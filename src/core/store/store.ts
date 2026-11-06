import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { z } from 'zod';
import {
  agentConfigSchema,
  agentEventSchema,
  idSchema,
  probeResultSchema,
  quotaMethodSchema,
  quotaSnapshotSchema,
  redactSecrets,
  sessionStateSchema,
  taskBriefSchema,
  taskStateSchema,
  type AgentConfig,
  type AgentEvent,
  type EventSink,
  type ProbeResult,
  type QuotaMethod,
  type QuotaSnapshot,
  type TaskBrief,
  type TaskState,
} from '../../shared/index.ts';
import { defaultWorktreesRoot, projectsOverlapProblem, projectWorkspaceProblem, projectWorkspaceSchema, type ProjectWorkspace } from '../workspace/config.ts';
import { redactDeep } from './redact-deep.ts';
import { MIGRATIONS } from './schema.ts';

export type SessionState = z.infer<typeof sessionStateSchema>;

export interface AgentRecord {
  config: AgentConfig;
  quotaMethod: QuotaMethod | null;
  lastProbe: ProbeResult | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentInput {
  config: AgentConfig;
  quotaMethod?: QuotaMethod | null;
  lastProbe?: ProbeResult | null;
}

export interface EventsPage {
  events: AgentEvent[];
  /** `seq` del último evento devuelto (o el `since` pedido si no hay nuevos). */
  lastSeq: number;
  hasMore: boolean;
}

export const projectInputSchema = z
  .strictObject({
    id: idSchema,
    name: z.string().min(1).max(120),
    repoPath: z.string().min(1).max(1024),
    /** Worktrees de la flota (enlaces, postCreate, gate); sin él la flota no crea ni integra tareas del proyecto. */
    workspace: projectWorkspaceSchema.optional(),
  })
  .superRefine((p, ctx) => {
    const why = p.workspace && projectWorkspaceProblem(p.id, p.repoPath, p.workspace);
    if (why) ctx.addIssue({ code: 'custom', path: ['workspace'], message: why });
  });
export type ProjectInput = z.input<typeof projectInputSchema>;
export interface ProjectRecord {
  id: string;
  name: string;
  repoPath: string;
  /** Solo si se registró con configuración de worktrees (con los valores por defecto ya puestos). */
  workspace?: ProjectWorkspace;
  createdAt: string;
}

export interface PlanRecord {
  id: string;
  projectId: string;
  text: string;
  warnings: string[];
  createdAt: string;
  taskIds: string[];
}

export interface TaskRecord {
  task: TaskBrief;
  state: TaskState;
  planId: string | null;
  agentId: string | null;
  /** Motivo del último cambio de estado (p. ej. por qué falló), ya tachado; `null` si no lo hubo. */
  detail: string | null;
  /** Veces que la flota empezó la tarea (la primera y cada reintento). */
  attempts: number;
  createdAt: string;
  updatedAt: string;
  /** Hora del último evento de sus agentes (autor o revisor); `null` si aún no hubo ninguno. */
  lastEventAt: string | null;
}

/** Cambios de `setTaskState` además del estado. */
export interface TaskStateUpdate {
  /** Motivo del cambio: `null` lo borra; sin valor se conserva el anterior. Se tacha y se recorta. */
  detail?: string | null;
  /** Suma un intento (la flota empieza la tarea). */
  countAttempt?: boolean;
}

/** Tope del motivo guardado de una tarea. */
export const MAX_TASK_DETAIL_CHARS = 2_000;

export interface SessionRecord {
  id: string;
  agentId: string;
  taskId: string | null;
  parentSessionId: string | null;
  state: SessionState;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  /** Último `seq` guardado (-1 si aún no hay eventos): punto de partida para reconectar. */
  lastSeq: number;
}

export const usageGroupSchema = z.enum(['agent', 'day', 'session', 'model']);
export type UsageGroup = z.infer<typeof usageGroupSchema>;

export interface UsageQuery {
  groupBy?: readonly UsageGroup[];
  agentId?: string;
  sessionId?: string;
  model?: string;
  /** Día inicial inclusivo (AAAA-MM-DD, en la zona horaria del almacén). */
  from?: string;
  /** Día final inclusivo. */
  to?: string;
}

export interface UsageRow {
  agentId?: string;
  day?: string;
  sessionId?: string;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  /** Número de eventos `usage` sumados. */
  entries: number;
}

export interface QuotaRecord {
  snapshot: QuotaSnapshot;
  recordedAt: string;
}

export interface StoreOptions {
  /** Ruta del archivo SQLite o `:memory:`. */
  path: string;
  /** Zona horaria para la columna `day` del uso (por defecto la del sistema). */
  timeZone?: string;
  now?: () => Date;
}

export type StoreErrorCode = 'invalid' | 'not_found' | 'conflict';
export class StoreError extends Error {
  override readonly name = 'StoreError';
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// Filas de SQLite validadas con Zod (el archivo es un dato externo).
const text = z.string();
const optText = z.string().nullable();
const int = z.union([z.number(), z.bigint()]).transform(Number);
const agentRow = z.object({ config_json: text, quota_method: optText, last_probe_json: optText, created_at: text, updated_at: text });
const projectRow = z.object({ id: text, name: text, repo_path: text, workspace_json: optText, created_at: text });
const planRow = z.object({ id: text, project_id: text, text, warnings_json: text, created_at: text });
const taskRow = z.object({
  brief_json: text,
  state: text,
  plan_id: optText,
  agent_id: optText,
  detail: optText,
  attempts: int,
  created_at: text,
  updated_at: text,
  last_event_at: optText,
});
/** Columnas de una tarea; la hora del último evento sale de sus sesiones (autor y revisor). */
const TASK_COLUMNS =
  'brief_json, state, plan_id, agent_id, detail, attempts, created_at, updated_at, (SELECT MAX(s.updated_at) FROM sessions s WHERE s.task_id = tasks.id) AS last_event_at';
const sessionRow = z.object({
  id: text,
  agent_id: text,
  task_id: optText,
  parent_session_id: optText,
  state: text,
  started_at: text,
  updated_at: text,
  ended_at: optText,
  last_seq: int,
});
const eventRow = z.object({ session_id: text, seq: int, agent_id: text, parent_session_id: optText, type: text, ts: text, payload_json: text });
const quotaRow = z.object({ snapshot_json: text, recorded_at: text });
const usageRow = z.object({
  agentId: text.optional(),
  day: text.optional(),
  sessionId: text.optional(),
  model: optText.optional(),
  inputTokens: int.nullable(),
  outputTokens: int.nullable(),
  cachedInputTokens: int.nullable(),
  reasoningTokens: int.nullable(),
  costUsd: z.number().nullable(),
  entries: int,
});

const json = <T>(schema: z.ZodType<T>, raw: string): T => schema.parse(JSON.parse(raw));

/** Máximo de eventos por página (`eventsSince`/`eventsPage`). */
export const MAX_EVENTS_PAGE = 5000;

function fieldsOf(error: z.ZodError): string {
  return error.issues.map((i) => i.path.join('.') || '(raíz)').join(', ');
}

/**
 * Valida, tacha todas las cadenas y vuelve a validar. Si el tachado deja el dato inválido (p. ej. un id
 * con forma de clave), se rechaza: guardar `[REDACTADO]` como id rompería las lecturas posteriores.
 */
function sanitize<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new StoreError('invalid', `${what} inválido: ${fieldsOf(parsed.error)}`);
  const again = schema.safeParse(redactDeep(parsed.data));
  if (!again.success) throw new StoreError('invalid', `${what}: un campo con forma de clave no se puede guardar (${fieldsOf(again.error)})`);
  return again.data;
}

/** Id válido que además no tiene forma de clave. */
function cleanId(value: unknown, what: string): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) throw new StoreError('invalid', `Id de ${what} inválido`);
  if (redactSecrets(parsed.data) !== parsed.data) throw new StoreError('invalid', `El id de ${what} tiene forma de clave`);
  return parsed.data;
}
const dayRegex = /^\d{4}-\d{2}-\d{2}$/;
const USAGE_COLUMNS: Record<UsageGroup, { column: string; alias: string }> = {
  agent: { column: 'agent_id', alias: 'agentId' },
  day: { column: 'day', alias: 'day' },
  session: { column: 'session_id', alias: 'sessionId' },
  model: { column: 'model', alias: 'model' },
};

/**
 * Almacén SQLite (`node:sqlite`) del núcleo: agentes, proyectos, planes, tareas, sesiones,
 * eventos (con las cadenas tachadas), uso y fotos de cupo. Implementa `EventSink`.
 */
export class SqliteStore implements EventSink {
  readonly path: string;
  private readonly db: DatabaseSync;

  /**
   * Base de datos para los módulos de F5 (ajustes, chats, plugins): cada uno crea sus tablas con
   * `CREATE TABLE IF NOT EXISTS <módulo>_…` y tacha lo que guarda. Las tablas del núcleo siguen en `schema.ts`.
   */
  get database(): DatabaseSync {
    return this.db;
  }
  private readonly statements = new Map<string, StatementSync>();
  private readonly dayFormat: Intl.DateTimeFormat;
  private readonly now: () => Date;

  constructor(opts: StoreOptions) {
    this.path = opts.path;
    this.now = opts.now ?? (() => new Date());
    this.dayFormat = new Intl.DateTimeFormat('en-CA', {
      timeZone: opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    if (opts.path !== ':memory:') mkdirSync(dirname(opts.path), { recursive: true });
    this.db = new DatabaseSync(opts.path);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    if (opts.path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  close(): void {
    this.statements.clear();
    if (this.db.isOpen) this.db.close();
  }

  /** Versión del esquema aplicada. */
  schemaVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get();
    return Number(row?.user_version ?? 0);
  }

  // ---------------------------------------------------------------- agentes

  /** Crea o actualiza un agente. `quotaMethod`/`lastProbe` omitidos conservan el valor guardado. */
  putAgent(input: AgentInput): AgentRecord {
    return this.writeAgent(input, false);
  }

  /** Crea un agente nuevo; `conflict` si el id ya existe (nunca reemplaza). */
  createAgent(input: AgentInput): AgentRecord {
    return this.writeAgent(input, true);
  }

  getAgent(id: string): AgentRecord | undefined {
    const raw = this.stmt('SELECT config_json, quota_method, last_probe_json, created_at, updated_at FROM agents WHERE id = ?').get(id);
    return raw ? this.toAgent(raw) : undefined;
  }

  listAgents(): AgentRecord[] {
    return this.stmt('SELECT config_json, quota_method, last_probe_json, created_at, updated_at FROM agents ORDER BY id')
      .all()
      .map((r) => this.toAgent(r));
  }

  deleteAgent(id: string): boolean {
    return Number(this.stmt('DELETE FROM agents WHERE id = ?').run(id).changes) > 0;
  }

  // -------------------------------------------------------------- proyectos

  /** Crea o reemplaza un proyecto entero (también `workspace`: si no viene, queda sin configuración de worktrees). */
  putProject(input: ProjectInput): ProjectRecord {
    const raw = projectInputSchema.safeParse(input);
    // Un comando o una ruta tachados dejarían un gate roto sin avisar: con forma de clave, se rechaza.
    if (raw.success && raw.data.workspace && JSON.stringify(redactDeep(raw.data.workspace)) !== JSON.stringify(raw.data.workspace)) {
      throw new StoreError('invalid', 'Proyecto: la configuración de worktrees (workspace) no puede llevar claves');
    }
    const p = sanitize(projectInputSchema, input, 'Proyecto');
    cleanId(p.id, 'proyecto');
    if (p.workspace) {
      // Dos proyectos de la flota no comparten copia ni raíz de worktrees (la guardia de uno tocaría los del otro).
      const paths = (x: { id: string; repoPath: string; workspace?: { worktreesRoot?: string | undefined } }) => ({
        id: x.id,
        repoPath: x.repoPath,
        worktreesRoot: x.workspace?.worktreesRoot ?? defaultWorktreesRoot(x.id),
      });
      const overlap = projectsOverlapProblem(paths(p), this.listProjects().filter((o) => o.workspace).map(paths));
      if (overlap) throw new StoreError('invalid', `Proyecto: ${overlap}`);
    }
    const existing = this.getProject(p.id);
    const createdAt = existing?.createdAt ?? this.iso();
    this.stmt(
      `INSERT INTO projects (id, name, repo_path, workspace_json, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, repo_path = excluded.repo_path, workspace_json = excluded.workspace_json`,
    ).run(p.id, p.name, p.repoPath, p.workspace ? JSON.stringify(p.workspace) : null, createdAt);
    return { id: p.id, name: p.name, repoPath: p.repoPath, ...(p.workspace ? { workspace: p.workspace } : {}), createdAt };
  }

  getProject(id: string): ProjectRecord | undefined {
    const raw = this.stmt('SELECT id, name, repo_path, workspace_json, created_at FROM projects WHERE id = ?').get(id);
    return raw ? toProject(raw) : undefined;
  }

  listProjects(): ProjectRecord[] {
    return this.stmt('SELECT id, name, repo_path, workspace_json, created_at FROM projects ORDER BY id').all().map(toProject);
  }

  deleteProject(id: string): boolean {
    return Number(this.stmt('DELETE FROM projects WHERE id = ?').run(id).changes) > 0;
  }

  // ------------------------------------------------------- planes y tareas

  /** Guarda un plan y sus tareas (estado `pending`) en una transacción. Falla si algún id de tarea ya existe. */
  createPlan(input: { id: string; projectId: string; text: string; warnings?: readonly string[]; tasks: readonly TaskBrief[] }): PlanRecord {
    const id = cleanId(input.id, 'plan');
    const projectId = cleanId(input.projectId, 'proyecto');
    const tasks = input.tasks.map((t) => sanitize(taskBriefSchema, t, 'Tarea'));
    const ids = new Set<string>();
    for (const t of tasks) {
      if (t.projectId !== projectId) throw new StoreError('invalid', `La tarea ${t.id} pertenece a otro proyecto (${t.projectId})`);
      if (ids.has(t.id)) throw new StoreError('invalid', `Id de tarea repetido en el plan: ${t.id}`);
      ids.add(t.id);
    }
    const ts = this.iso();
    const warnings = redactDeep([...(input.warnings ?? [])]);
    const textRedacted = redactDeep(input.text);
    this.tx(() => {
      if (this.stmt('SELECT 1 FROM plans WHERE id = ?').get(id)) throw new StoreError('conflict', `El plan ${id} ya existe`);
      for (const t of tasks) {
        if (this.stmt('SELECT 1 FROM tasks WHERE id = ?').get(t.id)) throw new StoreError('conflict', `La tarea ${t.id} ya existe`);
      }
      this.stmt('INSERT INTO plans (id, project_id, text, warnings_json, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        projectId,
        textRedacted,
        JSON.stringify(warnings),
        ts,
      );
      for (const t of tasks) this.insertTask(t, 'pending', id, ts);
    });
    return { id, projectId, text: textRedacted, warnings, createdAt: ts, taskIds: tasks.map((t) => t.id) };
  }

  getPlan(id: string): PlanRecord | undefined {
    const raw = this.stmt('SELECT id, project_id, text, warnings_json, created_at FROM plans WHERE id = ?').get(id);
    if (!raw) return undefined;
    const r = planRow.parse(raw);
    const taskIds = this.stmt('SELECT id FROM tasks WHERE plan_id = ? ORDER BY rowid')
      .all(id)
      .map((row) => z.object({ id: text }).parse(row).id);
    return { id: r.id, projectId: r.project_id, text: r.text, warnings: json(z.array(z.string()), r.warnings_json), createdAt: r.created_at, taskIds };
  }

  /** Crea o reemplaza una tarea suelta (sin plan). */
  putTask(task: TaskBrief, state: TaskState = 'pending', planId: string | null = null): TaskRecord {
    const t = sanitize(taskBriefSchema, task, 'Tarea');
    if (planId !== null) cleanId(planId, 'plan');
    const existing = this.getTask(t.id);
    const ts = this.iso();
    if (existing) {
      this.stmt('UPDATE tasks SET project_id = ?, plan_id = ?, state = ?, brief_json = ?, updated_at = ? WHERE id = ?').run(
        t.projectId,
        planId,
        taskStateSchema.parse(state),
        JSON.stringify(t),
        ts,
        t.id,
      );
    } else {
      this.insertTask(t, state, planId, ts);
    }
    const saved = this.getTask(t.id);
    if (!saved) throw new StoreError('invalid', `No se pudo guardar la tarea ${t.id}`);
    return saved;
  }

  getTask(id: string): TaskRecord | undefined {
    const raw = this.stmt(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(id);
    return raw ? toTask(raw) : undefined;
  }

  listTasks(filter: { projectId?: string; state?: TaskState; planId?: string } = {}): TaskRecord[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.projectId) addWhere(where, params, 'project_id = ?', filter.projectId);
    if (filter.state) addWhere(where, params, 'state = ?', filter.state);
    if (filter.planId) addWhere(where, params, 'plan_id = ?', filter.planId);
    const sql = `SELECT ${TASK_COLUMNS} FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, rowid`;
    return this.stmt(sql).all(...params).map(toTask);
  }

  /**
   * Cambia el estado. `agentId` sin valor conserva el agente; `update.detail` guarda el motivo (tachado) y
   * `update.countAttempt` suma un intento.
   */
  setTaskState(id: string, state: TaskState, agentId?: string | null, update: TaskStateUpdate = {}): TaskRecord {
    const s = taskStateSchema.parse(state);
    if (agentId !== undefined && agentId !== null) cleanId(agentId, 'agente');
    const sets = ['state = ?', 'updated_at = ?'];
    const params: SQLInputValue[] = [s, this.iso()];
    if (agentId !== undefined) {
      sets.push('agent_id = ?');
      params.push(agentId);
    }
    if (update.detail !== undefined) {
      sets.push('detail = ?');
      params.push(update.detail === null ? null : cleanDetail(update.detail));
    }
    if (update.countAttempt) sets.push('attempts = attempts + 1');
    const res = this.stmt(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    if (Number(res.changes) === 0) throw new StoreError('not_found', `No existe la tarea ${id}`);
    const saved = this.getTask(id);
    if (!saved) throw new StoreError('not_found', `No existe la tarea ${id}`);
    return saved;
  }

  // --------------------------------------------------------------- sesiones

  /** Registra una sesión antes de su primer evento (para enlazarla a la tarea). */
  startSession(input: { id: string; agentId: string; taskId?: string; parentSessionId?: string }): SessionRecord {
    // Los ids de sesión vienen de los adaptadores: se tachan igual que en `appendEvent` para que coincidan.
    const id = redactSecrets(z.string().min(1).parse(input.id));
    const agentId = cleanId(input.agentId, 'agente');
    const taskId = input.taskId === undefined ? null : cleanId(input.taskId, 'tarea');
    const parentSessionId = input.parentSessionId === undefined ? null : redactSecrets(z.string().min(1).parse(input.parentSessionId));
    const ts = this.iso();
    this.stmt(
      `INSERT INTO sessions (id, agent_id, task_id, parent_session_id, state, started_at, updated_at)
       VALUES (?, ?, ?, ?, 'starting', ?, ?)
       ON CONFLICT(id) DO UPDATE SET task_id = COALESCE(excluded.task_id, sessions.task_id),
         parent_session_id = COALESCE(sessions.parent_session_id, excluded.parent_session_id)`,
    ).run(id, agentId, taskId, parentSessionId, ts, ts);
    const saved = this.getSession(id);
    if (!saved) throw new StoreError('invalid', `No se pudo registrar la sesión ${id}`);
    return saved;
  }

  getSession(id: string): SessionRecord | undefined {
    const raw = this.stmt('SELECT * FROM sessions WHERE id = ?').get(id);
    return raw ? toSession(raw) : undefined;
  }

  listSessions(filter: { taskId?: string; agentId?: string; parentSessionId?: string; limit?: number } = {}): SessionRecord[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.taskId) addWhere(where, params, 'task_id = ?', filter.taskId);
    if (filter.agentId) addWhere(where, params, 'agent_id = ?', filter.agentId);
    if (filter.parentSessionId) addWhere(where, params, 'parent_session_id = ?', filter.parentSessionId);
    params.push(Math.min(Math.max(filter.limit ?? 200, 1), 1000));
    const sql = `SELECT * FROM sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, rowid DESC LIMIT ?`;
    return this.stmt(sql).all(...params).map(toSession);
  }

  /**
   * Cierra como `cancelled` las sesiones que quedaron abiertas (`starting`, `running` o `waiting`), p. ej. al
   * arrancar el núcleo tras un cierre: sus procesos ya no existen. `exceptAgents`: agentes cuyas sesiones raíz se
   * retoman (la mente reutiliza la sesión de cada chat); sus sesiones hijas (subagentes) no se retoman nunca y se
   * cancelan igual. No toca `updated_at`: sigue siendo la hora del último evento.
   */
  cancelOpenSessions(opts: { exceptAgents?: readonly string[] } = {}): number {
    const except = [...new Set(opts.exceptAgents ?? [])];
    const notIn = except.length ? ` AND (agent_id NOT IN (${except.map(() => '?').join(', ')}) OR parent_session_id IS NOT NULL)` : '';
    const res = this.stmt(
      `UPDATE sessions SET state = 'cancelled', ended_at = COALESCE(ended_at, ?) WHERE state IN ('starting', 'running', 'waiting')${notIn}`,
    ).run(this.iso(), ...except);
    return Number(res.changes);
  }

  // ---------------------------------------------------------------- eventos

  /** `EventSink`: valida, tacha y guarda el evento; los `usage` se suman a la tabla de uso. */
  append(event: AgentEvent): void {
    this.appendEvent(event);
  }

  /**
   * Igual que `append`, pero devuelve el evento tal como quedó guardado (tachado), o `undefined`
   * si ya existía uno con la misma sesión y `seq` (reenvío idempotente).
   */
  appendEvent(event: AgentEvent): AgentEvent | undefined {
    const e = sanitize(agentEventSchema, event, 'Evento');
    return this.tx(() => {
      const res = this.stmt(
        `INSERT OR IGNORE INTO events (session_id, seq, agent_id, parent_session_id, type, ts, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(e.sessionId, e.seq, e.agentId, e.parentSessionId ?? null, e.type, e.ts, JSON.stringify(e.payload));
      if (Number(res.changes) === 0) return undefined;
      const eventId = Number(res.lastInsertRowid);
      let state: SessionState | null = null;
      let endedAt: string | null = null;
      if (e.type === 'status') state = e.payload.state;
      if (e.type === 'done') {
        state = e.payload.ok ? 'done' : 'failed';
        endedAt = e.ts;
      }
      this.stmt(
        `INSERT INTO sessions (id, agent_id, parent_session_id, state, started_at, updated_at, ended_at, last_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           updated_at = excluded.updated_at,
           state = COALESCE(?, CASE WHEN sessions.state = 'starting' THEN 'running' ELSE sessions.state END),
           ended_at = CASE WHEN ? IN ('starting', 'running', 'waiting') THEN NULL ELSE COALESCE(excluded.ended_at, sessions.ended_at) END,
           last_seq = MAX(sessions.last_seq, excluded.last_seq),
           parent_session_id = COALESCE(sessions.parent_session_id, excluded.parent_session_id)`,
      ).run(e.sessionId, e.agentId, e.parentSessionId ?? null, state ?? 'running', e.ts, e.ts, endedAt, e.seq, state, state);
      if (e.type === 'usage') {
        const u = e.payload;
        this.stmt(
          `INSERT INTO usage (event_id, session_id, agent_id, model, day, ts, input_tokens, output_tokens,
             cached_input_tokens, reasoning_tokens, cost_usd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          eventId,
          e.sessionId,
          e.agentId,
          u.model ?? null,
          this.dayOf(e.ts),
          e.ts,
          u.inputTokens,
          u.outputTokens,
          u.cachedInputTokens ?? 0,
          u.reasoningTokens ?? 0,
          u.costUsd ?? null,
        );
      }
      return e;
    });
  }

  /** Eventos de una sesión con `seq` mayor que `since` (reconexión), en orden. Máximo `MAX_EVENTS_PAGE`. */
  eventsSince(sessionId: string, since = -1, limit = 500): AgentEvent[] {
    return this.queryEvents(sessionId, since, clampPage(limit));
  }

  /**
   * Página de eventos para reconectar: `hasMore` indica si quedan eventos después de `lastSeq`
   * (se pide una fila extra, también con el límite máximo). Repetir con `since = lastSeq`.
   */
  eventsPage(sessionId: string, since = -1, limit = 500): EventsPage {
    const n = clampPage(limit);
    const rows = this.queryEvents(sessionId, since, n + 1);
    const events = rows.slice(0, n);
    return { events, lastSeq: events.at(-1)?.seq ?? since, hasMore: rows.length > n };
  }

  private queryEvents(sessionId: string, since: number, rawLimit: number): AgentEvent[] {
    const rows = this.stmt(
      'SELECT session_id, seq, agent_id, parent_session_id, type, ts, payload_json FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?',
    ).all(sessionId, since, rawLimit);
    return rows.map((raw) => {
      const r = eventRow.parse(raw);
      return agentEventSchema.parse({
        sessionId: r.session_id,
        agentId: r.agent_id,
        ...(r.parent_session_id ? { parentSessionId: r.parent_session_id } : {}),
        seq: r.seq,
        ts: r.ts,
        type: r.type,
        payload: JSON.parse(r.payload_json),
      });
    });
  }

  // -------------------------------------------------------------------- uso

  /** Totales de uso agrupados por agente, día, sesión y/o modelo (sin `groupBy`: total general). */
  usageTotals(query: UsageQuery = {}): UsageRow[] {
    const groups = [...new Set(query.groupBy ?? [])].map((g) => USAGE_COLUMNS[usageGroupSchema.parse(g)]);
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (query.agentId) addWhere(where, params, 'agent_id = ?', query.agentId);
    if (query.sessionId) addWhere(where, params, 'session_id = ?', query.sessionId);
    if (query.model) addWhere(where, params, 'model = ?', query.model);
    if (query.from) addWhere(where, params, 'day >= ?', z.string().regex(dayRegex).parse(query.from));
    if (query.to) addWhere(where, params, 'day <= ?', z.string().regex(dayRegex).parse(query.to));
    const select = groups.map((g) => `${g.column} AS ${g.alias}`);
    const sql = [
      `SELECT ${[...select, 'SUM(input_tokens) AS inputTokens', 'SUM(output_tokens) AS outputTokens', 'SUM(cached_input_tokens) AS cachedInputTokens', 'SUM(reasoning_tokens) AS reasoningTokens', 'SUM(cost_usd) AS costUsd', 'COUNT(*) AS entries'].join(', ')}`,
      'FROM usage',
      where.length ? `WHERE ${where.join(' AND ')}` : '',
      groups.length ? `GROUP BY ${groups.map((g) => g.column).join(', ')} ORDER BY ${groups.map((g) => g.column).join(', ')}` : '',
    ].join(' ');
    return this.stmt(sql)
      .all(...params)
      .map((raw) => usageRow.parse(raw))
      .filter((r) => groups.length > 0 || r.entries > 0)
      .map((r) => {
        const row: UsageRow = {
          inputTokens: r.inputTokens ?? 0,
          outputTokens: r.outputTokens ?? 0,
          cachedInputTokens: r.cachedInputTokens ?? 0,
          reasoningTokens: r.reasoningTokens ?? 0,
          costUsd: r.costUsd ?? 0,
          entries: r.entries,
        };
        if (r.agentId !== undefined) row.agentId = r.agentId;
        if (r.day !== undefined) row.day = r.day;
        if (r.sessionId !== undefined) row.sessionId = r.sessionId;
        if (r.model !== undefined) row.model = r.model;
        return row;
      });
  }

  /** Gasto en USD de un agente (para el presupuesto manual de Claude). */
  spentUsd(agentId: string, fromDay?: string): number {
    return this.usageTotals({ agentId, ...(fromDay ? { from: fromDay } : {}) })[0]?.costUsd ?? 0;
  }

  // ------------------------------------------------------------------ cupos

  recordQuota(snapshot: QuotaSnapshot): QuotaRecord {
    const s = sanitize(quotaSnapshotSchema, snapshot, 'Foto de cupo');
    const recordedAt = this.iso();
    this.stmt(
      'INSERT INTO quota_snapshots (agent_id, method, taken_at, stale, error, snapshot_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(s.agentId, s.method, s.takenAt, s.stale ? 1 : 0, s.error ?? null, JSON.stringify(s), recordedAt);
    return { snapshot: s, recordedAt };
  }

  /** Última foto de cupo de cada agente. */
  latestQuotas(): QuotaRecord[] {
    return this.stmt(
      `SELECT q.snapshot_json, q.recorded_at FROM quota_snapshots q
       JOIN (SELECT agent_id, MAX(id) AS id FROM quota_snapshots GROUP BY agent_id) m ON q.id = m.id
       ORDER BY q.agent_id`,
    )
      .all()
      .map(toQuota);
  }

  quotaHistory(agentId: string, limit = 50): QuotaRecord[] {
    return this.stmt('SELECT snapshot_json, recorded_at FROM quota_snapshots WHERE agent_id = ? ORDER BY id DESC LIMIT ?')
      .all(agentId, Math.min(Math.max(limit, 1), 1000))
      .map(toQuota);
  }

  // ---------------------------------------------------------------- interno

  /** Día AAAA-MM-DD de un instante, en la zona horaria del almacén. */
  dayOf(ts: string): string {
    return this.dayFormat.format(new Date(ts));
  }

  private migrate(): void {
    const version = this.schemaVersion();
    for (let v = version; v < MIGRATIONS.length; v++) {
      const sql = MIGRATIONS[v];
      if (!sql) continue;
      this.tx(() => {
        this.db.exec(sql);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  private writeAgent(input: AgentInput, exclusive: boolean): AgentRecord {
    const config = sanitize(agentConfigSchema, input.config, 'Agente');
    cleanId(config.id, 'agente');
    const quotaMethodIn = input.quotaMethod && quotaMethodSchema.parse(input.quotaMethod);
    const lastProbeIn = input.lastProbe && sanitize(probeResultSchema, input.lastProbe, 'Probe');
    return this.tx(() => {
      const existing = this.getAgent(config.id);
      if (exclusive && existing) throw new StoreError('conflict', `Ya existe el agente ${config.id}`);
      const quotaMethod = input.quotaMethod === undefined ? (existing?.quotaMethod ?? null) : (quotaMethodIn ?? null);
      const lastProbe = input.lastProbe === undefined ? (existing?.lastProbe ?? null) : (lastProbeIn ?? null);
      const ts = this.iso();
      this.stmt(
        `INSERT INTO agents (id, config_json, quota_method, last_probe_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json, quota_method = excluded.quota_method,
           last_probe_json = excluded.last_probe_json, updated_at = excluded.updated_at`,
      ).run(config.id, JSON.stringify(config), quotaMethod, lastProbe ? JSON.stringify(lastProbe) : null, existing?.createdAt ?? ts, ts);
      return { config, quotaMethod, lastProbe, createdAt: existing?.createdAt ?? ts, updatedAt: ts };
    });
  }

  private insertTask(t: TaskBrief, state: TaskState, planId: string | null, ts: string): void {
    this.stmt(
      'INSERT INTO tasks (id, project_id, plan_id, state, agent_id, brief_json, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
    ).run(t.id, t.projectId, planId, taskStateSchema.parse(state), JSON.stringify(t), ts, ts);
  }

  private toAgent(raw: unknown): AgentRecord {
    const r = agentRow.parse(raw);
    return {
      config: json(agentConfigSchema, r.config_json),
      quotaMethod: r.quota_method ? quotaMethodSchema.parse(r.quota_method) : null,
      lastProbe: r.last_probe_json ? json(probeResultSchema, r.last_probe_json) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private iso(): string {
    return this.now().toISOString();
  }
}

function clampPage(limit: number): number {
  return Math.min(Math.max(Math.trunc(Number.isFinite(limit) ? limit : 1), 1), MAX_EVENTS_PAGE);
}

function addWhere(where: string[], params: SQLInputValue[], clause: string, value: SQLInputValue): void {
  where.push(clause);
  params.push(value);
}

function toProject(raw: unknown): ProjectRecord {
  const r = projectRow.parse(raw);
  const workspace = r.workspace_json === null ? undefined : json(projectWorkspaceSchema, r.workspace_json);
  return { id: r.id, name: r.name, repoPath: r.repo_path, ...(workspace ? { workspace } : {}), createdAt: r.created_at };
}

function toTask(raw: unknown): TaskRecord {
  const r = taskRow.parse(raw);
  return {
    task: json(taskBriefSchema, r.brief_json),
    state: taskStateSchema.parse(r.state),
    planId: r.plan_id,
    agentId: r.agent_id,
    detail: r.detail,
    attempts: r.attempts,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastEventAt: r.last_event_at,
  };
}

/** Motivo de una tarea listo para guardar: tachado y recortado (vacío: sin motivo). */
function cleanDetail(detail: string): string | null {
  const text = redactSecrets(detail).trim();
  if (!text) return null;
  return text.length <= MAX_TASK_DETAIL_CHARS ? text : `${text.slice(0, MAX_TASK_DETAIL_CHARS - 1)}…`;
}

function toSession(raw: unknown): SessionRecord {
  const r = sessionRow.parse(raw);
  return {
    id: r.id,
    agentId: r.agent_id,
    taskId: r.task_id,
    parentSessionId: r.parent_session_id,
    state: sessionStateSchema.parse(r.state),
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    endedAt: r.ended_at,
    lastSeq: r.last_seq,
  };
}

function toQuota(raw: unknown): QuotaRecord {
  const r = quotaRow.parse(raw);
  return { snapshot: json(quotaSnapshotSchema, r.snapshot_json), recordedAt: r.recorded_at };
}
