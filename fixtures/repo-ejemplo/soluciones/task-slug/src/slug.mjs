/**
 * Convierte una cadena de texto en un slug apto para URL.
 * - Elimina acentos y diacríticos.
 * - Convierte a minúsculas.
 * - Reemplaza secuencias de caracteres no alfanuméricos por guiones.
 * - Elimina guiones iniciales y finales.
 */
export function slugify(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }

  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
