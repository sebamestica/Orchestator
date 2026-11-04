/**
 * Servicio de plugins (F5): estado de Chrome y Canva en SQLite (`plugins_state`, sin tokens), secretos en la bóveda
 * (DPAPI) y entrega de servidores MCP a los agentes.
 *
 * - `list()`, `status(id)`, `connect(id, body)`, `disconnect(id)`, `handleCanvaCallback(query)`.
 * - `mcpServersFor(agentId, kind)`: servidores en forma neutra (`McpServerMap`) que cada adaptador traduce.
 * - `grant(req)`: lo mismo para una ejecución, con los candados de Chrome tomados (`chrome-personal` /
 *   `chrome-agente`, carpeta de candados del hub) hasta `release()`. Es la `McpServerSource` de los adaptadores.
 *
 * Cada cambio visible se publica como `{type:'plugin', plugin}`.
 */
import { access } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import {
  idSchema,
  redactSecrets,
  type AgentKind,
  type ConnectPluginBody,
  type Plugin,
  type PluginId,
} from '../../shared/index.ts';
import { LockError, LockManager, type LockHandle } from '../locks/index.ts';
import { describeHolder } from '../locks/owner.ts';
import type { F5HubMessage } from '../server/hub.ts';
import type { SecretVault } from '../vault/index.ts';
import { CANVA_MCP_URL, CanvaConnector, type CallbackQuery } from './canva.ts';
import {
  CHROME_SERVER,
  chromeLauncherPath,
  chromeServerSpec,
  chromeSteps,
  defaultChromeLauncher,
  DEFAULT_BROWSER_TOOLS_DIR,
  interpretChromeProbe,
  type ChromeLauncher,
  type ChromeProfile,
} from './chrome.ts';
import { EMPTY_GRANT, type McpGrant, type McpGrantRequest, type McpServerMap, type McpServerSource, type McpServerSpec } from './mcp.ts';
import { probeStdioMcp, type StdioProbeOptions, type StdioProbeResult } from './mcp-probe.ts';
import { McpOAuthClient, OAuthError, type McpOAuth } from './oauth.ts';
import { PluginStateStore, type PluginState } from './state.ts';

/** Tipos de agente que reciben cada plugin. agy aún no recibe servidores MCP por sesión (ver `agy-cli/index.ts`). */
export const PLUGIN_AGENT_KINDS: Readonly<Record<PluginId, readonly AgentKind[]>> = {
  chrome: ['claude-sdk', 'codex-cli'],
  canva: ['claude-sdk', 'codex-cli'],
};

const INFO: Readonly<Record<PluginId, { name: string; description: string }>> = {
  chrome: {
    name: 'Chrome',
    description: 'Navegador para los agentes por chrome-devtools-mcp: tu Chrome con tus sesiones (perfil personal) o un perfil propio de los agentes.',
  },
  canva: {
    name: 'Canva',
    description: 'Tus diseños de Canva por el MCP oficial (mcp.canva.com), con tu cuenta (OAuth).',
  },
};

const CANVA_STEPS = ['Pulsa Conectar: se abre la página de Canva para iniciar sesión.', 'Acepta los permisos; al volver verás «Canva conectado» y podrás cerrar la pestaña.'];
const CANVA_CONNECTING_STEPS = [
  'Inicia sesión en Canva en la pestaña que se abrió y acepta los permisos.',
  'Si no se abrió, abre el enlace de autorización (vale 10 minutos y una sola vez).',
];
const CANVA_NOTE = 'Usa Canva solo para los diseños que pide la tarea; no confirmes cambios (commit) ni borres diseños sin que el encargo lo pida.';

export class PluginError extends Error {
  override readonly name = 'PluginError';
  /** `invalid` (400), `not_found` (404), `conflict` (409). */
  readonly code: 'invalid' | 'not_found' | 'conflict';
  constructor(code: PluginError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export interface ChromePluginOptions {
  /** Carpeta de los lanzadores (`chrome-personal.cmd`, `chrome-agente.cmd`). */
  toolsDir?: string;
  /** Comando de cada perfil (pruebas: un MCP falso). Por defecto `cmd.exe /c <toolsDir>\chrome-<perfil>.cmd`. */
  launcher?: (profile: ChromeProfile) => ChromeLauncher;
  probe?: (opts: StdioProbeOptions) => Promise<StdioProbeResult>;
  startTimeoutMs?: number;
  /** Tiempo para `list_pages` (incluye aceptar el aviso de Chrome en el perfil personal). */
  browserTimeoutMs?: number;
  /** `false`: solo `initialize` + `tools/list` (no toca el navegador). */
  verifyBrowser?: boolean;
}

export interface CanvaPluginOptions {
  mcpUrl?: string;
  oauth?: McpOAuth;
  fetch?: typeof globalThis.fetch;
  refreshMarginMs?: number;
}

export interface PluginServiceOptions {
  db: DatabaseSync;
  vault: SecretVault;
  publish?: (message: F5HubMessage) => void;
  now?: () => Date;
  /** Registro (líneas ya tachadas, sin tokens). */
  log?: (line: string) => void;
  /** Tipo de un agente registrado (para avisar si uno elegido no puede recibir el plugin). */
  agentKind?: (agentId: string) => AgentKind | undefined;
  chrome?: ChromePluginOptions;
  canva?: CanvaPluginOptions;
  /** Candados (por defecto la carpeta del hub, `C:\dev\agent-hub\locks`). */
  locks?: Pick<LockManager, 'acquire'>;
  /** Espera por el candado de Chrome al entregarlo (0: si está ocupado, la sesión no lo recibe). */
  lockWaitMs?: number;
}

/** Id válido para el dueño de un candado (`idSchema`). */
function lockId(value: string, fallback: string): string {
  if (idSchema.safeParse(value).success) return value;
  const s = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return idSchema.safeParse(s).success ? s : fallback;
}

export class PluginService {
  readonly #opts: PluginServiceOptions;
  readonly #store: PluginStateStore;
  readonly #canva: CanvaConnector;
  readonly #canvaUrl: string;
  readonly #locks: Pick<LockManager, 'acquire'>;
  #publish: ((message: F5HubMessage) => void) | undefined;
  #authUrl: string | undefined;
  #chromeProbe: Promise<Plugin> | undefined;

  constructor(opts: PluginServiceOptions) {
    this.#opts = opts;
    this.#publish = opts.publish;
    this.#store = new PluginStateStore(opts.db);
    this.#canvaUrl = opts.canva?.mcpUrl ?? CANVA_MCP_URL;
    this.#locks = opts.locks ?? new LockManager();
    this.#canva = new CanvaConnector({
      vault: opts.vault,
      oauth: opts.canva?.oauth ?? new McpOAuthClient({ resourceUrl: this.#canvaUrl, clientName: 'Berland', ...(opts.canva?.fetch ? { fetch: opts.canva.fetch } : {}), ...(opts.now ? { now: opts.now } : {}) }),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.canva?.refreshMarginMs !== undefined ? { refreshMarginMs: opts.canva.refreshMarginMs } : {}),
      ...(opts.log ? { log: opts.log } : {}),
      onSessionChange: (e) => {
        if (e.kind === 'lost') this.#save({ ...this.#state('canva'), status: 'error', detail: e.message, steps: [...CANVA_STEPS] });
      },
    });
    // Un intento a medias de un arranque anterior (Chrome probando, Canva esperando el callback) no sigue vivo.
    for (const id of ['chrome', 'canva'] as const) {
      const s = this.#store.get(id);
      if (s?.status === 'connecting') this.#store.put({ ...s, status: 'disconnected', detail: 'La conexión quedó a medias al reiniciar el núcleo.', steps: this.#defaultSteps(id, s.profile), updatedAt: this.#iso() });
    }
  }

  /** Publicador del hub (se fija al registrar las rutas, cuando existe el hub). */
  setPublisher(publish: (message: F5HubMessage) => void): void {
    this.#publish = publish;
  }

  list(): Plugin[] {
    return [this.status('chrome'), this.status('canva')];
  }

  status(id: PluginId): Plugin {
    let s = this.#state(id);
    if (id === 'canva' && s.status === 'connecting' && !this.#canva.pendingAlive()) {
      s = { ...s, status: 'disconnected', detail: 'El enlace de autorización caducó (10 minutos): vuelve a pulsar Conectar.', steps: [...CANVA_STEPS] };
    }
    const authUrl = id === 'canva' && s.status === 'connecting' && this.#canva.pendingAlive() ? this.#authUrl : undefined;
    return {
      id,
      name: INFO[id].name,
      description: INFO[id].description,
      status: s.status,
      ...(s.detail !== undefined ? { detail: s.detail } : {}),
      agents: [...s.agents],
      steps: [...s.steps],
      ...(authUrl ? { authUrl } : {}),
      updatedAt: s.updatedAt,
    };
  }

  /**
   * Conecta. Chrome: prueba real del MCP (puede tardar lo que tarde el usuario en aceptar el aviso de Chrome).
   * Canva: devuelve `authUrl` y `status:'connecting'`; termina en `handleCanvaCallback`. `redirectUri` es la URL del
   * callback en este núcleo (`http://127.0.0.1:<puerto>/plugins/canva/callback`).
   */
  async connect(id: PluginId, body: ConnectPluginBody = {}, opts: { redirectUri?: string } = {}): Promise<Plugin> {
    if (id === 'chrome') return this.#connectChrome(body);
    if (body.profile !== undefined) throw new PluginError('invalid', 'profile solo aplica a Chrome');
    return this.#connectCanva(body, opts.redirectUri);
  }

  async disconnect(id: PluginId): Promise<Plugin> {
    const s = this.#state(id);
    if (id === 'chrome') {
      return this.#save({ ...s, status: 'disconnected', detail: 'Desconectado: los agentes no reciben Chrome.', steps: chromeSteps(s.profile ?? 'personal') });
    }
    this.#authUrl = undefined;
    let detail: string;
    try {
      const r = await this.#canva.disconnect();
      detail = !r.hadSession ? 'Desconectado.' : r.revoked ? 'Desconectado: token revocado y borrado de la bóveda.' : 'Desconectado: token borrado de la bóveda (el servidor no confirmó la revocación).';
    } catch (err) {
      detail = `Desconectado con errores: ${this.#errText(err)}`;
    }
    return this.#save({ ...s, status: 'disconnected', detail, steps: [...CANVA_STEPS] });
  }

  /** Vuelta del navegador desde Canva. Responde qué mostrar en la página del callback. */
  async handleCanvaCallback(query: CallbackQuery): Promise<{ ok: boolean; title: string; message: string }> {
    const result = await this.#canva.complete(query);
    if (result.ok) {
      this.#authUrl = undefined;
      const until = result.expiresAt ? ` · se renueva sola (vence ${new Date(result.expiresAt).toISOString().slice(0, 16).replace('T', ' ')} UTC)` : '';
      this.#save({ ...this.#state('canva'), status: 'connected', detail: `Cuenta de Canva conectada por OAuth${until}`, steps: [] });
      return { ok: true, title: 'Canva conectado', message: 'Canva conectado, ya puedes cerrar esta pestaña.' };
    }
    if (result.consumed) {
      this.#authUrl = undefined;
      this.#save({ ...this.#state('canva'), status: 'error', detail: result.message, steps: [...CANVA_STEPS] });
    }
    return { ok: false, title: 'No se pudo conectar Canva', message: result.message };
  }

  /** Servidores MCP para un agente (sin candados). Para una ejecución, usar `grant`. */
  async mcpServersFor(agentId: string, kind: AgentKind): Promise<McpServerMap> {
    return (await this.#collect(agentId, kind)).servers;
  }

  /** Servidores para una ejecución, con el candado de Chrome tomado hasta `release()`. */
  async grant(req: McpGrantRequest): Promise<McpGrant> {
    const { servers: collected, notes } = await this.#collect(req.agentId, req.kind);
    const handles: LockHandle[] = [];
    const skipped = new Set<string>();
    for (const profile of ['personal', 'agente'] as const) {
      const name = CHROME_SERVER[profile];
      if (!collected[name]) continue;
      try {
        handles.push(
          await this.#locks.acquire(name, { agent: lockId(req.agentId, 'agente'), task: lockId(req.taskId, 'sesion'), note: `MCP de Chrome (${profile}) para la sesión` }, {
            timeoutMs: this.#opts.lockWaitMs ?? 0,
            ...(req.signal ? { signal: req.signal } : {}),
          }),
        );
      } catch (err) {
        skipped.add(name);
        const who = err instanceof LockError && err.holder ? describeHolder(err.holder) : this.#errText(err);
        notes.push(`Chrome (perfil ${profile}) está en uso por ${who}: esta sesión no lo recibe. Si lo necesitas, dilo en tu informe.`);
      }
    }
    const servers = Object.fromEntries(Object.entries(collected).filter(([name]) => !skipped.has(name)));
    if (Object.keys(servers).length === 0 && notes.length === 0) return EMPTY_GRANT;
    let released = false;
    return {
      servers,
      notes,
      release: async () => {
        if (released) return;
        released = true;
        for (const h of handles) {
          try {
            await h.release();
          } catch (err) {
            this.#opts.log?.(`plugins: no se pudo soltar ${h.name}: ${this.#errText(err)}`);
          }
        }
      },
    };
  }

  /** `McpServerSource` para `createAdapterFactory({ plugins })` y la mente. */
  source(): McpServerSource {
    return (req) => this.grant(req);
  }

  /** Tokens conocidos en este proceso (para tachar). */
  knownSecrets(): string[] {
    return this.#canva.knownSecrets();
  }

  close(): void {
    this.#canva.close();
  }

  // ------------------------------------------------------------------ internos

  async #collect(agentId: string, kind: AgentKind): Promise<{ servers: Record<string, McpServerSpec>; notes: string[] }> {
    const servers: Record<string, McpServerSpec> = {};
    const notes: string[] = [];
    const wants = (id: PluginId, s: PluginState) => s.status === 'connected' && PLUGIN_AGENT_KINDS[id].includes(kind) && (s.agents.length === 0 || s.agents.includes(agentId));

    const chrome = this.#state('chrome');
    if (wants('chrome', chrome)) {
      const profile = chrome.profile ?? 'personal';
      servers[CHROME_SERVER[profile]] = chromeServerSpec(profile, this.#launcher(profile));
    }
    const canva = this.#state('canva');
    if (wants('canva', canva)) {
      try {
        const token = await this.#canva.accessToken();
        if (token) {
          servers.canva = { type: 'http', url: this.#canvaUrl, headers: { Authorization: `Bearer ${token}` }, instructions: CANVA_NOTE };
        } else {
          const now = this.#state('canva');
          if (now.status === 'connected') this.#save({ ...now, status: 'error', detail: 'No hay una sesión de Canva vigente: vuelve a conectar.', steps: [...CANVA_STEPS] });
          notes.push('Canva no está disponible en esta sesión (la sesión de Canva venció).');
        }
      } catch (err) {
        this.#opts.log?.(`plugins: Canva no disponible: ${this.#errText(err)}`);
        notes.push('Canva no está disponible en esta sesión (no se pudo leer o renovar el token).');
      }
    }
    return { servers, notes };
  }

  #connectChrome(body: ConnectPluginBody): Promise<Plugin> {
    if (this.#chromeProbe) return this.#chromeProbe;
    this.#chromeProbe = this.#probeChrome(body).finally(() => {
      this.#chromeProbe = undefined;
    });
    return this.#chromeProbe;
  }

  async #probeChrome(body: ConnectPluginBody): Promise<Plugin> {
    const prev = this.#state('chrome');
    const profile: ChromeProfile = body.profile ?? prev.profile ?? 'personal';
    const agents = body.agents ?? prev.agents;
    const extraSteps = this.#unsupportedAgentSteps('chrome', agents);
    this.#save({ ...prev, profile, agents, status: 'connecting', detail: `Comprobando Chrome (perfil ${profile})…`, steps: chromeSteps(profile) });

    const chromeOpts = this.#opts.chrome ?? {};
    const launcher = this.#launcher(profile);
    const launcherPath = chromeOpts.launcher ? undefined : chromeLauncherPath(profile, chromeOpts.toolsDir ?? DEFAULT_BROWSER_TOOLS_DIR);
    if (launcherPath) {
      try {
        await access(launcherPath);
      } catch {
        return this.#save({
          ...this.#state('chrome'),
          status: 'error',
          detail: `No se encontró el lanzador ${launcherPath}.`,
          steps: [`Instala chrome-devtools-mcp en ${chromeOpts.toolsDir ?? DEFAULT_BROWSER_TOOLS_DIR} (ver su README) y vuelve a conectar.`, ...extraSteps],
        });
      }
    }

    // El candado del perfil durante la prueba: si un agente lo tiene, el navegador ya está en uso y solo se listan herramientas.
    let lock: LockHandle | undefined;
    let busyBy: string | undefined;
    try {
      lock = await this.#locks.acquire(CHROME_SERVER[profile], { agent: 'orquestador', task: 'conectar-chrome', note: 'Prueba de conexión del plugin Chrome' }, { timeoutMs: 0 });
    } catch (err) {
      busyBy = err instanceof LockError && err.holder ? describeHolder(err.holder) : 'otro proceso';
    }
    const verifyBrowser = (chromeOpts.verifyBrowser ?? true) && busyBy === undefined;
    let result: StdioProbeResult;
    try {
      result = await (chromeOpts.probe ?? probeStdioMcp)({
        command: launcher.command,
        args: launcher.args,
        startTimeoutMs: chromeOpts.startTimeoutMs ?? 30_000,
        ...(verifyBrowser ? { call: { name: 'list_pages', timeoutMs: chromeOpts.browserTimeoutMs ?? 60_000 } } : {}),
      });
    } finally {
      await lock?.release().catch(() => undefined);
    }
    const outcome = interpretChromeProbe(profile, result, { ...(launcherPath ? { launcherPath } : {}), browserChecked: verifyBrowser, ...(busyBy ? { busyBy } : {}) });
    this.#opts.log?.(redactSecrets(`plugins: chrome ${profile} → ${outcome.status} (${outcome.tools} herramientas)`));
    return this.#save({ ...this.#state('chrome'), status: outcome.status, detail: outcome.detail, steps: [...outcome.steps, ...extraSteps] });
  }

  async #connectCanva(body: ConnectPluginBody, redirectUri: string | undefined): Promise<Plugin> {
    if (!redirectUri) throw new PluginError('invalid', 'Falta la URL del callback de Canva');
    const prev = this.#state('canva');
    const agents = body.agents ?? prev.agents;
    const extraSteps = this.#unsupportedAgentSteps('canva', agents);
    try {
      const { authUrl } = await this.#canvaStart(redirectUri);
      this.#authUrl = authUrl;
      return this.#save({ ...prev, agents, status: 'connecting', detail: 'Esperando que inicies sesión en Canva…', steps: [...CANVA_CONNECTING_STEPS, ...extraSteps] });
    } catch (err) {
      this.#authUrl = undefined;
      const blocked = err instanceof OAuthError && err.code === 'no_registration';
      return this.#save({
        ...prev,
        agents,
        status: 'error',
        detail: blocked ? `Canva no admite registro dinámico de clientes: ${this.#errText(err)}` : `No se pudo iniciar la conexión con Canva: ${this.#errText(err)}`,
        steps: blocked
          ? ['El orquestador necesita un client_id registrado a mano para Canva (no hay registro dinámico). Avísale a A0.', ...extraSteps]
          : ['Revisa tu conexión a internet y vuelve a pulsar Conectar.', ...extraSteps],
      });
    }
  }

  #canvaStart(redirectUri: string): Promise<{ authUrl: string }> {
    let u: URL;
    try {
      u = new URL(redirectUri);
    } catch {
      throw new PluginError('invalid', 'URL de callback inválida');
    }
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.pathname !== '/plugins/canva/callback') {
      throw new PluginError('invalid', 'El callback de Canva debe ser http://127.0.0.1:<puerto>/plugins/canva/callback');
    }
    return this.#canva.start(u.href);
  }

  #unsupportedAgentSteps(id: PluginId, agents: readonly string[]): string[] {
    const kindOf = this.#opts.agentKind;
    if (!kindOf) return [];
    return agents.flatMap((a) => {
      const kind = kindOf(a);
      if (kind === undefined) return [`El agente ${a} no está registrado.`];
      if (PLUGIN_AGENT_KINDS[id].includes(kind)) return [];
      return kind === 'agy-cli'
        ? [`${a} (agy) todavía no recibe plugins por sesión: agy usa su propia configuración global (agy mcp list).`]
        : [`${a} (${kind}) no puede usar servidores MCP.`];
    });
  }

  #launcher(profile: ChromeProfile): ChromeLauncher {
    const c = this.#opts.chrome;
    return c?.launcher ? c.launcher(profile) : defaultChromeLauncher(profile, c?.toolsDir ?? DEFAULT_BROWSER_TOOLS_DIR);
  }

  #defaultSteps(id: PluginId, profile: ChromeProfile | undefined): string[] {
    return id === 'chrome' ? chromeSteps(profile ?? 'personal') : [...CANVA_STEPS];
  }

  #state(id: PluginId): PluginState {
    return (
      this.#store.get(id) ?? {
        id,
        status: 'disconnected',
        agents: [],
        steps: this.#defaultSteps(id, 'personal'),
        ...(id === 'chrome' ? { profile: 'personal' as const } : {}),
        updatedAt: this.#iso(),
      }
    );
  }

  #save(state: PluginState): Plugin {
    this.#store.put({ ...state, updatedAt: this.#iso() }, this.knownSecrets());
    const plugin = this.status(state.id);
    try {
      this.#publish?.({ type: 'plugin', plugin });
    } catch (err) {
      this.#opts.log?.(`plugins: no se pudo publicar el cambio: ${this.#errText(err)}`);
    }
    return plugin;
  }

  #iso(): string {
    return (this.#opts.now ?? (() => new Date()))().toISOString();
  }

  #errText(err: unknown): string {
    return redactSecrets(err instanceof Error ? err.message : String(err), this.knownSecrets()).slice(0, 300);
  }
}
