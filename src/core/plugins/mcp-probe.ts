/**
 * Cliente MCP mínimo por stdio para comprobar un servidor de verdad: lo arranca, hace `initialize`,
 * `notifications/initialized`, `tools/list` (con paginación) y, si se pide, una `tools/call` que toca el recurso
 * real (p. ej. `list_pages` de chrome-devtools-mcp, que conecta o abre Chrome). Todo con tiempo límite. Al final
 * cierra stdin (convención de MCP por stdio), espera un poco y, si sigue vivo, termina el árbol de procesos.
 *
 * Mensajes JSON-RPC 2.0 delimitados por saltos de línea (especificación de MCP, transporte stdio).
 */
import { spawn as nodeSpawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { redactSecrets } from '../../shared/index.ts';
import { childEnv } from '../process/child-env.ts';
import { systemExe } from '../process/system-exe.ts';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

export interface StdioProbeOptions {
  command: string;
  args: readonly string[];
  /** Variables extra (el resto sale de `childEnv`, sin credenciales de proveedores). */
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  /** Arranque + `initialize` + `tools/list`. Por defecto 30 s (un `.cmd` de npm tarda en un PC ocupado). */
  startTimeoutMs?: number;
  /** Llamada que comprueba el recurso real. Sin ella, solo se listan herramientas. */
  call?: { name: string; arguments?: Record<string, unknown>; timeoutMs?: number };
  /** Espera tras cerrar stdin antes de terminar el árbol. Por defecto 3 s. */
  closeGraceMs?: number;
  spawn?: SpawnFn;
  clientVersion?: string;
}

export type ProbeStage = 'spawn' | 'initialize' | 'tools' | 'call';
export type ProbeFailure = 'timeout' | 'exit' | 'error' | 'tool_error' | 'invalid';

export type StdioProbeResult =
  | { ok: true; server?: { name: string; version?: string }; tools: string[]; callText?: string; stderr: string[] }
  | { ok: false; stage: ProbeStage; reason: ProbeFailure; message: string; tools: string[]; stderr: string[] };

class ProbeError extends Error {
  readonly stage: ProbeStage;
  readonly reason: ProbeFailure;
  constructor(stage: ProbeStage, reason: ProbeFailure, message: string) {
    super(message);
    this.stage = stage;
    this.reason = reason;
  }
}

const rpcMessageSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ code: z.number(), message: z.string() }).optional(),
});
const initializeResultSchema = z.looseObject({
  protocolVersion: z.string(),
  serverInfo: z.looseObject({ name: z.string(), version: z.string().optional() }).optional(),
});
const toolsListSchema = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string().min(1).max(200) })),
  nextCursor: z.string().optional(),
});
const toolCallSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).default([]),
  isError: z.boolean().optional(),
});

const STDERR_LINES = 10;
const MAX_PAGES = 20;

/** Termina el proceso y sus hijos (en Windows `cmd.exe /c x.cmd` deja a Node como nieto). */
function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawnSync(systemExe('taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
  }
  child.kill('SIGKILL');
}

export async function probeStdioMcp(opts: StdioProbeOptions): Promise<StdioProbeResult> {
  const spawn: SpawnFn = opts.spawn ?? ((cmd, args, o) => nodeSpawn(cmd, [...args], o));
  const stderr: string[] = [];
  const tools: string[] = [];
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(opts.command, opts.args, {
      cwd: opts.cwd ?? process.cwd(),
      env: childEnv(opts.env ?? {}),
      windowsHide: true,
      shell: false,
      stdio: 'pipe',
    });
  } catch (err) {
    return { ok: false, stage: 'spawn', reason: 'error', message: `No se pudo iniciar ${opts.command}: ${err instanceof Error ? err.message : String(err)}`, tools, stderr };
  }

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; stage: ProbeStage }>();
  let nextId = 1;
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;
  const exitWaiters: (() => void)[] = [];

  const failAll = (reason: ProbeFailure, message: string) => {
    for (const [id, p] of pending) {
      pending.delete(id);
      p.reject(new ProbeError(p.stage, reason, message));
    }
  };
  const send = (message: unknown) => {
    if (!child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  child.on('error', (err) => {
    spawnError = err;
    failAll('error', `No se pudo iniciar ${opts.command}: ${err.message}`);
  });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    failAll('exit', `El servidor MCP terminó (código ${String(code)}${signal ? `, señal ${signal}` : ''})`);
    for (const w of exitWaiters.splice(0)) w();
  });
  child.stdin.on('error', () => {
    /* el proceso cerró stdin: lo informa 'exit' */
  });
  child.stderr.setEncoding('utf8');
  createInterface({ input: child.stderr }).on('line', (line) => {
    const clean = redactSecrets(line).trim().slice(0, 300);
    if (!clean) return;
    stderr.push(clean);
    if (stderr.length > STDERR_LINES) stderr.splice(0, stderr.length - STDERR_LINES);
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return; // texto suelto en stdout: se ignora (algunos lanzadores imprimen avisos)
    }
    const parsed = rpcMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const msg = parsed.data;
    if (msg.method !== undefined) {
      // Petición del servidor (ping, roots/list…): este cliente no ofrece capacidades.
      if (msg.id !== undefined && msg.id !== null) {
        send(msg.method === 'ping' ? { jsonrpc: '2.0', id: msg.id, result: {} } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
      }
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new ProbeError(p.stage, 'error', `${msg.error.message} (código ${msg.error.code})`));
    else p.resolve(msg.result);
  });

  const request = (stage: ProbeStage, method: string, params: unknown, deadline: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (spawnError) return reject(new ProbeError(stage, 'error', spawnError.message));
      if (exited) return reject(new ProbeError(stage, 'exit', `El servidor MCP terminó (código ${String(exited.code)})`));
      const id = nextId++;
      const ms = Math.max(1, deadline - Date.now());
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new ProbeError(stage, 'timeout', `El servidor MCP no respondió a ${method} en ${Math.round(ms / 1000)} s`));
      }, ms);
      pending.set(id, {
        stage,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      send({ jsonrpc: '2.0', id, method, params });
    });

  const close = async () => {
    try {
      child.stdin.end();
    } catch {
      /* ya cerrado */
    }
    if (!exited && !spawnError) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, opts.closeGraceMs ?? 3000);
        exitWaiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    if (!exited && !spawnError) killTree(child);
  };

  try {
    const startDeadline = Date.now() + (opts.startTimeoutMs ?? 30_000);
    const init = initializeResultSchema.safeParse(
      await request('initialize', 'initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'orquestador', version: opts.clientVersion ?? '0.1.0' } }, startDeadline),
    );
    if (!init.success) throw new ProbeError('initialize', 'invalid', 'Respuesta de initialize inválida');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const list = toolsListSchema.safeParse(await request('tools', 'tools/list', cursor ? { cursor } : {}, startDeadline));
      if (!list.success) throw new ProbeError('tools', 'invalid', 'Respuesta de tools/list inválida');
      tools.push(...list.data.tools.map((t) => t.name));
      cursor = list.data.nextCursor;
      if (!cursor) break;
    }
    let callText: string | undefined;
    if (opts.call) {
      if (!tools.includes(opts.call.name)) throw new ProbeError('call', 'invalid', `El servidor no tiene la herramienta ${opts.call.name}`);
      const callDeadline = Date.now() + (opts.call.timeoutMs ?? 60_000);
      const res = toolCallSchema.safeParse(await request('call', 'tools/call', { name: opts.call.name, arguments: opts.call.arguments ?? {} }, callDeadline));
      if (!res.success) throw new ProbeError('call', 'invalid', `Respuesta de ${opts.call.name} inválida`);
      callText = redactSecrets(res.data.content.map((c) => c.text ?? '').join('\n').trim()).slice(0, 1000);
      if (res.data.isError) throw new ProbeError('call', 'tool_error', callText || `${opts.call.name} falló`);
    }
    const server = init.data.serverInfo ? { name: init.data.serverInfo.name, ...(init.data.serverInfo.version ? { version: init.data.serverInfo.version } : {}) } : undefined;
    return { ok: true, ...(server ? { server } : {}), tools, ...(callText !== undefined ? { callText } : {}), stderr };
  } catch (err) {
    const e = err instanceof ProbeError ? err : new ProbeError('initialize', 'error', err instanceof Error ? err.message : String(err));
    return { ok: false, stage: e.stage, reason: e.reason, message: redactSecrets(e.message).slice(0, 500), tools, stderr };
  } finally {
    await close();
  }
}
