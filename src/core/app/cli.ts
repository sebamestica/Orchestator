import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { redactSecrets } from '../../shared/index.ts';
import { agentes, agregarClaude, iniciar, probarClaude } from './cli-commands.ts';
import { CliError, readLimited, USAGE, type CliIo } from './cli-io.ts';
import { compose, type ComposeOptions, type Composition } from './compose.ts';
import { installExitLog, stampedLog, STOP_SIGNALS } from './core-log.ts';

type Command = (argv: readonly string[], io: CliIo, comp: Composition) => Promise<number>;

/** Órdenes del CLI; las perezosas se importan solo al usarlas. */
const COMMANDS: Record<string, Command | (() => Promise<Command>)> = {
  'agregar-claude': agregarClaude,
  agentes,
  iniciar,
  'probar-claude': probarClaude,
  // Carga el SDK de agentes y el orquestador de c11 solo al usarla.
  conversar: async () => (await import('./cli-conversar.ts')).conversar,
};
const LAZY = new Set(['conversar']);

export type MakeComposition = (io: CliIo, opts: { verbose: boolean }) => Composition;

/** Composición del CLI: configuración del entorno (ORQ_*); el registro, con hora, va a stderr solo con `iniciar`. */
export const defaultComposition: MakeComposition = (io, { verbose }) => {
  const opts: ComposeOptions = { env: io.env, ...(verbose ? { log: stampedLog((line) => io.err(line)) } : {}) };
  return compose(opts);
};

/** Ejecuta una orden y devuelve el código de salida. Los errores se muestran tachados, sin pila. */
export async function runCli(argv: readonly string[], io: CliIo, make: MakeComposition = defaultComposition): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === '--help' || name === '-h' || name === 'ayuda') {
    io.out(USAGE);
    return name ? 0 : 2;
  }
  const entry = COMMANDS[name];
  if (!entry) {
    io.err(`Orden desconocida: ${redactSecrets(name)}\n\n${USAGE}`);
    return 2;
  }
  let comp: Composition | undefined;
  try {
    const command = LAZY.has(name) ? await (entry as () => Promise<Command>)() : (entry as Command);
    comp = make(io, { verbose: name === 'iniciar' });
    return await command(rest, io, comp);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const key = io.env.ANTHROPIC_API_KEY;
    io.err(`Error: ${redactSecrets(message, key ? [key] : [])}`.slice(0, 1000));
    return err instanceof CliError ? 2 : 1;
  } finally {
    await comp?.shutdown();
  }
}

/** E/S real del proceso. */
export function nodeIo(): CliIo {
  return {
    out: (line) => void process.stdout.write(`${line}\n`),
    err: (line) => void process.stderr.write(`${line}\n`),
    env: process.env,
    stdinIsTty: process.stdin.isTTY === true,
    readStdin: () => readLimited(process.stdin),
    lines() {
      return createInterface({ input: process.stdin, crlfDelay: Infinity });
    },
    waitForStop() {
      return new Promise<void>((resolve) => {
        const stop = (signal: NodeJS.Signals) => {
          process.stderr.write(`${new Date().toISOString()} núcleo se detiene por ${signal}\n`);
          resolve();
        };
        for (const signal of STOP_SIGNALS) process.once(signal, stop);
      });
    },
  };
}

// `node src/core/app/cli.ts <orden>`: el proceso termina al acabar la orden (el CLI de Claude puede tardar en soltarlo).
if (import.meta.main) {
  // Si quien leía stdout (la ventana de Berland) murió, una escritura no debe tumbar al núcleo (EPIPE).
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });
  const argv = process.argv.slice(2);
  // El núcleo deja con hora su salida o su caída en stderr (el registro de la app de escritorio).
  if (argv[0] === 'iniciar') installExitLog(process, (text) => writeSync(2, text));
  const code = await runCli(argv, nodeIo());
  process.exit(code);
}
