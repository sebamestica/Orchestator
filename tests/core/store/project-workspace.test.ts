import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../../src/core/store/schema.ts';
import { projectInputSchema, SqliteStore, StoreError } from '../../../src/core/store/index.ts';

const T0 = '2026-11-03T12:00:00.000Z';
let dir: string;
const open: SqliteStore[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orq-store-ws-'));
});
afterEach(async () => {
  for (const s of open.splice(0)) s.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function store(path = ':memory:'): SqliteStore {
  const s = new SqliteStore({ path, timeZone: 'UTC', now: () => new Date(T0) });
  open.push(s);
  return s;
}

const workspace = {
  worktreesRoot: 'C:\\dev\\.worktrees\\demo-orq',
  links: ['node_modules', '.tools'],
  postCreate: [{ command: 'node', args: ['-e', "console.log('ok')"] }],
  gate: [{ command: 'npm.cmd', args: ['run', '-s', 'gate'], timeoutMs: 1_800_000 }],
};

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(StoreError);
    return (err as StoreError).code;
  }
  throw new Error('se esperaba StoreError');
}

describe('proyectos con configuración de worktrees (workspace)', () => {
  it('guarda y devuelve el workspace con los valores por defecto de c3', () => {
    const s = store();
    const saved = s.putProject({ id: 'demo', name: 'Demo', repoPath: 'C:\\dev\\demo', workspace });
    const expected = {
      id: 'demo',
      name: 'Demo',
      repoPath: 'C:\\dev\\demo',
      workspace: {
        ...workspace,
        baseBranch: 'main',
        integrationBranch: 'orq/integracion',
        postCreate: [{ command: 'node', args: ['-e', "console.log('ok')"], timeoutMs: 600_000, env: {} }],
        gate: [{ command: 'npm.cmd', args: ['run', '-s', 'gate'], timeoutMs: 1_800_000, env: {} }],
      },
      createdAt: T0,
    };
    expect(saved).toEqual(expected);
    expect(s.getProject('demo')).toEqual(expected);
    expect(s.listProjects()).toEqual([expected]);
  });

  it('sin workspace el proyecto queda igual que antes (sin la clave «workspace»)', () => {
    const s = store();
    const saved = s.putProject({ id: 'viejo', name: 'Viejo', repoPath: 'C:\\dev\\viejo' });
    expect(saved).toEqual({ id: 'viejo', name: 'Viejo', repoPath: 'C:\\dev\\viejo', createdAt: T0 });
    expect(Object.keys(s.getProject('viejo') ?? {})).toEqual(['id', 'name', 'repoPath', 'createdAt']);
  });

  it('putProject reemplaza el proyecto entero: sin workspace, lo quita', () => {
    const s = store();
    s.putProject({ id: 'demo', name: 'Demo', repoPath: 'C:\\dev\\demo', workspace });
    s.putProject({ id: 'demo', name: 'Demo', repoPath: 'C:\\dev\\demo' });
    expect(s.getProject('demo')?.workspace).toBeUndefined();
  });

  it('rechaza un workspace no válido: sin gate, enlaces fuera del repo, raíz dentro de la copia, ramas iguales, hooksDir, campos de más', () => {
    const s = store();
    const base = { id: 'demo', name: 'Demo', repoPath: 'C:\\dev\\demo' };
    const bad: unknown[] = [
      { ...workspace, gate: [] },
      { links: ['node_modules'] },
      { ...workspace, links: ['..\\fuera'] },
      { ...workspace, links: ['C:\\abs'] },
      { ...workspace, worktreesRoot: 'C:\\dev\\demo\\.wt' },
      { ...workspace, baseBranch: 'main', integrationBranch: 'main' },
      { ...workspace, desconocido: true },
      { ...workspace, hooksDir: 'C:\\dev\\demo\\.git\\hooks' },
      { ...workspace, gate: [{ command: '' }] },
    ];
    for (const w of bad) expect(code(() => s.putProject({ ...base, workspace: w } as never)), JSON.stringify(w)).toBe('invalid');
    expect(s.listProjects()).toEqual([]);
  });

  it('la validación explica el motivo (el servidor lo devuelve en el 400)', () => {
    const r = projectInputSchema.safeParse({ id: 'demo', name: 'D', repoPath: 'C:\\dev\\demo', workspace: { ...workspace, worktreesRoot: 'C:\\dev\\demo\\wt' } });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([
      'workspace: worktreesRoot (C:\\dev\\demo\\wt) no puede estar dentro de la copia del usuario',
    ]);
    const sinGate = projectInputSchema.safeParse({ id: 'demo', name: 'D', repoPath: 'C:\\dev\\demo', workspace: { ...workspace, gate: [] } });
    expect(sinGate.error?.issues[0]?.message).toMatch(/gate es obligatorio/);
  });

  it('un workspace con forma de clave se rechaza (no se guarda un gate tachado)', () => {
    const s = store();
    const key = `sk-ant-api03-${'x'.repeat(30)}`;
    const err = (() => {
      try {
        s.putProject({ id: 'demo', name: 'Demo', repoPath: 'C:\\dev\\demo', workspace: { ...workspace, gate: [{ command: 'node', args: [], env: { TOKEN: key } }] } });
      } catch (e) {
        return e as StoreError;
      }
      return undefined;
    })();
    expect(err?.code).toBe('invalid');
    expect(err?.message).toMatch(/no puede llevar claves/);
    expect(err?.message).not.toContain(key);
    expect(s.getProject('demo')).toBeUndefined();
  });

  it('migra una base v1 existente: conserva los proyectos y agrega la columna sin workspace', () => {
    const path = join(dir, 'v1.db');
    const db = new DatabaseSync(path);
    db.exec(MIGRATIONS[0] ?? '');
    db.exec('PRAGMA user_version = 1');
    db.prepare('INSERT INTO projects (id, name, repo_path, created_at) VALUES (?, ?, ?, ?)').run('viejo', 'Viejo', 'C:\\dev\\viejo', T0);
    db.close();

    const s = store(path);
    expect(s.schemaVersion()).toBe(MIGRATIONS.length);
    expect(s.getProject('viejo')).toEqual({ id: 'viejo', name: 'Viejo', repoPath: 'C:\\dev\\viejo', createdAt: T0 });
    s.putProject({ id: 'nuevo', name: 'Nuevo', repoPath: 'C:\\dev\\nuevo', workspace });
    s.close();
    // Al reabrir no se vuelve a migrar y el workspace sigue ahí.
    const again = store(path);
    expect(again.getProject('nuevo')?.workspace?.gate[0]?.command).toBe('npm.cmd');
    expect(again.getProject('viejo')?.workspace).toBeUndefined();
  });
});
