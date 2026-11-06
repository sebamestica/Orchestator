/**
 * Tacha secretos antes de escribir en registros, SQLite, Obsidian o eventos.
 * Regla del proyecto: ninguna clave sale del proceso que la recibió.
 */
// Los prefijos exigen no ir pegados a una letra o dígito: «task-scheduler-…» no es una clave «sk-…».
const PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic
  /(?<![A-Za-z0-9])sk-or-v1-[A-Za-z0-9]{20,}/g, // OpenRouter
  /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, // OpenAI y compatibles
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/g, // Google
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT / tokens OAuth
  // Blancos acotados: con `\s*` dentro del lookbehind, un tramo largo de espacios costaba O(n³) (2000 espacios, 6 s).
  /(?<=(?:api[_-]?key|authorization|x-api-key|bearer)["']?[ \t]{0,8}[:=]?[ \t]{0,8}["']?(?:Bearer[ \t]{1,8})?)[A-Za-z0-9._~+/=-]{16,}/gi,
  // Valor de `cookie`/`set-cookie`. Exige `nombre=` para no tocar frases ni el `<redacted>` de chrome-devtools-mcp.
  // Blancos y nombre acotados: sin tope, `'cookie:'.repeat(n)` o un tramo largo de blancos serían O(n²) o peor.
  // Como encabezado (`- cookie:a=b`, `Set-Cookie: a=b`), hasta el fin de línea: un valor puede llevar comillas.
  /(?<=(?<![A-Za-z0-9_-])(?:set-)?cookie[ \t]{0,4}:[ \t]{0,4})[^\s"'=;]{1,256}=[^\r\n]*/gi,
  // Entre comillas (`"cookie": "a=b"`), hasta la comilla de cierre.
  /(?<=(?<![A-Za-z0-9_-])(?:set-)?cookie["']?[ \t]{0,4}:[ \t]{0,4}["'])[^\s"'=;]{1,256}=[^"'\r\n]*/gi,
];

export const REDACTED = '[REDACTADO]';

export function redactSecrets(text: string, extraSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of extraSecrets) {
    if (secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}
