import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from '../../../../src/core/adapters/claude-sdk/index.ts';
import { agentConfigSchema, agentEventSchema, taskBriefSchema, type AgentEvent, type RunContext } from '../../../../src/shared/index.ts';

export const fixturePath = (name: string) => fileURLToPath(new URL(`../../../../fixtures/claude-sdk/${name}`, import.meta.url));

/** Mensajes crudos del SDK grabados en vivo (tests/live/claude-sdk.live.test.ts con ORQ_RECORD=1). */
export function loadJsonl(name: string): unknown[] {
  return readFileSync(fixturePath(name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown);
}

/** Clave ficticia con formato de Anthropic (no es real). */
export const FAKE_KEY = 'sk-ant-api03-FALSAparaPRUEBAS0123456789abcdefABCDEF';
export const WORKTREE = 'C:\\orq-fixture\\worktree';

export const config = agentConfigSchema.parse({
  id: 'claude-main',
  kind: 'claude-sdk',
  provider: 'anthropic',
  displayName: 'Claude',
});

export const task = taskBriefSchema.parse({
  id: 'tarea-prueba',
  projectId: 'orquestador',
  title: 'Tarea de prueba',
  objective: 'Responde exactamente: OK',
  ownedPaths: ['src/x.ts'],
  dependsOn: [],
  acceptance: ['Responde OK'],
  difficulty: 'low',
});

export function ctx(overrides: Partial<RunContext> = {}): RunContext {
  return {
    worktreePath: WORKTREE,
    env: { ANTHROPIC_API_KEY: FAKE_KEY },
    signal: new AbortController().signal,
    timeoutMs: 0,
    ...overrides,
  };
}

export interface FakeQuery {
  query: QueryFn;
  calls: { prompt: string; options: Options }[];
  readonly closed: boolean;
}

/**
 * `query` simulado que reproduce mensajes grabados. Con `hang`, después de los mensajes espera a que
 * se aborte `options.abortController` y lanza un AbortError (como el SDK real).
 */
export function fakeQuery(messages: readonly unknown[], opts: { hang?: boolean; throwAtEnd?: Error; stderr?: string } = {}): FakeQuery {
  const calls: FakeQuery['calls'] = [];
  let closed = false;
  const query: QueryFn = (params) => {
    calls.push(params);
    const signal = params.options.abortController?.signal;
    async function* gen(): AsyncGenerator<unknown> {
      for (const m of messages) {
        if (signal?.aborted) throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
        yield m;
      }
      if (opts.stderr) params.options.stderr?.(opts.stderr);
      if (opts.hang) {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        throw Object.assign(new Error('Claude Code process aborted by user'), { name: 'AbortError' });
      }
      if (opts.throwAtEnd) throw opts.throwAtEnd;
    }
    return Object.assign(gen(), { close: () => { closed = true; } });
  };
  return {
    query,
    calls,
    get closed() {
      return closed;
    },
  };
}

export async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of iterable) out.push(agentEventSchema.parse(e));
  return out;
}

type PayloadOf<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>['payload'];

/** Cargas de los eventos de un tipo, en orden. */
export function payload<T extends AgentEvent['type']>(events: readonly AgentEvent[], type: T): PayloadOf<T>[] {
  return events.filter((e) => e.type === type).map((e) => e.payload as PayloadOf<T>);
}
