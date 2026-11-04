import { z } from 'zod';
import { idSchema } from './agents.ts';

/** Encargo que recibe un agente. Debe bastar por sí solo: el agente no ve la conversación del orquestador. */
export const taskBriefSchema = z.strictObject({
  id: idSchema,
  projectId: idSchema,
  title: z.string().min(1).max(120),
  objective: z.string().min(1),
  /** Rutas (relativas al repo) que solo esta tarea puede modificar. */
  ownedPaths: z.array(z.string().min(1)).min(1),
  dependsOn: z.array(idSchema),
  acceptance: z.array(z.string().min(1)).min(1),
  difficulty: z.enum(['low', 'medium', 'high']),
  suggestedAgent: idSchema.optional(),
  /** Notas de memoria (Obsidian) y skills a leer, por ruta; el agente abre solo lo que necesite. */
  contextRefs: z.array(z.string()).default([]),
  skillRefs: z.array(z.string()).default([]),
});
export type TaskBrief = z.infer<typeof taskBriefSchema>;

export const taskStateSchema = z.enum(['pending', 'ready', 'running', 'review', 'integrated', 'failed', 'handed_off', 'cancelled']);
export type TaskState = z.infer<typeof taskStateSchema>;

/** Traspaso de una tarea a otro agente (regla: si Codex o agy agotan cupo, Claude continúa). */
export const handoffSchema = z.strictObject({
  taskId: idSchema,
  fromAgent: idSchema,
  toAgent: idSchema,
  reason: z.enum(['quota_exhausted', 'failure', 'timeout', 'manual']),
  worktreePath: z.string().min(1),
  partialSummary: z.string(),
  at: z.iso.datetime(),
});
export type Handoff = z.infer<typeof handoffSchema>;

export interface RunContext {
  /** Carpeta de trabajo de la tarea (worktree propio). */
  worktreePath: string;
  /** Variables extra para el proceso del agente (las claves llegan aquí, solo en memoria). */
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  timeoutMs: number;
  /** Resumen previo si la tarea viene de un traspaso. */
  handoff?: Handoff;
}
