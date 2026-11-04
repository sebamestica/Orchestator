import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyAgyError,
  translateAgyEvent,
} from '../../../../src/core/adapters/agy-cli/translate.ts';
import { agentEventSchema } from '../../../../src/shared/index.ts';

describe('translateAgyEvent con fixtures reales', () => {
  const fixturesDir = path.resolve(__dirname, '../../../../fixtures/agy');

  it('traduce stream-edit-command.jsonl completo preservando orden y datos', () => {
    const rawContent = readFileSync(path.join(fixturesDir, 'stream-edit-command.jsonl'), 'utf8');
    const lines = rawContent.trim().split('\n');

    let seq = 0;
    const allEvents = lines.flatMap((line) => {
      const parsed = JSON.parse(line);
      const bodies = translateAgyEvent(parsed, line);
      return bodies.map((body) =>
        agentEventSchema.parse({
          ...body,
          sessionId: 's-123',
          agentId: 'agy',
          seq: seq++,
          ts: '2026-11-01T21:00:00Z',
        }),
      );
    });

    expect(allEvents.length).toBeGreaterThan(10);

    // 1. init -> status running
    const statusEv = allEvents.find((e) => e.type === 'status');
    expect(statusEv).toBeDefined();
    if (statusEv && statusEv.type === 'status') {
      expect(statusEv.payload.state).toBe('running');
      expect(statusEv.payload.detail).toBe('b6696142-fd67-4b0b-aba1-10b4af1b0f5d');
    }

    // 2. tool_call write_file
    const writeFileCall = allEvents.find(
      (e) => e.type === 'tool_call' && e.payload.name === 'write_file',
    );
    expect(writeFileCall).toBeDefined();
    if (writeFileCall && writeFileCall.type === 'tool_call') {
      expect(writeFileCall.payload.callId).toBe('2');
      expect(writeFileCall.payload.inputSummary).toContain('saludo.txt');
    }

    // 3. file_change y tool_result write_file
    const fileChange = allEvents.find((e) => e.type === 'file_change');
    expect(fileChange).toBeDefined();
    if (fileChange && fileChange.type === 'file_change') {
      expect(fileChange.payload.path).toContain('saludo.txt');
      expect(fileChange.payload.change).toBe('modify');
    }

    const writeFileResult = allEvents.find(
      (e) => e.type === 'tool_result' && e.payload.callId === '2',
    );
    expect(writeFileResult).toBeDefined();
    if (writeFileResult && writeFileResult.type === 'tool_result') {
      expect(writeFileResult.payload.ok).toBe(true);
    }

    // 4. tool_call y tool_result run_command
    const runCmdCall = allEvents.find(
      (e) => e.type === 'tool_call' && e.payload.name === 'run_command',
    );
    expect(runCmdCall).toBeDefined();
    if (runCmdCall && runCmdCall.type === 'tool_call') {
      expect(runCmdCall.payload.callId).toBe('4');
      expect(runCmdCall.payload.inputSummary).toBe('echo terminado');
    }

    const runCmdResult = allEvents.find(
      (e) => e.type === 'tool_result' && e.payload.callId === '4',
    );
    expect(runCmdResult).toBeDefined();
    if (runCmdResult && runCmdResult.type === 'tool_result') {
      expect(runCmdResult.payload.ok).toBe(true);
      expect(runCmdResult.payload.summary).toContain('terminado');
    }

    // 5. text deltas
    const textEvents = allEvents.filter((e) => e.type === 'text');
    expect(textEvents.length).toBeGreaterThan(5);
    for (const t of textEvents) {
      if (t.type === 'text') {
        expect(t.payload.role).toBe('assistant');
        expect(t.payload.text.length).toBeGreaterThan(0);
      }
    }

    // 6. usage por paso
    const usageEvents = allEvents.filter((e) => e.type === 'usage');
    expect(usageEvents.length).toBeGreaterThanOrEqual(3);
    const firstUsage = usageEvents[0];
    if (firstUsage && firstUsage.type === 'usage') {
      expect(firstUsage.payload.inputTokens).toBe(12875);
      expect(firstUsage.payload.outputTokens).toBe(44);
    }

    // 7. result -> done
    const doneEv = allEvents.find((e) => e.type === 'done');
    expect(doneEv).toBeDefined();
    if (doneEv && doneEv.type === 'done') {
      expect(doneEv.payload.ok).toBe(true);
      expect(doneEv.payload.summary).toContain('Se ha creado el archivo');
    }
  });

  it('traduce stream-quota-error.jsonl a error quota_exhausted', () => {
    const rawContent = readFileSync(path.join(fixturesDir, 'stream-quota-error.jsonl'), 'utf8');
    const lines = rawContent.trim().split('\n');
    const events = lines.flatMap((line) => translateAgyEvent(JSON.parse(line), line));

    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    if (err && err.type === 'error') {
      expect(err.payload.code).toBe('quota_exhausted');
      expect(err.payload.message).toContain('RESOURCE_EXHAUSTED');
    }
  });

  it('traduce stream-error.jsonl a error con modelo no reconocido', () => {
    const rawContent = readFileSync(path.join(fixturesDir, 'stream-error.jsonl'), 'utf8');
    const line = rawContent.trim();
    const events = translateAgyEvent(JSON.parse(line), line);

    expect(events).toHaveLength(1);
    const err = events[0];
    expect(err).toBeDefined();
    if (err && err.type === 'error') {
      expect(err.payload.code).toBe('invalid_output');
      expect(err.payload.message).toContain('invalid model selection');
    }
  });
});

describe('classifyAgyError', () => {
  it('clasifica cuotas y límites agotados', () => {
    expect(classifyAgyError('RESOURCE_EXHAUSTED: Rate limit exceeded')).toBe('quota_exhausted');
    expect(classifyAgyError('quota exhausted for Gemini Models')).toBe('quota_exhausted');
    expect(classifyAgyError('too many requests, retry later')).toBe('quota_exhausted');
  });

  it('clasifica fallos de autenticación', () => {
    expect(classifyAgyError('unauthorized request')).toBe('auth');
    expect(classifyAgyError('login required to proceed')).toBe('auth');
    expect(classifyAgyError('API key not valid')).toBe('auth');
  });

  it('clasifica timeouts y cancelaciones', () => {
    expect(classifyAgyError('execution timed out')).toBe('timeout');
    expect(classifyAgyError('operation was aborted by signal')).toBe('cancelled');
  });

  it('devuelve unknown ante mensajes desconocidos', () => {
    expect(classifyAgyError('fallo interno indeterminado')).toBe('unknown');
  });
});
