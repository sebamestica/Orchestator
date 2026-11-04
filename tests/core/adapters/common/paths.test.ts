import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { relativizeChange } from '../../../../src/core/adapters/common/paths.ts';
import { translateCodexEvent } from '../../../../src/core/adapters/codex-cli/translate.ts';

const change = (path: string) => ({ type: 'file_change' as const, payload: { path, change: 'modify' as const } });

describe('relativizeChange compartido', () => {
  it.each([
    ['C:\\dev\\wt', 'C:\\dev\\wt\\src\\a.ts', 'src/a.ts'],
    ['C:\\dev\\wt', 'c:\\dev\\wt\\src\\a.ts', 'src/a.ts'],
    ['c:\\dev\\wt', 'C:\\dev\\wt\\src\\a.ts', 'src/a.ts'],
    ['C:/dev\\wt', 'c:\\dev/wt\\src/a.ts', 'src/a.ts'],
  ])('normaliza %s y %s', (root, file, expected) => {
    expect(relativizeChange(change(file), root).payload).toMatchObject({ path: expected });
  });

  it('convierte rutas nativas dentro del worktree', () => {
    const root = join(tmpdir(), 'orq-wt');
    expect(relativizeChange(change(join(root, 'src', 'a.ts')), root).payload).toMatchObject({ path: 'src/a.ts' });
  });

  it.each(['C:\\otra\\a.ts', 'C:\\dev\\wt-otro\\a.ts', 'D:\\dev\\wt\\a.ts', 'src/a.ts', 'src\\a.ts', '../a.ts', 'C:\\dev\\wt'])('conserva %s', (file) => {
    const event = change(file);
    expect(relativizeChange(event, 'C:\\dev\\wt')).toBe(event);
  });

  it('conserva eventos que no cambian archivos', () => {
    const event = { type: 'tool_call' as const, payload: { callId: '1', name: 'read', inputSummary: '' } };
    expect(relativizeChange(event, 'C:\\dev\\wt')).toBe(event);
  });

  it('normaliza el cambio de una sesion real grabada', () => {
    const raw = readFileSync(new URL('../../../../fixtures/codex/exec-command-edit.jsonl', import.meta.url), 'utf8');
    const event = raw.split('\n').filter(Boolean).flatMap((line) => translateCodexEvent(JSON.parse(line), line)).find((body) => body.type === 'file_change');
    expect(event?.type).toBe('file_change');
    if (event?.type !== 'file_change') throw new Error('Fixture sin cambio de archivo');
    const root = join(tmpdir(), 'orq-fixture');
    const absolute = { ...event, payload: { ...event.payload, path: join(root, 'src', 'fixture.ts') } };
    expect(relativizeChange(absolute, root).payload).toMatchObject({ path: 'src/fixture.ts', change: event.payload.change });
  });
});
