import { parseArgs, type ParseArgsConfig } from 'node:util';
import { redactSecrets } from '../../shared/index.ts';

/** Entrada y salida del CLI (inyectables en pruebas). La salida nunca lleva la clave. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  env: Readonly<Record<string, string | undefined>>;
  /** Todo stdin (para la clave con `--stdin`). */
  readStdin(): Promise<string>;
  stdinIsTty: boolean;
  /** Líneas de stdin (orden `conversar`). */
  lines(): AsyncIterable<string>;
  /** Espera la orden de parar (Ctrl+C) en `iniciar`. */
  waitForStop(): Promise<void>;
}

export class CliError extends Error {
  override readonly name = 'CliError';
}

/** Rechaza cualquier argumento con forma de clave: la clave entra por `ANTHROPIC_API_KEY` o por stdin. */
export function assertNoSecretArgs(argv: readonly string[]): void {
  for (const arg of argv) {
    if (/^--?(api-?key|clave|key|token)(=|$)/i.test(arg) || redactSecrets(arg) !== arg) {
      throw new CliError('La clave nunca va como argumento: defínela en ANTHROPIC_API_KEY o pásala por stdin con --stdin.');
    }
  }
}

type Options = NonNullable<ParseArgsConfig['options']>;

/** `parseArgs` estricto con mensajes en español. */
export function parseFlags<O extends Options>(argv: readonly string[], options: O) {
  try {
    return parseArgs({ args: [...argv], options, strict: true, allowPositionals: false }).values;
  } catch (err) {
    throw new CliError(`Argumentos inválidos: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function parseUsd(text: string | undefined, flag: string): number | undefined {
  if (text === undefined) return undefined;
  const n = Number(text.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) throw new CliError(`${flag} debe ser un número positivo de USD`);
  return n;
}

/** Una clave nunca pasa de unos cientos de bytes: más que esto por stdin es un error (hallazgo 4 de Codex). */
export const MAX_STDIN_BYTES = 16 * 1024;
export const STDIN_TIMEOUT_MS = 30_000;

/** Lee un flujo hasta su fin con tope de bytes (se corta al superarlo, sin acumular más) y plazo. */
export async function readLimited(
  stream: AsyncIterable<unknown> & { destroy?: () => void },
  maxBytes = MAX_STDIN_BYTES,
  timeoutMs = STDIN_TIMEOUT_MS,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  let timer: NodeJS.Timeout | undefined;
  const read = (async () => {
    for await (const chunk of stream) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk as Uint8Array);
      size += buf.length;
      if (size > maxBytes) throw new CliError(`stdin: más de ${maxBytes} bytes; una clave no es tan larga.`);
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString('utf8');
  })();
  read.catch(() => undefined);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CliError(`stdin: no terminó en ${Math.round(timeoutMs / 1000)} s; pasa la clave y cierra la entrada.`)), timeoutMs);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    stream.destroy?.();
    chunks.fill(Buffer.alloc(0));
  }
}

/** Clave de `--stdin`, de `ANTHROPIC_API_KEY` o de stdin si no es una terminal. Nunca se imprime. */
export async function readApiKey(io: CliIo, fromStdin: boolean): Promise<{ key: string; source: 'stdin' | 'entorno' }> {
  if (!fromStdin) {
    const envKey = io.env.ANTHROPIC_API_KEY?.trim();
    if (envKey) return { key: envKey, source: 'entorno' };
  }
  if (fromStdin || !io.stdinIsTty) {
    const key = (await io.readStdin()).trim();
    if (key) return { key, source: 'stdin' };
  }
  throw new CliError('Falta la clave: define ANTHROPIC_API_KEY o pásala por stdin con --stdin.');
}

export const USAGE = [
  'Uso: node src/core/app/cli.ts <orden> [opciones]',
  '',
  'Órdenes:',
  '  agregar-claude [--url <baseUrl>] [--presupuesto <usd>] [--id claude] [--nombre <texto>] [--modelo <id>] [--stdin] [--reemplazar]',
  '      Prueba la clave (ANTHROPIC_API_KEY o stdin), la guarda en la bóveda DPAPI y registra el agente.',
  '  agentes                 Lista los agentes (sin claves) y su gasto registrado.',
  '  iniciar [--abrir]       Arranca el núcleo en 127.0.0.1 e imprime URL, token y el enlace web; --abrir lo abre.',
  '  probar-claude [--agente <id>]',
  '      Ejecuta «Responde exactamente: OK» con la clave de la bóveda (sin variables de entorno).',
  '  conversar [--agente <id>] [--proyecto <id>] [--carpeta <ruta>] [--presupuesto <usd>]',
  '      Conversa con el orquestador por la terminal (una línea = un mensaje; /salir para terminar).',
  '',
  'Datos: %LOCALAPPDATA%\\orquestador (ORQ_DATA_DIR la reemplaza).',
].join('\n');
