/**
 * Lista blanca de la guardia de git: los únicos subcomandos (y opciones) que el módulo puede lanzar.
 * Todo lo que no esté aquí se niega (push, rebase, reset, clean, checkout, read-tree, update-ref…).
 * Revisión de agy (2026-11-02): las listas negras se evadían con alias, `include.path`, `--no-dry-run`,
 * `branch -m`, `update-ref` con 40 ceros o comandos de fontanería.
 */
export interface SubcommandRule {
  /** Banderas sin valor, en su forma exacta (`--porcelain`, `--untracked-files=no`). */
  flags?: readonly string[];
  /** Opciones que consumen el argumento siguiente (`-m <mensaje>`, `-b <rama>`). */
  valued?: readonly string[];
  /** Opciones con el valor pegado (`--format=%s`). */
  prefixed?: readonly string[];
  /** Acepta `--` (lo que sigue son rutas o la rama, nunca opciones). */
  dashDash?: boolean;
  minPositionals?: number;
  maxPositionals: number;
  /** Se permite con cwd en la copia del usuario (no cambia su rama ni su árbol). */
  inUserCheckout: boolean;
  /** Validación extra de la forma completa: devuelve el motivo si se niega. */
  check?: (form: ParsedForm) => string | undefined;
}

export interface ParsedForm {
  options: readonly string[];
  positionals: readonly string[];
}

/** Opciones globales permitidas: ninguna cambia la configuración ni el destino. */
export const ALLOWED_GLOBALS: ReadonlySet<string> = new Set(['--no-pager', '--no-optional-locks', '--literal-pathspecs']);

/** Claves que el módulo puede leer con `git config --local --get`. */
const READABLE_CONFIG = new Set(['extensions.worktreeconfig', 'core.worktree', 'core.bare']);

function checkConfig({ options, positionals }: ParsedForm): string | undefined {
  const key = positionals[0]?.toLowerCase();
  const read = options.length === 2 && options.includes('--local') && options.includes('--get') && positionals.length === 1;
  if (read && key !== undefined && READABLE_CONFIG.has(key)) return undefined;
  // Única escritura: habilitar la config por worktree (el bloqueo de push la necesita).
  const write = options.length === 1 && options[0] === '--local' && key === 'extensions.worktreeconfig' && positionals[1] === 'true';
  if (write && positionals.length === 2) return undefined;
  return 'solo se permite leer extensions.worktreeConfig/core.worktree/core.bare o habilitar extensions.worktreeConfig';
}

function checkBranch({ options, positionals }: ParsedForm): string | undefined {
  if (options.length === 0 && positionals.length === 2) return undefined; // crear: branch <nueva> <desde>
  if (options.length === 1 && options[0] === '--list' && positionals.length <= 1) return undefined;
  return 'branch solo crea ramas (branch <nueva> <desde>) o las lista';
}

function checkMerge({ options, positionals }: ParsedForm): string | undefined {
  if (options.includes('--abort')) return options.length === 1 && positionals.length === 0 ? undefined : '«merge --abort» va solo';
  return positionals.length === 1 ? undefined : 'merge integra exactamente una rama';
}

const READ_ONLY = { inUserCheckout: true } as const;

export const RULES: Readonly<Record<string, SubcommandRule>> = {
  'rev-parse': { ...READ_ONLY, flags: ['--verify', '--quiet', '-q', '--abbrev-ref', '--git-common-dir', '--show-toplevel'], valued: ['--git-path'], maxPositionals: 2 },
  status: { ...READ_ONLY, flags: ['--porcelain', '--porcelain=v1', '-z', '--untracked-files=all', '--untracked-files=no', '--untracked-files=normal'], maxPositionals: 0 },
  diff: { ...READ_ONLY, flags: ['--name-only', '--diff-filter=U', '-z', '--cached', '--stat'], dashDash: true, maxPositionals: 2 },
  'check-ignore': { ...READ_ONLY, flags: ['-q', '--quiet', '--no-index', '-z', '-v'], dashDash: true, minPositionals: 1, maxPositionals: 1000 },
  log: { ...READ_ONLY, flags: ['--oneline', '-1'], valued: ['-n'], prefixed: ['--format=', '--max-count='], maxPositionals: 1 },
  'ls-files': { ...READ_ONLY, flags: ['-z'], dashDash: true, maxPositionals: 1000 },
  'rev-list': { ...READ_ONLY, flags: ['--count', '--merges', '--parents'], valued: ['-n'], maxPositionals: 2 },
  remote: { ...READ_ONLY, maxPositionals: 0 },
  branch: { ...READ_ONLY, flags: ['--list'], maxPositionals: 2, check: checkBranch },
  config: { ...READ_ONLY, flags: ['--local', '--get'], maxPositionals: 2, check: checkConfig },
  'worktree add': { ...READ_ONLY, flags: ['--relative-paths'], valued: ['-b'], minPositionals: 1, maxPositionals: 2 },
  'worktree remove': { ...READ_ONLY, minPositionals: 1, maxPositionals: 1 },
  'worktree prune': { ...READ_ONLY, maxPositionals: 0 },
  'worktree list': { ...READ_ONLY, flags: ['--porcelain'], maxPositionals: 0 },
  // Solo fuera de la copia del usuario (worktree de integración o de tarea):
  merge: { inUserCheckout: false, flags: ['--no-ff', '--no-commit', '--abort'], dashDash: true, maxPositionals: 1, check: checkMerge },
  commit: { inUserCheckout: false, flags: ['--no-edit', '-q'], valued: ['-m'], maxPositionals: 0 },
  // Paso de commit de la flota (src/core/app/commit-step.ts): solo en worktrees de tarea, nunca en la copia del usuario.
  add: { inUserCheckout: false, flags: ['-A'], dashDash: true, maxPositionals: 1000 },
};

/** Subcomandos con sub-subcomando (`worktree add`). */
export const NESTED: ReadonlySet<string> = new Set(['worktree']);
