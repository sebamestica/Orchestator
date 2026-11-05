/**
 * Issue 9 en el servicio del chat: dos chats de proyectos distintos sobre la misma flota. La mente de uno no ve las
 * tareas del otro ni reanuda su sesión del SDK. Ver docs/plan/issues/09-aislamiento-contexto.md.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { brief, jsonOf, textOf } from '../conductor/fakes.ts';
import { bench, closeBenches, type ChatBench } from './helpers.ts';

afterEach(closeBenches);

async function withOtherProject(b: ChatBench): Promise<string> {
  const repo = join(b.dir, 'otro');
  await mkdir(repo, { recursive: true });
  b.store.putProject({ id: 'otro', name: 'Otro', repoPath: repo });
  return repo;
}

async function turn(b: ChatBench, chatId: string, text: string): Promise<void> {
  await b.service.send(chatId, { text });
  await b.settle(chatId);
}

describe('ChatService: cada proyecto con lo suyo', () => {
  it('la mente de demo no ve en estado ni en el planificador las tareas que otro chat entregó para otro proyecto', async () => {
    const b = await bench();
    await withOtherProject(b);
    const demo = b.service.create({ projectId: 'demo' });
    const otro = b.service.create({ projectId: 'otro' });
    await turn(b, demo.id, 'hola');
    await turn(b, otro.id, 'hola');

    b.ports.planner.result = { ok: true, tasks: [brief('tarea-otro', { projectId: 'otro' })] };
    expect((await b.service.sessionOf(otro.id)?.tools.call('crear_tareas', { plan: 'plan de otro' }))?.isError).toBeFalsy();
    expect((await b.service.approve(otro.id, ['tarea-otro'])).delivered).toEqual(['tarea-otro']);
    expect(b.ports.fleet.status('tarea-otro')).toMatchObject({ projectId: 'otro' });

    const mind = b.service.sessionOf(demo.id);
    if (!mind) throw new Error('sin sesión de demo');
    const summary = jsonOf(await mind.tools.call('estado', {}));
    expect(summary).toMatchObject({ proyecto: 'demo', total: 0 });
    const asked = await mind.tools.call('estado', { taskId: 'tarea-otro' });
    expect(asked.isError).toBe(true);
    expect(textOf(asked)).toMatch(/no es de este proyecto \(demo\)/);

    b.ports.planner.result = { ok: true, tasks: [brief('tarea-demo')] };
    await mind.tools.call('crear_tareas', { plan: 'plan de demo' });
    expect(b.ports.planner.requests.at(-1)).toMatchObject({ projectId: 'demo' });
    expect(b.ports.planner.requests.at(-1)?.knownTaskIds).not.toContain('tarea-otro');
    // El chat de otro sí la ve.
    const other = b.service.sessionOf(otro.id);
    if (!other) throw new Error('sin sesión de otro');
    expect(jsonOf(await other.tools.call('estado', {}))).toMatchObject({ proyecto: 'otro', total: 1 });
  });

  it('cada chat reanuda solo su propia sesión del SDK', async () => {
    const b = await bench();
    const repoOtro = await withOtherProject(b);
    const demo = b.service.create({ projectId: 'demo' });
    const otro = b.service.create({ projectId: 'otro' });
    const second = b.service.create({ projectId: 'demo' });
    for (const chat of [demo, otro, second]) await turn(b, chat.id, 'primero');
    for (const chat of [demo, otro, second]) b.service.close(chat.id);
    for (const chat of [second, otro, demo]) await turn(b, chat.id, 'segundo');

    // echoTurn: sin resume, la sesión del SDK es `sdk-<n.º de proceso>` (1, 2 y 3 en el orden del primer turno).
    const byCwd = (cwd: string) => b.q.calls.filter((c) => c.options.cwd === cwd).map((c) => c.options.resume ?? null);
    expect(byCwd(repoOtro)).toEqual([null, 'sdk-2']);
    expect(byCwd(b.repo)).toEqual([null, null, 'sdk-3', 'sdk-1']);
    expect(b.service.get(demo.id).state).toBe('idle');
  });
});
