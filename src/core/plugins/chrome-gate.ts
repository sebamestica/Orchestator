/**
 * Puerta MCP por stdio para el Chrome personal: un proxy delante de `chrome-devtools-mcp` que hace que un solo agente
 * a la vez maneje tu Chrome. Lo lanzan los agentes (Claude, Codex, la mente y sus subagentes) como servidor
 * `chrome-personal`; el núcleo lo arma en `chromeServerSpec`.
 *
 *   node chrome-gate.ts --lock chrome-personal --agent <id> --task <id> --locks-root <carpeta>
 *                       [--wait-ms N] [--idle-ms N] [--retry-ms N] -- <comando> [args…]
 *
 * - Todo pasa tal cual en las dos direcciones (JSON-RPC delimitado por saltos de línea), salvo `tools/call`.
 * - En la primera `tools/call` toma el candado `--lock` de `--locks-root` (el de la skill `local-compute-scheduling`,
 *   `C:\dev\agent-hub\locks`). Si otro lo tiene, la llamada **espera** hasta `--wait-ms`; si sigue ocupado, responde
 *   esa llamada con un error claro (quién lo tiene, «no abras otro navegador») sin pasarla al servidor.
 * - Suelta el candado tras `--idle-ms` sin llamadas en curso, al cerrarse stdin, al terminar el servidor o con una
 *   señal. Un agente que nunca navega no toma el candado.
 * - Si el dueño anterior fue una puerta (o la prueba de conexión) de esta máquina cuyo proceso ya no existe (lo
 *   terminaron a la fuerza), libera su candado y sigue (`isAbandonedChromeHolder`).
 * - `notifications/cancelled` de una llamada que aún espera la descarta (el servidor nunca la vio).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { idSchema } from '../../shared/index.ts';
import { LockError, LockManager } from '../locks/manager.ts';
import type { LockHandle } from '../locks/manager.ts';
import { lockNameSchema } from '../locks/names.ts';
import type { LockHolder } from '../locks/owner.ts';
import { systemExe } from '../process/system-exe.ts';
import { BERLAND_CHROME_NOTE, DEFAULT_GATE_IDLE_MS, DEFAULT_GATE_WAIT_MS, describeChromeHolder, isAbandonedChromeHolder } from './chrome.ts';

export interface GateOptions {
  lock: string;
  agent: string;
  task: string;
  locksRoot: string;
  waitMs: number;
  idleMs: number;
  retryMs: number;
  command: string;
  args: string[];
}

export const GATE_USAGE =
  'Uso: node chrome-gate.ts --lock <candado> --agent <id> --task <id> --locks-root <carpeta> [--wait-ms N] [--idle-ms N] [--retry-ms N] -- <comando> [args…]';

/** Lee los argumentos de la puerta. Lanza `Error` con el motivo si falta o sobra algo. */
export function parseGateArgs(argv: readonly string[]): GateOptions {
  const cut = argv.indexOf('--');
  if (cut === -1 || cut === argv.length - 1) throw new Error('falta `-- <comando>`');
  const own = argv.slice(0, cut);
  const [command, ...args] = argv.slice(cut + 1);
  const values = new Map<string, string>();
  for (let i = 0; i < own.length; i += 2) {
    const key = own[i];
    const value = own[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`argumento inválido: ${String(key)}`);
    values.set(key.slice(2), value);
  }
  const need = (k: string) => {
    const v = values.get(k);
    if (v === undefined) throw new Error(`falta --${k}`);
    return v;
  };
  const ms = (k: string, fallback: number) => {
    const raw = values.get(k);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`--${k} debe ser un número ≥ 0`);
    return n;
  };
  const known = new Set(['lock', 'agent', 'task', 'locks-root', 'wait-ms', 'idle-ms', 'retry-ms']);
  for (const k of values.keys()) if (!known.has(k)) throw new Error(`argumento desconocido: --${k}`);
  const lock = lockNameSchema.parse(need('lock'));
  const agent = idSchema.parse(need('agent'));
  const task = idSchema.parse(need('task'));
  const locksRoot = need('locks-root');
  if (!isAbsolute(locksRoot)) throw new Error('--locks-root debe ser una ruta absoluta');
  if (!command) throw new Error('falta el comando');
  return { lock, agent, task, locksRoot, waitMs: ms('wait-ms', DEFAULT_GATE_WAIT_MS), idleMs: ms('idle-ms', DEFAULT_GATE_IDLE_MS), retryMs: ms('retry-ms', 1000), command, args };
}

/** Texto para el agente cuando el Chrome sigue ocupado tras la espera. */
export function busyText(holder: LockHolder | undefined, waitedMs: number, now: Date = new Date()): string {
  const who = holder ? describeChromeHolder(holder, now) : 'otro agente';
  const waited = Math.max(1, Math.round(waitedMs / 60_000));
  return `El Chrome personal lo está usando ${who} y no se liberó tras esperar ${waited} min. No abras otro navegador ni uses otra herramienta de navegador: vuelve a intentarlo en unos minutos o, si no puedes esperar, dilo en tu informe.`;
}

type RpcId = string | number;
interface RpcLike {
  id?: RpcId | null;
  method?: string;
  params?: { requestId?: RpcId };
}

function parseRpc(line: string): RpcLike | undefined {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as RpcLike) : undefined;
  } catch {
    return undefined;
  }
}

const idKey = (id: RpcId) => `${typeof id}:${String(id)}`;

export interface ChromeGateDeps {
  /** Línea hacia el servidor MCP real (sin salto de línea). */
  toServer(line: string): void;
  /** Línea hacia el cliente (el agente). */
  toClient(line: string): void;
  locks?: Pick<LockManager, 'acquire' | 'releaseAbandoned'>;
  log?: (line: string) => void;
  now?: () => Date;
  /** Para pruebas: qué candados se consideran abandonados. */
  isAbandoned?: (holder: LockHolder) => boolean;
}

/** La lógica de la puerta, sin procesos (la usan `main` y las pruebas). */
export class ChromeGate {
  readonly #opts: Omit<GateOptions, 'command' | 'args'>;
  readonly #deps: ChromeGateDeps;
  readonly #locks: Pick<LockManager, 'acquire' | 'releaseAbandoned'>;
  readonly #stop = new AbortController();
  readonly #inFlight = new Set<string>();
  /** Llamadas que esperan el candado (para descartarlas si el cliente las cancela). */
  readonly #waiting = new Map<string, { cancelled: boolean }>();
  #held: LockHandle | undefined;
  #acquiring: Promise<{ ok: true } | { ok: false; text: string }> | undefined;
  #idle: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(opts: Omit<GateOptions, 'command' | 'args'>, deps: ChromeGateDeps) {
    this.#opts = opts;
    this.#deps = deps;
    this.#locks = deps.locks ?? new LockManager({ root: opts.locksRoot });
  }

  /** ¿Tiene el candado ahora? */
  get holding(): boolean {
    return this.#held !== undefined;
  }

  onClientLine(line: string): void {
    const msg = parseRpc(line);
    if (msg?.method === 'notifications/cancelled' && msg.params?.requestId !== undefined) {
      const waiting = this.#waiting.get(idKey(msg.params.requestId));
      if (waiting) {
        waiting.cancelled = true;
        return;
      }
    }
    if (msg?.method !== 'tools/call' || msg.id === undefined || msg.id === null) {
      this.#deps.toServer(line);
      return;
    }
    void this.#call(msg.id, line);
  }

  onServerLine(line: string): void {
    const msg = parseRpc(line);
    if (msg && msg.method === undefined && msg.id !== undefined && msg.id !== null && this.#inFlight.delete(idKey(msg.id))) this.#armIdle();
    this.#deps.toClient(line);
  }

  /** Suelta el candado y corta las esperas. Idempotente. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#stop.abort();
    if (this.#idle) clearTimeout(this.#idle);
    await this.#release('cierre');
  }

  async #call(id: RpcId, line: string): Promise<void> {
    const key = idKey(id);
    const entry = { cancelled: false };
    this.#waiting.set(key, entry);
    if (this.#idle) clearTimeout(this.#idle);
    const got = await this.#ensure();
    this.#waiting.delete(key);
    if (entry.cancelled || this.#closed) {
      this.#armIdle();
      return;
    }
    if (!got.ok) {
      this.#deps.toClient(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: got.text }], isError: true } }));
      this.#armIdle();
      return;
    }
    this.#inFlight.add(key);
    this.#deps.toServer(line);
  }

  #ensure(): Promise<{ ok: true } | { ok: false; text: string }> {
    if (this.#held) return Promise.resolve({ ok: true });
    this.#acquiring ??= this.#acquire().finally(() => {
      this.#acquiring = undefined;
    });
    return this.#acquiring;
  }

  async #acquire(): Promise<{ ok: true } | { ok: false; text: string }> {
    const now = this.#deps.now ?? (() => new Date());
    const abandoned = this.#deps.isAbandoned ?? ((h: LockHolder) => isAbandonedChromeHolder(h));
    const started = performance.now();
    let holder: LockHolder | undefined;
    let announced = false;
    for (;;) {
      if (this.#closed) return { ok: false, text: 'La sesión terminó mientras esperaba el Chrome personal.' };
      // Si el cliente canceló todas las llamadas que esperaban, no hace falta el candado.
      if ([...this.#waiting.values()].every((w) => w.cancelled)) return { ok: false, text: 'Llamada cancelada.' };
      try {
        this.#held = await this.#locks.acquire(this.#opts.lock, { agent: this.#opts.agent, task: this.#opts.task, note: `${BERLAND_CHROME_NOTE} · puerta MCP` }, { timeoutMs: 0 });
        this.#deps.log?.(`candado ${this.#opts.lock} tomado`);
        return { ok: true };
      } catch (err) {
        if (!(err instanceof LockError) || err.code !== 'busy') {
          const why = err instanceof Error ? err.message : String(err);
          this.#deps.log?.(`no se pudo tomar ${this.#opts.lock}: ${why}`);
          return { ok: false, text: `No se pudo tomar el candado del Chrome personal (${why.slice(0, 200)}). No abras otro navegador: dilo en tu informe.` };
        }
        holder = err.holder;
      }
      if (holder && abandoned(holder)) {
        try {
          await this.#locks.releaseAbandoned(this.#opts.lock, abandoned);
          this.#deps.log?.(`candado ${this.#opts.lock} abandonado (pid ${String(holder.pid)} ya no existe): liberado`);
        } catch (err) {
          this.#deps.log?.(`no se pudo liberar el candado abandonado: ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }
      const elapsed = performance.now() - started;
      if (elapsed >= this.#opts.waitMs) return { ok: false, text: busyText(holder, elapsed, now()) };
      if (!announced) {
        announced = true;
        this.#deps.log?.(`${this.#opts.lock} ocupado por ${holder ? describeChromeHolder(holder, now()) : 'otro'}: esperando`);
      }
      try {
        await sleep(Math.max(1, Math.min(this.#opts.retryMs * (0.75 + Math.random() * 0.5), this.#opts.waitMs - elapsed)), undefined, { signal: this.#stop.signal });
      } catch {
        return { ok: false, text: 'La sesión terminó mientras esperaba el Chrome personal.' };
      }
    }
  }

  #armIdle(): void {
    if (this.#idle) clearTimeout(this.#idle);
    if (this.#closed || !this.#held || this.#inFlight.size > 0 || this.#waiting.size > 0) return;
    this.#idle = setTimeout(() => {
      if (this.#inFlight.size === 0 && this.#waiting.size === 0) void this.#release('inactividad');
    }, this.#opts.idleMs);
    this.#idle.unref();
  }

  async #release(why: string): Promise<void> {
    const held = this.#held;
    this.#held = undefined;
    if (!held) return;
    try {
      await held.release();
      this.#deps.log?.(`candado ${held.name} soltado (${why})`);
    } catch (err) {
      if (!(err instanceof LockError && err.code === 'not_held')) this.#deps.log?.(`no se pudo soltar ${held.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Termina el servidor y sus hijos (en Windows `cmd.exe /c x.cmd` deja a Node como nieto). */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync(systemExe('taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

async function main(): Promise<void> {
  const log = (line: string) => process.stderr.write(`chrome-gate: ${line}\n`);
  let opts: GateOptions;
  try {
    opts = parseGateArgs(process.argv.slice(2));
  } catch (err) {
    log(`${err instanceof Error ? err.message : String(err)}\n${GATE_USAGE}`);
    process.exit(2);
  }
  const child = spawn(opts.command, opts.args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  child.stdin.on('error', () => undefined);
  process.stdout.on('error', () => undefined);
  const gate = new ChromeGate(opts, {
    toServer: (line) => {
      if (child.stdin.writable) child.stdin.write(`${line}\n`);
    },
    toClient: (line) => {
      process.stdout.write(`${line}\n`);
    },
    log,
  });
  let finishing = false;
  const finish = async (code: number) => {
    if (finishing) return;
    finishing = true;
    await gate.close();
    killTree(child);
    process.exit(code);
  };
  createInterface({ input: child.stdout }).on('line', (line) => gate.onServerLine(line));
  createInterface({ input: process.stdin }).on('line', (line) => gate.onClientLine(line));
  // Convención de MCP por stdio: el cliente cierra stdin para terminar. Se lo pasamos al servidor y le damos un poco.
  process.stdin.on('end', () => {
    child.stdin.end();
    setTimeout(() => void finish(0), 3000).unref();
  });
  child.on('exit', (code) => void finish(code ?? 0));
  child.on('error', (err) => {
    log(`no se pudo lanzar ${opts.command}: ${err.message}`);
    void finish(1);
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(signal, () => void finish(0));
}

function isMain(): boolean {
  try {
    const entry = process.argv[1];
    return entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) void main();
