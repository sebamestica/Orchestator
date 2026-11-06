/**
 * Lectura tolerante de campos de notas de la bóveda (frontmatter y secciones) para `ObsidianMemory`: nada de esto
 * lanza ante una nota editada a mano.
 */
import { parseNote, type Frontmatter, type FrontmatterValue } from './frontmatter.ts';
import { sectionText, stripComments } from './markdown.ts';

/**
 * Frontmatter de una nota que vamos a actualizar: nunca lanza. Una nota editada a mano con YAML que no
 * entendemos (claves repetidas, `{…}`, líneas raras o `---` sin cierre) no bloquea la memoria; lo que no
 * se entiende se ignora al leer y `updateNote` lo conserva tal cual al escribir.
 */
export function forgivingData(text: string): Frontmatter {
  try {
    return parseNote(text, { lenient: true, skipBadLines: true }).data;
  } catch {
    return {};
  }
}

export function numberField(data: Frontmatter, key: string): number {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function stringField(data: Frontmatter, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value : '';
}

/** `actualizado` no retrocede si llega una sesión con fecha anterior (fechas ISO: se comparan como texto). */
export function latestDate(data: Frontmatter, date: string): string {
  const prev = stringField(data, 'actualizado');
  return /^\d{4}-\d{2}-\d{2}$/.test(prev) && prev > date ? prev : date;
}

export function stringList(value: FrontmatterValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** La sección de la nota ya tiene un enlace `[[nota|…]]` o `[[nota]]` (bitácora o historial de una sesión registrada). */
export function linksTo(text: string, heading: string, note: string): boolean {
  let body = text;
  try {
    body = parseNote(text, { lenient: true, skipBadLines: true }).body;
  } catch {
    // `---` sin cierre: se busca en el texto entero.
  }
  const section = sectionText(body, heading);
  return section.includes(`[[${note}|`) || section.includes(`[[${note}]]`);
}

/** Texto de una decisión: el cuerpo sin el título ni las líneas de enlace al proyecto y al agente. */
export function decisionText(body: string): string {
  return stripComments(body)
    .split('\n')
    .filter((l) => !/^#\s/.test(l) && !/^- (Proyecto|Agente): \[\[/.test(l))
    .join('\n')
    .trim();
}

export function slugify(text: string): string {
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
