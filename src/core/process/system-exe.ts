import { win32 } from 'node:path';

/**
 * Ruta absoluta de un programa de Windows en `%SystemRoot%\System32` (`taskkill.exe`, `cmd.exe`…). En Windows,
 * `spawn` sin shell busca primero en el cwd: con un nombre suelto y el cwd en un worktree, un `taskkill.exe` del
 * agente se lanzaría en su lugar.
 */
export function systemExe(name: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'SYSTEMROOT');
  return win32.join((key && env[key]) || 'C:\\Windows', 'System32', name);
}
