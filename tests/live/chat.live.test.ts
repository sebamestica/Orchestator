/**
 * Prueba en vivo opcional del chat con la mente (gasta saldo: dos turnos cortos, esfuerzo bajo y tope de 0,50 USD).
 * Solo con ORQ_LIVE=1 y la clave en el entorno. Desde WSL:
 *   WSLENV=ANTHROPIC_API_KEY/w:ANTHROPIC_BASE_URL/w scripts/win.sh "set ORQ_LIVE=1&& npx vitest run tests/live/chat.live.test.ts"
 * Comprueba la sesión real del SDK por el `ChatService`: imagen como bloque, respuesta por el hub, cierre por ocio y
 * reanudación con `resume` (la mente recuerda la palabra del primer turno).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeSdkTranslator } from '../../src/core/adapters/claude-sdk/index.ts';
import { AttachmentStore, ChatService } from '../../src/core/chat/index.ts';
import { EventHub } from '../../src/core/server/index.ts';
import { SqliteStore } from '../../src/core/store/index.ts';
import { DEFAULT_SETTINGS, agentConfigSchema, redactSecrets } from '../../src/shared/index.ts';
import { fakePorts } from '../core/conductor/fakes.ts';

/** PNG válido de 1×1 (la API rechaza una firma sin imagen). */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const live = process.env.ORQ_LIVE === '1' && !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!live)('chat con la mente en vivo', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'orq-chat-live-'));
  });
  afterAll(async () => {
    for (let attempt = 0; dir && attempt < 20; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  });

  it('responde, se cierra por ocio y reanuda recordando el primer turno', async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
    const env: Record<string, string> = { ANTHROPIC_API_KEY: apiKey };
    if (process.env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
    const store = new SqliteStore({ path: ':memory:' });
    store.putProject({ id: 'demo', name: 'Demo', repoPath: dir });
    const hub = new EventHub(store);
    const attachments = new AttachmentStore({ db: store.database, dir: join(dir, 'adjuntos') });
    const agent = agentConfigSchema.parse({ id: 'claude', kind: 'claude-sdk', provider: 'anthropic', displayName: 'Claude' });
    const service = new ChatService({
      db: store.database,
      store,
      hub,
      settings: () => ({ ...DEFAULT_SETTINGS, mind: { agentId: null, effort: 'low' } }),
      mind: { agents: () => [agent], env: async () => env, budgetLeftUsd: () => 0.5 },
      ports: fakePorts(),
      translator: (init) => new ClaudeSdkTranslator(init),
      attachments,
      idleMs: 500,
    });
    const wait = async (chatId: string) => {
      for (let i = 0; i < 1200 && service.get(chatId).state === 'running'; i++) await new Promise((r) => setTimeout(r, 100));
    };
    try {
      const chat = service.create({ projectId: 'demo', mode: 'plan' });
      const image = await attachments.upload({ name: 'punto.png', mime: 'image/png', bytes: new Uint8Array(PNG_1X1) });
      await service.send(chat.id, { text: 'Recuerda la palabra «girasol». Responde solo «ok».', attachmentIds: [image.id] });
      await wait(chat.id);
      await new Promise((r) => setTimeout(r, 1500));
      expect(service.sessionOf(chat.id)).toBeUndefined();
      await service.send(chat.id, { text: '¿Qué palabra te pedí recordar? Responde solo la palabra.' });
      await wait(chat.id);
      const messages = service.messages(chat.id);
      console.warn(redactSecrets(JSON.stringify({ mensajes: messages.map((m) => [m.role, m.text]), costoUsd: service.get(chat.id).costUsd }), [apiKey]));
      expect(messages.at(-1)?.text.toLowerCase()).toContain('girasol');
      expect(store.eventsSince(chat.sessionId, -1, 5000).length).toBeGreaterThan(0);
    } finally {
      service.shutdown();
      store.close();
    }
  });
});
