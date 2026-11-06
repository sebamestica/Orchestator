import { describe, expect, it } from 'vitest';
import { createConductorTools, type DelegateResult } from '../../../src/core/conductor/index.ts';
import { FakeFleet, NOW, SESSION_SECRET, fakePorts, jsonOf, textOf } from '../conductor/fakes.ts';

/** Flota falsa con `retry` (como `FleetRuntime`): reintenta solo lo que está `failed` o, sin cola, lo que diga `stored`. */
class RetryingFleet extends FakeFleet {
  readonly retried: string[] = [];
  /** Estado guardado en la base de las tareas que la cola ya no tiene (después de un reinicio). */
  readonly stored = new Map<string, string>();
  async retry(taskId: string): Promise<DelegateResult> {
    const state = this.statuses.get(taskId)?.state ?? this.stored.get(taskId);
    if (state !== 'failed') return { accepted: false, reason: `La tarea ${taskId} está en estado ${state ?? '?'}: solo se reintenta una tarea fallida` };
    this.retried.push(taskId);
    this.statuses.set(taskId, { taskId, state: 'ready', agentId: 'claude-worker', updatedAt: NOW.toISOString() });
    return { accepted: true, state: 'ready', agentId: 'claude-worker', detail: 'reintentada en la cola de la flota' };
  }
}

async function delegated(fleet: FakeFleet) {
  const ports = fakePorts({ fleet });
  const tools = createConductorTools(ports, { defaultProjectId: 'demo', now: () => NOW, secrets: [SESSION_SECRET] });
  await tools.call('crear_tareas', { plan: 'plan' });
  ports.proposals.approve(['api']);
  expect((await tools.call('delegar', { taskId: 'api' })).isError).toBeFalsy();
  return { ports, tools };
}

describe('delegar sobre una tarea ya delegada', () => {
  it('si falló, la reintenta y responde con el motivo anterior', async () => {
    const fleet = new RetryingFleet();
    const { tools } = await delegated(fleet);
    fleet.advance('api', 'failed', 'api: sin éxito tras 4 intentos (último: timeout)');

    const result = await tools.call('delegar', { taskId: 'api' });
    expect(result.isError).toBeFalsy();
    expect(jsonOf(result)).toMatchObject({
      tarea: 'api',
      reintento: true,
      motivoAnterior: 'api: sin éxito tras 4 intentos (último: timeout)',
      estado: 'ready',
      agente: 'claude-worker',
    });
    expect(fleet.retried).toEqual(['api']);
    expect(fleet.delegated).toHaveLength(1);
  });

  it('tras reiniciar el núcleo (la cola ya no la tiene), también la reintenta si en la base figura fallida', async () => {
    const fleet = new RetryingFleet();
    const { tools } = await delegated(fleet);
    fleet.statuses.delete('api');
    fleet.stored.set('api', 'failed');
    const result = await tools.call('delegar', { taskId: 'api' });
    expect(result.isError).toBeFalsy();
    expect(jsonOf(result)).toMatchObject({ tarea: 'api', reintento: true, motivoAnterior: null });
    expect(fleet.retried).toEqual(['api']);
  });

  it('si sigue en curso, no la reintenta y lo dice con su estado', async () => {
    const fleet = new RetryingFleet();
    const { tools } = await delegated(fleet);
    fleet.advance('api', 'running');
    const result = await tools.call('delegar', { taskId: 'api' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/ya fue delegada \(estado: running\); consulta su avance con estado/);
    expect(fleet.retried).toEqual([]);
  });

  it('si la flota no puede reintentarla, el error trae su motivo', async () => {
    const fleet = new RetryingFleet();
    const { tools } = await delegated(fleet);
    fleet.advance('api', 'failed', 'falló');
    fleet.retry = async () => ({ accepted: false, reason: 'La tarea api depende de base (failed), que no está integrada ni en la flota' });
    const result = await tools.call('delegar', { taskId: 'api' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/falló y la flota no pudo reintentarla: La tarea api depende de base/);
  });

  it('si la flota niega el reintento a la mente (tope de gasto), delegar devuelve ese motivo y no reintenta', async () => {
    const fleet = new RetryingFleet();
    const { tools } = await delegated(fleet);
    fleet.advance('api', 'failed', 'tope de gasto de la tarea superado: 8.10 de 8 USD (dificultad high)');
    fleet.retry = async () => ({ accepted: false, reason: 'La tarea api se detuvo por su tope de gasto: solo el usuario puede reintentarla desde el tablero («Reintentar»).' });
    const result = await tools.call('delegar', { taskId: 'api' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no pudo reintentarla: La tarea api se detuvo por su tope de gasto: solo el usuario puede reintentarla/);
    expect(fleet.retried).toEqual([]);
  });

  it('una flota sin retry (puerto antiguo) sigue respondiendo «ya fue delegada»', async () => {
    const fleet = new FakeFleet();
    const { tools } = await delegated(fleet);
    fleet.advance('api', 'failed', 'falló');
    const result = await tools.call('delegar', { taskId: 'api' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/ya fue delegada \(estado: failed; falló\)/);
  });
});

describe('estado devuelve el motivo', () => {
  it('con la tarea fallida: detalle y cómo reintentarla', async () => {
    const fleet = new RetryingFleet();
    const { tools } = await delegated(fleet);
    expect(jsonOf(await tools.call('estado', { taskId: 'api' }))).toMatchObject({ estado: 'pending', detalle: null });
    fleet.advance('api', 'failed', 'interrumpida al reiniciar el núcleo');
    const body = jsonOf(await tools.call('estado', { taskId: 'api' }));
    expect(body).toMatchObject({ estado: 'failed', detalle: 'interrumpida al reiniciar el núcleo', siguientePaso: expect.stringMatching(/delegar/) });
  });

  it('con la tarea detenida por su tope de gasto: el siguiente paso es pedírselo al usuario, no delegar', async () => {
    const fleet = new RetryingFleet();
    const { tools } = await delegated(fleet);
    fleet.advance('api', 'failed', 'tope de gasto de la tarea superado: 1.02 de 1 USD (dificultad low)');
    const current = fleet.statuses.get('api');
    if (current) fleet.statuses.set('api', { ...current, budgetStop: true });
    const body = jsonOf(await tools.call('estado', { taskId: 'api' })) as { siguientePaso?: string };
    expect(body.siguientePaso).toMatch(/pídele al usuario que la reintente desde el tablero/);
    expect(body.siguientePaso).not.toMatch(/usa delegar/);
  });
});
