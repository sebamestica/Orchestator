import { redactSecrets } from '../../shared/index.ts';

type Now = () => Date;

/** Señales que detienen `iniciar` de forma ordenada (SIGHUP: en Windows, el cierre de la consola). */
export const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** Antepone la hora ISO a cada línea del registro del núcleo: la última línea antes de una muerte da su hora. */
export function stampedLog(write: (line: string) => void, now: Now = () => new Date()): (line: string) => void {
  return (line) => write(`${now().toISOString()} ${line}`);
}

/** Lo que `installExitLog` necesita del proceso (en producción, `process`). */
export interface ExitWatchable {
  readonly pid: number;
  on(event: 'exit', listener: (code: number) => void): unknown;
  on(event: 'uncaughtExceptionMonitor', listener: (err: unknown, origin: string) => void): unknown;
}

/**
 * Deja una línea con hora cuando el núcleo sale (fin normal o `process.exit`) o cae por una excepción sin atrapar.
 * `uncaughtExceptionMonitor` no cambia lo que hace Node (imprime la pila y sale). Una terminación brusca
 * (`taskkill /F`) no corre ningún manejador: esa la detecta la app de escritorio en la apertura siguiente.
 */
export function installExitLog(proc: ExitWatchable, write: (text: string) => void, now: Now = () => new Date()): void {
  const line = (text: string) => {
    try {
      write(`${now().toISOString()} ${text}\n`);
    } catch {
      // stderr ya cerrado: no hay dónde registrar.
    }
  };
  proc.on('exit', (code) => line(`núcleo sale (código ${code}, pid ${proc.pid})`));
  proc.on('uncaughtExceptionMonitor', (err, origin) => {
    const message = err instanceof Error ? err.message : String(err);
    line(`núcleo cae (${origin}, pid ${proc.pid}): ${redactSecrets(message).slice(0, 1000)}`);
  });
}
