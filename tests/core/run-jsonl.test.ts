import { afterEach, describe, expect, it } from 'vitest';
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

/** Deja vivo un nieto que hereda stdout/stderr (como un demonio que deja el agente), avisa su PID y sale. */
const conNieto = [
  "const { spawn } = require('node:child_process');",
  "const n = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'inherit', detached: true });",
  "n.unref();",
  "console.log(JSON.stringify({ nieto: n.pid }));",
  "console.log(JSON.stringify({ ok: true }));",
].join('\n');

const nietos: number[] = [];
function anotarNieto(item: JsonlLine) {
  if (item.kind !== 'json' || typeof item.value !== 'object' || item.value === null || !('nieto' in item.value)) return;
  if (typeof item.value.nieto === 'number') nietos.push(item.value.nieto);
}

async function collectConNieto(gen: AsyncGenerator<JsonlLine>, onItem?: (item: JsonlLine) => void): Promise<JsonlLine[]> {
  const out: JsonlLine[] = [];
  for await (const item of gen) { anotarNieto(item); onItem?.(item); out.push(item); }
  return out;
}

afterEach(() => {
  for (const pid of nietos.splice(0)) {
    try { process.kill(pid); } catch { /* ya terminó */ }
  }
});

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

  it('no cae si el hijo sale sin leer un stdin grande', async () => {
    for (let i = 0; i < 5; i++) {
      const items = await collect(runJsonl({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(), stdin: 'x'.repeat(2_000_000) }));
      expect(items.at(-1)).toMatchObject({ kind: 'exit', code: 0, timedOut: false, aborted: false });
      const stdinError = items.findIndex((item) => item.kind === 'stderr' && item.line.startsWith('stdin:'));
      if (stdinError !== -1) expect(stdinError).toBeLessThan(items.length - 1);
    }
  });

  describe('con un nieto que hereda stdout y sigue vivo', () => {
    it('termina poco después de que sale el hijo y conserva su código', async () => {
      const items = await collectConNieto(runJsonl({ command: process.execPath, args: ['-e', conNieto], cwd: process.cwd() }));
      expect(items.some((i) => i.kind === 'json' && JSON.stringify(i.value) === '{"ok":true}')).toBe(true);
      expect(items.some((i) => i.kind === 'stderr' && i.line.includes('proceso descendiente'))).toBe(true);
      expect(items.filter((i) => i.kind === 'exit')).toHaveLength(1);
      expect(items.at(-1)).toMatchObject({ kind: 'exit', code: 0, timedOut: false, aborted: false });
    }, 15_000);

    it('termina con un plazo y entrega un solo exit', async () => {
      const items = await collectConNieto(runJsonl({ command: process.execPath, args: ['-e', conNieto], cwd: process.cwd(), timeoutMs: 1000 }));
      expect(items.filter((i) => i.kind === 'exit')).toHaveLength(1);
      expect(items.at(-1)?.kind).toBe('exit');
    }, 15_000);

    it('la cancelación termina la iteración aunque el hijo ya haya salido', async () => {
      const ac = new AbortController();
      const started = Date.now();
      const items = await collectConNieto(runJsonl({ command: process.execPath, args: ['-e', conNieto], cwd: process.cwd(), signal: ac.signal }), (item) => {
        if (item.kind === 'json' && JSON.stringify(item.value) === '{"ok":true}') setTimeout(() => ac.abort(), 300);
      });
      expect(items.filter((i) => i.kind === 'exit')).toHaveLength(1);
      expect(items.at(-1)).toMatchObject({ kind: 'exit', aborted: true });
      expect(Date.now() - started).toBeLessThan(10_000);
    }, 15_000);
  });
});
