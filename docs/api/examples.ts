/**
 * Datos de ejemplo de la documentación. Se validan contra sus esquemas Zod al generar (ver build.ts):
 * un ejemplo que no cumple su contrato rompe la generación y las pruebas.
 *
 * Las cifras de Codex y agy salen de las capturas reales de `fixtures/` (cupo, tokens, versión).
 * Ningún ejemplo lleva una clave: la petición de alta usa un marcador (`{{apiKey}}` en Postman) y las
 * respuestas solo `secretRef`.
 */
import type { LockEntry, QuarantinedSkill, SkillEntry, SkillSource } from '../../src/core/skills/index.ts';
import type { AgentConfig, AgentEvent, FolderInspection, FsListResponse, MindCandidate, ProbeResult, QuotaSnapshot, Settings, TaskBrief } from '../../src/shared/index.ts';

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
