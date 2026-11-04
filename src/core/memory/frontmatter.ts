/**
 * Frontmatter YAML mínimo y seguro, sin dependencias.
 *
 * Serializa solo escalares (texto, número, booleano, null), listas de escalares y mapas de un nivel.
 * El lector acepta el subconjunto que usan Obsidian y los `SKILL.md`: `clave: valor`, comillas simples
 * y dobles, listas en bloque (`- x`) y en línea (`[a, b]`), bloques `|` y `>` y mapas de un nivel.
 * Rechaza anclas, alias, etiquetas (`!!`) y claves peligrosas (`__proto__`): nunca ejecuta nada.
 */

export type FrontmatterScalar = string | number | boolean | null;
export type FrontmatterValue = FrontmatterScalar | readonly FrontmatterScalar[] | Readonly<Record<string, FrontmatterScalar>>;
export type Frontmatter = Record<string, FrontmatterValue>;

export class FrontmatterError extends Error {
  override readonly name = 'FrontmatterError';
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const RESERVED_PLAIN = /^(?:true|false|yes|no|on|off|null|y|n|~)$/i;
/** Texto que puede ir sin comillas sin cambiar de tipo en ningún lector YAML (1.1 o 1.2). */
const SAFE_PLAIN = /^[A-Za-z_][A-Za-z0-9_./-]*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER_RE = /^[-+]?(?:\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|\.\d+)$/;

function assertKey(key: string): void {
  if (!KEY_RE.test(key) || FORBIDDEN_KEYS.has(key)) throw new FrontmatterError(`clave de frontmatter no válida: ${JSON.stringify(key)}`);
}

/** Comillas dobles de YAML: JSON escapa casi todo; se añaden los caracteres que YAML no admite sin escapar (C1, separadores Unicode, BOM). */
function quote(text: string): string {
  return JSON.stringify(text).replace(/[\u007F-\u009F\u2028\u2029\uFEFF\uFFFE\uFFFF]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function serializeScalar(value: FrontmatterScalar): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FrontmatterError('número no finito en frontmatter');
    return String(value);
  }
  if (ISO_DATE.test(value)) return value; // Obsidian la muestra como fecha
  if (SAFE_PLAIN.test(value) && !RESERVED_PLAIN.test(value)) return value;
  return quote(value);
}

function isScalar(value: unknown): value is FrontmatterScalar {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** Bloque YAML (sin los `---`). Orden de claves: el del objeto recibido. */
export function serializeFrontmatter(data: Readonly<Frontmatter>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    assertKey(key);
    if (isScalar(value)) {
      lines.push(`${key}: ${serializeScalar(value)}`);
    } else if (Array.isArray(value)) {
      const items: readonly unknown[] = value;
      if (items.length === 0) { lines.push(`${key}: []`); continue; }
      lines.push(`${key}:`);
      for (const item of items) {
        if (!isScalar(item)) throw new FrontmatterError(`la lista ${key} solo admite escalares`);
        lines.push(`  - ${serializeScalar(item)}`);
      }
    } else {
      const entries = Object.entries(value as Readonly<Record<string, unknown>>);
      if (entries.length === 0) { lines.push(`${key}: {}`); continue; }
      lines.push(`${key}:`);
      for (const [sub, subValue] of entries) {
        assertKey(sub);
        if (!isScalar(subValue)) throw new FrontmatterError(`el mapa ${key} solo admite escalares`);
        lines.push(`  ${sub}: ${serializeScalar(subValue)}`);
      }
    }
  }
  return lines.join('\n');
}

/** Nota completa: frontmatter + cuerpo. El cuerpo termina siempre en salto de línea. */
export function stringifyNote(data: Readonly<Frontmatter>, body: string): string {
  const yaml = serializeFrontmatter(data);
  const text = body.endsWith('\n') ? body : `${body}\n`;
  return `---\n${yaml}\n---\n${text}`;
}

export interface ParsedNote {
  data: Frontmatter;
  body: string;
  /** False si el texto no empieza con un bloque `---`. */
  hasFrontmatter: boolean;
  /** Claves que el modo tolerante guardó como texto sin interpretar o descartó. */
  unsupported: string[];
}

export interface ParseOptions {
  /**
   * Modo tolerante (para `SKILL.md` ajenos): un valor con sintaxis no soportada (p. ej. `metadata: {…}`)
   * se guarda como el texto crudo y una clave no válida o repetida se descarta, en lugar de lanzar.
   * Las claves peligrosas (`__proto__`…) se descartan siempre. Un `---` sin cierre sigue lanzando.
   */
  lenient?: boolean;
  /**
   * Con `lenient`, descarta además las líneas que no entiende (tabulación o sangría inesperada, sin
   * `clave:`) y anota `línea N` en `unsupported`. Para notas de Obsidian editadas a mano.
   */
  skipBadLines?: boolean;
}

/** Separa frontmatter y cuerpo. Lanza `FrontmatterError` si el bloque existe pero no es válido. */
export function parseNote(text: string, opts: ParseOptions = {}): ParsedNote {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return { data: {}, body: normalized, hasFrontmatter: false, unsupported: [] };
  const lines = normalized.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '---' || line === '...') { end = i; break; }
  }
  if (end < 0) throw new FrontmatterError('frontmatter sin cierre `---`');
  const unsupported: string[] = [];
  const lenient = opts.lenient === true;
  const data = parseYamlLines(lines.slice(1, end), lenient, lenient && opts.skipBadLines === true, unsupported);
  return { data, body: lines.slice(end + 1).join('\n'), hasFrontmatter: true, unsupported };
}

/**
 * Actualiza claves del frontmatter sin reescribir el resto: las líneas que no se tocan (propiedades del
 * usuario, YAML que este lector no entiende, claves repetidas) se conservan tal cual. Cada clave reemplaza
 * su primera aparición (con sus líneas de continuación) o se agrega al final del bloque. Sin frontmatter
 * (o con un `---` sin cierre) se crea uno delante del texto. `body` recibe el cuerpo actual y devuelve el nuevo.
 */
export function updateNote(text: string, updates: Readonly<Frontmatter>, body: (current: string) => string = (b) => b): string {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const end = normalized.startsWith('---\n') ? lines.findIndex((l, k) => k > 0 && (l === '---' || l === '...')) : -1;
  if (end < 0) return stringifyNote(updates, body(normalized));
  const yaml = lines.slice(1, end);
  for (const [key, value] of Object.entries(updates)) {
    const replacement = serializeFrontmatter({ [key]: value }).split('\n');
    const at = yaml.findIndex((l) => l.startsWith(key) && /^\s*:(?:\s|$)/.test(l.slice(key.length)));
    if (at < 0) { yaml.push(...replacement); continue; }
    let stop = at + 1;
    for (let k = at + 1; k < yaml.length; k++) {
      const l = yaml[k] ?? '';
      if (l.startsWith(' ') || l.startsWith('- ') || l === '-') stop = k + 1;
      else if (l.trim() !== '') break;
    }
    yaml.splice(at, stop - at, ...replacement);
  }
  const newBody = body(lines.slice(end + 1).join('\n'));
  return `---\n${yaml.join('\n')}\n---\n${newBody.endsWith('\n') ? newBody : `${newBody}\n`}`;
}

function indentOf(line: string): number {
  const match = /^ */.exec(line);
  return match ? match[0].length : 0;
}

function isBlank(line: string): boolean {
  return line.trim() === '' || line.trimStart().startsWith('#');
}

/** Lee las líneas que siguen a `clave:` mientras pertenezcan a su valor. */
function takeWhile(lines: readonly string[], from: number, belongs: (line: string) => boolean): string[] {
  const taken: string[] = [];
  while (from + taken.length < lines.length) {
    const next = lines[from + taken.length] ?? '';
    if (!belongs(next)) break;
    taken.push(next);
  }
  return taken;
}

function parseYamlLines(lines: readonly string[], lenient: boolean, skipBadLines: boolean, unsupported: string[]): Frontmatter {
  const out: Frontmatter = Object.create(null) as Frontmatter;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (isBlank(line)) { i++; continue; }
    const match = /^([^:\s][^:]*?)\s*:(?:\s+(.*))?$/.exec(line);
    if (/^\t/.test(line) || indentOf(line) !== 0 || !match) {
      if (skipBadLines) { unsupported.push(`línea ${i + 1}`); i++; continue; }
      if (/^\t/.test(line)) throw new FrontmatterError(`tabulación como sangría en la línea ${i + 1}`);
      if (indentOf(line) !== 0) throw new FrontmatterError(`sangría inesperada en la línea ${i + 1}`);
      throw new FrontmatterError(`línea no reconocida ${i + 1}: ${line.slice(0, 40)}`);
    }
    const key = match[1] ?? '';
    const rest = (match[2] ?? '').trim();
    i++;

    let parse: () => FrontmatterValue;
    let raw: string;
    if (rest === '' || rest.startsWith('#')) {
      // Lista o mapa en bloque, o valor nulo.
      const block = takeWhile(lines, i, (next) => isBlank(next) || indentOf(next) > 0 || next.startsWith('- ') || next === '-');
      i += block.length;
      parse = () => parseBlock(key, block);
      raw = block.join('\n').trim();
    } else if (/^[|>][+-]?$/.test(rest)) {
      const block = takeWhile(lines, i, (next) => next.trim() === '' || indentOf(next) > 0);
      i += block.length;
      parse = () => foldBlockScalar(block, rest.startsWith('>'), rest.slice(1));
      raw = block.join('\n').trim();
    } else {
      // Escalar en varias líneas: las líneas siguientes con sangría continúan el valor y YAML las une
      // con un espacio (una línea en blanco equivale a un salto de línea).
      const continuation = takeWhile(lines, i, (next) => next.trim() === '' || indentOf(next) > 0);
      while (continuation.length > 0 && (continuation.at(-1) ?? '').trim() === '') continuation.pop();
      i += continuation.length;
      let value = rest;
      for (const extra of continuation) {
        const piece = extra.trim();
        if (piece === '') value += '\n';
        else value += value.endsWith('\n') ? piece : ` ${piece}`;
      }
      parse = () => (value.startsWith('[') ? parseFlowList(value, key) : parseScalar(value));
      raw = value;
    }

    if (FORBIDDEN_KEYS.has(key) || !KEY_RE.test(key)) {
      if (!lenient) assertKey(key);
      unsupported.push(key);
      continue;
    }
    if (Object.hasOwn(out, key)) {
      if (!lenient) throw new FrontmatterError(`clave repetida: ${key}`);
      unsupported.push(key);
      continue;
    }
    try {
      out[key] = parse();
    } catch (err) {
      if (!lenient || !(err instanceof FrontmatterError)) throw err;
      out[key] = raw;
      unsupported.push(key);
    }
  }
  return { ...out };
}

function parseBlock(key: string, block: readonly string[]): FrontmatterValue {
  const content = block.filter((l) => !isBlank(l));
  if (content.length === 0) return null;
  if (content.every((l) => /^\s*- /.test(l) || /^\s*-$/.test(l))) {
    return content.map((l) => {
      const value = l.replace(/^\s*-\s?/, '').trim();
      if (value.startsWith('[') || value.startsWith('{')) throw new FrontmatterError(`lista anidada en ${key} no soportada`);
      return value === '' ? null : parseScalar(value);
    });
  }
  const map: Record<string, FrontmatterScalar> = {};
  const indent = indentOf(content[0] ?? '');
  if (indent === 0) throw new FrontmatterError(`bloque de ${key} sin sangría`);
  for (const l of content) {
    if (indentOf(l) !== indent) throw new FrontmatterError(`mapa anidado en ${key} no soportado`);
    const m = /^\s*([^:\s][^:]*?)\s*:(?:\s+(.*))?$/.exec(l);
    if (!m) throw new FrontmatterError(`línea no reconocida en ${key}: ${l.trim().slice(0, 40)}`);
    const sub = m[1] ?? '';
    assertKey(sub);
    const raw = (m[2] ?? '').trim();
    if (raw.startsWith('[') || raw.startsWith('{') || raw === '|' || raw === '>') throw new FrontmatterError(`valor compuesto en ${key}.${sub} no soportado`);
    map[sub] = raw === '' ? null : parseScalar(raw);
  }
  return map;
}

function foldBlockScalar(block: readonly string[], folded: boolean, chomp: string): string {
  const nonEmpty = block.filter((l) => l.trim() !== '');
  const indent = nonEmpty.length ? Math.min(...nonEmpty.map(indentOf)) : 0;
  const lines = block.map((l) => l.slice(indent));
  let text: string;
  if (folded) {
    text = '';
    for (let k = 0; k < lines.length; k++) {
      const l = lines[k] ?? '';
      if (k === 0) { text = l; continue; }
      const prev = lines[k - 1] ?? '';
      text += l === '' || prev === '' ? `\n${l}` : ` ${l}`;
    }
  } else {
    text = lines.join('\n');
  }
  const trimmed = text.replace(/\n+$/, '');
  if (chomp === '-') return trimmed;
  if (chomp === '+') return `${text}\n`;
  return trimmed === '' ? '' : `${trimmed}\n`;
}

function splitFlow(inner: string): string[] {
  const items: string[] = [];
  let current = '';
  let quoteChar: string | null = null;
  for (let k = 0; k < inner.length; k++) {
    const ch = inner[k] ?? '';
    if (quoteChar) {
      current += ch;
      if (quoteChar === '"' && ch === '\\') { current += inner[k + 1] ?? ''; k++; continue; }
      if (ch === quoteChar) quoteChar = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quoteChar = ch; current += ch; continue; }
    if (ch === '[' || ch === '{') throw new FrontmatterError('estructura anidada en línea no soportada');
    if (ch === ',') { items.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (quoteChar) throw new FrontmatterError('comillas sin cerrar en lista');
  if (current.trim() !== '' || items.length > 0) items.push(current.trim());
  return items;
}

function parseFlowList(raw: string, key: string): FrontmatterScalar[] {
  const text = stripComment(raw);
  if (!text.endsWith(']')) throw new FrontmatterError(`lista en línea sin cerrar en ${key}`);
  const items = splitFlow(text.slice(1, -1));
  if (items.some((item) => item === '')) throw new FrontmatterError(`elemento vacío en la lista ${key}`);
  return items.map((item) => parseScalar(item));
}

function stripComment(raw: string): string {
  if (raw.startsWith('"') || raw.startsWith("'")) return raw.trim();
  const idx = raw.search(/\s#/);
  return (idx >= 0 ? raw.slice(0, idx) : raw).trim();
}

function parseDoubleQuoted(raw: string): string {
  const end = findClosingDouble(raw);
  const after = raw.slice(end + 1).trim();
  if (after !== '' && !after.startsWith('#')) throw new FrontmatterError('texto después de las comillas');
  const inner = raw.slice(1, end).replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  // Escapes propios de YAML que JSON no conoce.
  const jsonish = inner
    .replace(/\\(.)/g, (whole, ch: string) => {
      if (ch === '0') return '\\u0000';
      if (ch === "'") return "'";
      if (ch === ' ') return ' ';
      if (ch === '/') return '/';
      return whole;
    })
    .replace(/\\x([0-9A-Fa-f]{2})/g, '\\u00$1');
  try {
    const value: unknown = JSON.parse(`"${jsonish}"`);
    if (typeof value !== 'string') throw new FrontmatterError('texto entre comillas no válido');
    return value;
  } catch {
    throw new FrontmatterError('texto entre comillas dobles no válido');
  }
}

function findClosingDouble(raw: string): number {
  for (let k = 1; k < raw.length; k++) {
    const ch = raw[k];
    if (ch === '\\') { k++; continue; }
    if (ch === '"') return k;
  }
  throw new FrontmatterError('comillas dobles sin cerrar');
}

function parseSingleQuoted(raw: string): string {
  let out = '';
  for (let k = 1; k < raw.length; k++) {
    const ch = raw[k];
    if (ch === "'") {
      if (raw[k + 1] === "'") { out += "'"; k++; continue; }
      const after = raw.slice(k + 1).trim();
      if (after !== '' && !after.startsWith('#')) throw new FrontmatterError('texto después de las comillas');
      return out;
    }
    out += ch;
  }
  throw new FrontmatterError('comillas simples sin cerrar');
}

function parseScalar(raw: string): FrontmatterScalar {
  if (raw.startsWith('"')) return parseDoubleQuoted(raw);
  if (raw.startsWith("'")) return parseSingleQuoted(raw);
  const text = stripComment(raw);
  if (/^[&*!%@`{]/.test(text)) throw new FrontmatterError(`sintaxis YAML no soportada: ${text.slice(0, 20)}`);
  if (/^(?:null|~)$/i.test(text) || text === '') return null;
  if (/^true$/i.test(text)) return true;
  if (/^false$/i.test(text)) return false;
  if (NUMBER_RE.test(text)) {
    const n = Number(text);
    if (Number.isFinite(n)) return n;
  }
  return text;
}
