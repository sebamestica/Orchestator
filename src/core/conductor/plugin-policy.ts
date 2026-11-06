/**
 * Reglas de la guardia para las herramientas de los plugins (servidores MCP `mcp__<servidor>__*`).
 *
 * Chrome personal (`chrome-personal`): sus herramientas leen y escriben archivos locales por los argumentos (navegar a
 * `file:`, `upload_file`, los `filePath` de capturas y volcados). Aquí se dice qué argumento es una URL, qué es una ruta
 * y cuál escribe; la guardia aplica sus raíces de lectura y de escritura (mente-01).
 *
 * Modos (autoeval-navegador-02): cada herramienta de plugin tiene una clase (`pluginToolClass`); fuera de los modos que
 * actúan (`modeActs`), la sesión niega toda la que no sea de lectura (`pluginModeProblem`).
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

/**
 * Clase de una herramienta de plugin (autoeval-navegador-02): `lectura` mira sin cambiar nada; `accion` cambia algo en
 * el navegador (clic, rellenar, subir, cerrar…); `script` ejecuta código en la página; `publicar` guarda o envía algo
 * en una cuenta del usuario (Canva). Fuera de los modos que actúan, solo pasa `lectura`.
 */
export type PluginToolClass = 'lectura' | 'accion' | 'script' | 'publicar';

export const CANVA_SERVER = 'canva';

/** Herramientas del Chrome personal que solo miran. Las que no están aquí cuentan como acción (una versión nueva no abre un hueco). */
const CHROME_READ_TOOLS = new Set([
  'list_pages',
  'select_page',
  'get_tab_id',
  'take_snapshot',
  'take_screenshot',
  'wait_for',
  'list_console_messages',
  'get_console_message',
  'list_network_requests',
  'get_network_request',
  'get_css_styles',
  'performance_analyze_insight',
]);
const CHROME_NAV_TOOLS = new Set(['new_page', 'navigate_page']);
const CANVA_READ = /^(?:(?:get|list|search)-|resolve-shortlink$)/;

const recordOf = (input: unknown): Record<string, unknown> => (input && typeof input === 'object' ? (input as Record<string, unknown>) : {});

function chromeToolClass(tool: string, input: unknown): PluginToolClass {
  if (tool === 'evaluate_script') return 'script';
  if (CHROME_NAV_TOOLS.has(tool)) {
    const { initScript, url } = recordOf(input);
    if (initScript !== undefined && initScript !== null && initScript !== '') return 'script';
    // `javascript:`, `data:`, `vbscript:`… ejecutan código aunque la guardia no los negara.
    if (url !== undefined && (typeof url !== 'string' || !isWebScheme(urlScheme(url)))) return 'script';
    return 'lectura';
  }
  return CHROME_READ_TOOLS.has(tool) ? 'lectura' : 'accion';
}

export function pluginToolClass(server: string, tool: string, input: unknown): PluginToolClass {
  if (server === CHROME_SERVER) return chromeToolClass(tool, input);
  if (server === CANVA_SERVER) return CANVA_READ.test(tool.toLowerCase().replace(/_/g, '-')) ? 'lectura' : 'publicar';
  return 'accion';
}

/** Servidor y herramienta de un `mcp__<servidor>__<herramienta>` de los plugins de la sesión, o `undefined`. */
export function pluginToolOf(toolName: string, servers: readonly string[]): { server: string; tool: string } | undefined {
  for (const server of servers) {
    const prefix = `mcp__${server}__`;
    if (toolName.startsWith(prefix) && toolName.length > prefix.length) return { server, tool: toolName.slice(prefix.length) };
  }
  return undefined;
}

/**
 * Motivo para negar una herramienta de plugin que no es de lectura en un modo en el que la mente no actúa (plan, auto,
 * o bypass sin proyecto), o `undefined` si no es de un plugin de la sesión o solo mira.
 */
export function pluginModeProblem(toolName: string, input: unknown, servers: readonly string[], mode: string | undefined, standalone: boolean): string | undefined {
  const plugin = pluginToolOf(toolName, servers);
  if (!plugin) return undefined;
  const kind = pluginToolClass(plugin.server, plugin.tool, input);
  if (kind === 'lectura') return undefined;
  const way = standalone ? 'pídele al usuario que pase a modo chat' : 'pídele al usuario que pase a chat o bypass, o propón una tarea';
  return `${toolName} cambia algo fuera de Berland (${kind}) y en el modo ${mode ?? 'actual'} no actúas: aquí solo miras. Para hacerlo, ${way}.`;
}
