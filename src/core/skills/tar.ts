import { join } from 'node:path';
import { safeSegments, UnsafePathError } from '../memory/safe-fs.ts';
import { runJsonl } from '../process/run-jsonl.ts';

/** Línea de un proceso lanzado (sin shell). Las de salida llegan recortadas y sin vacías. */
export type ToolLine =
  | { kind: 'out'; line: string }
  | { kind: 'err'; line: string }
  | { kind: 'exit'; code: number | null; timedOut: boolean; aborted: boolean };

/**
 * Lanza un programa por ruta absoluta con argumentos en arreglo y entrega su salida línea a línea.
 * Con `signal` se puede cortar a mitad (el proceso se mata). Inyectable en las pruebas.
 */
export type ToolRunner = (command: string, args: readonly string[], opts: { cwd: string; timeoutMs: number; signal?: AbortSignal }) => AsyncIterable<ToolLine>;

/** Ejecutor por defecto: reutiliza `runJsonl` (spawn sin shell, timeout, mata el árbol en Windows). */
export const runTool: ToolRunner = async function* (command, args, opts) {
  const run = runJsonl({ command, args, cwd: opts.cwd, timeoutMs: opts.timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) });
  for await (const item of run) {
    if (item.kind === 'json' || item.kind === 'text') yield { kind: 'out', line: item.line };
    else if (item.kind === 'stderr') yield { kind: 'err', line: item.line };
    else yield { kind: 'exit', code: item.code, timedOut: item.timedOut, aborted: item.aborted };
  }
};

/**
 * Ruta absoluta del `tar.exe` de Windows (bsdtar, lee y escribe zip). Absoluta a propósito:
 * en Windows `spawn` busca primero en la carpeta actual, y una skill podría traer su propio `tar.exe`.
 */
export function defaultTarPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== 'win32') return '/usr/bin/bsdtar';
  return join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'tar.exe');
}

export interface ZipEntry {
  /** Nombre tal como lo imprime `tar -tf` (bsdtar escapa los caracteres de control con `\`). */
  name: string;
  /** Primer carácter del modo en `tar -tvf`: `-` archivo, `d` carpeta, `l` enlace, `h` enlace duro… */
  type: string;
  size: number;
}

export interface ZipListing {
  entries: ZipEntry[];
  /** Problemas que impiden extraer (rutas peligrosas, enlaces, límites). Vacío si es seguro. */
  problems: string[];
  totalBytes: number;
}

export interface ZipLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  /** Entradas totales (archivos + carpetas + lo demás): frena las bombas de carpetas vacías. */
  maxEntries: number;
  /** Segmentos de ruta como máximo (`a/b/c.md` = 3). */
  maxDepth: number;
}

/** Problemas como mucho en un informe: el resto se resume en una línea. */
const MAX_PROBLEMS = 50;

function capProblems(problems: string[]): string[] {
  if (problems.length <= MAX_PROBLEMS) return problems;
  return [...problems.slice(0, MAX_PROBLEMS), `… y ${problems.length - MAX_PROBLEMS} problemas más`];
}

/** Segmentos de un nombre de entrada, sin `.` ni vacíos. */
export function entryDepth(name: string): number {
  return name.split('/').filter((s) => s !== '' && s !== '.').length;
}

/**
 * Comprueba un nombre de entrada del zip con `safeSegments` (rechaza rutas absolutas, unidades,
 * UNC, `..`, `:` de flujos alternos de NTFS, nombres reservados de Windows y segmentos que acaban
 * en punto o espacio) y además cualquier `\\`: bsdtar escapa así los caracteres de control, y en
 * un zip el separador correcto es `/`. La entrada `./` (la propia raíz) se admite.
 */
export function entryNameProblem(name: string): string | undefined {
  if (name.includes('\\')) return 'contiene «\\» (separador de Windows o carácter de control escapado)';
  if (/^(?:\.\/)+$/.test(name) || name === '.') return undefined;
  try {
    safeSegments(name);
    return undefined;
  } catch (err) {
    if (err instanceof UnsafePathError) return err.message;
    throw err;
  }
}

export class TarError extends Error {
  override readonly name = 'TarError';
  readonly stderr: string[];
  constructor(message: string, stderr: string[]) {
    super(message);
    this.stderr = stderr;
  }
}

export interface TarOptions {
  tarPath?: string;
  run?: ToolRunner;
  timeoutMs?: number;
}

/** Envoltorio de `tar` para zips: listar, validar, extraer y crear. Nunca ejecuta el contenido. */
export class Tar {
  readonly path: string;
  private readonly run: ToolRunner;
  private readonly timeoutMs: number;

  constructor(opts: TarOptions = {}) {
    this.path = opts.tarPath ?? defaultTarPath();
    this.run = opts.run ?? runTool;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /**
   * Lanza tar y pasa cada línea de salida a `onLine`; si devuelve false, corta el proceso
   * (no se acumula el resto) y devuelve `'cortado'`. Si no, exige código 0.
   */
  private async stream(args: readonly string[], cwd: string, what: string, onLine: (line: string) => boolean): Promise<'ok' | 'cortado'> {
    const ac = new AbortController();
    let cut = false;
    const stderr: string[] = [];
    let exit: Extract<ToolLine, { kind: 'exit' }> | undefined;
    for await (const item of this.run(this.path, args, { cwd, timeoutMs: this.timeoutMs, signal: ac.signal })) {
      if (item.kind === 'out') {
        if (!cut && !onLine(item.line)) { cut = true; ac.abort(); }
      } else if (item.kind === 'err') {
        if (stderr.length < 20) stderr.push(item.line);
      } else {
        exit = item;
      }
    }
    if (cut) return 'cortado';
    if (!exit) throw new TarError(`tar terminó sin código de salida al ${what}`, stderr);
    if (exit.timedOut) throw new TarError(`tar: tiempo agotado al ${what}`, stderr);
    if (exit.code !== 0) throw new TarError(`tar terminó con código ${String(exit.code)} al ${what}: ${stderr.slice(0, 5).join(' | ')}`, stderr);
    return 'ok';
  }

  /**
   * Lista el zip con `tar -tf` (nombres) y `tar -tvf` (tipo y tamaño) y valida cada entrada.
   * `-tf` no muestra los enlaces, por eso se cruza con la salida detallada, línea a línea.
   * La lectura se corta en cuanto hay más de `maxEntries` líneas: nunca se acumula más que eso.
   */
  async list(zipPath: string, cwd: string, limits: ZipLimits): Promise<ZipListing> {
    const tooMany = `más de ${limits.maxEntries} entradas en el zip (máximo ${limits.maxEntries}): listado interrumpido`;
    const names: string[] = [];
    const r1 = await this.stream(['-tf', zipPath], cwd, 'listar el zip', (line) => {
      if (names.length >= limits.maxEntries) return false;
      names.push(line);
      return true;
    });
    if (r1 === 'cortado') return { entries: [], problems: [tooMany], totalBytes: 0 };
    const verbose: string[] = [];
    const r2 = await this.stream(['-tvf', zipPath], cwd, 'listar el zip', (line) => {
      if (verbose.length >= limits.maxEntries) return false;
      verbose.push(line);
      return true;
    });
    if (r2 === 'cortado') return { entries: [], problems: [tooMany], totalBytes: 0 };

    const problems: string[] = [];
    if (names.length !== verbose.length) {
      problems.push(`listado inconsistente (${names.length} nombres y ${verbose.length} líneas detalladas): hay nombres en blanco o con saltos de línea`);
    }
    const entries: ZipEntry[] = [];
    let totalBytes = 0;
    let files = 0;
    for (const [i, name] of names.entries()) {
      const fields = (verbose[i] ?? '').trim().split(/\s+/);
      const mode = fields[0] ?? '';
      const type = mode[0] ?? '?';
      const size = Number(fields[4] ?? Number.NaN);
      entries.push({ name, type, size });
      const bad = entryNameProblem(name);
      if (bad) problems.push(`${name}: ${bad}`);
      const depth = entryDepth(name);
      if (depth > limits.maxDepth) problems.push(`${name}: profundidad ${depth} supera el máximo (${limits.maxDepth})`);
      if (type === 'l' || type === 'h' || / -> | link to /.test(verbose[i] ?? '')) problems.push(`${name}: es un enlace`);
      else if (type !== '-' && type !== 'd') problems.push(`${name}: tipo de entrada no permitido («${type}»)`);
      if (type === '-') {
        files++;
        if (!Number.isFinite(size)) problems.push(`${name}: tamaño ilegible en el listado`);
        else {
          totalBytes += size;
          if (size > limits.maxFileBytes) problems.push(`${name}: ${size} bytes supera el máximo por archivo (${limits.maxFileBytes})`);
        }
      }
    }
    if (names.length === 0) problems.push('el zip está vacío');
    if (files > limits.maxFiles) problems.push(`${files} archivos supera el máximo (${limits.maxFiles})`);
    if (totalBytes > limits.maxTotalBytes) problems.push(`${totalBytes} bytes descomprimidos supera el máximo (${limits.maxTotalBytes})`);
    return { entries, problems: capProblems(problems), totalBytes };
  }

  /** Extrae en `destDir` (que ya debe existir). Sin `-P`: bsdtar además rechaza `..` y `/` por su cuenta. */
  async extract(zipPath: string, destDir: string): Promise<void> {
    await this.stream(['-x', '-f', zipPath, '-C', destDir], destDir, 'extraer el zip', () => true);
  }

  /** Crea un zip (formato por la extensión, `-a`) con `member` dentro de `parentDir`, nombres en UTF-8. */
  async createZip(zipPath: string, parentDir: string, member: string): Promise<void> {
    if (!zipPath.toLowerCase().endsWith('.zip')) throw new TarError('el destino debe acabar en .zip', []);
    await this.stream(['-a', '-c', '-f', zipPath, '--options', 'zip:hdrcharset=UTF-8', '-C', parentDir, member], parentDir, 'crear el zip', () => true);
  }
}
