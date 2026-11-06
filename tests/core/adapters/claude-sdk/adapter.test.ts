import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSdkAdapter, DEFAULT_CLAUDE_MODEL, installedSdkVersion } from '../../../../src/core/adapters/claude-sdk/index.ts';
import type { HintedRunContext } from '../../../../src/core/brief/reasoning.ts';
import { renderBrief } from '../../../../src/core/brief/render-brief.ts';
import { LiveSpend } from '../../../../src/core/quota/live-spend.ts';
import { agentConfigSchema, type RunContext } from '../../../../src/shared/index.ts';
import { FAKE_KEY, WORKTREE, collect, config, ctx, fakeQuery, loadJsonl, payload, task } from './helpers.ts';

const subagentRun = loadJsonl('subagent-run.jsonl');
const ids = () => {
  let n = 0;
  return () => `sesion-${n++}`;
};

describe('ClaudeSdkAdapter.run', () => {
  it('pasa a query() el encargo, el worktree, los permisos y las reglas del repo', async () => {
    const fake = fakeQuery(subagentRun);
    const adapter = new ClaudeSdkAdapter({ config, query: fake.query, baseEnv: { PATH: 'C:\\Windows' }, newSessionId: ids() });
    await collect(adapter.run(task, ctx()));

    expect(fake.calls).toHaveLength(1);
    const { prompt, options } = fake.calls[0] ?? { prompt: '', options: {} };
    expect(prompt).toBe(renderBrief(task));
    expect(options).toMatchObject({
      cwd: WORKTREE,
      model: DEFAULT_CLAUDE_MODEL,
      permissionMode: 'acceptEdits',
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      forwardSubagentText: true,
    });
    expect(options.hooks?.PreToolUse).toHaveLength(1);
    expect(options.abortController).toBeInstanceOf(AbortController);
    expect(options.maxBudgetUsd).toBeUndefined();
    expect(fake.closed).toBe(true);
  });

  it('modo local: el prompt lleva la sección «Modo local» solo si ctx.local viene', async () => {
    const promptOf = async (c: RunContext) => {
      const fake = fakeQuery(subagentRun);
      await collect(new ClaudeSdkAdapter({ config, query: fake.query, baseEnv: {}, newSessionId: ids() }).run(task, c));
      return fake.calls[0]?.prompt ?? '';
    };
    const local: HintedRunContext = { ...ctx(), local: { path: 'C:\\x' } };
    const withLocal = await promptOf(local);
    expect(withLocal).toContain('## Modo local (sin worktree)');
    expect(withLocal).toContain('No hagas commits ni ramas');
    expect(await promptOf(ctx())).not.toContain('## Modo local');
  });

  it('emite starting, la traducción de la fixture y termina en done ok', async () => {
    const adapter = new ClaudeSdkAdapter({ config, query: fakeQuery(subagentRun).query, newSessionId: ids() });
    const events = await collect(adapter.run(task, ctx()));
    expect(events[0]).toMatchObject({ type: 'status', sessionId: 'sesion-0', payload: { state: 'starting' } });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.filter((e) => e.parentSessionId === 'sesion-0').length).toBe(4);
    expect(payload(events, 'usage')[0]).toMatchObject({ costUsd: 0.401845, model: 'claude-opus-5-5' });
    expect(events.at(-1)).toMatchObject({ type: 'done', payload: { ok: true, summary: 'OK ARANDANO' } });
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('env: hereda el entorno base, aplica baseUrl y ctx.env, y quita las marcas de Claude Code anfitrión', async () => {
    const fake = fakeQuery(subagentRun);
    const withUrl = agentConfigSchema.parse({ ...config, baseUrl: 'https://proxy.example.com' });
    const adapter = new ClaudeSdkAdapter({
      config: withUrl,
      query: fake.query,
      baseEnv: { PATH: 'C:\\Windows', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ANTHROPIC_API_KEY: 'sk-ant-vieja-0000000000000000', VACIA: undefined },
    });
    await collect(adapter.run(task, ctx()));
    expect(fake.calls[0]?.options.env).toEqual({
      PATH: 'C:\\Windows',
      ANTHROPIC_API_KEY: FAKE_KEY,
      ANTHROPIC_BASE_URL: 'https://proxy.example.com',
      CLAUDE_AGENT_SDK_CLIENT_APP: 'orquestador/0.1.0',
    });

    const fake2 = fakeQuery(subagentRun);
    await collect(new ClaudeSdkAdapter({ config: withUrl, query: fake2.query, baseEnv: {} }).run(task, ctx({ env: { ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_BASE_URL: 'http://152.0.0.1' } })));
    expect(fake2.calls[0]?.options.env?.ANTHROPIC_BASE_URL).toBe('http://152.0.0.1');
  });

  it('usa config.model y deja pasar opciones extra sin pisar las propias', async () => {
    const fake = fakeQuery(subagentRun);
    const cfg = agentConfigSchema.parse({ ...config, model: 'claude-sonnet-5-5' });
    await collect(new ClaudeSdkAdapter({ config: cfg, query: fake.query, extraOptions: { maxTurns: 3, cwd: 'C:\\otro', permissionMode: 'bypassPermissions' } }).run(task, ctx()));
    expect(fake.calls[0]?.options).toMatchObject({ model: 'claude-sonnet-5-5', maxTurns: 3, cwd: WORKTREE, permissionMode: 'acceptEdits' });
  });

  it('la política de herramientas por defecto bloquea git push, MCP no configuradas y ediciones fuera del worktree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orq-adaptador-'));
    try {
      const fake = fakeQuery(subagentRun);
      await collect(new ClaudeSdkAdapter({ config, query: fake.query }).run(task, ctx({ worktreePath: dir })));
      const canUseTool = fake.calls[0]?.options.canUseTool;
      expect(canUseTool).toBeTypeOf('function');
      const ask = async (name: string, input: Record<string, unknown>) =>
        ((await canUseTool?.(name, input, { signal: new AbortController().signal, toolUseID: 't', requestId: 'r' })) as PermissionResult).behavior;
      expect(await ask('Bash', { command: 'git push origin main' })).toBe('deny');
      expect(await ask('Bash', { command: 'npm run -s check' })).toBe('allow');
      expect(await ask('Write', { file_path: 'C:\\Windows\\system.ini', content: '' })).toBe('deny');
      expect(await ask('Write', { file_path: join(dir, 'src', 'a.ts'), content: '' })).toBe('allow');
      expect(await ask('mcp__fs__write_file', { path: 'x' })).toBe('deny');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falla cerrado si el worktree no existe: no se puede comprobar la ruta real', async () => {
    const fake = fakeQuery(subagentRun);
    await collect(new ClaudeSdkAdapter({ config, query: fake.query }).run(task, ctx()));
    const verdict = (await fake.calls[0]?.options.canUseTool?.('Write', { file_path: `${WORKTREE}\\a.ts` }, { signal: new AbortController().signal, toolUseID: 't', requestId: 'r' })) as PermissionResult;
    expect(verdict.behavior).toBe('deny');
  });

  it('las MCP configuradas a mano y extraTools se permiten; las rutas del encargo se pueden leer', async () => {
    const fake = fakeQuery(subagentRun);
    const t = { ...task, skillRefs: ['C:\\dev\\agent-hub\\skills\\flota\\SKILL.md'] };
    const adapter = new ClaudeSdkAdapter({ config, query: fake.query, extraTools: ['WebFetch'], extraOptions: { mcpServers: { orq: { type: 'stdio', command: 'node', args: ['x.js'] } } } });
    await collect(adapter.run(t, ctx()));
    const canUseTool = fake.calls[0]?.options.canUseTool;
    const ask = async (name: string, input: Record<string, unknown>) =>
      ((await canUseTool?.(name, input, { signal: new AbortController().signal, toolUseID: 't', requestId: 'r' })) as PermissionResult).behavior;
    expect(await ask('mcp__orq__estado', {})).toBe('allow');
    expect(await ask('mcp__otro__x', {})).toBe('deny');
    expect(await ask('WebFetch', { url: 'https://x' })).toBe('allow');
    expect(await ask('Read', { file_path: 'C:\\dev\\agent-hub\\skills\\flota\\references\\a.md' })).toBe('allow');
    expect(await ask('Read', { file_path: 'C:\\dev\\agent-hub\\locks\\x' })).toBe('deny');
  });

  it('tacha la clave en todos los eventos', async () => {
    const leak = [{ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: `mi clave: ${FAKE_KEY}` }] } }, ...subagentRun.slice(-1)];
    const events = await collect(new ClaudeSdkAdapter({ config, query: fakeQuery(leak).query }).run(task, ctx()));
    expect(JSON.stringify(events)).not.toContain(FAKE_KEY);
  });

  it('rechaza configuraciones de otro tipo de agente', () => {
    expect(() => new ClaudeSdkAdapter({ config: agentConfigSchema.parse({ ...config, kind: 'api' }) })).toThrow(/claude-sdk/);
  });
});

describe('ClaudeSdkAdapter.run: errores', () => {
  it('auth: con la fixture real de clave inválida corta al primer reintento 401', async () => {
    const fake = fakeQuery(loadJsonl('auth-error.jsonl'));
    const events = await collect(new ClaudeSdkAdapter({ config, query: fake.query }).run(task, ctx()));
    expect(payload(events, 'status').filter((p) => p.state === 'waiting')).toHaveLength(1);
    expect(payload(events, 'error')).toEqual([{ code: 'auth', message: 'Autenticación rechazada: La API respondió HTTP 401 (authentication_failed).' }]);
    expect(events.at(-1)?.payload).toEqual({ ok: false });
    expect(fake.closed).toBe(true);
  });

  it('auth: con retryPermanentErrors espera el resultado del SDK y también da auth', async () => {
    const events = await collect(new ClaudeSdkAdapter({ config, query: fakeQuery(loadJsonl('auth-error.jsonl')).query, retryPermanentErrors: true }).run(task, ctx()));
    expect(payload(events, 'error').map((p) => p.code)).toEqual(['auth']);
    expect(payload(events, 'status').filter((p) => p.state === 'waiting')).toHaveLength(10);
  });

  it('auth: excepción del proceso con stderr de clave inválida', async () => {
    const fake = fakeQuery([], { stderr: 'Error: Invalid API key · Please run /login', throwAtEnd: new Error('Claude Code process exited with code 1') });
    const events = await collect(new ClaudeSdkAdapter({ config, query: fake.query }).run(task, ctx()));
    expect(payload(events, 'error')[0]?.code).toBe('auth');
    expect(payload(events, 'error')[0]?.message).toMatch(/exited with code 1 \| stderr: Error: Invalid API key/);
  });

  it('crash: el proceso muere sin resultado ni pistas', async () => {
    const events = await collect(new ClaudeSdkAdapter({ config, query: fakeQuery(subagentRun.slice(0, 2), { throwAtEnd: new Error('spawn ENOENT') }).query }).run(task, ctx()));
    expect(payload(events, 'error')).toEqual([{ code: 'crash', message: 'spawn ENOENT' }]);
    // Registra lo estimado hasta ese momento.
    // Registra lo estimado hasta ese momento (ver translate.test.ts: prompt ×1,4 escrito en caché y salida del contenido).
    expect(payload(events, 'usage')).toEqual([{ inputTokens: 44080, outputTokens: 48, cachedInputTokens: 0, cacheWriteTokens: 44080, costUsd: 0.22136, model: 'claude-opus-5-5' }]);
    expect(events.at(-1)?.payload).toEqual({ ok: false });
  });

  it('crash: el SDK termina sin mensaje de resultado', async () => {
    const events = await collect(new ClaudeSdkAdapter({ config, query: fakeQuery(subagentRun.slice(0, 1)).query }).run(task, ctx()));
    expect(payload(events, 'error')).toEqual([{ code: 'crash', message: 'El SDK terminó sin mensaje de resultado.' }]);
  });
});

describe('ClaudeSdkAdapter.run: presupuesto (config.budgetUsd)', () => {
  const budget = (budgetUsd: number) => agentConfigSchema.parse({ ...config, budgetUsd });

  it('pasa al SDK el presupuesto restante como maxBudgetUsd', async () => {
    const fake = fakeQuery(subagentRun);
    await collect(new ClaudeSdkAdapter({ config: budget(2), query: fake.query, spentUsd: async () => 1.5 }).run(task, ctx()));
    expect(fake.calls[0]?.options.maxBudgetUsd).toBe(0.5);
  });

  it('no arranca si el presupuesto ya se agotó', async () => {
    const fake = fakeQuery(subagentRun);
    const events = await collect(new ClaudeSdkAdapter({ config: budget(2), query: fake.query, spentUsd: () => 2.1 }).run(task, ctx()));
    expect(fake.calls).toHaveLength(0);
    expect(payload(events, 'error')).toEqual([{ code: 'quota_exhausted', message: 'Presupuesto agotado: gastados 2.1000 de 2 USD.' }]);
    expect(events.at(-1)?.payload).toEqual({ ok: false });
  });

  it('corta en curso con quota_exhausted cuando lo gastado supera lo disponible', async () => {
    const fake = fakeQuery(subagentRun);
    const events = await collect(new ClaudeSdkAdapter({ config: budget(0.05), query: fake.query }).run(task, ctx()));
    // Se detiene tras el primer mensaje del asistente (~0,221 USD estimados), antes del subagente.
    expect(events.some((e) => e.parentSessionId !== undefined)).toBe(false);
    expect(payload(events, 'error')).toEqual([{ code: 'quota_exhausted', message: 'Se superó el presupuesto en curso: ~0.2214 USD de 0.0500 USD disponibles.' }]);
    expect(payload(events, 'usage')[0]).toMatchObject({ costUsd: 0.22136 });
    expect(events.at(-1)?.payload).toEqual({ ok: false });
    expect(fake.closed).toBe(true);
  });

  it('corta en curso si entre todos los que pagan con la clave se supera el presupuesto, y cierra su cuenta en curso', async () => {
    const fake = fakeQuery(subagentRun);
    const ledger = new LiveSpend();
    const chat = ledger.open(config.id);
    let reads = 0;
    // Al arrancar nadie gastó; a mitad de la ejecución un chat de la mente lleva 0,9 USD sin guardar.
    const spentUsd = () => {
      if (reads++ > 0) chat.set(0.9);
      return ledger.inFlightUsd(config.id);
    };
    const adapter = new ClaudeSdkAdapter({ config: budget(1), query: fake.query, spentUsd, liveSpend: () => ledger.open(config.id) });
    const events = await collect(adapter.run(task, ctx()));
    expect(fake.calls[0]?.options.maxBudgetUsd).toBe(1);
    expect(payload(events, 'error')).toEqual([{ code: 'quota_exhausted', message: expect.stringMatching(/^Presupuesto agotado: la clave de .+ superó 1 USD/) }]);
    expect(fake.closed).toBe(true);
    expect(ledger.inFlightUsd(config.id)).toBe(0.9);
    chat.close();
    expect(ledger.inFlightUsd(config.id)).toBe(0);
  });

  it('el tope del propio SDK (fixture real error_max_budget_usd) también da quota_exhausted', async () => {
    const events = await collect(new ClaudeSdkAdapter({ config: budget(0.01), query: fakeQuery(loadJsonl('budget-exceeded.jsonl')).query }).run(task, ctx()));
    expect(payload(events, 'error')[0]?.code).toBe('quota_exhausted');
    expect(payload(events, 'usage')[0]).toMatchObject({ costUsd: 0.025221 });
  });

  it('error al leer el gasto: no arranca', async () => {
    const fake = fakeQuery(subagentRun);
    const events = await collect(new ClaudeSdkAdapter({ config: budget(1), query: fake.query, spentUsd: () => Number.NaN }).run(task, ctx()));
    expect(fake.calls).toHaveLength(0);
    expect(payload(events, 'error')[0]?.message).toMatch(/No se pudo leer el gasto/);
  });
});

describe('ClaudeSdkAdapter.run: cancelación y tiempo', () => {
  it('cancela con ctx.signal y emite cancelled + done', async () => {
    const controller = new AbortController();
    const fake = fakeQuery(subagentRun.slice(0, 1), { hang: true });
    const adapter = new ClaudeSdkAdapter({ config, query: fake.query });
    const events = [];
    for await (const e of adapter.run(task, ctx({ signal: controller.signal }))) {
      events.push(e);
      if (e.type === 'status' && e.payload.state === 'running') controller.abort();
    }
    expect(fake.calls[0]?.options.abortController?.signal.aborted).toBe(true);
    expect(payload(events, 'error')).toEqual([{ code: 'cancelled', message: 'Tarea cancelada.' }]);
    expect(events.at(-1)?.payload).toEqual({ ok: false });
  });

  it('no llama al SDK si la señal ya estaba abortada', async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeQuery(subagentRun);
    const events = await collect(new ClaudeSdkAdapter({ config, query: fake.query }).run(task, ctx({ signal: controller.signal })));
    expect(fake.calls).toHaveLength(0);
    expect(payload(events, 'error')[0]?.code).toBe('cancelled');
  });

  it('corta por ctx.timeoutMs con timeout', async () => {
    const fake = fakeQuery(subagentRun.slice(0, 1), { hang: true });
    const events = await collect(new ClaudeSdkAdapter({ config, query: fake.query }).run(task, ctx({ timeoutMs: 50 })));
    expect(payload(events, 'error')).toEqual([{ code: 'timeout', message: 'Se agotó el tiempo de la tarea (0 s).' }]);
    expect(events.at(-1)?.payload).toEqual({ ok: false });
  });

  it('si el consumidor deja de leer, cierra el proceso del SDK', async () => {
    const fake = fakeQuery(subagentRun);
    for await (const e of new ClaudeSdkAdapter({ config, query: fake.query }).run(task, ctx())) {
      if (e.type === 'tool_call') break;
    }
    expect(fake.closed).toBe(true);
  });
});

describe('installedSdkVersion', () => {
  it('lee la versión del paquete instalado', () => {
    expect(installedSdkVersion()).toBe('0.3.302');
  });
});
