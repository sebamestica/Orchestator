/**
 * Issue 9: lo que la mente ve con sus herramientas queda acotado al proyecto de la sesión. Casos sacados de los datos
 * reales (docs/plan/issues/09-aislamiento-contexto.md): `estado` mostraba la cola de todos los proyectos, el
 * planificador recibía ids de otros proyectos y la memoria se leía y escribía en cualquier proyecto.
 */
import { describe, expect, it } from 'vitest';
import { MEMORY_BUDGET_CHARS, createConductorTools } from '../../../src/core/conductor/index.ts';
import { FakePlanner, NOW, SESSION_SECRET, brief, fakePorts, jsonOf, textOf } from './fakes.ts';
import type { FakePorts } from './fakes.ts';

/** Sesión del proyecto `orquestador` con la cola compartida que tenía el núcleo el 2026-11-05 a las 01:21. */
function setup(overrides: Partial<FakePorts> = {}) {
  const ports = fakePorts({
    planner: new FakePlanner({ ok: true, tasks: [brief('paquete-zip', { projectId: 'orquestador' })] }),
    ...overrides,
  });
  const fleet = ports.fleet.statuses;
  fleet.set('ayuda-ia', { taskId: 'ayuda-ia', projectId: 'orquestador', state: 'running', agentId: 'claude' });
  fleet.set('rutas-portables', { taskId: 'rutas-portables', projectId: 'orquestador', state: 'review', agentId: 'codex' });
  fleet.set('contexto-github', { taskId: 'contexto-github', projectId: 'professional', state: 'failed', agentId: 'claude', detail: 'Chrome ocupado' });
  fleet.set('analisis-mercado-instagram', { taskId: 'analisis-mercado-instagram', projectId: 'marketing', state: 'failed' });
  // Un puerto que no informa el proyecto: la tarea puede ser de cualquiera.
  fleet.set('sin-proyecto', { taskId: 'sin-proyecto', state: 'running' });
  const tools = createConductorTools(ports, { defaultProjectId: 'orquestador', now: () => NOW, secrets: [SESSION_SECRET] });
  return { ports, tools };
}

describe('estado: solo las tareas del proyecto de la sesión', () => {
  it('sin taskId no lista tareas de otros proyectos ni de proyecto desconocido', async () => {
    const { tools } = setup();
    const body = jsonOf(await tools.call('estado', {}));
    expect(body).toMatchObject({ proyecto: 'orquestador', total: 2 });
    expect((body.tareas as { id: string }[]).map((t) => t.id)).toEqual(['ayuda-ia', 'rutas-portables']);
    const text = JSON.stringify(body);
    for (const foreign of ['contexto-github', 'analisis-mercado-instagram', 'sin-proyecto', 'Chrome ocupado']) expect(text).not.toContain(foreign);
  });

  it('incluye las propuestas del chat y las tareas que la flota ya tiene de ellas, aunque el puerto no informe el proyecto', async () => {
    const { tools, ports } = setup();
    await tools.call('crear_tareas', { plan: 'Empaquetar Berland' });
    ports.fleet.statuses.set('paquete-zip', { taskId: 'paquete-zip', state: 'running', agentId: 'agy' });
    const body = jsonOf(await tools.call('estado', {}));
    expect((body.tareas as { id: string }[]).map((t) => t.id)).toEqual(['ayuda-ia', 'paquete-zip', 'rutas-portables']);
    expect(jsonOf(await tools.call('estado', { taskId: 'paquete-zip' }))).toMatchObject({ tarea: 'paquete-zip', proyecto: 'orquestador', estado: 'running' });
  });

  it('con el taskId de otro proyecto responde que no es de este proyecto, sin su estado ni su motivo', async () => {
    const { tools } = setup();
    for (const taskId of ['contexto-github', 'analisis-mercado-instagram', 'sin-proyecto']) {
      const result = await tools.call('estado', { taskId });
      expect(result.isError, taskId).toBe(true);
      expect(textOf(result)).toMatch(new RegExp(`la tarea ${taskId} no es de este proyecto \\(orquestador\\)`));
      expect(textOf(result)).not.toMatch(/failed|running|Chrome ocupado|claude/);
    }
    expect(jsonOf(await tools.call('estado', { taskId: 'rutas-portables' }))).toMatchObject({ tarea: 'rutas-portables', proyecto: 'orquestador', estado: 'review', agente: 'codex' });
    expect(textOf(await tools.call('estado', { taskId: 'fantasma' }))).toMatch(/no existe la tarea fantasma/);
  });

  it('una propuesta del chat para otro proyecto tampoco se informa', async () => {
    const { tools, ports } = setup();
    ports.proposals.propose([brief('ajena', { projectId: 'marketing' })]);
    expect(textOf(await tools.call('estado', { taskId: 'ajena' }))).toMatch(/no es de este proyecto/);
    expect(JSON.stringify(jsonOf(await tools.call('estado', {})))).not.toContain('ajena');
  });

  it('sin proyecto de sesión (terminal antigua, pruebas) sigue mostrando toda la flota', async () => {
    const ports = fakePorts();
    ports.fleet.statuses.set('x1', { taskId: 'x1', projectId: 'a', state: 'running' });
    ports.fleet.statuses.set('x2', { taskId: 'x2', projectId: 'b', state: 'running' });
    const tools = createConductorTools(ports, { now: () => NOW });
    expect(jsonOf(await tools.call('estado', {}))).toMatchObject({ total: 2 });
  });
});

describe('crear_tareas: el planificador no ve ids de otros proyectos', () => {
  it('knownTaskIds trae solo las tareas del proyecto del plan', async () => {
    const { tools, ports } = setup();
    const result = await tools.call('crear_tareas', { plan: 'Empaquetar Berland' });
    expect(result.isError).toBeFalsy();
    expect(ports.planner.requests[0]).toMatchObject({ projectId: 'orquestador', knownTaskIds: ['ayuda-ia', 'rutas-portables'] });
  });
});

describe('leer_memoria: la del proyecto de la sesión', () => {
  it('sin proyecto lee la de la sesión (el investigador no tiene que adivinar el id)', async () => {
    const { tools, ports } = setup();
    ports.memory.context = '### Resumen del proyecto orquestador\nBerland.';
    const text = textOf(await tools.call('leer_memoria', {}));
    expect(text).toBe(`Memoria de orquestador (máx. ${MEMORY_BUDGET_CHARS} caracteres):\n### Resumen del proyecto orquestador\nBerland.`);
    expect(ports.memory.contexts.map((c) => c.projectId)).toEqual(['orquestador']);
    expect(ports.memory.contexts[0]?.task.projectId).toBe('orquestador');
  });

  it('la de otro proyecto solo con proyecto explícito, y marcada como de OTRO proyecto', async () => {
    const { tools, ports } = setup();
    ports.memory.context = '### Resumen del proyecto marketing\nVideo 03.';
    const text = textOf(await tools.call('leer_memoria', { proyecto: 'marketing' }));
    expect(text).toMatch(/^Memoria de OTRO proyecto \(marketing\), no de este \(orquestador\)/);
    expect(ports.memory.contexts.map((c) => c.projectId)).toEqual(['marketing']);
  });

  it('una tarea del chat no sirve para leer la memoria de otro proyecto', async () => {
    const { tools, ports } = setup();
    await tools.call('crear_tareas', { plan: 'Empaquetar Berland' });
    const result = await tools.call('leer_memoria', { proyecto: 'marketing', tarea: 'paquete-zip' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/es del proyecto orquestador, no de marketing/);
    expect(ports.memory.contexts).toEqual([]);
  });

  it('sin proyecto de sesión pide el proyecto', async () => {
    const tools = createConductorTools(fakePorts(), { now: () => NOW });
    expect(textOf(await tools.call('leer_memoria', {}))).toMatch(/falta el proyecto/);
  });
});

describe('escribir_memoria: solo en la del proyecto de la sesión', () => {
  it('sin proyecto escribe en la de la sesión', async () => {
    const { tools, ports } = setup();
    expect(jsonOf(await tools.call('escribir_memoria', { nota: { tipo: 'resumen', texto: 'F5 en curso.' } }))).toEqual({ ok: true, tipo: 'resumen', proyecto: 'orquestador' });
    const decision = jsonOf(await tools.call('escribir_memoria', { proyecto: 'orquestador', nota: { tipo: 'decision', titulo: 'Zip', texto: 'Solo Windows.' } }));
    expect(decision).toMatchObject({ ok: true, tipo: 'decision', proyecto: 'orquestador' });
    expect(ports.memory.summaries.map((s) => s.projectId)).toEqual(['orquestador']);
    expect(ports.memory.decisions.map((d) => d.projectId)).toEqual(['orquestador']);
  });

  it('en otro proyecto falla y no escribe nada', async () => {
    const { tools, ports } = setup();
    const summary = await tools.call('escribir_memoria', { proyecto: 'marketing', nota: { tipo: 'resumen', texto: 'Pisado desde orquestador' } });
    const decision = await tools.call('escribir_memoria', { proyecto: 'professional', nota: { tipo: 'decision', titulo: 'x', texto: 'y' } });
    for (const result of [summary, decision]) {
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/solo puedes escribir en la memoria de este proyecto \(orquestador\)/);
    }
    expect(ports.memory.summaries).toEqual([]);
    expect(ports.memory.decisions).toEqual([]);
  });
});
