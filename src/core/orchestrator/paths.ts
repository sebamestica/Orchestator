/**
 * Rutas propias (`ownedPaths`) y detección de solapes entre tareas.
 *
 * Semántica (conservadora: ante la duda, hay solape):
 * - Rutas relativas al repo, con `/` o `\`. `./` inicial y `/` final se ignoran.
 * - Una ruta sin comodines es un archivo o una carpeta con todo su contenido (`src/a` ≡ `src/a/**`).
 * - Globs: `*` y `?` dentro de un segmento, `**` para cero o más segmentos, `{a,b}` alternativas,
 *   `[...]` cuenta como un carácter cualquiera. Todo patrón posee también lo que haya debajo
 *   de lo que coincide (`src/*` posee `src/x/y.ts`).
 * - Extglobs (`@(a|b)`, `+(…)`, `!(…)`, `*(…)`, `?(…)`): no soportados. `ownedPathProblem` los rechaza y,
 *   si llegan igual a `pathsOverlap`, cada grupo cuenta como `*` (solape conservador).
 * - Sin distinguir mayúsculas (Windows).
 */

type Token = { t: 'star' } | { t: 'any' } | { t: 'lit'; c: string };
type Segment = { globstar: true } | { globstar: false; tokens: Token[] };

const MAX_BRACE_EXPANSIONS = 64;

const EXTGLOB = /[@+!*?]\(/;

/** Normaliza: barras `/`, sin segmentos `.` (inicio, medio o final), sin barras repetidas ni final. `.` → `` (todo el repo). */
export function normalizeOwnedPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}

/** Devuelve el problema de una ruta propia, o `undefined` si es válida. */
export function ownedPathProblem(path: string): string | undefined {
  const raw = path.trim();
  if (!raw) return 'ruta vacía';
  if (raw.startsWith('!')) return `«${path}»: no se admiten negaciones; lista solo lo que la tarea modifica`;
  if (/^[A-Za-z]:/.test(raw) || raw.startsWith('/') || raw.startsWith('\\')) return `«${path}»: debe ser relativa a la raíz del repo`;
  const segments = normalizeOwnedPath(raw).split('/');
  if (segments.includes('..')) return `«${path}»: no puede salir del repo con «..»`;
  if (EXTGLOB.test(raw)) return `«${path}»: extglob no soportado (@(…), +(…), !(…), *(…), ?(…)); usa {a,b} o lista las rutas`;
  return undefined;
}

/** True si existe algún archivo que ambas rutas/globs poseerían. */
export function pathsOverlap(a: string, b: string): boolean {
  const left = expandBraces(normalizeOwnedPath(a)).map(compile);
  const right = expandBraces(normalizeOwnedPath(b)).map(compile);
  return left.some((x) => right.some((y) => patternsIntersect(x, y)));
}

export interface PathOverlap {
  taskA: string;
  pathA: string;
  taskB: string;
  pathB: string;
}

/** Solapes entre rutas de tareas distintas (cada par se informa una vez). */
export function findOverlaps(tasks: readonly { id: string; ownedPaths: readonly string[] }[]): PathOverlap[] {
  const out: PathOverlap[] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      if (!a || !b || a.id === b.id) continue;
      for (const pathA of a.ownedPaths) {
        for (const pathB of b.ownedPaths) {
          if (pathsOverlap(pathA, pathB)) out.push({ taskA: a.id, pathA, taskB: b.id, pathB });
        }
      }
    }
  }
  return out;
}

/** Expande `{a,b}` (anidadas incluidas). Si hay demasiadas variantes, recurre al prefijo fijo + `**`. */
function expandBraces(pattern: string): string[] {
  const out: string[] = [];
  const pending = [pattern];
  while (pending.length) {
    const current = pending.pop();
    if (current === undefined) break;
    const group = firstBraceGroup(current);
    if (!group) {
      out.push(current);
    } else {
      for (const alt of group.alternatives) pending.push(current.slice(0, group.start) + alt + current.slice(group.end + 1));
    }
    if (out.length + pending.length > MAX_BRACE_EXPANSIONS) return [staticPrefix(pattern)];
  }
  return out;
}

function firstBraceGroup(s: string): { start: number; end: number; alternatives: string[] } | undefined {
  for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
    let depth = 0;
    let last = start + 1;
    const alternatives: string[] = [];
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          alternatives.push(s.slice(last, i));
          if (alternatives.length > 1) return { start, end: i, alternatives };
          break;
        }
      } else if (ch === ',' && depth === 1) {
        alternatives.push(s.slice(last, i));
        last = i + 1;
      }
    }
  }
  return undefined;
}

/** Segmentos antes del primer comodín, seguidos de `**`. */
function staticPrefix(pattern: string): string {
  const fixed: string[] = [];
  for (const seg of pattern.split('/')) {
    if (/[*?[\]{}]/.test(seg)) break;
    fixed.push(seg);
  }
  return [...fixed, '**'].join('/');
}

function compile(pattern: string): Segment[] {
  const segments: Segment[] = pattern
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (s === '**' ? { globstar: true } : { globstar: false, tokens: tokenize(s) }));
  // Cada patrón posee también el contenido de lo que coincide.
  if (!segments.at(-1)?.globstar) segments.push({ globstar: true });
  return segments;
}

function tokenize(segment: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < segment.length; i++) {
    const ch = segment.charAt(i);
    const extglobEnd = '@+!*?'.includes(ch) && segment.charAt(i + 1) === '(' ? closingParen(segment, i + 1) : -1;
    if (extglobEnd !== -1) {
      // Extglob: no se interpreta; cuenta como `*` para no dar por disjunto lo que podría solaparse.
      if (out.at(-1)?.t !== 'star') out.push({ t: 'star' });
      i = extglobEnd;
    } else if (ch === '*') {
      if (out.at(-1)?.t !== 'star') out.push({ t: 'star' });
    } else if (ch === '?') {
      out.push({ t: 'any' });
    } else if (ch === '[') {
      const close = segment.indexOf(']', i + 2);
      if (close === -1) {
        out.push({ t: 'lit', c: ch });
      } else {
        out.push({ t: 'any' });
        i = close;
      }
    } else {
      out.push({ t: 'lit', c: ch.toLowerCase() });
    }
  }
  return out;
}

/** Índice del `)` que cierra el `(` en `open` (con anidamiento), o -1. */
function closingParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/** ¿Existe una ruta que coincida con ambos patrones? Programación dinámica sobre segmentos. */
function patternsIntersect(a: readonly Segment[], b: readonly Segment[]): boolean {
  const memo = new Map<number, boolean>();
  const width = b.length + 1;
  const go = (i: number, j: number): boolean => {
    const key = i * width + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const x = a[i];
    const y = b[j];
    let result: boolean;
    if (!x && !y) result = true;
    else if (x?.globstar) result = go(i + 1, j) || (y !== undefined && go(i, j + 1));
    else if (y?.globstar) result = go(i, j + 1) || (x !== undefined && go(i + 1, j));
    else if (!x || !y) result = false;
    else result = segmentsIntersect(x.tokens, y.tokens) && go(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

/** ¿Existe un nombre de segmento que coincida con ambos? */
function segmentsIntersect(a: readonly Token[], b: readonly Token[]): boolean {
  const memo = new Map<number, boolean>();
  const width = b.length + 1;
  const go = (i: number, j: number): boolean => {
    const key = i * width + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const x = a[i];
    const y = b[j];
    let result: boolean;
    if (!x && !y) result = true;
    else if (x?.t === 'star') result = go(i + 1, j) || (y !== undefined && go(i, j + 1));
    else if (y?.t === 'star') result = go(i, j + 1) || (x !== undefined && go(i + 1, j));
    else if (!x || !y) result = false;
    else if (x.t === 'any' || y.t === 'any' || x.c === y.c) result = go(i + 1, j + 1);
    else result = false;
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}
