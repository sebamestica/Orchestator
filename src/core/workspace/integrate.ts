import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { IntegrationResult, Workspace } from '../../shared/contracts.ts';
import { redactSecrets } from '../../shared/index.ts';
import { runCommands, summarizeCommands } from './commands.ts';
import { branchSchema, INTEGRATION_DIR } from './config.ts';
import type { WorkspaceProject } from './config.ts';
import { GitError } from './git.ts';
import type { GitRunner } from './git.ts';
import { createLinks, excludeLinks, removeAllLinks } from './links.ts';
import { gateModifiedNote, modifiedTracked, removeUntracked } from './leftovers.ts';
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

async function addIntegrationWorktree(git: GitRunner, project: WorkspaceProject, path: string): Promise<void> {
  await ensureIntegrationBranch(git, project);
  await git(project.repoPath, ['worktree', 'prune']);
  await git(project.repoPath, ['worktree', 'add', '--relative-paths', path, project.integrationBranch]);
  await blockPush(git, path, project.hooksDir);
  await createLinks(project.repoPath, path, project.links);
  await excludeLinks(git, path, project.links);
}

async function isClean(git: GitRunner, path: string): Promise<boolean> {
  if (await mergeInProgress(git, path)) return false;
  return (await git(path, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim() === '';
}

/**
 * Deja el worktree de integración igual que su rama: sin merge a medias, sin restos no versionados y sin cambios en
 * archivos versionados (los que deja un gate o un proceso cortado). Si `merge --abort` no basta, o falla («not
 * uptodate»), recrea la carpeta como `discardFresh` (enlaces fuera sin seguirlos, borrado y `worktree prune`): ahí
 * no se pierde nada, lo confirmado está en la rama de integración. La guardia no permite `reset` ni `checkout`.
 */
async function restoreIntegration(git: GitRunner, project: WorkspaceProject, path: string): Promise<void> {
  if (await mergeInProgress(git, path)) await git(path, ['merge', '--abort'], { check: false });
  await removeUntracked(git, path);
  if (await isClean(git, path)) return;
  await removeAllLinks(path);
  await rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 1_000 });
  await addIntegrationWorktree(git, project, path);
}

/** Prepara (o reutiliza) el worktree de integración y lo deja limpio (ver `restoreIntegration`). */
export async function ensureIntegrationWorktree(git: GitRunner, project: WorkspaceProject): Promise<string> {
  const path = integrationPath(project);
  if (!existsSync(path)) await addIntegrationWorktree(git, project, path);
  const head = (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  if (head !== project.integrationBranch) {
    throw new Error(`el worktree de integración está en «${head}», se esperaba «${project.integrationBranch}»`);
  }
  await restoreIntegration(git, project, path);
  return path;
}

async function listConflicts(git: GitRunner, cwd: string): Promise<string[]> {
  const r = await git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'], { check: false });
  return r.stdout.split('\0').filter(Boolean);
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
  if (!(await branchExists(git, cwd, workspace.branch))) {
    return done({ ok: false, conflicts: [], gateSummary: `no ejecutado: la rama «${workspace.branch}» no existe` });
  }
  const merge = await git(cwd, ['merge', '--no-ff', '--no-commit', '--', workspace.branch], { check: false });
  if (merge.code !== 0) {
    const conflicts = await listConflicts(git, cwd);
    await restoreIntegration(git, project, cwd);
    const detail = redactSecrets((merge.stdout + merge.stderr).trim().split(/\r?\n/).slice(-5).join('\n'));
    return done({ ok: false, conflicts, gateSummary: `no ejecutado: el merge falló${conflicts.length ? ` con ${String(conflicts.length)} conflicto(s)` : ''}\n${detail}` });
  }
  if (!(await mergeInProgress(git, cwd))) {
    return done({ ok: true, conflicts: [], gateSummary: `no ejecutado: «${workspace.branch}» ya estaba integrada (sin cambios)` });
  }
  return { kind: 'merged', cwd };
}

/**
 * Integra la rama de la tarea en la rama de integración, en su worktree propio:
 * `merge --no-ff --no-commit`, gate y commit; ante conflicto, gate fallido o gate que modificó archivos
 * versionados, se deshace todo (no queda commit, merge a medias ni cambios: ver `restoreIntegration`).
 */
export async function integrateWorkspace(git: GitRunner, project: WorkspaceProject, workspace: Workspace, opts: IntegrateOptions = {}): Promise<IntegrationResult> {
  const exclusive = opts.exclusive ?? (<T>(fn: () => Promise<T>) => fn());
  const step = await exclusive(() => startMerge(git, project, workspace));
  if (step.kind === 'done') return step.result;
  const { cwd } = step;
  const rollback = () => restoreIntegration(git, project, cwd);

  let gateSummary: string;
  try {
    // El gate es de la rama ya fusionada (lo cubren ownedPaths y la revisión); el programa que lo lanza no sale de ahí.
    const results = await runCommands(project.gate, cwd, opts.signal, { untrustedRoots: [project.worktreesRoot] });
    // El índice tiene el resultado del merge: lo que difiere en la copia de trabajo lo escribió el gate.
    const modified = await modifiedTracked(git, cwd);
    gateSummary = summarizeCommands(results, project.gate.length) + (modified.length ? `\n${gateModifiedNote(modified)}` : '');
    if (modified.length || results.some((r) => !r.ok)) {
      await exclusive(rollback);
      return { ok: false, conflicts: [], gateSummary };
    }
  } catch (err) {
    await exclusive(rollback);
    throw err;
  }

  const message = `merge: integra ${workspace.branch} (tarea ${workspace.taskId})`;
  return exclusive(async () => {
    try {
      await git(cwd, ['commit', '--no-edit', '-m', message]);
    } catch (err) {
      await rollback();
      const why = err instanceof GitError ? err.message : String(err);
      return { ok: false, conflicts: [], gateSummary: `${gateSummary}\ncommit fallido: ${redactSecrets(why)}` };
    }
    const commit = (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
    return { ok: true, conflicts: [], gateSummary, commit };
  });
}
