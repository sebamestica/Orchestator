/**
 * Trunca una cadena de texto a una longitud máxima con sufijo configurable.
 * Si la longitud del texto no supera maxLength, lo devuelve intacto.
 * Si lo supera, recorta el texto de forma que la longitud total con el sufijo no exceda maxLength.
 */
export function truncate(text, maxLength, suffix = '...') {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }
  if (typeof maxLength !== 'number' || maxLength <= 0) {
    return '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  if (maxLength <= suffix.length) {
    return suffix.slice(0, maxLength);
  }
  return text.slice(0, maxLength - suffix.length) + suffix;
}
