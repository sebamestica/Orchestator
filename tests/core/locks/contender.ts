/**
 * Proceso competidor para la prueba de carrera entre procesos (no es un archivo de prueba).
 * Uso: node contender.ts <raíz> <agente> [candado]
 * Escribe `ready`, espera una línea por stdin (la señal de salida) e intenta tomar el candado
 * sin espera. No lo libera: la prueba comprueba quién quedó como dueño y limpia la raíz.
 */
import { createInterface } from 'node:readline';
import { LockError, LockManager } from '../../../src/core/locks/index.ts';

const [root, agent, lock = 'gpu'] = process.argv.slice(2);
if (!root || !agent) {
  process.stderr.write('uso: contender.ts <raíz> <agente> [candado]\n');
  process.exit(2);
}

const manager = new LockManager({ root });
const report = (result: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ agent, pid: process.pid, ...result })}\n`);
const input = createInterface({ input: process.stdin });
input.once('line', () => {
  input.close();
  manager.acquire(lock, { agent, task: 'carrera' }).then(
    () => report({ won: true }),
    (error: unknown) => report({ won: false, code: error instanceof LockError ? error.code : String(error) }),
  );
});
process.stdout.write('ready\n');
