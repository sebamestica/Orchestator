import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IntegrationResult, Workspace } from '../../shared/contracts.ts';
import { redactSecrets } from '../../shared/index.ts';
import { runCommands, summarizeCommands } from './commands.ts';
import { branchSchema, INTEGRATION_DIR } from './config.ts';
import type { WorkspaceProject } from './config.ts';
import { GitError } from './git.ts';
import type { GitRunner } from './git.ts';
import { createLinks, excludeLinks } from './links.ts';
import { removeUntracked } from './leftovers.ts';
import { blockPush } from './push-block.ts';

/** Carpeta del worktree de integración del proyecto (nunca la copia del usuario). */
export function integrationPath(project: WorkspaceProject): string {
  return join(project.worktreesRoot, INTEGRATION_DIR);
}

export async function branchExists(git: GitRunner, cwd: string, branch: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { check: false });
  return r.code === 0;
}

/** Crea la rama de integración desde la base si no existe (no cambia la rama del usuario). */
export async function ensureIntegrationBranch(git: GitRunner, project: WorkspaceProject): Promise<void> {
  if (await branchExists(git, project.repoPath, project.integrationBranch)) return;
  await git(project.repoPath, ['branch', project.integrationBranch, project.baseBranch]);
}

async function mergeInProgress(git: GitRunner, cwd: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { check: false });
  return r.code === 0;
}

/** Prepara (o reutiliza) el worktree de integración y comprueba que esté limpio. */
export async function ensureIntegrationWorktree(git: GitRunner, project: WorkspaceProject): Promise<string> {
  const path = integrationPath(project);
  if (!existsSync(path)) {
    await ensureIntegrationBranch(git, project);
    await git(project.repoPath, ['worktree', 'prune']);
    await git(project.repoPath, ['worktree', 'add', '--relative-paths', path, project.integrationBranch]);
    await blockPush(git, path, project.hooksDir);
    await createLinks(project.repoPath, path, project.links);
    await excludeLinks(git, path, project.links);
  }
  const head = (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  if (head !== project.integrationBranch) {
    throw new Error(`el worktree de integración está en «${head}», se esperaba «${project.integrationBranch}»`);
  }
  // Un merge a medias de un proceso anterior que se cortó: se deshace antes de empezar.
  if (await mergeInProgress(git, path)) await git(path, ['merge', '--abort']);
  const status = (await git(path, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim();
  if (status !== '') throw new Error(`el worktree de integración tiene cambios sin confirmar:\n${status}`);
  return path;
}

async function listConflicts(git: GitRunner, cwd: string): Promise<string[]> {
  const r = await git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'], { check: false });
  return r.stdout.split('\0').filter(Boolean);
}

async function abortMerge(git: GitRunner, cwd: string): Promise<void> {
  if (await mergeInProgress(git, cwd)) await git(cwd, ['merge', '--abort']);
}

export interface IntegrateOptions {
  signal?: AbortSignal;
  /** Serializa los pasos que escriben en el repo con las creaciones del mismo proyecto (el gate queda fuera). */
  exclusive?: <T>(fn: () => Promise<T>) => Promise<T>;
}

type MergeStep = { kind: 'done'; result: IntegrationResult } | { kind: 'merged'; cwd: string };

/** Paso 1 (exclusivo): worktree limpio y `merge --no-ff --no-commit -- <rama>`; aborta si hay conflicto. */
async function startMerge(git: GitRunner, project: WorkspaceProject, workspace: Workspace): Promise<MergeStep> {
  const done = (result: IntegrationResult): MergeStep => ({ kind: 'done', result });
  if (!branchSchema.safeParse(workspace.branch).success) {
    return done({ ok: false, conflicts: [], gateSummary: `no ejecutado: nombre de rama no válido «${workspace.branch}»` });
  }
  const cwd = await ensureIntegrationWorktree(git, project);
  await removeUntracked(git, cwd);
  if (!(await branchExists(git, cwd, workspace.branch))) {
    return done({ ok: false, conflicts: [], gateSummary: `no ejecutado: la rama «${workspace.branch}» no existe` });
  }
  const merge = await git(cwd, ['merge', '--no-ff', '--no-commit', '--', workspace.branch], { check: false });
  if (merge.code !== 0) {
    const conflicts = await listConflicts(git, cwd);
    await abortMerge(git, cwd);
    await removeUntracked(git, cwd);
    const detail = redactSecrets((merge.stdout + merge.stderr).trim().split(/\r?\n/).slice(-5).join('\n'));
    return done({ ok: false, conflicts, gateSummary: `no ejecutado: el merge falló${conflicts.length ? ` con ${String(conflicts.length)} conflicto(s)` : ''}\n${detail}` });
  }
  if (!(await mergeInProgress(git, cwd))) {
    return done({ ok: true, conflicts: [], gateSummary: `no ejecutado: «${workspace.branch}» ya estaba integrada (sin cambios)` });
  }
  return { kind: 'merged', cwd };
}

/** Deshace el merge en curso y los restos no versionados que dejó el gate. */
async function rollback(git: GitRunner, cwd: string): Promise<void> {
  await abortMerge(git, cwd);
  await removeUntracked(git, cwd);
}

/**
 * Integra la rama de la tarea en la rama de integración, en su worktree propio:
 * `merge --no-ff --no-commit`, gate y commit; ante conflicto o gate fallido, `merge --abort`
 * (no queda commit ni merge a medias).
 */
export async function integrateWorkspace(git: GitRunner, project: WorkspaceProject, workspace: Workspace, opts: IntegrateOptions = {}): Promise<IntegrationResult> {
  const exclusive = opts.exclusive ?? (<T>(fn: () => Promise<T>) => fn());
  const step = await exclusive(() => startMerge(git, project, workspace));
  if (step.kind === 'done') return step.result;
  const { cwd } = step;

  let gateSummary: string;
  try {
    // El gate es de la rama ya fusionada (lo cubren ownedPaths y la revisión); el programa que lo lanza no sale de ahí.
    const results = await runCommands(project.gate, cwd, opts.signal, { untrustedRoots: [project.worktreesRoot] });
    gateSummary = summarizeCommands(results, project.gate.length);
    if (results.some((r) => !r.ok)) {
      await exclusive(() => rollback(git, cwd));
      return { ok: false, conflicts: [], gateSummary };
    }
  } catch (err) {
    await exclusive(() => rollback(git, cwd));
    throw err;
  }

  const message = `merge: integra ${workspace.branch} (tarea ${workspace.taskId})`;
  return exclusive(async () => {
    try {
      await git(cwd, ['commit', '--no-edit', '-m', message]);
    } catch (err) {
      await rollback(git, cwd);
      const why = err instanceof GitError ? err.message : String(err);
      return { ok: false, conflicts: [], gateSummary: `${gateSummary}\ncommit fallido: ${redactSecrets(why)}` };
    }
    const commit = (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
    return { ok: true, conflicts: [], gateSummary, commit };
  });
}
