/** Almacenamiento (issue 13): medición, vaciado que libera espacio, chats en curso y que nunca se toca un proyecto ni la bóveda. */
import { chmodSync, existsSync, lstatSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StorageCleanResponse, StorageSummary, UsageSummary } from '../../../src/shared/index.ts';
import { PNG } from '../chat/helpers.ts';
import { DAY, HOUR, age, fill, storageBench, type StorageBench } from './helpers.ts';

const benches: StorageBench[] = [];
async function bench(opts: Parameters<typeof storageBench>[0] = {}): Promise<StorageBench> {
  const b = await storageBench(opts);
  benches.push(b);
  return b;
}
afterEach(async () => {
  for (const b of benches.splice(0)) {
    b.release();
    await b.close();
  }
});

function pngOf(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  out.set(PNG);
  return out;
}

const n = (b: StorageBench, sql: string, ...params: string[]): number => Number((b.store.database.prepare(sql).get(...params) as { n: number }).n);

async function summary(b: StorageBench): Promise<StorageSummary> {
  const res = await b.call('GET', '/storage');
  expect(res.status).toBe(200);
  return (await b.json<{ storage: StorageSummary }>(res)).storage;
}

async function clean(b: StorageBench, path: string, body?: unknown): Promise<StorageCleanResponse> {
  const res = await b.call('POST', path, body);
  if (res.status !== 200) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return b.json<StorageCleanResponse>(res);
}

function diskBytes(path: string): number {
  return [path, `${path}-wal`, `${path}-shm`].reduce((s, p) => s + (existsSync(p) ? statSync(p).size : 0), 0);
}

describe('GET /storage', () => {
  it('mide los adjuntos subidos, los chats, las carpetas de conversaciones y la base; los proyectos no cuentan', async () => {
    const b = await bench();
    const img1 = await b.upload('captura.png', pngOf(5000), 'image/png');
    const img2 = await b.upload('foto.png', pngOf(3000), 'image/png');
    const txt = await b.upload('notas.md', new TextEncoder().encode('x'.repeat(1200)), 'text/markdown');
    const chat = await b.chat('mira esto', [img1.id, img2.id, txt.id]);
    await fill(join(b.convRoot, chat.id, 'src', 'a.txt'), 1000);
    await fill(join(b.convRoot, 'huerfana-0001', 'b.txt'), 2000);
    await age(join(b.convRoot, 'huerfana-0001'));
    await fill(join(b.repo, 'grande.bin'), 50_000);

    const s = await summary(b);
    expect(s.attachments.total).toEqual({ count: 3, bytes: 9200 });
    expect(s.attachments.images).toEqual({ count: 2, bytes: 8000 });
    expect(s.attachments.others).toEqual({ count: 1, bytes: 1200 });
    expect(s.attachments.orphans).toEqual({ count: 0, bytes: 0 });
    expect(s.attachments.dir).toBe(join(b.dataDir, 'attachments'));
    expect(s.chats).toMatchObject({ chats: 1, busy: 0, messages: 2, leftovers: { count: 0, bytes: 0 } });
    expect(s.chats.events).toBeGreaterThan(0);
    expect(s.chats.sessions).toBe(1);
    expect(s.chats.bytes).toBeGreaterThan(0);
    expect(s.chats.oldestUpdatedAt).not.toBeNull();
    expect(s.conversations).toMatchObject({ root: b.convRoot, exists: true, truncated: false, total: { count: 2, bytes: 3000 }, orphans: { count: 1, bytes: 2000 } });
    expect(s.database.path).toBe(b.dbPath);
    expect(s.database.totalBytes).toBe(diskBytes(b.dbPath));
    expect(s.database.totalBytes).toBe(s.database.fileBytes + s.database.walBytes + s.database.shmBytes);
    expect(s.database.chatBytes).toBe(s.chats.bytes + s.chats.leftovers.bytes);
    // Total = adjuntos + carpetas + base; los 50 KB del proyecto no aparecen.
    expect(s.totalBytes).toBe(9200 + 3000 + s.database.totalBytes);
  });

  it('sin carpeta de conversaciones ni adjuntos, todo en cero y la base medida igual', async () => {
    const b = await bench();
    const s = await summary(b);
    expect(s.attachments.total).toEqual({ count: 0, bytes: 0 });
    expect(s.conversations).toMatchObject({ exists: false, total: { count: 0, bytes: 0 } });
    expect(s.chats.oldestUpdatedAt).toBeNull();
    expect(s.totalBytes).toBe(s.database.totalBytes);
  });
});

describe('POST /storage/attachments/clean', () => {
  it('«sin usar» borra las copias que nadie usa y los archivos sueltos; respeta las usadas y lo recién subido', async () => {
    const b = await bench();
    const used = await b.upload('usada.png', pngOf(4000), 'image/png');
    const chat = await b.chat('con imagen', [used.id]);
    b.clock.now = new Date(Date.now() - 3 * HOUR);
    const old = await b.upload('vieja.png', pngOf(6000), 'image/png');
    b.clock.now = new Date();
    const recent = await b.upload('reciente.png', pngOf(2000), 'image/png');
    const loose = join(b.dataDir, 'attachments', 'suelto.bin');
    await fill(loose, 1500);
    await age(loose);

    expect((await summary(b)).attachments.orphans).toEqual({ count: 2, bytes: 7500 });
    const { result, storage } = await clean(b, '/storage/attachments/clean', { scope: 'orphans' });
    expect(result).toMatchObject({ target: 'attachments', freedBytes: 7500, compacted: false, deleted: { attachments: 1, files: 2 } });
    expect(result.skipped).toEqual([{ id: recent.id, reason: 'se subió hace menos de 1 h y aún no se envía' }]);
    expect(existsSync(old.path)).toBe(false);
    expect(existsSync(loose)).toBe(false);
    expect(existsSync(used.path)).toBe(true);
    expect(existsSync(recent.path)).toBe(true);
    expect(storage.attachments.total).toEqual({ count: 2, bytes: 6000 });
    expect(storage.attachments.orphans).toEqual({ count: 0, bytes: 0 });

    // «Todo»: también la usada (el chat no está ocupado); el chat conserva sus mensajes.
    const all = await clean(b, '/storage/attachments/clean', { scope: 'all' });
    expect(all.result).toMatchObject({ freedBytes: 4000, deleted: { attachments: 1, files: 1 } });
    expect(existsSync(used.path)).toBe(false);
    expect(existsSync(recent.path)).toBe(true);
    const { messages } = await b.json<{ messages: unknown[] }>(await b.call('GET', `/chats/${chat.id}/messages`));
    expect(messages).toHaveLength(2);
  });

  it('nunca borra un archivo registrado por ruta (es del usuario)', async () => {
    const b = await bench();
    const mine = join(b.repo, 'informe.md');
    await fill(mine, 800);
    const res = await b.call('POST', '/attachments/by-path', { path: mine });
    expect(res.status).toBe(201);
    b.clock.now = new Date(Date.now() + 3 * HOUR);
    expect((await summary(b)).attachments).toMatchObject({ linkedFiles: 1, total: { count: 0, bytes: 0 } });
    const { result } = await clean(b, '/storage/attachments/clean', { scope: 'all' });
    expect(result.deleted).toMatchObject({ attachments: 0, files: 0 });
    expect(readFileSync(mine).byteLength).toBe(800);
  });

  it('valida el cuerpo con Zod', async () => {
    const b = await bench();
    expect((await b.call('POST', '/storage/attachments/clean', { scope: 'todo' })).status).toBe(400);
    expect((await b.call('POST', '/storage/attachments/clean', { scope: 'all', extra: 1 })).status).toBe(400);
  });
});

describe('POST /storage/chats/clean', () => {
  it('«todos» borra chats con sus eventos, sesiones y carpeta, respeta el que responde, conserva el uso y compacta', async () => {
    const b = await bench();
    const a = await b.chat('uno');
    const c2 = await b.chat('dos');
    b.seed(a.sessionId, 1500);
    b.seed(`sub-${a.id}`, 40, { parentSessionId: a.sessionId });
    await fill(join(b.convRoot, a.id, 'trabajo', 'x.bin'), 3000);
    const usageRows = n(b, 'SELECT COUNT(*) AS n FROM usage WHERE session_id IN (?, ?)', a.sessionId, c2.sessionId);
    expect(usageRows).toBeGreaterThan(0);
    const usageBefore = (await b.json<UsageSummary>(await b.call('GET', '/usage/summary?period=month'))).totals;
    const vault = readFileSync(b.vaultPath, 'utf8');

    const busy = await b.chat();
    b.hold();
    expect((await b.call('POST', `/chats/${busy.id}/messages`, { text: 'espera' })).status).toBe(201);
    expect((await summary(b)).chats.busy).toBe(1);
    const before = diskBytes(b.dbPath);

    const { result, storage } = await clean(b, '/storage/chats/clean', { scope: 'all' });
    expect(result).toMatchObject({ target: 'chats', compacted: true, warnings: [], deleted: { chats: 2, messages: 4, folders: 1 } });
    expect(result.deleted.events).toBeGreaterThanOrEqual(1540);
    expect(result.deleted.sessions).toBeGreaterThanOrEqual(3);
    expect(result.skipped).toEqual([{ id: busy.id, reason: 'está respondiendo' }]);
    expect(result.freedBytes).toBeGreaterThan(1_000_000);
    expect(diskBytes(b.dbPath)).toBeLessThan(before - 1_000_000);

    const { chats } = await b.json<{ chats: { id: string }[] }>(await b.call('GET', '/chats'));
    expect(chats.map((c) => c.id)).toEqual([busy.id]);
    expect(storage.chats.chats).toBe(1);
    // Sin restos: ni eventos (salvo los de uso) ni sesiones de los chats borrados ni de su subagente.
    const gone = [a.sessionId, c2.sessionId, `sub-${a.id}`];
    for (const sid of gone) {
      expect(n(b, 'SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND id NOT IN (SELECT event_id FROM usage)', sid)).toBe(0);
      expect(n(b, 'SELECT COUNT(*) AS n FROM sessions WHERE id = ?', sid)).toBe(0);
    }
    expect(n(b, `SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id IN ('${a.id}', '${c2.id}')`)).toBe(0);
    expect(existsSync(join(b.convRoot, a.id))).toBe(false);
    expect(storage.chats.leftovers.count).toBe(0);
    // El historial de uso y el gasto total no cambian.
    expect(n(b, 'SELECT COUNT(*) AS n FROM usage WHERE session_id IN (?, ?)', a.sessionId, c2.sessionId)).toBe(usageRows);
    expect((await b.json<UsageSummary>(await b.call('GET', '/usage/summary?period=month'))).totals).toEqual(usageBefore);
    // Ni el proyecto ni la bóveda.
    expect(readFileSync(join(b.repo, 'README.md'), 'utf8')).toBe('# Proyecto del usuario\n');
    expect(readFileSync(b.vaultPath, 'utf8')).toBe(vault);
    expect(b.store.listProjects().map((p) => p.id)).toEqual(['demo']);

    b.release();
    await b.idle(busy.id);
  });

  it('respeta un chat con subagentes trabajando en segundo plano (y sus adjuntos)', async () => {
    const b = await bench();
    const img = await b.upload('ref.png', pngOf(2500), 'image/png');
    const chat = await b.chat('investiga', [img.id]);
    const { chat: live } = await b.json<{ chat: { backgroundTasks?: number } }>(await b.call('GET', `/chats/${chat.id}`));
    expect(live.backgroundTasks).toBe(1);
    expect((await summary(b)).chats.busy).toBe(1);

    const chats = await clean(b, '/storage/chats/clean', { scope: 'all' });
    expect(chats.result.skipped).toEqual([{ id: chat.id, reason: 'tiene 1 subagente trabajando' }]);
    expect(chats.result.deleted.chats).toBe(0);
    expect((await b.call('GET', `/chats/${chat.id}`)).status).toBe(200);

    const orphans = await clean(b, '/storage/attachments/clean', { scope: 'orphans' });
    expect(orphans.result.skipped).toEqual([]);
    const atts = await clean(b, '/storage/attachments/clean', { scope: 'all' });
    expect(atts.result.skipped).toEqual([{ id: img.id, reason: 'lo usa un chat que está respondiendo o con subagentes trabajando' }]);
    expect(existsSync(img.path)).toBe(true);
  });

  it('«de más de N días» borra solo los chats sin actividad reciente; sin días responde 400', async () => {
    const b = await bench();
    b.clock.now = new Date(Date.now() - 40 * DAY);
    const old = await b.chat('vieja');
    b.clock.now = new Date();
    const fresh = await b.chat('nueva');
    expect((await summary(b)).chats.oldestUpdatedAt?.slice(0, 10)).toBe(new Date(Date.now() - 40 * DAY).toISOString().slice(0, 10));

    expect((await b.call('POST', '/storage/chats/clean', { scope: 'older' })).status).toBe(400);
    expect((await b.call('POST', '/storage/chats/clean', { scope: 'older', olderThanDays: 0 })).status).toBe(400);
    const { result } = await clean(b, '/storage/chats/clean', { scope: 'older', olderThanDays: 30, compact: false });
    expect(result).toMatchObject({ compacted: false, deleted: { chats: 1 } });
    const { chats } = await b.json<{ chats: { id: string }[] }>(await b.call('GET', '/chats'));
    expect(chats.map((c) => c.id)).toEqual([fresh.id]);
    expect(chats.some((c) => c.id === old.id)).toBe(false);
  });

  it('«restos» borra mensajes, eventos y sesiones de chats ya borrados, sin tocar los vivos ni el uso', async () => {
    const b = await bench();
    const live = await b.chat('sigo vivo');
    const liveEvents = n(b, 'SELECT COUNT(*) AS n FROM events WHERE session_id = ?', live.sessionId);
    const gone = 'chat-00000000-0000-4000-b000-000000000001';
    b.seed(gone, 30);
    b.seed('sub-del-borrado', 10, { parentSessionId: gone });
    b.store.append({ type: 'usage', sessionId: gone, agentId: 'orquestador', seq: 500, ts: new Date().toISOString(), payload: { inputTokens: 10, outputTokens: 5, costUsd: 0.5, model: 'claude-opus-5-5' } });
    b.store.database
      .prepare(`INSERT INTO chat_messages (id, chat_id, role, text, attachments_json, mode, at) VALUES ('msg-huerfano-1', 'chat-que-no-existe', 'user', 'hola', '[]', 'plan', ?)`)
      .run(new Date().toISOString());

    expect((await summary(b)).chats.leftovers.count).toBe(30 + 10 + 2 + 1);
    const { result, storage } = await clean(b, '/storage/chats/clean', { scope: 'leftovers' });
    expect(result.deleted).toMatchObject({ chats: 0, messages: 1, events: 40, sessions: 2 });
    expect(storage.chats.leftovers).toEqual({ count: 0, bytes: 0 });
    expect(n(b, 'SELECT COUNT(*) AS n FROM usage WHERE session_id = ?', gone)).toBe(1);
    expect(n(b, 'SELECT COUNT(*) AS n FROM events WHERE session_id = ?', gone)).toBe(1);
    expect(n(b, 'SELECT COUNT(*) AS n FROM events WHERE session_id = ?', live.sessionId)).toBe(liveEvents);
    expect(storage.chats.chats).toBe(1);
  });

  it('sin el módulo del chat, borrar chats responde 501; los restos sí se vacían', async () => {
    const b = await bench({ noChat: true });
    const res = await b.call('POST', '/storage/chats/clean', { scope: 'all' });
    expect(res.status).toBe(501);
    expect((await b.json<{ error: { code: string } }>(res)).error.code).toBe('not_configured');
    expect((await b.call('POST', '/storage/chats/clean', { scope: 'leftovers' })).status).toBe(200);
    expect((await b.call('GET', '/storage')).status).toBe(200);
  });
});

describe('POST /storage/conversations/clean', () => {
  it('borra las carpetas sin chat sin seguir enlaces y nunca toca un proyecto', async () => {
    const b = await bench();
    const live = await b.chat('con carpeta');
    await fill(join(b.convRoot, live.id, 'a.txt'), 100);
    await age(join(b.convRoot, live.id));

    const orphan = join(b.convRoot, 'huerfana-0001');
    await fill(join(orphan, 'hondo', 'b.bin'), 5000);
    const readOnly = join(orphan, '.git', 'objects', 'ab', 'cdef');
    await fill(readOnly, 300);
    chmodSync(readOnly, 0o444);
    symlinkSync(b.repo, join(orphan, 'enlace-al-proyecto'), 'junction');
    await age(orphan);

    await fill(join(b.convRoot, 'reciente-0002', 'c.txt'), 100);
    symlinkSync(b.repo, join(b.convRoot, 'enlace-0003'), 'junction');
    const promoted = join(b.convRoot, 'proyecto-0004');
    await fill(join(promoted, 'main.py'), 400);
    await age(promoted);
    b.store.putProject({ id: 'ascendido', name: 'Ascendido', repoPath: promoted });

    expect((await summary(b)).conversations.orphans).toEqual({ count: 2, bytes: 5300 + 400 });
    const { result, storage } = await clean(b, '/storage/conversations/clean', { scope: 'orphans' });
    expect(result).toMatchObject({ target: 'conversations', freedBytes: 5300, deleted: { folders: 1, files: 2 } });
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { id: 'reciente-0002', reason: 'se creó o cambió hace menos de 1 h' },
        { id: 'proyecto-0004', reason: 'toca un proyecto, la bóveda, la base o la memoria' },
      ]),
    );
    expect(existsSync(orphan)).toBe(false);
    expect(readFileSync(join(b.repo, 'README.md'), 'utf8')).toBe('# Proyecto del usuario\n');
    expect(lstatSync(join(b.convRoot, 'enlace-0003')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(promoted, 'main.py')).byteLength).toBe(400);
    expect(existsSync(join(b.convRoot, live.id, 'a.txt'))).toBe(true);
    expect(storage.conversations.total.count).toBe(3);
  });

  it('solo acepta scope «orphans»', async () => {
    const b = await bench();
    expect((await b.call('POST', '/storage/conversations/clean', { scope: 'all' })).status).toBe(400);
  });

  it('si la raíz de conversaciones es parte de un proyecto, no borra nada', async () => {
    const b = await bench();
    await fill(join(b.convRoot, 'huerfana-0009', 'x.txt'), 100);
    await age(join(b.convRoot, 'huerfana-0009'));
    b.store.putProject({ id: 'raro', name: 'Raro', repoPath: b.convRoot });
    const { result } = await clean(b, '/storage/conversations/clean', { scope: 'orphans' });
    expect(result.deleted.folders).toBe(0);
    expect(result.skipped).toEqual([{ id: 'huerfana-0009', reason: 'toca un proyecto, la bóveda, la base o la memoria' }]);
    expect(existsSync(join(b.convRoot, 'huerfana-0009', 'x.txt'))).toBe(true);
  });
});

describe('POST /storage/compact', () => {
  it('libera las páginas de lo borrado', async () => {
    const b = await bench();
    b.seed('worker-temporal', 1200);
    b.store.database.prepare(`DELETE FROM events WHERE session_id = 'worker-temporal'`).run();
    const free = (await summary(b)).database.freeBytes;
    expect(free).toBeGreaterThan(500_000);
    const before = diskBytes(b.dbPath);
    const { result, storage } = await clean(b, '/storage/compact');
    expect(result).toMatchObject({ target: 'database', compacted: true, warnings: [] });
    expect(result.freedBytes).toBeGreaterThan(500_000);
    expect(diskBytes(b.dbPath)).toBe(before - result.freedBytes);
    expect(storage.database.freeBytes).toBe(0);
  });
});
