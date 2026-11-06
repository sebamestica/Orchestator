/**
 * Datos de ejemplo de la documentación. Se validan contra sus esquemas Zod al generar (ver build.ts):
 * un ejemplo que no cumple su contrato rompe la generación y las pruebas.
 *
 * Las cifras de Codex y agy salen de las capturas reales de `fixtures/` (cupo, tokens, versión).
 * Ningún ejemplo lleva una clave: la petición de alta usa un marcador (`{{apiKey}}` en Postman) y las
 * respuestas solo `secretRef`.
 */
import type { LockEntry, QuarantinedSkill, SkillEntry, SkillSource } from '../../src/core/skills/index.ts';
import type {
  AgentConfig,
  AgentEvent,
  FolderInspection,
  FsListResponse,
  MindCandidate,
  ProbeResult,
  QuotaSnapshot,
  Settings,
  StorageCleanResult,
  StorageSummary,
  TaskBrief,
  UsageBucket,
  UsageRate,
  UsageSummary,
} from '../../src/shared/index.ts';

const T_START = '2026-11-01T21:30:00.000Z';
const T_ADD = '2026-11-01T21:31:12.000Z';
const T_PLAN = '2026-11-01T21:40:05.000Z';
const T_RUN = '2026-11-01T21:42:00.000Z';
const T_END = '2026-11-01T21:43:30.000Z';
const T_QUOTA = '2026-11-01T21:45:00.000Z';

export const ids = {
  agent: 'claude-mi-clave',
  codex: 'codex',
  agy: 'agy',
  project: 'vetworld',
  plan: 'plan-20261101-a1b2c3',
  task: 'validar-citas',
  task2: 'pruebas-citas',
  /** `thread_id` real de `fixtures/codex/exec-ok.jsonl`. */
  session: '01a198bb-df05-7741-818d-3f0a16dd05ae',
  /** Id de cuarentena `<nombre>-<marca>` (QUARANTINE_ID_RE de src/core/skills). */
  skill: 'revisar-pr-20261101-214500-a1b2c3',
} as const;

// ------------------------------------------------------------------------------ agentes

export const claudeConfig: AgentConfig = {
  id: ids.agent,
  kind: 'claude-sdk',
  provider: 'anthropic',
  displayName: 'Claude (mi clave)',
  model: 'claude-opus-5-5',
  baseUrl: 'https://api.anthropic.com',
  secretRef: `${ids.agent}-key-3fa9c1`,
  quotaFloor: 0.2,
  budgetUsd: 20,
  enabled: true,
};
export const claudeProbe: ProbeResult = {
  agentId: ids.agent,
  installed: true,
  authenticated: true,
  version: '0.3.302',
  models: ['claude-opus-5-5'],
  quotaMethod: 'manual-budget',
  warnings: ['El proveedor no informa saldo: el cupo se mide con budgetUsd.'],
};
export const claudeAgent = { config: claudeConfig, quotaMethod: 'manual-budget' as const, lastProbe: claudeProbe, createdAt: T_ADD, updatedAt: T_ADD };

export const codexConfig: AgentConfig = { id: ids.codex, kind: 'codex-cli', provider: 'codex', displayName: 'Codex CLI', quotaFloor: 0.2, enabled: true };
export const codexProbe: ProbeResult = {
  agentId: ids.codex,
  installed: true,
  authenticated: true,
  version: '0.165.0',
  models: ['gpt-6.1-sol'],
  quotaMethod: 'codex-ratelimits',
  warnings: [],
};
export const codexAgent = { config: codexConfig, quotaMethod: 'codex-ratelimits' as const, lastProbe: codexProbe, createdAt: T_START, updatedAt: T_ADD };

export const agyConfig: AgentConfig = { id: ids.agy, kind: 'agy-cli', provider: 'antigravity', displayName: 'Antigravity CLI (agy)', quotaFloor: 0.2, enabled: true };
export const agyAgent = { config: agyConfig, quotaMethod: null, lastProbe: null, createdAt: T_ADD, updatedAt: T_ADD };

export const detectedClis = [
  {
    id: ids.codex,
    kind: 'codex-cli' as const,
    provider: 'codex' as const,
    displayName: 'Codex CLI',
    executable: 'C:\\Program Files\\nodejs\\node.exe',
    argsPrefix: ['C:\\Users\\yo\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'],
    version: '0.165.0',
  },
  {
    id: ids.agy,
    kind: 'agy-cli' as const,
    provider: 'antigravity' as const,
    displayName: 'Antigravity CLI (agy)',
    executable: 'C:\\Users\\yo\\AppData\\Local\\Programs\\agy\\agy.exe',
    argsPrefix: [],
  },
];

// -------------------------------------------------------------------------------- cupos

/** `fixtures/codex/app-server-ratelimits.json`: 1 % usado de 5 h y 12 % de la semana. */
export const codexQuota: QuotaSnapshot = {
  agentId: ids.codex,
  method: 'codex-ratelimits',
  takenAt: T_QUOTA,
  buckets: [
    { groupId: 'codex', groupName: 'Codex', window: '5h', remainingFraction: 0.99, resetAt: '2026-11-02T05:46:24.000Z' },
    { groupId: 'codex', groupName: 'Codex', window: 'weekly', remainingFraction: 0.88, resetAt: '2026-11-04T14:00:31.000Z' },
  ],
  stale: false,
};
/** `fixtures/agy/usage.json` (grupo Gemini). */
export const agyQuota: QuotaSnapshot = {
  agentId: ids.agy,
  method: 'agy-usage',
  takenAt: T_QUOTA,
  buckets: [
    { groupId: 'gemini', groupName: 'Gemini Models', window: '5h', remainingFraction: 0.998650074005127, resetAt: '2026-11-02T00:45:40.000Z' },
    { groupId: 'gemini', groupName: 'Gemini Models', window: 'weekly', remainingFraction: 0.9996142983436584, resetAt: '2026-11-08T19:45:40.000Z' },
  ],
  stale: false,
};
export const quotaRecords = [
  { snapshot: codexQuota, recordedAt: T_QUOTA },
  { snapshot: agyQuota, recordedAt: T_QUOTA },
];

// ------------------------------------------------------------------- proyectos y tareas

export const project = { id: ids.project, name: 'Vetworld', repoPath: 'C:\\dev\\Vetworld', createdAt: T_START };

/** Respuesta de POST /projects con el cuerpo de ejemplo: `workspace` con los valores por defecto ya puestos. */
export const projectWithWorkspace = {
  ...project,
  workspace: {
    worktreesRoot: 'C:\\dev\\.worktrees\\vetworld-orq',
    baseBranch: 'main',
    integrationBranch: 'orq/integracion',
    links: ['.tools', 'workbench', 'assets-source', 'node_modules'],
    postCreate: [],
    gate: [{ command: 'npm', args: ['run', '-s', 'gate'], timeoutMs: 1_800_000, env: {} }],
  },
};

export const planText = '1. Agregar validación al formulario de citas.\n2. Pruebas del formulario.';

/** Cuerpo de POST /tasks (forma de entrada: sin `contextRefs` ni `skillRefs`). */
export const taskInput = {
  id: ids.task,
  projectId: ids.project,
  title: 'Validar el formulario de citas',
  objective: 'Agregar validación con Zod al formulario de citas.',
  ownedPaths: ['src/citas/**'],
  dependsOn: [],
  acceptance: ['Pruebas del formulario en verde'],
  difficulty: 'low' as const,
};
export const task1: TaskBrief = { ...taskInput, suggestedAgent: ids.codex, contextRefs: [], skillRefs: [] };
export const task2: TaskBrief = {
  id: ids.task2,
  projectId: ids.project,
  title: 'Pruebas del formulario de citas',
  objective: 'Cubrir con Vitest los casos válidos e inválidos del formulario de citas.',
  ownedPaths: ['tests/citas/**'],
  dependsOn: [ids.task],
  acceptance: ['Casos válidos e inválidos cubiertos', 'npm run gate en verde'],
  difficulty: 'low',
  contextRefs: ['Orquestador/Proyectos/vetworld/Contexto.md'],
  skillRefs: [],
};

const taskRecord = (
  task: TaskBrief,
  state: 'pending' | 'ready' | 'cancelled' | 'failed',
  agentId: string | null,
  updatedAt = T_PLAN,
  extra: { detail?: string; attempts?: number; lastEventAt?: string } = {},
) => ({
  task,
  state,
  planId: ids.plan,
  agentId,
  detail: extra.detail ?? null,
  attempts: extra.attempts ?? 0,
  createdAt: T_PLAN,
  updatedAt,
  lastEventAt: extra.lastEventAt ?? null,
});
export const pendingTask = taskRecord(task1, 'pending', null);
export const pendingTask2 = taskRecord(task2, 'pending', null);
export const readyTask = taskRecord(task1, 'ready', null, T_RUN);
export const readyTask2 = taskRecord(task2, 'ready', null, T_RUN);
export const cancelledTask = taskRecord(task1, 'cancelled', null, T_RUN, { detail: 'Ya no hace falta' });
/** Tarea fallida (motivo guardado) y la misma tras `POST /tasks/:id/retry`: vuelve a la flota. */
export const failedTask = taskRecord(task1, 'failed', ids.codex, T_END, {
  detail: 'validar-citas: sin éxito tras 4 intentos (último: timeout (timeout: Sin actividad del agente durante 60 min (plazo por inactividad).)).',
  attempts: 1,
  lastEventAt: T_END,
});
export const retriedTask = taskRecord(task1, 'ready', ids.codex, T_QUOTA, { detail: 'reintento pedido por el usuario', attempts: 1, lastEventAt: T_END });
export const looseTask = {
  task: { ...taskInput, contextRefs: [], skillRefs: [] },
  state: 'pending' as const,
  planId: null,
  agentId: null,
  detail: null,
  attempts: 0,
  createdAt: T_PLAN,
  updatedAt: T_PLAN,
  lastEventAt: null,
};

export const plan = { id: ids.plan, projectId: ids.project, text: planText, warnings: [], createdAt: T_PLAN, taskIds: [ids.task, ids.task2] };

// ------------------------------------------------------------------ sesiones y eventos

const base = { sessionId: ids.session, agentId: ids.codex } as const;
export const events: AgentEvent[] = [
  { ...base, seq: 0, ts: '2026-11-01T21:42:00.000Z', type: 'status', payload: { state: 'running', detail: 'thread.started' } },
  { ...base, seq: 1, ts: '2026-11-01T21:42:20.000Z', type: 'tool_call', payload: { callId: 'item_1', name: 'command_execution', inputSummary: 'npm test -- citas' } },
  { ...base, seq: 2, ts: '2026-11-01T21:42:41.000Z', type: 'tool_result', payload: { callId: 'item_1', ok: true, summary: '12 pruebas aprobadas' } },
  { ...base, seq: 3, ts: '2026-11-01T21:42:55.000Z', type: 'file_change', payload: { path: 'src/citas/formulario.ts', change: 'modify' } },
  { ...base, seq: 4, ts: '2026-11-01T21:43:10.000Z', type: 'text', payload: { text: 'OK', role: 'assistant' } },
  {
    ...base,
    seq: 5,
    ts: '2026-11-01T21:43:11.000Z',
    type: 'usage',
    payload: { inputTokens: 22572, outputTokens: 5, cachedInputTokens: 13440, reasoningTokens: 0, model: 'gpt-6.1-sol' },
  },
  { ...base, seq: 6, ts: T_END, type: 'done', payload: { ok: true, summary: 'Validación agregada; pruebas en verde.' } },
];

export const session = {
  id: ids.session,
  agentId: ids.codex,
  taskId: ids.task,
  parentSessionId: null,
  state: 'done' as const,
  startedAt: T_RUN,
  updatedAt: T_END,
  endedAt: T_END,
  lastSeq: 6,
};

export const usageRows = [
  { agentId: ids.agent, day: '2026-11-01', inputTokens: 18250, outputTokens: 2140, cachedInputTokens: 12000, reasoningTokens: 0, costUsd: 0.103, entries: 3 },
  { agentId: ids.codex, day: '2026-11-01', inputTokens: 22572, outputTokens: 5, cachedInputTokens: 13440, reasoningTokens: 0, costUsd: 0, entries: 1 },
];

// ----------------------------------------------------------------- uso y gasto (issue 5)

/** Suma de uso con el total calculado (entrada nueva + caché escrita + caché leída + salida). */
function usageBucket(b: Partial<Omit<UsageBucket, 'totalTokens'>>): UsageBucket {
  const full = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0, costWithRateUsd: 0, entries: 0, ...b };
  return { ...full, totalTokens: full.inputTokens + full.cacheWriteTokens + full.cacheReadTokens + full.outputTokens };
}
const noUsage = usageBucket({});

/**
 * Cifras reales del 2026-11-04 (la base del usuario, en solo lectura), con un multiplicador de 1,3 en los modelos de
 * Claude. Los proyectos se juntan en uno de ejemplo; esos registros son anteriores al issue 5 (sin caché escrita).
 */
const apiDay = usageBucket({ inputTokens: 11669759, cacheReadTokens: 90578547, outputTokens: 1868576, costUsd: 87.980337, costWithRateUsd: 114.374438, entries: 63 });
const subscriptionDay = usageBucket({ inputTokens: 1936306, cacheReadTokens: 40008176, outputTokens: 209999, reasoningTokens: 85216, entries: 432 });
const mindDay = usageBucket({ inputTokens: 5735757, cacheReadTokens: 67708621, outputTokens: 1630094, costUsd: 52.604748, costWithRateUsd: 68.386172, entries: 36 });
const plannerDay = usageBucket({ inputTokens: 67615, cacheReadTokens: 21299, outputTokens: 70290, costUsd: 1.748103, costWithRateUsd: 2.272534, entries: 8 });
const otherDay = usageBucket({ inputTokens: 5866387, cacheReadTokens: 22848627, outputTokens: 168192, costUsd: 33.627486, costWithRateUsd: 43.715732, entries: 19 });
const looseDay = usageBucket({ inputTokens: 5934002, cacheReadTokens: 22869926, outputTokens: 238482, costUsd: 35.375589, costWithRateUsd: 45.988266, entries: 27 });
const T_USAGE_QUOTA = '2026-11-05T01:38:10.355Z';

export const usageSummary: UsageSummary = {
  currency: 'USD',
  timeZone: 'America/Santiago',
  today: '2026-11-04',
  period: 'month',
  from: '2026-11-01',
  to: '2026-11-04',
  periods: {
    today: { from: '2026-11-04', to: '2026-11-04', api: apiDay, subscription: subscriptionDay },
    week: { from: '2026-10-29', to: '2026-11-04', api: apiDay, subscription: subscriptionDay },
    month: { from: '2026-11-01', to: '2026-11-04', api: apiDay, subscription: subscriptionDay },
  },
  totals: { api: apiDay, subscription: subscriptionDay },
  byModel: [
    {
      ...usageBucket({ inputTokens: 9259059, cacheReadTokens: 45871974, outputTokens: 755319, costUsd: 66.67219, costWithRateUsd: 86.673847, entries: 58 }),
      billing: 'api',
      model: 'claude-opus-5-5',
      agentIds: [ids.agent, 'orquestador'],
      multiplier: 1.3,
      withoutCost: 0,
    },
    {
      ...usageBucket({ inputTokens: 2368450, cacheReadTokens: 44706573, outputTokens: 1090013, costUsd: 21.291244, costWithRateUsd: 27.678618, entries: 3 }),
      billing: 'api',
      model: 'claude-sonnet-5-5',
      agentIds: ['orquestador'],
      multiplier: 1.3,
      withoutCost: 0,
    },
    {
      ...usageBucket({ inputTokens: 42250, outputTokens: 23244, costUsd: 0.016903, costWithRateUsd: 0.021974, entries: 2 }),
      billing: 'api',
      model: 'claude-haiku-5-5',
      agentIds: ['orquestador'],
      multiplier: 1.3,
      withoutCost: 0,
    },
    { ...subscriptionDay, billing: 'subscription', model: null, agentIds: [ids.agy, ids.codex], multiplier: 1, withoutCost: 0 },
  ],
  byDay: [
    { day: '2026-11-01', api: noUsage, subscription: noUsage },
    { day: '2026-11-02', api: noUsage, subscription: noUsage },
    { day: '2026-11-03', api: noUsage, subscription: noUsage },
    { day: '2026-11-04', api: apiDay, subscription: subscriptionDay },
  ],
  byRole: [
    { role: 'mind', api: mindDay, subscription: noUsage },
    { role: 'planner', api: plannerDay, subscription: noUsage },
    { role: 'other', api: otherDay, subscription: subscriptionDay },
  ],
  byProject: [
    { projectId: ids.project, name: 'Vetworld', api: mindDay, subscription: noUsage },
    { projectId: null, name: null, api: looseDay, subscription: subscriptionDay },
  ],
  subscriptions: [
    {
      ...usageBucket({ inputTokens: 1333628, cacheReadTokens: 32218480, outputTokens: 144202, reasoningTokens: 79485, entries: 421 }),
      agentId: ids.agy,
      displayName: 'Antigravity (agy)',
      kind: 'agy-cli',
      models: [],
      quotaRemaining: 0.79,
      quotaTakenAt: T_USAGE_QUOTA,
      quotaStale: false,
    },
    {
      ...usageBucket({ inputTokens: 602678, cacheReadTokens: 7789696, outputTokens: 65797, reasoningTokens: 5731, entries: 11 }),
      agentId: ids.codex,
      displayName: 'Codex CLI',
      kind: 'codex-cli',
      models: [],
      quotaRemaining: 0.9,
      quotaTakenAt: '2026-11-05T01:37:59.854Z',
      quotaStale: false,
    },
  ],
  coverage: { withoutCacheWrite: 63, withoutCost: 0, unlinked: 451 },
};

export const usageRates: UsageRate[] = [{ model: 'claude-opus-5-5', multiplier: 1.3, updatedAt: '2026-11-04T22:10:00.000Z' }];

// --------------------------------------------------------------------- almacenamiento (issue 13)

export const DATA_DIR = 'C:\\Users\\yo\\AppData\\Local\\orquestador';
const MB = 1024 * 1024;

/** `GET /storage`: 38 adjuntos (31 imágenes), 24 chats, 6 carpetas de conversaciones y la base con su WAL. */
export const storageSummary: StorageSummary = {
  measuredAt: '2026-11-05T14:20:00.000Z',
  totalBytes: 74 * MB + 52 * MB + 96 * MB + 4 * MB + 32768,
  attachments: {
    dir: `${DATA_DIR}\\attachments`,
    total: { count: 38, bytes: 74 * MB },
    images: { count: 31, bytes: 61 * MB },
    others: { count: 7, bytes: 13 * MB },
    orphans: { count: 9, bytes: 18 * MB },
    linkedFiles: 4,
  },
  chats: {
    chats: 24,
    busy: 1,
    messages: 1310,
    events: 48210,
    sessions: 61,
    bytes: 71 * MB,
    leftovers: { count: 5120, bytes: 9 * MB },
    oldestUpdatedAt: '2026-10-02T18:04:11.000Z',
  },
  conversations: {
    root: 'C:\\Users\\yo\\AppData\\Local\\berland-conversaciones',
    exists: true,
    total: { count: 6, bytes: 52 * MB },
    orphans: { count: 2, bytes: 11 * MB },
    truncated: false,
  },
  database: {
    path: `${DATA_DIR}\\orquestador.db`,
    fileBytes: 96 * MB,
    walBytes: 4 * MB,
    shmBytes: 32768,
    totalBytes: 100 * MB + 32768,
    freeBytes: 6 * MB,
    chatBytes: 80 * MB,
    otherBytes: 10 * MB,
  },
};

/** `POST /storage/chats/clean` con `older` y 30 días: un chat seguía respondiendo y se omitió. */
export const storageChatsCleaned: StorageCleanResult = {
  target: 'chats',
  deleted: { chats: 9, messages: 412, events: 15230, sessions: 19, attachments: 0, files: 214, folders: 2 },
  freedBytes: 41 * MB,
  skipped: [{ id: '3f6c1e0a-5d2b-4c8e-9a71-0b2d4e6f8a10', reason: 'está respondiendo' }],
  compacted: true,
  warnings: [],
};

/** `POST /storage/attachments/clean` con `orphans`. */
export const storageAttachmentsCleaned: StorageCleanResult = {
  target: 'attachments',
  deleted: { chats: 0, messages: 0, events: 0, sessions: 0, attachments: 9, files: 9, folders: 0 },
  freedBytes: 18 * MB,
  skipped: [{ id: '8b1d2c3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e', reason: 'se subió hace menos de 1 h y aún no se envía' }],
  compacted: false,
  warnings: [],
};

export const storageConversationsCleaned: StorageCleanResult = {
  target: 'conversations',
  deleted: { chats: 0, messages: 0, events: 0, sessions: 0, attachments: 0, files: 1830, folders: 2 },
  freedBytes: 11 * MB,
  skipped: [],
  compacted: false,
  warnings: [],
};

export const storageCompacted: StorageCleanResult = {
  target: 'database',
  deleted: { chats: 0, messages: 0, events: 0, sessions: 0, attachments: 0, files: 0, folders: 0 },
  freedBytes: 10 * MB,
  skipped: [],
  compacted: true,
  warnings: [],
};

// --------------------------------------------------------------------- skills y memoria

// Tipos reales del hub de skills (src/core/skills); el servidor los transmite tal cual, tachados.

export const skillsList: SkillEntry[] = [
  {
    name: 'flota-orquestador',
    folder: 'flota-orquestador',
    dir: 'C:\\dev\\agent-hub\\skills\\flota-orquestador',
    root: 'C:\\dev\\agent-hub\\skills',
    description: 'Reglas para trabajar en la flota del orquestador.',
    valid: true,
    problems: [],
  },
];
const skillSource: SkillSource = {
  kind: 'zip',
  path: 'C:\\Users\\yo\\Downloads\\mi-skill.zip',
  sha256: '6f9bde7b3c3c90f1692c4071a3f1cb69709f7ee04531239a31442abd601ee4eb',
  topFolder: 'revisar-pr',
};
const skillLicense = { declared: 'MIT', files: [] };
const skillImportedAt = '2026-11-01T21:45:00.000Z';
const skillTreeHash = 'sha256:1ed65407c3d185c563d8e9a03dae30ba597254417dee0f5d6243249819acfd1c';
export const skillImport: QuarantinedSkill = {
  version: 1,
  id: ids.skill,
  name: 'revisar-pr',
  description: 'Revisa un PR y deja comentarios en español.',
  importedAt: skillImportedAt,
  source: skillSource,
  fileCount: 2,
  totalBytes: 3120,
  treeHash: skillTreeHash,
  files: [
    { path: 'SKILL.md', size: 2048, sha256: 'ee8be1e7c5ca51b32e7a824690c5369c0025cf9e8961ca92d417965003607812' },
    { path: 'scripts/check.sh', size: 1072, sha256: 'f334e3a73256c1be8daa684df566fa56f4037e392ea8fa4a80f05b031233994e', script: ['extensión', 'shebang'] },
  ],
  scripts: [{ path: 'scripts/check.sh', reasons: ['extensión', 'shebang'] }],
  license: skillLicense,
  skipped: [],
  warnings: [],
  skillMdPreview: '---\nname: revisar-pr\ndescription: Revisa un PR y deja comentarios en español.\nlicense: MIT\n---\n# Revisar PR',
  path: `C:\\dev\\agent-hub\\skills-entrantes\\${ids.skill}`,
};
export const skillApproved: LockEntry = {
  name: 'revisar-pr',
  description: skillImport.description,
  source: skillSource,
  treeHash: skillTreeHash,
  fileCount: 2,
  totalBytes: 3120,
  scripts: ['scripts/check.sh'],
  license: skillLicense,
  quarantineId: ids.skill,
  importedAt: skillImportedAt,
  approvedAt: '2026-11-01T21:50:00.000Z',
};
/** `reject` devuelve el id de cuarentena descartado. */
export const skillRejected: string = ids.skill;

const memoryText =
  '# Vetworld\nEstado: formulario de citas sin validación.\nDecisiones: Zod en formularios; Vitest para pruebas.\n\n## Sesiones pertinentes\n- 2026-10-30 citas-ui (codex): ok, src/citas/**';
export const memoryContext = { projectId: ids.project, taskId: ids.task, budgetChars: 4000, chars: memoryText.length, context: memoryText };

// ------------------------------------------------------------------ F5: ajustes, carpetas y tarea manual (c14)

export const settings: Settings = {
  mind: { agentId: ids.agent, model: 'claude-opus-5-5', effort: 'high' },
  workers: [],
  defaultMode: 'plan',
  quotaFloor: 0.2,
  concurrency: 3,
  appearance: { theme: 'dark', reducedEffects: false },
};
/** Resultado de `PATCH /settings` con el cuerpo de ejemplo. */
export const settingsPatched: Settings = { ...settings, workers: [ids.agent, ids.codex], concurrency: 2, quotaFloor: 0.25 };

export const mindCandidates: MindCandidate[] = [
  { agentId: ids.agent, displayName: claudeConfig.displayName, kind: 'claude-sdk', support: 'full', models: claudeProbe.models },
  { agentId: ids.codex, displayName: codexConfig.displayName, kind: 'codex-cli', support: 'experimental', note: 'necesita el puente MCP (F5.2)', models: codexProbe.models },
  { agentId: ids.agy, displayName: agyConfig.displayName, kind: 'agy-cli', support: 'experimental', note: 'necesita el puente MCP (F5.2)', models: [] },
];

export const fsList: FsListResponse = {
  path: 'C:\\dev',
  parent: 'C:\\',
  entries: [
    { name: 'agent-hub', path: 'C:\\dev\\agent-hub', isDir: true, isGitRepo: false },
    { name: 'orquestador', path: 'C:\\dev\\orquestador', isDir: true, isGitRepo: true },
    { name: 'Vetworld', path: 'C:\\dev\\Vetworld', isDir: true, isGitRepo: true },
    { name: 'notas.md', path: 'C:\\dev\\notas.md', isDir: false, isGitRepo: false },
  ],
};

export const folderInspection: FolderInspection = {
  path: 'C:\\dev\\Vetworld',
  suggestedId: ids.project,
  suggestedName: 'Vetworld',
  isGitRepo: true,
  gate: [{ command: 'npm', args: ['run', '-s', 'gate'] }],
  links: ['node_modules'],
  warnings: [],
};

/** Respuesta de POST /projects/from-folder: `workspace` deducido de la carpeta. */
export const projectFromFolder = {
  ...project,
  workspace: {
    worktreesRoot: 'C:\\dev\\.worktrees\\vetworld-orq',
    baseBranch: 'main',
    integrationBranch: 'orq/integracion',
    links: ['node_modules'],
    postCreate: [],
    gate: [{ command: 'npm', args: ['run', '-s', 'gate'], timeoutMs: 1_800_000, env: {} }],
  },
};

const MANUAL_ID = 'manual-20261101-4f9a2c';
export const manualTaskInput = {
  projectId: ids.project,
  title: 'Corregir la fecha de las citas',
  objective: 'Las citas del lunes se muestran con un día de desfase: corrige la zona horaria al guardarlas.',
  ownedPaths: ['src/citas/**'],
  acceptance: ['Las pruebas de citas pasan'],
  approve: false,
};
/** Respuesta de POST /tasks/manual con el cuerpo de ejemplo (`approve: false`: queda pendiente, sin plan). */
export const manualTask = {
  task: {
    id: MANUAL_ID,
    projectId: ids.project,
    title: manualTaskInput.title,
    objective: manualTaskInput.objective,
    ownedPaths: manualTaskInput.ownedPaths,
    dependsOn: [],
    acceptance: manualTaskInput.acceptance,
    difficulty: 'medium' as const,
    contextRefs: [],
    skillRefs: [],
  },
  state: 'pending' as const,
  planId: null,
  agentId: null,
  detail: null,
  attempts: 0,
  createdAt: T_PLAN,
  updatedAt: T_PLAN,
  lastEventAt: null,
};
