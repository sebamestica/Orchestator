/**
 * Plugin Chrome: tu Chrome personal, con tus sesiones, por el MCP `chrome-devtools-mcp` del hub
 * (`C:\dev\agent-hub\tools\browser\chrome-personal.cmd`, `--autoConnect`). Es la única vía de navegador para los
 * agentes de Berland: no hay perfil aislado ni otro Chrome. Requiere activar la depuración remota en
 * `chrome://inspect/#remote-debugging` y aceptar el aviso de Chrome.
 *
 * - `--autoConnect` solo se conecta (lee `DevToolsActivePort` de `%LOCALAPPDATA%\Google\Chrome\User Data`); si no
 *   puede, responde «Could not connect to Chrome» y nunca abre un Chrome propio. Conecta recién en la primera
 *   herramienta (no en `initialize` ni en `tools/list`), por eso la prueba real llama `list_pages`.
 * - Las pestañas nuevas por CDP se abren en el contexto por defecto del navegador: el último perfil usado
 *   (`profile.last_used` de `Local State`, hoy «Default»).
 * - Los agentes no lanzan el MCP directo: lo lanzan a través de la puerta (`chrome-gate.ts`), que toma el candado
 *   `chrome-personal` en la primera llamada y lo suelta al quedar ociosa.
 */
import { readFile, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { chromeProfileSchema } from '../../shared/index.ts';
import { describeHolder, type LockHolder } from '../locks/owner.ts';
import { systemExe } from '../process/system-exe.ts';
import type { McpStdioSpec } from './mcp.ts';
import type { StdioProbeResult } from './mcp-probe.ts';

/** Del contrato compartido. Solo `personal` es válido: `agente` (perfil aislado) se retiró en el issue 11. */
export type ChromeProfile = z.infer<typeof chromeProfileSchema>;

export const DEFAULT_BROWSER_TOOLS_DIR = 'C:\\dev\\agent-hub\\tools\\browser';

/** Nombre del servidor MCP y del candado (los mismos que usan las skills del hub). */
export const CHROME_SERVER = 'chrome-personal';
export const CHROME_LOCK = 'chrome-personal';

/** Inicio de la nota de los candados de Chrome que toma Berland (puerta y prueba de conexión). */
export const BERLAND_CHROME_NOTE = 'Berland: Chrome personal';

/** Espera por el candado en cada llamada de la puerta y tiempo ocioso antes de soltarlo. */
export const DEFAULT_GATE_WAIT_MS = 5 * 60_000;
export const DEFAULT_GATE_IDLE_MS = 3 * 60_000;
/**
 * Arranque de `chrome-personal` para el cliente MCP (Codex trae 10 s): la puerta, `cmd.exe`, el shim de npm y
 * `chrome-devtools-mcp` (bundle de ~8 MB) son dos Node y dos `cmd.exe`; con Defender escaneando tardan más.
 */
export const CHROME_STARTUP_TIMEOUT_SEC = 60;

/** La puerta MCP (`node chrome-gate.ts …`), junto a este archivo. */
export const CHROME_GATE_SCRIPT = fileURLToPath(new URL('./chrome-gate.ts', import.meta.url));

export interface ChromeLauncher {
  command: string;
  args: string[];
}

export function chromeLauncherPath(toolsDir = DEFAULT_BROWSER_TOOLS_DIR): string {
  return win32.join(toolsDir, 'chrome-personal.cmd');
}

/**
 * Opciones de `chrome-devtools-mcp` que Berland agrega al lanzador del hub (su `.cmd` las reenvía con `%*`).
 * - `--redact-network-headers`: `get_network_request` devuelve la cabecera `cookie` real (con las HttpOnly),
 *   `set-cookie` y `authorization` de las sesiones del usuario; con esto vuelven como `<redacted>`.
 * - `--no-file-navigations`: ningún agente abre `file:` en tu Chrome; la mente además lo tiene negado en la guardia
 *   (`plugin-policy.ts`).
 */
const LAUNCHER_FLAGS = ['--redact-network-headers', '--no-file-navigations'];

/** `cmd.exe /c <lanzador>` con la ruta absoluta de `cmd.exe` (un `cmd.exe` del worktree no se ejecuta en su lugar). */
export function defaultChromeLauncher(toolsDir = DEFAULT_BROWSER_TOOLS_DIR): ChromeLauncher {
  return { command: systemExe('cmd.exe'), args: ['/c', chromeLauncherPath(toolsDir), ...LAUNCHER_FLAGS] };
}

/** Nota para los agentes: el Chrome se comparte (con el usuario y con otros agentes). */
export const CHROME_TAB_NOTE =
  'Abre tu propia pestaña con `new_page`, trabaja solo en ella y ciérrala con `close_page` al terminar. No cierres, recargues ni navegues pestañas que no abriste: pueden ser del usuario o de otro agente.';
/** Una sola vía de navegador. */
export const CHROME_ONLY_NOTE =
  'Es el único navegador de esta sesión: el Chrome personal del usuario, con sus sesiones abiertas. Nunca abras otro navegador: ni el integrado de tu CLI, ni Playwright o Puppeteer, ni un perfil aparte (`chrome-agente`, `--userDataDir`). Si otro agente lo está usando, la herramienta espera; si responde que sigue ocupado, reintenta más tarde o dilo en tu informe.';
const PERSONAL_NOTE =
  'Entra solo a los sitios que pide la tarea, no escribas contraseñas ni datos de pago y no envíes formularios, compras ni mensajes sin que el encargo lo pida. Si un sitio pide iniciar sesión, pídeselo al usuario en tu informe.';
/** Para una sesión sin Chrome: que no busque otro navegador. */
export const NO_BROWSER_NOTE =
  'Esta sesión no tiene navegador (el plugin Chrome de Berland no está conectado para ti). No abras ninguno: ni el integrado de tu CLI, ni Playwright, ni otro Chrome. Si la tarea necesita navegar, dilo en tu informe.';

export interface ChromeGateIdentity {
  /** Agente y tarea dueños del candado (ids válidos de `idSchema`). */
  agent: string;
  task: string;
  /** Carpeta de candados (absoluta). */
  locksRoot: string;
  /** Node que ejecuta la puerta (por defecto el del núcleo). */
  node?: string;
  script?: string;
  waitMs?: number;
  idleMs?: number;
}

/** Argumentos de la puerta para un lanzador (deterministas: la mente compara su configuración entre mensajes). */
export function chromeGateArgs(launcher: ChromeLauncher, gate: ChromeGateIdentity): string[] {
  return [
    gate.script ?? CHROME_GATE_SCRIPT,
    '--lock', CHROME_LOCK,
    '--agent', gate.agent,
    '--task', gate.task,
    '--locks-root', gate.locksRoot,
    '--wait-ms', String(gate.waitMs ?? DEFAULT_GATE_WAIT_MS),
    '--idle-ms', String(gate.idleMs ?? DEFAULT_GATE_IDLE_MS),
    '--',
    launcher.command,
    ...launcher.args,
  ];
}

/** Servidor `chrome-personal` para un agente: la puerta delante del lanzador del hub. */
export function chromeServerSpec(launcher: ChromeLauncher, gate: ChromeGateIdentity): McpStdioSpec {
  const waitSec = Math.ceil((gate.waitMs ?? DEFAULT_GATE_WAIT_MS) / 1000);
  return {
    type: 'stdio',
    command: gate.node ?? process.execPath,
    args: chromeGateArgs(launcher, gate),
    instructions: `${CHROME_ONLY_NOTE} ${CHROME_TAB_NOTE} ${PERSONAL_NOTE}`,
    // Para el cliente MCP (Codex: `tool_timeout_sec`): la espera de la puerta más la llamada misma.
    toolTimeoutSec: waitSec + 120,
    startupTimeoutSec: CHROME_STARTUP_TIMEOUT_SEC,
  };
}

const PERSONAL_STEPS = [
  'Abre tu Chrome y entra a chrome://inspect/#remote-debugging.',
  'Activa «Permitir la depuración remota» (Allow remote debugging) y deja Chrome abierto.',
  'Pulsa Probar conexión y acepta el aviso de Chrome que pide permitir la conexión.',
];

/** Pasos a mano antes de conectar. */
export function chromeSteps(): string[] {
  return [...PERSONAL_STEPS];
}

export interface ChromeProbeOutcome {
  status: 'connected' | 'error';
  detail: string;
  steps: string[];
  tools: number;
}

/** Traduce el resultado de la prueba real en estado, detalle visible y pasos. */
export function interpretChromeProbe(result: StdioProbeResult, opts: { launcherPath?: string; browserChecked: boolean; busyBy?: string }): ChromeProbeOutcome {
  if (result.ok) {
    const n = result.tools.length;
    const extra = opts.browserChecked ? ' · conexión con tu Chrome comprobada' : opts.busyBy ? ` · en uso por ${opts.busyBy} (no se probó el navegador)` : ' · navegador sin probar';
    return { status: 'connected', detail: `Tu Chrome personal · ${n} herramienta${n === 1 ? '' : 's'}${extra}`, steps: [], tools: n };
  }
  const tail = result.stderr.length ? ` (${result.stderr.slice(-2).join(' / ')})` : '';
  if (result.stage !== 'call') {
    const where = opts.launcherPath ?? 'chrome-personal.cmd';
    const what = result.reason === 'timeout' ? 'no respondió a tiempo' : 'no arrancó';
    return {
      status: 'error',
      detail: `Tu Chrome personal: el MCP de Chrome ${what}: ${result.message}${tail}`.slice(0, 500),
      steps: [
        `Comprueba que existe ${where} y su carpeta node_modules (en C:\\dev\\agent-hub\\tools\\browser, npm install con el Node de Windows).`,
        'Vuelve a pulsar Probar conexión.',
      ],
      tools: result.tools.length,
    };
  }
  const timeout = result.reason === 'timeout';
  return {
    status: 'error',
    detail: timeout
      ? 'Tu Chrome personal no respondió. ¿Aceptaste el aviso de depuración remota?'
      : `No se pudo conectar con tu Chrome (${result.message.slice(0, 200)}).`,
    steps: [...PERSONAL_STEPS],
    tools: result.tools.length,
  };
}

// ------------------------------------------------------------------ estado vivo (solo lectura de archivos)

/** `%LOCALAPPDATA%\Google\Chrome\User Data` (la carpeta que lee `--autoConnect` en el canal estable). */
export function defaultChromeUserDataDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const local = env.LOCALAPPDATA ?? win32.join(env.USERPROFILE ?? 'C:\\Users\\Default', 'AppData', 'Local');
  return join(local, 'Google', 'Chrome', 'User Data');
}

const localStateSchema = z.looseObject({
  profile: z.looseObject({
    last_used: z.string().max(200).optional(),
    info_cache: z.record(z.string(), z.looseObject({ name: z.string().max(200).optional() })).optional(),
  }).optional(),
});

export interface ChromeProfileInfo {
  /** Carpeta del perfil (`Default`, `Profile 6`…). */
  dir: string;
  /** Nombre que muestra Chrome. */
  name?: string;
  /** Cuántos perfiles hay. */
  count: number;
}

/** Perfil donde se abren las pestañas nuevas: el último usado según `Local State`. `undefined` si no se puede leer. */
export async function readChromeProfile(userDataDir: string): Promise<ChromeProfileInfo | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(userDataDir, 'Local State'), 'utf8'));
  } catch {
    return undefined;
  }
  const parsed = localStateSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const cache = parsed.data.profile?.info_cache ?? {};
  const dir = parsed.data.profile?.last_used ?? 'Default';
  const name = cache[dir]?.name;
  return { dir, ...(name ? { name } : {}), count: Object.keys(cache).length };
}

/** ¿Chrome tiene activa la depuración remota? (`DevToolsActivePort` existe mientras está activa.) */
export async function remoteDebuggingOn(userDataDir: string): Promise<boolean> {
  try {
    return (await stat(join(userDataDir, 'DevToolsActivePort'))).isFile();
  } catch {
    return false;
  }
}

/** ¿Vive el proceso? `EPERM`: existe pero es de otro usuario. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
}

/**
 * Candado de Chrome abandonado: lo tomó Berland (puerta o prueba, siempre con el Node de Windows de esta máquina),
 * en este mismo equipo, y su proceso ya no existe. Solo esos se pueden liberar sin su token: un candado de la skill
 * o de un proceso de WSL (otro espacio de pids) nunca se toca.
 */
export function isAbandonedChromeHolder(holder: LockHolder, opts: { host?: string; alive?: (pid: number) => boolean } = {}): boolean {
  return (
    holder.format === 'json' &&
    holder.note?.startsWith(BERLAND_CHROME_NOTE) === true &&
    holder.host === (opts.host ?? hostname()) &&
    typeof holder.pid === 'number' &&
    !(opts.alive ?? pidAlive)(holder.pid)
  );
}

/** Quién tiene el candado, en palabras («codex-main (tarea t-1), hace 3 min»). */
export function describeChromeHolder(holder: LockHolder, now: Date = new Date()): string {
  if (!holder.agent) return describeHolder(holder);
  const at = holder.at ? Date.parse(holder.at) : Number.NaN;
  const min = Number.isFinite(at) ? Math.max(0, Math.floor((now.getTime() - at) / 60_000)) : undefined;
  const since = min === undefined ? '' : min === 0 ? ', hace menos de 1 min' : `, hace ${min} min`;
  return `${holder.agent} (tarea ${holder.task ?? '?'})${since}`;
}
