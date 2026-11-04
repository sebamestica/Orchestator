/**
 * Análisis de comandos de Bash, PowerShell y cmd para la política de herramientas del worker Claude.
 *
 * No es un intérprete completo: tokeniza como el shell (comillas, escapes, separadores `;` `&&` `||`
 * `|` `&` y saltos de línea, redirecciones y heredocs) y marca como problema todo lo que no se puede
 * verificar de forma estática (sustitución de comandos, sustitución de procesos, comillas sin cerrar,
 * `--%` de PowerShell). Las palabras con expansión de variables se marcan como dinámicas.
 */

export type ShellKind = 'bash' | 'powershell' | 'cmd';

export interface Word {
  /** Texto tras quitar comillas y escapes. */
  text: string;
  /** Contiene expansión de variables (`$X`, `${X}`, `%X%`, `!X!`): su valor real no se conoce. */
  dynamic: boolean;
  /** Tenía comillas o escapes (p. ej. `"push"`, `p\ush`). */
  quoted: boolean;
  /** Comodines o llaves sin comillas (`gi?`, `pu{sh,ll}`): el shell puede expandirlos a otra cosa. */
  glob: boolean;
}

export interface Redirect {
  op: string;
  target: Word;
}

export interface SimpleCommand {
  words: Word[];
  redirects: Redirect[];
  /** Recibe la salida de otro comando por una tubería (`a | b`). */
  piped: boolean;
}

export interface ParsedScript {
  commands: SimpleCommand[];
  /** Construcciones no verificables; si hay alguna, el comando se deniega. */
  problems: string[];
}

interface MutableWord {
  text: string;
  dynamic: boolean;
  quoted: boolean;
  glob: boolean;
}

interface Heredoc {
  delimiter: string;
  stripTabs: boolean;
  quoted: boolean;
}

class Builder {
  readonly commands: SimpleCommand[] = [];
  readonly problems: string[] = [];
  #cur: SimpleCommand = { words: [], redirects: [], piped: false };
  #word: MutableWord | undefined;
  #redirect: string | undefined;

  /** True si el comando en construcción ya tiene alguna palabra (posición de argumento). */
  get inArguments(): boolean {
    return this.#word !== undefined || this.#cur.words.length > 0;
  }

  /** Agrega comandos de una subexpresión analizada aparte. */
  addCommands(commands: readonly SimpleCommand[], problems: readonly string[]): void {
    this.commands.push(...commands);
    this.problems.push(...problems);
  }

  get hasWord(): boolean {
    return this.#word !== undefined;
  }

  get wordText(): string | undefined {
    return this.#word?.text;
  }

  word(): MutableWord {
    this.#word ??= { text: '', dynamic: false, quoted: false, glob: false };
    return this.#word;
  }

  dropWord(): void {
    this.#word = undefined;
  }

  endWord(): void {
    const w = this.#word;
    if (!w) return;
    this.#word = undefined;
    if (this.#redirect) {
      this.#cur.redirects.push({ op: this.#redirect, target: w });
      this.#redirect = undefined;
    } else {
      this.#cur.words.push(w);
    }
  }

  redirect(op: string): void {
    this.endWord();
    if (this.#redirect) this.problems.push('redirección sin destino');
    this.#redirect = op;
  }

  endCommand(piped = false): void {
    this.endWord();
    if (this.#redirect) {
      this.problems.push('redirección sin destino');
      this.#redirect = undefined;
    }
    if (this.#cur.words.length > 0 || this.#cur.redirects.length > 0) this.commands.push(this.#cur);
    this.#cur = { words: [], redirects: [], piped };
  }

  result(): ParsedScript {
    this.endCommand();
    return { commands: this.commands, problems: this.problems };
  }
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\r';
const BASH_DELIMS = new Set([' ', '\t', '\r', '\n', ';', '&', '|', '<', '>', '(', ')']);

/** Lee la palabra delimitadora de un heredoc a partir de `start`. */
function readHeredocDelimiter(src: string, start: number): { delimiter: string; quoted: boolean; end: number } {
  let i = start;
  while (isSpace(src[i])) i++;
  let delimiter = '';
  let quoted = false;
  while (i < src.length && !BASH_DELIMS.has(src[i] as string)) {
    const c = src[i] as string;
    if (c === "'" || c === '"') {
      quoted = true;
      const end = src.indexOf(c, i + 1);
      if (end < 0) return { delimiter: '', quoted, end: src.length };
      delimiter += src.slice(i + 1, end);
      i = end + 1;
    } else if (c === '\\') {
      quoted = true;
      delimiter += src[i + 1] ?? '';
      i += 2;
    } else {
      delimiter += c;
      i++;
    }
  }
  return { delimiter, quoted, end: i };
}

export function parseBash(src: string): ParsedScript {
  const r = scanBash(src, 0, false);
  return { commands: r.commands, problems: r.problems };
}

/**
 * Analiza bash desde `start`. Con `nested` (contenido de `$( )`) termina en el `)` que cierra y devuelve
 * su índice en `end`. Los comandos de una sustitución se agregan a la lista para evaluarlos igual que
 * los demás; la palabra que la contiene queda dinámica (su valor no se conoce).
 */
function scanBash(src: string, start: number, nested: boolean): ParsedScript & { end: number } {
  const b = new Builder();
  const pending: Heredoc[] = [];
  let i = start;
  let depth = 0;

  /** Analiza `$( … )` que empieza en `from` (el `$`) y devuelve el índice tras el `)`. */
  const substitution = (from: number): number => {
    if (src[from + 2] === '(') {
      b.problems.push('expansión aritmética $(( )) no verificable');
      return src.length;
    }
    const sub = scanBash(src, from + 2, true);
    b.addCommands(sub.commands, sub.problems);
    return sub.end + 1;
  };

  const consumeHeredocs = () => {
    while (pending.length > 0) {
      const h = pending.shift() as Heredoc;
      let found = false;
      while (i < src.length) {
        const nl = src.indexOf('\n', i);
        const lineEnd = nl < 0 ? src.length : nl;
        const raw = src.slice(i, lineEnd).replace(/\r$/, '');
        const line = h.stripTabs ? raw.replace(/^\t+/, '') : raw;
        i = nl < 0 ? src.length : nl + 1;
        if (line === h.delimiter) {
          found = true;
          break;
        }
        if (!h.quoted && (line.includes('$(') || line.includes('`'))) b.problems.push('sustitución de comandos dentro de un heredoc');
      }
      if (!found) b.problems.push(`heredoc sin cierre «${h.delimiter}»`);
    }
  };

  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (isSpace(c)) {
      b.endWord();
      i++;
      continue;
    }
    if (c === '\n') {
      b.endCommand();
      i++;
      consumeHeredocs();
      continue;
    }
    if (c === '#' && !b.hasWord) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\\') {
      if (next === '\n') {
        i += 2;
        continue;
      }
      const w = b.word();
      w.quoted = true;
      w.text += next ?? '';
      i += 2;
      continue;
    }
    if (c === "'") {
      const w = b.word();
      w.quoted = true;
      const end = src.indexOf("'", i + 1);
      if (end < 0) {
        b.problems.push('comilla simple sin cerrar');
        w.text += src.slice(i + 1);
        i = src.length;
      } else {
        w.text += src.slice(i + 1, end);
        i = end + 1;
      }
      continue;
    }
    if (c === '"') {
      const w = b.word();
      w.quoted = true;
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        const d = src[j] as string;
        if (d === '"') {
          closed = true;
          break;
        }
        if (d === '\\' && j + 1 < src.length && '$`"\\\n'.includes(src[j + 1] as string)) {
          if (src[j + 1] !== '\n') w.text += src[j + 1];
          j += 2;
          continue;
        }
        if (d === '`') b.problems.push('sustitución de comandos con comillas invertidas');
        if (d === '$' && src[j + 1] === '(') {
          w.dynamic = true;
          w.text += '$(…)';
          j = substitution(j);
          continue;
        }
        if (d === '$' && /[A-Za-z0-9_{@*#?$!-]/.test(src[j + 1] ?? '')) w.dynamic = true;
        w.text += d;
        j++;
      }
      if (!closed) b.problems.push('comilla doble sin cerrar');
      i = closed ? j + 1 : src.length;
      continue;
    }
    if (c === '`') {
      b.problems.push('sustitución de comandos con comillas invertidas');
      i++;
      continue;
    }
    if (c === '$' && next === '(') {
      const w = b.word();
      w.dynamic = true;
      w.text += '$(…)';
      i = substitution(i);
      continue;
    }
    if (c === '$') {
      const w = b.word();
      if (next === "'" || next === '"') {
        // $'…' (escapes ANSI-C) y $"…" (traducción): su texto real no se puede asegurar.
        w.dynamic = true;
        i++;
        continue;
      }
      if (/[A-Za-z0-9_{@*#?$!-]/.test(next ?? '')) w.dynamic = true;
      w.text += c;
      i++;
      continue;
    }
    if (c === ';') {
      b.endCommand();
      i += next === ';' ? 2 : 1;
      continue;
    }
    if (c === '&') {
      if (next === '&') {
        b.endCommand();
        i += 2;
        continue;
      }
      if (next === '>') {
        b.redirect('&>');
        i += src[i + 2] === '>' ? 3 : 2;
        continue;
      }
      b.endCommand();
      i++;
      continue;
    }
    if (c === '|') {
      b.endCommand(next !== '|');
      i += next === '|' || next === '&' ? 2 : 1;
      continue;
    }
    if ((c === '<' || c === '>') && next === '(') {
      b.problems.push('sustitución de procesos');
      i += 2;
      continue;
    }
    if (c === '(' || c === ')' || c === '{' || c === '}') {
      // Subshells y grupos: su contenido se evalúa como comandos sueltos. `{`/`}` solo si van solos.
      if ((c === '{' || c === '}') && (b.hasWord || !(next === undefined || BASH_DELIMS.has(next)))) {
        const w = b.word();
        w.text += c;
        w.glob = true;
        i++;
        continue;
      }
      if (c === '(') depth++;
      if (c === ')') {
        if (depth > 0) depth--;
        else if (nested) {
          const r = b.result();
          return { ...r, end: i };
        }
      }
      b.endCommand();
      i++;
      continue;
    }
    if (c === '<' || c === '>') {
      const fd = b.wordText;
      if (fd !== undefined && /^\d+$/.test(fd)) b.dropWord();
      else b.endWord();
      if (c === '<' && next === '<') {
        if (src[i + 2] === '<') {
          b.redirect('<<<');
          i += 3;
          continue;
        }
        let j = i + 2;
        const stripTabs = src[j] === '-';
        if (stripTabs) j++;
        const h = readHeredocDelimiter(src, j);
        if (!h.delimiter) b.problems.push('heredoc sin delimitador');
        else pending.push({ delimiter: h.delimiter, stripTabs, quoted: h.quoted });
        i = h.end;
        continue;
      }
      i++;
      let op = c;
      if (c === '>' && src[i] === '>') {
        op = '>>';
        i++;
      } else if (c === '>' && src[i] === '|') {
        i++;
      } else if (src[i] === '&') {
        // Duplicación de descriptores (`2>&1`, `>&-`): no escribe en archivos.
        let j = i + 1;
        while (/[\d-]/.test(src[j] ?? '')) j++;
        if (j > i + 1) {
          i = j;
          continue;
        }
        i++;
        op = '>&';
      }
      b.redirect(op);
      continue;
    }
    const w = b.word();
    w.text += c;
    if (c === '*' || c === '?' || c === '[') w.glob = true;
    i++;
  }
  if (pending.length > 0) b.problems.push('heredoc sin cuerpo');
  if (nested) b.problems.push('sustitución de comandos $( ) sin cerrar');
  return { ...b.result(), end: src.length };
}

export function parsePowerShell(src: string): ParsedScript {
  const b = new Builder();
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (isSpace(c)) {
      b.endWord();
      i++;
      continue;
    }
    if (c === '\n') {
      b.endCommand();
      i++;
      continue;
    }
    if (c === '<' && next === '#') {
      const end = src.indexOf('#>', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (c === '#' && !b.hasWord) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '`') {
      if (next === '\n' || (next === '\r' && src[i + 2] === '\n')) {
        i += next === '\n' ? 2 : 3;
        continue;
      }
      const w = b.word();
      w.quoted = true;
      w.text += next ?? '';
      i += 2;
      continue;
    }
    if (c === "'" || c === '‘' || c === '’') {
      const w = b.word();
      w.quoted = true;
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        const d = src[j] as string;
        if (d === "'" || d === '‘' || d === '’') {
          if (src[j + 1] === d) {
            w.text += d;
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        w.text += d;
        j++;
      }
      if (!closed) b.problems.push('comilla simple sin cerrar');
      i = closed ? j + 1 : src.length;
      continue;
    }
    if (c === '"' || c === '“' || c === '”') {
      const w = b.word();
      w.quoted = true;
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        const d = src[j] as string;
        if (d === '`') {
          w.text += src[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (d === '"' || d === '“' || d === '”') {
          if (src[j + 1] === '"') {
            w.text += '"';
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        if (d === '$' && src[j + 1] === '(') {
          const end = matchingParen(src, j + 1);
          if (end < 0) {
            b.problems.push('subexpresión $( ) sin cerrar');
            j = src.length;
            break;
          }
          const inner = parsePowerShell(src.slice(j + 2, end));
          b.addCommands(inner.commands, inner.problems);
          w.dynamic = true;
          w.text += '$(…)';
          j = end + 1;
          continue;
        }
        if (d === '$' && /[A-Za-z0-9_{:?$^]/.test(src[j + 1] ?? '')) w.dynamic = true;
        w.text += d;
        j++;
      }
      if (!closed) b.problems.push('comilla doble sin cerrar');
      i = closed ? j + 1 : src.length;
      continue;
    }
    if (c === '$' && next === '(') {
      // `$( … )` se analiza igual que `( … )` (ver abajo).
      i++;
      continue;
    }
    if (c === '$') {
      const w = b.word();
      if (/[A-Za-z0-9_{:?$^]/.test(next ?? '')) w.dynamic = true;
      w.text += c;
      i++;
      continue;
    }
    if (c === '@' && (next === '(' || next === '{') && !b.hasWord) {
      i++;
      continue;
    }
    if (c === '-' && next === '-' && src[i + 2] === '%' && !b.hasWord) {
      b.problems.push('--% de PowerShell (sin análisis)');
      break;
    }
    if (c === '(') {
      if (b.hasWord && /[\w\]]$/.test(b.wordText ?? '') && /\.[\w]+$|\]::[\w]+$/.test(b.wordText ?? '')) {
        b.problems.push('llamada a un método .NET: no se puede verificar');
      }
      const end = matchingParen(src, i);
      if (end < 0) {
        b.problems.push('paréntesis sin cerrar');
        break;
      }
      const inner = parsePowerShell(src.slice(i + 1, end));
      b.addCommands(inner.commands, inner.problems);
      if (b.inArguments) {
        // Argumento calculado: su valor no se conoce (el contenido ya se evalúa aparte).
        const w = b.word();
        w.text += '(…)';
        w.dynamic = true;
      }
      i = end + 1;
      if (src[i] === '.') b.problems.push('llamada a un método .NET: no se puede verificar');
      continue;
    }
    if (c === ';' || c === ')' || c === '{' || c === '}') {
      b.endCommand();
      i++;
      continue;
    }
    if ((c === '&' || c === '.') && next !== c && !b.hasWord) {
      // Operadores de llamada (`& x`, `. x`): con una expresión detrás, el comando real no se conoce.
      let j = i + 1;
      while (isSpace(src[j])) j++;
      if (c === '.' && j === i + 1) {
        b.word().text += c;
        i++;
        continue;
      }
      if (src[j] === '(' || src[j] === '{') b.problems.push('operador de llamada con una expresión: no se puede verificar');
      if (c === '.') b.problems.push('dot-sourcing de PowerShell: no se puede verificar');
      b.endCommand();
      i++;
      continue;
    }
    if (c === '&' || c === '|') {
      b.endCommand(c === '|' && next !== '|');
      i += next === c ? 2 : 1;
      continue;
    }
    if (c === '>' || (c === '<' && b.hasWord === false && next !== '#')) {
      if (c === '<') {
        b.problems.push('redirección de entrada no admitida en PowerShell');
        i++;
        continue;
      }
      const fd = b.wordText;
      if (fd !== undefined && /^[\d*]$/.test(fd)) b.dropWord();
      else b.endWord();
      i++;
      let op = '>';
      if (src[i] === '>') {
        op = '>>';
        i++;
      }
      if (src[i] === '&') {
        i++;
        while (/\d/.test(src[i] ?? '')) i++;
        continue;
      }
      b.redirect(op);
      continue;
    }
    b.word().text += c;
    i++;
  }
  return b.result();
}

/** Índice del `)` que cierra el `(` de `start`, saltando comillas; -1 si no cierra. */
function matchingParen(src: string, start: number): number {
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    const d = src[j];
    if (d === '`') {
      j++;
      continue;
    }
    if (d === "'" || d === '"') {
      const close = src.indexOf(d, j + 1);
      if (close < 0) return -1;
      j = close;
      continue;
    }
    if (d === '(') depth++;
    else if (d === ')' && --depth === 0) return j;
  }
  return -1;
}

export function parseCmd(src: string): ParsedScript {
  const b = new Builder();
  let i = 0;
  let inQuotes = false;
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (inQuotes) {
      if (c === '"') inQuotes = false;
      else {
        if (c === '%' || c === '!') {
          const end = src.indexOf(c, i + 1);
          if (end > i + 1 && /^[A-Za-z0-9_~:,=-]+$/.test(src.slice(i + 1, end))) b.word().dynamic = true;
        }
        b.word().text += c;
      }
      i++;
      continue;
    }
    if (c === '"') {
      b.word().quoted = true;
      inQuotes = true;
      i++;
      continue;
    }
    if (isSpace(c)) {
      b.endWord();
      i++;
      continue;
    }
    if (c === '\n') {
      b.endCommand();
      i++;
      continue;
    }
    if (c === '^') {
      // `^ ` no se trata como espacio escapado: se separa la palabra (más prudente).
      if (isSpace(next)) {
        b.endWord();
        i += 2;
        continue;
      }
      const w = b.word();
      w.quoted = true;
      if (next !== '\n') w.text += next ?? '';
      i += 2;
      continue;
    }
    if (c === '%' || c === '!') {
      const end = src.indexOf(c, i + 1);
      if (end > i + 1 && /^[A-Za-z0-9_~:,=-]+$/.test(src.slice(i + 1, end))) b.word().dynamic = true;
      b.word().text += c;
      i++;
      continue;
    }
    if (c === '&' || c === '|') {
      b.endCommand(c === '|' && next !== '|');
      i += next === c ? 2 : 1;
      continue;
    }
    if (c === '(' || c === ')') {
      b.endCommand();
      i++;
      continue;
    }
    if (c === '<' || c === '>') {
      const fd = b.wordText;
      if (fd !== undefined && /^\d$/.test(fd)) b.dropWord();
      else b.endWord();
      i++;
      let op: string = c;
      if (c === '>' && src[i] === '>') {
        op = '>>';
        i++;
      }
      if (src[i] === '&') {
        i++;
        while (/\d/.test(src[i] ?? '')) i++;
        continue;
      }
      b.redirect(op);
      continue;
    }
    b.word().text += c;
    i++;
  }
  if (inQuotes) b.problems.push('comilla doble sin cerrar');
  return b.result();
}

export function parseShell(src: string, kind: ShellKind): ParsedScript {
  return kind === 'bash' ? parseBash(src) : kind === 'powershell' ? parsePowerShell(src) : parseCmd(src);
}
