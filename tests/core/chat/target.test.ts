/**
 * Destino de los cambios de un chat (issue 2): local por defecto con el estado git real de la carpeta, remoto solo
 * cuando la mente pasa `destino` en `crear_tareas`, difusión `chat_target` y `GET /chats/:id/target`.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSdkTranslator } from '../../../src/core/adapters/claude-sdk/index.ts';
import { AttachmentStore, ChatService, registerChatRoutes } from '../../../src/core/chat/index.ts';
import { ChatTargets, isRemoteUrl, normalizeDestination, resolveChangesTarget } from '../../../src/core/chat/target.ts';
import { ChatDb } from '../../../src/core/chat/db.ts';
import { DESTINATION_PROMPT_TEXT } from '../../../src/core/conductor/index.ts';
import { AgentRegistry } from '../../../src/core/registry/index.ts';
import { EventHub, createApp, generateToken } from '../../../src/core/server/index.ts';
import { SqliteStore } from '../../../src/core/store/index.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import { projectWorkspaceSchema, type ProjectStorage } from '../../../src/core/workspace/index.ts';
import { changesTargetSchema, chatTargetResponse, DEFAULT_SETTINGS } from '../../../src/shared/index.ts';
import type { ChangesTarget, Chat } from '../../../src/shared/index.ts';
import { brief, fakePorts, jsonOf, SECRET_PATTERN } from '../conductor/fakes.ts';
import { bench, chatQuery, claudeAgent, closeBenches, echoTurn, MIND_KEY, type ChatBench } from './helpers.ts';

// Repos git reales.
vi.setConfig({ testTimeout: 90_000 });

const GH_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

const dirs: string[] = [];
async function temp(prefix = 'orq-destino-'): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await closeBenches();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

/** Chat del proyecto con su sesión abierta (un turno de eco) para llamar a sus herramientas. */
async function openChat(b: ChatBench, projectId = 'demo'): Promise<Chat> {
  const chat = b.service.create({ projectId });
  await b.service.send(chat.id, { text: 'hola' });
  await b.settle(chat.id);
  return chat;
}

async function crearTareas(b: ChatBench, chatId: string, args: Record<string, unknown>, taskId: string) {
  b.ports.planner.result = { ok: true, tasks: [brief(taskId)] };
  const session = b.service.sessionOf(chatId);
  if (!session) throw new Error('sin sesión');
  return session.tools.call('crear_tareas', { plan: `Plan de ${taskId}`, ...args });
}

const targetRows = (b: ChatBench) => b.store.database.prepare('SELECT * FROM chat_targets').all();

describe('chat sin destino: local con el git real de la carpeta', () => {
  it('carpeta sin git, git sin remoto y el proyecto orquestador (git con origin y worktrees)', async () => {
    const b = await bench();
    const plain = b.service.create({ projectId: 'demo' });
    expect(await b.service.target(plain.id)).toEqual({ kind: 'local', path: b.repo, git: 'none', worktrees: false });

    git(b.repo, 'init', '-q', '-b', 'main');
    expect(await b.service.target(plain.id)).toEqual({ kind: 'local', path: b.repo, git: 'local', worktrees: false });

    const orq = join(b.dir, 'orquestador');
    await mkdir(orq);
    git(orq, 'init', '-q', '-b', 'main');
    git(orq, 'remote', 'add', 'origin', `https://${GH_TOKEN}@github.com/sebamestica/Orchestator.git`);
    const workspace = projectWorkspaceSchema.parse({ worktreesRoot: join(b.dir, 'worktrees'), gate: [{ command: 'node', args: ['-v'] }] });
    b.store.putProject({ id: 'orquestador', name: 'Orquestador', repoPath: orq, workspace });
    const fleet = b.service.create({ projectId: 'orquestador' });
    const target = await b.service.target(fleet.id);
    expect(target).toEqual({ kind: 'local', path: orq, git: 'remote', worktrees: true });
    expect(JSON.stringify(target)).not.toContain('ghp_');
  });

  it('chat sin proyecto: local en su carpeta', async () => {
    const b = await bench();
    const cwd = await temp();
    const solo = b.service.create({ projectId: null, cwd });
    expect(await b.service.target(solo.id)).toEqual({ kind: 'local', path: cwd, git: 'none', worktrees: false });
  });

  it('chat que no existe: not_found', async () => {
    const b = await bench();
    await expect(b.service.target('no-existe-123')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('crear_tareas con destino', () => {
  it("destino { remoto: 'origin' }: remoto con la URL saneada y la rama actual; se difunde chat_target", async () => {
    const b = await bench();
    git(b.repo, 'init', '-q', '-b', 'main');
    git(b.repo, 'remote', 'add', 'origin', `https://${GH_TOKEN}@github.com/sebamestica/Orchestator`);
    const chat = await openChat(b);
    expect(b.q.calls[0]?.options.systemPrompt).toEqual(expect.arrayContaining([DESTINATION_PROMPT_TEXT]));

    const result = await crearTareas(b, chat.id, { destino: { remoto: 'origin' } }, 'api-destino');
    expect(result.isError).toBeFalsy();
    const expected: ChangesTarget = {
      kind: 'remote',
      path: b.repo,
      remote: { name: 'origin', url: 'https://github.com/sebamestica/Orchestator' },
      branch: 'main',
      configured: true,
    };
    expect(await b.service.target(chat.id)).toEqual(expected);
    expect(b.sent('chat_target')).toEqual([{ type: 'chat_target', chatId: chat.id, target: expected }]);
    expect(jsonOf(result).destino).toMatchObject({ guardado: true, tipo: 'remoto', remoto: 'https://github.com/sebamestica/Orchestator', rama: 'main', configurado: true });
    expect(JSON.stringify(result)).not.toContain('ghp_');
    // Las tareas siguen propuestas: el destino no aprueba ni sube nada.
    expect(b.service.proposals(chat.id).map((p) => [p.task.id, p.approval])).toEqual([['api-destino', 'proposed']]);
  });

  it('una URL con token se guarda saneada; coincide con origin (SCP) y toma su nombre, con la rama pedida', async () => {
    const b = await bench();
    git(b.repo, 'init', '-q', '-b', 'main');
    git(b.repo, 'remote', 'add', 'origin', 'git@github.com:a/b.git');
    const chat = await openChat(b);
    await crearTareas(b, chat.id, { destino: { remoto: `https://${GH_TOKEN}@github.com/a/b.git`, rama: 'entrega' } }, 'api-url');
    expect(await b.service.target(chat.id)).toEqual({
      kind: 'remote',
      path: b.repo,
      remote: { name: 'origin', url: 'https://github.com/a/b.git' },
      branch: 'entrega',
      configured: true,
    });
    const rows = JSON.stringify(targetRows(b));
    expect(rows).toContain('https://github.com/a/b.git');
    expect(rows).not.toMatch(/ghp_|@github/);
  });

  it('un remoto que no está en git remote queda configured: false (por nombre y por URL)', async () => {
    const b = await bench();
    git(b.repo, 'init', '-q', '-b', 'main');
    git(b.repo, 'remote', 'add', 'origin', 'https://github.com/a/b');
    const chat = await openChat(b);

    const byName = await crearTareas(b, chat.id, { destino: { remoto: 'upstream' } }, 'api-nombre');
    expect(await b.service.target(chat.id)).toEqual({ kind: 'remote', path: b.repo, remote: { name: 'upstream', url: '' }, branch: 'main', configured: false });
    expect(jsonOf(byName).destino).toMatchObject({ configurado: false, aviso: expect.stringMatching(/no está configurado/) });

    await crearTareas(b, chat.id, { destino: { remoto: 'git@gitlab.com:otro/c.git' } }, 'api-otra-url');
    expect(await b.service.target(chat.id)).toEqual({ kind: 'remote', path: b.repo, remote: { name: null, url: 'gitlab.com/otro/c' }, branch: 'main', configured: false });

    // En una carpeta sin git, ningún remoto está configurado.
    await rm(join(b.repo, '.git'), { recursive: true, force: true });
    expect(await b.service.target(chat.id)).toMatchObject({ kind: 'remote', configured: false, branch: null });
  });

  it('un plan nuevo sin destino lo conserva; destino: null vuelve a local; un plan que falla no lo toca', async () => {
    const b = await bench();
    git(b.repo, 'init', '-q', '-b', 'main');
    git(b.repo, 'remote', 'add', 'origin', 'https://github.com/a/b');
    const chat = await openChat(b);
    await crearTareas(b, chat.id, { destino: { remoto: 'origin' } }, 't1');
    await crearTareas(b, chat.id, {}, 't2');
    expect((await b.service.target(chat.id)).kind).toBe('remote');
    expect(b.sent('chat_target')).toHaveLength(1);

    b.ports.planner.result = { ok: false, issues: [{ code: 'x', message: 'plan inválido', taskIds: [] }] };
    const failed = await b.service.sessionOf(chat.id)?.tools.call('crear_tareas', { plan: 'malo', destino: null });
    expect(failed?.isError).toBe(true);
    expect((await b.service.target(chat.id)).kind).toBe('remote');

    const back = await crearTareas(b, chat.id, { destino: null }, 't3');
    expect(jsonOf(back).destino).toMatchObject({ guardado: true, tipo: 'local' });
    expect(await b.service.target(chat.id)).toEqual({ kind: 'local', path: b.repo, git: 'remote', worktrees: false });
    expect(b.sent('chat_target').at(-1)).toEqual({ type: 'chat_target', chatId: chat.id, target: { kind: 'local', path: b.repo, git: 'remote', worktrees: false } });
    expect(targetRows(b)).toEqual([]);
  });

  it('el destino es del proyecto del chat; borrar el chat borra su destino; el agente suelto no lo explica en el prompt', async () => {
    const b = await bench();
    const chat = await openChat(b);
    b.ports.planner.result = { ok: true, tasks: [brief('ajena', { projectId: 'otro' })] };
    const foreign = await b.service.sessionOf(chat.id)?.tools.call('crear_tareas', { plan: 'plan', proyecto: 'otro', destino: { remoto: 'origin' } });
    // Las tareas de otro proyecto se proponen, pero el destino es del chat (proyecto demo): no se anota.
    expect(foreign?.isError).toBeFalsy();
    expect(jsonOf(foreign ?? { content: [] }).destino).toMatchObject({ guardado: false, aviso: expect.stringMatching(/solo para su proyecto \(demo\)/) });
    expect(targetRows(b)).toEqual([]);
    expect(b.sent('chat_target')).toEqual([]);
    await crearTareas(b, chat.id, { destino: { remoto: 'https://github.com/a/b' } }, 'borrar');
    expect(targetRows(b)).toHaveLength(1);
    await b.service.delete(chat.id);
    expect(targetRows(b)).toEqual([]);

    const solo = b.service.create({ projectId: null, cwd: b.repo });
    await b.service.send(solo.id, { text: 'hola' });
    await b.settle(solo.id);
    expect(b.q.calls.at(-1)?.options.systemPrompt).not.toEqual(expect.arrayContaining([DESTINATION_PROMPT_TEXT]));
  });
});

describe('piezas de target.ts', () => {
  it('isRemoteUrl distingue nombres de remoto de URLs y rutas', () => {
    for (const name of ['origin', 'upstream', 'mi-remoto', 'feature/x']) expect(isRemoteUrl(name), name).toBe(false);
    for (const url of ['https://github.com/a/b', 'git@github.com:a/b.git', 'github.com:a/b', 'github.com/a/b', 'C:\\repos\\b', '/srv/git/b.git', 'file:///srv/b'])
      expect(isRemoteUrl(url), url).toBe(true);
  });

  it('normalizeDestination sanea la URL, tacha el nombre y vacía una rama en blanco', () => {
    expect(normalizeDestination({ remoto: `  https://${GH_TOKEN}@github.com/a/b?x=1 `, rama: 'main' })).toEqual({ remote: 'https://github.com/a/b', branch: 'main' });
    expect(normalizeDestination({ remoto: 'git@github.com:a/b.git' })).toEqual({ remote: 'github.com/a/b', branch: null });
    expect(normalizeDestination({ remoto: 'origin', rama: '  ' })).toEqual({ remote: 'origin', branch: null });
    expect(() => normalizeDestination({ remoto: '   ' })).toThrow();
  });

  it('resolveChangesTarget: el nombre exacto de un remoto gana a la heurística de URL; la salida valida el contrato', async () => {
    const storage: ProjectStorage = {
      kind: 'remote',
      branch: 'main',
      remote: { name: 'github.com/a/b', url: 'https://github.com/x/y' },
      remotes: [{ name: 'github.com/a/b', url: 'https://github.com/x/y' }],
    };
    const t = await resolveChangesTarget({ path: 'C:\\dev\\x', worktrees: true }, { remote: 'github.com/a/b', branch: null }, async () => storage);
    expect(changesTargetSchema.parse(t)).toEqual({ kind: 'remote', path: 'C:\\dev\\x', remote: { name: 'github.com/a/b', url: 'https://github.com/x/y' }, branch: 'main', configured: true });
  });

  it('ChatTargets: una fila que no valida se lee como sin destino (local)', async () => {
    const store = new SqliteStore({ path: ':memory:' });
    try {
      const targets = new ChatTargets(new ChatDb(store.database));
      targets.set('chat-1', { remote: 'origin', branch: null }, '2026-11-04T12:00:00.000Z');
      expect(targets.get('chat-1')).toEqual({ remote: 'origin', branch: null });
      store.database.prepare("UPDATE chat_targets SET remote = '' WHERE chat_id = 'chat-1'").run();
      expect(targets.get('chat-1')).toBeUndefined();
      expect(targets.clear('chat-1')).toBe(true);
      expect(targets.clear('chat-1')).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe('GET /chats/:id/target', () => {
  it('responde { target } validado (local y, tras crear_tareas con destino, remoto); 404 sin chat y 400 con id inválido', async () => {
    const dir = await temp('orq-destino-rutas-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'remote', 'add', 'origin', 'https://github.com/a/b.git');
    const store = new SqliteStore({ path: ':memory:' });
    store.putProject({ id: 'demo', name: 'Demo', repoPath: dir });
    const hub = new EventHub(store);
    const host = '127.0.0.1:47998';
    const token = generateToken();
    const ports = fakePorts();
    let service: ChatService | undefined;
    const core = createApp({
      token,
      allowedHosts: () => [host],
      store,
      registry: new AgentRegistry({ store, vault: new MemoryVault(), detectors: [] }),
      hub,
      validateResponses: true,
      routeModules: [
        (ctx) => {
          const attachments = new AttachmentStore({ db: ctx.store.database, dir: join(dir, '.datos') });
          service = new ChatService({
            db: ctx.store.database,
            store: ctx.store,
            hub: ctx.hub,
            settings: () => DEFAULT_SETTINGS,
            mind: { agents: () => [claudeAgent], env: async () => ({ ANTHROPIC_API_KEY: MIND_KEY }) },
            ports,
            translator: (init) => new ClaudeSdkTranslator(init),
            attachments,
            query: chatQuery(echoTurn).fn,
            drives: () => ['C:\\'],
          });
          registerChatRoutes(ctx, { service, attachments });
        },
      ],
    });
    const get = (path: string) => Promise.resolve(core.app.request(`http://${host}${path}`, { headers: { host, authorization: `Bearer ${token}` } }));
    try {
      const chat = service?.create({ projectId: 'demo' });
      if (!chat || !service) throw new Error('sin servicio');
      const local = await get(`/chats/${chat.id}/target`);
      expect(local.status).toBe(200);
      expect(chatTargetResponse.parse(await local.json())).toEqual({ target: { kind: 'local', path: dir, git: 'remote', worktrees: false } });

      await service.send(chat.id, { text: 'hola' });
      for (let i = 0; i < 400 && service.get(chat.id).state === 'running'; i++) await new Promise((r) => setTimeout(r, 5));
      await service.sessionOf(chat.id)?.tools.call('crear_tareas', { plan: 'plan', destino: { remoto: 'origin', rama: 'main' } });
      const remote = chatTargetResponse.parse(await (await get(`/chats/${chat.id}/target`)).json());
      expect(remote.target).toEqual({ kind: 'remote', path: dir, remote: { name: 'origin', url: 'https://github.com/a/b.git' }, branch: 'main', configured: true });
      expect(JSON.stringify(remote)).not.toMatch(SECRET_PATTERN);

      expect((await get('/chats/no-existe-123/target')).status).toBe(404);
      expect((await get('/chats/x/target')).status).toBe(400);
    } finally {
      service?.shutdown();
      store.close();
    }
  });
});
