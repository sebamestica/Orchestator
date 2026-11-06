import path from 'node:path';
import { assertRealInside, realOrNearest } from '../../memory/safe-fs.ts';
import { parseShell, type ShellKind, type Word } from './shell-parse.ts';

/**
 * Política de comandos para las herramientas Bash y PowerShell del worker Claude.
 *
 * Qué se deniega:
 * - lo no verificable: sustitución de comandos, `eval`, intérpretes con código en línea (`node -e`,
 *   `python -c`…), shells sin un comando literal, PowerShell codificado, llamadas a .NET, alias;
 * - git: `push`, `rebase`, `config`, `remote`, reescrituras, borrar o forzar ramas, `reset --hard`,
 *   `clean -f`, `-c`, `--git-dir`, `--work-tree`, variables `GIT_*`, `-C` fuera del worktree y
 *   subcomandos desconocidos (podrían ser alias);
 * - publicar paquetes, instalaciones globales, desplegar, la CLI de GitHub, tareas programadas, registro;
 * - crear enlaces o junctions;
 * - escrituras obvias fuera del worktree: redirecciones, `rm`/`cp`/`mv`/`mkdir`/`touch`/`tee`,
 *   `Set-Content`, `Out-File`, `Copy-Item`, `Move-Item`, `New-Item`, `Remove-Item`… con destino fuera
 *   (resuelto con la ruta real, que sigue junctions) o con rutas no verificables (variables, `~`).
 *
 * RIESGO RESIDUAL (sin aislamiento del sistema operativo en Windows): un proceso permitido puede
 * escribir donde quiera el usuario. Un script del worktree (`node script.js`, `npm run x`, `bash x.sh`),
 * un binario o una herramienta con rutas en archivos de configuración no se inspeccionan. Esta
 * política corta los caminos obvios y los errores del modelo; no es una frontera contra código hostil.
 */

const MAX_DEPTH = 3;

export interface ShellContext {
  worktree: string;
  kind: ShellKind;
  depth: number;
  /** Carpeta actual (cambia con `cd`); undefined si ya no se sabe. */
  cwd: string | undefined;
  /** El comando recibe la salida de otro por una tubería. */
  piped?: boolean;
}

/**
 * Variables que cambian qué ejecuta o dónde escribe un programa: `GIT_*` (repositorio, editor, ssh),
 * editores y paginadores que git lanza, opciones de Node/Python/Perl y la configuración de npm.
 */
const DANGEROUS_ENV = /^(?:GIT_|EDITOR$|VISUAL$|PAGER$|LESS|SSH_|SHELL$|BASH_ENV$|ENV$|PROMPT_COMMAND$|LD_|DYLD_|NODE_OPTIONS$|PYTHONSTARTUP$|PYTHONPATH$|PERL5OPT$|NPM_CONFIG_)/i;

function envProblem(name: string): string | undefined {
  return DANGEROUS_ENV.test(name) ? `la variable ${name} cambia qué se ejecuta o dónde se escribe` : undefined;
}

/** Palabras clave que preceden a un comando (`if git push; then …`). */
const BASH_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', 'coproc', '{', 'fi', 'done']);

type Outcome = string | { cwd: string | undefined };
const keep = (c: ShellContext): Outcome => ({ cwd: c.cwd });

/** True si `target` (absoluta) es `root` o está debajo, sin tocar el disco. */
export function lexicallyInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!path.isAbsolute(rel) && rel.split(/[\\/]/)[0] !== '..');
}

const PROTECTED = new Set(['.git', '.claude', '.mcp.json']);

/** Problema si `target` sale del worktree (también por junctions o enlaces); undefined si está dentro. */
export async function insideProblem(worktree: string, target: string): Promise<string | undefined> {
  if (!lexicallyInside(worktree, target)) return `ruta fuera del worktree: ${target}`;
  try {
    await assertRealInside(worktree, target);
  } catch {
    return `la ruta real sale del worktree (enlace o junction): ${target}`;
  }
  return undefined;
}

/** Primer segmento de `target` bajo `root` si es `.git`, `.claude` o `.mcp.json`. */
function protectedSegment(root: string, target: string): string | undefined {
  const first = path.relative(root, target).split(/[\\/]/)[0]?.toLowerCase();
  return first && PROTECTED.has(first) ? first : undefined;
}

/**
 * Como `insideProblem`, y además protege `.git`, `.claude/` y `.mcp.json` (configuración ejecutable), con la ruta escrita
 * y con la real: una junction interna (`alias` → `.git`) no abre una puerta a ellas.
 */
export async function writeProblem(worktree: string, target: string): Promise<string | undefined> {
  const outside = await insideProblem(worktree, target);
  if (outside) return `escritura fuera del worktree: ${outside}`;
  const hit = protectedSegment(path.resolve(worktree), path.resolve(target))
    ?? protectedSegment(await realOrNearest(worktree), await realOrNearest(target));
  return hit ? `ruta protegida del worktree (${hit}): ${target}` : undefined;
}

const SINKS = /^(?:\/dev\/(?:null|stdout|stderr)|nul:?|\$null)$/i;
const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** Ruta absoluta de una palabra del shell, o el motivo por el que no se puede verificar. */
export function resolveShellPath(word: Word, cwd: string | undefined): { abs: string } | { sink: true } | { problem: string } {
  const text = word.text;
  if (SINKS.test(text)) return { sink: true };
  if (word.dynamic) return { problem: `ruta con variables, no verificable: ${text}` };
  if (text === '') return { problem: 'ruta vacía' };
  if (text.startsWith('~')) return { problem: `ruta del perfil del usuario: ${text}` };
  if (/^[A-Za-z][A-Za-z0-9]+:/.test(text) || text.includes('::')) return { problem: `ruta de un proveedor (registro, entorno…): ${text}` };
  let candidate = text;
  const msys = /^\/([A-Za-z])(\/.*)?$/.exec(text);
  if (msys) candidate = `${(msys[1] as string).toUpperCase()}:${msys[2] ?? '/'}`;
  else if (text.startsWith('/') || text.startsWith('\\\\')) return { problem: `ruta absoluta fuera del worktree: ${text}` };
  if (/^[A-Za-z]:(?![\\/])/.test(candidate)) return { problem: `ruta relativa a una unidad: ${text}` };
  if (!path.isAbsolute(candidate) && cwd === undefined) return { problem: `carpeta actual desconocida tras cd: ${text}` };
  return { abs: path.resolve(cwd ?? '.', candidate) };
}

async function shellWriteProblem(word: Word, c: ShellContext): Promise<string | undefined> {
  if (URL_LIKE.test(word.text)) return undefined;
  const r = resolveShellPath(word, c.cwd);
  if ('sink' in r) return undefined;
  if ('problem' in r) return `escritura no verificable: ${r.problem}`;
  return writeProblem(c.worktree, r.abs);
}

async function firstWriteProblem(words: readonly Word[], c: ShellContext): Promise<string | undefined> {
  for (const w of words) {
    const p = await shellWriteProblem(w, c);
    if (p) return p;
  }
  return undefined;
}

/** Nombre normalizado del comando: sin carpeta, extensión ni mayúsculas (Windows no distingue). */
export function commandName(text: string): string {
  const base = text.replace(/^@/, '').split(/[\\/]/).pop() ?? text;
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/, '');
}

/** Prefijo válido de una opción larga (git y otros aceptan abreviaturas únicas: `--ha` = `--hard`). */
function longOpt(arg: string, full: string, min = 3): boolean {
  const name = arg.split('=')[0] ?? '';
  return name.startsWith('--') && name.length >= min && full.startsWith(name);
}

const DENIED: Readonly<Record<string, string>> = {
  source: 'ejecutar un script con source no se puede verificar',
  '.': 'ejecutar un script con «.» no se puede verificar',
  xargs: 'xargs ejecuta comandos armados con la entrada',
  parallel: 'parallel ejecuta comandos armados con la entrada',
  trap: 'trap ejecuta texto como código',
  alias: 'los alias pueden disfrazar comandos',
  'set-alias': 'los alias pueden disfrazar comandos',
  'new-alias': 'los alias pueden disfrazar comandos',
  sal: 'los alias pueden disfrazar comandos',
  nal: 'los alias pueden disfrazar comandos',
  'invoke-expression': 'Invoke-Expression ejecuta texto como código',
  iex: 'Invoke-Expression ejecuta texto como código',
  'invoke-command': 'Invoke-Command ejecuta bloques no verificables',
  icm: 'Invoke-Command ejecuta bloques no verificables',
  'start-process': 'Start-Process lanza programas fuera de la política',
  saps: 'Start-Process lanza programas fuera de la política',
  start: 'start lanza programas fuera de la política',
  'invoke-item': 'Invoke-Item abre programas fuera de la política',
  ii: 'Invoke-Item abre programas fuera de la política',
  schtasks: 'las tareas programadas salen del worktree',
  at: 'las tareas programadas salen del worktree',
  'register-scheduledtask': 'las tareas programadas salen del worktree',
  wsl: 'WSL da acceso a todo el disco',
  bash_env: 'BASH_ENV ejecuta código',
  runas: 'runas cambia de usuario',
  mshta: 'mshta ejecuta código no verificable',
  wscript: 'wscript ejecuta código no verificable',
  cscript: 'cscript ejecuta código no verificable',
  rundll32: 'rundll32 ejecuta código no verificable',
  regsvr32: 'regsvr32 ejecuta código no verificable',
  reg: 'modificar el registro de Windows necesita aprobación',
  regedit: 'modificar el registro de Windows necesita aprobación',
  setx: 'setx cambia variables de entorno permanentes',
  sc: 'sc (servicios o Set-Content) no se puede verificar',
  mklink: 'crear enlaces o junctions permite salir del worktree',
  ln: 'crear enlaces permite salir del worktree',
  junction: 'crear junctions permite salir del worktree',
  fsutil: 'fsutil puede crear enlaces y cambiar el sistema de archivos',
  'set-executionpolicy': 'cambiar la política de ejecución necesita aprobación',
  'new-psdrive': 'las unidades de PowerShell ocultan rutas reales',
  gh: 'la CLI de GitHub puede publicar en el remoto',
  hub: 'hub puede publicar en el remoto',
  vercel: 'desplegar necesita la aprobación del usuario',
  netlify: 'desplegar necesita la aprobación del usuario',
  firebase: 'desplegar necesita la aprobación del usuario',
  fly: 'desplegar necesita la aprobación del usuario',
  flyctl: 'desplegar necesita la aprobación del usuario',
  wrangler: 'desplegar necesita la aprobación del usuario',
  heroku: 'desplegar necesita la aprobación del usuario',
  ssh: 'las conexiones remotas necesitan aprobación',
  scp: 'las copias remotas necesitan aprobación',
  sftp: 'las copias remotas necesitan aprobación',
};

/** Intérpretes y la opción que les pasa código en línea. */
const INLINE_CODE: Readonly<Record<string, RegExp>> = {
  node: /^(?:-e|--eval|-p|--print|-pe|-ep)$|^--(?:eval|print)=/,
  nodejs: /^(?:-e|--eval|-p|--print|-pe|-ep)$|^--(?:eval|print)=/,
  bun: /^(?:-e|--eval|-p|--print)$/,
  deno: /^(?:eval|-e|--eval)$/,
  tsx: /^(?:-e|--eval|-p|--print)$/,
  'ts-node': /^(?:-e|--eval|-p|--print)$/,
  python: /^-[A-Za-z]*c$/,
  python3: /^-[A-Za-z]*c$/,
  python2: /^-[A-Za-z]*c$/,
  py: /^-[A-Za-z]*c$/,
  pythonw: /^-[A-Za-z]*c$/,
  perl: /^-[A-Za-z]*[eE]/,
  ruby: /^-[A-Za-z]*e/,
  php: /^-r$/,
  lua: /^-e$/,
  rscript: /^-e$/,
  osascript: /./,
};
/** Intérpretes que sin argumentos leen código de la entrada estándar. */
const STDIN_INTERPRETERS = new Set(['node', 'nodejs', 'python', 'python3', 'python2', 'py', 'pythonw', 'perl', 'ruby', 'php', 'lua', 'deno', 'bun', 'tsx', 'ts-node']);

/** Cmdlets que, en una tubería de PowerShell, toman de ella las rutas sobre las que actúan. */
const PIPE_SENSITIVE = new Set([
  'remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir', 'move-item', 'mi', 'mv', 'move', 'copy-item', 'cpi', 'cp', 'copy',
  'rename-item', 'rni', 'ren', 'new-item', 'ni', 'set-item', 'si', 'clear-content', 'clc', 'mkdir', 'md', 'set-acl',
  'expand-archive', 'compress-archive', 'clear-item', 'cli',
]);

/** Salta la condición de un `if` de cmd y devuelve el comando que ejecuta. */
function skipCmdIf(words: Word[]): Word[] {
  let k = 0;
  while (k < words.length && /^(?:not|\/i)$/i.test((words[k] as Word).text)) k++;
  const t = (words[k]?.text ?? '').toLowerCase();
  if (['exist', 'defined', 'errorlevel', 'cmdextversion'].includes(t)) return words.slice(k + 2);
  if ((words[k]?.text ?? '').includes('==')) return words.slice(k + 1);
  if (/^(?:equ|neq|lss|leq|gtr|geq)$/i.test(words[k + 1]?.text ?? '')) return words.slice(k + 3);
  return words.slice(k + 1);
}

const POSIX_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'git-bash', 'busybox']);
const POWERSHELLS = new Set(['powershell', 'pwsh', 'powershell_ise']);
const WRAPPERS: Readonly<Record<string, readonly string[]>> = {
  call: [],
  env: ['-u', '--unset'],
  sudo: ['-u', '-g', '-h'],
  nohup: [],
  time: ['-f', '-o'],
  command: [],
  builtin: [],
  exec: ['-a'],
  nice: ['-n', '--adjustment'],
  stdbuf: ['-i', '-o', '-e'],
  timeout: ['-s', '--signal', '-k', '--kill-after'],
  winpty: [],
  ionice: ['-c', '-n', '-p'],
  unbuffer: [],
  chronic: [],
};

export async function evalShell(script: string, c: ShellContext): Promise<string | undefined> {
  if (c.depth > MAX_DEPTH) return 'demasiados shells anidados';
  const parsed = parseShell(script, c.kind);
  if (parsed.problems.length > 0) return `${parsed.problems[0]}: no se puede verificar`;
  let cwd = c.cwd;
  for (const cmd of parsed.commands) {
    const ctx = { ...c, cwd };
    for (const r of cmd.redirects) {
      if (r.op === '<' || r.op === '<<<') continue;
      const p = await shellWriteProblem(r.target, ctx);
      if (p) return p;
    }
    const out = await evalCommand(cmd.words, { ...ctx, piped: cmd.piped });
    if (typeof out === 'string') return out;
    cwd = out.cwd;
  }
  return undefined;
}

async function evalCommand(input: readonly Word[], c: ShellContext): Promise<Outcome> {
  let words = [...input];
  if (c.kind !== 'powershell') {
    // Asignaciones previas: `X=1 cmd` (bash).
    for (;;) {
      while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test((words[0] as Word).text)) {
        const problem = envProblem((words[0] as Word).text.split(/\+?=/)[0] ?? '');
        if (problem) return problem;
        words = words.slice(1);
      }
      if (c.kind === 'bash' && words[0] && !words[0].quoted && BASH_KEYWORDS.has(words[0].text)) {
        words = words.slice(1);
        continue;
      }
      if (c.kind === 'cmd' && words[0] && ['do', 'else'].includes(words[0].text.toLowerCase())) {
        words = words.slice(1);
        continue;
      }
      break;
    }
    if (c.kind === 'cmd' && words[0]?.text.toLowerCase() === 'if') words = skipCmdIf(words.slice(1));
    if (c.kind === 'cmd' && words[0]?.text.toLowerCase() === 'for' && words.some((w) => /^\/f$/i.test(w.text))) {
      return 'for /f de cmd ejecuta comandos no verificables';
    }
  } else if (words[0]?.text.startsWith('$')) {
    // PowerShell: `$x = cmd …`, `$env:X = …`; el lado derecho se evalúa como comando.
    const first = words[0];
    const target = first.text.split('=')[0] ?? '';
    const envVar = /^\$env:(.+)$/i.exec(target)?.[1];
    if (envVar) {
      const problem = envProblem(envVar);
      if (problem) return problem;
    }
    if (first.text.includes('=')) {
      const rhs = first.text.slice(first.text.indexOf('=') + 1);
      words = rhs ? [{ ...first, text: rhs, dynamic: rhs.includes('$') }, ...words.slice(1)] : words.slice(1);
    } else if (words[1] && /^[+\-*/]?=$/.test(words[1].text)) {
      words = words.slice(2);
    } else {
      return `expresión de PowerShell con variables no verificable: ${first.text}`;
    }
  }
  const first = words[0];
  if (!first) return keep(c);
  if (first.dynamic) return `comando no verificable: ${first.text}`;
  if (first.glob) return `comodines en el nombre del comando: ${first.text}`;
  if (first.text.includes(']::') || /^\[/.test(first.text)) return 'las llamadas a .NET desde PowerShell no se pueden verificar';
  const name = commandName(first.text);
  const args = words.slice(1);

  const denied = DENIED[name];
  if (denied) return denied;

  if (name in WRAPPERS) {
    const valueOpts = WRAPPERS[name] as readonly string[];
    let k = 0;
    while (k < args.length) {
      const t = (args[k] as Word).text;
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        const problem = envProblem(t.split('=')[0] ?? '');
        if (problem) return problem;
        k++;
        continue;
      }
      if (name === 'env' && (t === '-C' || longOpt(t, '--chdir'))) return 'env --chdir cambia la carpeta de trabajo';
      if (t === '--') {
        k++;
        break;
      }
      if (t.startsWith('-')) {
        k += valueOpts.includes(t) ? 2 : 1;
        continue;
      }
      if (name === 'timeout' && /^\d/.test(t)) {
        k++;
        continue;
      }
      break;
    }
    return evalCommand(args.slice(k), c);
  }

  if (name === 'eval') {
    if (args.some((a) => a.dynamic)) return 'eval con variables no se puede verificar';
    const inner = await evalShell(args.map((a) => a.text).join(' '), { ...c, kind: 'bash', depth: c.depth + 1 });
    return inner ?? keep(c);
  }
  if (POSIX_SHELLS.has(name)) return evalPosixShell(args, c);
  if (name === 'cmd') return evalCmdShell(args, c);
  if (POWERSHELLS.has(name)) return evalPowerShellExe(args, c);

  const inline = INLINE_CODE[name];
  if (inline) {
    if (args.some((a) => inline.test(a.text))) return `${name} con código en línea no se puede verificar`;
    if (STDIN_INTERPRETERS.has(name) && !args.some((a) => !a.text.startsWith('-')) && !args.some((a) => /^-(?:v|-version|h|-help|V)$/.test(a.text))) {
      return `${name} sin script leería código de la entrada estándar`;
    }
    if (args.some((a) => a.text === '-')) return `${name} leería código de la entrada estándar`;
    return keep(c);
  }

  if (name === 'git') return evalGit(args, c);
  if (['npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx'].includes(name)) return evalNpm(name, args, c);
  if (['export', 'declare', 'typeset', 'local', 'readonly', 'set', 'set-item', 'si', 'set-variable', 'sv'].includes(name)) {
    for (const a of args) {
      const variable = a.text.replace(/^(?:env:|\$env:)/i, '').split('=')[0] ?? '';
      if (a.text.startsWith('-')) continue;
      if (/^(?:env:|\$env:)/i.test(a.text) || name !== 'set-item') {
        const problem = envProblem(variable);
        if (problem) return problem;
      }
    }
    if (name !== 'set-item' && name !== 'si') return keep(c);
  }
  if (['awk', 'gawk', 'nawk', 'mawk'].includes(name) && args.some((a) => /system|getline|[|>]/.test(a.text))) {
    return 'awk que ejecuta comandos o escribe archivos no se puede verificar';
  }
  if (name === 'sed' && args.some((a) => /(?:^|[;{}\n]|\d)\s*e(?:\s|;|$)|\/[gpiImMe0-9]*e[gpiImMe0-9]*(?:;|$)|(?:^|[;{}\n])\s*[wW]\s|\/[gpiImM0-9]*w\s/.test(a.text))) {
    return 'sed con los comandos e o w ejecuta comandos o escribe archivos';
  }
  if (c.piped && PIPE_SENSITIVE.has(name) && c.kind === 'powershell') {
    return `${first.text} recibe rutas por la tubería: no se pueden verificar`;
  }
  if (CD_COMMANDS.has(name)) return { cwd: cdTarget(args, c.cwd) };
  if (name === 'popd' || name === 'pop-location') return { cwd: undefined };
  if (name === 'find' && c.kind === 'bash') return evalFind(args, c);

  const p = await evalWriteCommand(name, args, c);
  return p ?? keep(c);
}

async function evalPosixShell(args: readonly Word[], c: ShellContext): Promise<Outcome> {
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as Word;
    const t = a.text;
    if (a.dynamic) return 'argumentos del shell no verificables';
    if (t === '--') break;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) {
      const script = args[k + 1];
      if (!script) return 'shell -c sin comando';
      if (script.dynamic) return 'shell -c con variables no se puede verificar';
      const inner = await evalShell(script.text, { ...c, kind: 'bash', depth: c.depth + 1 });
      return inner ?? keep(c);
    }
    if (['-o', '+o', '-O', '+O', '--rcfile', '--init-file'].includes(t)) {
      k++;
      continue;
    }
    if (t.startsWith('-') || t.startsWith('+')) {
      if (t === '-s' || t === '-i') return 'shell que lee órdenes de la entrada estándar';
      continue;
    }
    return keep(c); // script del worktree: riesgo residual documentado
  }
  return 'shell sin comando: leería órdenes de la entrada estándar';
}

function joinForShell(rest: readonly Word[]): string | undefined {
  if (rest.some((w) => w.dynamic)) return undefined;
  return rest.length === 1 ? (rest[0] as Word).text : rest.map((w) => w.text).join(' ');
}

async function evalCmdShell(args: readonly Word[], c: ShellContext): Promise<Outcome> {
  const k = args.findIndex((a) => /^\/[ck]/i.test(a.text));
  if (k < 0) return 'cmd sin /c: leería órdenes de la entrada estándar';
  const attached = (args[k] as Word).text.slice(2);
  const rest = attached ? [{ ...(args[k] as Word), text: attached }, ...args.slice(k + 1)] : args.slice(k + 1);
  const script = joinForShell(rest);
  if (script === undefined) return 'cmd /c con variables no se puede verificar';
  const inner = await evalShell(script, { ...c, kind: 'cmd', depth: c.depth + 1 });
  return inner ?? keep(c);
}

async function evalPowerShellExe(args: readonly Word[], c: ShellContext): Promise<Outcome> {
  const valueOpts = ['executionpolicy', 'ep', 'ex', 'windowstyle', 'w', 'inputformat', 'if', 'outputformat', 'of', 'version', 'v', 'configurationname', 'settingsfile', 'custompipename', 'psconsolefile'];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as Word;
    const isOpt = a.text.startsWith('-') || (a.text.startsWith('/') && a.text.length > 1 && !a.text.includes('\\'));
    if (!isOpt) {
      const script = joinForShell(args.slice(k));
      if (script === undefined) return 'powershell con variables no se puede verificar';
      const inner = await evalShell(script, { ...c, kind: 'powershell', depth: c.depth + 1 });
      return inner ?? keep(c);
    }
    const o = a.text.replace(/^[-/]+/, '').toLowerCase();
    if (o === 'e' || o === 'ec' || (o.length >= 2 && 'encodedcommand'.startsWith(o)) || o.startsWith('encodedarg')) {
      return 'comando codificado de PowerShell: no se puede verificar';
    }
    if (o === 'c' || (o.length >= 2 && 'command'.startsWith(o))) {
      const rest = args.slice(k + 1);
      if (rest.length === 0 || rest[0]?.text === '-') return 'powershell -Command leería la entrada estándar';
      const script = joinForShell(rest);
      if (script === undefined) return 'powershell -Command con variables no se puede verificar';
      const inner = await evalShell(script, { ...c, kind: 'powershell', depth: c.depth + 1 });
      return inner ?? keep(c);
    }
    if (o === 'f' || (o.length >= 2 && 'file'.startsWith(o))) return keep(c); // script del worktree: riesgo residual
    if (o === 'wd' || o === 'wo' || (o.length >= 2 && 'workingdirectory'.startsWith(o))) return 'powershell -WorkingDirectory cambia la carpeta de trabajo';
    if (valueOpts.some((v) => v === o)) k++;
  }
  return 'powershell sin -Command: leería órdenes de la entrada estándar';
}

const GIT_SWITCHES = new Set([
  '--bare', '--no-pager', '-p', '--paginate', '-P', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs',
  '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-advice', '--html-path', '--man-path',
  '--info-path', '--version', '--help', '-h', '-v',
]);

const GIT_BLOCKED: Readonly<Record<string, string>> = {
  push: 'git push necesita la aprobación del usuario',
  'send-pack': 'publicar en el remoto necesita la aprobación del usuario',
  'http-push': 'publicar en el remoto necesita la aprobación del usuario',
  rebase: 'git rebase reescribe la historia',
  config: 'git config puede quitar protecciones (alias, hooks, pushurl)',
  remote: 'git remote puede cambiar adónde se publica',
  'filter-branch': 'reescribir la historia necesita la aprobación del usuario',
  'filter-repo': 'reescribir la historia necesita la aprobación del usuario',
  replace: 'git replace reescribe objetos',
  'update-ref': 'mover o borrar referencias necesita la aprobación del usuario',
  'symbolic-ref': 'mover referencias necesita la aprobación del usuario',
  clone: 'no se clonan repositorios desde un worktree',
  submodule: 'los submódulos descargan y ejecutan configuración externa',
};

const GIT_ALLOWED = new Set([
  'status', 'log', 'diff', 'show', 'add', 'commit', 'restore', 'checkout', 'switch', 'branch', 'merge', 'stash', 'rm', 'mv',
  'tag', 'fetch', 'pull', 'cherry-pick', 'revert', 'reset', 'reflog', 'apply', 'am', 'format-patch', 'archive', 'bisect',
  'worktree', 'clean', 'grep', 'blame', 'annotate', 'shortlog', 'describe', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree',
  'cat-file', 'show-ref', 'for-each-ref', 'merge-base', 'name-rev', 'cherry', 'whatchanged', 'range-diff', 'diff-tree',
  'diff-index', 'diff-files', 'check-ignore', 'check-attr', 'count-objects', 'fsck', 'verify-commit', 'help', 'version',
  'stage', 'ls-remote', 'notes', 'show-branch',
]);

async function evalGit(args: readonly Word[], c: ShellContext): Promise<Outcome> {
  let k = 0;
  for (; k < args.length; k++) {
    const a = args[k] as Word;
    const t = a.text;
    if (a.dynamic || a.glob) return `argumento de git no verificable: ${t}`;
    if (!t.startsWith('-')) break;
    if (t === '-C') {
      const dir = args[k + 1];
      if (!dir) return 'git -C sin carpeta';
      const r = resolveShellPath(dir, c.cwd);
      if ('problem' in r) return `git -C: ${r.problem}`;
      if ('abs' in r) {
        const p = await insideProblem(c.worktree, r.abs);
        if (p) return `git -C fuera del worktree: ${p}`;
      }
      k++;
      continue;
    }
    if (t.startsWith('-c') || t.startsWith('--config-env')) return 'git -c puede cambiar alias y protecciones de git';
    if (/^--(?:git-dir|work-tree|exec-path=|namespace|super-prefix|attr-source)/.test(t)) return `git ${t.split('=')[0]} apunta a otro repositorio o configuración`;
    if (/^--(?:upload-pack|receive-pack|exec)/.test(t)) return `git ${t.split('=')[0]} ejecuta comandos`;
    if (GIT_SWITCHES.has(t.split('=')[0] ?? t) || t.startsWith('--list-cmds')) continue;
    return `opción global de git desconocida: ${t}`;
  }
  const subWord = args[k];
  if (!subWord) return keep(c);
  const sub = subWord.text.toLowerCase();
  const blocked = GIT_BLOCKED[sub];
  if (blocked) return blocked;
  if (!GIT_ALLOWED.has(sub)) return `subcomando de git desconocido o alias: ${subWord.text}`;
  const rest = args.slice(k + 1);
  const texts = rest.map((w) => w.text);
  if (texts.some((t) => /^--(?:upload-pack|receive-pack|exec)/.test(t) || /^-u./.test(t) && ['fetch', 'pull', 'ls-remote', 'archive'].includes(sub))) {
    return 'opciones de git que ejecutan comandos (--upload-pack, --exec)';
  }
  const shortHas = (letters: RegExp) => texts.some((t) => /^-[A-Za-z]+$/.test(t) && letters.test(t.slice(1)));

  if (['reset', 'branch', 'clean', 'tag', 'fetch', 'pull', 'worktree', 'reflog', 'bisect', 'checkout', 'switch'].includes(sub) && rest.some((w) => w.dynamic)) {
    return `argumentos de git ${sub} no verificables`;
  }
  switch (sub) {
    case 'reset':
      if (texts.some((t) => longOpt(t, '--hard', 4))) return 'git reset --hard descarta trabajo';
      break;
    case 'clean':
      if (shortHas(/f/) || texts.some((t) => longOpt(t, '--force'))) return 'git clean -f borra archivos sin seguimiento';
      break;
    case 'branch':
      if (shortHas(/[dDmMf]/) || texts.some((t) => longOpt(t, '--delete') || longOpt(t, '--move') || longOpt(t, '--force'))) {
        return 'borrar, renombrar o forzar ramas necesita la aprobación del usuario';
      }
      break;
    case 'tag':
      if (shortHas(/[df]/) || texts.some((t) => longOpt(t, '--delete') || longOpt(t, '--force'))) return 'borrar o forzar etiquetas necesita la aprobación del usuario';
      break;
    case 'fetch':
    case 'pull':
      if (texts.some((t) => !t.startsWith('-') && (t.includes(':') || t.startsWith('+')) && !URL_LIKE.test(t) && !/^[\w.-]+@[\w.-]+:/.test(t))) {
        return 'refspecs con destino pueden sobrescribir ramas de otros';
      }
      if (sub === 'pull' && (texts.some((t) => longOpt(t, '--rebase', 5)) || shortHas(/r/))) return 'git pull --rebase reescribe la historia';
      break;
    case 'worktree':
      if (texts[0] !== 'list') return 'solo se permite git worktree list';
      break;
    case 'reflog':
      if (texts[0] && ['expire', 'delete', 'drop'].includes(texts[0])) return 'borrar el reflog necesita la aprobación del usuario';
      break;
    case 'bisect':
      if (texts[0] === 'run') return 'git bisect run ejecuta comandos no verificables';
      break;
    case 'apply':
      if (texts.some((t) => longOpt(t, '--unsafe-paths', 4))) return 'git apply --unsafe-paths escribe fuera del worktree';
      break;
    case 'grep':
      if (texts.some((t) => /^-O/.test(t) || longOpt(t, '--open-files-in-pager', 4))) return 'git grep -O ejecuta un programa';
      break;
    case 'notes':
      if (texts[0] && !['list', 'show'].includes(texts[0])) return 'solo se permite consultar notas';
      break;
  }
  // Salidas a archivo (`-o`, `--output`, `--output-directory`).
  for (let j = 0; j < rest.length; j++) {
    const t = (rest[j] as Word).text;
    const isOut = t === '-o' || longOpt(t, '--output', 5) || longOpt(t, '--output-directory', 5);
    if (!isOut && !/^-o./.test(t)) continue;
    const inline = t.includes('=') ? t.slice(t.indexOf('=') + 1) : /^-o./.test(t) ? t.slice(2) : undefined;
    const target = inline !== undefined ? { ...(rest[j] as Word), text: inline } : rest[j + 1];
    if (!target) continue;
    const p = await shellWriteProblem(target, c);
    if (p) return p;
  }
  return keep(c);
}

const NPM_DENIED = new Set(['publish', 'unpublish', 'deprecate', 'dist-tag', 'owner', 'adduser', 'login', 'token', 'access']);

async function evalNpm(name: string, args: readonly Word[], c: ShellContext): Promise<Outcome> {
  if (args.some((a) => a.dynamic)) return `argumentos de ${name} no verificables`;
  const texts = args.map((a) => a.text.toLowerCase());
  const deniedWord = texts.find((t) => NPM_DENIED.has(t));
  if (deniedWord) return `${name} ${deniedWord} necesita la aprobación del usuario`;
  if (texts.some((t, k) => t === '-g' || longOpt(t, '--global') || t === '--location=global' || (t === '--location' && texts[k + 1] === 'global')) || (name === 'yarn' && texts.includes('global'))) {
    return 'una instalación global escribe fuera del worktree';
  }
  for (let k = 0; k < args.length; k++) {
    const t = texts[k] as string;
    const dirOpt = ['--prefix', '--dir', '--cwd', '--cache', '--globalconfig', '--userconfig'].find((o) => t === o || t.startsWith(`${o}=`));
    if (!dirOpt && !(name === 'pnpm' && t === '-c')) continue;
    const target = t.includes('=') ? { ...(args[k] as Word), text: (args[k] as Word).text.slice(t.indexOf('=') + 1) } : args[k + 1];
    if (!target) continue;
    const p = await shellWriteProblem(target, c);
    if (p) return p;
  }
  // npx, `npm exec`, `pnpm dlx`…: el paquete ejecutado se evalúa como un comando más.
  const execIndex = ['npx', 'pnpx', 'bunx'].includes(name) ? -1 : texts.findIndex((t) => !t.startsWith('-'));
  const isExec = execIndex === -1 || ['exec', 'x', 'dlx'].includes(texts[execIndex] ?? '');
  if (!isExec) return keep(c);
  if (texts.some((t) => t === '-c' || longOpt(t, '--call'))) return `${name} -c ejecuta un shell no verificable`;
  let k = execIndex + 1;
  while (k < args.length) {
    const t = texts[k] as string;
    if (t === '--') {
      k++;
      break;
    }
    if (t === '-p' || t === '--package') {
      k += 2;
      continue;
    }
    if (t.startsWith('-')) {
      k++;
      continue;
    }
    break;
  }
  return evalCommand(args.slice(k), c);
}

const CD_COMMANDS = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);

/** Carpeta a la que mueve un `cd` (o `Set-Location`, `pushd`) con estos argumentos; undefined si no se sabe. */
function cdTarget(args: readonly Word[], cwd: string | undefined): string | undefined {
  const positional = args.filter((a) => !(a.text.startsWith('-') && a.text.length > 1) && !/^\/d$/i.test(a.text));
  const target = positional[0];
  if (!target || target.text === '-') return undefined;
  const r = resolveShellPath(target, cwd);
  return 'abs' in r ? r.abs : undefined;
}

/**
 * Carpeta a la que vuelve `command` si su primer comando es un `cd` (o `Set-Location`, `pushd`) a una ruta literal,
 * resuelta contra `cwd`; undefined si empieza con otra cosa o el destino no se puede verificar. Si la salida del `cd`
 * va por una tubería, lo que sigue corre en otro proceso y no cuenta como vuelta.
 */
export function leadingCdTarget(command: string, kind: ShellKind, cwd: string): string | undefined {
  const parsed = parseShell(command, kind);
  if (parsed.problems.length > 0) return undefined;
  const [first, next] = parsed.commands;
  const name = first?.words[0];
  if (!first || !name || name.dynamic || next?.piped || !CD_COMMANDS.has(commandName(name.text))) return undefined;
  return cdTarget(first.words.slice(1), path.resolve(cwd));
}

async function evalFind(args: readonly Word[], c: ShellContext): Promise<Outcome> {
  const texts = args.map((a) => a.text);
  if (texts.some((t) => ['-exec', '-execdir', '-ok', '-okdir'].includes(t))) return 'find -exec ejecuta comandos no verificables';
  const writes = texts.some((t) => t === '-delete' || t.startsWith('-fprint') || t === '-fls');
  if (!writes) return keep(c);
  const starts = args.slice(0, Math.max(0, texts.findIndex((t) => t.startsWith('-') || t === '(' || t === '!'))).filter((a) => a.text);
  const p = await firstWriteProblem(starts.length > 0 ? starts : [{ text: '.', dynamic: false, quoted: false, glob: false }], c);
  if (p) return p;
  for (let k = 0; k < texts.length; k++) {
    if ((texts[k]?.startsWith('-fprint') || texts[k] === '-fls') && args[k + 1]) {
      const q = await shellWriteProblem(args[k + 1] as Word, c);
      if (q) return q;
    }
  }
  return keep(c);
}

type WriteMode = 'all' | 'dest-last' | 'dest-second' | 'ps' | 'ps-copy' | 'sed' | 'dd' | 'tar' | 'unzip' | '7z' | 'curl' | 'wget';

const WRITE_COMMANDS: Readonly<Record<string, WriteMode>> = {
  rm: 'all', rmdir: 'all', unlink: 'all', shred: 'all', touch: 'all', mkdir: 'all', md: 'all', truncate: 'all', chmod: 'all',
  chown: 'all', chgrp: 'all', del: 'all', erase: 'all', rd: 'all', tee: 'all', mv: 'all', move: 'all', mkfifo: 'all',
  mknod: 'all', ren: 'all', rename: 'all', attrib: 'all', icacls: 'all', takeown: 'all', cacls: 'all', install: 'all',
  rsync: 'dest-last', cp: 'dest-last', copy: 'dest-last', xcopy: 'dest-second', robocopy: 'dest-second', sed: 'sed', dd: 'dd',
  tar: 'tar', unzip: 'unzip', '7z': '7z', curl: 'curl', wget: 'wget',
  'set-content': 'ps', 'add-content': 'ps', ac: 'ps', 'clear-content': 'ps', clc: 'ps', 'out-file': 'ps', 'tee-object': 'ps',
  'export-csv': 'ps', epcsv: 'ps', 'export-clixml': 'ps', 'set-item': 'ps', si: 'ps', 'new-item': 'ps', ni: 'ps',
  'remove-item': 'ps', ri: 'ps', 'move-item': 'ps', mi: 'ps', 'rename-item': 'ps', rni: 'ps', 'copy-item': 'ps-copy', cpi: 'ps-copy',
  'expand-archive': 'ps-copy', 'compress-archive': 'ps-copy', 'invoke-webrequest': 'ps', iwr: 'ps', 'invoke-restmethod': 'ps',
  irm: 'ps', 'start-bitstransfer': 'ps-copy', 'set-acl': 'ps', 'new-itemproperty': 'ps', 'set-itemproperty': 'ps',
};
/** En PowerShell estos nombres son alias de cmdlets y llevan parámetros de PowerShell. */
const PS_ALIASES: Readonly<Record<string, WriteMode>> = {
  rm: 'ps', del: 'ps', erase: 'ps', rd: 'ps', rmdir: 'ps', mv: 'ps', move: 'ps', mkdir: 'ps', md: 'ps', ren: 'ps', tee: 'ps',
  cp: 'ps-copy', copy: 'ps-copy',
};

const PS_SOURCE_PARAMS = ['path', 'literalpath', 'pspath'];
const PS_DEST_PARAMS = ['destination', 'destinationpath'];
const PS_PATH_PARAMS = [...PS_SOURCE_PARAMS, ...PS_DEST_PARAMS, 'filepath', 'outfile', 'target', 'name', 'newname'];
const PS_VALUE_PARAMS = [
  'value', 'encoding', 'itemtype', 'type', 'filter', 'include', 'exclude', 'stream', 'delimiter', 'width', 'uri', 'method',
  'body', 'headers', 'contenttype', 'credential', 'inputobject', 'depth', 'erroraction', 'warningaction', 'informationaction',
  'outvariable', 'errorvariable', 'pipelinevariable', 'outbuffer', 'useragent', 'timeoutsec', 'proxy', 'compressionlevel',
  'maximumredirection', 'websession', 'sessionvariable', 'propertytype',
];

interface PsArgs {
  positional: Word[];
  params: { name: string; kind: 'source' | 'dest' | 'path' | 'value'; value: Word | undefined }[];
}

function parsePsArgs(args: readonly Word[]): PsArgs {
  const out: PsArgs = { positional: [], params: [] };
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as Word;
    const m = a.quoted ? null : /^-([A-Za-z]+)(?::(.*))?$/.exec(a.text);
    if (!m) {
      out.positional.push(a);
      continue;
    }
    const name = (m[1] as string).toLowerCase();
    const inline = m[2] !== undefined ? { ...a, text: m[2] } : undefined;
    let kind: PsArgs['params'][number]['kind'] | undefined;
    if (PS_DEST_PARAMS.some((p) => p.startsWith(name))) kind = 'dest';
    else if (PS_SOURCE_PARAMS.some((p) => p.startsWith(name))) kind = 'source';
    else if (PS_PATH_PARAMS.some((p) => p.startsWith(name))) kind = 'path';
    else if (PS_VALUE_PARAMS.some((p) => p.startsWith(name))) kind = 'value';
    if (!kind) continue; // modificador (-Force, -Recurse…): no consume valor
    const value = inline ?? args[k + 1];
    if (!inline) k++;
    out.params.push({ name, kind, value });
  }
  return out;
}

async function evalWriteCommand(name: string, args: readonly Word[], c: ShellContext): Promise<string | undefined> {
  const mode = c.kind === 'powershell' ? (PS_ALIASES[name] ?? WRITE_COMMANDS[name]) : WRITE_COMMANDS[name];
  if (!mode) return undefined;
  if (mode === 'ps' || mode === 'ps-copy') {
    const ps = parsePsArgs(args);
    // -ItemType, su alias -Type y cualquier abreviatura (-t, -it…); con una variable no se sabe qué crea.
    const itemTypes = ps.params.filter((p) => ['itemtype', 'type'].some((n) => n.startsWith(p.name))).map((p) => p.value);
    if (itemTypes.some((t) => t?.dynamic)) return 'tipo de elemento con variables, no verificable (podría crear un enlace)';
    if (itemTypes.some((t) => /symbolic|junction|hard/i.test(t?.text ?? ''))) return 'crear enlaces o junctions permite salir del worktree';
    const targets: Word[] = [];
    if (mode === 'ps') {
      targets.push(...ps.positional);
      for (const p of ps.params) if (p.kind !== 'value' && p.value) targets.push(p.value);
    } else {
      const dest = ps.params.filter((p) => p.kind === 'dest' && p.value).map((p) => p.value as Word);
      targets.push(...(dest.length > 0 ? dest : ps.positional.slice(1, 2)));
    }
    return firstWriteProblem(targets, c);
  }

  const optionLike = (t: string) => (t.startsWith('-') && t !== '-') || (c.kind === 'cmd' && /^\/[A-Za-z?]/.test(t));
  const endOfOptions = args.findIndex((a) => a.text === '--');
  const positional = args.filter((a, k) => (endOfOptions >= 0 && k > endOfOptions) || (k !== endOfOptions && !optionLike(a.text)));
  const valueOf = (opts: readonly string[]): Word[] => {
    const found: Word[] = [];
    args.forEach((a, k) => {
      for (const o of opts) {
        if (a.text === o && args[k + 1]) found.push(args[k + 1] as Word);
        else if (o.startsWith('--') && a.text.startsWith(`${o}=`)) found.push({ ...a, text: a.text.slice(o.length + 1) });
      }
    });
    return found;
  };

  switch (mode) {
    case 'all':
      return firstWriteProblem(positional, c);
    case 'dest-last': {
      const explicit = valueOf(['-t', '--target-directory']);
      const dest = explicit.length > 0 ? explicit : positional.length >= 2 ? [positional.at(-1) as Word] : [];
      return firstWriteProblem(dest, c);
    }
    case 'dest-second':
      return firstWriteProblem(positional.slice(1, 2), c);
    case 'sed': {
      const inPlace = args.some((a) => /^-[A-Za-z]*i/.test(a.text) || a.text.startsWith('--in-place'));
      if (!inPlace) return undefined;
      const hasScriptOpt = args.some((a) => a.text === '-e' || a.text === '-f' || a.text.startsWith('--expression') || a.text.startsWith('--file'));
      return firstWriteProblem(hasScriptOpt ? positional : positional.slice(1), c);
    }
    case 'dd':
      return firstWriteProblem(args.filter((a) => a.text.startsWith('of=')).map((a) => ({ ...a, text: a.text.slice(3) })), c);
    case 'tar':
      if (args.some((a) => a.text === '-P' || longOpt(a.text, '--absolute-names', 4))) return 'tar --absolute-names escribe fuera del worktree';
      return firstWriteProblem(valueOf(['-C', '--directory']), c);
    case 'unzip':
      return firstWriteProblem(valueOf(['-d']), c);
    case '7z':
      return firstWriteProblem(args.filter((a) => /^-o./.test(a.text)).map((a) => ({ ...a, text: a.text.slice(2) })), c);
    case 'curl':
      return firstWriteProblem(valueOf(['-o', '--output', '--output-dir']), c);
    case 'wget':
      return firstWriteProblem(valueOf(['-O', '--output-document', '-P', '--directory-prefix', '-o', '--output-file']), c);
  }
  return undefined;
}

/** Motivo de denegación de un comando de Bash, PowerShell o cmd ejecutado en `worktree`; undefined si se permite. */
export async function shellCommandProblem(command: string, kind: ShellKind, worktree: string, cwd: string = worktree): Promise<string | undefined> {
  return evalShell(command, { worktree: path.resolve(worktree), kind, depth: 0, cwd: path.resolve(cwd) });
}
