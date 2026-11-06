/**
 * datos-05: si falla la escritura de `Contexto.md` o de la nota del agente, un segundo `recordSession` con la misma
 * sesión completa lo que faltó, sin duplicar líneas ni totales.
 * Ver inssues/datos-05-memoria-registro-sesion-a-medias.md.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNote } from '../../../src/core/memory/frontmatter.ts';
import { ObsidianMemory } from '../../../src/core/memory/index.ts';
import type { SessionSummary } from '../../../src/shared/index.ts';

const failing = vi.hoisted(() => ({ suffix: '' }));
vi.mock('../../../src/core/memory/safe-fs.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/memory/safe-fs.ts')>();
  return {
    ...orig,
    writeFileAtomic: vi.fn(async (root: string, target: string, content: string | Uint8Array) => {
      if (failing.suffix && target.replace(/\\/g, '/').endsWith(failing.suffix)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${target}'`), { code: 'EPERM' });
      }
      return orig.writeFileAtomic(root, target, content);
    }),
  };
});

let vault: string;
beforeEach(async () => {
  failing.suffix = '';
  vault = await mkdtemp(join(tmpdir(), 'orq-registro-parcial-'));
});
afterEach(async () => { await rm(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

const s: SessionSummary = {
  projectId: 'demo', taskId: 'parser', agentId: 'codex', title: 'Parser de demo', outcome: 'ok',
  summary: 'Parser listo.', filesChanged: ['src/parser.ts'], inputTokens: 120, outputTokens: 30, costUsd: 0.5,
  at: '2026-11-05T10:00:00.000Z',
};
const NOTE = 'Orquestador/Sesiones/2026-11-05-parser';
const read = (rel: string) => readFile(join(vault, ...rel.split('/')), 'utf8');
const logLines = (text: string) => text.split('\n').filter((l) => l.startsWith('- ') && l.includes(`[[${NOTE}|`));

async function expectComplete(): Promise<void> {
  const project = await read('Orquestador/Proyectos/demo/Contexto.md');
  expect(parseNote(project).data.sesiones).toBe(1);
  expect(logLines(project)).toHaveLength(1);
  const agent = await read('Orquestador/Agentes/codex.md');
  const data = parseNote(agent).data;
  expect(data.sesiones).toBe(1);
  expect(data.tokens_entrada).toBe(s.inputTokens);
  expect(data.tokens_salida).toBe(s.outputTokens);
  expect(data.costo_usd).toBe(0.5);
  expect(logLines(agent)).toHaveLength(1);
  expect(await readdir(join(vault, 'Orquestador', 'Sesiones'))).toEqual(['2026-11-05-parser.md']);
}

describe('datos-05: recordSession completa una sesión registrada a medias', () => {
  it('A: falla Contexto.md; el reintento agrega la bitácora y los totales del agente', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    failing.suffix = 'Proyectos/demo/Contexto.md';
    await expect(memory.recordSession(s)).rejects.toThrow(/EPERM/);
    await read(`${NOTE}.md`);
    await expect(read('Orquestador/Agentes/codex.md')).rejects.toThrow(/ENOENT/);
    failing.suffix = '';
    await memory.recordSession(s);
    await expectComplete();
  });

  it('B: falla la nota del agente; el reintento suma los totales sin duplicar la bitácora', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    failing.suffix = 'Agentes/codex.md';
    await expect(memory.recordSession(s)).rejects.toThrow(/EPERM/);
    expect(logLines(await read('Orquestador/Proyectos/demo/Contexto.md'))).toHaveLength(1);
    failing.suffix = '';
    await memory.recordSession(s);
    await expectComplete();
  });

  it('C: tres registros seguidos sin fallos dejan una sola línea en cada nota', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    for (let i = 0; i < 3; i++) await memory.recordSession(s);
    await expectComplete();
  });
});
