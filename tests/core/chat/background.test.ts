import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { startsMainTurn } from '../../../src/core/chat/index.ts';
import type { ConductorQueryFn } from '../../../src/core/conductor/index.ts';
import { DEFAULT_SETTINGS } from '../../../src/shared/index.ts';
import { bench, closeBenches, sdkInit, sdkResult, sdkText, tick } from './helpers.ts';

afterEach(closeBenches);

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function taskStarted(taskId: string, toolUseId: string, sid: string): SDKMessage {
  return { type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, description: 'Investigar reels', subagent_type: 'general-purpose', session_id: sid, uuid: uuid() } as unknown as SDKMessage;
}

function taskDone(taskId: string, toolUseId: string, sid: string): SDKMessage {
  return { type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: toolUseId, status: 'completed', summary: 'listo', session_id: sid, uuid: uuid() } as unknown as SDKMessage;
}

/**
 * `query` falsa que, además de responder a cada mensaje del usuario, deja **inyectar** mensajes del SDK entre turnos:
 * así se simula un subagente en segundo plano que termina y la mente que sigue sola, sin mensaje del usuario.
 */
function injectableQuery(script: (message: SDKUserMessage, ctx: { index: number; process: number; options: Options }) => SDKMessage[]) {
  const state = {
    calls: [] as { options: Options }[],
    closed: 0,
    inject: (_messages: SDKMessage[]): void => {
      throw new Error('sin proceso del SDK');
    },
    fn: undefined as unknown as ConductorQueryFn,
  };
  state.fn = ({ prompt, options }) => {
    state.calls.push({ options });
    const process = state.calls.length;
    const queue: SDKMessage[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    const push = (messages: SDKMessage[]) => {
      queue.push(...messages);
      wake?.();
    };
    state.inject = push;
    void (async () => {
      let index = 0;
      for await (const message of prompt) push(script(message, { index: index++, process, options }));
      done = true;
      wake?.();
    })();
    const stream = (async function* () {
      while (true) {
        while (queue.length) yield queue.shift() as SDKMessage;
        if (done) return;
        await new Promise<void>((r) => {
          wake = r;
        });
        wake = undefined;
      }
    })();
    return Object.assign(stream, {
      close: () => {
        state.closed++;
        done = true;
        wake?.();
      },
      interrupt: async () => undefined,
    });
  };
  return state;
}

/** Primer turno: la mente lanza un investigador en segundo plano y termina su respuesta. */
const launchScript = (message: SDKUserMessage, ctx: { index: number; process: number; options: Options }): SDKMessage[] => {
  const sid = typeof ctx.options.resume === 'string' ? ctx.options.resume : `sdk-${ctx.process}`;
  const text = typeof message.message.content === 'string' ? message.message.content : '';
  if (text === 'investiga') return [sdkInit(sid), sdkText('Lanzo un investigador.', sid), taskStarted('t1', 'tu1', sid), sdkResult('Lanzo un investigador.', sid, 0.01)];
  return [sdkInit(sid), sdkText(`eco: ${text}`, sid), sdkResult(`eco: ${text}`, sid, 0.02)];
};

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('no se cumplió a tiempo');
    await tick(5);
  }
}

describe('ChatService: los agentes siguen en segundo plano aunque nadie mire', () => {
  it('startsMainTurn: init y mensajes de la mente abren turno; los avisos de subagentes no', () => {
    expect(startsMainTurn(sdkInit('s'))).toBe(true);
    expect(startsMainTurn(sdkText('hola', 's'))).toBe(true);
    expect(startsMainTurn(sdkText('del subagente', 's', 'tu1'))).toBe(false);
    expect(startsMainTurn(taskStarted('t1', 'tu1', 's'))).toBe(false);
    expect(startsMainTurn(taskDone('t1', 'tu1', 's'))).toBe(false);
  });

  it('cuando termina el subagente, la mente sigue sola: su respuesta queda en el historial y el chat pasa por running', async () => {
    const q = injectableQuery(launchScript);
    const b = await bench({ query: q.fn });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'investiga' });
    await b.settle(chat.id);
    expect(b.service.get(chat.id).backgroundTasks).toBe(1);

    const sid = 'sdk-1';
    q.inject([taskDone('t1', 'tu1', sid), sdkInit(sid), sdkText('Terminó el investigador: 15 reels.', sid), sdkResult('Terminó el investigador: 15 reels.', sid, 0.03)]);
    await waitFor(() => b.service.messages(chat.id).some((m) => m.text.includes('15 reels')));
    await b.settle(chat.id);

    const messages = b.service.messages(chat.id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(messages.at(-1)?.text).toBe('Terminó el investigador: 15 reels.');
    expect(b.service.get(chat.id).backgroundTasks).toBeUndefined();
    expect(b.sent('chat_message').at(-1)?.message.text).toContain('15 reels');
    // El chat se vio ocupado mientras la mente respondía sola.
    expect(b.sent('chat').some((m) => m.chat.state === 'running' && m.chat.backgroundTasks === undefined)).toBe(true);
  });

  it('con un subagente trabajando, la sesión no se cierra por inactividad; al terminar, sí', async () => {
    const q = injectableQuery(launchScript);
    const b = await bench({ query: q.fn, idleMs: 30 });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'investiga' });
    await b.settle(chat.id);
    await tick(150); // cinco plazos de inactividad
    expect(q.closed).toBe(0);
    expect(b.service.get(chat.id).backgroundTasks).toBe(1);

    q.inject([taskDone('t1', 'tu1', 'sdk-1')]);
    await waitFor(() => q.closed === 1);
    expect(b.service.get(chat.id).backgroundTasks).toBeUndefined();
  });

  it('un cambio de ajustes con un subagente trabajando no recrea la sesión (no lo mata); al terminar, rige', async () => {
    const q = injectableQuery(launchScript);
    const b = await bench({ query: q.fn });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'investiga' });
    await b.settle(chat.id);

    b.settings.value = { ...DEFAULT_SETTINGS, mind: { ...DEFAULT_SETTINGS.mind, effort: 'low' } };
    await b.service.send(chat.id, { text: 'como vas' });
    await b.settle(chat.id);
    expect(q.calls).toHaveLength(1);
    expect(q.closed).toBe(0);

    q.inject([taskDone('t1', 'tu1', 'sdk-1')]);
    await waitFor(() => b.service.get(chat.id).backgroundTasks === undefined);
    await b.service.send(chat.id, { text: 'sigue' });
    await b.settle(chat.id);
    expect(q.calls).toHaveLength(2);
    expect(q.calls[1]?.options.effort).toBe('low');
    expect(q.calls[1]?.options.resume).toBe('sdk-1');
  });

  it('un esfuerzo por mensaje con un subagente trabajando no recrea la sesión: el turno usa el de la sesión viva y queda en el log', async () => {
    const q = injectableQuery(launchScript);
    const lines: string[] = [];
    const b = await bench({ query: q.fn, log: (line) => lines.push(line) });
    const chat = b.service.create({ projectId: 'demo', mode: 'chat' });
    await b.service.send(chat.id, { text: 'investiga' });
    await b.settle(chat.id);

    await b.service.send(chat.id, { text: 'rápido', effort: 'low' });
    await b.settle(chat.id);
    expect(q.calls).toHaveLength(1);
    expect(q.closed).toBe(0);
    expect(lines.some((l) => /el turno pidió esfuerzo low, pero 1 subagente\(s\) siguen trabajando; usa el de la sesión viva \(medium\)/.test(l))).toBe(true);

    q.inject([taskDone('t1', 'tu1', 'sdk-1')]);
    await waitFor(() => b.service.get(chat.id).backgroundTasks === undefined);
    await b.service.send(chat.id, { text: 'sigue', effort: 'low' });
    await b.settle(chat.id);
    expect(q.calls).toHaveLength(2);
    expect(q.calls[1]?.options).toMatchObject({ effort: 'low', resume: 'sdk-1' });
  });

  it('los plugins que se refrescan al abrir la sesión no hacen que el mensaje siguiente la recree', async () => {
    const fake = { type: 'stdio' as const, command: 'node', args: ['chrome-falso.mjs'] };
    const holder: { envCalls?: string[] } = {};
    // Como en f5-chat: la caché de plugins se llena al cargar el entorno de la mente.
    const none: Record<string, typeof fake> = {};
    const b = await bench({ mcpServersFor: () => ((holder.envCalls?.length ?? 0) > 0 ? { chrome: fake } : none) });
    holder.envCalls = b.envCalls;
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'uno' });
    await b.settle(chat.id);
    expect(b.q.calls[0]?.options.mcpServers?.chrome).toEqual(fake);
    await b.service.send(chat.id, { text: 'dos' });
    await b.settle(chat.id);
    expect(b.q.calls).toHaveLength(1);
    expect(b.q.closed).toBe(0);
  });
});
