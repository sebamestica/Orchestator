import { describe, expect, it } from 'vitest';
import { DEFAULT_CONCURRENCY, QueueError, TaskQueue, type TaskStateChange } from '../../../src/core/orchestrator/queue.ts';
import { task } from './fakes.ts';

function finish(queue: TaskQueue, id: string): void {
  queue.transition(id, 'review');
  queue.transition(id, 'integrated');
}

describe('TaskQueue', () => {
  it('libera las tareas en orden de dependencias: solo cuando todas están integradas', () => {
    const queue = new TaskQueue();
    queue.addAll([task('qc', { dependsOn: ['qa', 'qb'] }), task('qa'), task('qb', { dependsOn: ['qa'] })]);
    expect(queue.state('qa')).toBe('ready');
    expect(queue.state('qb')).toBe('pending');
    expect(queue.state('qc')).toBe('pending');

    expect(queue.next()?.id).toBe('qa');
    expect(queue.next()).toBeUndefined(); // b y c esperan a a
    queue.transition('qa', 'review');
    expect(queue.state('qb')).toBe('pending'); // en revisión no basta: debe estar integrada
    queue.transition('qa', 'integrated');
    expect(queue.state('qb')).toBe('ready');
    expect(queue.state('qc')).toBe('pending'); // le falta b

    expect(queue.next()?.id).toBe('qb');
    finish(queue, 'qb');
    expect(queue.next()?.id).toBe('qc');
  });

  it('limita la concurrencia (3 por defecto) contando running, handed_off y review', () => {
    const queue = new TaskQueue();
    expect(queue.concurrency).toBe(DEFAULT_CONCURRENCY);
    expect(DEFAULT_CONCURRENCY).toBe(3);
    queue.addAll(['t1', 't2', 't3', 't4', 't5'].map((id) => task(id)));
    const taken = [queue.next(), queue.next(), queue.next(), queue.next()].map((x) => x?.id);
    expect(taken).toEqual(['t1', 't2', 't3', undefined]);
    expect(queue.active).toBe(3);

    queue.transition('t1', 'handed_off');
    queue.transition('t2', 'review');
    expect(queue.next()).toBeUndefined(); // siguen ocupando cupo

    queue.transition('t3', 'failed'); // una fallida libera su lugar
    expect(queue.next()?.id).toBe('t4');
    queue.transition('t2', 'integrated');
    expect(queue.next()?.id).toBe('t5');
    expect(queue.next()).toBeUndefined();
  });

  it('permite ajustar la concurrencia y rechaza valores inválidos', () => {
    const queue = new TaskQueue({ concurrency: 1 });
    queue.addAll([task('qa'), task('qb')]);
    expect(queue.next()?.id).toBe('qa');
    expect(queue.next()).toBeUndefined();
    queue.concurrency = 2;
    expect(queue.next()?.id).toBe('qb');
    expect(() => { queue.concurrency = 0; }).toThrow(QueueError);
    expect(() => new TaskQueue({ concurrency: 1.5 })).toThrow(QueueError);
  });

  it('emite un evento por cada cambio de estado, con agente y detalle', () => {
    const now = new Date('2026-11-01T12:00:00.000Z');
    const queue = new TaskQueue({ now: () => now });
    const changes: TaskStateChange[] = [];
    const off = queue.on((c) => changes.push(c));
    queue.addAll([task('qa'), task('qb', { dependsOn: ['qa'] })]);
    queue.next();
    queue.transition('qa', 'handed_off', { agentId: 'codex', detail: 'quota_exhausted' });
    queue.transition('qa', 'running', { agentId: 'claude-1' });
    finish(queue, 'qa');
    off();
    queue.next();

    expect(changes.map((c) => `${c.taskId}:${c.from ?? '∅'}→${c.to}`)).toEqual([
      'qa:∅→pending',
      'qb:∅→pending',
      'qa:pending→ready',
      'qa:ready→running',
      'qa:running→handed_off',
      'qa:handed_off→running',
      'qa:running→review',
      'qa:review→integrated',
      'qb:pending→ready',
    ]);
    expect(changes[4]).toMatchObject({ agentId: 'codex', detail: 'quota_exhausted', at: '2026-11-01T12:00:00.000Z' });
    expect(changes[6]).toMatchObject({ agentId: 'claude-1' }); // conserva el último agente
    expect(queue.get('qa')?.agentId).toBe('claude-1');
  });

  it('un oyente que lanza no rompe la cola', () => {
    const queue = new TaskQueue();
    const seen: string[] = [];
    const original = console.error;
    console.error = () => undefined;
    try {
      queue.on(() => { throw new Error('oyente roto'); });
      queue.on((c) => seen.push(c.to));
      queue.add(task('qa'));
    } finally {
      console.error = original;
    }
    expect(seen).toEqual(['pending', 'ready']);
  });

  it('rechaza dependencias desconocidas, ciclos e ids repetidos sin agregar nada', () => {
    const queue = new TaskQueue();
    expect(() => queue.addAll([task('qa', { dependsOn: ['zz'] })])).toThrow(/zz/);
    expect(() => queue.addAll([task('qa', { dependsOn: ['qb'] }), task('qb', { dependsOn: ['qa'] })])).toThrow(/Ciclo/);
    expect(queue.list()).toEqual([]);
    queue.add(task('qa'));
    expect(() => queue.add(task('qa'))).toThrow(/ya está/);
    queue.add(task('qb', { dependsOn: ['qa'] })); // depende de una tarea ya encolada
    expect(queue.state('qb')).toBe('pending');
  });

  it('valida las transiciones', () => {
    const queue = new TaskQueue();
    queue.add(task('qa'));
    expect(() => queue.transition('qa', 'integrated')).toThrow(/ready → integrated/);
    expect(queue.canTransition('qa', 'running')).toBe(true);
    expect(queue.canTransition('qa', 'review')).toBe(false);
    expect(queue.canTransition('zz', 'running')).toBe(false);
    expect(() => queue.state('zz')).toThrow(QueueError);
  });

  it('cancela en cascada las dependientes que no han empezado', () => {
    const queue = new TaskQueue();
    queue.addAll([task('qa'), task('qb', { dependsOn: ['qa'] }), task('qc', { dependsOn: ['qb'] }), task('qd')]);
    queue.next();
    expect(queue.cancel('qa', 'el usuario la canceló')).toBe(true);
    expect(['qa', 'qb', 'qc', 'qd'].map((id) => queue.state(id))).toEqual(['cancelled', 'cancelled', 'cancelled', 'ready']);
    expect(queue.cancel('qa')).toBe(false); // ya terminada
  });

  it('una tarea agregada después de cancelar su requisito se cancela al agregarla (hallazgo 6 de Codex)', () => {
    const queue = new TaskQueue();
    const changes: TaskStateChange[] = [];
    queue.add(task('base'));
    queue.cancel('base');
    queue.on((c) => changes.push(c));
    queue.addAll([task('nieta', { dependsOn: ['hija'] }), task('hija', { dependsOn: ['base'] }), task('libre')]);
    expect(queue.state('hija')).toBe('cancelled');
    expect(queue.state('nieta')).toBe('cancelled');
    expect(queue.state('libre')).toBe('ready');
    expect(changes.filter((c) => c.to === 'cancelled').map((c) => [c.taskId, c.detail])).toEqual([
      ['hija', 'dependencia base cancelada'],
      ['nieta', 'dependencia hija cancelada'],
    ]);
    expect(queue.list().filter((e) => e.state === 'pending')).toEqual([]);
  });

  it('reintenta una tarea fallida e informa si está ociosa', () => {
    const queue = new TaskQueue();
    queue.addAll([task('qa'), task('qb', { dependsOn: ['qa'] })]);
    expect(queue.isIdle()).toBe(false);
    queue.next();
    queue.transition('qa', 'failed');
    expect(queue.isIdle()).toBe(true); // b queda bloqueada
    queue.retry('qa');
    expect(queue.next()?.id).toBe('qa');
    finish(queue, 'qa');
    expect(queue.state('qb')).toBe('ready');
  });
});
