/**
 * Herramientas propias del orquestador: un servidor MCP en proceso (`createSdkMcpServer`) con las siete
 * herramientas de PLAN.md §4.4.6. Toda entrada se valida con Zod (también dentro del manejador: el modelo
 * es una fuente externa) y toda salida es breve y pasa por `redactSecrets`.
 */
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { idSchema, minRemainingFraction, quotaSnapshotSchema, redactSecrets, taskBriefSchema } from '../../shared/index.ts';
import type { MindMode, QuotaSnapshot, TaskBrief } from '../../shared/index.ts';
import type { Awaitable, ConductorPorts, FleetTaskStatus, ProposedTask } from './ports.ts';
import { label } from './proposals.ts';
import { redactDeep } from './redact.ts';

export const CONDUCTOR_SERVER_NAME = 'orquestador';
export const CONDUCTOR_TOOL_NAMES = ['crear_tareas', 'delegar', 'estado', 'cupos', 'leer_memoria', 'escribir_memoria', 'buscar_skills'] as const;
export type ConductorToolName = (typeof CONDUCTOR_TOOL_NAMES)[number];

/** Herramientas que necesitan proyecto y flota: no existen para un agente suelto. */
export const FLEET_TOOL_NAMES: readonly ConductorToolName[] = ['crear_tareas', 'delegar', 'estado', 'escribir_memoria'];
/** Tope del plan de implementación que recibe `crear_tareas` (llega íntegro al planificador). */
export const MAX_PLAN_CHARS = 100_000;
/** Tope de una decisión de memoria (cabe un plan de implementación completo). */
export const MAX_DECISION_CHARS = 20_000;
/** Presupuesto fijo de `leer_memoria` (caracteres): el modelo no lo elige. */
export const MEMORY_BUDGET_CHARS = 4_000;
/** Tope de cualquier salida de herramienta. */
export const MAX_OUTPUT_CHARS = 8_000;
export const MAX_SKILLS = 5;
const MAX_LISTED_TASKS = 40;
const MAX_ISSUES = 10;

/** Nombre con el que el SDK expone la herramienta al modelo (y el que va en `allowedTools`). */
export function mcpToolName(name: ConductorToolName): string {
  return `mcp__${CONDUCTOR_SERVER_NAME}__${name}`;
}

export type ToolResult = Awaited<ReturnType<SdkMcpToolDefinition['handler']>>;
type ToolExtras = NonNullable<Parameters<typeof tool>[4]>;

export interface ConductorToolsOptions {
  /** Proyecto por omisión de `crear_tareas` (el de la sesión). */
  defaultProjectId?: string;
  /** Autor de las decisiones que escribe el orquestador. */
  agentId?: string;
  /** Valores que también se tachan en las salidas (p. ej. la clave en uso). */
  secrets?: readonly string[] | (() => readonly string[]);
  now?: () => Date;
  memoryBudgetChars?: number;
  /** Cancela llamadas largas (el planificador). */
  signal?: AbortSignal;
  /**
   * Modo de la mente, leído en cada llamada. `plan`: `delegar` no está disponible (el usuario aprueba y la tarea pasa
   * sola a la flota). `auto`/`bypass`: las tareas nuevas se aprueban con `autoApprove`. Sin modo: comportamiento de la
   * terminal antigua (el usuario aprueba y el orquestador delega).
   */
  mode?: () => MindMode | undefined;
  /**
   * Aprobación automática de los modos `auto` y `bypass` (el usuario la autorizó al elegir el modo). No es una
   * herramienta del modelo: la pone quien arma la sesión.
   */
  autoApprove?: (taskIds: readonly string[]) => Awaitable<readonly ProposedTask[]>;
  /** Agente suelto: sin proyecto ni flota (crear_tareas, delegar, estado y escribir_memoria fallan). */
  standalone?: boolean;
}

export interface ConductorTools {
  /** Servidor MCP en proceso para `Options.mcpServers`. */
  server: McpSdkServerConfigWithInstance;
  serverName: string;
  /** Nombres completos (`mcp__orquestador__…`) para `allowedTools`. */
  allowedTools: readonly string[];
  /** Llama al manejador directamente (pruebas y flujos guionados); misma validación que vía MCP. */
  call(name: ConductorToolName, args: unknown): Promise<ToolResult>;
}

export function createConductorTools(ports: ConductorPorts, opts: ConductorToolsOptions = {}): ConductorTools {
  const now = opts.now ?? (() => new Date());
  const agentId = idSchema.parse(opts.agentId ?? 'orquestador');
  const defaultProjectId = opts.defaultProjectId === undefined ? undefined : idSchema.parse(opts.defaultProjectId);
  const budget = z.number().int().positive().max(100_000).parse(opts.memoryBudgetChars ?? MEMORY_BUDGET_CHARS);
  const secrets = (): readonly string[] => (typeof opts.secrets === 'function' ? opts.secrets() : (opts.secrets ?? []));
  const redact = (text: string) => redactSecrets(text, secrets());
  const out = (text: string) => truncate(redact(text), MAX_OUTPUT_CHARS);
  const reply = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: out(typeof value === 'string' ? value : JSON.stringify(value)) }] });
  const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: out(`Error: ${message}`) }], isError: true });
  /** Tareas en vuelo de `delegar`: dos llamadas paralelas no delegan dos veces. */
  const delegating = new Set<string>();
  const mode = (): MindMode | undefined => opts.mode?.();
  const standalone = opts.standalone === true;
  const noFleet = (name: ConductorToolName) => fail(`${name} no está disponible para un agente suelto (sin proyecto ni flota). Sugiere abrir la carpeta como proyecto.`);

  function define<S extends z.ZodRawShape>(
    name: ConductorToolName,
    description: string,
    shape: S,
    annotations: ToolExtras['annotations'],
    run: (input: z.output<z.ZodObject<S, z.core.$strict>>) => Promise<ToolResult>,
  ) {
    const schema = z.strictObject(shape);
    const invoke = async (args: unknown): Promise<ToolResult> => {
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) return fail(`entrada inválida para ${name}: ${oneLine(z.prettifyError(parsed.error))}`);
      try {
        return await run(parsed.data);
      } catch (err) {
        return fail(`${name} falló: ${oneLine(err instanceof Error ? err.message : String(err)).slice(0, 400)}`);
      }
    };
    return { name, invoke, definition: tool(name, description, shape, (args) => invoke(args), { annotations }) };
  }

  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

  async function knownTaskIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const e of await ports.proposals.list()) ids.add(e.task.id);
    for (const s of await ports.fleet.list()) ids.add(s.taskId);
    return [...ids].sort();
  }

  const defs = [
    define(
      'crear_tareas',
      'Convierte un plan de implementación en tareas con rutas propias sin solapes, dependencias y criterios de aceptación. ' +
        'Las tareas quedan PROPUESTAS hasta que el usuario las apruebe (en los modos auto y bypass se aprueban solas). Devuelve la lista resumida.',
      {
        plan: z
          .string()
          .trim()
          .min(1)
          .max(MAX_PLAN_CHARS)
          .describe('Plan de implementación completo: objetivo, pasos, rutas propias por tarea, riesgos y verificación. Va íntegro a los agentes.'),
        proyecto: idSchema.optional().describe('Id del proyecto; por omisión, el de la sesión.'),
      },
      writes,
      async ({ plan, proyecto }) => {
        if (standalone) return noFleet('crear_tareas');
        const projectId = proyecto ?? defaultProjectId;
        if (!projectId) return fail('falta el proyecto: indícalo en `proyecto`.');
        const result = await ports.planner.plan({ projectId, planText: redact(plan), knownTaskIds: await knownTaskIds(), signal: opts.signal });
        if (!result.ok) {
          const issues = result.issues.slice(0, MAX_ISSUES).map((i) => ({ codigo: i.code, mensaje: oneLine(i.message), tareas: i.taskIds }));
          return fail(`el planificador no pudo convertir el plan en tareas válidas: ${JSON.stringify(issues)}. Ajusta el plan y vuelve a intentarlo.`);
        }
        // Lo que devuelve el planificador es externo: se valida y se tacha antes de guardarlo.
        const tasks = z.array(taskBriefSchema).min(1).parse(redactDeep(result.tasks, secrets()));
        const foreign = tasks.filter((t) => t.projectId !== projectId).map((t) => t.id);
        if (foreign.length) return fail(`el planificador devolvió tareas de otro proyecto: ${foreign.join(', ')}`);
        let proposed = await ports.proposals.propose(tasks);
        const current = mode();
        if ((current === 'auto' || current === 'bypass') && opts.autoApprove) proposed = await opts.autoApprove(proposed.map((e) => e.task.id));
        const approved = proposed.filter((e) => e.approval === 'approved').length;
        return reply({
          estado: approved === proposed.length ? 'aprobadas' : 'propuestas',
          proyecto: projectId,
          pendientesDeAprobacion: proposed.filter((e) => e.approval === 'proposed').length,
          ...(approved ? { aprobadas: approved, modo: current } : {}),
          tareas: proposed.map((e) => summarizeTask(e.task)),
          siguientePaso: nextStep(current, approved === proposed.length),
        });
      },
    ),
    define(
      'delegar',
      'Entrega a la flota una tarea APROBADA por el usuario (la cola elige agente y worktree). ' +
        'Si la tarea no está aprobada devuelve un error: en ese caso pide la aprobación al usuario.',
      { taskId: idSchema.describe('Id de la tarea aprobada.') },
      writes,
      async ({ taskId }) => {
        if (standalone) return noFleet('delegar');
        if (mode() === 'plan') {
          return fail('delegar no está disponible en modo plan: cuando el usuario aprueba una tarea en la interfaz, pasa sola a la flota. Pídele que la apruebe.');
        }
        if (delegating.has(taskId)) return fail(`la tarea ${taskId} ya se está delegando.`);
        delegating.add(taskId);
        try {
          const entry = await ports.proposals.get(taskId);
          if (!entry) return fail(`no existe la tarea ${taskId}. Créala con crear_tareas y espera la aprobación del usuario.`);
          if (entry.approval === 'proposed') {
            return fail(`la tarea ${taskId} no está aprobada: está propuesta y espera la aprobación del usuario. Pídele que la revise y la apruebe; tú no puedes aprobarla.`);
          }
          if (entry.approval === 'rejected') return fail(`la tarea ${taskId} no está aprobada: el usuario la rechazó. No la delegues; propón otra si hace falta.`);
          if (entry.approval === 'delegated') return fail(`la tarea ${taskId} ya fue delegada; consulta su avance con estado.`);
          const missing: string[] = [];
          for (const dep of entry.task.dependsOn) {
            const depEntry = await ports.proposals.get(dep);
            if (depEntry?.approval === 'delegated') continue;
            if (await ports.fleet.status(dep)) continue;
            missing.push(dep);
          }
          if (missing.length) return fail(`antes de ${taskId} delega sus dependencias: ${missing.join(', ')}.`);
          const result = await ports.fleet.delegate(entry.task);
          if (!result.accepted) return fail(`la flota no aceptó la tarea ${taskId}: ${oneLine(result.reason)}`);
          await ports.proposals.markDelegated(taskId);
          return reply({ tarea: taskId, aprobacion: 'delegated', estado: result.state ?? null, agente: result.agentId ?? null, detalle: result.detail });
        } finally {
          delegating.delete(taskId);
        }
      },
    ),
    define(
      'estado',
      'Estado de una tarea (aprobación y avance en la flota) o, sin taskId, resumen de toda la flota.',
      { taskId: idSchema.optional().describe('Id de la tarea; omítelo para ver la flota completa.') },
      readOnly,
      async ({ taskId }) => {
        if (standalone) return noFleet('estado');
        if (taskId !== undefined) {
          const entry = await ports.proposals.get(taskId);
          const status = await ports.fleet.status(taskId);
          if (!entry && !status) return fail(`no existe la tarea ${taskId}.`);
          return reply({
            tarea: taskId,
            titulo: entry?.task.title ?? null,
            proyecto: entry?.task.projectId ?? null,
            aprobacion: entry ? entry.approval : null,
            aprobacionTexto: entry ? label(entry.approval) : null,
            estado: status?.state ?? null,
            agente: status?.agentId ?? null,
            actualizado: status?.updatedAt ?? entry?.delegatedAt ?? entry?.decidedAt ?? entry?.proposedAt ?? null,
            detalle: status?.detail,
          });
        }
        return reply(fleetSummary(await ports.proposals.list(), await ports.fleet.list()));
      },
    ),
    define(
      'cupos',
      'Última lectura de cupo por agente: % restante (la ventana que limita primero) y hora de reinicio.',
      {},
      readOnly,
      async () => {
        const agents = ports.quotas.all().map(summarizeQuota);
        return reply(agents.length ? { agentes: agents } : { agentes: [], aviso: 'Todavía no hay lecturas de cupo.' });
      },
    ),
    define(
      'leer_memoria',
      `Extracto de la memoria del proyecto (resumen vivo y sesiones pertinentes), con un tope fijo de ${budget} caracteres. ` +
        'Úsala antes de planificar para no repetir contexto.',
      {
        proyecto: idSchema.describe('Id del proyecto.'),
        tarea: idSchema.optional().describe('Id de una tarea propuesta para traer lo pertinente a ella.'),
      },
      readOnly,
      async ({ proyecto, tarea }) => {
        let brief: TaskBrief;
        if (tarea !== undefined) {
          const entry = await ports.proposals.get(tarea);
          if (!entry) return fail(`no conozco la tarea ${tarea}; omite tarea para leer el contexto general.`);
          if (entry.task.projectId !== proyecto) return fail(`la tarea ${tarea} es del proyecto ${entry.task.projectId}, no de ${proyecto}.`);
          brief = entry.task;
        } else {
          brief = generalBrief(proyecto);
        }
        const context = truncate((await ports.memory.buildContext(proyecto, brief, budget)).trim(), budget);
        if (!context) return reply(`Sin memoria guardada para ${proyecto}.`);
        return reply(`Memoria de ${proyecto}${tarea ? ` para ${tarea}` : ''} (máx. ${budget} caracteres):\n${context}`);
      },
    ),
    define(
      'escribir_memoria',
      'Guarda en la memoria del proyecto una decisión (nota nueva con título) o el resumen vivo del proyecto ' +
        '(reemplaza el anterior: incluye todo lo vigente). Breve y sin claves ni secretos.',
      {
        proyecto: idSchema.describe('Id del proyecto.'),
        nota: z
          .discriminatedUnion('tipo', [
            z.strictObject({
              tipo: z.literal('decision'),
              titulo: z.string().trim().min(1).max(200),
              texto: z.string().trim().min(1).max(MAX_DECISION_CHARS),
            }),
            z.strictObject({ tipo: z.literal('resumen'), texto: z.string().trim().min(1).max(8_000) }),
          ])
          .describe('Decisión { tipo: "decision", titulo, texto } o resumen { tipo: "resumen", texto }.'),
      },
      writes,
      async ({ proyecto, nota }) => {
        if (standalone) return noFleet('escribir_memoria');
        const at = now().toISOString();
        if (nota.tipo === 'decision') {
          const notePath = await ports.memory.recordDecision({ projectId: proyecto, title: redact(nota.titulo), text: redact(nota.texto), at, agentId });
          return reply({ ok: true, tipo: 'decision', proyecto, nota: notePath });
        }
        await ports.memory.writeProjectSummary(proyecto, redact(nota.texto), at);
        return reply({ ok: true, tipo: 'resumen', proyecto });
      },
    ),
    define(
      'buscar_skills',
      `Busca skills pertinentes por palabras clave. Devuelve hasta ${MAX_SKILLS} nombres y rutas de SKILL.md, sin su contenido: ` +
        'cita la ruta en el encargo (skillRefs) y ábrela solo si la necesitas.',
      { texto: z.string().trim().min(2).max(300).describe('Palabras clave de lo que se necesita.') },
      readOnly,
      async ({ texto }) => {
        const terms = keywords(texto);
        if (!terms.length) return fail('escribe palabras clave más específicas.');
        const seen = new Set<string>();
        const ranked: { name: string; dir: string; description: string; score: number }[] = [];
        for (const skill of await ports.skills.list()) {
          if (skill.valid === false || seen.has(skill.name)) continue;
          seen.add(skill.name);
          const name = normalize(skill.name);
          const description = normalize(skill.description ?? '');
          let score = 0;
          for (const term of terms) {
            if (name.includes(term)) score += 3;
            if (description.includes(term)) score += 1;
          }
          if (score > 0) ranked.push({ name: skill.name, dir: skill.dir, description: skill.description ?? '', score });
        }
        ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
        const skills = ranked.slice(0, MAX_SKILLS).map((s) => ({
          nombre: s.name,
          ruta: path.join(s.dir, 'SKILL.md'),
          ...(s.description ? { descripcion: truncate(oneLine(s.description), 160) } : {}),
        }));
        return reply(skills.length ? { skills } : { skills: [], aviso: 'Ninguna skill coincide.' });
      },
    ),
  ];

  const server = createSdkMcpServer({
    name: CONDUCTOR_SERVER_NAME,
    version: '0.1.0',
    // Siempre en el prompt (no diferidas tras la búsqueda de herramientas) y en orden fijo: prefijo cacheable.
    alwaysLoad: true,
    tools: defs.map((d) => d.definition),
  });
  const handlers = new Map(defs.map((d) => [d.name, d.invoke] as const));

  return {
    server,
    serverName: CONDUCTOR_SERVER_NAME,
    allowedTools: CONDUCTOR_TOOL_NAMES.map(mcpToolName),
    call: (name, args) => {
      const handler = handlers.get(name);
      return handler ? handler(args) : Promise.resolve(fail(`herramienta desconocida: ${String(name)}`));
    },
  };
}

// ---------- piezas puras ----------

function nextStep(mode: MindMode | undefined, allApproved: boolean): string {
  if (allApproved) return `Quedaron aprobadas (modo ${mode ?? 'auto'}): delégalas con delegar, primero las dependencias, e informa al usuario.`;
  if (mode === 'plan') return 'Muestra estas tareas al usuario y pide su aprobación: al aprobarlas pasan solas a la flota. No intentes aprobarlas ni delegarlas tú.';
  return 'Muestra estas tareas al usuario y espera su aprobación. No las delegues antes ni intentes aprobarlas tú.';
}

function summarizeTask(task: TaskBrief) {
  return {
    id: task.id,
    titulo: task.title,
    dificultad: task.difficulty,
    agenteSugerido: task.suggestedAgent ?? null,
    dependeDe: task.dependsOn,
    rutas: task.ownedPaths.slice(0, 8),
    criterios: task.acceptance.length,
  };
}

function fleetSummary(entries: readonly ProposedTask[], statuses: readonly FleetTaskStatus[]) {
  const byId = new Map<string, { id: string; aprobacion: string | null; estado: string | null; agente: string | null }>();
  for (const e of entries) byId.set(e.task.id, { id: e.task.id, aprobacion: e.approval, estado: null, agente: null });
  for (const s of statuses) {
    const row = byId.get(s.taskId) ?? { id: s.taskId, aprobacion: null, estado: null, agente: null };
    row.estado = s.state;
    row.agente = s.agentId ?? null;
    byId.set(s.taskId, row);
  }
  const rows = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const count = (key: 'aprobacion' | 'estado') => {
    const out: Record<string, number> = {};
    for (const r of rows) {
      const k = r[key];
      if (k !== null) out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  return {
    total: rows.length,
    porAprobacion: count('aprobacion'),
    porEstado: count('estado'),
    tareas: rows.slice(0, MAX_LISTED_TASKS),
    ...(rows.length > MAX_LISTED_TASKS ? { omitidas: rows.length - MAX_LISTED_TASKS } : {}),
  };
}

function pct(fraction: number | null): number | null {
  return fraction === null ? null : Math.round(fraction * 1000) / 10;
}

function summarizeQuota(raw: QuotaSnapshot) {
  const parsed = quotaSnapshotSchema.safeParse(raw);
  if (!parsed.success) return { agente: String((raw as { agentId?: unknown }).agentId ?? 'desconocido'), error: 'lectura de cupo inválida' };
  const s = parsed.data;
  const min = minRemainingFraction(s);
  const limiting = s.buckets
    .filter((b) => b.remainingFraction !== null && b.remainingFraction === min)
    .map((b) => b.resetAt)
    .filter((r): r is string => r !== undefined)
    .sort()[0];
  return {
    agente: s.agentId,
    restantePct: pct(min),
    reinicio: limiting ?? null,
    ventanas: s.buckets.map((b) => ({ grupo: b.groupName, ventana: b.window, restantePct: pct(b.remainingFraction), reinicio: b.resetAt ?? null })),
    leido: s.takenAt,
    desactualizado: s.stale,
    ...(s.error !== undefined ? { error: oneLine(s.error).slice(0, 200) } : {}),
  };
}

/** Encargo genérico para pedir el contexto del proyecto sin una tarea concreta. */
function generalBrief(projectId: string): TaskBrief {
  return taskBriefSchema.parse({
    id: 'contexto-general',
    projectId,
    title: 'Contexto general del proyecto',
    objective: 'Contexto general para planificar.',
    ownedPaths: ['.'],
    dependsOn: [],
    acceptance: ['Contexto vigente del proyecto'],
    difficulty: 'low',
  });
}

const STOPWORDS = new Set(['con', 'del', 'las', 'los', 'para', 'por', 'que', 'una', 'uno', 'unos', 'unas', 'the', 'and', 'for', 'with', 'como', 'sobre']);

function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function keywords(text: string): string[] {
  return [...new Set(normalize(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
