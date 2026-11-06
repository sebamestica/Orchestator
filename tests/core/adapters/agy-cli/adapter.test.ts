import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgyCliAdapter, agyBrowserOffArgs } from '../../../../src/core/adapters/agy-cli/index.ts';
import { pathValue } from '../../../../src/core/adapters/agy-cli/git-shim.ts';
import type { HintedRunContext } from '../../../../src/core/brief/reasoning.ts';
import type { JsonlLine, JsonlProcessOptions } from '../../../../src/core/process/run-jsonl.ts';
import type { AgentConfig, AgentEvent, RunContext, TaskBrief } from '../../../../src/shared/index.ts';
import { agentConfigSchema, REDACTED, taskBriefSchema } from '../../../../src/shared/index.ts';

const baseConfig: AgentConfig = agentConfigSchema.parse({
  id: 'agy-test',
  kind: 'agy-cli',
  provider: 'antigravity',
  displayName: 'Antigravity CLI Test',
  model: 'gemini-3.8-flash-high',
});

const sampleTask: TaskBrief = taskBriefSchema.parse({
  id: 'tarea-test',
  projectId: 'orquestador',
  title: 'Probar agy adapter',
  objective: 'Verificar la integración del adaptador',
  ownedPaths: ['src/core/test.ts'],
  dependsOn: [],
  acceptance: ['pruebas en verde'],
  difficulty: 'low',
});

async function collectEvents(gen: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
  }
  return events;
}

describe('AgyCliAdapter.probe', () => {
  it('detecta correctamente versión y modelos disponibles', async () => {
    async function* mockRunner(opts: JsonlProcessOptions): AsyncGenerator<JsonlLine> {
      if (opts.args.includes('--version')) {
        yield { kind: 'text', line: '1.4.12' };
        yield { kind: 'exit', code: 0, signal: null, timedOut: false, aborted: false };
      } else if (opts.args.includes('models')) {
        yield { kind: 'text', line: 'Fetching available models...' };
        yield { kind: 'text', line: 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)' };
        yield { kind: 'text', line: 'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)' };
        yield { kind: 'exit', code: 0, signal: null, timedOut: false, aborted: false };
      }
    }

    const adapter = new AgyCliAdapter(baseConfig, { runner: mockRunner });
    const probe = await adapter.probe();

    expect(probe.installed).toBe(true);
    expect(probe.authenticated).toBe(true);
    expect(probe.version).toBe('1.4.12');
    expect(probe.models).toEqual(['gemini-3.8-flash-high', 'claude-sonnet-4-6']);
    expect(probe.quotaMethod).toBe('agy-usage');
    expect(probe.warnings).toHaveLength(0);
  });

  it('maneja agy no instalado o con error', async () => {
    async function* mockRunner(): AsyncGenerator<JsonlLine> {
      yield { kind: 'stderr', line: 'command not found: agy' };
      yield { kind: 'exit', code: 127, signal: null, timedOut: false, aborted: false };
    }

    const adapter = new AgyCliAdapter(baseConfig, { runner: mockRunner });
    const probe = await adapter.probe();

    expect(probe.installed).toBe(false);
    expect(probe.authenticated).toBe(false);
    expect(probe.models).toHaveLength(0);
    expect(probe.warnings.length).toBeGreaterThan(0);
  });
});

describe('AgyCliAdapter.run', () => {
  it('crea BRIEF-<tarea>.md, ejecuta agy con argumentos correctos y emite eventos', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'agy-adapter-test-'));
    let capturedOpts: JsonlProcessOptions | undefined;

    async function* mockRunner(opts: JsonlProcessOptions): AsyncGenerator<JsonlLine> {
      capturedOpts = opts;
      yield {
        kind: 'json',
        value: { event: 'init', conversation_id: 'conv-123' },
        line: JSON.stringify({ event: 'init', conversation_id: 'conv-123' }),
      };
      yield {
        kind: 'json',
        value: {
          event: 'step_update',
          step_update: {
            step_index: 1,
            state: 'DONE',
            step_type: 'agent_response',
            text_delta: '¡Completado exitosamente con secreto-ultra!',
            usage: { input_tokens: 100, output_tokens: 20 },
          },
        },
        line: '',
      };
      yield {
        kind: 'json',
        value: {
          event: 'result',
          result: {
            conversation_id: 'conv-123',
            status: 'SUCCESS',
            response: 'Todo listo',
          },
        },
        line: '',
      };
      yield { kind: 'exit', code: 0, signal: null, timedOut: false, aborted: false };
    }

    try {
      const adapter = new AgyCliAdapter(baseConfig, { runner: mockRunner });
      const ctx: RunContext = {
        worktreePath: tmp,
        env: { SECRET_TOKEN: 'secreto-ultra' },
        signal: new AbortController().signal,
        timeoutMs: 30000,
      };

      const events = await collectEvents(adapter.run(sampleTask, ctx));

      // Verificó creación del archivo de brief
      const briefContent = await readFile(path.join(tmp, '.orq', 'BRIEF-tarea-test.md'), 'utf8');
      expect(briefContent).toContain('# Tarea tarea-test: Probar agy adapter');
      // El git de Berland pasa por un .cmd y cmd se come los ^.
      expect(briefContent).toContain('usa HEAD~1, no ^');

      // Verificó argumentos del CLI
      expect(capturedOpts).toBeDefined();
      expect(capturedOpts?.args).toEqual([
        '-p',
        'Lee el archivo .orq/BRIEF-tarea-test.md y cúmplelo.',
        '--output-format',
        'stream-json',
        '--dangerously-skip-permissions',
        ...agyBrowserOffArgs(),
        '--model',
        'gemini-3.8-flash-high',
      ]);
      expect(capturedOpts?.cwd).toBe(tmp);
      // autoeval-reglas-04: su git pasa por el `git` de Berland, primero en el PATH (en Windows, con git.exe instalado).
      if (process.platform === 'win32') {
        const shimDir = path.join(tmp, '.orq', 'bin');
        expect(pathValue(capturedOpts?.env ?? {})?.split(path.delimiter)[0]).toBe(shimDir);
        expect(await readFile(path.join(shimDir, 'git.cmd'), 'utf8')).toContain('git-shim.ts');
        expect(capturedOpts?.env?.SECRET_TOKEN).toBe('secreto-ultra');
      }

      // Verificó eventos
      expect(events[0]?.type).toBe('status');
      expect((events[0] as { payload: { state: string } }).payload.state).toBe('starting');

      const textEv = events.find((e) => e.type === 'text');
      expect(textEv).toBeDefined();
      if (textEv && textEv.type === 'text') {
        expect(textEv.payload.text).not.toContain('secreto-ultra');
        expect(textEv.payload.text).toContain(REDACTED);
      }

      const doneEv = events.at(-1);
      expect(doneEv?.type).toBe('done');
      if (doneEv && doneEv.type === 'done') {
        expect(doneEv.payload.ok).toBe(true);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('modo local: el BRIEF-<tarea>.md lleva la sección «Modo local» (sin commits ni ramas)', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'agy-adapter-local-'));
    async function* mockRunner(): AsyncGenerator<JsonlLine> {
      yield { kind: 'exit', code: 0, signal: null, timedOut: false, aborted: false };
    }
    try {
      const adapter = new AgyCliAdapter(baseConfig, { runner: mockRunner });
      const ctx: HintedRunContext = { worktreePath: tmp, env: {}, signal: new AbortController().signal, timeoutMs: 30000, local: { path: tmp } };
      await collectEvents(adapter.run(sampleTask, ctx));
      const brief = await readFile(path.join(tmp, '.orq', 'BRIEF-tarea-test.md'), 'utf8');
      expect(brief).toContain('## Modo local (sin worktree)');
      expect(brief).toContain('No hagas commits ni ramas');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('emite error de cancelación si signal está abortada antes de iniciar', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'agy-abort-test-'));
    try {
      const controller = new AbortController();
      controller.abort();

      const adapter = new AgyCliAdapter(baseConfig);
      const ctx: RunContext = {
        worktreePath: tmp,
        env: {},
        signal: controller.signal,
        timeoutMs: 30000,
      };

      const events = await collectEvents(adapter.run(sampleTask, ctx));
      const errEv = events.find((e) => e.type === 'error');
      expect(errEv).toBeDefined();
      if (errEv && errEv.type === 'error') {
        expect(errEv.payload.code).toBe('cancelled');
      }

      const doneEv = events.at(-1);
      expect(doneEv?.type).toBe('done');
      if (doneEv && doneEv.type === 'done') {
        expect(doneEv.payload.ok).toBe(false);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('emite error de quota_exhausted si agy retorna error de cuota', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'agy-quota-test-'));
    async function* mockRunner(): AsyncGenerator<JsonlLine> {
      yield {
        kind: 'json',
        value: {
          event: 'result',
          result: {
            conversation_id: 'conv-q',
            status: 'ERROR',
            error: 'RESOURCE_EXHAUSTED: Rate limit exceeded for Gemini Models',
          },
        },
        line: '',
      };
      yield { kind: 'exit', code: 1, signal: null, timedOut: false, aborted: false };
    }

    try {
      const adapter = new AgyCliAdapter(baseConfig, { runner: mockRunner });
      const ctx: RunContext = {
        worktreePath: tmp,
        env: {},
        signal: new AbortController().signal,
        timeoutMs: 30000,
      };

      const events = await collectEvents(adapter.run(sampleTask, ctx));
      const quotaErr = events.find(
        (e) => e.type === 'error' && e.payload.code === 'quota_exhausted',
      );
      expect(quotaErr).toBeDefined();

      const doneEv = events.at(-1);
      expect(doneEv?.type).toBe('done');
      if (doneEv && doneEv.type === 'done') {
        expect(doneEv.payload.ok).toBe(false);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('emite error de timeout si el proceso se interrumpe por tiempo', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'agy-timeout-test-'));
    async function* mockRunner(): AsyncGenerator<JsonlLine> {
      yield { kind: 'exit', code: null, signal: 'SIGTERM', timedOut: true, aborted: false };
    }

    try {
      const adapter = new AgyCliAdapter(baseConfig, { runner: mockRunner });
      const ctx: RunContext = {
        worktreePath: tmp,
        env: {},
        signal: new AbortController().signal,
        timeoutMs: 1000,
      };

      const events = await collectEvents(adapter.run(sampleTask, ctx));
      const timeoutErr = events.find((e) => e.type === 'error' && e.payload.code === 'timeout');
      expect(timeoutErr).toBeDefined();

      const doneEv = events.at(-1);
      expect(doneEv?.type).toBe('done');
      if (doneEv && doneEv.type === 'done') {
        expect(doneEv.payload.ok).toBe(false);
      }
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('AgyCliAdapter.run: cierre y avisos (revisión A0)', () => {
  const exit = (code: number): JsonlLine => ({ kind: 'exit', code, signal: null, timedOut: false, aborted: false });
  const success = { event: 'result', result: { status: 'SUCCESS', response: 'OK' } };
  async function runWith(lines: JsonlLine[]): Promise<AgentEvent[]> {
    const tmp = await mkdtemp(path.join(tmpdir(), 'agy-a0-test-'));
    try {
      async function* runner(): AsyncGenerator<JsonlLine> { yield* lines; }
      const ctx: RunContext = { worktreePath: tmp, env: {}, signal: new AbortController().signal, timeoutMs: 30000 };
      return await collectEvents(new AgyCliAdapter(baseConfig, { runner }).run(sampleTask, ctx));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  it('result SUCCESS seguido de salida con código 1: un solo done, al final y fallido', async () => {
    const events = await runWith([{ kind: 'json', value: success, line: JSON.stringify(success) }, exit(1)]);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    const last = events.at(-1);
    expect(last).toMatchObject({ type: 'done', payload: { ok: false } });
    expect(events.at(-2)).toMatchObject({ type: 'error', payload: { code: 'crash' } });
  });

  it('result SUCCESS y salida 0: done ok con el resumen de agy', async () => {
    const events = await runWith([{ kind: 'json', value: success, line: JSON.stringify(success) }, exit(0)]);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'done', payload: { ok: true, summary: 'OK' } });
  });

  it('un aviso en stderr que menciona timeout no hace fallar la tarea', async () => {
    const events = await runWith([
      { kind: 'stderr', line: 'W1101 retrying request after timeout (attempt 1)' },
      { kind: 'json', value: success, line: JSON.stringify(success) },
      exit(0),
    ]);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.find((e) => e.type === 'raw')).toMatchObject({ payload: { source: 'agy-stderr' } });
    expect(events.at(-1)).toMatchObject({ type: 'done', payload: { ok: true } });
  });

  it('un aviso de diagnóstico en stderr con 401 dentro de un nombre no es error de sesión', async () => {
    const line = 'WARNING: proceeding, even though we could not create PATH aliases at path "C:\\tmp\\arg0\\agy-arg0a4012b"';
    const events = await runWith([{ kind: 'stderr', line }, { kind: 'json', value: success, line: JSON.stringify(success) }, exit(0)]);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'done', payload: { ok: true } });
  });
});
