/**
 * Chat con la mente (F5, c15): conversaciones guardadas en SQLite, cada una con una `ConductorSession` viva y perezosa.
 *
 * - La sesión se crea con el primer mensaje y se cierra tras `idleMs` sin uso (15 min), al cerrar o al borrar el chat.
 *   Al recrearla se reanuda con `resume` (el `session_id` del SDK guardado), así no se pierde el contexto.
 * - Lo que cambia la forma de la sesión (mente, modelo, modo, raíces de lectura, plugins) se compara en cada mensaje:
 *   si cambió, la sesión se recrea (reanudada) y el cambio rige desde ese turno. El modo, además, se lee en cada llamada
 *   de la guardia y de las herramientas. El esfuerzo del turno (`effort` del mensaje o el de los ajustes) se aplica en
 *   vivo (`ConductorSession.setEffort`) y solo recrea la sesión si el SDK no lo permite.
 * - Modo `chat`: la mente conversa como Claude Code en la carpeta del chat (con o sin proyecto), sin flota.
 * - Los eventos de la sesión van al hub (`hub.append`, SQLite + `/ws`) con `sessionId = chat.sessionId`, en
 *   diferencias de uso (`usageDeltas`) y con `seq` continuo entre sesiones reanudadas.
 * - Destino de los cambios (`target`): local salvo que la mente haya anotado con `crear_tareas.destino` el repositorio
 *   que indicó el usuario; cada cambio se difunde como `chat_target`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { McpServerConfig, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { effortSchema, redactSecrets } from '../../shared/index.ts';
import type {
  AgentConfig,
  AgentEvent,
  Attachment,
  ChangesTarget,
  Chat,
  ChatMessage,
  CreateChatBody,
  Effort,
  MindMode,
  PatchChatBody,
  Proposal,
  Settings,
  TaskBrief,
} from '../../shared/index.ts';
import {
  CONDUCTOR_AGENT_ID,
  ConductorSession,
  MAX_IMAGE_BASE64_BYTES,
  ProposalError,
  approveAndDeliver,
  effortNote,
  imageTooLarge,
  sdkSessionIdOf,
  usageDeltas,
} from '../conductor/index.ts';
import type {
  ConductorPorts,
  ConductorQueryFn,
  DelegateResult,
  DeliveryReport,
  DestinationRequest,
  FleetPort,
  ImageInput,
  PlannerPort,
  SdkMessageTranslator,
  TranslatorInit,
} from '../conductor/index.ts';
import type { EventHub } from '../server/index.ts';
import type { SqliteStore } from '../store/index.ts';
import { AttachmentError, sniffImage, type AttachmentStore } from './attachments.ts';
import { ChatDb, ChatRepo, type ChatUpdate, type StoredChat } from './db.ts';
import { ChatProposals, toProposal } from './proposals.ts';
import { conversationDir } from './conversations.ts';
import { ChatTargets, normalizeDestination, resolveChangesTarget } from './target.ts';

/** Sesión ociosa: se cierra y se reanuda con el próximo mensaje. */
export const CHAT_IDLE_MS = 15 * 60 * 1000;
/** Si el SDK no cierra el turno tras interrumpir, se corta la sesión (se reanuda con el próximo mensaje). */
export const INTERRUPT_GRACE_MS = 10_000;
const TITLE_MAX = 60;

export type ChatErrorCode = 'invalid' | 'not_found' | 'conflict' | 'not_configured' | 'too_large';
export class ChatError extends Error {
  override name = 'ChatError';
  readonly code: ChatErrorCode;
  constructor(code: ChatErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Lo que el chat necesita del almacén del núcleo. */
export type ChatStorePort = Pick<SqliteStore, 'getProject' | 'getTask' | 'putTask' | 'setTaskState' | 'getSession' | 'listTasks' | 'cancelOpenSessions'>;
/** Lo que el chat necesita del hub (`/ws`). */
export type ChatHub = Pick<EventHub, 'append' | 'publish' | 'publishTask'>;

/** Plugins de la mente leídos en el momento (c16): servidores para el SDK y el entorno con sus secretos (`ORQ_MCP_*`). */
export interface MindPlugins {
  mcpServers: Readonly<Record<string, McpServerConfig>>;
  env: Readonly<Record<string, string>>;
  /** Reglas de uso para el prompt (`pluginsSection`: pestaña propia, sin contraseñas, «sin navegador»…). */
  rules?: string;
}

/** De dónde sale la mente: agentes registrados y su entorno (clave de la bóveda, solo en memoria). */
export interface MindPort {
  agents(): readonly AgentConfig[];
  env(agentId: string): Promise<Readonly<Record<string, string>>>;
  /**
   * Plugins de la mente leídos en cada mensaje, antes de decidir si la sesión viva sirve: conectar, desconectar o
   * renovar un token cambia la forma y la sesión se recrea (reanudada). Sin esto, `ChatServiceDeps.mcpServersFor`.
   */
  plugins?(agentId: string): Promise<MindPlugins>;
  /** Si el servidor de un plugin sigue conectado para la mente ahora (la guardia lo mira en cada llamada). */
  pluginLive?(agentId: string, server: string): boolean;
  /** Entorno base del proceso del SDK, sin credenciales del anfitrión. */
  baseEnv?(): Readonly<Record<string, string | undefined>>;
  /** Lo que queda del presupuesto del agente (USD); `undefined` sin tope. */
  budgetLeftUsd?(agentId: string): number | undefined;
}

export interface ChatServiceDeps {
  /** `store.database` del núcleo. */
  db: DatabaseSync;
  store: ChatStorePort;
  hub: ChatHub;
  /** Ajustes vigentes (c14 `SettingsStore`); se leen al crear cada chat y cada sesión. */
  settings: () => Settings;
  mind: MindPort;
  /** Puertos compartidos del orquestador; las propuestas son por chat (SQLite). */
  ports: Omit<ConductorPorts, 'proposals'>;
  /** Traductor de mensajes del SDK a eventos (c1 `ClaudeSdkTranslator`). */
  translator: (init: TranslatorInit) => SdkMessageTranslator;
  attachments: AttachmentStore;
  /** Servidores MCP fijos para la mente, sin entorno (pruebas); los plugins vivos llegan por `MindPort.plugins`. */
  mcpServersFor?: (agentId: string) => Readonly<Record<string, McpServerConfig>>;
  /** Raíces fijas de lectura (p. ej. el hub de skills). */
  readRoots?: readonly string[];
  /** Archivos que la mente nunca lee (bóveda y base de datos del núcleo). */
  denyPaths?: readonly string[];
  /**
   * Raíz de las carpetas internas de las conversaciones (chats sin proyecto): una por chat, que Berland crea solo.
   * Sin ella, una conversación tiene que traer su `cwd`.
   */
  conversationsRoot?: string;
  /** Unidades locales para el modo bypass (por defecto las letras de unidad que existen). */
  drives?: () => readonly string[];
  query?: ConductorQueryFn;
  idleMs?: number;
  interruptGraceMs?: number;
  now?: () => Date;
  newId?: () => string;
  log?: (line: string) => void;
}

interface Turn {
  session: ConductorSession;
  texts: string[];
  interrupted: boolean;
  grace?: ReturnType<typeof setTimeout>;
}

interface Live {
  proposals: ChatProposals;
  session?: ConductorSession;
  key?: string;
  delta?: (event: AgentEvent) => AgentEvent | undefined;
  seq: number;
  busy: boolean;
  turn?: Turn;
  idle?: ReturnType<typeof setTimeout>;
  /** Carpetas de los archivos adjuntos (no imágenes): la mente las puede leer. */
  roots: Set<string>;
  /**
   * Subagentes de la mente que siguen trabajando (sesiones hijas con estado `starting`/`running`/`waiting`). Mientras
   * haya alguno, la sesión no se cierra por inactividad ni se recrea por un cambio de ajustes: se los mataría.
   */
  background: Set<string>;
}

export interface SendInput {
  text: string;
  attachmentIds?: readonly string[];
  /** Esfuerzo de este turno (barra de esfuerzo); sin él, el de los ajustes de la mente. */
  effort?: Effort;
}

export interface ApprovalOutcome extends DeliveryReport {
  proposals: Proposal[];
}

const resultSchema = z.object({ type: z.literal('result'), subtype: z.string(), is_error: z.boolean().optional(), result: z.string().optional() }).loose();

/**
 * Mensaje del SDK que abre un turno de la mente: el `init` de cada turno o un mensaje suyo (no de un subagente). Los
 * avisos de progreso de los subagentes (`task_*`) no abren turno.
 */
export function startsMainTurn(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as { type?: unknown; subtype?: unknown; parent_tool_use_id?: unknown };
  if (m.type === 'system') return m.subtype === 'init';
  return m.type === 'assistant' && (m.parent_tool_use_id === null || m.parent_tool_use_id === undefined);
}

/** Letras de unidad que existen (Windows); fuera de Windows, la raíz. */
export function localDrives(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return ['/'];
  const out: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const drive = `${String.fromCharCode(c)}:\\`;
    try {
      if (existsSync(drive)) out.push(drive);
    } catch {
      /* unidad no disponible */
    }
  }
  return out.length ? out : ['C:\\'];
}

/** Mente según los ajustes: el agente elegido o el primer `claude-sdk` habilitado. */
export function resolveMind(settings: Settings, agents: readonly AgentConfig[]): AgentConfig {
  const wanted = settings.mind.agentId;
  if (wanted) {
    const agent = agents.find((a) => a.id === wanted);
    if (!agent) throw new ChatError('not_configured', `El agente ${wanted} elegido como mente no existe: elige otro en Ajustes → Mente y subagentes`);
    if (agent.kind !== 'claude-sdk') {
      throw new ChatError('not_configured', `Por ahora solo un agente Claude (SDK) puede ser la mente; ${wanted} es ${agent.kind} (llega en F5.2)`);
    }
    if (!agent.enabled) throw new ChatError('not_configured', `El agente ${wanted} elegido como mente está deshabilitado`);
    return agent;
  }
  const first = agents.find((a) => a.kind === 'claude-sdk' && a.enabled);
  if (!first) throw new ChatError('not_configured', 'No hay un agente Claude habilitado para la mente: agrégalo en Ajustes → Agentes');
  return first;
}

/** Texto que recibe la mente: el del usuario más «Adjuntos: <ruta>» por cada archivo que no es imagen. */
export function composeUserText(text: string, files: readonly Pick<Attachment, 'path'>[]): string {
  const lines = files.map((f) => `Adjuntos: ${f.path}`);
  return [text.trim() ? text : '', lines.join('\n')].filter(Boolean).join('\n\n');
}

/** Hash de los servidores, su entorno (con los secretos) y sus reglas: cambia si cambia cualquier valor, sin guardarlo. */
function pluginsFingerprint(plugins: MindPlugins): string {
  const sorted = (o: Readonly<Record<string, unknown>>) => Object.keys(o).sort().map((k) => [k, o[k]]);
  return createHash('sha256').update(JSON.stringify([sorted(plugins.mcpServers), sorted(plugins.env), plugins.rules ?? ''])).digest('hex');
}

function titleFrom(text: string, attachments: readonly Attachment[]): string {
  const line = text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? attachments[0]?.name ?? '';
  const flat = redactSecrets(line.replace(/\s+/g, ' '));
  return flat.length <= TITLE_MAX ? flat : `${flat.slice(0, TITLE_MAX - 1)}…`;
}

const CLOCK = new Intl.DateTimeFormat('es-CL', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Aviso del turno que cortó un reinicio del núcleo: la hora del último evento y los subagentes perdidos. */
function cutTurnNotice(lastEventAt: string | undefined, lostSubagents: number): string {
  const when = lastEventAt ? ` (último evento a las ${CLOCK.format(new Date(lastEventAt))})` : '';
  const lost =
    lostSubagents === 0
      ? ''
      : lostSubagents === 1
        ? ' 1 subagente en segundo plano se perdió al reiniciar.'
        : ` ${lostSubagents} subagentes en segundo plano se perdieron al reiniciar.`;
  return `La respuesta se cortó porque el núcleo se cerró${when}. Vuelve a enviar tu mensaje.${lost}`;
}

function oneLine(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 500);
}

export class ChatService {
  readonly #deps: ChatServiceDeps;
  readonly #db: ChatDb;
  readonly #repo: ChatRepo;
  readonly #targets: ChatTargets;
  readonly #live = new Map<string, Live>();
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #idleMs: number;
  readonly #graceMs: number;
  readonly #log: (line: string) => void;
  readonly #fleet: FleetPort;
  readonly #planner: PlannerPort;
  #drives: readonly string[] | undefined;

  constructor(deps: ChatServiceDeps) {
    this.#deps = deps;
    this.#db = new ChatDb(deps.db);
    this.#repo = new ChatRepo(this.#db);
    this.#targets = new ChatTargets(this.#db);
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? randomUUID;
    this.#idleMs = deps.idleMs ?? CHAT_IDLE_MS;
    this.#graceMs = deps.interruptGraceMs ?? INTERRUPT_GRACE_MS;
    this.#log = deps.log ?? (() => undefined);

    const base = deps.ports.fleet;
    const retry = base.retry?.bind(base);
    this.#fleet = {
      delegate: (task) => this.#deliver(task),
      status: (taskId) => base.status(taskId),
      list: () => base.list(),
      ...(retry ? { retry } : {}),
    };
    const store = deps.store;
    const db = this.#db;
    this.#planner = {
      // El planificador no debe repetir ids del tablero ni de otras conversaciones del proyecto.
      plan: (r) =>
        deps.ports.planner.plan({
          ...r,
          knownTaskIds: [
            ...new Set([...r.knownTaskIds, ...store.listTasks({ projectId: r.projectId }).map((t) => t.task.id), ...ChatProposals.idsForProject(db, r.projectId)]),
          ].sort(),
        }),
    };
  }

  /**
   * Arranque del núcleo: los chats que quedaron `running` no tienen turno vivo. Vuelven a `idle` con un aviso en el
   * hilo, y sus subagentes en segundo plano (sin proceso) se cierran. No va en el constructor: lo llama el servidor
   * cuando ya escucha (`onStarted`), para que un segundo núcleo sin puerto no toque la base.
   */
  recover(): void {
    const cut = this.#repo.resetRunning(this.#iso());
    for (const chatId of cut) this.#noticeCutTurn(chatId);
    if (cut.length) this.#log(`chat: ${cut.length} chat(s) con el turno cortado por el reinicio vuelven a libre, con aviso`);
  }

  /** Deja en el hilo que el reinicio cortó el turno y cierra las sesiones de los subagentes que se perdieron. */
  #noticeCutTurn(chatId: string): void {
    try {
      const chat = this.#require(chatId).chat;
      const lost = this.#deps.store.cancelOpenSessions({ parentSessionId: chat.sessionId });
      const lastEventAt = this.#deps.store.getSession(chat.sessionId)?.updatedAt;
      const text = cutTurnNotice(lastEventAt, lost);
      this.#repo.addMessage({ id: this.#newId(), chatId: chat.id, role: 'assistant', text, attachments: [], mode: chat.mode, at: this.#iso() });
    } catch (err) {
      this.#log(`chat ${chatId}: no se pudo dejar el aviso del turno cortado: ${oneLine(err)}`);
    }
  }

  // ---------------------------------------------------------------- chats

  list(projectId?: string | null): Chat[] {
    return this.#repo.list(projectId).map((chat) => this.#withLive(chat));
  }

  get(chatId: string): Chat {
    return this.#withLive(this.#require(chatId).chat);
  }

  /** El chat con lo que solo vive en memoria: los subagentes que siguen en segundo plano. */
  #withLive(chat: Chat): Chat {
    const n = this.#live.get(chat.id)?.background.size ?? 0;
    let out = n > 0 ? { ...chat, backgroundTasks: n } : chat;
    if (this.#isInternalFolder(chat.cwd)) out = { ...out, internalFolder: true };
    return out;
  }

  /** `cwd` es una carpeta interna de conversación (dentro de `conversationsRoot`). */
  #isInternalFolder(cwd: string): boolean {
    const root = this.#deps.conversationsRoot;
    if (!root) return false;
    const rel = path.relative(path.resolve(root), path.resolve(cwd));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  create(body: CreateChatBody): Chat {
    const settings = this.#deps.settings();
    let cwd: string;
    let id: string | undefined;
    if (body.projectId !== null) {
      const project = this.#deps.store.getProject(body.projectId);
      if (!project) throw new ChatError('not_found', `No existe el proyecto ${body.projectId}`);
      cwd = requireDir(body.cwd ?? project.repoPath, 'cwd');
    } else if (body.cwd) {
      cwd = requireDir(body.cwd, 'cwd');
    } else {
      // Una conversación no pide carpeta: trabaja en una interna, propia del chat.
      const root = this.#deps.conversationsRoot;
      if (!root) throw new ChatError('invalid', 'Una conversación sin proyecto necesita su carpeta (cwd)');
      id = this.#newId();
      cwd = conversationDir(root, id);
    }
    const extraRoots = uniqueDirs(body.extraRoots ?? []);
    const mind = resolveMind(settings, this.#deps.mind.agents());
    // La carpeta interna se crea solo cuando el chat ya es válido.
    if (id !== undefined) mkdirSync(cwd, { recursive: true });
    id ??= this.#newId();
    const at = this.#iso();
    const { chat } = this.#repo.insert({
      id,
      projectId: body.projectId,
      title: redactSecrets(body.title?.trim() ?? ''),
      cwd,
      extraRoots,
      mode: body.mode ?? settings.defaultMode,
      mindAgentId: mind.id,
      sessionId: `chat-${id}`,
      state: 'idle',
      costUsd: 0,
      createdAt: at,
      updatedAt: at,
    });
    const out = this.#withLive(chat);
    this.#deps.hub.publish({ type: 'chat', chat: out });
    return out;
  }

  /**
   * Renombrar, cambiar el modo o las carpetas extra. El prompt cambia desde el turno siguiente; la guardia ve el modo y
   * las carpetas extra al instante (quitar una carpeta la revoca también para los subagentes ya lanzados).
   */
  patch(chatId: string, body: PatchChatBody): Chat {
    this.#require(chatId);
    const patch: ChatUpdate = {};
    if (body.title !== undefined) patch.title = redactSecrets(body.title.trim());
    if (body.mode !== undefined) patch.mode = body.mode;
    if (body.extraRoots !== undefined) patch.extraRoots = uniqueDirs(body.extraRoots);
    return this.#update(chatId, patch);
  }

  /** Cierra la conversación: corta el turno en curso y la sesión. Un mensaje nuevo la reabre (reanudada). */
  close(chatId: string): Chat {
    this.#require(chatId);
    const live = this.#live.get(chatId);
    if (live) {
      if (live.turn) live.turn.interrupted = true;
      this.#dropSession(chatId, live);
    }
    return this.#update(chatId, { state: 'closed' });
  }

  /** Borra el chat, sus mensajes y propuestas (las tareas ya entregadas siguen en el tablero) y las copias de adjuntos que solo usaba él. */
  async delete(chatId: string): Promise<void> {
    this.#require(chatId);
    const live = this.#live.get(chatId);
    if (live) {
      if (live.turn) live.turn.interrupted = true;
      this.#dropSession(chatId, live);
      if (live.idle) clearTimeout(live.idle);
    }
    const used = this.#repo.attachmentIdsUsedOutside(chatId);
    const own = this.#repo.attachmentsOf(chatId).filter((a) => a.source === 'upload' && !used.has(a.id));
    this.#repo.delete(chatId);
    this.#targets.clear(chatId);
    this.#live.delete(chatId);
    for (const a of own) {
      try {
        await this.#deps.attachments.remove(a.id);
      } catch (err) {
        this.#log(`chat: no se pudo borrar el adjunto ${a.id}: ${oneLine(err)}`);
      }
    }
    this.#deps.hub.publish({ type: 'chat_deleted', chatId });
  }

  messages(chatId: string, limit?: number): ChatMessage[] {
    this.#require(chatId);
    return this.#repo.messages(chatId, limit);
  }

  /**
   * Dónde quedan los cambios del chat: en local (la carpeta del proyecto o, sin proyecto, la del chat) salvo que la
   * mente haya anotado el repositorio que indicó el usuario. Lee el git de la carpeta (solo lectura) en cada llamada.
   */
  async target(chatId: string): Promise<ChangesTarget> {
    const { chat } = this.#require(chatId);
    const project = chat.projectId === null ? undefined : this.#deps.store.getProject(chat.projectId);
    const place = { path: project?.repoPath ?? chat.cwd, worktrees: project?.workspace !== undefined };
    return resolveChangesTarget(place, this.#targets.get(chatId));
  }

  // ------------------------------------------------------------- mensajes

  /**
   * Guarda el mensaje del usuario y lo entrega a la mente. Vuelve en cuanto el mensaje está guardado: la respuesta
   * llega por `/ws`. Con un turno en curso, `conflict`.
   */
  async send(chatId: string, input: SendInput): Promise<ChatMessage> {
    const stored = this.#require(chatId);
    if (input.effort !== undefined && !effortSchema.safeParse(input.effort).success) throw new ChatError('invalid', `Esfuerzo inválido: ${String(input.effort)}`);
    const live = this.#liveOf(chatId);
    if (live.busy) throw new ChatError('conflict', 'La mente todavía está respondiendo: espera o interrumpe el turno');
    // Ocupado antes de cualquier espera: dos envíos simultáneos no arrancan dos turnos.
    live.busy = true;
    const addedRoots: string[] = [];
    try {
      const attachments = (input.attachmentIds ?? []).map((id) => this.#attachment(id));
      const images: ImageInput[] = [];
      const files: Attachment[] = [];
      for (const a of attachments) {
        if (a.kind !== 'image') {
          files.push(a);
          continue;
        }
        const { bytes } = await this.#readAttachment(a.id);
        // Un archivo por ruta pudo cambiar desde que se registró: el tipo sale otra vez de sus bytes.
        const mediaType = sniffImage(bytes);
        if (!mediaType) {
          files.push(a);
          continue;
        }
        const data = Buffer.from(bytes).toString('base64');
        if (data.length > MAX_IMAGE_BASE64_BYTES) throw new ChatError('too_large', imageTooLarge(a.name, data.length));
        images.push({ mediaType, data, name: a.name });
      }
      for (const f of files) {
        const root = path.dirname(f.path);
        if (!live.roots.has(root)) addedRoots.push(root);
        live.roots.add(root);
      }
      // Tachado también hacia la mente: el SDK guarda la transcripción de la sesión en disco.
      const composed = redactSecrets(composeUserText(input.text, files));
      if (!composed.trim() && !images.length) throw new ChatError('invalid', 'Mensaje vacío');
      // Con esfuerzo propio, la mente lo sabe por una línea al inicio (el historial guarda el texto sin ella).
      const text = input.effort ? [effortNote(input.effort), composed].filter((t) => t.trim()).join('\n') : composed;

      if (live.idle) clearTimeout(live.idle);
      live.idle = undefined;
      const session = await this.#ensureSession(chatId, live, input.effort);
      const chat = this.#require(chatId).chat;
      const message = this.#repo.addMessage({
        id: this.#newId(),
        chatId,
        role: 'user',
        text: redactSecrets(input.text),
        attachments,
        mode: chat.mode,
        at: this.#iso(),
      });
      this.#deps.hub.publish({ type: 'chat_message', message });
      const patch: ChatUpdate = { state: 'running' };
      if (!stored.chat.title) patch.title = titleFrom(input.text, attachments);
      this.#update(chatId, patch);
      live.turn = { session, texts: [], interrupted: false };
      this.#emit(chatId, live, { type: 'status', payload: { state: 'running', detail: 'pensando' } });
      try {
        session.send(text, { images });
      } catch (err) {
        live.turn = undefined;
        live.busy = false;
        this.#update(chatId, { state: 'error' });
        throw new ChatError('invalid', oneLine(err));
      }
      return message;
    } catch (err) {
      if (!live.turn) {
        live.busy = false;
        // Un envío fallido no deja abierta la lectura de las carpetas de sus adjuntos.
        for (const root of addedRoots) live.roots.delete(root);
      }
      if (err instanceof AttachmentError) throw new ChatError(err.code, err.message);
      throw err;
    }
  }

  /** Corta el turno en curso (la conversación sigue). Sin turno, no hace nada. */
  async interrupt(chatId: string): Promise<Chat> {
    const chat = this.#require(chatId).chat;
    const live = this.#live.get(chatId);
    const turn = live?.turn;
    if (!live || !turn) return chat;
    turn.interrupted = true;
    try {
      await turn.session.interrupt();
    } catch (err) {
      this.#log(`chat ${chatId}: interrumpir falló: ${oneLine(err)}`);
    }
    if (live.turn === turn && !turn.grace) {
      turn.grace = setTimeout(() => {
        if (live.turn !== turn) return;
        // El SDK no cerró el turno: se corta la sesión; el próximo mensaje la reanuda.
        this.#dropSession(chatId, live);
        this.#finishTurn(chatId, live, turn, undefined);
      }, this.#graceMs);
      turn.grace.unref?.();
    }
    return this.#require(chatId).chat;
  }

  // ------------------------------------------------------------ propuestas

  proposals(chatId: string): Proposal[] {
    this.#require(chatId);
    return this.#liveOf(chatId).proposals.proposals();
  }

  /** Decisión del usuario: aprueba y entrega a la flota (la tarea pasa a `ready` en el tablero). */
  async approve(chatId: string, taskIds: readonly string[]): Promise<ApprovalOutcome> {
    this.#require(chatId);
    const proposals = this.#liveOf(chatId).proposals;
    let report: DeliveryReport;
    try {
      report = await approveAndDeliver(proposals, this.#fleet, taskIds);
    } catch (err) {
      if (err instanceof ProposalError) throw new ChatError(/No existe/.test(err.message) ? 'not_found' : 'conflict', err.message);
      throw err;
    }
    return { ...report, proposals: proposals.proposals() };
  }

  /** Aprueba y entrega todas las propuestas pendientes (y las aprobadas que aún no llegaron a la flota). */
  async approveAll(chatId: string): Promise<ApprovalOutcome> {
    this.#require(chatId);
    const proposals = this.#liveOf(chatId).proposals;
    const ids = proposals
      .list()
      .filter((p) => p.approval === 'proposed' || p.approval === 'approved')
      .map((p) => p.task.id);
    if (!ids.length) return { delivered: [], failed: [], proposals: proposals.proposals() };
    return this.approve(chatId, ids);
  }

  reject(chatId: string, taskIds: readonly string[]): Proposal[] {
    this.#require(chatId);
    const proposals = this.#liveOf(chatId).proposals;
    try {
      proposals.reject(taskIds);
    } catch (err) {
      if (err instanceof ProposalError) throw new ChatError(/No existe/.test(err.message) ? 'not_found' : 'conflict', err.message);
      throw err;
    }
    return proposals.proposals();
  }

  /** Cierra todas las sesiones vivas (al detener el núcleo). */
  shutdown(): void {
    for (const [chatId, live] of this.#live) {
      if (live.idle) clearTimeout(live.idle);
      if (live.turn) live.turn.interrupted = true;
      this.#dropSession(chatId, live);
    }
  }

  /** Sesión viva del chat (pruebas y diagnóstico). */
  sessionOf(chatId: string): ConductorSession | undefined {
    return this.#live.get(chatId)?.session;
  }

  // -------------------------------------------------------------- interno

  #iso(): string {
    return this.#now().toISOString();
  }

  #require(chatId: string): StoredChat {
    const stored = this.#repo.get(chatId);
    if (!stored) throw new ChatError('not_found', `No existe el chat ${chatId}`);
    return stored;
  }

  #update(chatId: string, patch: ChatUpdate): Chat {
    const { chat } = this.#repo.update(chatId, { ...patch, updatedAt: this.#iso() });
    const out = this.#withLive(chat);
    this.#deps.hub.publish({ type: 'chat', chat: out });
    return out;
  }

  /** Difunde el chat sin tocar la base (cambió algo que solo vive en memoria). */
  #publishLive(chatId: string): void {
    const stored = this.#repo.get(chatId);
    if (stored) this.#deps.hub.publish({ type: 'chat', chat: this.#withLive(stored.chat) });
  }

  #attachment(id: string): Attachment {
    const a = this.#deps.attachments.get(id);
    if (!a) throw new ChatError('not_found', `No existe el adjunto ${id}`);
    return a;
  }

  async #readAttachment(id: string): Promise<{ bytes: Uint8Array }> {
    try {
      return await this.#deps.attachments.read(id);
    } catch (err) {
      if (err instanceof AttachmentError) throw new ChatError(err.code, err.message);
      throw err;
    }
  }

  #liveOf(chatId: string): Live {
    let live = this.#live.get(chatId);
    if (!live) {
      const roots = new Set(
        this.#repo
          .attachmentsOf(chatId)
          .filter((a) => a.kind !== 'image')
          .map((a) => path.dirname(a.path)),
      );
      const proposals = new ChatProposals(this.#db, chatId, {
        now: this.#now,
        onChange: () => this.#deps.hub.publish({ type: 'proposals', chatId, proposals: proposals.proposals() }),
        taken: (taskId) => (this.#deps.store.getTask(taskId) ? `La tarea ${taskId} ya existe en el tablero; usa otro id` : undefined),
      });
      const sessionId = this.#require(chatId).chat.sessionId;
      live = { proposals, seq: this.#deps.store.getSession(sessionId)?.lastSeq ?? -1, busy: false, roots, background: new Set() };
      this.#live.set(chatId, live);
    }
    return live;
  }

  #modeOf(chatId: string): MindMode {
    return this.#repo.get(chatId)?.chat.mode ?? 'plan';
  }

  #drivesList(): readonly string[] {
    this.#drives ??= this.#deps.drives?.() ?? localDrives();
    return this.#drives;
  }

  /** Raíces de lectura además de `cwd` y de las carpetas extra: hub de skills, adjuntos y, en bypass, las unidades. */
  #rootsFor(chat: Chat, live: Live): string[] {
    return [...new Set([...(this.#deps.readRoots ?? []), ...live.roots, ...(chat.mode === 'bypass' ? this.#drivesList() : [])])];
  }

  /**
   * Sesión viva del chat con la forma vigente. El esfuerzo no es parte de la forma: el del turno
   * (`turnEffort ?? settings.mind.effort`) se aplica en vivo con `setEffort`; si el SDK no lo permite, la sesión se
   * recrea reanudada. Con subagentes vivos nunca se recrea (issue 7): el turno usa lo que tenga la sesión viva.
   */
  async #ensureSession(chatId: string, live: Live, turnEffort?: Effort): Promise<ConductorSession> {
    const { chat, sdkSessionId } = this.#require(chatId);
    // La carpeta interna de una conversación vuelve a existir si alguien la vació (Ajustes › Almacenamiento).
    if (this.#isInternalFolder(chat.cwd)) mkdirSync(chat.cwd, { recursive: true });
    const settings = this.#deps.settings();
    const mind = resolveMind(settings, this.#deps.mind.agents());
    const model = settings.mind.model ?? mind.model;
    const effort = turnEffort ?? settings.mind.effort;
    const roots = this.#rootsFor(chat, live);
    const plugins = await this.#pluginsOf(mind.id);
    const key = JSON.stringify({
      mind: mind.id,
      model: model ?? null,
      mode: chat.mode,
      cwd: chat.cwd,
      extraRoots: chat.extraRoots,
      roots: [...roots].sort(),
      plugins: Object.keys(plugins.mcpServers).sort(),
      // Huella de la configuración y de los secretos (un token renovado recrea la sesión): solo el hash, nunca el valor.
      pluginsHash: pluginsFingerprint(plugins),
      quotaFloor: settings.quotaFloor,
    });
    const alive = live.session && !live.session.closed ? live.session : undefined;
    if (alive) {
      const sameShape = live.key === key;
      const busy = live.background.size > 0;
      if (sameShape || busy) {
        // El esfuerzo cambia en vivo (sin recrear el proceso), también con subagentes trabajando.
        const applied = await alive.setEffort(effort);
        if (sameShape && applied) return alive;
        if (busy) {
          // Recrear la sesión mataría a los subagentes que siguen trabajando: el cambio rige cuando terminen.
          if (!sameShape) this.#log(`chat ${chatId}: los ajustes de la mente cambiaron, pero ${live.background.size} subagente(s) siguen trabajando; se aplican al terminar`);
          if (!applied) this.#log(`chat ${chatId}: el turno pidió esfuerzo ${effort}, pero ${live.background.size} subagente(s) siguen trabajando; usa el de la sesión viva (${alive.effort}) hasta que terminen`);
          return alive;
        }
      }
    }
    if (live.session) this.#dropSession(chatId, live);

    const left = this.#deps.mind.budgetLeftUsd?.(mind.id);
    if (left !== undefined && left <= 0) throw new ChatError('conflict', `Presupuesto de ${mind.id} agotado: súbelo en Ajustes → Agentes`);
    let env: Readonly<Record<string, string>>;
    try {
      env = { ...plugins.env, ...(await this.#deps.mind.env(mind.id)) };
    } catch (err) {
      throw new ChatError('not_configured', `No se pudo cargar la clave de ${mind.id}: ${oneLine(err)}`);
    }
    if (chat.mindAgentId !== mind.id) this.#update(chatId, { mindAgentId: mind.id });
    const port = this.#deps.mind;

    const session = new ConductorSession({
      ports: { ...this.#deps.ports, planner: this.#planner, fleet: this.#fleet, proposals: live.proposals },
      projectId: chat.projectId,
      cwd: chat.cwd,
      // La guardia lee las carpetas extra vigentes en cada llamada: quitarlas las revoca aunque haya subagentes vivos.
      extraRoots: () => this.#repo.get(chatId)?.chat.extraRoots ?? [],
      // Sin `workspace` el proyecto trabaja en modo local (directo en la carpeta, sin commits).
      ...(chat.projectId ? { workMode: this.#deps.store.getProject(chat.projectId)?.workspace ? 'worktrees' as const : 'local' as const } : {}),
      mode: () => this.#modeOf(chatId),
      autoApprove: (ids) => live.proposals.approve(ids),
      recordDestination: (input) => this.#recordDestination(chatId, input),
      readRoots: () => {
        const current = this.#repo.get(chatId)?.chat;
        return current ? this.#rootsFor(current, live) : roots;
      },
      denyPaths: [...(this.#deps.denyPaths ?? [])],
      env,
      ...(this.#deps.mind.baseEnv ? { baseEnv: this.#deps.mind.baseEnv() } : {}),
      ...(model ? { model } : {}),
      effort,
      quotaFloor: settings.quotaFloor,
      sessionId: chat.sessionId,
      translator: this.#deps.translator,
      ...(this.#deps.query ? { query: this.#deps.query } : {}),
      ...(sdkSessionId ? { resume: sdkSessionId } : {}),
      ...(Object.keys(plugins.mcpServers).length ? { mcpServers: { ...plugins.mcpServers } } : {}),
      ...(plugins.rules ? { pluginRules: plugins.rules } : {}),
      ...(port.pluginLive ? { pluginLive: (server: string) => port.pluginLive?.(mind.id, server) ?? true } : {}),
      ...(left !== undefined ? { maxBudgetUsd: left } : {}),
      onStderr: (line) => this.#log(`chat ${chatId} (stderr): ${line.slice(0, 500)}`),
    });
    live.session = session;
    live.key = key;
    // Los subagentes de un proceso anterior ya no existen.
    this.#stopBackground(chatId, live);
    // Un proceso del SDK nuevo cuenta el uso desde cero.
    live.delta = usageDeltas();
    void this.#read(chatId, live, session);
    return session;
  }

  #pluginsOf(agentId: string): Promise<MindPlugins> {
    if (this.#deps.mind.plugins) return this.#deps.mind.plugins(agentId);
    return Promise.resolve({ mcpServers: this.#deps.mcpServersFor?.(agentId) ?? {}, env: {} });
  }

  /** `crear_tareas.destino`: lo guarda (o vuelve a local con `null`), lo difunde como `chat_target` y lo devuelve resuelto. */
  async #recordDestination(chatId: string, input: { projectId: string; destination: DestinationRequest | null }): Promise<ChangesTarget> {
    const { chat } = this.#require(chatId);
    if (chat.projectId !== input.projectId) {
      throw new ChatError('invalid', `El destino se guarda por chat y solo para su proyecto (${chat.projectId ?? 'ninguno'}), no para ${input.projectId}`);
    }
    if (input.destination === null) this.#targets.clear(chatId);
    else this.#targets.set(chatId, normalizeDestination(input.destination), this.#iso());
    const target = await this.target(chatId);
    this.#deps.hub.publish({ type: 'chat_target', chatId, target });
    return target;
  }

  /** Suelta la sesión viva y la cierra; devuelve cuántos subagentes en segundo plano murieron con ella. */
  #dropSession(chatId: string, live: Live): number {
    const session = live.session;
    live.session = undefined;
    live.key = undefined;
    const stopped = this.#stopBackground(chatId, live);
    if (session && !session.closed) {
      try {
        session.close();
      } catch (err) {
        this.#log(`chat ${chatId}: cerrar la sesión falló: ${oneLine(err)}`);
      }
    }
    return stopped;
  }

  /**
   * Da por terminados los subagentes de un proceso del SDK que ya no existe: los cancela en la tienda (su aviso ya no
   * llegará) y difunde el chat. Devuelve cuántos eran.
   */
  #stopBackground(chatId: string, live: Live): number {
    const ids = [...live.background];
    if (!ids.length) return 0;
    live.background.clear();
    const parentSessionId = this.#repo.get(chatId)?.chat.sessionId;
    if (parentSessionId) {
      for (const sessionId of ids) {
        const payload = { state: 'cancelled' as const, detail: 'la sesión de la mente se cerró' };
        this.#emit(chatId, live, { sessionId, agentId: CONDUCTOR_AGENT_ID, parentSessionId, seq: 0, ts: this.#iso(), type: 'status', payload });
      }
    }
    this.#publishLive(chatId);
    return ids.length;
  }

  async #read(chatId: string, live: Live, session: ConductorSession): Promise<void> {
    let known = this.#repo.get(chatId)?.sdkSessionId ?? undefined;
    let warned = false;
    try {
      for await (const update of session.stream()) {
        const sdkId = sdkSessionIdOf(update.message);
        if (sdkId && sdkId !== known) {
          known = sdkId;
          try {
            this.#repo.update(chatId, { sdkSessionId: sdkId });
          } catch {
            /* el chat se borró */
          }
        }
        // La mente sigue sola (p. ej. terminó un subagente en segundo plano): es un turno más, con su respuesta
        // guardada en el historial y el chat en `running`, aunque nadie esté mirando.
        if (!live.turn && live.session === session && startsMainTurn(update.message)) this.#beginAutonomousTurn(chatId, live, session);
        for (const event of update.events) this.#emit(chatId, live, event);
        if (update.message.type === 'result' && live.turn?.session === session) this.#finishTurn(chatId, live, live.turn, update.message);
      }
    } catch (err) {
      if (this.#repo.get(chatId) && live.turn?.session === session && !live.turn.interrupted) {
        this.#emit(chatId, live, { type: 'error', payload: { code: 'crash', message: `La conversación con la mente se cortó: ${oneLine(err)}` } });
        warned = true;
      }
      this.#log(`chat ${chatId}: la sesión terminó con error: ${oneLine(err)}`);
    } finally {
      // El proceso del SDK terminó solo (caída, error fatal, tope de gasto): sus subagentes murieron con él y ya no
      // llegará su aviso. Los cierres de `#dropSession` y la sesión que reemplazó `#ensureSession` no pasan por aquí.
      if (live.session === session) {
        const stopped = this.#dropSession(chatId, live);
        if (stopped && !warned) {
          const message = `La sesión de la mente terminó; ${stopped} subagente(s) en segundo plano se detuvieron. Escríbele para retomar.`;
          this.#emit(chatId, live, { type: 'error', payload: { code: 'crash', message } });
        }
      }
      const turn = live.turn;
      if (turn?.session === session) this.#finishTurn(chatId, live, turn, undefined);
    }
  }

  /** Evento al hub: diferencias de uso, `seq` continuo, costo del chat y texto del turno. */
  #emit(chatId: string, live: Live, event: AgentEvent | Pick<AgentEvent, 'type' | 'payload'>): void {
    const stored = this.#repo.get(chatId);
    if (!stored) return;
    const full: AgentEvent =
      'sessionId' in event
        ? event
        : ({ sessionId: stored.chat.sessionId, agentId: CONDUCTOR_AGENT_ID, seq: 0, ts: this.#iso(), ...event } as AgentEvent);
    const delta = live.delta ? live.delta(full) : full;
    if (!delta) return;
    const out = { ...delta, seq: ++live.seq } as AgentEvent;
    const main = out.sessionId === stored.chat.sessionId && !out.parentSessionId;
    if (out.type === 'status' && out.parentSessionId === stored.chat.sessionId) this.#trackBackground(chatId, live, out.sessionId, out.payload.state);
    if (main && out.type === 'text' && out.payload.role === 'assistant') live.turn?.texts.push(out.payload.text);
    try {
      this.#deps.hub.append(out);
    } catch (err) {
      this.#log(`chat ${chatId}: no se pudo guardar un evento: ${oneLine(err)}`);
    }
    if (main && out.type === 'usage' && out.payload.costUsd) {
      const costUsd = Math.round((stored.chat.costUsd + out.payload.costUsd) * 1e9) / 1e9;
      this.#update(chatId, { costUsd });
    }
  }

  #finishTurn(chatId: string, live: Live, turn: Turn, message: SDKMessage | undefined): void {
    if (live.turn !== turn) return;
    live.turn = undefined;
    live.busy = false;
    if (turn.grace) clearTimeout(turn.grace);
    const stored = this.#repo.get(chatId);
    if (!stored) return;
    const result = message ? resultSchema.safeParse(message) : undefined;
    const ok = result?.success === true && result.data.subtype === 'success' && result.data.is_error !== true;
    const final = ok && result.data.result?.trim() ? result.data.result : turn.texts.join('\n\n');
    if (final.trim()) {
      const reply = this.#repo.addMessage({
        id: this.#newId(),
        chatId,
        role: 'assistant',
        text: turn.session.redact(final),
        attachments: [],
        mode: stored.chat.mode,
        at: this.#iso(),
      });
      this.#deps.hub.publish({ type: 'chat_message', message: reply });
    }
    if (stored.chat.state !== 'closed') this.#update(chatId, { state: ok || turn.interrupted ? 'idle' : 'error' });
    this.#scheduleIdle(chatId, live);
  }

  /** Turno que arranca la mente sin mensaje del usuario: ocupa el chat y su respuesta se guarda como cualquier otra. */
  #beginAutonomousTurn(chatId: string, live: Live, session: ConductorSession): void {
    if (!this.#repo.get(chatId)) return;
    live.turn = { session, texts: [], interrupted: false };
    live.busy = true;
    if (live.idle) clearTimeout(live.idle);
    live.idle = undefined;
    this.#update(chatId, { state: 'running' });
  }

  /** Lleva la cuenta de los subagentes de la mente que siguen trabajando y la difunde al cambiar. */
  #trackBackground(chatId: string, live: Live, sessionId: string, state: string): void {
    const before = live.background.size;
    if (state === 'starting' || state === 'running' || state === 'waiting') live.background.add(sessionId);
    else live.background.delete(sessionId);
    if (live.background.size === before) return;
    this.#publishLive(chatId);
    // Terminó el último y la mente está libre: vuelve a correr el plazo de inactividad.
    if (live.background.size === 0 && !live.busy) this.#scheduleIdle(chatId, live);
  }

  #scheduleIdle(chatId: string, live: Live): void {
    if (live.idle) clearTimeout(live.idle);
    if (!live.session) return;
    live.idle = setTimeout(() => {
      live.idle = undefined;
      if (live.busy) return;
      // Con subagentes trabajando no se cierra: se vuelve a mirar en otro plazo.
      if (live.background.size > 0) return this.#scheduleIdle(chatId, live);
      this.#dropSession(chatId, live);
    }, this.#idleMs);
    live.idle.unref?.();
  }

  /**
   * Entrega a la flota: la tarea entra al tablero como `ready` (o vuelve a `ready` si quedó `pending` tras un rechazo)
   * y se encola. Si la flota no la acepta, vuelve a `pending` en el tablero (la propuesta sigue aprobada).
   */
  async #deliver(task: TaskBrief): Promise<DelegateResult> {
    const { store, hub } = this.#deps;
    const existing = store.getTask(task.id);
    if (existing && (existing.state !== 'pending' || JSON.stringify(existing.task) !== JSON.stringify(task))) {
      return { accepted: false, reason: `Ya existe la tarea ${task.id} en el tablero (${existing.state})` };
    }
    try {
      hub.publishTask(existing ? store.setTaskState(task.id, 'ready') : store.putTask(task, 'ready'));
    } catch (err) {
      return { accepted: false, reason: oneLine(err) };
    }
    let result: DelegateResult;
    try {
      result = await this.#deps.ports.fleet.delegate(task);
    } catch (err) {
      result = { accepted: false, reason: oneLine(err) };
    }
    if (!result.accepted) {
      try {
        hub.publishTask(store.setTaskState(task.id, 'pending'));
      } catch (err) {
        this.#log(`chat: no se pudo devolver ${task.id} a pendiente: ${oneLine(err)}`);
      }
    }
    return result;
  }
}

function requireDir(raw: string, what: string): string {
  if (!path.isAbsolute(raw)) throw new ChatError('invalid', `${what}: la ruta debe ser absoluta (${raw})`);
  const dir = path.resolve(raw);
  if (redactSecrets(dir) !== dir) throw new ChatError('invalid', `${what}: la ruta tiene forma de clave`);
  let ok = false;
  try {
    ok = statSync(dir).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) throw new ChatError('invalid', `${what}: no existe la carpeta ${dir}`);
  return dir;
}

function uniqueDirs(raw: readonly string[]): string[] {
  return [...new Set(raw.map((r) => requireDir(r, 'extraRoots')))];
}

export { toProposal };
