/**
 * Memoria del orquestador en una bóveda de Obsidian: notas Markdown con frontmatter YAML y
 * `[[enlaces]]` sesión ↔ proyecto ↔ agente (el grafo de Obsidian los muestra sin plugins).
 *
 *   <bóveda>/Orquestador/Proyectos/<proyecto>/Contexto.md   resumen vivo + bitácora
 *   <bóveda>/Orquestador/Proyectos/<proyecto>/Planes/<id>.md plan general de una o varias tareas (`.orq/PLAN.md`)
 *   <bóveda>/Orquestador/Sesiones/<AAAA-MM-DD>-<tarea>.md    una nota por sesión
 *   <bóveda>/Orquestador/Agentes/<agente>.md                 totales de tokens y costo + historial
 *   <bóveda>/Orquestador/Decisiones/<AAAA-MM-DD>-<tema>.md   decisiones con enlace al proyecto
 *
 * Todo texto pasa por `redactSecrets` antes de escribirse y otra vez antes de salir en un contexto.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { MemoryStore, SessionSummary, TaskBrief } from '../../shared/index.ts';
import { idSchema, redactSecrets } from '../../shared/index.ts';
import { BudgetWriter, measureSavings, rankSessions, truncateText, type SessionCandidate, type TokenSavings } from './context.ts';
import { parseNote, stringifyNote, updateNote, type Frontmatter, type FrontmatterValue } from './frontmatter.ts';
import { appendToSection, demoteHeadings, replaceSection, sectionText, stripComments, withoutHeadingLines, withoutSection } from './markdown.ts';
import { NoteFolder } from './note-folder.ts';
import { assertRealInside, createFileExclusive, resolveInside, safeSegments, writeFileAtomic } from './safe-fs.ts';
import { withVaultLock, type VaultLockOptions } from './vault-lock.ts';

/** Bóveda local de desarrollo (docs/DECISIONES.md); la de OneDrive se elige en la configuración. */
export const DEFAULT_VAULT = 'C:\\dev\\orquestador-memoria';
export const DEFAULT_ROOT_FOLDER = 'Orquestador';

/** Plan de la sesión (lo agrega la flota): nota del plan general y pasos de `.orq/PLAN-TAREA.md` al terminar el turno. */
export const sessionPlanSchema = z.object({
  /** Id de la nota en `Proyectos/<proyecto>/Planes/` (solo si se guardó). */
  id: idSchema.optional(),
  exists: z.boolean().optional(),
  done: z.number().int().nonnegative().optional(),
  pending: z.number().int().nonnegative().optional(),
});
export type SessionPlan = z.infer<typeof sessionPlanSchema>;
/** `SessionSummary` con el plan opcional que entiende `recordSession`. */
export type SessionNoteInput = SessionSummary & { plan?: SessionPlan };

export const sessionSummarySchema = z.object({
  projectId: idSchema,
  taskId: idSchema,
  agentId: idSchema,
  title: z.string().trim().min(1).max(200),
  outcome: z.enum(['ok', 'failed', 'handed_off']),
  summary: z.string().max(100_000),
  filesChanged: z.array(z.string().min(1).max(500)).max(5_000),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().finite().optional(),
  at: z.iso.datetime({ offset: true }),
  plan: sessionPlanSchema.optional(),
}) satisfies z.ZodType<SessionSummary>;

/** Plan general (el texto de `.orq/PLAN.md` sin el aviso para el agente) y las tareas que salen de él. */
export const planNoteSchema = z.object({
  projectId: idSchema,
  /** Id del plan (`plan-…`) o, si la tarea es suelta, el de la tarea: nombre de la nota. */
  planId: idSchema,
  title: z.string().trim().min(1).max(200),
  text: z.string().min(1).max(200_000),
  taskIds: z.array(idSchema).min(1).max(1_000),
  at: z.iso.datetime({ offset: true }),
});
export type PlanNoteInput = z.infer<typeof planNoteSchema>;

export const decisionSchema = z.object({
  projectId: idSchema,
  title: z.string().trim().min(1).max(200),
  text: z.string().min(1).max(100_000),
  at: z.iso.datetime({ offset: true }),
  agentId: idSchema.optional(),
});
export type DecisionInput = z.infer<typeof decisionSchema>;

export interface ObsidianMemoryOptions {
  /** Carpeta de la bóveda (por defecto `C:\dev\orquestador-memoria`). */
  vaultPath?: string;
  /** Carpeta del orquestador dentro de la bóveda. */
  rootFolder?: string;
  /** Secretos conocidos (p. ej. claves cargadas en memoria) que también se tachan. */
  extraSecrets?: readonly string[];
  /** Máximo de caracteres del resumen de cada sesión dentro del contexto. */
  sessionExcerptChars?: number;
  /** Máximo de sesiones en el contexto. */
  maxSessions?: number;
  /** Candado entre procesos de la bóveda (`<bóveda>/.orquestador-candado`); por defecto espera hasta 30 s. */
  lock?: VaultLockOptions;
}

export interface ContextMeasurement {
  context: string;
  savings: TokenSavings;
}

const SUMMARY_HEADING = '## Resumen';
const LOG_HEADING = '## Bitácora';
const SESSIONS_HEADING = '## Sesiones';
const PLAN_HEADING = '## Plan';
const SUMMARY_PLACEHOLDER = '%% Resumen vivo del proyecto: estado, decisiones y rutas clave. Edítalo en Obsidian o con `writeProjectSummary`. %%';

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Texto apto para ir entre comillas invertidas en Markdown. */
const codeSpan = (text: string) => `\`${oneLine(text).replace(/`/g, "'")}\``;

/**
 * Frontmatter de una nota que vamos a actualizar: nunca lanza. Una nota editada a mano con YAML que no
 * entendemos (claves repetidas, `{…}`, líneas raras o `---` sin cierre) no bloquea la memoria; lo que no
 * se entiende se ignora al leer y `updateNote` lo conserva tal cual al escribir.
 */
function forgivingData(text: string): Frontmatter {
  try {
    return parseNote(text, { lenient: true, skipBadLines: true }).data;
  } catch {
    return {};
  }
}

function numberField(data: Frontmatter, key: string): number {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringField(data: Frontmatter, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value : '';
}

/** `actualizado` no retrocede si llega una sesión con fecha anterior (fechas ISO: se comparan como texto). */
function latestDate(data: Frontmatter, date: string): string {
  const prev = stringField(data, 'actualizado');
  return /^\d{4}-\d{2}-\d{2}$/.test(prev) && prev > date ? prev : date;
}

function stringList(value: FrontmatterValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Campos del plan en el frontmatter de la sesión (fuera del resumen: `buildContext` no crece). */
function sessionPlanData(plan: SessionPlan | undefined): Frontmatter {
  if (!plan) return {};
  return {
    ...(plan.id ? { plan: plan.id } : {}),
    ...(plan.exists === undefined ? {} : { plan_tarea: plan.exists }),
    ...(plan.done === undefined ? {} : { plan_pasos_hechos: plan.done }),
    ...(plan.pending === undefined ? {} : { plan_pasos_pendientes: plan.pending }),
  };
}

function slugify(text: string): string {
  const slug = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug.length >= 2 ? slug : 'decision';
}

export class ObsidianMemory implements MemoryStore {
  readonly vaultPath: string;
  readonly rootFolder: string;
  private readonly extraSecrets: readonly string[];
  private readonly excerptChars: number;
  private readonly maxSessions: number;
  private readonly lockOptions: VaultLockOptions;
  private structureReady = false;
  /** Notas de `Sesiones/` ya parseadas (caché por mtime y tamaño): no se reabren en cada encargo. */
  private readonly sessionFolder: NoteFolder;
  /** Serializa las escrituras de esta instancia; entre procesos las protege el candado de la bóveda. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: ObsidianMemoryOptions = {}) {
    this.vaultPath = path.resolve(opts.vaultPath ?? DEFAULT_VAULT);
    // Valida la carpeta raíz desde el principio y la deja con `/`, como la enlaza Obsidian.
    this.rootFolder = safeSegments(opts.rootFolder ?? DEFAULT_ROOT_FOLDER).join('/');
    this.extraSecrets = opts.extraSecrets ?? [];
    this.excerptChars = opts.sessionExcerptChars ?? 400;
    this.maxSessions = opts.maxSessions ?? 8;
    this.lockOptions = opts.lock ?? {};
    this.sessionFolder = new NoteFolder(this.vaultPath, this.sessionsDir());
  }

  // ---------- rutas (relativas a la bóveda, con `/`, tal como las enlaza Obsidian) ----------

  projectNote(projectId: string): string {
    return `${this.rootFolder}/Proyectos/${idSchema.parse(projectId)}/Contexto`;
  }

  agentNote(agentId: string): string {
    return `${this.rootFolder}/Agentes/${idSchema.parse(agentId)}`;
  }

  planNote(projectId: string, planId: string): string {
    return `${this.rootFolder}/Proyectos/${idSchema.parse(projectId)}/Planes/${idSchema.parse(planId)}`;
  }

  private sessionsDir(): string {
    return `${this.rootFolder}/Sesiones`;
  }

  /** Ruta absoluta de una nota (sin `.md`) con la guardia contra `..` y rutas absolutas. */
  private abs(note: string): string {
    return resolveInside(this.vaultPath, `${note}.md`);
  }

  private redact(text: string): string {
    return redactSecrets(text, this.extraSecrets);
  }

  private link(note: string, alias: string): string {
    return `[[${note}|${alias}]]`;
  }

  private async readNote(note: string): Promise<string | null> {
    const file = this.abs(note);
    try {
      await assertRealInside(this.vaultPath, file);
      return await readFile(file, 'utf8');
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  private async writeNote(note: string, text: string): Promise<void> {
    await writeFileAtomic(this.vaultPath, this.abs(note), text);
  }

  /**
   * Lectura-modificación-escritura protegida: primero en cola dentro de esta instancia y luego con un
   * candado entre procesos por bóveda (mkdir atómico; libera candados de procesos muertos). Cubre la
   * elección del nombre de la sesión, Contexto.md, la nota del agente y Decisiones/.
   */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const locked = async () => {
      await mkdir(this.vaultPath, { recursive: true });
      return withVaultLock(path.join(this.vaultPath, '.orquestador-candado'), fn, this.lockOptions);
    };
    const run = this.queue.then(locked, locked);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Crea las carpetas de la estructura (Obsidian muestra también las vacías). Una vez por instancia. */
  async ensureStructure(): Promise<void> {
    if (this.structureReady) return;
    for (const dir of ['Proyectos', 'Sesiones', 'Agentes', 'Decisiones']) {
      const absolute = resolveInside(this.vaultPath, `${this.rootFolder}/${dir}`);
      await mkdir(this.vaultPath, { recursive: true });
      await assertRealInside(this.vaultPath, absolute);
      await mkdir(absolute, { recursive: true });
      await assertRealInside(this.vaultPath, absolute);
    }
    this.structureReady = true;
  }

  // ---------- escritura ----------

  /**
   * Nota de sesión + línea en la bitácora del proyecto + totales del agente, todo bajo el candado de la
   * bóveda. Idempotente para la misma sesión (tarea, agente y hora).
   */
  async recordSession(input: SessionNoteInput): Promise<void> {
    const s = sessionSummarySchema.parse(input);
    await this.exclusive(async () => {
      await this.ensureStructure();
      const date = s.at.slice(0, 10);
      const title = this.redact(oneLine(s.title));
      const totalTokens = s.inputTokens + s.outputTokens;
      const projectLink = this.link(this.projectNote(s.projectId), s.projectId);
      const agentLink = this.link(this.agentNote(s.agentId), s.agentId);
      const files = s.filesChanged.map((f) => this.redact(oneLine(f)));
      const data: Frontmatter = {
        tipo: 'sesion',
        proyecto: s.projectId,
        tarea: s.taskId,
        agente: s.agentId,
        resultado: s.outcome,
        fecha: date,
        at: s.at,
        titulo: title,
        tokens_entrada: s.inputTokens,
        tokens_salida: s.outputTokens,
        tokens_total: totalTokens,
        ...(s.costUsd === undefined ? {} : { costo_usd: round6(s.costUsd) }),
        ...sessionPlanData(s.plan),
        archivos: files,
        tags: ['orquestador/sesion', `proyecto/${s.projectId}`, `agente/${s.agentId}`],
      };
      const cost = s.costUsd === undefined ? 'sin dato' : `${s.costUsd.toFixed(4)} USD`;
      const body = [
        `# ${title}`,
        '',
        `- Proyecto: ${projectLink}`,
        `- Agente: ${agentLink}`,
        `- Tarea: ${codeSpan(s.taskId)} · Resultado: ${s.outcome} · ${s.at}`,
        `- Tokens: ${s.inputTokens} entrada, ${s.outputTokens} salida · Costo: ${cost}`,
        ...this.sessionPlanLines(s.projectId, s.plan),
        '',
        SUMMARY_HEADING,
        demoteHeadings(this.redact(s.summary.trim())) || '(sin resumen)',
        '',
        '## Archivos',
        ...(files.length ? files.map((f) => `- ${codeSpan(f)}`) : ['(ninguno)']),
      ].join('\n');

      for (let attempt = 0; attempt < 20; attempt++) {
        const note = await this.freeSessionNote(date, s);
        if (note === null) return; // ya registrada
        const sessionLink = this.link(note, note.slice(note.lastIndexOf('/') + 1));
        // Se preparan las tres notas antes de escribir: si algo falla, no queda la sesión a medias.
        const projectText = await this.projectWithLog(s.projectId, date, `- ${date} · ${sessionLink} · ${agentLink} · ${s.outcome} · ${title}`);
        const agentText = await this.agentWithTotals(s, date, `- ${date} · ${sessionLink} · ${projectLink} · ${s.outcome} · ${totalTokens} tokens`);
        // Nota nueva creada en exclusiva (`wx`): si otro escritor tomó el nombre primero, se prueba el siguiente sufijo.
        if (!(await createFileExclusive(this.vaultPath, this.abs(note), stringifyNote(data, body)))) continue;
        await this.writeNote(this.projectNote(s.projectId), projectText);
        await this.writeNote(this.agentNote(s.agentId), agentText);
        return;
      }
      throw new Error(`no se pudo reservar un nombre para la sesión de ${s.taskId} el ${date}`);
    });
  }

  /** Nombre libre `<fecha>-<tarea>[-n]`; null si la misma sesión (tarea, agente y hora) ya estaba registrada. */
  private async freeSessionNote(date: string, s: z.infer<typeof sessionSummarySchema>): Promise<string | null> {
    for (let n = 1; n < 1000; n++) {
      const note = `${this.sessionsDir()}/${date}-${s.taskId}${n === 1 ? '' : `-${n}`}`;
      const existing = await this.readNote(note);
      if (existing === null) return note;
      const data = forgivingData(existing);
      if (data.tarea === s.taskId && data.agente === s.agentId && data.at === s.at) return null;
    }
    throw new Error(`demasiadas sesiones de ${s.taskId} el ${date}`);
  }

  private newProjectNote(projectId: string, date: string): string {
    const data: Frontmatter = {
      tipo: 'proyecto',
      proyecto: projectId,
      creado: date,
      actualizado: date,
      sesiones: 0,
      tags: ['orquestador/proyecto'],
    };
    return stringifyNote(data, [`# ${projectId}`, '', SUMMARY_HEADING, SUMMARY_PLACEHOLDER, '', LOG_HEADING].join('\n'));
  }

  /**
   * Texto nuevo de `Contexto.md` con la línea agregada a la bitácora. Se lee en modo tolerante y solo se
   * reescriben `actualizado` y `sesiones`: las demás líneas del frontmatter (del usuario) quedan tal cual.
   */
  private async projectWithLog(projectId: string, date: string, line: string): Promise<string> {
    const text = (await this.readNote(this.projectNote(projectId))) ?? this.newProjectNote(projectId, date);
    const data = forgivingData(text);
    return updateNote(text, { actualizado: latestDate(data, date), sesiones: numberField(data, 'sesiones') + 1 }, (body) => appendToSection(body, LOG_HEADING, line));
  }

  /** Texto nuevo de la nota del agente con los totales sumados; conserva las líneas del usuario. */
  private async agentWithTotals(s: z.infer<typeof sessionSummarySchema>, date: string, line: string): Promise<string> {
    const text = (await this.readNote(this.agentNote(s.agentId))) ?? stringifyNote({ tipo: 'agente', agente: s.agentId }, [`# ${s.agentId}`, '', SESSIONS_HEADING].join('\n'));
    const prev = forgivingData(text);
    const tokensIn = numberField(prev, 'tokens_entrada') + s.inputTokens;
    const tokensOut = numberField(prev, 'tokens_salida') + s.outputTokens;
    const updates: Frontmatter = {
      tipo: 'agente',
      agente: s.agentId,
      sesiones: numberField(prev, 'sesiones') + 1,
      tokens_entrada: tokensIn,
      tokens_salida: tokensOut,
      tokens_total: tokensIn + tokensOut,
      costo_usd: round6(numberField(prev, 'costo_usd') + (s.costUsd ?? 0)),
      actualizado: latestDate(prev, date),
      ...(stringList(prev.tags).length ? {} : { tags: ['orquestador/agente'] }),
    };
    return updateNote(text, updates, (body) => appendToSection(body, SESSIONS_HEADING, line));
  }

  /** Reemplaza la sección «Resumen» de `Contexto.md` (lo que más pesa en cada encargo nuevo). */
  async writeProjectSummary(projectId: string, summary: string, at: string): Promise<void> {
    const id = idSchema.parse(projectId);
    const date = z.iso.datetime({ offset: true }).parse(at).slice(0, 10);
    const content = demoteHeadings(this.redact(summary.trim())) || SUMMARY_PLACEHOLDER;
    await this.exclusive(async () => {
      await this.ensureStructure();
      const note = this.projectNote(id);
      const text = (await this.readNote(note)) ?? this.newProjectNote(id, date);
      const data = forgivingData(text);
      await this.writeNote(note, updateNote(text, { actualizado: latestDate(data, date) }, (body) => replaceSection(body, SUMMARY_HEADING, content)));
    });
  }

  /** Nota en `Decisiones/` enlazada al proyecto (y al agente, si se indica). Devuelve la ruta de la nota. */
  async recordDecision(input: DecisionInput): Promise<string> {
    const d = decisionSchema.parse(input);
    return await this.exclusive(async () => {
      await this.ensureStructure();
      const date = d.at.slice(0, 10);
      const base = `${this.rootFolder}/Decisiones/${date}-${slugify(d.title)}`;
      const title = this.redact(oneLine(d.title));
      const data: Frontmatter = {
        tipo: 'decision',
        proyecto: d.projectId,
        fecha: date,
        at: d.at,
        titulo: title,
        ...(d.agentId ? { agente: d.agentId } : {}),
        tags: ['orquestador/decision', `proyecto/${d.projectId}`],
      };
      const body = [
        `# ${title}`,
        '',
        `- Proyecto: ${this.link(this.projectNote(d.projectId), d.projectId)}`,
        ...(d.agentId ? [`- Agente: ${this.link(this.agentNote(d.agentId), d.agentId)}`] : []),
        '',
        demoteHeadings(this.redact(d.text.trim())),
      ].join('\n');
      for (let n = 1; n < 1000; n++) {
        const note = n === 1 ? base : `${base}-${n}`;
        if (await createFileExclusive(this.vaultPath, this.abs(note), stringifyNote(data, body))) return note;
      }
      throw new Error(`demasiadas decisiones «${d.title}» el ${date}`);
    });
  }

  /**
   * Nota del plan general en `Proyectos/<proyecto>/Planes/<id>.md`, bajo el candado de la bóveda. Idempotente: si
   * ya existe (otra tarea del mismo plan), solo suma sus tareas a `tareas` y actualiza la fecha; el cuerpo, que el
   * usuario puede editar en Obsidian, queda tal cual. Devuelve la ruta de la nota (sin `.md`).
   */
  async recordPlan(input: PlanNoteInput): Promise<string> {
    const p = planNoteSchema.parse(input);
    const note = this.planNote(p.projectId, p.planId);
    return await this.exclusive(async () => {
      await this.ensureStructure();
      const date = p.at.slice(0, 10);
      for (let attempt = 0; attempt < 5; attempt++) {
        const existing = await this.readNote(note);
        if (existing !== null) {
          const data = forgivingData(existing);
          const tasks = [...new Set([...stringList(data.tareas), ...p.taskIds])];
          const tasksLine = `- Tareas: ${tasks.map(codeSpan).join(', ')}`;
          await this.writeNote(note, updateNote(existing, { tareas: tasks, actualizado: latestDate(data, date) }, (body) => body.replace(/^- Tareas: .*$/m, () => tasksLine)));
          return note;
        }
        const title = this.redact(oneLine(p.title));
        const data: Frontmatter = {
          tipo: 'plan',
          proyecto: p.projectId,
          plan: p.planId,
          fecha: date,
          at: p.at,
          actualizado: date,
          titulo: title,
          tareas: [...new Set(p.taskIds)],
          tags: ['orquestador/plan', `proyecto/${p.projectId}`],
        };
        const body = [
          `# ${title}`,
          '',
          `- Proyecto: ${this.link(this.projectNote(p.projectId), p.projectId)}`,
          `- Tareas: ${[...new Set(p.taskIds)].map(codeSpan).join(', ')}`,
          '',
          PLAN_HEADING,
          demoteHeadings(this.redact(p.text.trim())) || '(sin texto)',
        ].join('\n');
        // Creación exclusiva (`wx`): si otro escritor sin candado la creó entre medio, se actualiza la suya.
        if (await createFileExclusive(this.vaultPath, this.abs(note), stringifyNote(data, body))) return note;
      }
      throw new Error(`no se pudo guardar el plan ${p.planId}`);
    });
  }

  /** Línea del plan en la nota de sesión: enlace a la nota del plan y pasos de `.orq/PLAN-TAREA.md`. */
  private sessionPlanLines(projectId: string, plan: SessionPlan | undefined): string[] {
    if (!plan) return [];
    const parts: string[] = [];
    if (plan.id) parts.push(`Plan: ${this.link(this.planNote(projectId, plan.id), plan.id)}`);
    if (plan.exists === false) parts.push('sin `.orq/PLAN-TAREA.md`');
    else if (plan.done !== undefined || plan.pending !== undefined) parts.push(`Pasos de \`.orq/PLAN-TAREA.md\`: ${plan.done ?? 0} hechos, ${plan.pending ?? 0} pendientes`);
    return parts.length ? [`- ${parts.join(' · ')}`] : [];
  }

  // ---------- lectura ----------

  /** Sesiones del proyecto leídas de `Sesiones/` (las notas ilegibles se ignoran). Orden: nombre de nota. */
  async listSessions(projectId: string): Promise<SessionCandidate[]> {
    return (await this.readSessions(projectId)).map(({ candidate }) => candidate);
  }

  /** Notas de sesión del proyecto con su texto (las ilegibles se ignoran). Ver `NoteFolder`. */
  private async readSessions(projectId: string): Promise<{ candidate: SessionCandidate; text: string }[]> {
    const id = idSchema.parse(projectId);
    return (await this.sessionFolder.list())
      .filter(({ data }) => data.tipo === 'sesion' && data.proyecto === id)
      .map(({ name, data, body, text }) => ({
        text,
        candidate: {
          notePath: `${this.sessionsDir()}/${name}`,
          taskId: stringField(data, 'tarea'),
          agentId: stringField(data, 'agente'),
          title: stringField(data, 'titulo') || name,
          outcome: stringField(data, 'resultado'),
          summary: sectionText(body, SUMMARY_HEADING),
          files: stringList(data.archivos),
          at: stringField(data, 'at') || stringField(data, 'fecha'),
        },
      }));
  }

  /** Resumen del proyecto: el cuerpo de `Contexto.md` sin la bitácora ni comentarios. */
  async projectSummary(projectId: string): Promise<string> {
    const text = await this.readNote(this.projectNote(projectId));
    if (text === null) return '';
    let body = text;
    try {
      body = parseNote(text, { lenient: true, skipBadLines: true }).body;
    } catch {
      // `---` sin cierre: Obsidian lo muestra como texto; aquí también.
    }
    return stripComments(withoutHeadingLines(withoutSection(body, LOG_HEADING), SUMMARY_HEADING)).replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * Contexto para un encargo: primero el resumen del proyecto y luego las sesiones pertinentes
   * (misma tarea, archivos dentro de `ownedPaths`, palabras del título; la recencia desempata),
   * sin pasar de `budgetChars`. Determinista y tachado.
   */
  async buildContext(projectId: string, task: TaskBrief, budgetChars: number): Promise<string> {
    const id = idSchema.parse(projectId);
    const budget = Number.isFinite(budgetChars) ? Math.max(0, Math.floor(budgetChars)) : 0;
    if (budget === 0) return '';
    const writer = new BudgetWriter(budget);

    const summary = this.redact(await this.projectSummary(id));
    if (summary) {
      const block = `### Resumen del proyecto ${id}\n${summary}`;
      if (!writer.tryAdd(block)) writer.tryAdd(truncateText(block, writer.remaining()));
    }

    const ranked = rankSessions(await this.listSessions(id), task).slice(0, this.maxSessions);
    let headerAdded = false;
    for (const { session } of ranked) {
      const head = `- ${session.at.slice(0, 10)} · ${session.taskId} · ${session.agentId} · ${session.outcome} — ${this.redact(oneLine(session.title))}`;
      const files = session.files.length ? ` Archivos: ${session.files.slice(0, 6).map((f) => this.redact(f)).join(', ')}${session.files.length > 6 ? '…' : ''}.` : '';
      const ref = ` (${session.notePath})`;
      const excerpt = truncateText(this.redact(oneLine(session.summary)), this.excerptChars);
      const candidates = [
        `${head}. ${excerpt}${files}${ref}`,
        `${head}.${files}${ref}`,
        `${head}${ref}`,
      ];
      for (const item of candidates) {
        const block = headerAdded ? item : `### Sesiones anteriores pertinentes\n${item}`;
        if (writer.tryAdd(block)) { headerAdded = true; break; }
      }
    }

    // Segunda pasada de tachado (por si un secreto quedara partido entre bloques) y tope duro.
    return truncateText(this.redact(writer.toString()), budget);
  }

  /** Historial completo del proyecto (lo que habría que mandar sin memoria): Contexto.md + todas sus sesiones, tachado. */
  async fullHistory(projectId: string): Promise<string> {
    const parts: string[] = [];
    const context = await this.readNote(this.projectNote(projectId));
    if (context !== null) parts.push(context);
    for (const { text } of await this.readSessions(projectId)) parts.push(text);
    // Tachado también aquí: las notas pueden tener claves pegadas a mano en Obsidian.
    return this.redact(parts.join('\n'));
  }

  /** `buildContext` + ahorro estimado de tokens frente al historial completo. */
  async measureContext(projectId: string, task: TaskBrief, budgetChars: number): Promise<ContextMeasurement> {
    const context = await this.buildContext(projectId, task, budgetChars);
    return { context, savings: measureSavings(context, await this.fullHistory(projectId)) };
  }
}
