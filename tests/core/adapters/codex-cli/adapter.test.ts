import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexCliAdapter, codexBrowserOffArgs, codexEffortArgs } from '../../../../src/core/adapters/codex-cli/index.ts';
import type { HintedRunContext } from '../../../../src/core/brief/reasoning.ts';
import { buildReviewTask } from '../../../../src/core/orchestrator/fleet.ts';
import { resolveCodexExecutable } from '../../../../src/core/adapters/codex-cli/executable.ts';
import { translateCodexEvent, classifyCodexError } from '../../../../src/core/adapters/codex-cli/translate.ts';
import type { JsonlLine, JsonlProcessOptions } from '../../../../src/core/process/run-jsonl.ts';
import { agentConfigSchema, agentEventSchema, taskBriefSchema } from '../../../../src/shared/index.ts';
import type { AgentEvent, RunContext, TaskBrief } from '../../../../src/shared/index.ts';

const config = agentConfigSchema.parse({ id: 'codex-test', kind: 'codex-cli', provider: 'codex', displayName: 'Codex' });
const task = taskBriefSchema.parse({ id: 'task-test', projectId: 'project-test', title: 'Prueba', objective: 'Leer y editar fixture.txt',
  ownedPaths: ['fixture.txt'], acceptance: ['Archivo editado'], dependsOn: [], difficulty: 'low' });
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function context(): Promise<RunContext> {
  const path = await mkdtemp(join(tmpdir(), 'orq-codex-test-'));
  directories.push(path);
  return { worktreePath: path, env: {}, signal: new AbortController().signal, timeoutMs: 1000 };
}
async function fixture(name: string): Promise<JsonlLine[]> {
  return (await readFile(new URL(`../../../../fixtures/codex/${name}`, import.meta.url), 'utf8')).trim().split(/\r?\n/)
    .map((line) => ({ kind: 'json', line, value: JSON.parse(line) as unknown }));
}
const exit: JsonlLine = { kind: 'exit', code: 0, signal: null, timedOut: false, aborted: false };
function runner(lines: JsonlLine[]) {
  return vi.fn(async function* (options: JsonlProcessOptions) { void options; yield* lines; });
}
async function collect(adapter: CodexCliAdapter, ctx: RunContext): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of adapter.run(task, ctx)) events.push(agentEventSchema.parse(event));
  return events;
}

describe('Codex CLI', () => {
  it('resuelve Node + codex.js sin .cmd', () => {
    expect(resolveCodexExecutable({ APPDATA: 'C:\\perfil con espacio' })).toEqual({ command: process.execPath,
      args: [join('C:\\perfil con espacio', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')] });
  });
  it('traduce el fixture real de exec y pasa el encargo por stdin', async () => {
    const run = runner([...await fixture('exec-ok.jsonl'), exit]);
    const ctx = await context();
    const events = await collect(new CodexCliAdapter(config, { runner: run }), ctx);
    expect(events.find((e) => e.type === 'text')?.payload).toEqual({ text: 'OK', role: 'assistant' });
    expect(events.find((e) => e.type === 'usage')?.payload).toEqual({ inputTokens: 22572, cachedInputTokens: 13440, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: 0 });
    expect(events.at(-1)).toMatchObject({ type: 'done', payload: { ok: true } });
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(new Set(events.map((e) => e.sessionId)).size).toBe(1);
    const opts = run.mock.calls[0]?.[0];
    expect(opts?.args).toEqual([resolveCodexExecutable().args[0], 'exec', '--json', '-c', 'model_reasoning_effort="low"', ...codexBrowserOffArgs(), '-s', 'workspace-write', '-C', ctx.worktreePath,
      '-o', join(ctx.worktreePath, '.orq', 'ultimo-mensaje.md'), '-']);
    expect(opts?.stdin).toContain(task.objective);
    expect(opts?.args).not.toContain(task.objective);
    expect(opts?.signal).toBe(ctx.signal);
  });
  it('esfuerzo de razonamiento según rol y dificultad; cada reintento sube un nivel hasta high', async () => {
    const effortOf = async (t: TaskBrief, extra: Partial<HintedRunContext> = {}) => {
      const run = runner([...await fixture('exec-ok.jsonl'), exit]);
      const ctx = await context();
      for await (const event of new CodexCliAdapter(config, { runner: run }).run(t, { ...ctx, ...extra })) agentEventSchema.parse(event);
      const args = run.mock.calls[0]?.[0].args ?? [];
      const i = args.indexOf('-c');
      return { pair: args.slice(i, i + 2), stdin: run.mock.calls[0]?.[0].stdin ?? '' };
    };
    expect((await effortOf(task)).pair).toEqual(['-c', 'model_reasoning_effort="low"']);
    expect((await effortOf({ ...task, difficulty: 'medium' })).pair).toEqual(['-c', 'model_reasoning_effort="medium"']);
    expect((await effortOf({ ...task, difficulty: 'high' })).pair).toEqual(['-c', 'model_reasoning_effort="high"']);
    expect((await effortOf(buildReviewTask(task, ['claude'], 'diff'))).pair).toEqual(['-c', 'model_reasoning_effort="medium"']);
    expect((await effortOf(task, { retries: 1 })).pair).toEqual(['-c', 'model_reasoning_effort="medium"']);
    expect((await effortOf({ ...task, difficulty: 'medium' }, { retries: 4 })).pair).toEqual(['-c', 'model_reasoning_effort="high"']);
    expect(codexEffortArgs(task, 2)).toEqual(['-c', 'model_reasoning_effort="high"']);
    // Codex carga AGENTS.md por su cuenta: el encargo no pide leerlo.
    const { stdin } = await effortOf(task);
    expect(stdin).not.toContain('- `AGENTS.md`');
    expect(stdin).toContain('- `.orq/PLAN.md` (plan general)');
  });
  it('traduce comando, cambios y razonamiento (fixture sintético identificado)', async () => {
    const lines = await fixture('items-synthetic.jsonl');
    const last = lines.at(-1);
    const events = lines.flatMap((line) => line.kind === 'json' ? translateCodexEvent(line.value, line.line) : []);
    expect(events).toEqual([
      { type: 'text', payload: { text: 'Resumen de razonamiento', role: 'thinking-summary' } },
      { type: 'tool_call', payload: { callId: 'cmd', name: 'command_execution', inputSummary: 'Get-Content fixture.txt' } },
      { type: 'tool_result', payload: { callId: 'cmd', ok: true, summary: 'antes\n' } },
      { type: 'file_change', payload: { path: 'fixture.txt', change: 'modify' } },
      { type: 'file_change', payload: { path: 'nuevo.txt', change: 'add' } },
      { type: 'file_change', payload: { path: 'viejo.txt', change: 'delete' } },
      { type: 'tool_result', payload: { callId: 'patch', ok: true, summary: 'update fixture.txt\nadd nuevo.txt\ndelete viejo.txt' } },
      { type: 'raw', payload: { source: 'codex-cli', line: last?.kind === 'json' ? last.line : '' } },
    ]);
  });
  it('detecta cupo agotado en error y turn.failed', async () => {
    const events = await collect(new CodexCliAdapter(config, { runner: runner([...await fixture('errors-synthetic.jsonl'), { ...exit, code: 1 }]) }), await context());
    expect(events.filter((e) => e.type === 'error').map((e) => e.payload.code)).toEqual(['quota_exhausted', 'quota_exhausted']);
    expect(events.at(-1)?.payload).toEqual({ ok: false });
  });
  it('detecta mensaje de cupo en texto y stderr', async () => {
    const message = "You've hit your usage limit";
    expect(translateCodexEvent({ type: 'item.completed', item: { id: 'limit', type: 'agent_message', text: message } }, '')[0])
      .toMatchObject({ type: 'error', payload: { code: 'quota_exhausted' } });
    const events = await collect(new CodexCliAdapter(config, { runner: runner([{ kind: 'stderr', line: message }, exit]) }), await context());
    expect(events.find((e) => e.type === 'error')).toMatchObject({ payload: { code: 'quota_exhausted' } });
    expect(events.at(-1)?.payload).toEqual({ ok: false });
  });
  it.each(['rate limit exceeded', 'Too many requests', 'insufficient_quota', 'usage_limit_reached'])('clasifica %s', (message) => {
    expect(classifyCodexError(message)).toBe('quota_exhausted');
  });
  it.each([
    [{ type: 'turn.completed', usage: { input_tokens: -1 } }, 'invalid_output'],
    [{ type: 'item.completed', item: {} }, 'invalid_output'],
    [{ type: 'thread.started' }, 'invalid_output'],
    [null, 'invalid_output'],
  ])('rechaza salida conocida malformada', (value, code) => {
    expect(translateCodexEvent(value, 'original')[0]).toMatchObject({ type: 'error', payload: { code } });
  });
  it('preserva tipos nuevos en raw', () => {
    expect(translateCodexEvent({ type: 'nuevo' }, 'original')).toEqual([{ type: 'raw', payload: { source: 'codex-cli', line: 'original' } }]);
  });
  it.each([
    [{ ...exit, code: 1 }, 'crash'], [{ ...exit, timedOut: true }, 'timeout'], [{ ...exit, aborted: true }, 'cancelled'],
  ] as const)('normaliza salidas fallidas', async (end, code) => {
    const events = await collect(new CodexCliAdapter(config, { runner: runner([end]) }), await context());
    expect(events.find((e) => e.type === 'error')).toMatchObject({ payload: { code } });
    expect(events.at(-1)).toMatchObject({ type: 'done', payload: { ok: false } });
  });
  it('no da éxito a un proceso vacío', async () => {
    const events = await collect(new CodexCliAdapter(config, { runner: runner([exit]) }), await context());
    expect(events.find((e) => e.type === 'error')).toMatchObject({ payload: { code: 'invalid_output' } });
  });
  it('maneja spawn que lanza y termina con done', async () => {
    const events = await collect(new CodexCliAdapter(config, { runner: vi.fn(() => { throw new Error('EPERM'); }) }), await context());
    expect(events.at(-1)).toMatchObject({ type: 'done', payload: { ok: false } });
  });
  it('cancela antes de lanzar', async () => {
    const run = runner([]);
    const ctx = await context();
    ctx.signal = AbortSignal.abort();
    const events = await collect(new CodexCliAdapter(config, { runner: run }), ctx);
    expect(run).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'error')).toMatchObject({ payload: { code: 'cancelled' } });
  });
  it('redacta secretos del entorno en texto, errores y raw', async () => {
    const secret = ['secreto', 'de-prueba', 'sin-credencial'].join('-');
    const ctx = await context();
    ctx.env = { TOKEN: secret };
    const events = await collect(new CodexCliAdapter(config, { runner: runner([
      { kind: 'stderr', line: secret }, { kind: 'json', line: secret, value: { type: 'item.completed', item: { id: 'x', type: 'agent_message', text: secret } } }, exit,
    ]) }), ctx);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).toContain('[REDACTADO]');
  });
  it('sanea el archivo final que escribe el CLI', async () => {
    const ctx = await context();
    const secret = ['secreto', 'de-prueba', 'archivo'].join('-');
    ctx.env = { TOKEN: secret };
    await mkdir(join(ctx.worktreePath, '.orq'));
    const file = join(ctx.worktreePath, '.orq', 'ultimo-mensaje.md');
    await writeFile(file, secret);
    await collect(new CodexCliAdapter(config, { runner: runner([...await fixture('exec-ok.jsonl'), exit]) }), ctx);
    expect(await readFile(file, 'utf8')).toBe('[REDACTADO]');
  });
  it('traduce el fallo real de inicialización como salida cruda y crash', async () => {
    const text = await readFile(new URL('../../../../fixtures/codex/exec-init-failed.txt', import.meta.url), 'utf8');
    const events = await collect(new CodexCliAdapter(config, { runner: runner([{ kind: 'stderr', line: text }, { ...exit, code: 1 }]) }), await context());
    expect(events.at(-1)).toMatchObject({ type: 'done', payload: { ok: false } });
  });
  it('probe lee versión y sesión sin inferencia', async () => {
    const run = vi.fn(async function* (options: JsonlProcessOptions): AsyncGenerator<JsonlLine> {
      yield { kind: 'text', line: options.args.includes('--version') ? 'codex-cli 0.165.0' : 'Logged in using ChatGPT' };
      yield exit;
    });
    expect(await new CodexCliAdapter(config, { runner: run }).probe()).toMatchObject({ installed: true, authenticated: true, version: '0.165.0', quotaMethod: 'codex-ratelimits' });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('probe no autentica por un mensaje con salida fallida', async () => {
    expect(await new CodexCliAdapter(config, { runner: runner([{ kind: 'text', line: 'Not logged in' }, { ...exit, code: 1 }]) }).probe()).toMatchObject({ installed: false, authenticated: false });
  });
});
