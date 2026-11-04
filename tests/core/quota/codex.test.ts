import { mkdtemp, readFile, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexQuotaProvider, readLatestCodexRollout } from '../../../src/core/quota/codex.ts';

const fixture = (name: string) => readFile(new URL(`../../../fixtures/codex/${name}`, import.meta.url), 'utf8');
const directories: string[] = [];
const now = () => new Date('2026-10-29T00:29:18.510Z');
const offline = () => Promise.reject(new Error('Sin app-server'));
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function sessions(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'orq-quota-test-'));
  directories.push(path);
  await mkdir(join(path, '2026', '10'), { recursive: true });
  await writeFile(join(path, '2026', '10', 'rollout.jsonl'), await fixture('rollout-token-count.jsonl'));
  return path;
}

describe('cupo Codex', () => {
  it('ordena por mtime, conserva timestamp del evento y poda solo archivos anteriores', async () => {
    const path = await sessions();
    const original = await fixture('rollout-token-count.jsonl');
    const initial = join(path, '2026', '10', 'rollout.jsonl');
    const newest = join(path, 'recent.jsonl');
    const equal = join(path, 'equal.jsonl');
    const old = join(path, 'old.jsonl');
    await writeFile(newest, original);
    await writeFile(equal, original.replace('00:19:18.510Z', '00:20:18.510Z'));
    await writeFile(old, original);
    for (const [file, date] of [[initial, '2026-10-28T00:00:00Z'], [old, '2026-10-29T00:18:00Z'],
      [newest, '2026-11-01T00:00:00Z'], [equal, '2026-10-29T00:19:18.510Z']] as const) {
      await utimes(file, new Date(date), new Date(date));
    }
    const opened: string[] = [];
    const result = await readLatestCodexRollout(path, (file) => opened.push(file));
    expect(opened).toEqual([newest, equal]);
    expect(result?.takenAt).toBe('2026-10-29T00:20:18.510Z');
  });

  it('continúa tras un archivo reciente sin cupos válidos', async () => {
    const path = await sessions();
    const recent = join(path, 'empty.jsonl');
    await writeFile(recent, '{truncado\n{}\n');
    await utimes(recent, new Date('2030-01-01Z'), new Date('2030-01-01Z'));
    const opened: string[] = [];
    expect((await readLatestCodexRollout(path, (file) => opened.push(file)))?.buckets).toHaveLength(2);
    expect(opened).toHaveLength(2);
    expect(opened[0]).toBe(recent);
  });
  it('prioriza app-server y convierte porcentaje y epoch', async () => {
    const readAppServer = vi.fn(async (): Promise<unknown> => JSON.parse(await fixture('app-server-synthetic.json')) as unknown);
    const snapshot = await new CodexQuotaProvider('codex-test', { readAppServer, sessionsDir: 'inexistente', now }).read();
    expect(readAppServer).toHaveBeenCalledOnce();
    expect(snapshot).toEqual({ agentId: 'codex-test', method: 'codex-ratelimits', takenAt: now().toISOString(), stale: false,
      buckets: [
        { groupId: 'codex', groupName: 'codex', window: '5h', remainingFraction: 0.36, resetAt: new Date(1793239909 * 1000).toISOString() },
        { groupId: 'codex', groupName: 'codex', window: 'weekly', remainingFraction: 0.9, resetAt: new Date(1793800832 * 1000).toISOString() },
      ] });
  });
  it('usa el registro real anidado cuando falla RPC; exactamente 10 min no es stale', async () => {
    const snapshot = await new CodexQuotaProvider('codex-test', { readAppServer: offline, sessionsDir: await sessions(), now }).read();
    expect(snapshot.takenAt).toBe('2026-10-29T00:19:18.510Z');
    expect(snapshot.stale).toBe(false);
    expect(snapshot.buckets.map((b) => [b.window, b.remainingFraction])).toEqual([['5h', 0.36], ['weekly', 0.9]]);
  });
  it('marca stale después de 10 min y conserva la hora original', async () => {
    const snapshot = await new CodexQuotaProvider('codex-test', { readAppServer: offline, sessionsDir: await sessions(), now: () => new Date(now().getTime() + 1) }).read();
    expect(snapshot.stale).toBe(true);
    expect(snapshot.takenAt).toBe('2026-10-29T00:19:18.510Z');
  });
  it('elige el último token_count por timestamp entre archivos e ignora truncados', async () => {
    const path = await sessions();
    const original: unknown = JSON.parse(await fixture('rollout-token-count.jsonl'));
    const later = JSON.stringify(original).replace('2026-10-29T00:19:18.510Z', '2026-10-29T00:28:18.510Z').replace('"used_percent":64', '"used_percent":80');
    await writeFile(join(path, 'aaa.jsonl'), `${later}\n{"timestamp":\n`);
    await writeFile(join(path, 'zzz.jsonl'), `${JSON.stringify(original)}\n{"type":"event_msg","payload":{"type":"token_count","rate_limits":null}}\n`);
    const snapshot = await new CodexQuotaProvider('codex-test', { readAppServer: offline, sessionsDir: path, now }).read();
    expect(snapshot.takenAt).toBe('2026-10-29T00:28:18.510Z');
    expect(snapshot.buckets[0]?.remainingFraction).toBeCloseTo(0.2);
  });
  it.each([null, {}, { rateLimits: { primary: { usedPercent: 101 } } }, { rateLimits: { primary: null, secondary: null } }])('respalda RPC ausente o inválido', async (value) => {
    const snapshot = await new CodexQuotaProvider('codex-test', { readAppServer: async () => value, sessionsDir: await sessions(), now }).read();
    expect(snapshot.buckets).toHaveLength(2);
    expect(snapshot.takenAt).toBe('2026-10-29T00:19:18.510Z');
  });
  it('lee múltiples grupos sin duplicar la vista antigua', async () => {
    const snapshot = await new CodexQuotaProvider('codex-test', { now, readAppServer: async () => ({
      rateLimits: { primary: { usedPercent: 99 } },
      rateLimitsByLimitId: { codex: { primary: { usedPercent: 0, resetsAt: null } }, other: { limitName: 'Otro', secondary: { usedPercent: 100 } } },
    }) }).read();
    expect(snapshot.buckets).toEqual([
      { groupId: 'codex', groupName: 'codex', window: '5h', remainingFraction: 1 },
      { groupId: 'other', groupName: 'Otro', window: 'weekly', remainingFraction: 0 },
    ]);
  });
  it('fallo total produce snapshot vacío y explícitamente desconocido', async () => {
    const snapshot = await new CodexQuotaProvider('codex-test', { readAppServer: offline, sessionsDir: join(await sessions(), 'inexistente'), now }).read();
    expect(snapshot).toMatchObject({ stale: true, buckets: [], method: 'codex-ratelimits' });
    expect(snapshot.error).toContain('No se pudo leer');
  });
});
