import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HookCallbackMatcher, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatError, ChatService, composeUserText, resolveMind } from '../../../src/core/chat/index.ts';
import { CONDUCTOR_AGENT_ID } from '../../../src/core/conductor/index.ts';
import { ClaudeSdkTranslator } from '../../../src/core/adapters/claude-sdk/index.ts';
import { CHROME_TAB_NOTE, NO_BROWSER_NOTE, chromeServerSpec, pluginsSection } from '../../../src/core/plugins/index.ts';
import { DEFAULT_SETTINGS, agentConfigSchema } from '../../../src/shared/index.ts';
import type { Chat } from '../../../src/shared/index.ts';
import { LiveSpend } from '../../../src/core/quota/live-spend.ts';
import { promptBlocks } from '../conductor/fakes.ts';
import { MIND_KEY, PNG, bench, claudeAgent, closeBenches, echoTurn, meteredTurn, sdkInit, sdkResult, sdkSpent, sdkText, settleChat, tick, usageCost, type ChatBench, type TurnFn } from './helpers.ts';

afterEach(closeBenches);

const optionsOf = (b: ChatBench, i = 0): Options => {
  const o = b.q.calls[i]?.options;
  if (!o) throw new Error(`query ${i} no se llamó`);
  return o;
};

/** La guardia (hook PreToolUse) de un proceso del SDK. */
function guardOf(o: Options) {
  const hook = (o.hooks?.PreToolUse as HookCallbackMatcher[] | undefined)?.[0]?.hooks[0];
  if (!hook) throw new Error('falta la guardia');
  const signal = new AbortController().signal;
  return async (tool_name: string, tool_input: unknown): Promise<boolean> => {
    const out = await hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: 'p', cwd: '.' }, 't', { signal });
    return !JSON.stringify(out).includes('"deny"');
  };
}

async function turn(b: ChatBench, chatId: string, text: string) {
  const message = await b.service.send(chatId, { text });
  await b.settle(chatId);
  return message;
}

function userContent(b: ChatBench, i: number): unknown {
  return b.q.received[i]?.message.content;
}

describe('ChatService: ciclo de vida', () => {
  it('crea, lista, renombra, cambia el modo, cierra y borra', async () => {
    const b = await bench();
    const chat = b.service.create({ projectId: 'demo' });
    expect(chat).toMatchObject({ projectId: 'demo', cwd: b.repo, extraRoots: [], mode: 'plan', mindAgentId: 'claude', state: 'idle', costUsd: 0, title: '' });
    expect(chat.sessionId).toBe(`chat-${chat.id}`);
    const solo = b.service.create({ projectId: null, cwd: b.dir, mode: 'auto', title: 'Suelto' });
    expect(b.service.list().map((c) => c.id).sort()).toEqual([chat.id, solo.id].sort());
    expect(b.service.list('demo').map((c) => c.id)).toEqual([chat.id]);
    expect(b.service.list(null).map((c) => c.id)).toEqual([solo.id]);

    expect(b.service.patch(chat.id, { title: '  Tablero  ', mode: 'bypass', extraRoots: [b.dir, b.dir] })).toMatchObject({ title: 'Tablero', mode: 'bypass', extraRoots: [b.dir] });
    expect(b.service.close(chat.id).state).toBe('closed');
    // Nada arrancó el SDK: la sesión es perezosa.
    expect(b.q.calls).toHaveLength(0);
    await b.service.delete(chat.id);
    expect(() => b.service.get(chat.id)).toThrow(ChatError);
    expect(b.sent('chat_deleted')).toEqual([{ type: 'chat_deleted', chatId: chat.id }]);
    expect(b.sent('chat').map((m) => m.chat.id)).toContain(solo.id);
  });

  it('valida proyecto, carpetas y mente', async () => {
    const b = await bench();
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return err instanceof ChatError ? err.code : 'otro';
      }
      return 'sin error';
    };
    expect(code(() => b.service.create({ projectId: 'no-existe' }))).toBe('not_found');
    expect(code(() => b.service.create({ projectId: null }))).toBe('invalid');
    expect(code(() => b.service.create({ projectId: null, cwd: 'relativa' }))).toBe('invalid');
    expect(code(() => b.service.create({ projectId: null, cwd: join(b.dir, 'no-existe') }))).toBe('invalid');
    expect(code(() => b.service.create({ projectId: 'demo', extraRoots: [join(b.dir, 'falta')] }))).toBe('invalid');
    b.agents.splice(0);
    expect(code(() => b.service.create({ projectId: 'demo' }))).toBe('not_configured');
  });

  it('la mente: el agente de los ajustes o el primer claude-sdk habilitado', () => {
    const codex = agentConfigSchema.parse({ id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex' });
    const off = agentConfigSchema.parse({ ...claudeAgent, id: 'claude-off', enabled: false });
    const other = agentConfigSchema.parse({ ...claudeAgent, id: 'claude-2' });
    expect(resolveMind(DEFAULT_SETTINGS, [codex, off, other, claudeAgent]).id).toBe('claude-2');
    expect(resolveMind({ ...DEFAULT_SETTINGS, mind: { agentId: 'claude', effort: 'low' } }, [other, claudeAgent]).id).toBe('claude');
    expect(() => resolveMind({ ...DEFAULT_SETTINGS, mind: { agentId: 'codex', effort: 'low' } }, [codex])).toThrow(/solo un agente Claude/);
    expect(() => resolveMind({ ...DEFAULT_SETTINGS, mind: { agentId: 'claude-off', effort: 'low' } }, [off])).toThrow(/deshabilitado/);
    expect(() => resolveMind(DEFAULT_SETTINGS, [codex])).toThrow(/No hay un agente Claude/);
  });
});

describe('ChatService: mensajes, eventos y costo', () => {
  it('guarda el mensaje del usuario, responde por el hub y publica estado y costo sin duplicarlo', async () => {
    const b = await bench({ settings: { ...DEFAULT_SETTINGS, mind: { agentId: null, model: 'claude-fable-5-1', effort: 'medium' } } });
    const chat = b.service.create({ projectId: 'demo' });
    const message = await b.service.send(chat.id, { text: `Separa la API\ny la interfaz (clave ${MIND_KEY})` });
    // Responde en cuanto guarda el mensaje del usuario.
    expect(message).toMatchObject({ chatId: chat.id, role: 'user', mode: 'plan', attachments: [] });
    expect(message.text).not.toContain(MIND_KEY);
    await b.settle(chat.id);
    // Tampoco llega a la mente (la transcripción del SDK queda en disco).
    expect(JSON.stringify(b.q.received)).not.toContain(MIND_KEY);
    await turn(b, chat.id, 'segundo');

    const o = optionsOf(b);
    expect(b.q.calls).toHaveLength(1);
    expect(o).toMatchObject({ model: 'claude-fable-5-1', effort: 'medium', cwd: b.repo });
    expect(o.resume).toBeUndefined();
    expect(o.env?.ANTHROPIC_API_KEY).toBe(MIND_KEY);
    expect(b.envCalls).toEqual(['claude']);

    const messages = b.service.messages(chat.id);
    expect(messages.map((m) => [m.role, m.text.slice(0, 20)])).toEqual([
      ['user', 'Separa la API\ny la i'],
      ['assistant', 'eco: Separa la API\ny'],
      ['user', 'segundo'],
      ['assistant', 'eco: segundo'],
    ]);
    expect(JSON.stringify(messages)).not.toContain(MIND_KEY);
    expect(b.sent('chat_message').map((m) => m.message.role)).toEqual(['user', 'assistant', 'user', 'assistant']);

    // Estados publicados y título automático.
    const states = b.sent('chat').filter((m) => m.chat.id === chat.id).map((m) => m.chat.state);
    expect(states).toContain('running');
    expect(b.service.get(chat.id)).toMatchObject({ state: 'idle', title: 'Separa la API' });

    // Eventos al hub con sessionId del chat y seq continuo; costo acumulado 0,01 → 0,02 guardado como 0,01 + 0,01.
    const events = b.events(chat.sessionId);
    expect(events.length).toBeGreaterThan(4);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.every((e) => e.agentId === 'orquestador')).toBe(true);
    expect(events.filter((e) => e.type === 'usage').map((e) => (e.type === 'usage' ? e.payload.costUsd : 0))).toEqual([0.01, 0.01]);
    expect(b.store.spentUsd('orquestador')).toBeCloseTo(0.02, 9);
    expect(b.service.get(chat.id).costUsd).toBeCloseTo(0.02, 9);
    expect(b.sent('event').every((m) => m.event.sessionId === chat.sessionId)).toBe(true);
  });

  it('409 con un turno en curso; interrumpir corta el turno y deja el chat ocioso', async () => {
    const slow: TurnFn = async (_m, ctx) => {
      await ctx.stopped;
      return [sdkInit('sdk-1'), sdkText('a medias', 'sdk-1'), sdkResult(undefined, 'sdk-1', 0.001, 'error_during_execution')];
    };
    const b = await bench({ turn: slow });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'largo' });
    expect(b.service.get(chat.id).state).toBe('running');
    await expect(b.service.send(chat.id, { text: 'otro' })).rejects.toMatchObject({ code: 'conflict' });
    // Dos envíos simultáneos: solo uno pasa.
    await b.service.interrupt(chat.id);
    await b.settle(chat.id);
    expect(b.q.interrupted).toBe(1);
    expect(b.service.get(chat.id).state).toBe('idle');
    expect(b.service.messages(chat.id).map((m) => [m.role, m.text])).toEqual([['user', 'largo'], ['assistant', 'a medias']]);
    // Sin turno, interrumpir no hace nada.
    await b.service.interrupt(chat.id);
    expect(b.q.interrupted).toBe(1);
  });

  describe('el result de un turno detenido', () => {
    const DIAG = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null';
    const cut: SDKMessage = { ...sdkResult(undefined, 'sdk-1', 0.001, 'error_during_execution'), errors: [DIAG] } as unknown as SDKMessage;

    it('no deja error ni done fallido: la sesión queda cancelada y el chat ocioso', async () => {
      const slow: TurnFn = async (_m, ctx) => {
        await ctx.stopped;
        return [sdkInit('sdk-1'), sdkText('a medias', 'sdk-1'), cut];
      };
      const b = await bench({ turn: slow });
      const chat = b.service.create({ projectId: 'demo' });
      await b.service.send(chat.id, { text: 'largo' });
      await b.service.interrupt(chat.id);
      await b.settle(chat.id);
      const events = b.events(chat.sessionId);
      expect(events.filter((e) => e.type === 'error')).toEqual([]);
      expect(events.filter((e) => e.type === 'done' && !e.payload.ok)).toEqual([]);
      expect(events.some((e) => e.type === 'usage')).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: 'status', payload: { state: 'cancelled' } });
      expect(b.store.getSession(chat.sessionId)?.state).toBe('cancelled');
      expect(b.service.get(chat.id).state).toBe('idle');
      expect(b.service.messages(chat.id).map((m) => m.text)).toEqual(['largo', 'a medias']);
    });

    it('sin «Detener», el mismo result sigue siendo un fallo', async () => {
      const b = await bench({ turn: () => [sdkInit('sdk-1'), cut] });
      const chat = b.service.create({ projectId: 'demo' });
      await turn(b, chat.id, 'hola');
      const events = b.events(chat.sessionId);
      expect(events.some((e) => e.type === 'error' && e.payload.message.includes('ede_diagnostic'))).toBe(true);
      expect(b.store.getSession(chat.sessionId)?.state).toBe('failed');
      expect(b.service.get(chat.id).state).toBe('error');
    });
  });

  it('dos envíos a la vez: el segundo recibe 409 aunque el primero aún cargue la clave', async () => {
    const b = await bench();
    const chat = b.service.create({ projectId: 'demo' });
    const [one, two] = await Promise.allSettled([b.service.send(chat.id, { text: 'uno' }), b.service.send(chat.id, { text: 'dos' })]);
    expect(one.status).toBe('fulfilled');
    expect(two.status === 'rejected' && two.reason instanceof ChatError && two.reason.code).toBe('conflict');
    await b.settle(chat.id);
    expect(b.service.messages(chat.id).filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('si el SDK no cierra el turno tras interrumpir, corta la sesión y la reanuda con el próximo mensaje', async () => {
    let hang = true;
    const t: TurnFn = async (m, ctx) => {
      if (hang) {
        hang = false;
        await new Promise(() => undefined);
      }
      return echoTurn(m, ctx);
    };
    const b = await bench({ turn: t, interruptGraceMs: 20 });
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'cuelga' });
    await b.service.interrupt(chat.id);
    await b.settle(chat.id);
    expect(b.service.get(chat.id).state).toBe('idle');
    expect(b.q.closed).toBe(1);
    await turn(b, chat.id, 'sigue');
    expect(b.q.calls).toHaveLength(2);
    expect(b.service.messages(chat.id).at(-1)?.text).toMatch(/eco: sigue/);
  });

  it('un turno fallido deja el chat en error y el siguiente vuelve a responder', async () => {
    let fail = true;
    const t: TurnFn = (m, ctx) => {
      if (fail) {
        fail = false;
        return [sdkInit('sdk-1'), sdkResult(undefined, 'sdk-1', 0, 'error_max_turns')];
      }
      return echoTurn(m, ctx);
    };
    const b = await bench({ turn: t });
    const chat = b.service.create({ projectId: 'demo' });
    await turn(b, chat.id, 'uno');
    expect(b.service.get(chat.id).state).toBe('error');
    expect(b.events(chat.sessionId).some((e) => e.type === 'error')).toBe(true);
    await turn(b, chat.id, 'dos');
    expect(b.service.get(chat.id).state).toBe('idle');
  });

  it('presupuesto agotado o sin clave: error claro y no se guarda el mensaje', async () => {
    const b = await bench({ budgetLeftUsd: () => 0 });
    const chat = b.service.create({ projectId: 'demo' });
    await expect(b.service.send(chat.id, { text: 'hola' })).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/Presupuesto/) });
    expect(b.service.messages(chat.id)).toEqual([]);
    expect(b.service.get(chat.id).state).toBe('idle');
  });
});

describe('ChatService: saldo común de la clave', () => {
  /** Saldo de 1 USD sobre lo que la mente tiene guardado en SQLite más lo que llevan en curso sus sesiones vivas. */
  async function sharedBench(t: TurnFn) {
    const ledger = new LiveSpend();
    const holder: { b?: ChatBench } = {};
    const b = await bench({
      turn: t,
      liveSpend: (id) => ledger.open(id),
      budgetLeftUsd: (id) => 1 - (holder.b?.store.spentUsd('orquestador') ?? 0) - ledger.inFlightUsd(id),
    });
    holder.b = b;
    return { b, ledger };
  }

  async function until(cond: () => boolean, ms = 2_000) {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('la condición no se cumplió');
      await tick();
    }
  }

  it('un chat que llega mientras otro gasta recibe solo lo que queda, y sin saldo se rechaza aunque su sesión siga viva', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const t: TurnFn = (_m, ctx) => {
      const sid = `sdk-${ctx.process}`;
      if (ctx.process === 1) {
        return (async function* () {
          yield sdkInit(sid);
          yield sdkSpent('trabajando', sid, 0.8);
          await gate;
          yield sdkResult('listo A', sid, 0.8);
        })();
      }
      return [...(ctx.index === 0 ? [sdkInit(sid)] : []), sdkText('eco', sid), sdkResult('listo B', sid, 0.2 * (ctx.index + 1))];
    };
    const { b, ledger } = await sharedBench(t);
    const chatA = b.service.create({ projectId: 'demo' });
    const chatB = b.service.create({ projectId: 'demo' });
    await b.service.send(chatA.id, { text: 'largo' });
    await until(() => ledger.inFlightUsd('claude') > 0.79);

    // A lleva 0,8 USD sin guardar: B nace con lo que queda, no con el saldo entero.
    await turn(b, chatB.id, 'corto');
    expect(optionsOf(b, 1).maxBudgetUsd).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(b.service.get(chatA.id).state).toBe('running');

    release();
    await b.settle(chatA.id);
    expect(ledger.inFlightUsd('claude')).toBe(0);
    expect(b.store.spentUsd('orquestador')).toBeCloseTo(1, 9);
    // Sin saldo: B se rechaza con su sesión todavía viva (no se recrea ni se cierra).
    await expect(b.service.send(chatB.id, { text: 'otro' })).rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/Presupuesto/) });
    expect(b.q.calls).toHaveLength(2);
    expect(b.q.closed).toBe(0);
    expect(b.service.messages(chatB.id).filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('si a mitad de turno se acaba el saldo común, avisa y corta el turno', async () => {
    const t: TurnFn = (_m, ctx) =>
      (async function* () {
        yield sdkInit('sdk-1');
        yield sdkSpent('sigo gastando', 'sdk-1', 1.2);
        await ctx.stopped;
        yield sdkResult(undefined, 'sdk-1', 1.2, 'error_during_execution');
      })();
    const { b, ledger } = await sharedBench(t);
    const chat = b.service.create({ projectId: 'demo' });
    await b.service.send(chat.id, { text: 'caro' });
    await b.settle(chat.id);
    expect(b.q.interrupted).toBe(1);
    expect(b.service.get(chat.id).state).toBe('idle');
    const errors = b.events(chat.sessionId).filter((e) => e.type === 'error');
    // Primero el aviso del presupuesto; después llega el `result` del turno cortado.
    expect(errors[0]?.type === 'error' && [errors[0].payload.code, errors[0].payload.message]).toEqual(['quota_exhausted', expect.stringMatching(/Presupuesto de claude agotado/)]);
    expect(ledger.inFlightUsd('claude')).toBe(0);
  });
});

describe('ChatService: persistencia y reanudación', () => {
  it('cierra la sesión ociosa y la reanuda con resume y seq continuo', async () => {
    const used = { input: 40, cached: 60, output: 10 };
    const b = await bench({ idleMs: 50, turn: meteredTurn([{ turns: [used] }, { restored: used, turns: [used] }]) });
    const chat = b.service.create({ projectId: 'demo' });
    await turn(b, chat.id, 'primero');
    // (Con la CPU cargada, el temporizador puede vencer antes de esta línea: no se comprueba la sesión viva aquí.)
    for (let i = 0; i < 200 && b.q.closed === 0; i++) await tick(10);
    expect(b.q.closed).toBe(1);
    expect(b.service.sessionOf(chat.id)).toBeUndefined();

    await turn(b, chat.id, 'segundo');
    expect(b.q.calls).toHaveLength(2);
    expect(optionsOf(b, 1).resume).toBe('sdk-1');
    // El proceso reanudado trae el acumulado que restaura Claude Code más lo suyo: solo se cuenta lo suyo (c + c, no 3·c).
    expect(b.service.get(chat.id).costUsd).toBeCloseTo(2 * usageCost(used), 9);
    const events = b.events(chat.sessionId);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.filter((e) => e.type === 'done')).toHaveLength(2);
  });

  it('otro arranque del núcleo ve chats, mensajes y propuestas, y reanuda la conversación', async () => {
    const b = await bench();
    const chat = b.service.create({ projectId: 'demo' });
    await turn(b, chat.id, 'hola');
    await b.service.sessionOf(chat.id)?.tools.call('crear_tareas', { plan: 'plan' });
    b.store.database.prepare(`UPDATE chat_chats SET state = 'running' WHERE id = ?`).run(chat.id);
    b.service.shutdown();

    const again = restart(b);
    try {
      // Crear el servicio no toca la base: el servidor llama a `recover()` cuando ya escucha.
      expect(again.get(chat.id).state).toBe('running');
      again.recover();
      // Un turno `running` sin proceso vivo vuelve a `idle` al arrancar, con un aviso de que se cortó.
      expect(again.get(chat.id).state).toBe('idle');
      expect(again.messages(chat.id).map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
      expect(again.messages(chat.id).at(-1)?.text).toMatch(/se cortó/);
      expect(again.proposals(chat.id).map((p) => [p.task.id, p.approval])).toEqual([['api', 'proposed'], ['ui', 'proposed']]);
      await again.send(chat.id, { text: 'sigo' });
      await settleChat(again, chat.id);
      expect(b.q.calls.at(-1)?.options.resume).toBe('sdk-1');
      const events = b.events(chat.sessionId);
      expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
    } finally {
      again.shutdown();
    }
  });

  it('un turno cortado por el reinicio deja un aviso en el hilo y cierra los subagentes que se perdieron', async () => {
    const b = await bench();
    const chat = b.service.create({ projectId: 'demo' });
    const quiet = b.service.create({ projectId: 'demo' });
    await turn(b, chat.id, 'hola');
    b.store.database.prepare(`UPDATE chat_chats SET state = 'running' WHERE id = ?`).run(chat.id);
    b.store.database
      .prepare(`INSERT INTO chat_messages (id, chat_id, role, text, attachments_json, mode, at) VALUES ('sin-respuesta', ?, 'user', 'investiga', '[]', 'auto', ?)`)
      .run(chat.id, new Date().toISOString());
    for (const id of ['sub-1', 'sub-2']) {
      b.store.append({ sessionId: id, agentId: CONDUCTOR_AGENT_ID, parentSessionId: chat.sessionId, seq: 0, ts: new Date().toISOString(), type: 'status', payload: { state: 'running' } });
    }
    b.service.shutdown();

    const again = restart(b);
    try {
      again.recover();
      expect(again.get(chat.id).state).toBe('idle');
      const notice = again.messages(chat.id).at(-1);
      expect(notice?.role).toBe('assistant');
      expect(notice?.text).toMatch(/se cortó/);
      expect(notice?.text).toMatch(/2 subagentes/);
      expect(b.store.listSessions({ parentSessionId: chat.sessionId }).map((s) => s.state)).toEqual(['cancelled', 'cancelled']);
      // Un chat que estaba libre no recibe aviso.
      expect(again.messages(quiet.id)).toEqual([]);
    } finally {
      again.shutdown();
    }
  });
});

/** Otro arranque del núcleo sobre la misma base (cola y procesos nuevos). */
function restart(b: ChatBench): ChatService {
  return new ChatService({
    db: b.store.database,
    store: b.store,
    hub: b.hub,
    settings: () => DEFAULT_SETTINGS,
    mind: { agents: () => [claudeAgent], env: async () => ({ ANTHROPIC_API_KEY: MIND_KEY }) },
    ports: b.ports,
    translator: (init) => new ClaudeSdkTranslator(init),
    attachments: b.attachments,
    query: b.q.fn,
  });
}

describe('ChatService: modos', () => {
  it('plan: delegar fuera de allowedTools y bloqueada; las propuestas esperan al usuario', async () => {
    const b = await bench();
    const chat = b.service.create({ projectId: 'demo', mode: 'plan' });
    await turn(b, chat.id, 'hola');
    const o = optionsOf(b);
    expect(o.allowedTools).not.toContain('mcp__orquestador__delegar');
    expect(o.allowedTools).toContain('mcp__orquestador__crear_tareas');
    expect(promptBlocks(o)[2]).toMatch(/## Modo: plan/);
    expect(await guardOf(o)('mcp__orquestador__delegar', { taskId: 'api' })).toBe(false);
    const tools = b.service.sessionOf(chat.id)?.tools;
    await tools?.call('crear_tareas', { plan: 'plan' });
    expect(b.service.proposals(chat.id).map((p) => p.approval)).toEqual(['proposed', 'proposed']);
    expect((await tools?.call('delegar', { taskId: 'api' }))?.isError).toBe(true);
    expect(b.ports.fleet.delegated).toEqual([]);
  });

  it('auto: crear_tareas aprueba sola, la mente delega y la tarea llega al tablero', async () => {
    const b = await bench();
    const chat = b.service.create({ projectId: 'demo', mode: 'auto' });
    await turn(b, chat.id, 'hola');
    const o = optionsOf(b);
    expect(o.allowedTools).toContain('mcp__orquestador__delegar');
    expect(promptBlocks(o)[2]).toMatch(/## Modo: auto[\s\S]*quedan aprobadas al instante/);
    expect(await guardOf(o)('mcp__orquestador__delegar', { taskId: 'api' })).toBe(true);
    const tools = b.service.sessionOf(chat.id)?.tools;
    const created = await tools?.call('crear_tareas', { plan: 'plan' });
    expect(created?.isError).toBeFalsy();
    expect(b.service.proposals(chat.id).map((p) => p.approval)).toEqual(['approved', 'approved']);
    expect((await tools?.call('delegar', { taskId: 'api' }))?.isError).toBeFalsy();
    expect(b.ports.fleet.delegated.map((t) => t.id)).toEqual(['api']);
    expect(b.store.getTask('api')?.state).toBe('ready');
    expect(b.sent('task').map((m) => m.task.task.id)).toContain('api');
    expect(b.sent('proposals').at(-1)?.proposals.map((p) => p.approval)).toEqual(['delegated', 'approved']);

    // Cambiar a plan: la guardia la bloquea al instante; el turno siguiente arranca una sesión sin delegar.
    b.service.patch(chat.id, { mode: 'plan' });
    expect(await guardOf(o)('mcp__orquestador__delegar', { taskId: 'ui' })).toBe(false);
    expect((await tools?.call('delegar', { taskId: 'ui' }))?.isError).toBe(true);
    await turn(b, chat.id, 'sigue');
    expect(b.q.calls).toHaveLength(2);
    expect(optionsOf(b, 1).resume).toBe('sdk-1');
    // Sin grabar el prompt: el SDK reanudado manda este contexto (modo plan), no el de la primera sesión.
    expect(optionsOf(b, 1).systemPrompt).toMatchObject({ type: 'custom', snapshot: false });
    expect(optionsOf(b, 1).allowedTools).not.toContain('mcp__orquestador__delegar');
    expect(promptBlocks(optionsOf(b, 1))[2]).toMatch(/## Modo: plan/);
    // El prefijo en caché es el mismo en los dos modos.
    expect(promptBlocks(optionsOf(b, 1))[0]).toBe(promptBlocks(o)[0]);
    expect(b.service.messages(chat.id).map((m) => m.mode)).toEqual(['auto', 'auto', 'plan', 'plan']);
  });

  it('bypass: readRoots amplía la lectura a las unidades locales además de extraRoots', async () => {
    const b = await bench();
    const extra = await mkdtemp(join(tmpdir(), 'orq-extra-'));
    try {
      const chat = b.service.create({ projectId: 'demo', mode: 'auto', extraRoots: [extra] });
      await turn(b, chat.id, 'hola');
      const auto = optionsOf(b);
      expect(auto.additionalDirectories).toContain(extra);
      expect(auto.additionalDirectories).not.toContain('D:\\');
      expect(await guardOf(auto)('Read', { file_path: join(extra, 'a.md') })).toBe(true);
      expect(await guardOf(auto)('Read', { file_path: join(tmpdir(), 'fuera.md') })).toBe(false);

      b.service.patch(chat.id, { mode: 'bypass' });
      await turn(b, chat.id, 'lee fuera');
      const bypass = optionsOf(b, 1);
      expect(bypass.additionalDirectories).toEqual(expect.arrayContaining([extra, 'C:\\', 'D:\\']));
      expect(bypass.allowedTools).toContain('mcp__orquestador__delegar');
      expect(promptBlocks(bypass)[2]).toMatch(/## Modo: bypass/);
      // Issue 8: en bypass la mente edita y ejecuta (la guardia niega una llamada sin ruta ni comando); en auto, no.
      for (const t of ['Bash', 'PowerShell', 'Edit', 'Write']) {
        expect(bypass.allowedTools).toContain(t);
        expect(bypass.disallowedTools).not.toContain(t);
        expect(auto.allowedTools).not.toContain(t);
        expect(await guardOf(bypass)(t, {})).toBe(false);
      }
    } finally {
      await rm(extra, { recursive: true, force: true });
    }
  });

  it('agente suelto: sin herramientas de flota ni propuestas', async () => {
    const b = await bench();
    const chat = b.service.create({ projectId: null, cwd: b.dir, mode: 'auto' });
    await turn(b, chat.id, 'hola');
    const o = optionsOf(b);
    expect(o.cwd).toBe(b.dir);
    for (const t of ['crear_tareas', 'delegar', 'estado', 'escribir_memoria']) expect(o.allowedTools).not.toContain(`mcp__orquestador__${t}`);
    expect(promptBlocks(o)[2]).toMatch(/Proyecto: ninguno \(conversación/);
    const res = await b.service.sessionOf(chat.id)?.tools.call('crear_tareas', { plan: 'x', proyecto: 'demo' });
    expect(res?.isError).toBe(true);
    expect(b.service.proposals(chat.id)).toEqual([]);
  });

  it('los ajustes (modelo, esfuerzo) rigen desde el turno siguiente', async () => {
    const b = await bench();
    const chat = b.service.create({ projectId: 'demo' });
    await turn(b, chat.id, 'uno');
    b.settings.value = { ...DEFAULT_SETTINGS, mind: { agentId: null, model: 'claude-fable-5-1', effort: 'low' } };
    await turn(b, chat.id, 'dos');
    expect(optionsOf(b, 0).model).toBe('claude-opus-5-5');
    expect(optionsOf(b, 1)).toMatchObject({ model: 'claude-fable-5-1', effort: 'low', resume: 'sdk-1' });
  });
});

describe('ChatService: adjuntos', () => {
  it('imagen como bloque image (base64) en el mensaje de usuario', async () => {
    const b = await bench();
    const chat = b.service.create({ projectId: 'demo' });
    const image = await b.attachments.upload({ name: 'captura.png', mime: 'image/png', bytes: PNG });
    const message = await b.service.send(chat.id, { text: '¿qué ves?', attachmentIds: [image.id] });
    await b.settle(chat.id);
    expect(message.attachments).toEqual([image]);
    expect(userContent(b, 0)).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(PNG).toString('base64') } },
      { type: 'text', text: '¿qué ves?' },
    ]);
    // Solo la imagen, sin texto.
    await b.service.send(chat.id, { text: '', attachmentIds: [image.id] });
    await b.settle(chat.id);
    expect(userContent(b, 1)).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(PNG).toString('base64') } }]);
  });

  it('archivo por ruta: «Adjuntos: <ruta>» y su carpeta entra en readRoots', async () => {
    const b = await bench();
    const outside = await mkdtemp(join(tmpdir(), 'orq-escritorio-'));
    try {
      const file = join(outside, 'notas.md');
      await writeFile(file, '# notas');
      const chat = b.service.create({ projectId: 'demo' });
      await turn(b, chat.id, 'antes');
      expect(await guardOf(optionsOf(b))('Read', { file_path: file })).toBe(false);
      const att = await b.attachments.registerPath(file);
      expect(att).toMatchObject({ kind: 'text', source: 'path', path: file, name: 'notas.md' });
      await b.service.send(chat.id, { text: 'resume esto', attachmentIds: [att.id] });
      await b.settle(chat.id);
      expect(userContent(b, 1)).toBe(`resume esto\n\nAdjuntos: ${file}`);
      // La carpeta del archivo cambió las raíces: sesión nueva (reanudada) con la carpeta en additionalDirectories.
      const o = optionsOf(b, 1);
      expect(o.resume).toBe('sdk-1');
      expect(o.additionalDirectories).toContain(dirname(file));
      expect(await guardOf(o)('Read', { file_path: file })).toBe(true);
      expect(composeUserText('', [{ path: 'C:\\a.txt' }, { path: 'D:\\b.pdf' }])).toBe('Adjuntos: C:\\a.txt\nAdjuntos: D:\\b.pdf');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('una subida abre solo su propio archivo, no los de otros chats ni la carpeta común', async () => {
    const b = await bench();
    const otherRepo = join(b.dir, 'otro');
    await mkdir(otherRepo, { recursive: true });
    b.store.putProject({ id: 'otro', name: 'Otro', repoPath: otherRepo });
    const chatA = b.service.create({ projectId: 'demo' });
    const chatB = b.service.create({ projectId: 'otro' });
    const a = await b.attachments.upload({ name: 'a.pdf', mime: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.7 contrato') });
    await b.service.send(chatA.id, { text: 'lee', attachmentIds: [a.id] });
    await b.settle(chatA.id);
    // Subida antigua, en la carpeta común (antes de una carpeta por subida).
    const legacy = join(b.attachments.dir, 'viejo1-notas.txt');
    await mkdir(b.attachments.dir, { recursive: true });
    await writeFile(legacy, 'viejo');
    b.store.database
      .prepare('INSERT INTO chat_attachments (id, name, mime, size, path, kind, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('viejo1', 'notas.txt', 'text/plain', 5, legacy, 'text', 'upload', '2026-11-04T12:00:00.000Z');
    const own = await b.attachments.upload({ name: 'b.txt', mime: 'text/plain', bytes: new TextEncoder().encode('propio') });
    await b.service.send(chatB.id, { text: 'lee', attachmentIds: [own.id, 'viejo1'] });
    await b.settle(chatB.id);

    const o = b.q.calls.at(-1)?.options;
    if (!o) throw new Error('falta la sesión de B');
    const allow = guardOf(o);
    expect(await allow('Read', { file_path: own.path })).toBe(true);
    expect(await allow('Read', { file_path: legacy })).toBe(true);
    expect(await allow('Read', { file_path: a.path })).toBe(false);
    expect(await allow('Glob', { path: b.attachments.dir, pattern: '*' })).toBe(false);
    expect(await allow('Grep', { path: b.attachments.dir, pattern: 'x' })).toBe(false);
    expect(await allow('Glob', { pattern: `${b.attachments.dir.replace(/\\/g, '/')}/**/*` })).toBe(false);
    // additionalDirectories: solo carpetas, sin la carpeta común.
    const dirs = o.additionalDirectories ?? [];
    expect(dirs).not.toContain(b.attachments.dir);
    expect(dirs).toContain(dirname(own.path));
    expect(dirs).not.toContain(legacy);
  });

  it('un envío fallido no deja legible la carpeta de su adjunto', async () => {
    let left = 0;
    const b = await bench({ budgetLeftUsd: () => left });
    const outside = await mkdtemp(join(tmpdir(), 'orq-fallido-'));
    try {
      const file = join(outside, 'x.md');
      await writeFile(file, 'x');
      const att = await b.attachments.registerPath(file);
      const chat = b.service.create({ projectId: 'demo' });
      await expect(b.service.send(chat.id, { text: 'lee', attachmentIds: [att.id] })).rejects.toMatchObject({ code: 'conflict' });
      left = 1;
      await turn(b, chat.id, 'sin adjunto');
      expect(optionsOf(b).additionalDirectories ?? []).not.toContain(outside);
      expect(await guardOf(optionsOf(b))('Read', { file_path: file })).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('una imagen por ruta que dejó de serlo se manda como archivo, no como bloque image', async () => {
    const b = await bench();
    const file = join(b.dir, 'foto.png');
    await writeFile(file, PNG);
    const att = await b.attachments.registerPath(file);
    expect(att.kind).toBe('image');
    await writeFile(file, 'ya no es una imagen');
    const chat = b.service.create({ projectId: 'demo' });
    await turn(b, chat.id, 'hola');
    await b.service.send(chat.id, { text: 'mira', attachmentIds: [att.id] });
    await b.settle(chat.id);
    expect(userContent(b, 1)).toBe(`mira\n\nAdjuntos: ${file}`);
  });

  it('una imagen de más de 5 MB en base64 se rechaza con un error claro y no se guarda el mensaje', async () => {
    const b = await bench();
    const chat = b.service.create({ projectId: 'demo' });
    const big = new Uint8Array(4 * 1024 * 1024);
    big.set(PNG);
    const image = await b.attachments.upload({ name: 'enorme.png', mime: 'image/png', bytes: big });
    await expect(b.service.send(chat.id, { text: 'mira', attachmentIds: [image.id] })).rejects.toMatchObject({
      code: 'too_large',
      message: expect.stringMatching(/«enorme\.png» es demasiado grande.*5 MB en base64/),
    });
    expect(b.service.messages(chat.id)).toEqual([]);
    expect(b.q.calls).toHaveLength(0);
    await expect(b.service.send(chat.id, { text: 'x', attachmentIds: ['no-existe-1'] })).rejects.toMatchObject({ code: 'not_found' });
    // Tras el rechazo, el chat acepta otro mensaje.
    await turn(b, chat.id, 'sin imagen');
    expect(b.service.messages(chat.id)).toHaveLength(2);
  });

  it('borrar el chat borra las copias subidas que solo usaba él', async () => {
    const b = await bench();
    const chat = b.service.create({ projectId: 'demo' });
    const other = b.service.create({ projectId: 'demo' });
    const mine = await b.attachments.upload({ name: 'a.txt', mime: 'text/plain', bytes: new TextEncoder().encode('a') });
    const shared = await b.attachments.upload({ name: 'b.txt', mime: 'text/plain', bytes: new TextEncoder().encode('b') });
    await b.service.send(chat.id, { text: 'x', attachmentIds: [mine.id, shared.id] });
    await b.settle(chat.id);
    await b.service.send(other.id, { text: 'y', attachmentIds: [shared.id] });
    await b.settle(other.id);
    await b.service.delete(chat.id);
    expect(b.attachments.get(mine.id)).toBeUndefined();
    expect(b.attachments.get(shared.id)).toBeDefined();
    await expect(b.attachments.read(mine.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await b.attachments.read(shared.id)).bytes).toEqual(new TextEncoder().encode('b'));
  });
});

describe('ChatService: propuestas', () => {
  async function withProposals(mode: Chat['mode'] = 'plan') {
    const b = await bench();
    const chat = b.service.create({ projectId: 'demo', mode });
    await turn(b, chat.id, 'plan');
    await b.service.sessionOf(chat.id)?.tools.call('crear_tareas', { plan: 'Objetivo, pasos, rutas, riesgos y verificación' });
    return { b, chat };
  }

  it('aprobar entrega a la flota: ready en el tablero, delegated en el chat, difusión de proposals y task', async () => {
    const { b, chat } = await withProposals();
    expect(b.sent('proposals').at(-1)).toMatchObject({ chatId: chat.id, proposals: [{ approval: 'proposed' }, { approval: 'proposed' }] });
    const out = await b.service.approve(chat.id, ['api']);
    expect(out).toMatchObject({ delivered: ['api'], failed: [] });
    expect(out.proposals.map((p) => [p.task.id, p.approval])).toEqual([['api', 'delegated'], ['ui', 'proposed']]);
    expect(b.ports.fleet.delegated.map((t) => t.id)).toEqual(['api']);
    expect(b.store.getTask('api')?.state).toBe('ready');
    expect(b.sent('task').some((m) => m.task.task.id === 'api' && m.task.state === 'ready')).toBe(true);
    // Las propuestas del chat son estrictas: sin fechas internas.
    expect(Object.keys(out.proposals[0] ?? {}).sort()).toEqual(['approval', 'proposedAt', 'task']);
    // El planificador no repite ids ya usados en el tablero ni en otras conversaciones.
    await b.service.sessionOf(chat.id)?.tools.call('crear_tareas', { plan: 'otro plan' });
    expect(b.ports.planner.requests.at(-1)?.knownTaskIds).toEqual(expect.arrayContaining(['api', 'ui']));
  });

  it('rechazar, y aprobar todo en orden de dependencias', async () => {
    const { b, chat } = await withProposals();
    expect(b.service.reject(chat.id, ['ui']).map((p) => [p.task.id, p.approval])).toEqual([['api', 'proposed'], ['ui', 'rejected']]);
    const all = await b.service.approveAll(chat.id);
    expect(all.delivered).toEqual(['api']);
    expect(all.proposals.map((p) => p.approval)).toEqual(['delegated', 'rejected']);
    await expect(Promise.resolve().then(() => b.service.reject(chat.id, ['api']))).rejects.toMatchObject({ code: 'conflict' });
    await expect(b.service.approve(chat.id, ['nada'])).rejects.toMatchObject({ code: 'not_found' });
  });

  it('aprobar todo entrega primero las dependencias (ui depende de api)', async () => {
    const { b, chat } = await withProposals();
    const all = await b.service.approveAll(chat.id);
    expect(all).toMatchObject({ delivered: ['api', 'ui'], failed: [] });
    expect(b.ports.fleet.delegated.map((t) => t.id)).toEqual(['api', 'ui']);
  });

  it('una dependencia sin entregar o un rechazo de la flota dejan la tarea aprobada para reintentar', async () => {
    const { b, chat } = await withProposals();
    const ui = await b.service.approve(chat.id, ['ui']);
    expect(ui.delivered).toEqual([]);
    expect(ui.failed).toEqual([{ taskId: 'ui', reason: expect.stringMatching(/depende de api/) }]);
    b.ports.fleet.reject = 'falta el gestor de worktrees';
    const api = await b.service.approve(chat.id, ['api']);
    expect(api.failed).toEqual([{ taskId: 'api', reason: 'falta el gestor de worktrees' }]);
    expect(api.proposals.map((p) => p.approval)).toEqual(['approved', 'approved']);
    expect(b.store.getTask('api')?.state).toBe('pending');
    b.ports.fleet.reject = undefined;
    const retry = await b.service.approveAll(chat.id);
    expect(retry.delivered).toEqual(['api', 'ui']);
    expect(b.store.getTask('api')?.state).toBe('ready');
  });

  it('las propuestas de un chat no pisan las de otro', async () => {
    const { b, chat } = await withProposals();
    const other = b.service.create({ projectId: 'demo' });
    await turn(b, other.id, 'plan');
    const res = await b.service.sessionOf(other.id)?.tools.call('crear_tareas', { plan: 'mismo plan' });
    expect(res?.isError).toBe(true);
    expect(JSON.stringify(res)).toMatch(/otra conversación/);
    expect(b.service.proposals(other.id)).toEqual([]);
    expect(b.service.proposals(chat.id)).toHaveLength(2);
  });
});

describe('ChatService: plugins para la mente', () => {
  it('mcpServersFor(agentId) llega como mcpServers del SDK con sus herramientas en allowedTools', async () => {
    const asked: string[] = [];
    const fake = { type: 'stdio' as const, command: 'node', args: ['servidor-falso.mjs'] };
    const b = await bench({
      mcpServersFor: (agentId) => {
        asked.push(agentId);
        return { 'chrome-personal': fake };
      },
    });
    const chat = b.service.create({ projectId: 'demo' });
    await turn(b, chat.id, 'navega');
    const o = optionsOf(b);
    expect(asked).toContain('claude');
    expect(o.mcpServers?.['chrome-personal']).toEqual(fake);
    expect(Object.keys(o.mcpServers ?? {}).sort()).toEqual(['chrome-personal', 'orquestador']);
    expect(o.allowedTools).toContain('mcp__chrome-personal__*');
    expect(await guardOf(o)('mcp__chrome-personal__navigate_page', { url: 'https://example.com' })).toBe(true);
    expect(await guardOf(o)('mcp__otro__borrar', {})).toBe(false);
  });

  it('un token renovado (mismo servidor, otro secreto) recrea la sesión reanudada; si nada cambia, la reutiliza', async () => {
    let token = `Bearer ${'a'.repeat(24)}`;
    const canva = { type: 'http' as const, url: 'https://mcp.canva.com/mcp', headers: { Authorization: '${ORQ_MCP_CANVA_AUTHORIZATION}' } };
    const b = await bench({ plugins: async () => ({ mcpServers: { canva }, env: { ORQ_MCP_CANVA_AUTHORIZATION: token } }) });
    const chat = b.service.create({ projectId: 'demo' });
    await turn(b, chat.id, 'uno');
    await turn(b, chat.id, 'dos');
    expect(b.q.calls).toHaveLength(1);
    token = `Bearer ${'b'.repeat(24)}`;
    await turn(b, chat.id, 'tres');
    expect(b.q.calls).toHaveLength(2);
    expect(optionsOf(b, 1).resume).toBe('sdk-1');
    expect(optionsOf(b, 1).env?.ORQ_MCP_CANVA_AUTHORIZATION).toBe(token);
  });

  it('las reglas de los plugins llegan al prompt de la mente (también solo notas, sin servidores) y cambiarlas recrea la sesión', async () => {
    const chrome = chromeServerSpec({ command: 'cmd.exe', args: ['/c', 'chrome-personal.cmd'] }, { agent: 'claude', task: 'sesion', locksRoot: 'C:\\locks' });
    let rules = pluginsSection({ servers: { 'chrome-personal': chrome }, notes: [] });
    let mcpServers: Record<string, { type: 'stdio'; command: string; args: string[] }> = { 'chrome-personal': { type: 'stdio', command: 'node', args: ['puerta.mjs'] } };
    const b = await bench({ plugins: async () => ({ mcpServers, env: {}, rules }) });
    const chat = b.service.create({ projectId: 'demo' });
    await turn(b, chat.id, 'navega');
    const first = promptBlocks(optionsOf(b)).join('\n');
    expect(first).toContain(CHROME_TAB_NOTE);
    expect(first).toContain('no escribas contraseñas');
    // Chrome desconectado: sin servidores, pero con la nota de que no hay navegador.
    mcpServers = {};
    rules = pluginsSection({ servers: {}, notes: [NO_BROWSER_NOTE] });
    await turn(b, chat.id, 'abre una página');
    expect(b.q.calls).toHaveLength(2);
    const second = promptBlocks(optionsOf(b, 1)).join('\n');
    expect(second).toContain(NO_BROWSER_NOTE);
    expect(second).not.toContain(CHROME_TAB_NOTE);
    // Solo cambia el texto de las reglas: cambia la forma y la sesión se recrea.
    rules = pluginsSection({ servers: {}, notes: [NO_BROWSER_NOTE, 'Canva no está disponible en esta sesión.'] });
    await turn(b, chat.id, 'tres');
    expect(b.q.calls).toHaveLength(3);
    expect(promptBlocks(optionsOf(b, 2)).join('\n')).toContain('Canva no está disponible');
  });

  it('pluginLive: la guardia de la sesión viva niega en el acto un plugin que se desconectó', async () => {
    let on = true;
    const fake = { type: 'stdio' as const, command: 'node', args: ['servidor-falso.mjs'] };
    // El Chrome personal: en plan solo pasan sus herramientas de lectura (plugin-policy), como list_pages.
    const b = await bench({ mcpServersFor: () => ({ 'chrome-personal': fake }), pluginLive: (agentId, server) => agentId === 'claude' && server === 'chrome-personal' && on });
    const chat = b.service.create({ projectId: 'demo' });
    await turn(b, chat.id, 'navega');
    const guard = guardOf(optionsOf(b));
    expect(await guard('mcp__chrome-personal__list_pages', {})).toBe(true);
    on = false;
    expect(await guard('mcp__chrome-personal__list_pages', {})).toBe(false);
    expect(await guard('Read', { file_path: join(b.repo, 'a.txt') })).toBe(true);
  });
});

describe('ChatService: el texto sale tachado', () => {
  it('ni la clave de la sesión ni patrones de claves llegan a SQLite', async () => {
    const leak: TurnFn = (): SDKMessage[] => [sdkInit('sdk-1'), sdkText(`mi clave es ${MIND_KEY}`, 'sdk-1'), sdkResult(`listo ${MIND_KEY}`, 'sdk-1', 0.001)];
    const b = await bench({ turn: leak });
    const chat = b.service.create({ projectId: 'demo', title: `t ${MIND_KEY}` });
    await turn(b, chat.id, 'hola');
    const dump = JSON.stringify([b.service.list(), b.service.messages(chat.id), b.events(chat.sessionId)]);
    expect(dump).not.toContain(MIND_KEY);
    expect(dump).toContain('[REDACTADO]');
  });
});

describe('ChatService: carpetas', () => {
  it('extraRoots debe existir; se puede vaciar', async () => {
    const b = await bench();
    const sub = join(b.dir, 'sub');
    await mkdir(sub);
    const chat = b.service.create({ projectId: 'demo', extraRoots: [sub] });
    expect(chat.extraRoots).toEqual([sub]);
    expect(() => b.service.patch(chat.id, { extraRoots: [join(b.dir, 'falta')] })).toThrow(/no existe la carpeta/);
    expect(b.service.patch(chat.id, { extraRoots: [] }).extraRoots).toEqual([]);
  });
});
