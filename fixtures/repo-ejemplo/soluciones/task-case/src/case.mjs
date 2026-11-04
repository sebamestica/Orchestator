/**
 * Divide una cadena en palabras considerando espacios, guiones y cambios de mayúsculas/minúsculas.
 */
function extractWords(str) {
  if (typeof str !== 'string' || str.length === 0) {
    return [];
  }
  const matches = str.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g);
  return matches ?? [];
}

/**
 * Convierte una cadena a formato camelCase (p. ej. 'hola mundo' -> 'holaMundo').
 */
export function camelCase(text) {
  const words = extractWords(text);
  if (words.length === 0) {
    return '';
  }

  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index === 0) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}

/**
 * Convierte una cadena a formato snake_case (p. ej. 'Hola Mundo' -> 'hola_mundo').
 */
export function snakeCase(text) {
  const words = extractWords(text);
  if (words.length === 0) {
    return '';
  }

  return words.map((w) => w.toLowerCase()).join('_');
}
