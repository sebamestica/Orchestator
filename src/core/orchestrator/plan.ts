import { z } from 'zod';
import type { TaskBrief } from '../../shared/index.ts';
import { idSchema, redactSecrets, taskBriefSchema } from '../../shared/index.ts';
import { findCycles } from './graph.ts';
import { findOverlaps, ownedPathProblem } from './paths.ts';

/** Mensaje de una conversación con el modelo planificador. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}
export interface PlannerRequest {
  system: string;
  messages: readonly ChatMessage[];
  signal?: AbortSignal;
}
/** Modelo que convierte el plan en tareas (Claude por SDK o cualquier modelo por API). Devuelve el texto de la respuesta. */
export interface PlannerLlm {
  complete(request: PlannerRequest): Promise<string>;
}

export type PlanIssueCode = 'json' | 'schema' | 'empty' | 'duplicate_id' | 'invalid_path' | 'overlap' | 'unknown_dependency' | 'cycle';
export interface PlanIssue {
  code: PlanIssueCode;
  message: string;
  taskIds: string[];
}

export interface ValidatePlanOptions {
  /** Proyecto de todas las tareas: lo decide el orquestador, no el modelo. */
  projectId?: string;
  /** Tareas ya existentes (fuera de este plan) que se pueden usar en `dependsOn`. */
  knownTaskIds?: Iterable<string>;
}
export interface PlanValidation {
  /** Tareas que pasaron el esquema. Solo usarlas si `issues` está vacío. */
  tasks: TaskBrief[];
  issues: PlanIssue[];
}

export interface PlanToTasksOptions extends ValidatePlanOptions {
  projectId: string;
  /** Rondas de reparación tras el primer intento (por defecto 2). */
  maxRepairs?: number;
  signal?: AbortSignal;
}
export type PlanResult =
  | { ok: true; tasks: TaskBrief[]; attempts: number }
  | { ok: false; issues: PlanIssue[]; attempts: number; lastOutput: string };

/**
 * Pide al modelo las tareas del plan, las valida (esquema, rutas sin solapes, dependencias existentes, sin ciclos)
 * y, si hay errores, se los devuelve para que repare.
 *
 * Intentos (decisión de A0): 1 intento + `maxRepairs` reparaciones; con el valor por defecto (2) son hasta
 * **3 llamadas** al modelo. `maxRepairs: 0` hace una sola llamada.
 *
 * Todo lo devuelto (tareas, errores y `lastOutput`) pasa por `redactSecrets`.
 */
export async function planToTasks(planText: string, llm: PlannerLlm, opts: PlanToTasksOptions): Promise<PlanResult> {
  const maxRepairs = opts.maxRepairs ?? 2;
  // Se materializa una vez: un iterable de un solo uso (p. ej. `Map.keys()`) llegaría vacío a la segunda lectura.
  const validateOpts: PlanToTasksOptions = { ...opts, knownTaskIds: new Set(opts.knownTaskIds ?? []) };
  const system = plannerSystemPrompt();
  const messages: ChatMessage[] = [{ role: 'user', content: plannerUserPrompt(planText, validateOpts) }];
  let lastOutput = '';
  let issues: PlanIssue[] = [];
  for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
    const reply = await llm.complete({ system, messages: [...messages], signal: opts.signal });
    lastOutput = redactSecrets(reply);
    const parsed = extractJsonArray(reply);
    const validation = parsed.ok
      ? validatePlan(parsed.value, validateOpts)
      : { tasks: [], issues: [{ code: 'json' as const, message: redactSecrets(parsed.error), taskIds: [] }] };
    issues = validation.issues;
    if (issues.length === 0) return { ok: true, tasks: validation.tasks, attempts: attempt };
    messages.push({ role: 'assistant', content: lastOutput }, { role: 'user', content: repairPrompt(issues) });
  }
  return { ok: false, issues, attempts: maxRepairs + 1, lastOutput };
}

/**
 * Valida un plan ya parseado. Pura: sirve también para planes escritos a mano.
 * Las tareas y los errores devueltos van tachados con `redactSecrets` (texto libre e ids inválidos); los ids y rutas
 * válidos se conservan tal cual, y un id o ruta que parezca una clave es un error de esquema.
 */
export function validatePlan(raw: unknown, opts: ValidatePlanOptions = {}): PlanValidation {
  const result = checkPlan(raw, opts);
  const keep = keepTokens(raw, result.tasks, opts);
  return {
    tasks: result.tasks.map((t) => redactTask(t, keep)),
    issues: result.issues.map((i) => ({ ...i, message: redactKeeping(i.message, keep), taskIds: i.taskIds.map((id) => redactKeeping(id, keep)) })),
  };
}

function checkPlan(raw: unknown, opts: ValidatePlanOptions): PlanValidation {
  const issues: PlanIssue[] = [];
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.tasks) ? raw.tasks : undefined;
  if (!list) return { tasks: [], issues: [{ code: 'json', message: 'La respuesta debe ser un arreglo JSON de tareas.', taskIds: [] }] };
  if (list.length === 0) return { tasks: [], issues: [{ code: 'empty', message: 'El plan no tiene tareas.', taskIds: [] }] };

  const tasks: TaskBrief[] = [];
  list.forEach((item: unknown, index) => {
    const input = opts.projectId && isRecord(item) ? { ...item, projectId: opts.projectId } : item;
    const result = taskBriefSchema.safeParse(input);
    if (result.success) {
      const t = result.data;
      const suspicious = [t.id, t.projectId, t.suggestedAgent, ...t.dependsOn, ...t.ownedPaths].filter((v): v is string => v !== undefined && looksLikeSecret(v));
      if (suspicious.length === 0) {
        tasks.push(t);
        return;
      }
      issues.push({ code: 'schema', message: `Tarea ${index} (${t.id}): ids y rutas no pueden contener claves: ${suspicious.join(', ')}.`, taskIds: [t.id] });
      return;
    }
    const id = isRecord(item) && typeof item.id === 'string' ? item.id : undefined;
    for (const issue of result.error.issues) {
      const where = issue.path.length ? issue.path.map(String).join('.') : '(tarea)';
      issues.push({ code: 'schema', message: `Tarea ${index}${id ? ` (${id})` : ''}: ${where}: ${issue.message}`, taskIds: id ? [id] : [] });
    }
  });

  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t.id, (counts.get(t.id) ?? 0) + 1);
  for (const [id, n] of counts) {
    if (n > 1) issues.push({ code: 'duplicate_id', message: `El id «${id}» se repite en ${n} tareas.`, taskIds: [id] });
  }

  for (const t of tasks) {
    for (const p of t.ownedPaths) {
      const problem = ownedPathProblem(p);
      if (problem) issues.push({ code: 'invalid_path', message: `Tarea ${t.id}: ruta inválida ${problem}.`, taskIds: [t.id] });
    }
  }

  for (const o of findOverlaps(tasks)) {
    issues.push({
      code: 'overlap',
      message: `Las tareas ${o.taskA} y ${o.taskB} se solapan: «${o.pathA}» y «${o.pathB}» pueden tocar los mismos archivos. Cada archivo debe pertenecer a una sola tarea.`,
      taskIds: [o.taskA, o.taskB],
    });
  }

  const ids = new Set(tasks.map((t) => t.id));
  // Las tareas que no pasaron el esquema ya tienen su error: sus dependientes no deben sumar uno falso.
  for (const item of list) if (isRecord(item) && typeof item.id === 'string') ids.add(item.id);
  const known = new Set(opts.knownTaskIds ?? []);
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!ids.has(dep) && !known.has(dep)) {
        issues.push({ code: 'unknown_dependency', message: `Tarea ${t.id}: depende de «${dep}», que no existe.`, taskIds: [t.id] });
      }
    }
  }

  for (const cycle of findCycles(tasks)) {
    const members = [...new Set(cycle)];
    const message = members.length === 1
      ? `Tarea ${cycle[0] ?? '?'}: depende de sí misma.`
      : `Ciclo de dependencias: ${cycle.join(' → ')} (→ = «depende de»).`;
    issues.push({ code: 'cycle', message, taskIds: members });
  }

  return { tasks, issues };
}

/** Inicios de arreglo u objeto que se prueban como mucho por respuesta (cada uno recorre el texto). */
const MAX_JSON_STARTS = 32;

/**
 * Extrae el arreglo JSON de la respuesta del modelo. Prueba, en orden: bloques ```json, la respuesta entera (si
 * empieza por `[` o `{`) y cada tramo balanceado que empiece por `[` y luego por `{`, hasta el primero que parsee.
 * Así tolera texto alrededor aunque traiga corchetes (`Plan [v2]: [...]`).
 */
export function extractJsonArray(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const candidates: string[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) if (m[1]?.trim()) candidates.push(m[1]);
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) candidates.push(trimmed);
  candidates.push(...balancedSlices(text, '['), ...balancedSlices(text, '{'));
  if (candidates.length === 0) return { ok: false, error: 'La respuesta no contiene JSON.' };
  let error: string | undefined;
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate.trim()) };
    } catch (err) {
      error ??= `JSON inválido: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { ok: false, error: error ?? 'La respuesta no contiene JSON.' };
}

/**
 * Tramos que empiezan en `open` y terminan donde se cierran sus corchetes/llaves (respetando cadenas JSON).
 * No entra en tramos anidados de uno ya tomado (si el de fuera no parsea, un trozo suyo tampoco es el plan) y se
 * detiene ante uno que no se cierra (lo que sigue está dentro de JSON roto).
 */
function balancedSlices(text: string, open: '[' | '{'): string[] {
  const out: string[] = [];
  let starts = 0;
  let start = text.indexOf(open);
  while (start !== -1 && starts < MAX_JSON_STARTS) {
    starts++;
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '[' || ch === '{') {
        depth++;
      } else if ((ch === ']' || ch === '}') && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) break;
    out.push(text.slice(start, end + 1));
    start = text.indexOf(open, end + 1);
  }
  return out;
}

/** Prefijos de claves reales (redact.ts): un id o ruta que empieza así y `redactSecrets` tacha, es una clave. */
const SECRET_PREFIX = /^(?:sk-|gh[pousr]_|AIza|eyJ)/i;
function looksLikeSecret(value: string): boolean {
  return SECRET_PREFIX.test(value) && redactSecrets(value) !== value;
}

/**
 * Ids y rutas legítimos que `redactSecrets` confundiría con claves (su patrón `sk-…` no exige límite de palabra:
 * «task-scheduler-with-priorities» sale como «ta[REDACTADO]»). Se protegen al tachar el texto libre.
 */
function keepTokens(raw: unknown, tasks: readonly TaskBrief[], opts: ValidatePlanOptions): string[] {
  const tokens = new Set<string>();
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.tasks) ? raw.tasks : [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    if (typeof item.id === 'string' && idSchema.safeParse(item.id).success) tokens.add(item.id);
    if (Array.isArray(item.dependsOn)) for (const d of item.dependsOn) if (typeof d === 'string' && idSchema.safeParse(d).success) tokens.add(d);
  }
  for (const t of tasks) for (const p of t.ownedPaths) tokens.add(p);
  for (const id of opts.knownTaskIds ?? []) tokens.add(id);
  if (opts.projectId) tokens.add(opts.projectId);
  return [...tokens].filter((t) => redactSecrets(t) !== t && !looksLikeSecret(t)).sort((a, b) => b.length - a.length);
}

/** `redactSecrets` sin tocar los tokens de `keep` (más largos primero). */
function redactKeeping(text: string, keep: readonly string[]): string {
  if (keep.length === 0) return redactSecrets(text);
  let out = text;
  keep.forEach((token, i) => {
    out = out.split(token).join(`\uE000${i}\uE001`); // marcadores de uso privado: ningún patrón de clave los cruza
  });
  return redactSecrets(out).replace(/\uE000(\d+)\uE001/g, (_m, i: string) => keep[Number(i)] ?? '');
}

/** Tacha el texto libre de una tarea; ids y rutas ya se validaron y se conservan. */
function redactTask(task: TaskBrief, keep: readonly string[]): TaskBrief {
  const r = (text: string) => redactKeeping(text, keep);
  return {
    ...task,
    title: r(task.title),
    objective: r(task.objective),
    acceptance: task.acceptance.map(r),
    contextRefs: task.contextRefs.map(r),
    skillRefs: task.skillRefs.map(r),
  };
}

let cachedSchema: string | undefined;
function taskJsonSchema(): string {
  cachedSchema ??= JSON.stringify(z.toJSONSchema(taskBriefSchema, { io: 'input' }));
  return cachedSchema;
}

export function plannerSystemPrompt(): string {
  return [
    'Eres el planificador de un orquestador que reparte tareas de programación entre agentes (Claude, Codex, agy) que trabajan en paralelo, cada uno en su propio worktree de git.',
    'Convierte el plan del usuario en tareas. Responde SOLO con un arreglo JSON de tareas, sin texto alrededor.',
    '',
    'Reglas:',
    '- Cada tarea se basta por sí sola: el agente no ve esta conversación. El objetivo dice qué hacer, dónde y cómo comprobarlo.',
    '- `id`: minúsculas, dígitos y guiones (p. ej. "adaptador-codex"), único en el plan.',
    '- `ownedPaths`: rutas relativas a la raíz del repo, con globs si hace falta (`src/core/x/**`), que SOLO esa tarea modifica. No pueden solaparse entre tareas: ni la misma ruta, ni una carpeta y algo dentro de ella, ni globs que coincidan con los mismos archivos. Sin rutas absolutas, sin «..» y sin negaciones.',
    '- `dependsOn`: ids de tareas que deben estar integradas antes de empezar. Solo ids existentes y sin ciclos.',
    '- `acceptance`: criterios verificables (comandos, pruebas, salidas esperadas).',
    '- `difficulty`: "high" para arquitectura, integración o razonamiento largo; "low" o "medium" para módulos acotados.',
    '- Prefiere tareas pequeñas e independientes para que corran en paralelo; usa `dependsOn` solo cuando una tarea necesita el código de otra.',
    '',
    'Esquema JSON de cada tarea:',
    taskJsonSchema(),
  ].join('\n');
}

function plannerUserPrompt(planText: string, opts: PlanToTasksOptions): string {
  const lines = [`Proyecto: ${opts.projectId}. Usa "projectId": "${opts.projectId}" en todas las tareas.`];
  const known = [...(opts.knownTaskIds ?? [])];
  if (known.length) lines.push(`Tareas ya existentes que puedes usar en dependsOn: ${known.join(', ')}.`);
  lines.push('', 'Plan:', redactSecrets(planText));
  return lines.join('\n');
}

function repairPrompt(issues: readonly PlanIssue[]): string {
  return [
    'Tu respuesta tiene estos errores:',
    ...issues.map((i) => `- [${i.code}] ${i.message}`),
    '',
    'Corrígelos y responde de nuevo SOLO con el arreglo JSON completo de tareas.',
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
