/** `settleChat`: la espera del fin del turno se mide en tiempo y avisa al vencer, en vez de seguir con el chat en `running`. */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Chat } from '../../../src/shared/index.ts';
import { settleChat } from './helpers.ts';

const fake = (states: Chat['state'][]) => {
  let i = 0;
  return { get: () => ({ state: states[Math.min(i++, states.length - 1)] }) as Chat };
};

describe('settleChat', () => {
  it('rechaza nombrando el chat si sigue running al vencer el plazo', async () => {
    await expect(settleChat(fake(['running']), 'c1', 50)).rejects.toThrow(/c1.*running/);
  });

  it('resuelve cuando el chat sale de running', async () => {
    await expect(settleChat(fake(['running', 'running', 'running', 'idle']), 'c1', 5_000)).resolves.toBeUndefined();
  });

  it('ninguna prueba del chat espera el turno con un bucle de vueltas sin aviso', async () => {
    const dir = import.meta.dirname;
    const files = (await readdir(dir)).filter((f) => f.endsWith('.test.ts'));
    const loop = /for \(let i = 0; i < \d+ && [^;]*state === 'running'/;
    const offenders: string[] = [];
    for (const f of files) if (loop.test(await readFile(join(dir, f), 'utf8'))) offenders.push(f);
    expect(offenders).toEqual([]);
  });
});
