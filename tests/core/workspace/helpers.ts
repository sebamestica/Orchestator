import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskBrief } from '../../../src/shared/index.ts';
import type { CommandSpecInput } from '../../../src/core/workspace/index.ts';

export interface TempRepo {
  base: string;
  repo: string;
  worktreesRoot: string;
  git: (cwd: string, ...args: string[]) => string;
  cleanup: () => void;
}

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

let template: string | undefined;

/**
 * Plantilla creada una vez por proceso de pruebas: copiarla cuesta mucho menos que lanzar git
 * siete veces por prueba (en Windows cada proceso es caro y la flota comparte el equipo).
 */
function repoTemplate(): string {
  if (template && existsSync(template)) return template;
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orq-wt-plantilla-')));
  gitIn(dir, 'init', '-q', '--template=', '-b', 'main');
  gitIn(dir, 'config', 'user.name', 'Prueba');
  gitIn(dir, 'config', 'user.email', 'prueba@example.invalid');
  gitIn(dir, 'config', 'commit.gpgsign', 'false');
  gitIn(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.postcreate-ok\n');
  writeFileSync(join(dir, 'a.txt'), 'linea original\n');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-q', '-m', 'inicial');
  mkdirSync(join(dir, 'node_modules', 'paquete'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'paquete', 'keep.txt'), 'no borrar');
  mkdirSync(join(dir, 'workbench'));
  writeFileSync(join(dir, 'workbench', 'keep.txt'), 'no borrar');
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  template = dir;
  return dir;
}

/** Repo git real en `os.tmpdir()` con un commit inicial, `node_modules` ignorado y `workbench` sin ignorar. */
export function makeRepo(): TempRepo {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'orq-wt-')));
  const repo = join(base, 'repo');
  cpSync(repoTemplate(), repo, { recursive: true });
  const cleanup = () => {
    try {
      rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* temporal: si Windows retiene algo, se queda */
    }
  };
  return { base, repo, worktreesRoot: join(base, 'worktrees'), git: gitIn, cleanup };
}

/** Comando de node sin shell. */
export function nodeCmd(code: string, extra: Partial<CommandSpecInput> = {}): CommandSpecInput {
  return { command: process.execPath, args: ['-e', code], ...extra };
}

export function brief(id: string): TaskBrief {
  return {
    id,
    projectId: 'demo',
    title: `Tarea ${id}`,
    objective: 'prueba',
    ownedPaths: ['src/**'],
    dependsOn: [],
    acceptance: ['pasa'],
    difficulty: 'low',
    contextRefs: [],
    skillRefs: [],
  };
}

/** Escribe un archivo y lo confirma en el worktree indicado. */
export function commitFile(t: TempRepo, cwd: string, file: string, content: string, msg = `cambia ${file}`): void {
  writeFileSync(join(cwd, file), content);
  t.git(cwd, 'add', file);
  t.git(cwd, 'commit', '-q', '-m', msg);
}

export function head(t: TempRepo, cwd: string, ref = 'HEAD'): string {
  return t.git(cwd, 'rev-parse', ref).trim();
}
