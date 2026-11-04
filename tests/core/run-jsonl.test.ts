import { describe, expect, it } from 'vitest';
import { runJsonl, type JsonlLine } from '../../src/core/process/run-jsonl.ts';

async function collect(gen: AsyncGenerator<JsonlLine>): Promise<JsonlLine[]> {
  const out: JsonlLine[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

const script = [
  "process.stdin.on('data', d => {",
  "  console.log(JSON.stringify({ type: 'eco', text: String(d).trim() }));",
  "  console.log('texto suelto');",
  "  console.error('aviso');",
  "});",
].join('\n');

describe('runJsonl', () => {
  it('separa JSON, texto y stderr y termina con exit', async () => {
    const items = await collect(runJsonl({ command: process.execPath, args: ['-e', script], cwd: process.cwd(), stdin: 'hola' }));
    expect(items.find((i) => i.kind === 'json')).toMatchObject({ value: { type: 'eco', text: 'hola' } });
    expect(items.some((i) => i.kind === 'text' && i.line === 'texto suelto')).toBe(true);
    expect(items.some((i) => i.kind === 'stderr' && i.line === 'aviso')).toBe(true);
    expect(items.at(-1)).toMatchObject({ kind: 'exit', code: 0, timedOut: false });
  });

  it('corta por timeout', async () => {
    const items = await collect(runJsonl({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], cwd: process.cwd(), timeoutMs: 500 }));
    expect(items.at(-1)).toMatchObject({ kind: 'exit', timedOut: true });
  });
});
