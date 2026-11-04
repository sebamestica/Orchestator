import type { AgentAdapter, EventSink, TaskBrief } from '../../shared/index.ts';
import { taskBriefSchema } from '../../shared/index.ts';
import { Router, Supervisor, type AttemptResult, type ExecuteResult } from '../orchestrator/index.ts';

/** Tarea mínima con la que se comprueba que un agente Claude trabaja con la clave de la bóveda. */
export const SMOKE_PROMPT = 'Responde exactamente: OK';

export function smokeTask(id = 'probar-claude', projectId = 'orquestador'): TaskBrief {
  return taskBriefSchema.parse({
    id,
    projectId,
    title: 'Prueba de la clave de Claude',
    objective: `${SMOKE_PROMPT}\nNo edites archivos ni ejecutes comandos.`,
    ownedPaths: ['(ninguna)'],
    dependsOn: [],
    acceptance: ['La respuesta final es exactamente OK'],
    difficulty: 'low',
  });
}

export interface SmokeOptions {
  adapter: AgentAdapter;
  /** `envFor` de la composición (la clave sale de la bóveda, nunca del entorno). */
  envFor: (agentId: string) => Readonly<Record<string, string>>;
  sink: EventSink;
  worktreePath: string;
  timeoutMs?: number;
  task?: TaskBrief;
}

export interface SmokeResult {
  run: ExecuteResult;
  attempt: AttemptResult | undefined;
  /** Textos del asistente, ya tachados. */
  text: string;
}

/** Ejecuta la tarea con `Supervisor` (un intento, sin traspasos), igual que la flota. */
export async function runSmokeTask(opts: SmokeOptions): Promise<SmokeResult> {
  const config = opts.adapter.config;
  const supervisor = new Supervisor({ adapters: [opts.adapter], router: new Router({ agents: [config] }), sink: opts.sink, env: opts.envFor });
  const run = await supervisor.execute(opts.task ?? smokeTask(), {
    agentId: config.id,
    worktreePath: opts.worktreePath,
    maxAttempts: 1,
    updateQueue: false,
    timeoutMs: opts.timeoutMs ?? 240_000,
  });
  const attempt = run.attempts.at(-1);
  return { run, attempt, text: (attempt?.texts ?? []).join('\n').trim() };
}
