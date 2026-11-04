import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { childEnv } from './child-env.ts';
import { systemExe } from './system-exe.ts';

export interface JsonlProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  /** Texto que se escribe en stdin y luego se cierra (p. ej. el encargo para `codex exec -`). */
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type JsonlLine =
  | { kind: 'json'; value: unknown; line: string }
  | { kind: 'text'; line: string }
  | { kind: 'stderr'; line: string }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; aborted: boolean };

/**
 * Lanza un CLI y entrega su salida línea a línea: JSON parseado cuando la línea lo es, texto si no.
 * Siempre termina con un elemento `exit`. Sin `shell: true`: los argumentos se pasan tal cual
 * (en Windows, lanzar `.cmd` requiere resolver antes el `.js`/`.exe` real).
 */
export async function* runJsonl(opts: JsonlProcessOptions): AsyncGenerator<JsonlLine> {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    // Sin credenciales heredadas: cada agente recibe solo las suyas en `opts.env`.
    env: childEnv(opts.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let timedOut = false;
  let aborted = false;
  const kill = () => {
    if (child.exitCode !== null) return;
    if (process.platform === 'win32' && child.pid) {
      // Mata el árbol completo (los CLI lanzan subprocesos).
      // Ruta absoluta: con el cwd en un worktree, `taskkill` a secas podría ser un ejecutable del agente.
      spawn(systemExe('taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  };
  const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs) : undefined;
  const onAbort = () => { aborted = true; kill(); };
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();

  const queue: JsonlLine[] = [];
  let wake: (() => void) | undefined;
  const push = (item: JsonlLine) => { queue.push(item); wake?.(); };

  createInterface({ input: child.stdout }).on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { push({ kind: 'json', value: JSON.parse(trimmed), line: trimmed }); return; } catch { /* no es JSON válido */ }
    }
    push({ kind: 'text', line: trimmed });
  });
  createInterface({ input: child.stderr }).on('line', (line) => { if (line.trim()) push({ kind: 'stderr', line }); });

  let exited = false;
  child.on('error', (err) => { push({ kind: 'stderr', line: `spawn error: ${err.message}` }); });
  child.on('close', (code, signal) => {
    exited = true;
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    push({ kind: 'exit', code, signal, timedOut, aborted });
  });

  if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
  else child.stdin.end();

  while (true) {
    const item = queue.shift();
    if (item) {
      yield item;
      if (item.kind === 'exit') return;
      continue;
    }
    if (exited && queue.length === 0) return;
    await new Promise<void>((resolve) => { wake = resolve; });
    wake = undefined;
  }
}
