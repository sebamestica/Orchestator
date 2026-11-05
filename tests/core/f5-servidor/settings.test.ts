import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mindCandidates, MIND_BRIDGE_NOTE, SETTINGS_TABLE, SettingsStore, settingsStoreFor } from '../../../src/core/settings/index.ts';
import { SqliteStore, StoreError } from '../../../src/core/store/index.ts';
import { DEFAULT_SETTINGS, mindCandidateSchema, settingsSchema, type Settings } from '../../../src/shared/index.ts';
import { cleanupDirs, makeF5App, putAgent, tempDir } from './helpers.ts';

afterEach(cleanupDirs);

describe('SettingsStore', () => {
  it('sin filas devuelve DEFAULT_SETTINGS y crea su tabla sin tocar schema.ts', () => {
    const db = new DatabaseSync(':memory:');
    const settings = new SettingsStore(db);
    expect(settings.get()).toEqual(DEFAULT_SETTINGS);
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(SETTINGS_TABLE);
    expect(table).toEqual({ name: SETTINGS_TABLE });
    // Cada get() es una copia: mutarla no cambia los ajustes.
    settings.get().workers.push('x');
    expect(settings.get().workers).toEqual([]);
  });

  it('mezcla un nivel de profundidad; mind.model: null borra el modelo', () => {
    const settings = new SettingsStore(new DatabaseSync(':memory:'));
    const a = settings.update({ mind: { model: 'claude-opus-5-5' }, appearance: { reducedEffects: true } });
    // Esfuerzo por defecto de la mente: medium (issue 6; antes high).
    expect(a.mind).toEqual({ agentId: null, effort: 'medium', model: 'claude-opus-5-5' });
    expect(a.appearance).toEqual({ theme: 'dark', reducedEffects: true });
    const b = settings.update({ mind: { effort: 'max' }, workers: ['codex', 'codex', 'claude'] });
    expect(b.mind).toEqual({ agentId: null, effort: 'max', model: 'claude-opus-5-5' });
    expect(b.workers).toEqual(['codex', 'claude']);
    const c = settings.update({ mind: { model: null } });
    expect(c.mind).toEqual({ agentId: null, effort: 'max' });
    expect(settingsSchema.safeParse(c).success).toBe(true);
  });

  it('valida con settingsPatchSchema: campos desconocidos, rangos y tipos dan StoreError invalid (400)', () => {
    const settings = new SettingsStore(new DatabaseSync(':memory:'));
    for (const bad of [{ concurrency: 0 }, { concurrency: 9 }, { quotaFloor: 1.5 }, { otro: 1 }, { workers: ['No Válido'] }, { defaultMode: 'loco' }, { appearance: { theme: 'rosa' } }]) {
      expect(() => settings.update(bad), JSON.stringify(bad)).toThrow(StoreError);
    }
    expect(settings.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('no guarda nada con forma de clave', () => {
    const settings = new SettingsStore(new DatabaseSync(':memory:'));
    expect(() => settings.update({ mind: { model: `sk-ant-api03-${'a'.repeat(40)}` } })).toThrow(/forma de clave/);
  });

  it('persiste en SQLite: otro arranque sobre el mismo archivo lee lo guardado', async () => {
    const path = join(await tempDir(), 'orq.db');
    const first = new SqliteStore({ path });
    new SettingsStore(first.database).update({ concurrency: 5, workers: ['codex'], defaultMode: 'auto' });
    first.close();
    const second = new SqliteStore({ path });
    try {
      const s = new SettingsStore(second.database).get();
      expect(s).toMatchObject({ concurrency: 5, workers: ['codex'], defaultMode: 'auto', quotaFloor: DEFAULT_SETTINGS.quotaFloor });
    } finally {
      second.close();
    }
  });

  it('una fila guardada que ya no cumple el contrato vuelve a su valor por defecto sin romper las demás', () => {
    const db = new DatabaseSync(':memory:');
    const bad: string[] = [];
    new SettingsStore(db).update({ concurrency: 4 });
    db.prepare(`INSERT INTO ${SETTINGS_TABLE} (key, value, updated_at) VALUES ('quotaFloor', '7', 'x'), ('workers', '{roto', 'x'), ('ajeno', '1', 'x')`).run();
    const s = new SettingsStore(db, { onInvalidRow: (k) => bad.push(k) }).get();
    expect(s.concurrency).toBe(4);
    expect(s.quotaFloor).toBe(DEFAULT_SETTINGS.quotaFloor);
    expect(s.workers).toEqual([]);
    expect(bad.sort()).toEqual(['quotaFloor', 'workers']);
  });

  it('avisa a los oyentes solo cuando algo cambia; settingsStoreFor comparte la instancia por base', () => {
    const db = new DatabaseSync(':memory:');
    const a = settingsStoreFor(db);
    expect(settingsStoreFor(db)).toBe(a);
    expect(settingsStoreFor(new DatabaseSync(':memory:'))).not.toBe(a);
    const seen: Settings[] = [];
    const off = a.onChange((s) => seen.push(s));
    a.update({ concurrency: 2 });
    a.update({ concurrency: 2 });
    a.update({});
    expect(seen.map((s) => s.concurrency)).toEqual([2]);
    off();
    a.update({ concurrency: 3 });
    expect(seen).toHaveLength(1);
  });
});

describe('candidatos a mente', () => {
  it('claude-sdk habilitado → full; codex y agy → experimental con nota; api y deshabilitados → none', () => {
    const t = makeF5App();
    putAgent(t.store, 'codex', 'codex-cli', { models: ['gpt-5.5-codex'] });
    putAgent(t.store, 'claude', 'claude-sdk', { models: ['claude-opus-5-5', 'claude-sonnet-5'], model: 'claude-fable-5' });
    putAgent(t.store, 'agy', 'agy-cli');
    putAgent(t.store, 'gpt', 'api', { models: ['gpt-5'] });
    putAgent(t.store, 'claude-off', 'claude-sdk', { enabled: false });
    const list = mindCandidates(t.registry.list());
    for (const c of list) mindCandidateSchema.parse(c);
    const byId = Object.fromEntries(list.map((c) => [c.agentId, c]));
    expect(list[0]?.agentId).toBe('claude');
    expect(byId.claude).toMatchObject({ support: 'full', kind: 'claude-sdk', models: ['claude-fable-5', 'claude-opus-5-5', 'claude-sonnet-5'] });
    expect(byId.claude?.note).toBeUndefined();
    expect(byId.codex).toMatchObject({ support: 'experimental', note: MIND_BRIDGE_NOTE, models: ['gpt-5.5-codex'] });
    expect(byId.agy).toMatchObject({ support: 'experimental', note: MIND_BRIDGE_NOTE, models: [] });
    expect(byId.gpt?.support).toBe('none');
    expect(byId['claude-off']?.support).toBe('none');
    expect(list.map((c) => c.support)).toEqual(['full', 'experimental', 'experimental', 'none', 'none']);
  });
});

describe('rutas de ajustes', () => {
  it('GET /settings y PATCH /settings: valida, guarda y difunde {type:"settings"}', async () => {
    const t = makeF5App();
    putAgent(t.store, 'claude', 'claude-sdk');
    const got = await t.req('GET', '/settings');
    expect(got.status).toBe(200);
    expect(got.json).toEqual({ settings: DEFAULT_SETTINGS });

    const patched = await t.req('PATCH', '/settings', { body: { mind: { agentId: 'claude', model: 'claude-opus-5-5' }, workers: ['claude'], concurrency: 2 } });
    expect(patched.status).toBe(200);
    const settings = (patched.json as { settings: Settings }).settings;
    expect(settings).toMatchObject({ mind: { agentId: 'claude', model: 'claude-opus-5-5', effort: 'medium' }, workers: ['claude'], concurrency: 2 });
    expect(t.messages.filter((m) => m.type === 'settings')).toEqual([{ type: 'settings', settings }]);
    expect((await t.req('GET', '/settings')).json).toEqual({ settings });
  });

  it('PATCH /settings rechaza entradas inválidas y mentes imposibles con 400 (sin difundir)', async () => {
    const t = makeF5App();
    putAgent(t.store, 'gpt', 'api');
    for (const body of [{ concurrency: 12 }, { campo: true }, { mind: { agentId: 'no-existe' } }, { mind: { agentId: 'gpt' } }]) {
      const res = await t.req('PATCH', '/settings', { body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json).toMatchObject({ error: { code: 'invalid_request' } });
    }
    expect((await t.req('PATCH', '/settings', { body: { mind: { agentId: null } } })).status).toBe(200);
    expect(t.messages.filter((m) => m.type === 'settings')).toHaveLength(1);
  });

  it('GET /mind/candidates responde {candidates}', async () => {
    const t = makeF5App();
    putAgent(t.store, 'claude', 'claude-sdk', { models: ['claude-opus-5-5'] });
    putAgent(t.store, 'codex', 'codex-cli');
    const res = await t.req('GET', '/mind/candidates');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      candidates: [
        { agentId: 'claude', displayName: 'Agente claude', kind: 'claude-sdk', support: 'full', models: ['claude-opus-5-5'] },
        { agentId: 'codex', displayName: 'Agente codex', kind: 'codex-cli', support: 'experimental', note: MIND_BRIDGE_NOTE, models: [] },
      ],
    });
  });

  it('todas las rutas de c14 exigen el token', async () => {
    const t = makeF5App();
    for (const [method, path] of [
      ['GET', '/settings'],
      ['PATCH', '/settings'],
      ['GET', '/mind/candidates'],
      ['GET', '/fs/list'],
      ['POST', '/fs/pick-folder'],
      ['POST', '/projects/inspect'],
      ['POST', '/projects/from-folder'],
      ['POST', '/tasks/manual'],
    ] as const) {
      const res = await t.req(method, path, { token: null, ...(method === 'GET' ? {} : { body: {} }) });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});
