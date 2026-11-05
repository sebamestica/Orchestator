/**
 * Rutas documentadas = rutas reales del servidor (`createApp(...).routes`) + lo que solo necesita la
 * documentación: valores de los parámetros de ruta, respuestas de ejemplo y scripts de Postman.
 *
 * Método, ruta, etiqueta, resumen, esquemas, estado, errores y ejemplos de petición vienen del
 * servidor. Si el servidor agrega o quita una ruta, la generación falla hasta actualizar `docExtras`.
 */
import { DEFAULT_PORT } from '../../src/core/config/index.ts';
import { API_VERSION, type RouteSpec } from '../../src/core/server/index.ts';
import * as ex from './examples.ts';
import { serverRoutes } from './source.ts';

export { API_VERSION, DEFAULT_PORT };

/** Variables de colección de Postman: valor inicial y descripción. Los secretos empiezan vacíos. */
export const collectionVariables = {
  baseUrl: { value: `http://127.0.0.1:${DEFAULT_PORT}`, description: 'URL del núcleo (solo 127.0.0.1). Cambia el puerto si arrancas con ORQ_PORT.' },
  token: { value: '', description: 'Token que imprime el núcleo al arrancar (cambia en cada arranque). Ponlo solo en «Current value».' },
  apiKey: { value: '', description: 'Clave del proveedor para POST /agents. Ponla solo en «Current value» y bórrala después.' },
  agentId: { value: ex.ids.agent, description: 'Agente para las rutas /agents/:id (POST /agents la actualiza).' },
  projectId: { value: ex.ids.project, description: 'Proyecto para /projects/:id y /memory/:project/context.' },
  planId: { value: ex.ids.plan, description: 'Plan para /plans/:id (POST /plans la actualiza).' },
  taskId: { value: ex.ids.task, description: 'Tarea para /tasks/:id (POST /plans y POST /tasks la actualizan).' },
  sessionId: { value: ex.ids.session, description: 'Sesión para /sessions/:id.' },
  skillName: { value: ex.ids.skill, description: 'Skill en cuarentena para /skills/:name/approve y /reject.' },
} as const;
export type CollectionVariable = keyof typeof collectionVariables;

export interface DocExtras {
  /** Variable de colección de Postman que da el valor de cada parámetro de ruta. */
  paramVars?: Readonly<Record<string, CollectionVariable>>;
  /** Respuesta de ejemplo (se valida con el esquema de respuesta del servidor). */
  responseExample?: unknown;
  /** Cuerpo para Postman cuando difiere del ejemplo del servidor (p. ej. `{{apiKey}}` en lugar del marcador). */
  postmanExample?: unknown;
  /** Script de pruebas de Postman (guarda ids generados por el servidor en variables de colección). */
  postmanTest?: readonly string[];
}

export type DocRoute = RouteSpec & DocExtras;

/** Clave de una ruta: `POST /agents/:id/probe`. */
export function routeKey(route: Pick<RouteSpec, 'method' | 'path'>): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

/** Etiquetas en el orden de la colección, con su descripción. */
export const tags: readonly { name: string; description: string }[] = [
  { name: 'Sistema', description: 'Estado del núcleo.' },
  { name: 'Agentes', description: 'Registro de agentes: alta con clave (va a la bóveda DPAPI), CLIs detectados, prueba y baja.' },
  { name: 'Cupos', description: 'Cupo restante por agente (Codex, agy, OpenRouter, presupuesto manual).' },
  { name: 'Proyectos', description: 'Repositorios locales sobre los que trabaja la flota.' },
  { name: 'Planes y tareas', description: 'Plan en texto → tareas propuestas → aprobación → ejecución.' },
  { name: 'Sesiones', description: 'Sesiones de agente y sus eventos normalizados (con reconexión por `seq`).' },
  { name: 'Uso', description: 'Tokens y costo acumulados.' },
  { name: 'Skills', description: 'Hub de skills con cuarentena.' },
  { name: 'Memoria', description: 'Extractos de la memoria en Obsidian para ahorrar contexto.' },
  { name: 'Ajustes', description: 'Ajustes de la interfaz (F5): la mente, los subagentes de la flota, el modo inicial, el umbral de cupo, la concurrencia y la apariencia.' },
  { name: 'Carpetas', description: 'Explorador de carpetas del equipo y diálogo nativo de Windows para elegir la carpeta de un proyecto (F5).' },
  { name: 'Tiempo real', description: 'WebSocket con eventos en vivo y cambios de cupo, tareas y agentes.' },
];

const agentId = { id: 'agentId' } as const;
const projectId = { id: 'projectId' } as const;
const planId = { id: 'planId' } as const;
const taskId = { id: 'taskId' } as const;
const sessionId = { id: 'sessionId' } as const;
const skillName = { name: 'skillName' } as const;

/** Lo que agrega la documentación a cada ruta del servidor (una entrada por ruta, ni más ni menos). */
export const docExtras: Readonly<Record<string, DocExtras>> = {
  'GET /health': { responseExample: { ok: true, version: API_VERSION, startedAt: '2026-11-01T21:30:00.000Z', uptimeMs: 93500 } },

  'GET /agents': { responseExample: { agents: [ex.claudeAgent, ex.codexAgent] } },
  'POST /agents': {
    postmanExample: { provider: 'anthropic', apiKey: '{{apiKey}}', displayName: 'Claude (mi clave)', baseUrl: 'https://api.anthropic.com', budgetUsd: 20 },
    responseExample: { agent: ex.claudeAgent, probe: ex.claudeProbe },
    postmanTest: [
      "if (pm.response.code === 201) pm.collectionVariables.set('agentId', pm.response.json().agent.config.id);",
      "pm.test('la respuesta no contiene la clave', () => pm.expect(pm.response.text()).to.not.include(pm.variables.get('apiKey') || '<sin clave>'));",
    ],
  },
  'POST /agents/detect': { responseExample: { detected: ex.detectedClis, added: [ex.agyAgent] } },
  'GET /agents/:id': { paramVars: agentId, responseExample: { agent: ex.claudeAgent } },
  'PATCH /agents/:id': {
    paramVars: agentId,
    responseExample: { agent: { ...ex.claudeAgent, config: { ...ex.claudeConfig, enabled: false, quotaFloor: 0.25 }, updatedAt: '2026-11-01T21:50:00.000Z' } },
  },
  'DELETE /agents/:id': { paramVars: agentId, responseExample: { deleted: true, id: ex.ids.agent } },
  'POST /agents/:id/probe': { paramVars: agentId, responseExample: { agent: ex.claudeAgent, probe: ex.claudeProbe } },

  'GET /quotas': { responseExample: { quotas: ex.quotaRecords } },
  'POST /quotas/refresh': { responseExample: { quotas: ex.quotaRecords, errors: [] } },

  'GET /projects': { responseExample: { projects: [ex.project] } },
  'POST /projects': { responseExample: { project: ex.projectWithWorkspace } },
  'GET /projects/:id': { paramVars: projectId, responseExample: { project: ex.project } },
  'DELETE /projects/:id': { paramVars: projectId, responseExample: { deleted: true, id: ex.ids.project } },
  'POST /projects/inspect': { responseExample: ex.folderInspection },
  'POST /projects/from-folder': { responseExample: { project: ex.projectFromFolder } },

  'POST /plans': {
    responseExample: { plan: ex.plan, tasks: [ex.pendingTask, ex.pendingTask2] },
    postmanTest: [
      'if (pm.response.code === 201) {',
      '  const body = pm.response.json();',
      "  pm.collectionVariables.set('planId', body.plan.id);",
      "  if (body.tasks.length > 0) pm.collectionVariables.set('taskId', body.tasks[0].task.id);",
      '}',
    ],
  },
  'GET /plans/:id': { paramVars: planId, responseExample: { plan: ex.plan, tasks: [ex.pendingTask, ex.pendingTask2] } },
  'POST /plans/:id/approve': { paramVars: planId, responseExample: { plan: ex.plan, tasks: [ex.readyTask, ex.readyTask2] } },

  'GET /tasks': { responseExample: { tasks: [ex.pendingTask, ex.pendingTask2] } },
  'POST /tasks': {
    responseExample: { task: ex.looseTask },
    postmanTest: ["if (pm.response.code === 201) pm.collectionVariables.set('taskId', pm.response.json().task.task.id);"],
  },
  'GET /tasks/:id': { paramVars: taskId, responseExample: { task: ex.failedTask } },
  'POST /tasks/:id/approve': { paramVars: taskId, responseExample: { task: ex.readyTask } },
  'POST /tasks/:id/cancel': { paramVars: taskId, responseExample: { task: ex.cancelledTask } },
  'POST /tasks/:id/retry': { paramVars: taskId, responseExample: { task: ex.retriedTask } },
  'POST /tasks/manual': { responseExample: { task: ex.manualTask } },

  'GET /sessions': { responseExample: { sessions: [ex.session] } },
  'GET /sessions/:id': { paramVars: sessionId, responseExample: { session: ex.session } },
  'GET /sessions/:id/events': { paramVars: sessionId, responseExample: { sessionId: ex.ids.session, events: ex.events, lastSeq: 6, hasMore: false } },

  'GET /usage': { responseExample: { groupBy: ['agent', 'day'], rows: ex.usageRows } },

  'GET /skills': { responseExample: { skills: ex.skillsList } },
  'POST /skills/import': { responseExample: { result: ex.skillImport } },
  'POST /skills/:name/approve': { paramVars: skillName, responseExample: { result: ex.skillApproved } },
  'POST /skills/:name/reject': { paramVars: skillName, responseExample: { result: ex.skillRejected } },

  'GET /memory/:project/context': { paramVars: { project: 'projectId' }, responseExample: ex.memoryContext },

  'GET /settings': { responseExample: { settings: ex.settings } },
  'PATCH /settings': { responseExample: { settings: ex.settingsPatched } },
  'GET /mind/candidates': { responseExample: { candidates: ex.mindCandidates } },

  'GET /fs/list': { responseExample: ex.fsList },
  'POST /fs/pick-folder': { responseExample: { path: 'C:\\dev\\Vetworld' } },

  'GET /ws': {},
};

/** Rutas del servidor con lo que agrega la documentación. Falla si alguna ruta no tiene entrada o sobra una. */
export function docRoutes(server: readonly RouteSpec[] = serverRoutes()): DocRoute[] {
  const keys = new Set(server.map(routeKey));
  const orphans = Object.keys(docExtras).filter((k) => !keys.has(k));
  if (orphans.length) throw new Error(`docs/api/routes.ts documenta rutas que el servidor no tiene: ${orphans.join(', ')}`);
  return server.map((route) => {
    const extra = docExtras[routeKey(route)];
    if (!extra) throw new Error(`Falta documentar ${routeKey(route)} en docExtras (docs/api/routes.ts)`);
    return { ...route, ...extra };
  });
}
