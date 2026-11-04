/**
 * Chat con la mente (F5, c15): conversaciones guardadas en SQLite, cada una con una `ConductorSession` viva y perezosa.
 *
 * - La sesión se crea con el primer mensaje y se cierra tras `idleMs` sin uso (15 min), al cerrar o al borrar el chat.
 *   Al recrearla se reanuda con `resume` (el `session_id` del SDK guardado), así no se pierde el contexto.
 * - Lo que cambia la forma de la sesión (mente, modelo, esfuerzo, modo, raíces de lectura, plugins) se compara en
 *   cada mensaje: si cambió, la sesión se recrea (reanudada) y el cambio rige desde ese turno. El modo, además, se lee
 *   en cada llamada de la guardia y de las herramientas.
 * - Los eventos de la sesión van al hub (`hub.append`, SQLite + `/ws`) con `sessionId = chat.sessionId`, en
 *   diferencias de uso (`usageDeltas`) y con `seq` continuo entre sesiones reanudadas.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { McpServerConfig, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { redactSecrets } from '../../shared/index.ts';
import type {
  AgentConfig,
  AgentEvent,
  Attachment,
  Chat,
  ChatMessage,
  CreateChatBody,
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
  imageTooLarge,
  sdkSessionIdOf,
  usageDeltas,
} from '../conductor/index.ts';
import type {
  ConductorPorts,
  ConductorQueryFn,
  DelegateResult,
  DeliveryReport,
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
export type ChatStorePort = Pick<SqliteStore, 'getProject' | 'getTask' | 'putTask' | 'setTaskState' | 'getSession' | 'listTasks'>;
/** Lo que el chat necesita del hub (`/ws`). */
export type ChatHub = Pick<EventHub, 'append' | 'publish' | 'publishTask'>;

/** De dónde sale la mente: agentes registrados y su entorno (clave de la bóveda, solo en memoria). */
export interface MindPort {
  agents(): readonly AgentConfig[];
  env(agentId: string): Promise<Readonly<Record<string, string>>>;
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
  /** Servidores MCP de plugins para la mente (c16 `PluginService.mcpServersFor`). */
  mcpServersFor?: (agentId: string) => Readonly<Record<string, McpServerConfig>>;
  /** Raíces fijas de lectura (p. ej. el hub de skills). */
  readRoots?: readonly string[];
  /** Archivos que la mente nunca lee (bóveda y base de datos del núcleo). */
  denyPaths?: readonly string[];
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
}

export interface SendInput {
  text: string;
  attachmentIds?: readonly string[];
}

export interface ApprovalOutcome extends DeliveryReport {
  proposals: Proposal[];
}

const resultSchema = z.object({ type: z.literal('result'), subtype: z.string(), is_error: z.boolean().optional(), result: z.string().optional() }).loose();

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

function titleFrom(text: string, attachments: readonly Attachment[]): string {
  const line = text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? attachments[0]?.name ?? '';
  const flat = redactSecrets(line.replace(/\s+/g, ' '));
  return flat.length <= TITLE_MAX ? flat : `${flat.slice(0, TITLE_MAX - 1)}…`;
}

function oneLine(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 500);
}

export class ChatService {
  readonly #deps: ChatServiceDeps;
  readonly #db: ChatDb;
  readonly #repo: ChatRepo;
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
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? randomUUID;
    this.#idleMs = deps.idleMs ?? CHAT_IDLE_MS;
    this.#graceMs = deps.interruptGraceMs ?? INTERRUPT_GRACE_MS;
    this.#log = deps.log ?? (() => undefined);
    this.#repo.resetRunning(this.#iso());

    const base = deps.ports.fleet;
    this.#fleet = {
      delegate: (task) => this.#deliver(task),
      status: (taskId) => base.status(taskId),
      list: () => base.list(),
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

  // ---------------------------------------------------------------- chats

  list(projectId?: string | null): Chat[] {
    return this.#repo.list(projectId);
  }

  get(chatId: string): Chat {
    return this.#require(chatId).chat;
  }

  create(body: CreateChatBody): Chat {
    const settings = this.#deps.settings();
    let cwd: string;
    if (body.projectId !== null) {
      const project = this.#deps.store.getProject(body.projectId);
      if (!project) throw new ChatError('not_found', `No existe el proyecto ${body.projectId}`);
      cwd = requireDir(body.cwd ?? project.repoPath, 'cwd');
    } else {
      if (!body.cwd) throw new ChatError('invalid', 'Un agente suelto necesita su carpeta (cwd)');
      cwd = requireDir(body.cwd, 'cwd');
    }
    const extraRoots = uniqueDirs(body.extraRoots ?? []);
    const mind = resolveMind(settings, this.#deps.mind.agents());
    const id = this.#newId();
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
    this.#deps.hub.publish({ type: 'chat', chat });
    return chat;
  }

  /** Renombrar, cambiar el modo o las carpetas extra. Rige desde el turno siguiente (la guardia ve el modo al instante). */
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

  // ------------------------------------------------------------- mensajes

  /**
   * Guarda el mensaje del usuario y lo entrega a la mente. Vuelve en cuanto el mensaje está guardado: la respuesta
   * llega por `/ws`. Con un turno en curso, `conflict`.
   */
  async send(chatId: string, input: SendInput): Promise<ChatMessage> {
    const stored = this.#require(chatId);
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
      const text = redactSecrets(composeUserText(input.text, files));
      if (!text.trim() && !images.length) throw new ChatError('invalid', 'Mensaje vacío');

      if (live.idle) clearTimeout(live.idle);
      live.idle = undefined;
      const session = await this.#ensureSession(chatId, live);
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
    this.#deps.hub.publish({ type: 'chat', chat });
    return chat;
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
      live = { proposals, seq: this.#deps.store.getSession(sessionId)?.lastSeq ?? -1, busy: false, roots };
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

  async #ensureSession(chatId: string, live: Live): Promise<ConductorSession> {
    const { chat, sdkSessionId } = this.#require(chatId);
    const settings = this.#deps.settings();
    const mind = resolveMind(settings, this.#deps.mind.agents());
    const model = settings.mind.model ?? mind.model;
    const effort = settings.mind.effort;
    const plugins = { ...(this.#deps.mcpServersFor?.(mind.id) ?? {}) };
    const roots = this.#rootsFor(chat, live);
    const key = JSON.stringify({
      mind: mind.id,
      model: model ?? null,
      effort,
      mode: chat.mode,
      cwd: chat.cwd,
      extraRoots: chat.extraRoots,
      roots: [...roots].sort(),
      plugins: Object.keys(plugins).sort(),
      quotaFloor: settings.quotaFloor,
    });
    if (live.session && !live.session.closed && live.key === key) return live.session;
    if (live.session) this.#dropSession(chatId, live);

    const left = this.#deps.mind.budgetLeftUsd?.(mind.id);
    if (left !== undefined && left <= 0) throw new ChatError('conflict', `Presupuesto de ${mind.id} agotado: súbelo en Ajustes → Agentes`);
    let env: Readonly<Record<string, string>>;
    try {
      env = await this.#deps.mind.env(mind.id);
    } catch (err) {
      throw new ChatError('not_configured', `No se pudo cargar la clave de ${mind.id}: ${oneLine(err)}`);
    }
    if (chat.mindAgentId !== mind.id) this.#update(chatId, { mindAgentId: mind.id });

    const session = new ConductorSession({
      ports: { ...this.#deps.ports, planner: this.#planner, fleet: this.#fleet, proposals: live.proposals },
      projectId: chat.projectId,
      cwd: chat.cwd,
      extraRoots: chat.extraRoots,
      mode: () => this.#modeOf(chatId),
      autoApprove: (ids) => live.proposals.approve(ids),
      readRoots: () => {
        const current = this.#repo.get(chatId)?.chat;
        return current ? [...current.extraRoots, ...this.#rootsFor(current, live)] : roots;
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
      ...(Object.keys(plugins).length ? { mcpServers: plugins } : {}),
      ...(left !== undefined ? { maxBudgetUsd: left } : {}),
      onStderr: (line) => this.#log(`chat ${chatId} (stderr): ${line.slice(0, 500)}`),
    });
    live.session = session;
    live.key = key;
    // Un proceso del SDK nuevo cuenta el uso desde cero.
    live.delta = usageDeltas();
    void this.#read(chatId, live, session);
    return session;
  }

  #dropSession(chatId: string, live: Live): void {
    const session = live.session;
    live.session = undefined;
    live.key = undefined;
    if (session && !session.closed) {
      try {
        session.close();
      } catch (err) {
        this.#log(`chat ${chatId}: cerrar la sesión falló: ${oneLine(err)}`);
      }
    }
  }

  async #read(chatId: string, live: Live, session: ConductorSession): Promise<void> {
    let known = this.#repo.get(chatId)?.sdkSessionId ?? undefined;
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
        for (const event of update.events) this.#emit(chatId, live, event);
        if (update.message.type === 'result' && live.turn?.session === session) this.#finishTurn(chatId, live, live.turn, update.message);
      }
    } catch (err) {
      if (this.#repo.get(chatId) && live.turn?.session === session && !live.turn.interrupted) {
        this.#emit(chatId, live, { type: 'error', payload: { code: 'crash', message: `La conversación con la mente se cortó: ${oneLine(err)}` } });
      }
      this.#log(`chat ${chatId}: la sesión terminó con error: ${oneLine(err)}`);
    } finally {
      if (live.session === session) {
        live.session = undefined;
        live.key = undefined;
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

  #scheduleIdle(chatId: string, live: Live): void {
    if (live.idle) clearTimeout(live.idle);
    if (!live.session) return;
    live.idle = setTimeout(() => {
      live.idle = undefined;
      if (!live.busy) this.#dropSession(chatId, live);
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
