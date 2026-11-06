/**
 * Servicio de plugins (F5): estado de Chrome y Canva en SQLite (`plugins_state`, sin tokens), secretos en la bóveda
 * (DPAPI) y entrega de servidores MCP a los agentes.
 *
 * - `list()`, `status(id)`, `connect(id, body)`, `disconnect(id)`, `handleCanvaCallback(query)`.
 * - `listLive()`: lo mismo con el estado vivo de Chrome (depuración remota, perfil, quién lo usa ahora).
 * - `mcpServersFor(agentId, kind)`: servidores en forma neutra (`McpServerMap`) que cada adaptador traduce.
 * - `grant(req)`: lo mismo para una ejecución, con notas para el encargo. Es la `McpServerSource` de los adaptadores.
 *
 * Chrome (issue 11): una sola vía, tu Chrome personal. Cada agente recibe `chrome-personal` a través de la puerta
 * (`chrome-gate.ts`), que toma el candado `chrome-personal` en la primera llamada y espera si otro lo tiene. Así un
 * agente que no navega no bloquea a nadie, y la mente queda bajo el mismo candado que la flota.
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
import { defaultLocksRoot, LockError, LockManager, type LockHandle } from '../locks/index.ts';
import type { F5HubMessage } from '../server/hub.ts';
import type { SecretVault } from '../vault/index.ts';
import { CANVA_MCP_URL, CanvaConnector, type CallbackQuery } from './canva.ts';
import {
  BERLAND_CHROME_NOTE,
  CHROME_LOCK,
  CHROME_SERVER,
  chromeLauncherPath,
  chromeServerSpec,
  chromeSteps,
  defaultChromeLauncher,
  defaultChromeUserDataDir,
  DEFAULT_BROWSER_TOOLS_DIR,
  describeChromeHolder,
  interpretChromeProbe,
  isAbandonedChromeHolder,
  NO_BROWSER_NOTE,
  readChromeProfile,
  remoteDebuggingOn,
  type ChromeLauncher,
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
    description: 'Tu Chrome personal, con tus sesiones y tu perfil, para los agentes (chrome-devtools-mcp). Es su único navegador: nunca abren otro. Uno a la vez: si otro agente lo está usando, el siguiente espera.',
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
const CANVA_NOTE =
  'Usa Canva solo para los diseños que pide la tarea, con este servidor (tu cuenta, por OAuth); no confirmes cambios (commit) ni borres diseños sin que el encargo lo pida. Si algo solo se puede hacer en la web de Canva, hazlo en el Chrome personal (`chrome-personal`), nunca en otro navegador.';
const AGENTE_RETIRED = 'Se quitó el perfil aislado de los agentes: ahora usan solo tu Chrome personal. Pulsa Probar conexión.';

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
  /** Carpeta del lanzador `chrome-personal.cmd`. */
  toolsDir?: string;
  /** Comando del MCP (pruebas: un MCP falso). Por defecto `cmd.exe /c <toolsDir>\chrome-personal.cmd`. */
  launcher?: () => ChromeLauncher;
  probe?: (opts: StdioProbeOptions) => Promise<StdioProbeResult>;
  startTimeoutMs?: number;
  /** Tiempo para `list_pages` (incluye aceptar el aviso de Chrome). */
  browserTimeoutMs?: number;
  /** `false`: solo `initialize` + `tools/list` (no toca el navegador). */
  verifyBrowser?: boolean;
  /** Carpeta de datos de Chrome para el estado vivo (por defecto `%LOCALAPPDATA%\Google\Chrome\User Data`). */
  userDataDir?: string;
  /** Puerta MCP: Node, script, espera por llamada y tiempo ocioso (por defecto los de `chrome.ts`). */
  gate?: { node?: string; script?: string; waitMs?: number; idleMs?: number };
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
  /** Candados (por defecto la carpeta del hub, `C:\dev\agent-hub\locks`). La puerta usa la misma `root`. */
  locks?: Pick<LockManager, 'acquire' | 'read' | 'releaseAbandoned' | 'root'>;
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
  readonly #locks: Pick<LockManager, 'acquire' | 'read' | 'releaseAbandoned' | 'root'>;
  #publish: ((message: F5HubMessage) => void) | undefined;
  #authUrl: string | undefined;
  #chromeProbe: Promise<Plugin> | undefined;

  constructor(opts: PluginServiceOptions) {
    this.#opts = opts;
    this.#publish = opts.publish;
    this.#store = new PluginStateStore(opts.db);
    this.#canvaUrl = opts.canva?.mcpUrl ?? CANVA_MCP_URL;
    this.#locks = opts.locks ?? new LockManager({ root: defaultLocksRoot() });
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
      if (s?.status === 'connecting') this.#store.put({ ...s, status: 'disconnected', detail: 'La conexión quedó a medias al reiniciar el núcleo.', steps: this.#defaultSteps(id), updatedAt: this.#iso() });
    }
    // El perfil aislado de los agentes ya no existe (issue 11): quien lo tenía elegido vuelve a tu Chrome personal,
    // desconectado hasta que pruebes la conexión (necesita la depuración remota activa).
    const chrome = this.#store.get('chrome');
    if (chrome?.profile === 'agente') {
      this.#store.put({ ...chrome, profile: 'personal', status: 'disconnected', detail: AGENTE_RETIRED, steps: chromeSteps(), updatedAt: this.#iso() });
    }
  }

  /** Publicador del hub (se fija al registrar las rutas, cuando existe el hub). */
  setPublisher(publish: (message: F5HubMessage) => void): void {
    this.#publish = publish;
  }

  list(): Plugin[] {
    return [this.status('chrome'), this.status('canva')];
  }

  /** `list()` con el estado vivo de Chrome en `detail`: depuración remota, perfil de las pestañas nuevas y quién lo usa. */
  async listLive(): Promise<Plugin[]> {
    const [chrome, canva] = this.list();
    if (!chrome || !canva) return this.list();
    const live = await this.chromeLive();
    return [{ ...chrome, detail: [chrome.detail, ...live].filter((x): x is string => !!x).join(' · ') }, canva];
  }

  /** Estado vivo de tu Chrome, sin tocarlo: solo lee archivos (`DevToolsActivePort`, `Local State`, el candado). */
  async chromeLive(): Promise<string[]> {
    const dir = this.#opts.chrome?.userDataDir ?? defaultChromeUserDataDir();
    const [on, profile, lock] = await Promise.all([remoteDebuggingOn(dir), readChromeProfile(dir), this.#locks.read(CHROME_LOCK).catch(() => undefined)]);
    const parts = [on ? 'Depuración remota activa' : 'Depuración remota apagada: actívala en chrome://inspect/#remote-debugging'];
    if (profile) {
      const label = profile.name ? `«${profile.name}» (${profile.dir})` : `«${profile.dir}»`;
      parts.push(`Pestañas nuevas en tu perfil ${label}${profile.count > 1 ? ', el último que usaste' : ''}`);
    }
    if (!lock) parts.push('Libre ahora');
    else if (isAbandonedChromeHolder(lock.holder)) parts.push('Libre ahora (el último agente terminó sin soltarlo; se libera solo)');
    else parts.push(`En uso ahora por ${describeChromeHolder(lock.holder, (this.#opts.now ?? (() => new Date()))())}`);
    return parts;
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
    if (id === 'chrome') {
      if (body.profile === 'agente') throw new PluginError('invalid', 'El perfil aislado «agente» ya no existe: los agentes usan solo tu Chrome personal.');
      return this.#connectChrome(body);
    }
    if (body.profile !== undefined) throw new PluginError('invalid', 'profile solo aplica a Chrome');
    return this.#connectCanva(body, opts.redirectUri);
  }

  async disconnect(id: PluginId): Promise<Plugin> {
    const s = this.#state(id);
    if (id === 'chrome') {
      return this.#save({ ...s, status: 'disconnected', detail: 'Desconectado: los agentes no reciben navegador (ni otro Chrome).', steps: chromeSteps() });
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

  /**
   * Servidores y notas para la mente (sin tarea), en forma neutra: con ellos se arman sus reglas (`pluginsSection`,
   * que lee las `instructions` de cada servidor) antes de traducirlos al SDK.
   */
  forMind(agentId: string): Promise<Pick<McpGrant, 'servers' | 'notes'>> {
    return this.#collect(agentId, 'claude-sdk');
  }

  /** Servidores MCP para un agente (la mente: sin tarea). Para una ejecución, usar `grant`. */
  async mcpServersFor(agentId: string, kind: AgentKind, taskId?: string): Promise<McpServerMap> {
    return (await this.#collect(agentId, kind, taskId)).servers;
  }

  /**
   * Servidores para una ejecución, con sus notas. El candado de Chrome no se toma aquí: lo toma la puerta en la
   * primera llamada. `release()` libera el candado si la puerta de esta sesión murió sin soltarlo.
   */
  async grant(req: McpGrantRequest): Promise<McpGrant> {
    const { servers, notes } = await this.#collect(req.agentId, req.kind, req.taskId);
    if (Object.keys(servers).length === 0 && notes.length === 0) return EMPTY_GRANT;
    const owner = { agent: lockId(req.agentId, 'agente'), task: lockId(req.taskId, 'sesion') };
    const hasChrome = CHROME_SERVER in servers;
    let released = false;
    return {
      servers,
      notes,
      release: async () => {
        if (released || !hasChrome) return;
        released = true;
        try {
          await this.#locks.releaseAbandoned(CHROME_LOCK, (h) => h.agent === owner.agent && h.task === owner.task && isAbandonedChromeHolder(h));
          this.#opts.log?.(`plugins: candado ${CHROME_LOCK} de ${owner.agent}/${owner.task} quedó abandonado y se liberó`);
        } catch (err) {
          // Lo normal: libre (`not_held`) o de otro (`not_owner`).
          if (!(err instanceof LockError && (err.code === 'not_held' || err.code === 'not_owner'))) this.#opts.log?.(`plugins: no se pudo revisar ${CHROME_LOCK}: ${this.#errText(err)}`);
        }
      },
    };
  }

  /**
   * Si el servidor de un plugin (`chrome-personal`, `canva`) se le sigue entregando a este agente, según el estado de
   * ahora. La guardia de la mente lo mira en cada llamada: un «Desconectar» corta también a la sesión que ya lo tenía.
   */
  delivers(agentId: string, kind: AgentKind, server: string): boolean {
    const id: PluginId | undefined = server === CHROME_SERVER ? 'chrome' : server === 'canva' ? 'canva' : undefined;
    return id !== undefined && this.#wants(id, this.#state(id), agentId, kind);
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

  async #collect(agentId: string, kind: AgentKind, taskId?: string): Promise<{ servers: Record<string, McpServerSpec>; notes: string[] }> {
    const servers: Record<string, McpServerSpec> = {};
    const notes: string[] = [];

    const chrome = this.#state('chrome');
    if (this.#wants('chrome', chrome, agentId, kind)) {
      const gate = this.#opts.chrome?.gate ?? {};
      servers[CHROME_SERVER] = chromeServerSpec(this.#launcher(), {
        agent: lockId(agentId, 'agente'),
        task: lockId(taskId ?? 'sesion', 'sesion'),
        locksRoot: this.#locks.root,
        ...gate,
      });
    } else if (PLUGIN_AGENT_KINDS.chrome.includes(kind)) {
      // Sin Chrome, que no busque otro navegador (el integrado de su CLI, Playwright, un perfil aparte).
      notes.push(NO_BROWSER_NOTE);
    }
    const canva = this.#state('canva');
    if (this.#wants('canva', canva, agentId, kind)) {
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

  #wants(id: PluginId, s: PluginState, agentId: string, kind: AgentKind): boolean {
    return s.status === 'connected' && PLUGIN_AGENT_KINDS[id].includes(kind) && (s.agents.length === 0 || s.agents.includes(agentId));
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
    const agents = body.agents ?? prev.agents;
    const extraSteps = this.#unsupportedAgentSteps('chrome', agents);
    this.#save({ ...prev, profile: 'personal', agents, status: 'connecting', detail: 'Comprobando tu Chrome personal…', steps: chromeSteps() });

    const chromeOpts = this.#opts.chrome ?? {};
    const launcher = this.#launcher();
    const launcherPath = chromeOpts.launcher ? undefined : chromeLauncherPath(chromeOpts.toolsDir ?? DEFAULT_BROWSER_TOOLS_DIR);
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

    // El candado durante la prueba: si un agente lo tiene, el navegador ya está en uso y solo se listan herramientas.
    let lock: LockHandle | undefined;
    let busyBy: string | undefined;
    const take = () => this.#locks.acquire(CHROME_LOCK, { agent: 'orquestador', task: 'probar-chrome', note: `${BERLAND_CHROME_NOTE} · prueba de conexión` }, { timeoutMs: 0 });
    try {
      lock = await take();
    } catch (err) {
      if (err instanceof LockError && err.holder && isAbandonedChromeHolder(err.holder)) {
        await this.#locks.releaseAbandoned(CHROME_LOCK, (h) => isAbandonedChromeHolder(h)).catch(() => undefined);
        lock = await take().catch(() => undefined);
      }
      if (!lock) busyBy = err instanceof LockError && err.holder ? describeChromeHolder(err.holder, (this.#opts.now ?? (() => new Date()))()) : 'otro proceso';
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
    const outcome = interpretChromeProbe(result, { ...(launcherPath ? { launcherPath } : {}), browserChecked: verifyBrowser, ...(busyBy ? { busyBy } : {}) });
    this.#opts.log?.(redactSecrets(`plugins: chrome personal → ${outcome.status} (${outcome.tools} herramientas)`));
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
        ? [`${a} (agy) todavía no recibe plugins por sesión: usa su propio chrome-personal (agy mcp list), sin el candado de Berland.`]
        : [`${a} (${kind}) no puede usar servidores MCP.`];
    });
  }

  #launcher(): ChromeLauncher {
    const c = this.#opts.chrome;
    return c?.launcher ? c.launcher() : defaultChromeLauncher(c?.toolsDir ?? DEFAULT_BROWSER_TOOLS_DIR);
  }

  #defaultSteps(id: PluginId): string[] {
    return id === 'chrome' ? chromeSteps() : [...CANVA_STEPS];
  }

  #state(id: PluginId): PluginState {
    return (
      this.#store.get(id) ?? {
        id,
        status: 'disconnected',
        agents: [],
        steps: this.#defaultSteps(id),
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
