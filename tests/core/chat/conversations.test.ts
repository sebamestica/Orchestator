import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ChatError, conversationDir, conversationsRoot } from '../../../src/core/chat/index.ts';
import { bench, closeBenches } from './helpers.ts';

afterEach(closeBenches);

const base = mkdtempSync(join(tmpdir(), 'orq-conversaciones-'));
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('Conversaciones: chats sin proyecto que no piden carpeta', () => {
  it('conversationsRoot queda junto a la carpeta de datos, no dentro (la guardia sigue negando esa carpeta)', () => {
    const data = join(base, 'Local', 'orquestador');
    const root = conversationsRoot(data);
    expect(root).toBe(join(base, 'Local', 'berland-conversaciones'));
    expect(path.relative(data, root).startsWith('..')).toBe(true);
    expect(conversationDir(root, 'chat_abc123')).toBe(join(root, 'chat_abc123'));
  });

  it('sin cwd crea una carpeta interna propia del chat y la marca como interna', async () => {
    const root = join(base, 'raiz-1');
    const b = await bench({ conversationsRoot: root });
    const chat = b.service.create({ projectId: null });
    expect(chat.cwd).toBe(join(root, chat.id));
    expect(statSync(chat.cwd).isDirectory()).toBe(true);
    expect(chat.internalFolder).toBe(true);
    expect(b.service.get(chat.id).internalFolder).toBe(true);
    expect(b.service.list(null).map((c) => c.internalFolder)).toEqual([true]);
    expect(b.sent('chat').at(-1)?.chat.internalFolder).toBe(true);
    // Dos conversaciones no comparten carpeta (el contexto no se mezcla).
    const other = b.service.create({ projectId: null });
    expect(other.cwd).not.toBe(chat.cwd);
  });

  it('la conversación responde sin que nadie elija carpeta; si la carpeta interna se vació, vuelve a existir', async () => {
    const root = join(base, 'raiz-2');
    const b = await bench({ conversationsRoot: root });
    const chat = b.service.create({ projectId: null });
    rmSync(chat.cwd, { recursive: true, force: true });
    await b.service.send(chat.id, { text: 'hola' });
    await b.settle(chat.id);
    expect(existsSync(chat.cwd)).toBe(true);
    expect(b.q.calls[0]?.options.cwd).toBe(chat.cwd);
    expect(b.service.messages(chat.id).map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('con una carpeta elegida o con proyecto, nada cambia y no se marca como interna', async () => {
    const b = await bench({ conversationsRoot: join(base, 'raiz-3') });
    const own = b.service.create({ projectId: null, cwd: b.repo });
    expect(own.cwd).toBe(b.repo);
    expect(own.internalFolder).toBeUndefined();
    const project = b.service.create({ projectId: 'demo' });
    expect(project.internalFolder).toBeUndefined();
    expect(existsSync(join(base, 'raiz-3'))).toBe(false);
  });

  it('un chat inválido no deja carpeta creada; sin conversationsRoot sigue exigiendo cwd', async () => {
    const root = join(base, 'raiz-4');
    const b = await bench({ conversationsRoot: root });
    expect(() => b.service.create({ projectId: null, extraRoots: [join(base, 'no-existe')] })).toThrow(ChatError);
    expect(existsSync(root)).toBe(false);
    const old = await bench();
    expect(() => old.service.create({ projectId: null })).toThrow(/necesita su carpeta/);
  });
});
