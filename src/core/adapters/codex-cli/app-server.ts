import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { resolveCodexExecutable } from './executable.ts';
import type { CodexExecutable } from './executable.ts';
import { childEnv } from '../../process/child-env.ts';
import { systemExe } from '../../process/system-exe.ts';

/**
 * Termina el app-server sin bloquear el bucle de eventos del núcleo. En Windows el lanzador npm tiene un `codex.exe`
 * nativo como hijo: `taskkill /T` recorre el árbol y solo cuando termina se mata al lanzador, porque si muere antes
 * `taskkill` ya no encuentra el PID y el nativo queda huérfano.
 */
function stopTree(child: ChildProcess): void {
  const alive = () => child.exitCode === null && child.signalCode === null;
  if (!alive()) return;
  if (process.platform !== 'win32' || !child.pid) { child.kill(); return; }
  const fallback = () => { if (alive()) child.kill(); };
  const killer = spawn(systemExe('taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  // Sin oyente de 'error', un fallo al lanzar taskkill sería una excepción sin capturar en el núcleo.
  killer.once('error', fallback);
  killer.once('exit', fallback);
  killer.unref();
}

const responseSchema = z.object({ id: z.union([z.number(), z.string()]).optional(), result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional() });

/** JSON-RPC en JSONL, sin cabeceras LSP ni campo jsonrpc. Inicializa antes de leer cupos.
 * https://learn.chatgpt.com/docs/app-server#initialization
 * https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt
 */
export async function readCodexAppServer(executable: CodexExecutable = resolveCodexExecutable(), timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable.command, [...executable.args, 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: childEnv() });
    const lines = createInterface({ input: child.stdout });
    // Drenar stderr sin persistir diagnósticos potencialmente sensibles.
    child.stderr.resume();
    let settled = false;
    let initialized = false;
    const finish = (error: Error | undefined, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      // El resultado ya está leído: entregarlo sin esperar a que el árbol termine.
      if (error) reject(error); else resolve(value);
      stopTree(child);
    };
    const timer = setTimeout(() => finish(new Error('Timeout de Codex app-server')), timeoutMs);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on('error', () => finish(new Error('No se pudo iniciar Codex app-server')));
    child.stdin.on('error', () => finish(new Error('Se cerró stdin de Codex app-server')));
    child.on('close', () => finish(new Error('Codex app-server terminó sin respuesta')));
    lines.on('line', (line) => {
      let value: unknown;
      try { value = JSON.parse(line); } catch { finish(new Error('JSON inválido de Codex app-server')); return; }
      const parsed = responseSchema.safeParse(value);
      if (!parsed.success) { finish(new Error('Respuesta inválida de Codex app-server')); return; }
      const response = parsed.data;
      if (response.id !== 0 && response.id !== 1) return;
      if (response.error) { finish(new Error('Codex app-server rechazó la consulta')); return; }
      if (response.result === undefined) { finish(new Error('Codex app-server respondió sin result')); return; }
      if (response.id === 0 && !initialized) {
        initialized = true;
        send({ method: 'initialized', params: {} });
        send({ method: 'account/rateLimits/read', id: 1 });
      } else if (response.id === 1 && initialized) finish(undefined, response.result);
    });
    send({ method: 'initialize', id: 0, params: { clientInfo: { name: 'orquestador', title: 'Orquestador local', version: '0.1.0' } } });
  });
}
