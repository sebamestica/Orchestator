import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactSecrets } from '../../../../src/shared/redact.ts';

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Registro del proceso principal (`logs/escritorio.log`). Cada línea pasa por `redactSecrets` con los
 * secretos vivos (el token del núcleo): nunca queda un token en claro en disco.
 */
export function createFileLog(path: string, secrets: () => readonly string[], now: () => Date = () => new Date()): (line: string) => void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // Primera vez: el archivo aún no existe.
  }
  return (line) => {
    const clean = redactSecrets(line, secrets()).replace(/[\r\n]+/g, ' ').slice(0, 2000);
    try {
      appendFileSync(path, `${now().toISOString()} ${clean}\n`);
    } catch {
      // Un registro que falla no debe tumbar la app.
    }
  };
}
