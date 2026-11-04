import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquire, defaultLocksRoot, KNOWN_LOCKS, listStale, LOCK_POOLS, LockError, LockManager, lockNameSchema, lockOwnerSchema, OWNER_FILE, release, withLock,
} from '../../../src/core/locks/index.ts';
import type { LockHandle } from '../../../src/core/locks/index.ts';
import { REDACTED } from '../../../src/shared/index.ts';

const HOUR = 3_600_000;
const c7 = { agent: 'c7', task: 'c7-locks' };
const codex = { agent: 'codex', task: 'fichas-razas' };
const contender = fileURLToPath(new URL('./contender.ts', import.meta.url));

let root: string;
let locks: LockManager;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orq-locks-'));
  locks = new LockManager({ root });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function lockError(promise: Promise<unknown>): Promise<LockError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LockError) return error;
    throw error;
  }
  throw new Error('se esperaba un LockError');
}

async function ownerJson(name: string) {
  const text = await readFile(join(root, name, OWNER_FILE), 'utf8');
  return { text, owner: lockOwnerSchema.parse(JSON.parse(text)) };
}

/** Candado creado como en la skill (bash): `mkdir` + `echo "<agente> <tarea> $(date -Is)" > owner`. */
async function skillLock(name: string, owner: string | Uint8Array) {
  const path = join(root, name);
  await mkdir(path);
  await writeFile(join(path, OWNER_FILE), owner);
}

describe('nombres de candado', () => {
  it('acepta los de la skill y nombres nuevos simples', () => {
    for (const name of [...KNOWN_LOCKS, 'blender', 'port.3100', 'gpu_cuda']) expect(lockNameSchema.safeParse(name).success, name).toBe(true);
  });

  it.each(['', '.', '..', '../gpu', 'gpu/..', 'a/b', 'a\\b', 'C:gpu', '/gpu', 'GPU', 'gpu.', 'a..b', 'con', 'nul.txt', 'com1', 'lpt9', ' gpu', 'gpu e2e', '-gpu', 'x'.repeat(65), 'gpu.releasing.1.abcdef12'])(
    'rechaza «%s» sin crear nada', async (name) => {
      expect((await lockError(locks.acquire(name, c7))).code).toBe('invalid_name');
      expect((await lockError(locks.release(name, 'a'.repeat(32)))).code).toBe('invalid_name');
      expect((await lockError(locks.releaseSkillLock(name, c7))).code).toBe('invalid_name');
      expect((await lockError(locks.read(name))).code).toBe('invalid_name');
      expect(await readdir(root)).toEqual([]);
    },
  );
});

describe('acquire y release', () => {
  it('crea la carpeta con un owner JSON de una línea validado con Zod', async () => {
    const handle = await locks.acquire('gpu', { ...c7, note: 'blender --threads 4' });
    expect(handle.path).toBe(join(root, 'gpu'));
    const { text, owner } = await ownerJson('gpu');
    expect(owner).toEqual({ agent: 'c7', task: 'c7-locks', pid: process.pid, host: hostname(), at: handle.owner.at, note: 'blender --threads 4', tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(text.trimEnd().includes('\n')).toBe(false);
    expect(text.endsWith('\n')).toBe(true);
    expect(Date.now() - Date.parse(owner.at)).toBeLessThan(60_000);
    // Sin restos del archivo temporal de la escritura atómica.
    expect(await readdir(handle.path)).toEqual([OWNER_FILE]);
    await handle.release();
    expect(await readdir(root)).toEqual([]);
  });

  it('falla de inmediato si está ocupado e informa al dueño', async () => {
    await locks.acquire('gpu', c7);
    const started = performance.now();
    const error = await lockError(locks.acquire('gpu', codex));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(error.code).toBe('busy');
    expect(error.holder).toMatchObject({ format: 'json', agent: 'c7', task: 'c7-locks', pid: process.pid });
    expect(error.message).toContain('c7/c7-locks');
    // No es reentrante: el mismo dueño tampoco lo toma dos veces.
    expect((await lockError(locks.acquire('gpu', c7))).code).toBe('busy');
  });

  it('solo el dueño libera: el token de otra adquisición recibe not_owner', async () => {
    const mine = await locks.acquire('e2e', c7);
    const theirs = await locks.acquire('gpu', codex);
    const before = await readFile(join(root, 'e2e', OWNER_FILE), 'utf8');
    const other = await lockError(locks.release('e2e', theirs));
    expect(other.code).toBe('not_owner');
    expect(other.holder).toMatchObject({ agent: 'c7' });
    expect(other.message).toContain('Ese token no es el de la adquisición vigente de e2e');
    expect(await readFile(join(root, 'e2e', OWNER_FILE), 'utf8')).toBe(before);
    // El dueño puede liberar con el token suelto, sin el handle.
    await locks.release('e2e', mine.token);
    expect(await locks.read('e2e')).toBeUndefined();
    expect((await lockError(locks.release('e2e', mine))).code).toBe('not_held');
  });

  it('rechaza dueños inválidos sin crear la carpeta', async () => {
    for (const owner of [{ agent: 'C7', task: 'x1' }, { agent: 'c7', task: '../x' }, { agent: '', task: 'x1' }, { agent: 'c7', task: 'a b' }]) {
      expect((await lockError(locks.acquire('gpu', owner))).code).toBe('invalid_owner');
    }
    expect(await readdir(root)).toEqual([]);
  });
});

describe('dos dueños simultáneos', () => {
  it('entre promesas en paralelo solo una gana (5 rondas de 16)', async () => {
    for (let round = 0; round < 5; round++) {
      const owners = Array.from({ length: 16 }, (_, i) => ({ agent: `agente-${i}`, task: `ronda-${round}` }));
      const results = await Promise.allSettled(owners.map((owner) => locks.acquire('gpu', owner)));
      const winners = results.filter((r) => r.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'busy' });
      const winner = winners[0]?.status === 'fulfilled' ? winners[0].value : undefined;
      expect((await ownerJson('gpu')).owner.agent).toBe(winner?.owner.agent);
      await winner?.release();
    }
  });

  it('entre procesos de Node separados solo uno gana', async () => {
    const agents = ['proc-a', 'proc-b', 'proc-c', 'proc-d'];
    const children = agents.map((agent) => {
      const child = spawn(process.execPath, [contender, root, agent, 'gpu'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const lines = createInterface({ input: child.stdout });
      const ready = new Promise<void>((resolve, reject) => {
        lines.once('line', (line) => (line === 'ready' ? resolve() : reject(new Error(line))));
        child.once('exit', () => reject(new Error(`salió antes de estar listo: ${stderr}`)));
      });
      const result = new Promise<{ agent: string; pid: number; won: boolean; code?: string }>((resolve, reject) => {
        lines.on('line', (line) => { if (line !== 'ready') resolve(JSON.parse(line)); });
        child.once('exit', (code) => reject(new Error(`salió (${code}) sin resultado: ${stderr}`)));
      });
      return { child, ready, result };
    });
    await Promise.all(children.map((c) => c.ready));
    // Todos parten a la vez: la señal sale a los 4 procesos en el mismo tick.
    for (const { child } of children) child.stdin.end('go\n');
    const results = await Promise.all(children.map((c) => c.result));
    const winners = results.filter((r) => r.won);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => !r.won).map((r) => r.code)).toEqual(['busy', 'busy', 'busy']);
    const { owner } = await ownerJson('gpu');
    expect(owner).toMatchObject({ agent: winners[0]?.agent, task: 'carrera', pid: winners[0]?.pid });
  });

  it.each(['blender-mcp', 'slicer-mcp'] as const)('%s: sesión interactiva con un único dueño', async (pool) => {
    expect(LOCK_POOLS[pool]).toEqual([pool]);
    const owners = Array.from({ length: 3 }, (_, i) => ({ agent: `agente-${i}`, task: 'escena' }));
    const results = await Promise.allSettled(owners.map((owner) => locks.acquireAny(LOCK_POOLS[pool], owner)));
    expect(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.name] : []))).toEqual([pool]);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r.reason as LockError).code)).toEqual(['busy', 'busy']);
    // Con el candado de la orden de bash de la skill también queda ocupado para el núcleo.
    const held = results.find((r) => r.status === 'fulfilled');
    if (held?.status === 'fulfilled') await held.value.release();
    await skillLock(pool, 'agy inspeccion-escena 2026-11-03T01:00:00-03:00\n');
    expect((await lockError(locks.acquire(pool, c7))).code).toBe('busy');
  });

  it('heavy-cpu admite 2 trabajos: de 5 competidores ganan 2, uno por carpeta', async () => {
    const owners = Array.from({ length: 5 }, (_, i) => ({ agent: `blender-${i}`, task: 'malla' }));
    const results = await Promise.allSettled(owners.map((owner) => locks.acquireAny(LOCK_POOLS['heavy-cpu'], owner)));
    const won = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value.name] : []));
    expect(won.sort()).toEqual(['heavy-cpu-1', 'heavy-cpu-2']);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r.reason as LockError).code)).toEqual(['busy', 'busy', 'busy']);
  });
});

describe('espera con reintentos', () => {
  it('espera a que el dueño libere y entonces lo toma', async () => {
    const held = await locks.acquire('gpu', c7);
    setTimeout(() => void held.release(), 150);
    const started = performance.now();
    const handle = await locks.acquire('gpu', codex, { timeoutMs: 5000, retryMs: 20 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
    expect((await ownerJson('gpu')).owner.agent).toBe('codex');
    await handle.release();
  });

  it('se rinde con timeout al agotar el tope', async () => {
    await locks.acquire('gpu', c7);
    const started = performance.now();
    const error = await lockError(locks.acquire('gpu', codex, { timeoutMs: 250, retryMs: 30 }));
    expect(error.code).toBe('timeout');
    expect(performance.now() - started).toBeGreaterThanOrEqual(240);
    expect(error.holder).toMatchObject({ agent: 'c7' });
  });

  it('se cancela con AbortSignal y no toma un candado si ya estaba cancelado', async () => {
    await locks.acquire('gpu', c7);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('apagado')), 50);
    const started = performance.now();
    expect((await lockError(locks.acquire('gpu', codex, { timeoutMs: 10_000, retryMs: 20, signal: controller.signal }))).code).toBe('aborted');
    expect(performance.now() - started).toBeLessThan(2000);
    expect((await lockError(locks.acquire('e2e', codex, { signal: AbortSignal.abort() }))).code).toBe('aborted');
    expect(await locks.read('e2e')).toBeUndefined();
  });

  it('rechaza opciones inválidas', async () => {
    expect((await lockError(locks.acquire('gpu', c7, { timeoutMs: -1 }))).code).toBe('invalid_option');
    expect((await lockError(locks.acquire('gpu', c7, { timeoutMs: 100, retryMs: Number.NaN }))).code).toBe('invalid_option');
  });
});

describe('withLock', () => {
  it('devuelve el resultado y libera', async () => {
    const result = await locks.withLock('gpu', c7, async (lock) => {
      expect((await locks.read(lock.name))?.holder.agent).toBe('c7');
      return 42;
    });
    expect(result).toBe(42);
    expect(await locks.read('gpu')).toBeUndefined();
  });

  it('libera aunque fn lance (async o síncrona) y relanza el mismo error', async () => {
    const boom = new Error('render falló');
    await expect(locks.withLock('gpu', c7, async () => { throw boom; })).rejects.toBe(boom);
    expect(await locks.read('gpu')).toBeUndefined();
    await expect(locks.withLock('gpu', c7, () => { throw boom; })).rejects.toBe(boom);
    expect(await locks.read('gpu')).toBeUndefined();
    // Queda libre para otro dueño.
    await (await locks.acquire('gpu', codex)).release();
  });

  it('no ejecuta fn si el candado está ocupado', async () => {
    await locks.acquire('gpu', codex);
    const fn = vi.fn();
    expect((await lockError(locks.withLock('gpu', c7, fn))).code).toBe('busy');
    expect(fn).not.toHaveBeenCalled();
    expect((await locks.read('gpu'))?.holder.agent).toBe('codex');
  });

  it('nunca borra el candado de otro: si se lo quitaron, falla con not_owner (y AggregateError si fn también falló)', async () => {
    let thief: LockHandle | undefined;
    const steal = async () => {
      await rm(join(root, 'gpu'), { recursive: true });
      thief = await locks.acquire('gpu', codex);
    };
    expect((await lockError(locks.withLock('gpu', c7, steal))).code).toBe('not_owner');
    expect((await locks.read('gpu'))?.holder.agent).toBe('codex');
    await thief?.release();

    const boom = new Error('falló');
    const both = await locks.withLock('gpu', c7, async () => { await steal(); throw boom; }).catch((e: unknown) => e);
    expect(both).toBeInstanceOf(AggregateError);
    expect((both as AggregateError).errors[0]).toBe(boom);
    expect((both as AggregateError).errors[1]).toMatchObject({ code: 'not_owner' });
    expect((await locks.read('gpu'))?.holder.agent).toBe('codex');
  });

  it('tolera que el candado ya no exista al terminar', async () => {
    await expect(locks.withLock('gpu', c7, async (lock) => { await rm(lock.path, { recursive: true }); return 'ok'; })).resolves.toBe('ok');
  });

  it('acepta un grupo de candados equivalentes', async () => {
    await locks.acquire('heavy-cpu-1', codex);
    const name = await locks.withLock(LOCK_POOLS['heavy-cpu'], c7, (lock) => lock.name);
    expect(name).toBe('heavy-cpu-2');
    expect(await locks.read('heavy-cpu-2')).toBeUndefined();
  });
});

describe('listStale', () => {
  it('detecta candados de más de 3 h sin borrarlos', async () => {
    const handle = await locks.acquire('gpu', c7);
    await locks.acquire('e2e', codex);
    const at = Date.parse(handle.owner.at);
    expect(await locks.listStale()).toEqual([]);
    const later = new LockManager({ root, now: () => new Date(at + 3 * HOUR + 60_000) });
    const stale = await later.listStale();
    expect(stale.map((s) => s.name)).toEqual(['e2e', 'gpu']);
    expect(stale.find((s) => s.name === 'gpu')).toMatchObject({ path: join(root, 'gpu'), since: new Date(at).toISOString(), holder: { agent: 'c7', format: 'json' } });
    expect(stale.every((s) => s.ageMs > 3 * HOUR)).toBe(true);
    // Siguen ahí, con su dueño intacto.
    expect((await readdir(root)).sort()).toEqual(['e2e', 'gpu']);
    expect((await ownerJson('gpu')).owner.agent).toBe('c7');
    // Exactamente 3 h no es «más de 3 h»; el umbral se puede cambiar.
    expect(await new LockManager({ root, now: () => new Date(at + 3 * HOUR) }).listStale()).toHaveLength(0);
    expect(await new LockManager({ root, now: () => new Date(at + 2 * HOUR) }).listStale(1)).toHaveLength(2);
  });

  it('usa la fecha del owner de la skill o, si falta, la de la carpeta', async () => {
    const fourHoursAgo = new Date(Date.now() - 4 * HOUR);
    await skillLock('heavy-cpu-1', `agy fichas de razas ${fourHoursAgo.toISOString().replace('Z', '+00:00')}\n`);
    // Dueño que murió entre el mkdir y la escritura de owner: queda la carpeta vacía.
    const zombie = join(root, 'heavy-cpu-2');
    await mkdir(zombie);
    await utimes(zombie, new Date(Date.now() - 5 * HOUR), new Date(Date.now() - 5 * HOUR));
    await locks.acquire('gpu', c7);
    const stale = await locks.listStale();
    expect(stale.map((s) => [s.name, s.holder.format])).toEqual([['heavy-cpu-1', 'text'], ['heavy-cpu-2', 'missing']]);
    expect(stale[0]?.holder).toMatchObject({ agent: 'agy', task: 'fichas de razas' });
    expect(stale[1]?.ageMs).toBeGreaterThan(4.9 * HOUR);
    expect((await readdir(root)).sort()).toEqual(['gpu', 'heavy-cpu-1', 'heavy-cpu-2']);
  });

  it('ignora entradas que no son candados y raíces inexistentes', async () => {
    await writeFile(join(root, 'Notas.TXT'), 'x');
    await locks.acquire('gpu', c7);
    expect((await locks.list()).map((l) => l.name)).toEqual(['gpu']);
    expect(await new LockManager({ root: join(root, 'no-existe') }).listStale(0)).toEqual([]);
    expect((await lockError(locks.listStale(-1))).code).toBe('invalid_option');
  });
});

describe('compatibilidad con la skill local-compute-scheduling', () => {
  // La skill vive en el hub (antes en Vetworld/.agents/skills). En Windows, que es donde corren las pruebas, se
  // exige: si se mueve otra vez, la prueba falla en lugar de saltarse sin avisar.
  const skill = process.platform === 'win32'
    ? 'C:\\dev\\agent-hub\\skills\\local-compute-scheduling\\SKILL.md'
    : '/mnt/c/dev/agent-hub/skills/local-compute-scheduling/SKILL.md';

  it.skipIf(process.platform !== 'win32' && !existsSync(skill))('usa los mismos nombres de candado que la tabla de la skill', async () => {
    expect(existsSync(skill), `falta ${skill}`).toBe(true);
    const table = (await readFile(skill, 'utf8')).split('\n').filter((line) => line.startsWith('| `'));
    const names = table.flatMap((line) => [...(line.split('|')[1] ?? '').matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]));
    expect(new Set(names)).toEqual(new Set(KNOWN_LOCKS));
    // Columna «Simultáneos» de la tabla = carpetas del grupo en LOCK_POOLS.
    const slots = Object.fromEntries(table.map((line) => {
      const cells = line.split('|').map((c) => c.trim());
      return [(cells[1] ?? '').replace(/`/g, '').split(',')[0]?.trim().replace(/-\d+$/, '') ?? '', Number(cells[3])];
    }));
    expect(slots).toEqual(Object.fromEntries(Object.entries(LOCK_POOLS).map(([pool, names]) => [pool, names.length])));
  });

  it('respeta un candado tomado con la orden de bash de la skill', async () => {
    await skillLock('gpu', 'codex fichas-razas 2026-11-01T22:05:13-03:00\n');
    const busy = await lockError(locks.acquire('gpu', c7));
    expect(busy.code).toBe('busy');
    expect(busy.holder).toMatchObject({ format: 'text', agent: 'codex', task: 'fichas-razas', at: '2026-11-01T22:05:13-03:00' });
    expect((await locks.read('gpu'))?.since).toBe('2026-11-02T01:05:13.000Z');
    expect((await lockError(locks.releaseSkillLock('gpu', c7))).code).toBe('not_owner');
    expect((await lockError(locks.release('gpu', 'a'.repeat(32)))).code).toBe('not_owner');
    await locks.releaseSkillLock('gpu', codex);
    expect(await readdir(root)).toEqual([]);
  });

  it('lee el owner que escribe Windows PowerShell 5.1 (UTF-16 LE con BOM, CRLF)', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('agy e2e-smoke 2026-11-01T22:05:13.1234567-03:00\r\n', 'utf16le')]);
    await skillLock('e2e', utf16);
    expect((await locks.read('e2e'))?.holder).toMatchObject({ format: 'text', agent: 'agy', task: 'e2e-smoke', at: '2026-11-01T22:05:13.1234567-03:00' });
  });

  it.runIf(process.platform === 'win32')('convive con la orden de PowerShell de la skill (New-Item + owner con >)', async () => {
    await locks.acquire('gpu', c7);
    const quoted = (path: string) => `'${path.replaceAll("'", "''")}'`;
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$L = ${quoted(join(root, 'heavy-cpu-1'))}`,
      'New-Item -ItemType Directory $L | Out-Null',
      // Windows PowerShell 5.1: `>` escribe UTF-16 LE con BOM; Get-Date -Format o trae 7 decimales y zona.
      '"agy blender-malla $(Get-Date -Format o)" > "$L\\owner"',
      `try { New-Item -ItemType Directory ${quoted(join(root, 'gpu'))} | Out-Null; 'TOMADO' } catch { 'OCUPADO' }`,
    ].join('\n');
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString(); });
      child.once('error', reject);
      child.once('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`powershell salió con ${code}: ${err}`))));
    });
    expect(output).toBe('OCUPADO');
    const info = await locks.read('heavy-cpu-1');
    expect(info?.holder).toMatchObject({ format: 'text', agent: 'agy', task: 'blender-malla' });
    expect(Math.abs(Date.parse(info?.since ?? '') - Date.now())).toBeLessThan(60_000);
    expect((await lockError(locks.acquire('heavy-cpu-1', c7))).code).toBe('busy');
    expect((await locks.acquireAny(LOCK_POOLS['heavy-cpu'], c7)).name).toBe('heavy-cpu-2');
    expect((await ownerJson('gpu')).owner.agent).toBe('c7');
  });

  it('un candado del núcleo bloquea el mkdir de la skill', async () => {
    await locks.acquire('e2e', c7);
    await expect(mkdir(join(root, 'e2e'))).rejects.toMatchObject({ code: 'EEXIST' });
  });

  it('informa owners ilegibles sin fallar', async () => {
    await skillLock('gpu', '{"agent": "c7"');
    await skillLock('e2e', '{"agent":"c7","task":"t1"}');
    const all = await locks.list();
    expect(all.map((l) => l.holder.format)).toEqual(['invalid', 'invalid']);
    expect((await lockError(locks.acquire('gpu', c7))).code).toBe('busy');
    expect((await lockError(locks.release('gpu', 'a'.repeat(32)))).code).toBe('not_owner');
    expect((await lockError(locks.releaseSkillLock('gpu', c7))).code).toBe('not_owner');
  });
});

describe('seguridad', () => {
  const fakeKey = ['sk', 'ant', 'api03', 'x'.repeat(24)].join('-');

  it('redacta claves en la nota del owner y en owners de texto', async () => {
    const handle = await locks.acquire('gpu', { ...c7, note: `ANTHROPIC_API_KEY=${fakeKey} npm run e2e` });
    const { text } = await ownerJson('gpu');
    expect(text).not.toContain(fakeKey);
    expect(text).toContain(REDACTED);
    expect(handle.owner.note).not.toContain(fakeKey);
    await skillLock('e2e', `codex ${fakeKey} 2026-11-01T22:05:13-03:00\n`);
    const holder = (await locks.read('e2e'))?.holder;
    expect(JSON.stringify(holder)).not.toContain(fakeKey);
  });
});

describe('raíz por defecto y atajos', () => {
  it('apunta a C:\\dev\\agent-hub\\locks y se puede reemplazar', () => {
    expect(defaultLocksRoot({}, 'win32')).toBe('C:\\dev\\agent-hub\\locks');
    expect(defaultLocksRoot({}, 'linux')).toBe('/mnt/c/dev/agent-hub/locks');
    expect(defaultLocksRoot({ ORQ_LOCKS_ROOT: root }, 'win32')).toBe(root);
    expect(() => new LockManager({ root: 'locks' })).toThrow(LockError);
  });

  it('acquire, withLock, release y listStale usan ORQ_LOCKS_ROOT', async () => {
    vi.stubEnv('ORQ_LOCKS_ROOT', root);
    const handle = await acquire('gpu', c7);
    expect(handle.path).toBe(join(root, 'gpu'));
    expect(await listStale(0)).toHaveLength(1);
    expect(await withLock('e2e', c7, () => 'ok')).toBe('ok');
    await release('gpu', handle);
    expect(await readdir(root)).toEqual([]);
    expect((await stat(root)).isDirectory()).toBe(true);
  });
});
