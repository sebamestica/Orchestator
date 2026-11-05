/**
 * Puertos del orquestador (conductor). Son las únicas dependencias de las herramientas y la sesión:
 * A0 los conecta al integrar con las piezas reales, sin que este módulo las importe.
 *
 *   PlannerPort          ← c2 `planToTasks(planText, llm, opts)` (src/core/orchestrator/plan.ts)
 *   FleetPort            ← c2 `Fleet` / `TaskQueue` + supervisor (src/core/orchestrator)
 *   ProposalStore        ← `TaskProposals` de este módulo (o una versión en SQLite)
 *   QuotaPort            ← `QuotaMonitor` (src/core/quota/monitor.ts): `all()` encaja tal cual
 *   ConductorMemoryPort  ← `ObsidianMemory` (src/core/memory): `buildContext`, `recordDecision`, `writeProjectSummary` encajan tal cual
 *   SkillCatalogPort     ← c8 `SkillHub.list()` (src/core/skills/hub.ts): `SkillEntry` encaja tal cual
 *   SdkMessageTranslator ← c1 `ClaudeSdkTranslator` (src/core/adapters/claude-sdk/translate.ts)
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, MemoryStore, QuotaSnapshot, TaskBrief, TaskState } from '../../shared/index.ts';

export type Awaitable<T> = T | Promise<T>;

// ---------- planificador ----------

export interface PlanIssueInfo {
  code: string;
  message: string;
  taskIds: readonly string[];
}

export type PlannerResult = { ok: true; tasks: readonly TaskBrief[] } | { ok: false; issues: readonly PlanIssueInfo[] };

export interface PlanRequest {
  projectId: string;
  /** Plan en lenguaje natural, ya tachado con `redactSecrets`. */
  planText: string;
  /** Ids de tareas ya existentes (propuestas o en la flota): pueden ir en `dependsOn` y no deben repetirse. */
  knownTaskIds: readonly string[];
  signal?: AbortSignal;
}

/** Convierte un plan en tareas validadas (c2: `planToTasks` con su `PlannerLlm`). */
export interface PlannerPort {
  plan(request: PlanRequest): Promise<PlannerResult>;
}

// ---------- propuestas y aprobación ----------

/**
 * `proposed`: la propuso el orquestador y espera al usuario. `approved`/`rejected`: decidió el usuario.
 * `delegated`: el orquestador ya la entregó a la flota.
 */
export type ApprovalState = 'proposed' | 'approved' | 'rejected' | 'delegated';

export interface ProposedTask {
  task: TaskBrief;
  approval: ApprovalState;
  proposedAt: string;
  decidedAt?: string;
  delegatedAt?: string;
}

/**
 * Lo que el orquestador puede hacer con las propuestas. A propósito **no** incluye aprobar:
 * aprobar es del usuario (UI / API local), nunca de una herramienta del modelo.
 */
export interface ProposalStore {
  /** Registra tareas como `proposed`. Falla si alguna ya está aprobada o delegada. */
  propose(tasks: readonly TaskBrief[]): Awaitable<readonly ProposedTask[]>;
  get(taskId: string): Awaitable<ProposedTask | undefined>;
  list(projectId?: string): Awaitable<readonly ProposedTask[]>;
  /** Pasa de `approved` a `delegated`. Falla en cualquier otro estado. */
  markDelegated(taskId: string): Awaitable<ProposedTask>;
}

// ---------- flota ----------

export interface FleetTaskStatus {
  taskId: string;
  state: TaskState;
  agentId?: string;
  updatedAt?: string;
  detail?: string;
}

export type DelegateResult =
  | { accepted: true; agentId?: string; state?: TaskState; detail?: string }
  | { accepted: false; reason: string };

/** Cola, router y supervisor de la flota (c2). `delegate` encola una tarea aprobada; no espera a que termine. */
export interface FleetPort {
  delegate(task: TaskBrief): Promise<DelegateResult>;
  status(taskId: string): Awaitable<FleetTaskStatus | undefined>;
  list(): Awaitable<readonly FleetTaskStatus[]>;
  /** Reintenta una tarea fallida (también tras reiniciar el núcleo). Sin él, `delegar` no reintenta. */
  retry?(taskId: string): Promise<DelegateResult>;
}

// ---------- cupos, memoria y skills ----------

/** Última foto de cupo por agente (`QuotaMonitor.all()`). */
export interface QuotaPort {
  all(): readonly QuotaSnapshot[];
}

export interface DecisionNote {
  projectId: string;
  title: string;
  text: string;
  at: string;
  agentId?: string;
}

/** Memoria en Obsidian: `MemoryStore.buildContext` más las escrituras que usa el orquestador. */
export interface ConductorMemoryPort extends Pick<MemoryStore, 'buildContext'> {
  /** Nota en `Decisiones/`; devuelve su ruta dentro de la bóveda. */
  recordDecision(input: DecisionNote): Promise<string>;
  /** Reemplaza el resumen vivo del proyecto (`Contexto.md`). */
  writeProjectSummary(projectId: string, summary: string, at: string): Promise<void>;
}

export interface SkillInfo {
  name: string;
  /** Carpeta de la skill (contiene `SKILL.md`). */
  dir: string;
  description?: string;
  /** False si su frontmatter no es válido: no se ofrece. */
  valid?: boolean;
}

export interface SkillCatalogPort {
  list(): Promise<readonly SkillInfo[]>;
}

// ---------- traductor de mensajes del SDK ----------

/** Traduce cada mensaje del SDK a eventos normalizados (c1: `ClaudeSdkTranslator.translate`). */
export interface SdkMessageTranslator {
  translate(message: SDKMessage): readonly AgentEvent[];
}

/** Datos con los que se construye el traductor de una sesión (encaja con `TranslatorOptions` de c1). */
export interface TranslatorInit {
  agentId: string;
  sessionId: string;
  cwd: string;
  /** Valores que el traductor debe tachar además de los patrones de `redactSecrets` (la clave en uso). */
  secrets: readonly string[];
}

// ---------- conjunto ----------

export interface ConductorPorts {
  planner: PlannerPort;
  proposals: ProposalStore;
  fleet: FleetPort;
  quotas: QuotaPort;
  memory: ConductorMemoryPort;
  skills: SkillCatalogPort;
}
