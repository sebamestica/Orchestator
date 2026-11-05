import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { routePath } from 'hono/route';
import { redactSecrets, type MemoryStore, type TaskBrief, type TaskState } from '../../shared/index.ts';
import type { AgentRegistry, QuotaRefreshResult } from '../registry/index.ts';
import type { QuotaRecord, SqliteStore, TaskRecord, UsageGroup } from '../store/index.ts';
import { ApiError, errorBody, toApiError } from './errors.ts';
import type { EventHub } from './hub.ts';
import { ApiRouter, type HttpMethod, type RouteSpec } from './routing.ts';
import * as s from './schemas.ts';
import { bearerAuth, hostGuard, originGuard, securityHeaders } from './security.ts';
import { createWsHandlers } from './ws.ts';

/** Versión de la API local (también en OpenAPI). */
export const API_VERSION = '0.1.0';

/** Resultado del planificador; compatible con `PlanResult` de `planToTasks` (src/core/orchestrator). */
export type PlannerResult =
  | { ok: true; tasks: TaskBrief[]; attempts?: number }
  | { ok: false; issues: { code: string; message: string; taskIds?: string[] }[]; attempts?: number };

/** Planificador inyectado: convierte el texto del plan en tareas validadas. */
export interface Planner {
  plan(input: { projectId: string; text: string; knownTaskIds: string[]; signal?: AbortSignal }): Promise<PlannerResult>;
}

/** Hub de skills inyectado (src/core/skills). Los resultados se transmiten tachados. */
export interface SkillsService {
  list(): Promise<unknown>;
  importSkill(source: string): Promise<unknown>;
  approve(name: string): Promise<unknown>;
  reject(name: string): Promise<unknown>;
}

/** Ganchos para la orquestación (cola de tareas). */
export interface TaskHooks {
  onApproved?(task: TaskRecord): void | Promise<void>;
  /**
   * Cancela la tarea en la orquestación. `false`: no se pudo (p. ej. ya pasó el punto de compromiso de la integración);
   * entonces el servidor no la marca `cancelled`. Sin valor, se da por cancelada.
   */
  onCancel?(task: TaskRecord, reason?: string): boolean | undefined | Promise<boolean | undefined>;
  /** Tareas del proyecto que la orquestación tiene realmente en curso (aunque el almacén diga otra cosa). */
  activeTasks?(projectId: string): readonly string[];
}

export interface QuotaService {
  refresh(agentId?: string): Promise<QuotaRefreshResult<QuotaRecord>>;
}

/** Lo que recibe un módulo de rutas de F5 (ajustes, chats, plugins…) para registrar las suyas. */
export interface RouteModuleContext {
  r: ApiRouter;
  app: Hono;
  store: SqliteStore;
  registry: AgentRegistry;
  hub: EventHub;
  now: () => Date;
  newId: (prefix: string) => string;
  log?: (line: string) => void;
  /**
   * Marca una ruta exacta (sin parámetros ni comodines) como pública: no exige el token. Solo para lo que abre el
   * navegador fuera de la interfaz (p. ej. la vuelta de OAuth de Canva). Host, Origin y tamaño se siguen comprobando.
   */
  allowWithoutToken?: (method: 'get', path: string) => void;
  /**
   * Tope de cuerpo propio para una ruta exacta (sin parámetros), en lugar del global (`maxBodyBytes`, 1 MB):
   * p. ej. `POST /attachments`, que recibe hasta 20 MB de bytes crudos.
   */
  setBodyLimit: (method: HttpMethod, path: string, maxBytes: number) => void;
  /**
   * Aprueba una tarea pendiente igual que `POST /tasks/:id/approve` (estado, agente fijado, `deps.tasks.onApproved` y
   * difusión). 409 si no está pendiente.
   */
  approveTask: (task: TaskRecord, agentId?: string) => Promise<TaskRecord>;
  /**
   * Middleware que corre ANTES del token (después de Host y Origin). Solo para recursos públicos: la interfaz
   * estática (c14) o el retorno de un OAuth. Todo lo demás va por `r` y sigue exigiendo el token.
   */
  beforeAuth: (handler: MiddlewareHandler) => void;
}

/** Módulo de rutas: se registra después de las rutas base y antes de `/ws`. */
export type RouteModule = (ctx: RouteModuleContext) => void;

export interface AppDeps {
  token: string;
  /** Valores válidos del encabezado Host (se consulta en cada petición: el puerto puede asignarse al escuchar). */
  allowedHosts: () => readonly string[];
  allowedOrigins?: readonly string[];
  store: SqliteStore;
  registry: AgentRegistry;
  hub: EventHub;
  quotas?: QuotaService;
  planner?: Planner;
  skills?: SkillsService;
  memory?: MemoryStore;
  tasks?: TaskHooks;
  /** Registro de peticiones: método, ruta sin consulta, estado y duración. Nunca encabezados ni cuerpos. */
  log?: (line: string) => void;
  now?: () => Date;
  maxBodyBytes?: number;
  /** Comprueba cada respuesta contra su esquema (pruebas). */
  validateResponses?: boolean;
  newId?: (prefix: string) => string;
  /** Módulos de rutas extra (F5). Cada uno vive en su carpeta y se cablea en `src/core/app/route-modules.ts`. */
  routeModules?: readonly RouteModule[];
}

export interface CoreApp {
  app: Hono;
  routes: readonly RouteSpec[];
}

const CANCELLABLE: readonly TaskState[] = ['pending', 'ready', 'running', 'review'];
/** Tareas en manos de la flota: con alguna, el proyecto no se borra ni se reconfigura. */
const ACTIVE_STATES: readonly TaskState[] = ['ready', 'running', 'review', 'handed_off'];
const DEFAULT_MEMORY_BUDGET = 4000;

function notConfigured(what: string): ApiError {
  return new ApiError(501, 'not_configured', `${what} no está configurado en este arranque`);
}

/** Llama a un servicio de otro módulo: sus errores se tachan y se traducen. */
async function callService<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
    const msg = redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 300);
    if (code === 'not_found' || code === 'ENOENT') throw new ApiError(404, 'not_found', `${name}: ${msg}`);
    if (code === 'invalid') throw new ApiError(400, 'invalid_request', `${name}: ${msg}`);
    if (code === 'conflict') throw new ApiError(409, 'conflict', `${name}: ${msg}`);
    throw new ApiError(500, 'internal', `${name}: ${msg}`);
  }
}

/**
 * Ruta para el registro: la plantilla registrada (`/agents/:id`), nunca la URL cruda, que puede traer
 * una clave pegada por error. Sin ruta propia: «(ruta desconocida)».
 */
function routeForLog(c: Context): string {
  let template = '*';
  try {
    template = routePath(c, -1);
  } catch {
    template = '*';
  }
  return template === '*' || template === '/*' ? '(ruta desconocida)' : template;
}

function defaultId(prefix: string): string {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `${prefix}-${day}-${randomBytes(3).toString('hex')}`;
}

/**
 * API local del núcleo (Hono). Orden de defensas: Host (DNS rebinding) → Origin (sin CORS) → token →
 * tamaño del cuerpo → Zod en cada entrada. Las respuestas JSON pasan por `redactDeep`.
 */
export function createApp(deps: AppDeps): CoreApp {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const newId = deps.newId ?? defaultId;
  const log = deps.log;
  const { store, registry, hub } = deps;

  const app = new Hono();
  app.onError((err, c) => {
    const e = toApiError(err);
    if (e.status >= 500 && log) log(redactSecrets(`error ${c.req.method} ${routeForLog(c)}: ${err.message}`).slice(0, 500));
    return c.json(errorBody(e), e.status);
  });
  app.notFound((c) => c.json(errorBody(new ApiError(404, 'not_found', 'Ruta no encontrada')), 404));
  app.use('*', async (c, next) => {
    const t0 = performance.now();
    await next();
    log?.(redactSecrets(`${c.req.method} ${routeForLog(c)} ${c.res.status} ${Math.round(performance.now() - t0)}ms`));
  });
  app.use('*', securityHeaders);
  app.use('*', hostGuard(deps.allowedHosts));
  app.use('*', originGuard(deps.allowedOrigins ?? []));
  // Recursos públicos de los módulos de F5 (`beforeAuth`): se llenan al registrar los módulos, más abajo.
  const publicHandlers: MiddlewareHandler[] = [];
  app.use('*', async (c, next) => {
    const dispatch = async (i: number): Promise<Response | undefined> => {
      const handler = publicHandlers[i];
      if (!handler) {
        await next();
        return undefined;
      }
      const res = await handler(c, async () => {
        const inner = await dispatch(i + 1);
        if (inner) c.res = inner;
      });
      return res instanceof Response ? res : undefined;
    };
    return dispatch(0);
  });
  // Rutas públicas exactas que registran los módulos de F5 (`allowWithoutToken`); el resto exige el token.
  const publicRoutes = new Set<string>();
  const auth = bearerAuth(deps.token);
  app.use('*', (c, next) => (publicRoutes.has(`${c.req.method} ${c.req.path}`) ? next() : auth(c, next)));
  const tooLarge = (): never => {
    throw new ApiError(413, 'payload_too_large', 'El cuerpo supera el tamaño máximo');
  };
  const defaultBodyLimit = bodyLimit({ maxSize: deps.maxBodyBytes ?? 1024 * 1024, onError: tooLarge });
  // Rutas de módulos con tope propio (`setBodyLimit`); el resto usa el global.
  const routeBodyLimits = new Map<string, MiddlewareHandler>();
  app.use('*', (c, next) => (routeBodyLimits.get(`${c.req.method} ${c.req.path}`) ?? defaultBodyLimit)(c, next));
  const setBodyLimit = (method: HttpMethod, path: string, maxBytes: number) => {
    routeBodyLimits.set(`${method.toUpperCase()} ${path}`, bodyLimit({ maxSize: maxBytes, onError: tooLarge }));
  };

  const r = new ApiRouter(app, { validateResponses: deps.validateResponses ?? false });

  const requireTask = (id: string): TaskRecord => {
    const t = store.getTask(id);
    if (!t) throw new ApiError(404, 'not_found', `No existe la tarea ${id}`);
    return t;
  };
  const requireProject = (id: string) => {
    const p = store.getProject(id);
    if (!p) throw new ApiError(404, 'not_found', `No existe el proyecto ${id}`);
    return p;
  };
  const planWithTasks = (id: string) => {
    const plan = store.getPlan(id);
    if (!plan) throw new ApiError(404, 'not_found', `No existe el plan ${id}`);
    return { plan, tasks: store.listTasks({ planId: id }) };
  };
  const approve = async (task: TaskRecord, agentId?: string): Promise<TaskRecord> => {
    if (task.state !== 'pending') throw new ApiError(409, 'conflict', `La tarea ${task.task.id} está en estado ${task.state}`);
    if (agentId) registry.require(agentId);
    const saved = store.setTaskState(task.task.id, 'ready', agentId);
    await callService('orquestación', async () => deps.tasks?.onApproved?.(saved));
    hub.publishTask(saved);
    return saved;
  };

  // ------------------------------------------------------------- sistema
  r.add(
    { method: 'get', path: '/health', tag: 'Sistema', summary: 'Estado del servidor', response: s.healthResponse },
    () => ({ ok: true as const, version: API_VERSION, startedAt: startedAt.toISOString(), uptimeMs: Math.max(0, now().getTime() - startedAt.getTime()) }),
  );

  // ------------------------------------------------------------- agentes
  r.add({ method: 'get', path: '/agents', tag: 'Agentes', summary: 'Lista los agentes registrados', response: s.agentsResponse }, () => ({
    agents: registry.list(),
  }));
  r.add(
    {
      method: 'post',
      path: '/agents',
      tag: 'Agentes',
      summary: 'Agrega un agente',
      description:
        'Con `apiKey`: prueba el agente con la clave solo en memoria y, si la prueba sale bien, guarda el agente y la clave en la bóveda (DPAPI) con su método de cupo; si la prueba falla no se guarda nada. Sin `apiKey`: registra una configuración sin clave (CLIs). La respuesta nunca incluye la clave, solo `secretRef`.',
      body: s.addAgentBody,
      response: s.addAgentResponse,
      status: 201,
      errors: [400, 409, 413, 415, 422, 501],
      example: { provider: 'anthropic', apiKey: '<tu clave>', displayName: 'Claude (mi clave)', baseUrl: 'https://api.anthropic.com', budgetUsd: 20 },
    },
    async ({ body }) => {
      if ('apiKey' in body) {
        const res = await registry.addAgentFromKey(body);
        hub.publishAgent(res.agent);
        return res;
      }
      if (registry.get(body.id)) throw new ApiError(409, 'conflict', `Ya existe el agente ${body.id}`);
      const agent = registry.put(body);
      hub.publishAgent(agent);
      return { agent, probe: null };
    },
  );
  r.add(
    {
      method: 'post',
      path: '/agents/detect',
      tag: 'Agentes',
      summary: 'Detecta CLIs instalados (codex, agy) y registra los nuevos',
      response: s.detectResponse,
    },
    async () => {
      const res = await registry.detectClis();
      for (const a of res.added) hub.publishAgent(a);
      return res;
    },
  );
  r.add(
    { method: 'get', path: '/agents/:id', tag: 'Agentes', summary: 'Detalle de un agente', params: { id: s.agentIdParam }, response: s.agentResponse, errors: [404] },
    ({ params }) => ({ agent: registry.require(params.id ?? '') }),
  );
  r.add(
    {
      method: 'patch',
      path: '/agents/:id',
      tag: 'Agentes',
      summary: 'Cambia nombre, modelo, URL, umbral de cupo, presupuesto o habilitación',
      params: { id: s.agentIdParam },
      body: s.patchAgentBody,
      response: s.agentResponse,
      errors: [400, 404, 415],
      example: { enabled: false, quotaFloor: 0.25 },
    },
    ({ params, body }) => {
      const agent = registry.update(params.id ?? '', body);
      hub.publishAgent(agent);
      return { agent };
    },
  );
  r.add(
    {
      method: 'delete',
      path: '/agents/:id',
      tag: 'Agentes',
      summary: 'Borra un agente y su clave de la bóveda',
      params: { id: s.agentIdParam },
      response: s.deletedResponse,
      errors: [404],
    },
    async ({ params }) => {
      const id = params.id ?? '';
      if (!(await registry.delete(id))) throw new ApiError(404, 'not_found', `No existe el agente ${id}`);
      hub.publishAgentDeleted(id);
      return { deleted: true as const, id };
    },
  );
  r.add(
    {
      method: 'post',
      path: '/agents/:id/probe',
      tag: 'Agentes',
      summary: 'Prueba el agente (instalación, sesión, modelos) y guarda su método de cupo',
      params: { id: s.agentIdParam },
      response: s.probeResponse,
      errors: [404, 422, 501],
    },
    async ({ params }) => {
      const res = await registry.probe(params.id ?? '');
      hub.publishAgent(res.agent);
      return res;
    },
  );

  // --------------------------------------------------------------- cupos
  r.add(
    { method: 'get', path: '/quotas', tag: 'Cupos', summary: 'Última foto de cupo de cada agente', query: s.quotasQuery, response: s.quotasResponse, errors: [400] },
    ({ query }) => ({ quotas: store.latestQuotas().filter((q) => !query.agentId || q.snapshot.agentId === query.agentId) }),
  );
  r.add(
    {
      method: 'post',
      path: '/quotas/refresh',
      tag: 'Cupos',
      summary: 'Lee ahora el cupo de todos los agentes habilitados (o de uno)',
      description: 'Cada foto nueva se guarda y se transmite por `/ws` como `{type:"quota"}`.',
      body: s.refreshQuotasBody,
      bodyOptional: true,
      response: s.refreshQuotasResponse,
      errors: [400, 404, 415, 501],
      example: {},
    },
    async ({ body }) => {
      const quotas = deps.quotas;
      if (!quotas) throw notConfigured('El lector de cupos');
      return quotas.refresh(body.agentId);
    },
  );

  // ----------------------------------------------------------- proyectos
  r.add({ method: 'get', path: '/projects', tag: 'Proyectos', summary: 'Lista los proyectos', response: s.projectsResponse }, () => ({
    projects: store.listProjects(),
  }));
  r.add(
    {
      method: 'post',
      path: '/projects',
      tag: 'Proyectos',
      summary: 'Registra un proyecto (repo local)',
      description:
        'Con `workspace` (enlaces, `postCreate` y `gate` obligatorio) la flota puede crear worktrees e integrar tareas del proyecto; sin él se registra igual, pero la flota rechaza sus tareas por falta de gate. Para cambiarlo: DELETE y POST de nuevo.',
      body: s.projectBody,
      response: s.projectResponse,
      status: 201,
      errors: [400, 409, 415],
      example: {
        id: 'vetworld',
        name: 'Vetworld',
        repoPath: 'C:\\dev\\Vetworld',
        workspace: {
          worktreesRoot: 'C:\\dev\\.worktrees\\vetworld-orq',
          links: ['.tools', 'workbench', 'assets-source', 'node_modules'],
          gate: [{ command: 'npm', args: ['run', '-s', 'gate'], timeoutMs: 1_800_000 }],
        },
      },
    },
    ({ body }) => {
      if (store.getProject(body.id)) throw new ApiError(409, 'conflict', `Ya existe el proyecto ${body.id}`);
      return { project: store.putProject(body) };
    },
  );
  r.add(
    { method: 'get', path: '/projects/:id', tag: 'Proyectos', summary: 'Detalle de un proyecto', params: { id: s.projectIdParam }, response: s.projectResponse, errors: [404] },
    ({ params }) => ({ project: requireProject(params.id ?? '') }),
  );
  r.add(
    {
      method: 'delete',
      path: '/projects/:id',
      tag: 'Proyectos',
      summary: 'Borra un proyecto (no toca el repo)',
      description: 'Con tareas activas (`ready`, `running`, `review` o `handed_off`) responde 409: cambiar la configuración de worktrees o el gate con tareas en curso dejaría integraciones a medias. Cancélalas o espera a que terminen.',
      params: { id: s.projectIdParam },
      response: s.deletedResponse,
      errors: [404, 409],
    },
    ({ params }) => {
      const id = params.id ?? '';
      // Lo guardado y lo que la flota tiene de verdad en curso (una integración no se detiene por cancelarla en SQLite).
      const active = [...new Set([
        ...store.listTasks({ projectId: id }).filter((t) => ACTIVE_STATES.includes(t.state)).map((t) => t.task.id),
        ...(deps.tasks?.activeTasks?.(id) ?? []),
      ])];
      if (active.length > 0) {
        throw new ApiError(409, 'conflict', `El proyecto ${id} tiene ${String(active.length)} tarea(s) activa(s) (${active.slice(0, 5).join(', ')}): cancélalas o espera a que terminen`);
      }
      if (!store.deleteProject(id)) throw new ApiError(404, 'not_found', `No existe el proyecto ${id}`);
      return { deleted: true as const, id };
    },
  );

  // -------------------------------------------------------------- planes
  r.add(
    {
      method: 'post',
      path: '/plans',
      tag: 'Planes y tareas',
      summary: 'Convierte un plan en tareas (pendientes de aprobación)',
      description: 'El planificador (Claude) devuelve tareas validadas: rutas sin solapes, dependencias existentes y sin ciclos. Si no lo logra responde 422 con `issues`.',
      body: s.planBody,
      response: s.planResponse,
      status: 201,
      errors: [400, 404, 409, 413, 415, 422, 501],
      example: { projectId: 'vetworld', text: '1. Agregar validación al formulario de citas.\n2. Pruebas del formulario.' },
    },
    async ({ body, c }) => {
      const planner = deps.planner;
      if (!planner) throw notConfigured('El planificador');
      requireProject(body.projectId);
      const knownTaskIds = store.listTasks({ projectId: body.projectId }).map((t) => t.task.id);
      const result = await callService('planificador', () =>
        planner.plan({ projectId: body.projectId, text: body.text, knownTaskIds, signal: c.req.raw.signal }),
      );
      if (!result.ok) throw new ApiError(422, 'plan_invalid', 'El planificador no produjo un plan válido', { issues: result.issues });
      const plan = store.createPlan({ id: newId('plan'), projectId: body.projectId, text: body.text, tasks: result.tasks });
      const out = planWithTasks(plan.id);
      for (const t of out.tasks) hub.publishTask(t);
      return out;
    },
  );
  r.add(
    { method: 'get', path: '/plans/:id', tag: 'Planes y tareas', summary: 'Plan y sus tareas', params: { id: s.planIdParam }, response: s.planResponse, errors: [404] },
    ({ params }) => planWithTasks(params.id ?? ''),
  );
  r.add(
    {
      method: 'post',
      path: '/plans/:id/approve',
      tag: 'Planes y tareas',
      summary: 'Aprueba todas las tareas pendientes del plan',
      params: { id: s.planIdParam },
      response: s.planResponse,
      errors: [404],
    },
    async ({ params }) => {
      const { tasks } = planWithTasks(params.id ?? '');
      for (const t of tasks) if (t.state === 'pending') await approve(t);
      return planWithTasks(params.id ?? '');
    },
  );

  // -------------------------------------------------------------- tareas
  r.add(
    { method: 'get', path: '/tasks', tag: 'Planes y tareas', summary: 'Lista tareas (filtros opcionales)', query: s.tasksQuery, response: s.tasksResponse, errors: [400], queryExample: { projectId: 'vetworld', state: 'pending' } },
    ({ query }) => ({
      tasks: store.listTasks({
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.state ? { state: query.state } : {}),
        ...(query.planId ? { planId: query.planId } : {}),
      }),
    }),
  );
  r.add(
    {
      method: 'post',
      path: '/tasks',
      tag: 'Planes y tareas',
      summary: 'Crea una tarea suelta (pendiente)',
      body: s.taskBody,
      response: s.taskResponse,
      status: 201,
      errors: [400, 404, 409, 413, 415],
      example: {
        id: 'validar-citas',
        projectId: 'vetworld',
        title: 'Validar el formulario de citas',
        objective: 'Agregar validación con Zod al formulario de citas.',
        ownedPaths: ['src/citas/**'],
        dependsOn: [],
        acceptance: ['Pruebas del formulario en verde'],
        difficulty: 'low',
      },
    },
    ({ body }) => {
      requireProject(body.projectId);
      if (store.getTask(body.id)) throw new ApiError(409, 'conflict', `Ya existe la tarea ${body.id}`);
      const task = store.putTask(body);
      hub.publishTask(task);
      return { task };
    },
  );
  r.add(
    { method: 'get', path: '/tasks/:id', tag: 'Planes y tareas', summary: 'Detalle de una tarea', params: { id: s.taskIdParam }, response: s.taskResponse, errors: [404] },
    ({ params }) => ({ task: requireTask(params.id ?? '') }),
  );
  r.add(
    {
      method: 'post',
      path: '/tasks/:id/approve',
      tag: 'Planes y tareas',
      summary: 'Aprueba una tarea pendiente (pasa a ready); opcionalmente fija el agente',
      params: { id: s.taskIdParam },
      body: s.approveTaskBody,
      bodyOptional: true,
      response: s.taskResponse,
      errors: [400, 404, 409, 415],
      example: {},
    },
    async ({ params, body }) => ({ task: await approve(requireTask(params.id ?? ''), body.agentId) }),
  );
  r.add(
    {
      method: 'post',
      path: '/tasks/:id/cancel',
      tag: 'Planes y tareas',
      summary: 'Cancela una tarea pendiente, lista, en curso o en revisión',
      params: { id: s.taskIdParam },
      body: s.cancelTaskBody,
      bodyOptional: true,
      response: s.taskResponse,
      errors: [400, 404, 409, 415],
      example: { reason: 'Ya no hace falta' },
    },
    async ({ params, body }) => {
      const task = requireTask(params.id ?? '');
      if (!CANCELLABLE.includes(task.state)) throw new ApiError(409, 'conflict', `La tarea ${task.task.id} está en estado ${task.state}`);
      // Primero la orquestación: si ya pasó el punto de compromiso (se está integrando), no se cancela y el almacén
      // sigue diciendo la verdad.
      const accepted = await callService('orquestación', async () => deps.tasks?.onCancel?.(task, body.reason));
      if (accepted === false) {
        throw new ApiError(409, 'conflict', `La tarea ${task.task.id} se está integrando: la cancelación solo se aplica si la integración falla`);
      }
      const saved = store.setTaskState(task.task.id, 'cancelled');
      hub.publishTask(saved);
      return { task: saved };
    },
  );

  // ------------------------------------------------------------ sesiones
  r.add(
    { method: 'get', path: '/sessions', tag: 'Sesiones', summary: 'Lista sesiones (más recientes primero)', query: s.sessionsQuery, response: s.sessionsResponse, errors: [400] },
    ({ query }) => ({
      sessions: store.listSessions({
        ...(query.taskId ? { taskId: query.taskId } : {}),
        ...(query.agentId ? { agentId: query.agentId } : {}),
        ...(query.parentSessionId ? { parentSessionId: query.parentSessionId } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
      }),
    }),
  );
  r.add(
    { method: 'get', path: '/sessions/:id', tag: 'Sesiones', summary: 'Detalle de una sesión', params: { id: s.sessionIdParam }, response: s.sessionResponse, errors: [404] },
    ({ params }) => {
      const session = store.getSession(params.id ?? '');
      if (!session) throw new ApiError(404, 'not_found', 'No existe la sesión');
      return { session };
    },
  );
  r.add(
    {
      method: 'get',
      path: '/sessions/:id/events',
      tag: 'Sesiones',
      summary: 'Eventos de una sesión desde un seq (reconexión)',
      description: 'Devuelve los eventos con `seq > since`, en orden. Repite con `since = lastSeq` mientras `hasMore` sea true.',
      params: { id: s.sessionIdParam },
      query: s.eventsQuery,
      response: s.eventsResponse,
      errors: [400, 404],
      queryExample: { since: '-1', limit: '500' },
    },
    ({ params, query }) => {
      const id = params.id ?? '';
      if (!store.getSession(id)) throw new ApiError(404, 'not_found', 'No existe la sesión');
      return { sessionId: id, ...store.eventsPage(id, query.since ?? -1, query.limit ?? 500) };
    },
  );

  // ----------------------------------------------------------------- uso
  r.add(
    {
      method: 'get',
      path: '/usage',
      tag: 'Uso',
      summary: 'Totales de tokens y costo por agente, día, sesión y/o modelo',
      query: s.usageQuery,
      response: s.usageResponse,
      errors: [400],
      queryExample: { groupBy: 'agent,day' },
    },
    ({ query }) => {
      const groupBy = (query.groupBy?.split(',') ?? []) as UsageGroup[];
      const unique = [...new Set(groupBy)];
      const rows = store.usageTotals({
        groupBy: unique,
        ...(query.agentId ? { agentId: query.agentId } : {}),
        ...(query.sessionId ? { sessionId: query.sessionId } : {}),
        ...(query.model ? { model: query.model } : {}),
        ...(query.from ? { from: query.from } : {}),
        ...(query.to ? { to: query.to } : {}),
      });
      return { groupBy: unique, rows };
    },
  );

  // -------------------------------------------------------------- skills
  const skills = (): SkillsService => {
    if (!deps.skills) throw notConfigured('El hub de skills');
    return deps.skills;
  };
  r.add({ method: 'get', path: '/skills', tag: 'Skills', summary: 'Lista las skills instaladas', response: s.skillsResponse, errors: [501] }, async () => ({
    skills: await callService('skills', () => skills().list()),
  }));
  r.add(
    {
      method: 'post',
      path: '/skills/import',
      tag: 'Skills',
      summary: 'Importa una skill (carpeta o .zip) a cuarentena y devuelve el informe de revisión',
      body: s.importSkillBody,
      response: s.skillResultResponse,
      status: 201,
      errors: [400, 404, 409, 415, 501],
      example: { source: 'C:\\Users\\yo\\Downloads\\mi-skill.zip' },
    },
    async ({ body }) => ({ result: await callService('skills', () => skills().importSkill(body.source)) }),
  );
  r.add(
    { method: 'post', path: '/skills/:name/approve', tag: 'Skills', summary: 'Aprueba una skill en cuarentena', params: { name: s.skillNameParam }, response: s.skillResultResponse, errors: [400, 404, 501] },
    async ({ params }) => ({ result: await callService('skills', () => skills().approve(params.name ?? '')) }),
  );
  r.add(
    { method: 'post', path: '/skills/:name/reject', tag: 'Skills', summary: 'Rechaza (descarta) una skill en cuarentena', params: { name: s.skillNameParam }, response: s.skillResultResponse, errors: [400, 404, 501] },
    async ({ params }) => ({ result: await callService('skills', () => skills().reject(params.name ?? '')) }),
  );

  // ------------------------------------------------------------- memoria
  r.add(
    {
      method: 'get',
      path: '/memory/:project/context',
      tag: 'Memoria',
      summary: 'Extracto de memoria (Obsidian) para un proyecto o una tarea',
      params: { project: s.projectIdParam },
      query: s.memoryQuery,
      response: s.memoryContextResponse,
      errors: [400, 404, 501],
      queryExample: { budget: '4000' },
    },
    async ({ params, query }) => {
      const memory = deps.memory;
      if (!memory) throw notConfigured('La memoria');
      const projectId = requireProject(params.project ?? '').id;
      let task: TaskBrief;
      if (query.taskId) {
        task = requireTask(query.taskId).task;
        if (task.projectId !== projectId) throw new ApiError(404, 'not_found', `La tarea ${query.taskId} no es del proyecto ${projectId}`);
      } else {
        task = {
          id: 'contexto-proyecto',
          projectId,
          title: 'Contexto del proyecto',
          objective: 'Resumen general del proyecto',
          ownedPaths: ['.'],
          dependsOn: [],
          acceptance: ['-'],
          difficulty: 'low',
          contextRefs: [],
          skillRefs: [],
        };
      }
      const budgetChars = query.budget ?? DEFAULT_MEMORY_BUDGET;
      const context = redactSecrets(await callService('memoria', () => memory.buildContext(projectId, task, budgetChars)));
      return { projectId, taskId: query.taskId ?? null, budgetChars, chars: context.length, context };
    },
  );

  // ------------------------------------------------------ módulos de F5
  const allowWithoutToken = (method: 'get', path: string) => {
    if (!/^\/[A-Za-z0-9/_-]+$/.test(path)) throw new Error(`Ruta pública inválida: ${path}`);
    publicRoutes.add(`${method.toUpperCase()} ${path}`);
  };
  const beforeAuth = (handler: MiddlewareHandler) => {
    publicHandlers.push(handler);
  };
  for (const mod of deps.routeModules ?? []) {
    mod({ r, app, store, registry, hub, now, newId, allowWithoutToken, setBodyLimit, approveTask: approve, beforeAuth, ...(log ? { log } : {}) });
  }

  // ----------------------------------------------------------- WebSocket
  r.addRaw(
    {
      method: 'get',
      path: '/ws',
      tag: 'Tiempo real',
      summary: 'WebSocket: eventos en vivo, cambios de cupo, tareas y agentes',
      description:
        'Handshake con `Authorization: Bearer <token>` o, desde el navegador, con el subprotocolo `Sec-WebSocket-Protocol: orq, orq.bearer.<token>` (el servidor responde `orq`). Mensajes del servidor: `hello`, `event`, `quota`, `task`, `agent`, `agent_deleted`, `replay`, `pong`, `error` y, de F5, `settings`, `chat`, `chat_message`, `chat_deleted`, `chat_target`, `proposals`, `plugin`. Del cliente: `{"type":"replay","sessionId":"…","since":<seq>}` y `{"type":"ping"}`.',
      status: 101,
      errors: [426, 501],
      websocket: true,
    },
    ...createWsHandlers({ hub, store, version: API_VERSION, now }),
  );

  return { app, routes: r.specs };
}
