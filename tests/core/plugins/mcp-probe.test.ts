import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeStdioMcp } from '../../../src/core/plugins/index.ts';
import { cleanup, fakeLauncher, tempDir } from './helpers.ts';

afterEach(cleanup);

const realTools = (JSON.parse(await readFile(new URL('./fixtures/chrome-devtools-mcp-1.11.0-tools.json', import.meta.url), 'utf8')) as { tools: string[] }).tools;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pidOf(marker: string): Promise<number> {
  const m = /inicio (\d+)/.exec(await readFile(marker, 'utf8'));
  if (!m?.[1]) throw new Error('sin pid');
  return Number(m[1]);
}

describe('probeStdioMcp (MCP por stdio con tiempo límite)', () => {
  it('initialize + tools/list paginado + tools/call, y cierra el servidor por EOF', async () => {
    const marker = join(await tempDir(), 'marca.txt');
    const l = fakeLauncher('ok', marker);
    const r = await probeStdioMcp({ command: l.command, args: l.args, call: { name: 'list_pages' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.server).toEqual({ name: 'chrome_devtools', version: '1.11.0' });
    expect(r.tools).toEqual(realTools);
    expect(r.tools).toHaveLength(32);
    expect(r.callText).toContain('about:blank');
    expect(r.stderr).toContain('chrome-devtools-mcp (falso) listo');
    expect(await readFile(marker, 'utf8')).toContain('cerrado');
    expect(alive(await pidOf(marker))).toBe(false);
  });

  it('responde las peticiones del servidor (ping, roots/list) sin trabarse', async () => {
    const l = fakeLauncher('ping-first');
    const r = await probeStdioMcp({ command: l.command, args: l.args });
    expect(r).toMatchObject({ ok: true });
  });

  it('servidor mudo: falla por tiempo en initialize y lo termina', async () => {
    const marker = join(await tempDir(), 'marca.txt');
    const l = fakeLauncher('hang', marker);
    const t0 = Date.now();
    const r = await probeStdioMcp({ command: l.command, args: l.args, startTimeoutMs: 1500, closeGraceMs: 500 });
    expect(r).toMatchObject({ ok: false, stage: 'initialize', reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(alive(await pidOf(marker))).toBe(false);
  });

  it('servidor que ignora el EOF: se termina el proceso tras la espera', async () => {
    const marker = join(await tempDir(), 'marca.txt');
    const l = fakeLauncher('ignore-eof', marker);
    const r = await probeStdioMcp({ command: l.command, args: l.args, closeGraceMs: 300 });
    expect(r.ok).toBe(true);
    const pid = await pidOf(marker);
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((res) => setTimeout(res, 50));
    expect(alive(pid)).toBe(false);
  });

  it('servidor que termina al arrancar: etapa initialize, motivo exit, con stderr', async () => {
    const l = fakeLauncher('exit');
    const r = await probeStdioMcp({ command: l.command, args: l.args });
    expect(r).toMatchObject({ ok: false, stage: 'initialize', reason: 'exit' });
    if (r.ok) return;
    expect(r.stderr.join('\n')).toContain('no se encontró el módulo');
  });

  it('la herramienta de comprobación falla: etapa call, motivo tool_error, con su texto', async () => {
    const l = fakeLauncher('no-browser');
    const r = await probeStdioMcp({ command: l.command, args: l.args, call: { name: 'list_pages' } });
    expect(r).toMatchObject({ ok: false, stage: 'call', reason: 'tool_error', tools: realTools });
    if (r.ok) return;
    expect(r.message).toContain('chrome://inspect/#remote-debugging');
  });

  it('comando inexistente: falla sin esperar', async () => {
    const t0 = Date.now();
    const r = await probeStdioMcp({ command: join(await tempDir(), 'no-existe.exe'), args: [] });
    expect(r).toMatchObject({ ok: false, reason: 'error' });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
