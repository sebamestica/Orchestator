/**
 * Plugin Chrome: el MCP `chrome-devtools-mcp` de `C:\dev\agent-hub\tools\browser` con uno de dos perfiles.
 * - `personal`: tu Chrome con tus sesiones (`chrome-personal.cmd`, `--autoConnect`). Requiere activar la
 *   depuración remota en `chrome://inspect/#remote-debugging` y aceptar el aviso de Chrome.
 * - `agente`: perfil propio de los agentes (`chrome-agente.cmd`, `tools\browser\chrome-profile`); el MCP abre
 *   Chrome si no está abierto. Chrome admite un solo proceso por perfil.
 *
 * chrome-devtools-mcp conecta o abre el navegador recién en la primera herramienta (no en `initialize` ni en
 * `tools/list`), por eso la prueba real llama `list_pages`.
 */
import { win32 } from 'node:path';
import type { z } from 'zod';
import type { chromeProfileSchema } from '../../shared/index.ts';
import { systemExe } from '../process/system-exe.ts';
import type { McpStdioSpec } from './mcp.ts';
import type { StdioProbeResult } from './mcp-probe.ts';

export type ChromeProfile = z.infer<typeof chromeProfileSchema>;

export const DEFAULT_BROWSER_TOOLS_DIR = 'C:\\dev\\agent-hub\\tools\\browser';

/** Nombre del servidor MCP y del candado de cada perfil (los mismos que usan las skills del hub). */
export const CHROME_SERVER: Readonly<Record<ChromeProfile, string>> = { personal: 'chrome-personal', agente: 'chrome-agente' };

export interface ChromeLauncher {
  command: string;
  args: string[];
}

export function chromeLauncherPath(profile: ChromeProfile, toolsDir = DEFAULT_BROWSER_TOOLS_DIR): string {
  return win32.join(toolsDir, `chrome-${profile}.cmd`);
}

/** `cmd.exe /c <lanzador>` con la ruta absoluta de `cmd.exe` (un `cmd.exe` del worktree no se ejecuta en su lugar). */
export function defaultChromeLauncher(profile: ChromeProfile, toolsDir = DEFAULT_BROWSER_TOOLS_DIR): ChromeLauncher {
  return { command: systemExe('cmd.exe'), args: ['/c', chromeLauncherPath(profile, toolsDir)] };
}

/** Nota para los agentes: el Chrome se comparte (con el usuario y con otros agentes). */
export const CHROME_TAB_NOTE =
  'Abre tu propia pestaña con `new_page`, trabaja solo en ella y ciérrala con `close_page` al terminar. No cierres, recargues ni navegues pestañas que no abriste: pueden ser del usuario o de otro agente.';
const PERSONAL_NOTE =
  'Es el Chrome del usuario con sus sesiones reales: entra solo a los sitios que pide la tarea, no escribas contraseñas ni datos de pago y no envíes formularios, compras ni mensajes sin que el encargo lo pida.';

export function chromeServerSpec(profile: ChromeProfile, launcher: ChromeLauncher): McpStdioSpec {
  return {
    type: 'stdio',
    command: launcher.command,
    args: [...launcher.args],
    instructions: profile === 'personal' ? `${CHROME_TAB_NOTE} ${PERSONAL_NOTE}` : CHROME_TAB_NOTE,
  };
}

const PERSONAL_STEPS = [
  'Abre tu Chrome y entra a chrome://inspect/#remote-debugging.',
  'Activa «Permitir la depuración remota» (Allow remote debugging) y deja Chrome abierto.',
  'Pulsa Conectar y acepta el aviso de Chrome que pide permitir la conexión.',
];
const AGENTE_STEPS = [
  'Pulsa Conectar: se abre un Chrome con el perfil de los agentes (C:\\dev\\agent-hub\\tools\\browser\\chrome-profile).',
  'Inicia sesión una vez en los sitios que necesiten los agentes; la sesión queda guardada en ese perfil.',
  'Google, Cloudflare y otros sitios pueden bloquear este perfil por ser automatizado: para ellos usa el perfil personal.',
];

/** Pasos a mano antes de conectar. */
export function chromeSteps(profile: ChromeProfile): string[] {
  return profile === 'personal' ? [...PERSONAL_STEPS] : [...AGENTE_STEPS];
}

export interface ChromeProbeOutcome {
  status: 'connected' | 'error';
  detail: string;
  steps: string[];
  tools: number;
}

const label = (profile: ChromeProfile) => `Perfil ${profile}`;

/** Traduce el resultado de la prueba real en estado, detalle visible y pasos. */
export function interpretChromeProbe(profile: ChromeProfile, result: StdioProbeResult, opts: { launcherPath?: string; browserChecked: boolean; busyBy?: string }): ChromeProbeOutcome {
  if (result.ok) {
    const n = result.tools.length;
    const extra = opts.browserChecked ? '' : opts.busyBy ? ` · en uso por ${opts.busyBy} (no se probó el navegador)` : ' · navegador sin probar';
    return { status: 'connected', detail: `${label(profile)} · ${n} herramienta${n === 1 ? '' : 's'}${extra}`, steps: [], tools: n };
  }
  const tail = result.stderr.length ? ` (${result.stderr.slice(-2).join(' / ')})` : '';
  if (result.stage !== 'call') {
    const where = opts.launcherPath ?? `chrome-${profile}.cmd`;
    const what = result.reason === 'timeout' ? 'no respondió a tiempo' : 'no arrancó';
    return {
      status: 'error',
      detail: `${label(profile)}: el MCP de Chrome ${what}: ${result.message}${tail}`.slice(0, 500),
      steps: [
        `Comprueba que existe ${where} y su carpeta node_modules (en C:\\dev\\agent-hub\\tools\\browser, npm install con el Node de Windows).`,
        'Vuelve a pulsar Conectar.',
      ],
      tools: result.tools.length,
    };
  }
  const text = result.message;
  if (profile === 'agente' && /already running/i.test(text)) {
    return {
      status: 'error',
      detail: `${label(profile)}: ya hay un Chrome abierto con el perfil de los agentes (otro agente o una sesión tuya lo está usando).`,
      steps: ['Cierra la ventana de Chrome del perfil de los agentes o espera a que el otro agente termine.', 'Vuelve a pulsar Conectar.'],
      tools: result.tools.length,
    };
  }
  if (profile === 'personal') {
    const timeout = result.reason === 'timeout';
    return {
      status: 'error',
      detail: timeout
        ? `${label(profile)}: Chrome no respondió. ¿Aceptaste el aviso de depuración remota?`
        : `${label(profile)}: no se pudo conectar con tu Chrome (${text.slice(0, 200)}).`,
      steps: [...PERSONAL_STEPS],
      tools: result.tools.length,
    };
  }
  return {
    status: 'error',
    detail: `${label(profile)}: el MCP no pudo abrir Chrome (${text.slice(0, 200)}).`,
    steps: ['Comprueba que Chrome está instalado y que nadie más usa la carpeta chrome-profile.', 'Vuelve a pulsar Conectar.'],
    tools: result.tools.length,
  };
}
