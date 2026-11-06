/**
 * Reglas de la guardia para las herramientas de los plugins (servidores MCP `mcp__<servidor>__*`).
 *
 * Chrome personal (`chrome-personal`): sus herramientas leen y escriben archivos locales por los argumentos (navegar a
 * `file:`, `upload_file`, los `filePath` de capturas y volcados). Aquí se dice qué argumento es una URL, qué es una ruta
 * y cuál escribe; la guardia aplica sus raíces de lectura y de escritura (mente-01).
 */
import { CHROME_SERVER } from '../plugins/chrome.ts';

export const CHROME_TOOL_PREFIX = `mcp__${CHROME_SERVER}__`;

/** Nombre corto de una herramienta del Chrome personal (`navigate_page`), o `undefined` si es de otro servidor. */
export function chromeToolOf(toolName: string): string | undefined {
  return toolName.startsWith(CHROME_TOOL_PREFIX) && toolName.length > CHROME_TOOL_PREFIX.length ? toolName.slice(CHROME_TOOL_PREFIX.length) : undefined;
}

/** Argumentos con una URL a la que navega el navegador (`url`, `installUrlOrBundleUrl`…). */
export const isUrlArg = (key: string): boolean => key === 'url' || key.endsWith('Url');
/** Argumentos con rutas locales (`filePath`, `filePaths`, `outputDirPath`, `path`…). */
export const isPathArg = (key: string): boolean => key === 'path' || key.endsWith('Path') || key.endsWith('Paths');

/** Herramientas que escriben en la ruta de sus argumentos (captura, volcado, traza, cuerpo de una petición, informe). */
const CHROME_OUTPUT_TOOLS = new Set([
  'take_screenshot',
  'take_snapshot',
  'take_heapsnapshot',
  'screencast_start',
  'performance_start_trace',
  'performance_stop_trace',
  'evaluate_script',
  'get_network_request',
  'lighthouse_audit',
]);
export const chromeToolWrites = (tool: string): boolean => CHROME_OUTPUT_TOOLS.has(tool);

/**
 * Esquema de una URL normalizado con `new URL()` (`file:` aunque venga como `FILE:` o con espacios), `about:blank`
 * para la página en blanco, o `undefined` si no es una URL válida.
 */
export function urlScheme(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    return url.href === 'about:blank' ? 'about:blank' : url.protocol;
  } catch {
    return undefined;
  }
}

/** Esquemas a los que la mente puede navegar: la web y la página en blanco. */
export const isWebScheme = (scheme: string | undefined): boolean => scheme === 'http:' || scheme === 'https:' || scheme === 'about:blank';
