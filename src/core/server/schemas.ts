import { z } from 'zod';
import {
  agentConfigSchema,
  agentEventSchema,
  idSchema,
  manualTaskBody as manualTaskInput,
  probeResultSchema,
  quotaMethodSchema,
  quotaSnapshotSchema,
  sessionStateSchema,
  taskBriefSchema,
  taskStateSchema,
} from '../../shared/index.ts';
import { ownedPathProblem } from '../orchestrator/paths.ts';
import { addAgentFromKeySchema, agentInputSchema, agentPatchSchema } from '../registry/index.ts';
import { projectInputSchema } from '../store/index.ts';
import { API_ERROR_CODES } from './errors.ts';

// ------------------------------------------------------------- parámetros

export const agentIdParam = idSchema;
export const projectIdParam = idSchema;
export const planIdParam = idSchema;
export const taskIdParam = idSchema;
export const sessionIdParam = z.string().min(1).max(200);
/** Nombre de skill o de su carpeta en cuarentena (`<nombre>-<marca>`); sin `..` ni separadores. */
export const skillNameParam = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .refine((s) => !s.includes('..'), { message: 'Nombre inválido' });

// ---------------------------------------------------------------- entradas

/** Alta de agente: con `apiKey` (va a la bóveda y se prueba) o configuración sin clave (CLI). */
export const addAgentBody = z.union([addAgentFromKeySchema, agentInputSchema]);
export const patchAgentBody = agentPatchSchema;
export const quotasQuery = z.strictObject({ agentId: idSchema.optional() });
export const refreshQuotasBody = z.strictObject({ agentId: idSchema.optional() });
export const projectBody = projectInputSchema;
export const planBody = z.strictObject({
  projectId: idSchema,
  /** Plan en texto libre; el planificador (Claude) lo convierte en tareas. */
  text: z.string().trim().min(1).max(100_000),
});
export const tasksQuery = z.strictObject({
  projectId: idSchema.optional(),
  state: taskStateSchema.optional(),
  planId: idSchema.optional(),
});
/** Misma regla que `validatePlan`: sin rutas absolutas, «..», negaciones ni extglobs (si no, la tarea nunca integra). */
function refineOwnedPaths(t: { ownedPaths: readonly string[] }, ctx: z.RefinementCtx): void {
  t.ownedPaths.forEach((path, i) => {
    const problem = ownedPathProblem(path);
    if (problem) ctx.addIssue({ code: 'custom', path: ['ownedPaths', i], message: `ruta propia inválida ${problem}` });
  });
}
export const taskBody = taskBriefSchema.superRefine(refineOwnedPaths);
export const manualTaskBody = manualTaskInput.superRefine(refineOwnedPaths);
export const approveTaskBody = z.strictObject({ agentId: idSchema.optional() });
export const cancelTaskBody = z.strictObject({ reason: z.string().trim().min(1).max(500).optional() });
export const sessionsQuery = z.strictObject({
  taskId: idSchema.optional(),
  agentId: idSchema.optional(),
  parentSessionId: sessionIdParam.optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
export const eventsQuery = z.strictObject({
  /** Último `seq` recibido: devuelve los eventos con `seq` mayor (−1 o ausente: desde el principio). */
  since: z.coerce.number().int().min(-1).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const usageQuery = z.strictObject({
  /** Lista separada por comas: agent, day, session, model. */
  groupBy: z
    .string()
    .regex(/^(agent|day|session|model)(,(agent|day|session|model))*$/)
    .optional(),
  agentId: idSchema.optional(),
  sessionId: sessionIdParam.optional(),
  model: z.string().min(1).max(200).optional(),
  from: day.optional(),
  to: day.optional(),
});
export const importSkillBody = z.strictObject({
  /** Carpeta o `.zip` local a poner en cuarentena. */
  source: z.string().trim().min(1).max(2048),
});
export const memoryQuery = z.strictObject({
  taskId: idSchema.optional(),
  budget: z.coerce.number().int().min(200).max(200_000).optional(),
});

// -------------------------------------------------------------- respuestas

const isoTs = z.iso.datetime();
export const errorResponse = z.strictObject({
  error: z.strictObject({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    warnings: z.array(z.string()).optional(),
    issues: z.array(z.strictObject({ code: z.string(), message: z.string(), taskIds: z.array(z.string()).optional() })).optional(),
  }),
});
export const healthResponse = z.strictObject({
  ok: z.literal(true),
  version: z.string(),
  startedAt: isoTs,
  uptimeMs: z.number().int().nonnegative(),
});
export const agentRecordSchema = z.strictObject({
  config: agentConfigSchema,
  quotaMethod: quotaMethodSchema.nullable(),
  lastProbe: probeResultSchema.nullable(),
  createdAt: isoTs,
  updatedAt: isoTs,
});
export const agentsResponse = z.strictObject({ agents: z.array(agentRecordSchema) });
export const agentResponse = z.strictObject({ agent: agentRecordSchema });
export const probeResponse = z.strictObject({ agent: agentRecordSchema, probe: probeResultSchema });
export const addAgentResponse = z.strictObject({ agent: agentRecordSchema, probe: probeResultSchema.nullable() });
export const detectedCliSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(['codex-cli', 'agy-cli']),
  provider: z.enum(['codex', 'antigravity']),
  displayName: z.string(),
  executable: z.string(),
  argsPrefix: z.array(z.string()),
  version: z.string().optional(),
});
export const detectResponse = z.strictObject({ detected: z.array(detectedCliSchema), added: z.array(agentRecordSchema) });
export const deletedResponse = z.strictObject({ deleted: z.literal(true), id: z.string() });
export const quotaRecordSchema = z.strictObject({ snapshot: quotaSnapshotSchema, recordedAt: isoTs });
export const quotasResponse = z.strictObject({ quotas: z.array(quotaRecordSchema) });
export const refreshQuotasResponse = z.strictObject({
  quotas: z.array(quotaRecordSchema),
  errors: z.array(z.strictObject({ agentId: z.string(), message: z.string() })),
});
export const projectRecordSchema = z.strictObject({ ...projectInputSchema.shape, createdAt: isoTs });
export const projectsResponse = z.strictObject({ projects: z.array(projectRecordSchema) });
export const projectResponse = z.strictObject({ project: projectRecordSchema });
export const taskRecordSchema = z.strictObject({
  task: taskBriefSchema,
  state: taskStateSchema,
  planId: z.string().nullable(),
  agentId: z.string().nullable(),
  /** Motivo del último cambio de estado (p. ej. por qué falló o «interrumpida al reiniciar el núcleo»). */
  detail: z.string().nullable(),
  /** Veces que la flota empezó la tarea (la primera y cada reintento). */
  attempts: z.number().int().nonnegative(),
  createdAt: isoTs,
  updatedAt: isoTs,
  /** Hora del último evento de sus agentes (autor o revisor): muestra el avance aunque el estado no cambie. */
  lastEventAt: isoTs.nullable(),
});
export const planRecordSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  text: z.string(),
  warnings: z.array(z.string()),
  createdAt: isoTs,
  taskIds: z.array(idSchema),
});
export const planResponse = z.strictObject({ plan: planRecordSchema, tasks: z.array(taskRecordSchema) });
export const tasksResponse = z.strictObject({ tasks: z.array(taskRecordSchema) });
export const taskResponse = z.strictObject({ task: taskRecordSchema });
export const sessionRecordSchema = z.strictObject({
  id: z.string(),
  agentId: z.string(),
  taskId: z.string().nullable(),
  parentSessionId: z.string().nullable(),
  state: sessionStateSchema,
  startedAt: isoTs,
  updatedAt: isoTs,
  endedAt: isoTs.nullable(),
  lastSeq: z.number().int().min(-1),
});
export const sessionsResponse = z.strictObject({ sessions: z.array(sessionRecordSchema) });
export const sessionResponse = z.strictObject({ session: sessionRecordSchema });
export const eventsResponse = z.strictObject({
  sessionId: z.string(),
  events: z.array(agentEventSchema),
  /** `seq` del último evento devuelto (o el `since` pedido si no hay nuevos): úsalo en la siguiente llamada. */
  lastSeq: z.number().int().min(-1),
  hasMore: z.boolean(),
});
export const usageRowSchema = z.strictObject({
  agentId: z.string().optional(),
  day: day.optional(),
  sessionId: z.string().optional(),
  model: z.string().nullable().optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  entries: z.number().int().nonnegative(),
});
export const usageResponse = z.strictObject({ groupBy: z.array(z.enum(['agent', 'day', 'session', 'model'])), rows: z.array(usageRowSchema) });
/** El hub de skills (otro módulo) define el detalle; aquí se transmite tal cual, tachado. */
export const skillsResponse = z.strictObject({ skills: z.unknown() });
export const skillResultResponse = z.strictObject({ result: z.unknown() });
export const memoryContextResponse = z.strictObject({
  projectId: idSchema,
  taskId: idSchema.nullable(),
  budgetChars: z.number().int().positive(),
  chars: z.number().int().nonnegative(),
  context: z.string(),
});
