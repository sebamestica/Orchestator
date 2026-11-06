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
import { parseNote, stringifyNote, updateNote, type Frontmatter } from './frontmatter.ts';
import { appendToSection, demoteHeadings, replaceSection, sectionText, stripComments, withoutHeadingLines, withoutSection } from './markdown.ts';
import { NoteFolder } from './note-folder.ts';
import { decisionText, forgivingData, latestDate, linksTo, numberField, slugify, stringField, stringList } from './note-fields.ts';
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

/** Decisión leída de `Decisiones/` para el contexto. */
interface DecisionEntry {
  notePath: string;
  date: string;
  at: string;
  title: string;
  /** Cuerpo sin título ni enlaces. */
  text: string;
  /** Nota entera (para `fullHistory`). */
  note: string;
}

export interface ContextMeasurement {
  context: string;
  savings: TokenSavings;
}

const SUMMARY_HEADING = '## Resumen';
const LOG_HEADING = '## Bitácora';
const SESSIONS_HEADING = '## Sesiones';
const PLAN_HEADING = '## Plan';
/** Decisiones en el contexto y largo de su extracto; de un «Plan: …» basta el título (el texto entero es largo). */
const MAX_DECISIONS = 8;
const DECISION_EXCERPT_CHARS = 300;
const PLAN_TITLE = /^plan\b/i;
const SUMMARY_PLACEHOLDER = '%% Resumen vivo del proyecto: estado, decisiones y rutas clave. Edítalo en Obsidian o con `writeProjectSummary`. %%';

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Texto apto para ir entre comillas invertidas en Markdown. */
const codeSpan = (text: string) => `\`${oneLine(text).replace(/`/g, "'")}\``;

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

export class ObsidianMemory implements MemoryStore {
  readonly vaultPath: string;
  readonly rootFolder: string;
  private readonly extraSecrets: readonly string[];
  private readonly excerptChars: number;
  private readonly maxSessions: number;
  private readonly lockOptions: VaultLockOptions;
  private structureReady = false;
  /** Notas de `Sesiones/` y `Decisiones/` ya parseadas (caché por mtime y tamaño): no se reabren en cada encargo. */
  private readonly sessionFolder: NoteFolder;
  private readonly decisionFolder: NoteFolder;
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
    this.decisionFolder = new NoteFolder(this.vaultPath, this.decisionsDir());
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

  private decisionsDir(): string {
    return `${this.rootFolder}/Decisiones`;
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
   * bóveda. Idempotente para la misma sesión (tarea, agente y hora): cada nota se escribe solo si no tiene ya el
   * enlace a la sesión, así que repetir el registro tras un fallo a medias completa lo que faltó sin duplicar.
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
        const { note, existing } = await this.freeSessionNote(date, s);
        const sessionLink = this.link(note, note.slice(note.lastIndexOf('/') + 1));
        // Se preparan los textos antes de escribir (un fallo de lectura no deja nada escrito). Un fallo de escritura sí
        // puede dejar la sesión a medias: el próximo registro de la misma sesión completa solo la nota que no la enlaza.
        const projectText = await this.projectWithLog(s.projectId, date, note, `- ${date} · ${sessionLink} · ${agentLink} · ${s.outcome} · ${title}`);
        const agentText = await this.agentWithTotals(s, date, note, `- ${date} · ${sessionLink} · ${projectLink} · ${s.outcome} · ${totalTokens} tokens`);
        // Nota nueva creada en exclusiva (`wx`): si otro escritor tomó el nombre primero, se prueba el siguiente sufijo.
        if (!existing && !(await createFileExclusive(this.vaultPath, this.abs(note), stringifyNote(data, body)))) continue;
        if (projectText !== null) await this.writeNote(this.projectNote(s.projectId), projectText);
        if (agentText !== null) await this.writeNote(this.agentNote(s.agentId), agentText);
        return;
      }
      throw new Error(`no se pudo reservar un nombre para la sesión de ${s.taskId} el ${date}`);
    });
  }

  /** Nombre libre `<fecha>-<tarea>[-n]`, o la nota de la misma sesión (tarea, agente y hora) si ya existe. */
  private async freeSessionNote(date: string, s: z.infer<typeof sessionSummarySchema>): Promise<{ note: string; existing: boolean }> {
    for (let n = 1; n < 1000; n++) {
      const note = `${this.sessionsDir()}/${date}-${s.taskId}${n === 1 ? '' : `-${n}`}`;
      const text = await this.readNote(note);
      if (text === null) return { note, existing: false };
      const data = forgivingData(text);
      if (data.tarea === s.taskId && data.agente === s.agentId && data.at === s.at) return { note, existing: true };
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
   * Texto nuevo de `Contexto.md` con la línea agregada a la bitácora, o null si ya enlaza la sesión. Se lee en modo
   * tolerante y solo se reescriben `actualizado` y `sesiones`: las demás líneas del frontmatter (del usuario) quedan tal cual.
   */
  private async projectWithLog(projectId: string, date: string, sessionNote: string, line: string): Promise<string | null> {
    const text = (await this.readNote(this.projectNote(projectId))) ?? this.newProjectNote(projectId, date);
    if (linksTo(text, LOG_HEADING, sessionNote)) return null;
    const data = forgivingData(text);
    return updateNote(text, { actualizado: latestDate(data, date), sesiones: numberField(data, 'sesiones') + 1 }, (body) => appendToSection(body, LOG_HEADING, line));
  }

  /** Texto nuevo de la nota del agente con los totales sumados, o null si ya enlaza la sesión; conserva las líneas del usuario. */
  private async agentWithTotals(s: z.infer<typeof sessionSummarySchema>, date: string, sessionNote: string, line: string): Promise<string | null> {
    const text = (await this.readNote(this.agentNote(s.agentId))) ?? stringifyNote({ tipo: 'agente', agente: s.agentId }, [`# ${s.agentId}`, '', SESSIONS_HEADING].join('\n'));
    if (linksTo(text, SESSIONS_HEADING, sessionNote)) return null;
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
      const base = `${this.decisionsDir()}/${date}-${slugify(d.title)}`;
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

  /** Decisiones del proyecto (`Decisiones/`, también los «Plan: …»), la más reciente primero. */
  private async readDecisions(projectId: string): Promise<DecisionEntry[]> {
    const id = idSchema.parse(projectId);
    return (await this.decisionFolder.list())
      .filter(({ data }) => data.tipo === 'decision' && data.proyecto === id)
      .map(({ name, data, body, text }) => ({
        notePath: `${this.decisionsDir()}/${name}`,
        date: (stringField(data, 'at') || stringField(data, 'fecha')).slice(0, 10),
        at: stringField(data, 'at'),
        title: stringField(data, 'titulo') || name.replace(/\.md$/, ''),
        text: decisionText(body),
        note: text,
      }))
      .sort((a, b) => (b.at > a.at ? 1 : b.at < a.at ? -1 : b.notePath.localeCompare(a.notePath)));
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
   * Contexto para un encargo: primero el resumen del proyecto, luego sus decisiones (reglas vigentes, la más reciente
   * primero; de los planes solo el título) y al final las sesiones pertinentes (misma tarea, archivos dentro de
   * `ownedPaths`, palabras del título; la recencia desempata), sin pasar de `budgetChars`. Determinista y tachado.
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

    this.addDecisions(writer, await this.readDecisions(id));

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

  /** Bloque «Decisiones del proyecto»: una línea por decisión (fecha, título, extracto y ruta), dentro del presupuesto. */
  private addDecisions(writer: BudgetWriter, decisions: readonly DecisionEntry[]): void {
    let headerAdded = false;
    for (const d of decisions.slice(0, MAX_DECISIONS)) {
      const head = `- ${d.date} · ${this.redact(oneLine(d.title))}`;
      const ref = ` (${d.notePath})`;
      const excerpt = PLAN_TITLE.test(d.title) ? '' : truncateText(this.redact(oneLine(d.text)), DECISION_EXCERPT_CHARS);
      const candidates = excerpt ? [`${head}. ${excerpt}${ref}`, `${head}${ref}`] : [`${head}${ref}`];
      for (const item of candidates) {
        const block = headerAdded ? item : `### Decisiones del proyecto\n${item}`;
        if (writer.tryAdd(block)) { headerAdded = true; break; }
      }
    }
  }

  /** Historial completo del proyecto (lo que habría que mandar sin memoria): Contexto.md + decisiones + sesiones, tachado. */
  async fullHistory(projectId: string): Promise<string> {
    const parts: string[] = [];
    const context = await this.readNote(this.projectNote(projectId));
    if (context !== null) parts.push(context);
    for (const { note } of await this.readDecisions(projectId)) parts.push(note);
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
