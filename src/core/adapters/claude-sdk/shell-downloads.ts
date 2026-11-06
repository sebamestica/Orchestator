import path from 'node:path';
import { parseShell, type ShellKind, type Word } from './shell-parse.ts';
import { cdTarget, commandName, isCdCommand, pathKey, POSIX_SHELLS, POWERSHELL_VALUE_OPTS, POWERSHELLS, resolveShellPath, shellCommandProblem, URL_LIKE, WRAPPERS } from './shell-policy.ts';

/**
 * Descargas de una sesión de shell: lo que un comando baja de internet no lo ejecuta la misma sesión, ni después de
 * renombrarlo o copiarlo. Aquí se detecta qué rutas escribe una descarga; la política de shell niega ejecutarlas
 * (`untrusted` de `shellCommandProblem`). Cada guardia (la de la mente y el hook de los workers) guarda las de su sesión.
 *
 * Riesgo residual: lo que extrae un archivo comprimido bajado, lo que la sesión vuelve a escribir con Write tras leerlo
 * y lo bajado antes de reiniciar o reanudar la sesión (la memoria es del proceso).
 */

const MAX_DEPTH = 3;
/** URL con esquema o del estilo `host.tld/ruta` (wget y curl la aceptan sin `https://`). */
const looksLikeUrl = (text: string) => URL_LIKE.test(text) || /^[\w-]+(?:\.[\w-]+)+\/\S*$/.test(text);

const PS_WEB = new Set(['invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm']);
/** En una tubería que sale de una descarga, escriben su contenido. */
const PIPE_WRITERS = new Set(['tee', 'tee-object', 'out-file', 'set-content', 'add-content', 'ac']);
const MOVERS = new Set(['mv', 'cp', 'copy', 'move', 'ren', 'rename', 'copy-item', 'cpi', 'move-item', 'mi', 'rename-item', 'rni']);
const RENAMERS = new Set(['ren', 'rename', 'rename-item', 'rni']);

/** Último segmento de la ruta de una URL: el nombre que usan `curl -O` y `wget`. */
function urlFileName(url: string): string | undefined {
  try {
    return path.posix.basename(new URL(URL_LIKE.test(url) ? url : `https://${url}`).pathname) || undefined;
  } catch {
    return undefined;
  }
}

/** Ruta absoluta de una palabra, o undefined si no se puede verificar. */
function absOf(w: Word | undefined, cwd: string): string | undefined {
  const r = w ? resolveShellPath(w, cwd) : undefined;
  return r && 'abs' in r ? r.abs : undefined;
}

/** Parámetro de PowerShell abreviado (`-OutF`, `-OutFile:x`): su valor, o undefined. */
function psParam(args: readonly Word[], full: string, min: number): Word | undefined {
  for (let k = 0; k < args.length; k++) {
    const m = /^-([A-Za-z]+)(?::(.+))?$/.exec((args[k] as Word).text);
    if (!m || (m[1] as string).length < min || !full.startsWith((m[1] as string).toLowerCase())) continue;
    return m[2] !== undefined ? { ...(args[k] as Word), text: m[2] } : args[k + 1];
  }
  return undefined;
}

function curlOutputs(args: readonly Word[], cwd: string): string[] {
  const out: string[] = [];
  let remote = false;
  let dir = cwd;
  const at = (w: Word | undefined) => absOf(w, cwd);
  for (let k = 0; k < args.length; k++) {
    const t = (args[k] as Word).text;
    if (t === '--output' || /^-[A-Za-z]*o$/.test(t)) out.push(at(args[++k]) ?? '');
    else if (t.startsWith('--output=')) out.push(at({ ...(args[k] as Word), text: t.slice('--output='.length) }) ?? '');
    else if (t === '--output-dir') dir = at(args[++k]) ?? dir;
    else if (t === '--remote-name' || t === '--remote-name-all' || /^-[A-Za-z]*O[A-Za-z]*$/.test(t)) remote = true;
  }
  if (remote) for (const a of args) if (looksLikeUrl(a.text)) out.push(path.join(dir, urlFileName(a.text) ?? ''));
  return out.filter(Boolean);
}

function wgetOutputs(args: readonly Word[], cwd: string): string[] {
  // `-O x`, `-qO x` (opciones cortas agrupadas), `-Ox` y `--output-document=x`.
  const value = (short: string, long: string): Word | undefined => {
    const k = args.findIndex((a) => a.text === long || new RegExp(`^-[A-Za-z]*${short}$`).test(a.text));
    if (k >= 0) return args[k + 1];
    const inline = args.find((a) => a.text.startsWith(`${long}=`) || new RegExp(`^-${short}.`).test(a.text));
    if (!inline) return undefined;
    return { ...inline, text: inline.text.startsWith(long) ? inline.text.slice(long.length + 1) : inline.text.slice(2) };
  };
  const document = value('O', '--output-document');
  if (document) return document.text === '-' ? [] : [absOf(document, cwd) ?? ''].filter(Boolean);
  const dir = absOf(value('P', '--directory-prefix'), cwd) ?? cwd;
  return args.filter((a) => looksLikeUrl(a.text)).map((a) => path.join(dir, urlFileName(a.text) ?? 'index.html'));
}

/** Rutas que escribe un comando que baja de internet (sin contar sus redirecciones). */
function downloadOutputs(name: string, args: readonly Word[], kind: ShellKind, cwd: string): string[] | undefined {
  const resolve = (w: Word | undefined) => [absOf(w, cwd) ?? ''].filter(Boolean);
  const psOut = kind === 'powershell' ? resolve(psParam(args, 'outfile', 4)) : [];
  if (PS_WEB.has(name)) return psOut;
  if (name === 'start-bitstransfer') {
    const source = psParam(args, 'source', 2)?.text ?? args.find((a) => URL_LIKE.test(a.text))?.text ?? '';
    const dest = resolve(psParam(args, 'destination', 2) ?? args.filter((a) => !a.text.startsWith('-'))[1]);
    return [...dest, ...dest.map((d) => path.join(d, urlFileName(source) ?? ''))];
  }
  if (name === 'curl') return [...psOut, ...curlOutputs(args, cwd)];
  if (name === 'wget') return [...psOut, ...wgetOutputs(args, cwd)];
  return undefined;
}

/** Destinos de un `mv`/`cp`/`Copy-Item`/`Rename-Item` cuyo origen ya está marcado: la copia también queda marcada. */
function movedOutputs(name: string, args: readonly Word[], cwd: string, marked: ReadonlySet<string>): string[] {
  const positional = args.filter((a) => !a.text.startsWith('-'));
  const abs = positional.map((a) => absOf(a, cwd));
  const dest = abs.at(-1);
  if (!dest || abs.length < 2) return [];
  const newName = (positional.at(-1) as Word).text;
  const out: string[] = [];
  for (const src of abs.slice(0, -1)) {
    if (!src || !marked.has(pathKey(src))) continue;
    out.push(...(RENAMERS.has(name) ? [path.join(path.dirname(src), newName)] : [dest, path.join(dest, path.basename(src))]));
  }
  return out;
}

/**
 * Rutas (claves de `pathKey`) que `command`, ejecutado en `cwd`, baja de internet: salidas de `curl`, `wget`,
 * `Invoke-WebRequest`/`irm -OutFile` y `Start-BitsTransfer`, sus redirecciones y tuberías a `tee`/`Out-File`, y las
 * copias o renombres de lo ya marcado (`known` y lo bajado antes en el mismo comando).
 */
export function downloadTargets(command: string, kind: ShellKind, cwd: string, known: ReadonlySet<string> = new Set()): Set<string> {
  const found = new Set<string>();
  const marked = new Set(known);
  collect(command, kind, path.resolve(cwd), (abs) => {
    found.add(pathKey(abs));
    marked.add(pathKey(abs));
  }, marked, 0);
  return found;
}

/** Quita los envoltorios (`timeout 60`, `env X=1`, `nohup`…) y devuelve el comando que ejecutan. */
function unwrap(words: readonly Word[]): Word[] {
  let rest = [...words];
  for (let name = commandName(rest[0]?.text ?? ''); name in WRAPPERS; name = commandName(rest[0]?.text ?? '')) {
    const valued = WRAPPERS[name] as readonly string[];
    let k = 1;
    while (k < rest.length && /^(?:-|\d|[A-Za-z_]\w*=)/.test((rest[k] as Word).text)) k += valued.includes((rest[k] as Word).text) ? 2 : 1;
    rest = rest.slice(k);
  }
  return rest;
}

const joinWords = (words: readonly Word[]) => words.map((w) => w.text).join(' ');

/**
 * Script de un shell anidado y su tipo, si lo hay: `bash -c '…'`, `cmd /c …` (también `/c"…"`), `eval '…'` y
 * `powershell [-Command] …` (sin `-Command`, el primer argumento que no es opción). Elige el script como
 * `evalCmdShell` y `evalPowerShellExe` de la política: lo que ella evalúa es lo que aquí se recorre.
 */
function nestedScript(name: string, args: readonly Word[]): { script: string; kind: ShellKind } | undefined {
  if (name === 'eval') return { script: joinWords(args), kind: 'bash' };
  if (POSIX_SHELLS.has(name)) {
    const k = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a.text));
    return k >= 0 ? { script: joinWords(args.slice(k + 1)), kind: 'bash' } : undefined;
  }
  if (name === 'cmd') {
    const k = args.findIndex((a) => /^\/[ck]/i.test(a.text));
    return k >= 0 ? { script: [(args[k] as Word).text.slice(2), joinWords(args.slice(k + 1))].filter(Boolean).join(' '), kind: 'cmd' } : undefined;
  }
  if (!POWERSHELLS.has(name)) return undefined;
  for (let k = 0; k < args.length; k++) {
    const a = (args[k] as Word).text;
    if (!a.startsWith('-') && !(a.startsWith('/') && a.length > 1 && !a.includes('\\'))) return { script: joinWords(args.slice(k)), kind: 'powershell' };
    const o = a.replace(/^[-/]+/, '').toLowerCase();
    if (o === 'c' || (o.length >= 2 && 'command'.startsWith(o))) return { script: joinWords(args.slice(k + 1)), kind: 'powershell' };
    if (POWERSHELL_VALUE_OPTS.includes(o)) k++;
  }
  return undefined;
}

function collect(command: string, kind: ShellKind, cwd: string, mark: (abs: string) => void, marked: ReadonlySet<string>, depth: number): void {
  const parsed = parseShell(command, kind);
  if (parsed.problems.length > 0 || depth > MAX_DEPTH) return;
  let dir: string | undefined = cwd;
  let downloading = false;
  for (const cmd of parsed.commands) {
    const words = unwrap(cmd.words);
    const first = words[0];
    if (dir === undefined) break;
    if (!first) continue;
    const name = commandName(first.text);
    const args = words.slice(1);
    if (!cmd.piped) downloading = false;
    if (isCdCommand(name)) {
      dir = cdTarget(args, dir);
      continue;
    }
    const nested = nestedScript(name, args);
    if (nested) collect(nested.script, nested.kind, dir, mark, marked, depth + 1);
    const outputs = downloadOutputs(name, args, kind, dir);
    if (outputs) {
      downloading = true;
      outputs.forEach(mark);
    }
    // Lo que escribe una descarga o un comando que recibe su salida por la tubería (`curl … | tr -d x > a.sh`).
    if (outputs || downloading) {
      for (const r of cmd.redirects) {
        const target = r.op.startsWith('<') || r.op.startsWith('2') ? undefined : absOf(r.target, dir);
        if (target) mark(target);
      }
    }
    if (outputs) continue;
    if (downloading && PIPE_WRITERS.has(name)) {
      for (const a of args) {
        const target = a.text.startsWith('-') ? undefined : absOf(a, dir);
        if (target) mark(target);
      }
    } else if (MOVERS.has(name)) {
      movedOutputs(name, args, dir, marked).forEach(mark);
    }
  }
}

/**
 * `shellCommandProblem` con la memoria de la sesión: niega ejecutar lo que bajó (en este comando o en uno anterior,
 * `downloaded`) y, si el comando se permite, suma a `downloaded` lo que baja.
 */
export async function sessionShellProblem(
  command: string,
  kind: ShellKind,
  root: string,
  cwd: string,
  downloaded: Set<string>,
  opts: { userCopy?: boolean } = {},
): Promise<string | undefined> {
  const fetched = downloadTargets(command, kind, cwd, downloaded);
  const problem = await shellCommandProblem(command, kind, root, cwd, { ...opts, untrusted: new Set([...downloaded, ...fetched]) });
  if (!problem) for (const f of fetched) downloaded.add(f);
  return problem;
}
