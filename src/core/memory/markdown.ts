/**
 * Secciones `## Título` de las notas, sin confundirse con encabezados dentro de bloques de código
 * (``` o ~~~). Los textos que llegan de fuera (resúmenes de sesión, del proyecto, decisiones) pasan
 * por `demoteHeadings` para que un `## Bitácora` dentro del texto no se tome por la sección real.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

interface FenceScan {
  /** Por cada línea: true si está fuera de un bloque de código (las vallas cuentan como dentro). */
  outside: boolean[];
  /** Valla que quedó abierta al final, si la hay. */
  open: { ch: string; len: number } | null;
}

function scanFences(lines: readonly string[]): FenceScan {
  const outside: boolean[] = [];
  let open: FenceScan['open'] = null;
  for (const line of lines) {
    const m = FENCE.exec(line);
    const marker = m?.[1] ?? '';
    const ch = marker.charAt(0);
    if (open) {
      if (m && ch === open.ch && marker.length >= open.len && (m[2] ?? '').trim() === '') open = null;
      outside.push(false);
    } else if (m && !(ch === '`' && (m[2] ?? '').includes('`'))) {
      open = { ch, len: marker.length };
      outside.push(false);
    } else {
      outside.push(true);
    }
  }
  return { outside, open };
}

export function outsideFences(lines: readonly string[]): boolean[] {
  return scanFences(lines).outside;
}

/** `#` o `##` reales (fuera de código): marcan el límite de una sección. */
function isSectionBreak(line: string, outside: boolean): boolean {
  return outside && /^#{1,2}(?:[ \t]|$)/.test(line);
}

/**
 * Prepara un texto recibido para ir dentro de una sección: baja `#` y `##` a `###` fuera de bloques de
 * código y cierra una valla que haya quedado abierta (si no, el resto de la nota quedaría «dentro» del código).
 */
export function demoteHeadings(text: string): string {
  const lines = text.split('\n');
  const { outside, open } = scanFences(lines);
  const out = lines.map((line, k) => (outside[k] ? line.replace(/^( {0,3})#{1,2}(?=[ \t]|$)/, '$1###') : line));
  if (open) out.push(open.ch.repeat(Math.max(3, open.len)));
  return out.join('\n');
}

export function stripComments(text: string): string {
  return text.replace(/%%[\s\S]*?%%/g, '').replace(/<!--[\s\S]*?-->/g, '');
}

interface Span {
  lines: string[];
  outside: boolean[];
  /** Índice del encabezado, o -1. */
  start: number;
  /** Índice de la primera línea después de la sección. */
  end: number;
}

function locate(body: string, heading: string): Span {
  const lines = body.split('\n');
  const outside = outsideFences(lines);
  const start = lines.findIndex((l, k) => outside[k] === true && l.trimEnd() === heading);
  let end = lines.length;
  if (start >= 0) {
    for (let k = start + 1; k < lines.length; k++) {
      if (isSectionBreak(lines[k] ?? '', outside[k] === true)) { end = k; break; }
    }
  }
  return { lines, outside, start, end };
}

/** Texto de la sección (hasta el siguiente `#`/`##` real), sin comentarios de Obsidian ni HTML. */
export function sectionText(body: string, heading: string): string {
  const { lines, start, end } = locate(body, heading);
  if (start < 0) return '';
  return stripComments(lines.slice(start + 1, end).join('\n')).trim();
}

/** Cuerpo sin la sección indicada. */
export function withoutSection(body: string, heading: string): string {
  const { lines, start, end } = locate(body, heading);
  if (start < 0) return body;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n');
}

/** Cuerpo sin encabezados `#` reales (el título) y sin la línea `heading`; el código queda intacto. */
export function withoutHeadingLines(body: string, heading: string): string {
  const lines = body.split('\n');
  const outside = outsideFences(lines);
  return lines.filter((l, k) => !(outside[k] === true && (/^#(?:[ \t]|$)/.test(l) || l.trimEnd() === heading))).join('\n');
}

/** Agrega `line` al final de la sección `heading` (o crea la sección al final del cuerpo). */
export function appendToSection(body: string, heading: string, line: string): string {
  const trimmed = body.replace(/\n+$/, '');
  const { lines, start, end } = locate(trimmed, heading);
  if (start < 0) return `${trimmed}\n\n${heading}\n${line}\n`;
  let insertAt = end;
  while (insertAt > start + 1 && (lines[insertAt - 1] ?? '').trim() === '') insertAt--;
  lines.splice(insertAt, 0, line);
  return `${lines.join('\n')}\n`;
}

/** Reemplaza el contenido de la sección `heading` (o la crea después del título `#`). */
export function replaceSection(body: string, heading: string, content: string): string {
  const { lines, outside, start, end } = locate(body.replace(/\n+$/, ''), heading);
  if (start < 0) {
    const titleAt = lines.findIndex((l, k) => outside[k] === true && /^#[ \t]/.test(l));
    lines.splice(titleAt + 1, 0, '', heading, content);
    return `${lines.join('\n')}\n`;
  }
  lines.splice(start + 1, end - (start + 1), content, ...(end < lines.length ? [''] : []));
  return `${lines.join('\n')}\n`;
}
