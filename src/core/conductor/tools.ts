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
import type { ChangesTarget, MindMode, QuotaSnapshot, TaskBrief } from '../../shared/index.ts';
import type { Awaitable, ConductorPorts, FleetTaskStatus, ProposedTask } from './ports.ts';
import { label } from './proposals.ts';
import { redactDeep } from './redact.ts';

export const CONDUCTOR_SERVER_NAME = 'orquestador';
export const CONDUCTOR_TOOL_NAMES = ['crear_tareas', 'delegar', 'estado', 'cupos', 'leer_memoria', 'escribir_memoria', 'buscar_skills'] as const;
export type ConductorToolName = (typeof CONDUCTOR_TOOL_NAMES)[number];

/** Herramientas que necesitan proyecto y flota: no existen en una conversación sin proyecto. */
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
/** Tope de `crear_tareas.destino.remoto` (nombre o URL). */
export const MAX_DESTINATION_CHARS = 2_000;
/** Rama de `destino`: sin espacios, sin «..» ni «//», sin empezar por «-». */
const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}$/;
const MAX_LISTED_TASKS = 40;
const MAX_ISSUES = 10;

/** Nombre con el que el SDK expone la herramienta al modelo (y el que va en `allowedTools`). */
export function mcpToolName(name: ConductorToolName): string {
  return `mcp__${CONDUCTOR_SERVER_NAME}__${name}`;
}

export type ToolResult = Awaited<ReturnType<SdkMcpToolDefinition['handler']>>;
type ToolExtras = NonNullable<Parameters<typeof tool>[4]>;

/**
 * Estado de la flota con el proyecto de su tarea. Los puertos del núcleo lo agregan (`withTaskProjects`, en
 * `app/conductor.ts`): con él, `estado` y el planificador no ven tareas de otro proyecto.
 */
export type ProjectTaskStatus = FleetTaskStatus & { projectId?: string };

/** Proyecto de un estado de la flota, si el puerto lo informa. */
export function statusProject(status: FleetTaskStatus | undefined): string | undefined {
  return status && 'projectId' in status && typeof status.projectId === 'string' ? status.projectId : undefined;
}

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
  /**
   * Guarda el destino de los cambios que el usuario indicó en el plan (`crear_tareas.destino`); `null`: el usuario pidió
   * volver a local. Lo pone quien arma la sesión (el chat) y devuelve el destino resuelto. Se llama solo después de que
   * las tareas quedaron propuestas. Sin él, `destino` no se guarda (la respuesta lo avisa).
   */
  recordDestination?: (input: { projectId: string; destination: DestinationRequest | null }) => Awaitable<ChangesTarget>;
}

/** `crear_tareas.destino`: repositorio donde subir los cambios, tal como lo indicó el usuario. */
export interface DestinationRequest {
  /** Nombre de un remoto de la carpeta (`origin`) o URL del repositorio. */
  remoto: string;
  rama?: string;
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
  const noFleet = (name: ConductorToolName) => fail(`${name} no está disponible en una conversación (sin proyecto ni flota). Sugiere abrir la carpeta como proyecto.`);

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

  /** Guarda el destino de `crear_tareas` y lo resume para la mente; un fallo no deshace las tareas propuestas. */
  async function noteDestination(projectId: string, destino: DestinationRequest | null): Promise<Record<string, unknown>> {
    if (!opts.recordDestination) return { guardado: false, aviso: 'Esta sesión no guarda el destino: los cambios quedan en local.' };
    const destination = destino === null ? null : { remoto: redact(destino.remoto), ...(destino.rama ? { rama: redact(destino.rama) } : {}) };
    try {
      return summarizeTarget(await opts.recordDestination({ projectId, destination }));
    } catch (err) {
      return { guardado: false, aviso: `No se pudo guardar el destino: ${oneLine(err instanceof Error ? err.message : String(err)).slice(0, 300)}` };
    }
  }

  /**
   * Propuestas y tareas de la flota de `projectId`. Una tarea de la flota cuyo proyecto no se conoce solo cuenta si es
   * una propuesta de esta conversación (del mismo proyecto): las demás pueden ser de otro proyecto y no se muestran.
   */
  async function projectTasks(projectId: string): Promise<{ entries: ProposedTask[]; statuses: FleetTaskStatus[] }> {
    const entries = (await ports.proposals.list()).filter((e) => e.task.projectId === projectId);
    const own = new Set(entries.map((e) => e.task.id));
    const statuses = (await ports.fleet.list()).filter((s) => (statusProject(s) ?? (own.has(s.taskId) ? projectId : undefined)) === projectId);
    return { entries, statuses };
  }

  /** Ids que el planificador puede usar en `dependsOn`: solo los del proyecto del plan. */
  async function knownTaskIds(projectId: string): Promise<string[]> {
    const { entries, statuses } = await projectTasks(projectId);
    return [...new Set([...entries.map((e) => e.task.id), ...statuses.map((s) => s.taskId)])].sort();
  }

  /** Proyecto de la sesión para `leer_memoria`/`escribir_memoria`, o el que se pidió. */
  const memoryProject = (proyecto: string | undefined): string | undefined => proyecto ?? defaultProjectId;

  const defs = [
    define(
      'crear_tareas',
      'Convierte un plan de implementación en tareas con rutas propias sin solapes, dependencias y criterios de aceptación. ' +
        'Las tareas quedan PROPUESTAS hasta que el usuario las apruebe (en los modos auto y bypass se aprueban solas). Devuelve la lista resumida. ' +
        'Los cambios quedan en local salvo que el usuario haya indicado un repositorio donde subirlos: entonces va en destino (solo se anota; no se sube nada).',
      {
        plan: z
          .string()
          .trim()
          .min(1)
          .max(MAX_PLAN_CHARS)
          .describe('Plan de implementación completo: objetivo, pasos, rutas propias por tarea, riesgos y verificación. Va íntegro a los agentes.'),
        proyecto: idSchema.optional().describe('Id del proyecto; por omisión, el de la sesión.'),
        destino: z
          .strictObject({
            remoto: z
              .string()
              .trim()
              .min(1)
              .max(MAX_DESTINATION_CHARS)
              .describe('Nombre del remoto de la carpeta (p. ej. origin) o URL del repositorio, tal como lo indicó el usuario.'),
            rama: z.string().trim().regex(BRANCH_NAME).optional().describe('Rama de destino, solo si el usuario la indicó.'),
          })
          .nullable()
          .optional()
          .describe(
            'Repositorio donde subir los cambios: solo si el usuario indicó explícitamente un repositorio donde subir los cambios; si no, omítelo. ' +
              'Un plan sin destino conserva el anterior. null: el usuario pidió explícitamente volver a local.',
          ),
      },
      writes,
      async ({ plan, proyecto, destino }) => {
        if (standalone) return noFleet('crear_tareas');
        const projectId = proyecto ?? defaultProjectId;
        if (!projectId) return fail('falta el proyecto: indícalo en `proyecto`.');
        const result = await ports.planner.plan({ projectId, planText: redact(plan), knownTaskIds: await knownTaskIds(projectId), signal: opts.signal });
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
        // El destino se anota solo con las tareas ya propuestas: un plan que falla no lo cambia.
        const target = destino === undefined ? undefined : await noteDestination(projectId, destino);
        return reply({
          estado: approved === proposed.length ? 'aprobadas' : 'propuestas',
          proyecto: projectId,
          pendientesDeAprobacion: proposed.filter((e) => e.approval === 'proposed').length,
          ...(approved ? { aprobadas: approved, modo: current } : {}),
          tareas: proposed.map((e) => summarizeTask(e.task)),
          ...(target ? { destino: target } : {}),
          siguientePaso: nextStep(current, approved === proposed.length),
        });
      },
    ),
    define(
      'delegar',
      'Entrega a la flota una tarea APROBADA por el usuario (la cola elige agente y worktree). ' +
        'Si la tarea no está aprobada devuelve un error: en ese caso pide la aprobación al usuario. ' +
        'Con una tarea ya delegada que FALLÓ, la reintenta: sigue en su mismo worktree con el último motivo.',
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
          if (entry.approval === 'delegated') {
            // Ya delegada: si falló (también tras reiniciar el núcleo, cuando la cola ya no la tiene), se reintenta.
            const status = await ports.fleet.status(taskId);
            if (ports.fleet.retry && (status === undefined || status.state === 'failed')) {
              const retried = await ports.fleet.retry(taskId);
              if (retried.accepted) {
                return reply({
                  tarea: taskId,
                  aprobacion: 'delegated',
                  reintento: true,
                  motivoAnterior: status?.detail ?? null,
                  estado: retried.state ?? null,
                  agente: retried.agentId ?? null,
                  detalle: retried.detail,
                });
              }
              if (status?.state === 'failed') return fail(`la tarea ${taskId} falló y la flota no pudo reintentarla: ${oneLine(retried.reason)}`);
            }
            const now = status ? ` (estado: ${status.state}${status.detail ? `; ${oneLine(status.detail)}` : ''})` : '';
            return fail(`la tarea ${taskId} ya fue delegada${now}; consulta su avance con estado. Solo se reintenta una tarea fallida.`);
          }
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
      'Estado de una tarea de este proyecto (aprobación, avance en la flota y motivo del último cambio, p. ej. por qué falló) o, sin taskId, ' +
        'resumen de las tareas del proyecto. Solo informa las tareas del proyecto de esta sesión: las de otros proyectos no se muestran.',
      { taskId: idSchema.optional().describe('Id de la tarea; omítelo para ver las tareas del proyecto.') },
      readOnly,
      async ({ taskId }) => {
        if (standalone) return noFleet('estado');
        const scope = defaultProjectId;
        if (taskId !== undefined) {
          const entry = await ports.proposals.get(taskId);
          const status = await ports.fleet.status(taskId);
          if (!entry && !status) return fail(`no existe la tarea ${taskId}.`);
          // Con proyecto de sesión, una tarea de otro proyecto (o de proyecto desconocido) no se informa.
          if (scope !== undefined && (entry?.task.projectId ?? statusProject(status)) !== scope) {
            return fail(`la tarea ${taskId} no es de este proyecto (${scope}): estado solo informa las tareas del proyecto de esta sesión.`);
          }
          return reply({
            tarea: taskId,
            titulo: entry?.task.title ?? null,
            proyecto: entry?.task.projectId ?? statusProject(status) ?? null,
            aprobacion: entry ? entry.approval : null,
            aprobacionTexto: entry ? label(entry.approval) : null,
            estado: status?.state ?? null,
            agente: status?.agentId ?? null,
            actualizado: status?.updatedAt ?? entry?.delegatedAt ?? entry?.decidedAt ?? entry?.proposedAt ?? null,
            detalle: status?.detail ?? null,
            ...(status?.state === 'failed' ? { siguientePaso: 'Falló: el motivo está en detalle. Para reintentarla (sigue en su worktree) usa delegar con su taskId.' } : {}),
          });
        }
        if (scope === undefined) return reply(fleetSummary(await ports.proposals.list(), await ports.fleet.list()));
        const { entries, statuses } = await projectTasks(scope);
        return reply({ proyecto: scope, ...fleetSummary(entries, statuses) });
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
      `Extracto de la memoria de este proyecto (resumen vivo y sesiones pertinentes), con un tope fijo de ${budget} caracteres. ` +
        'Úsala antes de planificar para no repetir contexto. Lee siempre la del proyecto de esta sesión: la de otro proyecto, solo si el usuario la pidió explícitamente.',
      {
        proyecto: idSchema
          .optional()
          .describe('Omítelo: por omisión, el proyecto de esta sesión. Solo si el usuario pidió explícitamente la memoria de otro proyecto, su id.'),
        tarea: idSchema.optional().describe('Id de una tarea propuesta para traer lo pertinente a ella.'),
      },
      readOnly,
      async ({ proyecto, tarea }) => {
        const projectId = memoryProject(proyecto);
        if (!projectId) return fail('falta el proyecto: indícalo en `proyecto`.');
        const foreign = defaultProjectId !== undefined && projectId !== defaultProjectId;
        let brief: TaskBrief;
        if (tarea !== undefined) {
          const entry = await ports.proposals.get(tarea);
          if (!entry) return fail(`no conozco la tarea ${tarea}; omite tarea para leer el contexto general.`);
          if (entry.task.projectId !== projectId) return fail(`la tarea ${tarea} es del proyecto ${entry.task.projectId}, no de ${projectId}.`);
          brief = entry.task;
        } else {
          brief = generalBrief(projectId);
        }
        const context = truncate((await ports.memory.buildContext(projectId, brief, budget)).trim(), budget);
        if (!context) return reply(`Sin memoria guardada para ${projectId}.`);
        const head = foreign
          ? `Memoria de OTRO proyecto (${projectId}), no de este (${defaultProjectId}): úsala solo para lo que pidió el usuario y no la mezcles con las tareas de este proyecto`
          : `Memoria de ${projectId}${tarea ? ` para ${tarea}` : ''}`;
        return reply(`${head} (máx. ${budget} caracteres):\n${context}`);
      },
    ),
    define(
      'escribir_memoria',
      'Guarda en la memoria de este proyecto una decisión (nota nueva con título) o el resumen vivo del proyecto ' +
        '(reemplaza el anterior: incluye todo lo vigente). Breve y sin claves ni secretos. Solo escribe en la memoria del proyecto de esta sesión.',
      {
        proyecto: idSchema.optional().describe('Omítelo: siempre es el proyecto de esta sesión (otro proyecto da error).'),
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
        const projectId = memoryProject(proyecto);
        if (!projectId) return fail('falta el proyecto: indícalo en `proyecto`.');
        if (defaultProjectId !== undefined && projectId !== defaultProjectId) {
          return fail(`solo puedes escribir en la memoria de este proyecto (${defaultProjectId}), no en la de ${projectId}. Omite proyecto; para otro proyecto, el usuario debe abrir un chat de ese proyecto.`);
        }
        const at = now().toISOString();
        if (nota.tipo === 'decision') {
          const notePath = await ports.memory.recordDecision({ projectId, title: redact(nota.titulo), text: redact(nota.texto), at, agentId });
          return reply({ ok: true, tipo: 'decision', proyecto: projectId, nota: notePath });
        }
        await ports.memory.writeProjectSummary(projectId, redact(nota.texto), at);
        return reply({ ok: true, tipo: 'resumen', proyecto: projectId });
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

/** Destino resuelto, en breve para la mente (la URL ya viene saneada). */
function summarizeTarget(target: ChangesTarget): Record<string, unknown> {
  if (target.kind === 'local') {
    return { guardado: true, tipo: 'local', carpeta: target.path, nota: 'Los cambios quedan en la carpeta; no se suben a ningún repositorio.' };
  }
  return {
    guardado: true,
    tipo: 'remoto',
    remoto: target.remote.url || target.remote.name,
    nombre: target.remote.name,
    rama: target.branch,
    configurado: target.configured,
    nota: 'Queda anotado: no se sube nada por ahora y subir siempre necesita la aprobación explícita del usuario.',
    ...(target.configured ? {} : { aviso: 'El remoto no está configurado en la carpeta (git remote): díselo al usuario.' }),
  };
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
