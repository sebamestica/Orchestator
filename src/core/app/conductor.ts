import { join } from 'node:path';
import type { MindMode, QuotaProvider, TaskBrief } from '../../shared/index.ts';
import { ClaudeSdkTranslator } from '../adapters/claude-sdk/index.ts';
import {
  CONDUCTOR_AGENT_ID,
  ConductorSession,
  TaskProposals,
  approveAndDeliver,
  type ConductorQueryFn,
  type ConductorSessionOptions,
  type DeliveryReport,
  type FleetPort,
  type FleetTaskStatus,
  type PlannerPort,
  type ProjectTaskStatus,
  type SkillCatalogPort,
  type SkillInfo,
} from '../conductor/index.ts';
import { planToTasks } from '../orchestrator/index.ts';
import { QuotaMonitor } from '../quota/monitor.ts';
import { SkillHub } from '../skills/index.ts';
import type { AgentRecord } from '../store/index.ts';
import type { Composition } from './compose.ts';
import { withoutHostCredentials } from './env.ts';
import type { FleetRuntime } from './fleet-port.ts';

export interface ConductorOptions {
  projectId: string;
  /** Carpeta del proyecto (cwd del SDK y raíz de lectura). */
  cwd: string;
  /** Agente Claude cuya clave y URL usa el orquestador (por defecto el primer `claude-sdk` habilitado). */
  agentId?: string;
  /** Tope de la conversación; por defecto lo que queda del presupuesto del agente (si tiene). */
  maxBudgetUsd?: number;
  effort?: ConductorSessionOptions['effort'];
  maxTurns?: number;
  readRoots?: readonly string[];
  notes?: string;
  /** `query` del SDK (pruebas). */
  query?: ConductorQueryFn;
  onStderr?: (line: string) => void;
  log?: (line: string) => void;
  /** Espera máxima de la primera lectura de cupos (va en el prompt de sistema). */
  quotaTimeoutMs?: number;
  /**
   * Modo de la mente (por defecto `plan`: el usuario aprueba con `approve` y la tarea pasa sola a la flota; `delegar`
   * no está disponible). En `auto` las tareas nuevas se aprueban solas y el orquestador las delega.
   */
  mode?: Exclude<MindMode, 'bypass'>;
}

export interface Conductor {
  session: ConductorSession;
  agent: AgentRecord;
  proposals: TaskProposals;
  quotas: QuotaMonitor;
  fleet: FleetRuntime;
  /** Decisión del usuario: aprueba y entrega a la flota en orden de dependencias. */
  approve(taskIds: readonly string[]): Promise<DeliveryReport>;
  close(): Promise<void>;
}

/** PlannerPort de c11 → `planToTasks` de c2 con el `PlannerLlm` de la composición (misma clave y URL). */
export function plannerPort(comp: Pick<Composition, 'plannerLlm'> & Partial<Pick<Composition, 'plans'>>): PlannerPort {
  return {
    async plan(r) {
      const res = await planToTasks(r.planText, comp.plannerLlm, { projectId: r.projectId, knownTaskIds: r.knownTaskIds, ...(r.signal ? { signal: r.signal } : {}) });
      // El plan de la mente acompaña a cada tarea hasta su worktree (.orq/PLAN.md), aunque el usuario no lo vea.
      if (res.ok) comp.plans?.remember({ text: r.planText, tasks: res.tasks });
      return res.ok ? { ok: true, tasks: res.tasks } : { ok: false, issues: res.issues };
    },
  };
}

function conductorAgent(comp: Composition, agentId?: string): AgentRecord {
  if (agentId) return comp.registry.require(agentId);
  const agent = comp.registry.list().find((a) => a.config.kind === 'claude-sdk' && a.config.enabled);
  if (!agent) throw new Error('No hay un agente Claude registrado para el orquestador: usa «node src/core/app/cli.ts agregar-claude».');
  return agent;
}

/** Proyecto de una tarea según la cola de la flota o, si la cola no la tiene, la base. */
export function taskProjectOf(comp: Pick<Composition, 'fleet'> & Partial<Pick<Composition, 'store'>>): (taskId: string) => string | undefined {
  return (taskId) => comp.fleet.queue.get(taskId)?.task.projectId ?? comp.store?.getTask(taskId)?.task.projectId;
}

/**
 * Flota con el proyecto de cada tarea en `status` y `list` (`ProjectTaskStatus`): con él, `estado` y el planificador
 * de la mente solo ven las tareas del proyecto de la sesión. `delegate` y `retry` pasan tal cual.
 */
export function withTaskProjects(port: FleetPort, projectOf: (taskId: string) => string | undefined): FleetPort {
  const tag = (status: FleetTaskStatus): ProjectTaskStatus => {
    const projectId = projectOf(status.taskId);
    return projectId === undefined ? status : { ...status, projectId };
  };
  const retry = port.retry?.bind(port);
  return {
    delegate: (task) => port.delegate(task),
    status: async (taskId) => {
      const status = await port.status(taskId);
      return status && tag(status);
    },
    list: async () => (await port.list()).map(tag),
    ...(retry ? { retry } : {}),
  };
}

/**
 * Skills que ve la mente de un proyecto: las comunes del hub (`installRoot`) y, con `projectDir`, las de
 * `<proyecto>/.agents/skills`. Nunca las de la carpeta donde arrancó el núcleo (`SkillHub` usa `process.cwd()`), que
 * pueden ser de otro proyecto.
 */
export function projectSkillsPort(hub: Pick<SkillHub, 'list' | 'installRoot'>, projectDir?: string): SkillCatalogPort {
  const own = projectDir === undefined ? undefined : new SkillHub({ roots: [join(projectDir, '.agents', 'skills')] });
  return {
    async list(): Promise<SkillInfo[]> {
      const shared = (await hub.list()).filter((s) => s.root === hub.installRoot);
      return own ? [...shared, ...(await own.list())] : shared;
    },
  };
}

/** Lo que la mente nunca lee con Read/Grep/Glob: bóveda de claves, base del núcleo y memoria de todos los proyectos. */
export function mindDenyPaths(comp: Pick<Composition, 'config' | 'memory'>): string[] {
  const db = comp.config.dbPath;
  // La memoria (Obsidian) tiene la de todos los proyectos: se lee solo con `leer_memoria`, acotada al proyecto.
  return [comp.config.vaultPath, db, `${db}-wal`, `${db}-shm`, comp.memory.vaultPath];
}

async function quotaProviders(comp: Composition): Promise<QuotaProvider[]> {
  const out: QuotaProvider[] = [];
  for (const agent of comp.registry.list().filter((a) => a.config.enabled)) {
    const provider = await comp.quotaProviderFactory(agent, await comp.registry.secretsFor(agent.config));
    if (provider) out.push(provider);
  }
  return out;
}

/**
 * Orquestador Claude (c11) conectado a las piezas reales: planificador de c2 con la clave de la bóveda, propuestas en
 * memoria, la flota de la composición (c2 + worktrees de c3), `QuotaMonitor`, `ObsidianMemory` y `SkillHub`. La sesión
 * recibe la clave y la URL del agente Claude desde la bóveda (`env.load`), nunca del entorno del proceso.
 */
export async function createConductor(comp: Composition, opts: ConductorOptions): Promise<Conductor> {
  const log = opts.log ?? (() => undefined);
  const agent = conductorAgent(comp, opts.agentId);
  const env = await comp.env.load(agent.config.id);
  const providers = await quotaProviders(comp);
  const quotas = new QuotaMonitor(providers);
  const firstRead = quotas.refresh().catch((err: unknown) => {
    log(`cupos: falló la primera lectura (${err instanceof Error ? err.message : String(err)})`);
    return [];
  });
  await Promise.race([firstRead, new Promise((r) => setTimeout(r, opts.quotaTimeoutMs ?? 20_000).unref())]);

  // La flota real (c2 + worktrees de c3 + paso de commit), la misma que usa el servidor.
  const fleetPort = await comp.fleet.port();
  const proposals = new TaskProposals();

  const budget = agent.config.budgetUsd;
  const left = budget === undefined ? undefined : budget - comp.spentUsd(agent.config.id) - comp.spentUsd(CONDUCTOR_AGENT_ID);
  if (left !== undefined && left <= 0 && opts.maxBudgetUsd === undefined) {
    quotas.stop();
    throw new Error(`Presupuesto de ${agent.config.id} agotado (${budget} USD).`);
  }
  const maxBudgetUsd = opts.maxBudgetUsd ?? left;

  const mode = opts.mode ?? 'plan';
  const session = new ConductorSession({
    ports: {
      planner: plannerPort(comp),
      proposals,
      // Con el proyecto de cada tarea: `estado` y el planificador solo ven las de este proyecto.
      fleet: withTaskProjects(fleetPort, taskProjectOf(comp)),
      quotas,
      memory: comp.memory,
      skills: projectSkillsPort(comp.skills, opts.cwd),
    },
    projectId: opts.projectId,
    mode,
    autoApprove: (ids) => proposals.approve(ids),
    cwd: opts.cwd,
    denyPaths: mindDenyPaths(comp),
    env,
    baseEnv: withoutHostCredentials(comp.hostEnv()),
    ...(agent.config.model ? { model: agent.config.model } : {}),
    translator: (init) => new ClaudeSdkTranslator(init),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.readRoots ? { readRoots: opts.readRoots } : {}),
    ...(opts.notes ? { notes: opts.notes } : {}),
    ...(opts.query ? { query: opts.query } : {}),
    ...(opts.onStderr ? { onStderr: opts.onStderr } : {}),
  });

  return {
    session,
    agent,
    proposals,
    quotas,
    fleet: fleetPort,
    approve: (taskIds) => approveAndDeliver(proposals, fleetPort, taskIds),
    /** Cierra la conversación; la flota es de la composición (`comp.shutdown()` la detiene). */
    async close() {
      session.close();
      quotas.stop();
    },
  };
}

/** Uso en diferencias (vive en el módulo del orquestador; se reexporta para la terminal y las pruebas). */
export { usageDeltas } from '../conductor/index.ts';

/** Tareas del proyecto con su estado de aprobación (para `/propuestas` en la terminal). */
export function describeProposals(proposals: TaskProposals, projectId?: string): string[] {
  return proposals.list(projectId).map((p) => `${p.task.id}  [${p.approval}]  ${p.task.title}${dependsText(p.task)}`);
}

function dependsText(task: TaskBrief): string {
  return task.dependsOn.length ? `  (depende de ${task.dependsOn.join(', ')})` : '';
}
