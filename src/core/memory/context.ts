/**
 * Piezas puras de `buildContext`: estimación de tokens, coincidencia de rutas y palabras,
 * puntuación de sesiones y recorte a un presupuesto de caracteres. Todo determinista
 * (sin reloj ni azar): la recencia se mide contra la sesión más nueva, no contra «ahora».
 */

/** Estimación barata de tokens: ≈ 1 token cada 4 caracteres (suficiente para comparar). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface TokenSavings {
  contextChars: number;
  contextTokens: number;
  fullChars: number;
  fullTokens: number;
  savedTokens: number;
  /** Fracción ahorrada frente a mandar el historial completo (0–1). */
  savedRatio: number;
}

export function measureSavings(context: string, fullHistory: string): TokenSavings {
  const contextTokens = estimateTokens(context);
  const fullTokens = estimateTokens(fullHistory);
  const savedTokens = Math.max(0, fullTokens - contextTokens);
  return {
    contextChars: context.length,
    contextTokens,
    fullChars: fullHistory.length,
    fullTokens,
    savedTokens,
    savedRatio: fullTokens === 0 ? 0 : savedTokens / fullTokens,
  };
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

/** Convierte un patrón de `ownedPaths` (`**`, `*`, `?`) en expresión regular. Sin comodines, vale como prefijo de carpeta. */
export function ownedPathMatcher(pattern: string): (file: string) => boolean {
  const normalized = toPosix(pattern.trim()).replace(/\/$/, '');
  if (!/[*?]/.test(normalized)) {
    const lower = normalized.toLowerCase();
    return (file) => {
      const f = toPosix(file).toLowerCase();
      return f === lower || f.startsWith(`${lower}/`);
    };
  }
  let source = '';
  for (let k = 0; k < normalized.length; k++) {
    const ch = normalized[k] ?? '';
    if (ch === '*') {
      if (normalized[k + 1] === '*') {
        const slash = normalized[k + 2] === '/';
        source += slash ? '(?:.*/)?' : '.*';
        k += slash ? 2 : 1;
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const re = new RegExp(`^${source}$`, 'i');
  return (file) => re.test(toPosix(file));
}

const STOPWORDS = new Set([
  'con', 'los', 'las', 'del', 'una', 'uno', 'unos', 'unas', 'por', 'para', 'que', 'sin', 'como', 'mas', 'sus', 'entre',
  'sobre', 'este', 'esta', 'estos', 'estas', 'desde', 'hasta', 'cada', 'todo', 'todos', 'nuevo', 'nueva',
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'new', 'add', 'fix',
]);

/** Palabras significativas: minúsculas, sin tildes, ≥ 3 letras, sin palabras vacías. */
export function significantWords(text: string): Set<string> {
  const words = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
}

export interface SessionCandidate {
  /** Ruta de la nota relativa a la bóveda, con `/`. */
  notePath: string;
  taskId: string;
  agentId: string;
  title: string;
  outcome: string;
  summary: string;
  files: readonly string[];
  /** ISO 8601. */
  at: string;
}

export interface TaskQuery {
  id: string;
  title: string;
  ownedPaths: readonly string[];
}

export interface ScoredSession {
  session: SessionCandidate;
  score: number;
  pathHits: number;
  wordHits: number;
  sameTask: boolean;
}

const DAY_MS = 86_400_000;

/**
 * Puntúa y ordena las sesiones pertinentes. Pertinente = misma tarea, algún archivo dentro de
 * `ownedPaths` o alguna palabra del título en común. La recencia (relativa a la sesión más nueva)
 * solo suma a las pertinentes y desempata. Orden total: puntuación, fecha y ruta de la nota.
 */
export function rankSessions(sessions: readonly SessionCandidate[], task: TaskQuery): ScoredSession[] {
  const matchers = task.ownedPaths.map(ownedPathMatcher);
  const taskWords = significantWords(task.title);
  const times = sessions.map((s) => Date.parse(s.at)).filter((t) => Number.isFinite(t));
  const newest = times.length ? Math.max(...times) : 0;
  const scored: ScoredSession[] = [];
  for (const session of sessions) {
    const sameTask = session.taskId === task.id;
    const pathHits = session.files.filter((f) => matchers.some((m) => m(f))).length;
    const titleWords = significantWords(session.title);
    const summaryWords = significantWords(session.summary);
    let titleHits = 0;
    let summaryHits = 0;
    for (const w of taskWords) {
      if (titleWords.has(w)) titleHits++;
      else if (summaryWords.has(w)) summaryHits++;
    }
    // Tocar los mismos archivos pesa más que compartir palabras: 4 por el primero, +1 por cada otro (máx. 7).
    const pathScore = pathHits > 0 ? 4 + Math.min(pathHits - 1, 3) : 0;
    const relevance = (sameTask ? 10 : 0) + pathScore + titleHits * 2 + summaryHits;
    if (relevance === 0) continue;
    const t = Date.parse(session.at);
    const ageDays = Number.isFinite(t) ? Math.max(0, (newest - t) / DAY_MS) : 365;
    const recency = 2 / (1 + ageDays / 7);
    scored.push({ session, score: relevance + recency, pathHits, wordHits: titleHits + summaryHits, sameTask });
  }
  return scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ta = Date.parse(a.session.at);
    const tb = Date.parse(b.session.at);
    if (ta !== tb) return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0);
    return a.session.notePath < b.session.notePath ? -1 : a.session.notePath > b.session.notePath ? 1 : 0;
  });
}

/** Recorta a `max` caracteres sin partir pares sustitutos y marcando el corte con «…». */
export function truncateText(text: string, max: number): string {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  if (max === 1) return '…';
  let cut = max - 1;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return `${text.slice(0, cut).trimEnd()}…`;
}

/** Acumula bloques separados por salto de línea sin pasar de `budget` caracteres. */
export class BudgetWriter {
  private readonly parts: string[] = [];
  private readonly budget: number;
  private used = 0;

  constructor(budget: number) {
    this.budget = Math.max(0, Math.floor(budget));
  }

  /** Espacio libre para el próximo bloque (descontado el separador). */
  remaining(): number {
    return Math.max(0, this.budget - this.used - (this.parts.length ? 1 : 0));
  }

  /** Agrega el bloque solo si cabe entero. */
  tryAdd(block: string): boolean {
    if (block === '' || block.length > this.remaining()) return false;
    this.used += block.length + (this.parts.length ? 1 : 0);
    this.parts.push(block);
    return true;
  }

  get isEmpty(): boolean {
    return this.parts.length === 0;
  }

  toString(): string {
    return this.parts.join('\n');
  }
}
