import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookCallbackMatcher, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
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
function injectableQuery(
  script: (message: SDKUserMessage, ctx: { index: number; process: number; options: Options }) => SDKMessage[],
  /** `Query.applyFlagSettings` de la prueba (sin él, la sesión no puede cambiar el esfuerzo en vivo). */
  applyFlagSettings?: () => Promise<unknown>,
) {
  const state = {
    calls: [] as { options: Options }[],
    closed: 0,
    inject: (_messages: SDKMessage[]): void => {
      throw new Error('sin proceso del SDK');
    },
    /** El proceso del SDK muere: el iterador lanza `err` en la vuelta siguiente, sin avisos de los subagentes. */
    crash: (_err: Error): void => {
      throw new Error('sin proceso del SDK');
    },
    /** El iterador termina con `return`, sin avisos de los subagentes. */
    end: (): void => {
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
    let failure: Error | undefined;
    const push = (messages: SDKMessage[]) => {
      queue.push(...messages);
      wake?.();
    };
    state.inject = push;
    state.crash = (err) => {
      failure = err;
      wake?.();
    };
    state.end = () => {
      done = true;
      wake?.();
    };
    void (async () => {
      let index = 0;
      for await (const message of prompt) push(script(message, { index: index++, process, options }));
      done = true;
      wake?.();
    })();
    const stream = (async function* () {
      while (true) {
        while (queue.length) yield queue.shift() as SDKMessage;
        if (failure) throw failure;
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
      ...(applyFlagSettings ? { applyFlagSettings } : {}),
    });
  };
  return state;
}

/** La guardia (hook PreToolUse) de un proceso del SDK. */
function guardOf(o: Options | undefined) {
  const hook = (o?.hooks?.PreToolUse as HookCallbackMatcher[] | undefined)?.[0]?.hooks[0];
  if (!hook) throw new Error('falta la guardia');
  const signal = new AbortController().signal;
  return async (tool_name: string, tool_input: unknown): Promise<boolean> => {
    const out = await hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: 'p', cwd: '.' }, 't', { signal });
    return !JSON.stringify(out).includes('"deny"');
  };
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

  it.each([
    ['lanza', (q: ReturnType<typeof injectableQuery>) => q.crash(new Error('Claude Code process exited with code 1'))],
    ['termina sin aviso', (q: ReturnType<typeof injectableQuery>) => q.end()],
  ])('si el proceso del SDK %s con subagentes y sin turno, el chat los da por detenidos y lo avisa', async (_how, kill) => {
    const q = injectableQuery(launchScript);
    const b = await bench({ query: q.fn });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'investiga' });
    await b.settle(chat.id);
    expect(b.service.get(chat.id).backgroundTasks).toBe(1);

    kill(q);
    await waitFor(() => b.service.sessionOf(chat.id) === undefined);
    await tick(10);
    expect(b.service.get(chat.id).backgroundTasks).toBeUndefined();
    expect(b.sent('chat').at(-1)?.chat.backgroundTasks).toBeUndefined();
    const errors = b.events(chat.sessionId).filter((e) => e.type === 'error' && !e.parentSessionId);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.type === 'error' && errors[0].payload.message).toMatch(/1 subagente/);
  });

  it('cerrar el chat con un subagente vivo no deja avisos ni difusiones de más al terminar el proceso', async () => {
    const q = injectableQuery(launchScript);
    const b = await bench({ query: q.fn });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'investiga' });
    await b.settle(chat.id);
    b.service.close(chat.id);
    const chats = b.sent('chat').length;
    await tick(30);
    expect(q.closed).toBe(1);
    expect(b.sent('chat')).toHaveLength(chats);
    expect(b.events(chat.sessionId).filter((e) => e.type === 'error')).toHaveLength(0);
    expect(b.service.get(chat.id).backgroundTasks).toBeUndefined();
  });

  it('cerrar el chat deja cancelados en la tienda sus subagentes; el aviso del proceso reanudado no abre sesiones task-*', async () => {
    const restart = { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'stopped', reason: 'worker_restart', summary: 'no terminó', session_id: 'sdk-1', uuid: uuid() } as unknown as SDKMessage;
    const q = injectableQuery((message, ctx) => (ctx.process === 2 && ctx.index === 0 ? [restart, ...launchScript(message, ctx)] : launchScript(message, ctx)));
    const b = await bench({ query: q.fn });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'investiga' });
    await b.settle(chat.id);
    expect(b.store.getSession('tu1')?.state).toBe('running');

    b.service.close(chat.id);
    expect(b.store.getSession('tu1')?.state).toBe('cancelled');

    await b.service.send(chat.id, { text: 'hola' });
    await b.settle(chat.id);
    expect(q.calls).toHaveLength(2);
    expect(b.store.getSession('task-t1')).toBeUndefined();
    const open = b.store.listSessions({ parentSessionId: chat.sessionId }).filter((x) => ['starting', 'running', 'waiting'].includes(x.state));
    expect(open).toEqual([]);
  });


  it('si la mente arranca sola mientras un envío espera (esfuerzo en vivo), el envío responde conflict y no pisa el turno', async () => {
    const received: string[] = [];
    let release = () => {};
    const flags = new Promise<void>((resolve) => {
      release = resolve;
    });
    const q = injectableQuery((message, ctx) => {
      const text = typeof message.message.content === 'string' ? message.message.content : '';
      received.push(text);
      return launchScript(message, ctx);
    }, () => flags);
    const b = await bench({ query: q.fn });
    const outside = await mkdtemp(join(tmpdir(), 'orq-pisado-'));
    try {
      const file = join(outside, 'notas.md');
      await writeFile(file, '# notas');
      const att = await b.attachments.registerPath(file);
      const chat = b.service.create({ projectId: 'demo' });
      await b.service.send(chat.id, { text: 'investiga' });
      await b.settle(chat.id);
      expect(b.service.get(chat.id).backgroundTasks).toBe(1);

      // El envío queda esperando a que el SDK aplique el esfuerzo nuevo; en esa espera, la mente sigue sola.
      const pending = b.service.send(chat.id, { text: 'rápido', effort: 'low', attachmentIds: [att.id] });
      const sid = 'sdk-1';
      q.inject([taskDone('t1', 'tu1', sid), sdkInit(sid), sdkText('A1', sid)]);
      await waitFor(() => b.service.get(chat.id).state === 'running');
      release();
      await expect(pending).rejects.toMatchObject({ code: 'conflict' });

      expect(received.some((t) => t.includes('rápido'))).toBe(false);
      expect(b.service.messages(chat.id).some((m) => m.text === 'rápido')).toBe(false);
      // El turno autónomo sigue ocupando el chat y la carpeta del adjunto rechazado no quedó legible.
      expect(b.service.get(chat.id).state).toBe('running');
      await expect(b.service.send(chat.id, { text: 'otra' })).rejects.toMatchObject({ code: 'conflict' });
      expect(await guardOf(q.calls[0]?.options)('Read', { file_path: file })).toBe(false);

      q.inject([sdkResult(undefined, sid, 0.01, 'error_during_execution')]);
      await waitFor(() => b.service.get(chat.id).state !== 'running');
      expect(b.service.messages(chat.id).at(-1)).toMatchObject({ role: 'assistant', text: 'A1' });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });


  it('los plugins que se vuelven a leer en cada mensaje no hacen que el siguiente recree la sesión si no cambiaron', async () => {
    const fake = { type: 'stdio' as const, command: 'node', args: ['chrome-falso.mjs'] };
    // Como en f5-chat: cada lectura arma objetos nuevos con el mismo contenido.
    const b = await bench({ plugins: async () => ({ mcpServers: { chrome: { ...fake } }, env: { ORQ_MCP_CHROME_X: 'valor-fijo' } }) });
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

describe('ChatService: quitar una carpeta extra la revoca al instante, aunque haya subagentes vivos', () => {
  const guardOf = (o: Options | undefined) => {
    const hook = (o?.hooks?.PreToolUse as HookCallbackMatcher[] | undefined)?.[0]?.hooks[0];
    if (!hook) throw new Error('falta la guardia');
    const signal = new AbortController().signal;
    return async (tool_name: string, tool_input: unknown, agent_id?: string): Promise<boolean> => {
      const input = { hook_event_name: 'PreToolUse' as const, tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: 'p', cwd: '.', ...(agent_id ? { agent_id } : {}) };
      return !JSON.stringify(await hook(input, 't', { signal })).includes('"deny"');
    };
  };

  it('modo chat: Read y Write sobre la carpeta quitada se niegan sin recrear la sesión; al volver a agregarla, se permiten', async () => {
    const extra = await mkdtemp(join(tmpdir(), 'orq-extra-'));
    try {
      await writeFile(join(extra, 'a.txt'), 'hola');
      const q = injectableQuery(launchScript);
      const b = await bench({ query: q.fn });
      const chat = b.service.create({ projectId: 'demo', mode: 'chat', extraRoots: [extra] });
      await b.service.send(chat.id, { text: 'investiga' });
      await b.settle(chat.id);
      expect(b.service.get(chat.id).backgroundTasks).toBe(1);
      const allow = guardOf(q.calls[0]?.options);
      const read = { file_path: join(extra, 'a.txt') };
      const write = { file_path: join(extra, 'b.txt'), content: 'x' };
      expect(await allow('Read', read)).toBe(true);
      expect(await allow('Write', write)).toBe(true);

      b.service.patch(chat.id, { extraRoots: [] });
      expect(await allow('Read', read)).toBe(false);
      expect(await allow('Write', write)).toBe(false);
      expect(await allow('Grep', { pattern: 'x', path: extra })).toBe(false);
      expect(await allow('Read', read, 'investigador-1')).toBe(false);

      // Otro mensaje con el subagente vivo: misma sesión y la carpeta sigue cerrada.
      await b.service.send(chat.id, { text: 'como vas' });
      await b.settle(chat.id);
      expect(q.calls).toHaveLength(1);
      expect(await allow('Read', read)).toBe(false);
      expect(await allow('Write', write)).toBe(false);

      b.service.patch(chat.id, { extraRoots: [extra] });
      expect(await allow('Read', read)).toBe(true);
      expect(await allow('Write', write)).toBe(true);
      expect(q.calls).toHaveLength(1);
    } finally {
      await rm(extra, { recursive: true, force: true });
    }
  });
});

describe('ChatService: tope de turnos autónomos seguidos', () => {
  it('al pasar el tope, cierra la sesión con sus subagentes y avisa; un mensaje del usuario reinicia la cuenta', async () => {
    const q = injectableQuery(launchScript);
    const limits = { ...DEFAULT_SETTINGS.mindLimits, maxAutonomousTurns: 2 };
    const b = await bench({ query: q.fn, settings: { ...DEFAULT_SETTINGS, mindLimits: limits } });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'investiga' });
    await b.settle(chat.id);
    const sid = 'sdk-1';
    // Dos turnos autónomos: cada uno termina un subagente y lanza otro.
    for (const [i, name] of ['A', 'B'].entries()) {
      q.inject([taskDone(`t${i + 1}`, `tu${i + 1}`, sid), sdkInit(sid), sdkText(`turno ${name}`, sid), taskStarted(`t${i + 2}`, `tu${i + 2}`, sid), sdkResult(`turno ${name}`, sid, 0.01)]);
      await waitFor(() => b.service.messages(chat.id).some((m) => m.text === `turno ${name}`));
      await b.settle(chat.id);
    }
    expect(q.closed).toBe(0);
    expect(b.service.get(chat.id).backgroundTasks).toBe(1);
    // El tercero pasa el tope: se corta antes de abrir el turno, con el subagente vivo.
    q.inject([taskStarted('t9', 'tu9', sid), sdkInit(sid), sdkText('turno C', sid), sdkResult('turno C', sid, 0.01)]);
    await waitFor(() => q.closed === 1);
    await b.settle(chat.id);
    expect(b.service.get(chat.id).backgroundTasks).toBeUndefined();
    expect(b.service.get(chat.id).state).toBe('idle');
    const texts = b.service.messages(chat.id).map((m) => m.text);
    expect(texts).not.toContain('turno C');
    expect(texts.at(-1)).toMatch(/2 turnos seguidos sin mensaje tuyo/);

    // «sigue» reanuda la sesión con la cuenta en cero: un turno autónomo más pasa.
    await b.service.send(chat.id, { text: 'sigue' });
    await b.settle(chat.id);
    expect(q.calls).toHaveLength(2);
    q.inject([sdkInit(sid), sdkText('turno D', sid), sdkResult('turno D', sid, 0.01)]);
    await waitFor(() => b.service.messages(chat.id).some((m) => m.text === 'turno D'));
    expect(q.closed).toBe(1);
  });

  it('mente-10: un subagente que termina con otros de su tanda vivos no cuenta para el tope; sin subagentes vivos sí', async () => {
    const q = injectableQuery(launchScript);
    const limits = { ...DEFAULT_SETTINGS.mindLimits, maxAutonomousTurns: 1 };
    const b = await bench({ query: q.fn, settings: { ...DEFAULT_SETTINGS, mindLimits: limits } });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'investiga' });
    await b.settle(chat.id);
    const sid = 'sdk-1';
    // Tres programadores en paralelo (el primero lo lanzó el turno del usuario).
    q.inject([taskStarted('t2', 'tu2', sid), taskStarted('t3', 'tu3', sid)]);
    await waitFor(() => b.service.get(chat.id).backgroundTasks === 3);
    // Cada uno termina y abre un turno: los dos primeros son parciales; el último es el único que cuenta (1 de 1).
    for (const [i, id] of ['t1', 't2', 't3'].entries()) {
      q.inject([taskDone(id, `tu${i + 1}`, sid), sdkInit(sid), sdkText(`resultado ${id}`, sid), sdkResult(`resultado ${id}`, sid, 0.01)]);
      await waitFor(() => b.service.messages(chat.id).some((m) => m.text === `resultado ${id}`));
      await b.settle(chat.id);
    }
    expect(q.closed).toBe(0);
    expect(b.service.get(chat.id).backgroundTasks).toBeUndefined();
    // Un turno más sin ningún subagente que lo explique sí pasa el tope.
    q.inject([sdkInit(sid), sdkText('de más', sid), sdkResult('de más', sid, 0.01)]);
    await waitFor(() => q.closed === 1);
    await b.settle(chat.id);
    const texts = b.service.messages(chat.id).map((m) => m.text);
    expect(texts).not.toContain('de más');
    expect(texts.at(-1)).toMatch(/1 turnos seguidos sin mensaje tuyo/);
  });
});
