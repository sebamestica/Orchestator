import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CodexExecutable { command: string; args: readonly string[] }

/** Evita el shim .cmd: Node ejecuta directamente el punto de entrada npm. */
export function resolveCodexExecutable(env: NodeJS.ProcessEnv = process.env): CodexExecutable {
  const appData = env.APPDATA ?? join(env.USERPROFILE ?? homedir(), 'AppData', 'Roaming');
  return { command: process.execPath, args: [join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')] };
}
