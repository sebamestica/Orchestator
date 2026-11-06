import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONDUCTOR_SERVER_NAME,
  CONDUCTOR_TOOL_NAMES,
  MAX_DECISION_CHARS,
  MAX_OUTPUT_CHARS,
  MAX_PLAN_CHARS,
  MAX_SKILLS,
  MEMORY_BUDGET_CHARS,
  createConductorTools,
  mcpToolName,
} from '../../../src/core/conductor/index.ts';
import type { ConductorToolName } from '../../../src/core/conductor/index.ts';
import { minRemainingFraction, REDACTED } from '../../../src/shared/index.ts';
import {
  FAKE_API_KEY,
  FAKE_OPENAI_KEY,
  FakeFleet,
  FakePlanner,
  NOW,
  SECRET_PATTERN,
  SESSION_SECRET,
  brief,
  fakePorts,
  fixtureQuotas,
  jsonOf,
  textOf,
} from './fakes.ts';
import type { FakePorts } from './fakes.ts';

function setup(overrides: Partial<FakePorts> = {}, opts: Parameters<typeof createConductorTools>[1] = {}) {
  const ports = fakePorts(overrides);
  const tools = createConductorTools(ports, { defaultProjectId: 'demo', now: () => NOW, secrets: [SESSION_SECRET], ...opts });
  return { ports, tools };
}

async function expectInvalid(tools: ReturnType<typeof setup>['tools'], name: ConductorToolName, args: unknown) {
  const result = await tools.call(name, args);
  expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
  expect(textOf(result)).toMatch(/entrada inválida/);
}

describe('servidor MCP del orquestador', () => {
  it('es un servidor en proceso con las siete herramientas en orden fijo', () => {
    const { tools } = setup();
    expect(tools.server.type).toBe('sdk');
    expect(tools.server.name).toBe(CONDUCTOR_SERVER_NAME);
    expect(tools.server.instance).toBeDefined();
    expect(CONDUCTOR_TOOL_NAMES).toEqual(['crear_tareas', 'delegar', 'estado', 'cupos', 'leer_memoria', 'escribir_memoria', 'buscar_skills']);
    expect(tools.allowedTools).toEqual(CONDUCTOR_TOOL_NAMES.map((n) => `mcp__orquestador__${n}`));
    expect(mcpToolName('cupos')).toBe('mcp__orquestador__cupos');
  });

  it('rechaza una herramienta desconocida y entradas que no son objetos', async () => {
    const { tools } = setup();
    const unknown = await tools.call('nada' as ConductorToolName, {});
    expect(unknown.isError).toBe(true);
    await expectInvalid(tools, 'estado', 'texto');
    await expectInvalid(tools, 'cupos', [1, 2]);
  });
});

describe('crear_tareas', () => {
  it('deja las tareas propuestas (pendientes de aprobación) y devuelve la lista resumida', async () => {
    const { tools, ports } = setup();
    ports.fleet.statuses.set('previa', { taskId: 'previa', projectId: 'demo', state: 'integrated' });
    const result = await tools.call('crear_tareas', { plan: 'Agregar la API y luego la interfaz' });
    expect(result.isError).toBeFalsy();
    const body = jsonOf(result);
    expect(body).toMatchObject({ estado: 'propuestas', proyecto: 'demo', pendientesDeAprobacion: 2 });
    expect(body.tareas).toEqual([
      { id: 'api', titulo: 'Tarea api', dificultad: 'medium', agenteSugerido: null, dependeDe: [], rutas: ['src/api/**'], criterios: 1 },
      { id: 'ui', titulo: 'Tarea ui', dificultad: 'medium', agenteSugerido: 'codex', dependeDe: ['api'], rutas: ['src/ui/**'], criterios: 1 },
    ]);
    expect(String(body.siguientePaso)).toMatch(/aprobación/);
    expect(ports.proposals.list().map((e) => [e.task.id, e.approval])).toEqual([['api', 'proposed'], ['ui', 'proposed']]);
    expect(ports.planner.requests[0]).toMatchObject({ projectId: 'demo', planText: 'Agregar la API y luego la interfaz', knownTaskIds: ['previa'] });
  });

  it('tacha secretos del plan antes de mandarlo al planificador', async () => {
    const planner = new FakePlanner({ ok: true, tasks: [brief('x1', { projectId: 'demo' })] });
    const { tools } = setup({ planner });
    const result = await tools.call('crear_tareas', { plan: `Usa la clave ${FAKE_API_KEY} y ${SESSION_SECRET}`, proyecto: 'demo' });
    expect(result.isError).toBeFalsy();
    expect(planner.requests[0]?.projectId).toBe('demo');
    expect(planner.requests[0]?.planText).not.toMatch(SECRET_PATTERN);
    expect(planner.requests[0]?.planText).toContain(REDACTED);
  });

  it('valida la entrada', async () => {
    const { tools } = setup();
    await expectInvalid(tools, 'crear_tareas', {});
    await expectInvalid(tools, 'crear_tareas', { plan: '   ' });
    await expectInvalid(tools, 'crear_tareas', { plan: 'x'.repeat(MAX_PLAN_CHARS + 1) });
    await expectInvalid(tools, 'crear_tareas', { plan: 'ok', proyecto: 'Con Espacios' });
    await expectInvalid(tools, 'crear_tareas', { plan: 'ok', extra: true });
  });

  it('informa los problemas del planificador sin crear propuestas', async () => {
    const planner = new FakePlanner({ ok: false, issues: [{ code: 'overlap', message: `rutas solapadas ${FAKE_API_KEY}`, taskIds: ['a', 'b'] }] });
    const { tools, ports } = setup({ planner });
    const result = await tools.call('crear_tareas', { plan: 'plan' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/overlap/);
    expect(textOf(result)).not.toMatch(SECRET_PATTERN);
    expect(ports.proposals.list()).toEqual([]);
  });

  it('valida con Zod lo que devuelve el planificador (proyecto y esquema)', async () => {
    const foreign = setup({ planner: new FakePlanner({ ok: true, tasks: [brief('a1', { projectId: 'ajeno' })] }) });
    const r1 = await foreign.tools.call('crear_tareas', { plan: 'plan' });
    expect(r1.isError).toBe(true);
    expect(textOf(r1)).toMatch(/otro proyecto: a1/);

    const broken = setup({ planner: new FakePlanner({ ok: true, tasks: [{ ...brief('a2'), ownedPaths: [] }] }) });
    const r2 = await broken.tools.call('crear_tareas', { plan: 'plan' });
    expect(r2.isError).toBe(true);
    expect(broken.ports.proposals.list()).toEqual([]);

    const empty = setup({ planner: new FakePlanner({ ok: true, tasks: [] }) });
    expect((await empty.tools.call('crear_tareas', { plan: 'plan' })).isError).toBe(true);
  });

  it('pide el proyecto si la sesión no tiene uno', async () => {
    const ports = fakePorts();
    const tools = createConductorTools(ports, { now: () => NOW });
    const result = await tools.call('crear_tareas', { plan: 'plan' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/falta el proyecto/);
  });

  it('no pisa una tarea ya aprobada', async () => {
    const { tools, ports } = setup();
    await tools.call('crear_tareas', { plan: 'plan' });
    ports.proposals.approve(['api']);
    const again = await tools.call('crear_tareas', { plan: 'plan' });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toMatch(/ya está aprobada/);
    expect(ports.proposals.get('api')?.approval).toBe('approved');
  });
});

describe('delegar', () => {
  it('rechaza con un error claro las tareas que el usuario no aprobó', async () => {
    const { tools, ports } = setup();
    await tools.call('crear_tareas', { plan: 'plan' });
    const result = await tools.call('delegar', { taskId: 'api' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no está aprobada/);
    expect(textOf(result)).toMatch(/aprobación del usuario/);
    expect(ports.fleet.delegated).toEqual([]);
    expect(ports.proposals.get('api')?.approval).toBe('proposed');
  });

  it('rechaza tareas rechazadas, inexistentes o ya delegadas', async () => {
    const { tools, ports } = setup();
    await tools.call('crear_tareas', { plan: 'plan' });
    ports.proposals.reject(['api']);
    const rejected = await tools.call('delegar', { taskId: 'api' });
    expect(rejected.isError).toBe(true);
    expect(textOf(rejected)).toMatch(/no está aprobada: el usuario la rechazó/);

    const missing = await tools.call('delegar', { taskId: 'no-existe' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/no existe la tarea no-existe/);
    expect(ports.fleet.delegated).toEqual([]);
  });

  it('delega una tarea aprobada una sola vez', async () => {
    const { tools, ports } = setup();
    await tools.call('crear_tareas', { plan: 'plan' });
    ports.proposals.approve(['api']);
    const result = await tools.call('delegar', { taskId: 'api' });
    expect(result.isError).toBeFalsy();
    expect(jsonOf(result)).toEqual({ tarea: 'api', aprobacion: 'delegated', estado: 'pending', agente: 'claude-worker' });
    expect(ports.fleet.delegated.map((t) => t.id)).toEqual(['api']);
    expect(ports.proposals.get('api')).toMatchObject({ approval: 'delegated', delegatedAt: NOW.toISOString() });

    const twice = await tools.call('delegar', { taskId: 'api' });
    expect(twice.isError).toBe(true);
    expect(textOf(twice)).toMatch(/ya fue delegada/);
    expect(ports.fleet.delegated).toHaveLength(1);
  });

  it('exige delegar antes las dependencias', async () => {
    const { tools, ports } = setup();
    await tools.call('crear_tareas', { plan: 'plan' });
    ports.proposals.approve(['api', 'ui']);
    const early = await tools.call('delegar', { taskId: 'ui' });
    expect(early.isError).toBe(true);
    expect(textOf(early)).toMatch(/dependencias: api/);
    expect((await tools.call('delegar', { taskId: 'api' })).isError).toBeFalsy();
    expect((await tools.call('delegar', { taskId: 'ui' })).isError).toBeFalsy();
    expect(ports.fleet.delegated.map((t) => t.id)).toEqual(['api', 'ui']);
  });

  it('si la flota no la acepta, la tarea sigue aprobada para reintentar', async () => {
    const fleet = new FakeFleet();
    fleet.reject = `sin agentes libres ${FAKE_OPENAI_KEY}`;
    const { tools, ports } = setup({ fleet });
    await tools.call('crear_tareas', { plan: 'plan' });
    ports.proposals.approve(['api']);
    const result = await tools.call('delegar', { taskId: 'api' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/la flota no aceptó la tarea api: sin agentes libres/);
    expect(textOf(result)).not.toMatch(SECRET_PATTERN);
    expect(ports.proposals.get('api')?.approval).toBe('approved');
    fleet.reject = undefined;
    expect((await tools.call('delegar', { taskId: 'api' })).isError).toBeFalsy();
  });

  it('dos llamadas en paralelo no delegan dos veces', async () => {
    const { tools, ports } = setup();
    await tools.call('crear_tareas', { plan: 'plan' });
    ports.proposals.approve(['api']);
    const [a, b] = await Promise.all([tools.call('delegar', { taskId: 'api' }), tools.call('delegar', { taskId: 'api' })]);
    expect([a.isError ?? false, b.isError ?? false].sort()).toEqual([false, true]);
    expect(ports.fleet.delegated).toHaveLength(1);
  });

  it('valida la entrada', async () => {
    const { tools } = setup();
    await expectInvalid(tools, 'delegar', {});
    await expectInvalid(tools, 'delegar', { taskId: 'Mayúsculas' });
    await expectInvalid(tools, 'delegar', { taskId: 'a' });
    await expectInvalid(tools, 'delegar', { taskId: 42 });
  });
});

describe('estado', () => {
  it('da el estado de una tarea: aprobación y avance en la flota', async () => {
    const { tools, ports } = setup();
    await tools.call('crear_tareas', { plan: 'plan' });
    expect(jsonOf(await tools.call('estado', { taskId: 'api' }))).toMatchObject({
      tarea: 'api', titulo: 'Tarea api', proyecto: 'demo', aprobacion: 'proposed', estado: null, agente: null,
    });
    ports.proposals.approve(['api']);
    await tools.call('delegar', { taskId: 'api' });
    ports.fleet.advance('api', 'running', `trabajando ${FAKE_API_KEY}`);
    const body = jsonOf(await tools.call('estado', { taskId: 'api' }));
    expect(body).toMatchObject({ tarea: 'api', aprobacion: 'delegated', estado: 'running', agente: 'claude-worker' });
    expect(JSON.stringify(body)).not.toMatch(SECRET_PATTERN);
  });

  it('resume la flota sin taskId', async () => {
    const { tools, ports } = setup();
    await tools.call('crear_tareas', { plan: 'plan' });
    ports.proposals.approve(['api']);
    await tools.call('delegar', { taskId: 'api' });
    ports.fleet.statuses.set('externa', { taskId: 'externa', projectId: 'demo', state: 'review', agentId: 'agy' });
    expect(jsonOf(await tools.call('estado', {}))).toEqual({
      proyecto: 'demo',
      total: 3,
      porAprobacion: { delegated: 1, proposed: 1 },
      porEstado: { pending: 1, review: 1 },
      tareas: [
        { id: 'api', aprobacion: 'delegated', estado: 'pending', agente: 'claude-worker' },
        { id: 'externa', aprobacion: null, estado: 'review', agente: 'agy' },
        { id: 'ui', aprobacion: 'proposed', estado: null, agente: null },
      ],
    });
  });

  it('acota la lista de la flota', async () => {
    const { tools, ports } = setup();
    for (let i = 0; i < 45; i++) ports.fleet.statuses.set(`t-${String(i).padStart(2, '0')}`, { taskId: `t-${String(i).padStart(2, '0')}`, projectId: 'demo', state: 'running' });
    const body = jsonOf(await tools.call('estado', {}));
    expect(body.total).toBe(45);
    expect(body.tareas).toHaveLength(40);
    expect(body.omitidas).toBe(5);
  });

  it('error claro con una tarea desconocida y entrada inválida', async () => {
    const { tools } = setup();
    const result = await tools.call('estado', { taskId: 'fantasma' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no existe la tarea fantasma/);
    await expectInvalid(tools, 'estado', { taskId: '../x' });
    await expectInvalid(tools, 'estado', { tarea: 'api' });
  });
});

describe('cupos', () => {
  it('devuelve la última foto por agente con % restante y reinicio (fixtures reales de agy y Codex)', async () => {
    const snapshots = await fixtureQuotas();
    const { tools, ports } = setup();
    ports.quotas.snapshots = snapshots;
    const body = jsonOf(await tools.call('cupos', {}));
    const agents = body.agentes as { agente: string; restantePct: number | null; reinicio: string | null; ventanas: unknown[]; desactualizado: boolean }[];
    expect(agents.map((a) => a.agente)).toEqual(['agy', 'codex']);
    for (const [i, snap] of snapshots.entries()) {
      const min = minRemainingFraction(snap);
      expect(agents[i]?.restantePct).toBe(min === null ? null : Math.round(min * 1000) / 10);
      expect(agents[i]?.ventanas).toHaveLength(snap.buckets.length);
      expect(agents[i]?.desactualizado).toBe(snap.stale);
    }
    const [agy] = snapshots;
    if (!agy) throw new Error('falta la fixture de agy');
    const agyLimiting = agy.buckets.filter((b) => b.remainingFraction === minRemainingFraction(agy)).map((b) => b.resetAt).sort()[0];
    expect(agents[0]?.reinicio).toBe(agyLimiting);
    expect(agents[0]?.reinicio).toMatch(/^2026-11-/);
  });

  it('avisa si no hay lecturas y tacha errores con secretos', async () => {
    const { tools, ports } = setup();
    expect(jsonOf(await tools.call('cupos', {}))).toEqual({ agentes: [], aviso: 'Todavía no hay lecturas de cupo.' });
    ports.quotas.snapshots = [{ agentId: 'codex', method: 'none', takenAt: NOW.toISOString(), buckets: [], stale: true, error: `401 con ${FAKE_OPENAI_KEY}` }];
    const result = await tools.call('cupos', {});
    expect(textOf(result)).not.toMatch(SECRET_PATTERN);
    expect(jsonOf(result).agentes).toEqual([{ agente: 'codex', restantePct: null, reinicio: null, ventanas: [], leido: NOW.toISOString(), desactualizado: true, error: `401 con ${REDACTED}` }]);
  });

  it('valida la foto que recibe y la entrada', async () => {
    const { tools, ports } = setup();
    ports.quotas.snapshots = [{ agentId: 'agy', method: 'agy-usage', takenAt: 'ayer', buckets: [], stale: false }];
    expect(jsonOf(await tools.call('cupos', {})).agentes).toEqual([{ agente: 'agy', error: 'lectura de cupo inválida' }]);
    await expectInvalid(tools, 'cupos', { agente: 'agy' });
  });
});

describe('leer_memoria', () => {
  it('pide el contexto general con presupuesto fijo', async () => {
    const { tools, ports } = setup();
    ports.memory.context = '### Resumen del proyecto demo\nAPI lista.';
    const result = await tools.call('leer_memoria', { proyecto: 'demo' });
    expect(textOf(result)).toBe(`Memoria de demo (máx. ${MEMORY_BUDGET_CHARS} caracteres):\n### Resumen del proyecto demo\nAPI lista.`);
    expect(ports.memory.contexts).toHaveLength(1);
    expect(ports.memory.contexts[0]).toMatchObject({ projectId: 'demo', budget: MEMORY_BUDGET_CHARS });
    expect(ports.memory.contexts[0]?.task).toMatchObject({ id: 'contexto-general', projectId: 'demo' });
  });

  it('usa el encargo de la tarea propuesta', async () => {
    const { tools, ports } = setup();
    await tools.call('crear_tareas', { plan: 'plan' });
    await tools.call('leer_memoria', { proyecto: 'demo', tarea: 'ui' });
    expect(ports.memory.contexts[0]?.task).toEqual(ports.proposals.get('ui')?.task);
    const foreign = await tools.call('leer_memoria', { proyecto: 'otro', tarea: 'ui' });
    expect(foreign.isError).toBe(true);
    expect(textOf(foreign)).toMatch(/es del proyecto demo/);
    const unknown = await tools.call('leer_memoria', { proyecto: 'demo', tarea: 'nueva' });
    expect(unknown.isError).toBe(true);
  });

  it('tacha secretos y no pasa del presupuesto aunque la memoria devuelva más', async () => {
    const { tools, ports } = setup();
    ports.memory.context = `Clave ${FAKE_API_KEY} y ${SESSION_SECRET}. ${'relleno '.repeat(2_000)}`;
    const text = textOf(await tools.call('leer_memoria', { proyecto: 'demo' }));
    expect(text).not.toMatch(SECRET_PATTERN);
    expect(text).toContain(REDACTED);
    expect(text.length).toBeLessThanOrEqual(MEMORY_BUDGET_CHARS + 80);
  });

  it('dice si no hay memoria y valida la entrada', async () => {
    const { tools } = setup();
    expect(textOf(await tools.call('leer_memoria', { proyecto: 'demo' }))).toBe('Sin memoria guardada para demo.');
    await expectInvalid(tools, 'leer_memoria', { proyecto: 'demo', presupuesto: 100_000 });
    await expectInvalid(tools, 'leer_memoria', { proyecto: 'C:\\x' });
  });
});

describe('escribir_memoria', () => {
  it('guarda una decisión con autor y fecha, tachada', async () => {
    const { tools, ports } = setup();
    const result = await tools.call('escribir_memoria', {
      proyecto: 'demo',
      nota: { tipo: 'decision', titulo: 'Usar node:sqlite', texto: `Sin compilación nativa. Clave ${FAKE_API_KEY}` },
    });
    expect(jsonOf(result)).toEqual({ ok: true, tipo: 'decision', proyecto: 'demo', nota: 'Orquestador/Decisiones/2026-11-01-decision' });
    expect(ports.memory.decisions).toEqual([
      { projectId: 'demo', title: 'Usar node:sqlite', text: `Sin compilación nativa. Clave ${REDACTED}`, at: NOW.toISOString(), agentId: 'orquestador' },
    ]);
  });

  it('reemplaza el resumen vivo del proyecto', async () => {
    const { tools, ports } = setup();
    const result = await tools.call('escribir_memoria', { proyecto: 'demo', nota: { tipo: 'resumen', texto: `Fase F3. ${SESSION_SECRET}` } });
    expect(jsonOf(result)).toEqual({ ok: true, tipo: 'resumen', proyecto: 'demo' });
    expect(ports.memory.summaries).toEqual([{ projectId: 'demo', summary: `Fase F3. ${REDACTED}`, at: NOW.toISOString() }]);
  });

  it('valida la entrada', async () => {
    const { tools, ports } = setup();
    await expectInvalid(tools, 'escribir_memoria', { proyecto: 'demo' });
    await expectInvalid(tools, 'escribir_memoria', { proyecto: 'demo', nota: { tipo: 'decision', texto: 'sin título' } });
    await expectInvalid(tools, 'escribir_memoria', { proyecto: 'demo', nota: { tipo: 'chisme', texto: 'x' } });
    await expectInvalid(tools, 'escribir_memoria', { proyecto: 'demo', nota: { tipo: 'resumen', texto: 'x'.repeat(8_001) } });
    await expectInvalid(tools, 'escribir_memoria', { proyecto: 'demo', nota: { tipo: 'resumen', texto: 'ok', titulo: 'sobra' } });
    expect(ports.memory.decisions).toEqual([]);
    expect(ports.memory.summaries).toEqual([]);
  });
});

describe('buscar_skills', () => {
  const chromeDir = path.join('C:', 'dev', 'agent-hub', 'skills', 'navegador-chrome');
  const chromeDescription = 'Usar el Chrome personal del usuario para navegar y probar páginas web.';
  const skills = [
    { name: 'navegador-chrome', dir: path.join('C:', 'dev', 'agent-hub', 'skills', 'navegador-chrome'), description: 'Usar el Chrome personal del usuario para navegar y probar páginas web.' },
    { name: 'flota-orquestador', dir: path.join('C:', 'dev', 'agent-hub', 'skills', 'flota-orquestador'), description: 'Reglas de la flota: worktree por tarea y traspaso a Claude.' },
    { name: 'rota', dir: path.join('C:', 'x', 'rota'), description: 'navegador roto', valid: false },
    { name: 'pdf', dir: path.join('C:', 'x', 'pdf'), description: `Leer PDF. Token ${FAKE_OPENAI_KEY}` },
  ];

  it('devuelve nombres y rutas pertinentes, sin contenido', async () => {
    const { tools, ports } = setup();
    ports.skills.skills = skills;
    const body = jsonOf(await tools.call('buscar_skills', { texto: 'probar una página en el navegador' }));
    expect(body).toEqual({
      skills: [
        { nombre: 'navegador-chrome', ruta: path.join(chromeDir, 'SKILL.md'), descripcion: chromeDescription },
      ],
    });
    const fleet = jsonOf(await tools.call('buscar_skills', { texto: 'Flota y WORKTREE' }));
    expect((fleet.skills as { nombre: string }[]).map((s) => s.nombre)).toEqual(['flota-orquestador']);
  });

  it('omite skills inválidas, tacha secretos, acota a cinco y avisa si nada coincide', async () => {
    const { tools, ports } = setup();
    ports.skills.skills = [...skills, ...Array.from({ length: 8 }, (_, i) => ({ name: `pdf-${i}`, dir: path.join('C:', 'pdf', String(i)), description: 'pdf' }))];
    const pdf = await tools.call('buscar_skills', { texto: 'pdf' });
    expect(textOf(pdf)).not.toMatch(SECRET_PATTERN);
    expect(jsonOf(pdf).skills).toHaveLength(MAX_SKILLS);
    const broken = jsonOf(await tools.call('buscar_skills', { texto: 'roto' }));
    expect(broken).toEqual({ skills: [], aviso: 'Ninguna skill coincide.' });
  });

  it('valida la entrada', async () => {
    const { tools } = setup();
    await expectInvalid(tools, 'buscar_skills', {});
    await expectInvalid(tools, 'buscar_skills', { texto: 'a' });
    await expectInvalid(tools, 'buscar_skills', { texto: 'x'.repeat(301) });
    const stop = await tools.call('buscar_skills', { texto: 'para con' });
    expect(stop.isError).toBe(true);
    expect(textOf(stop)).toMatch(/palabras clave/);
  });
});

describe('salidas sin secretos', () => {
  it('ninguna de las siete herramientas deja pasar claves conocidas ni las de la sesión', async () => {
    const planner = new FakePlanner({ ok: true, tasks: [brief('api', { title: `API ${FAKE_API_KEY}`, objective: SESSION_SECRET })] });
    const { tools, ports } = setup({ planner });
    ports.memory.context = `memoria ${FAKE_API_KEY} ${SESSION_SECRET}`;
    ports.quotas.snapshots = [{ agentId: 'agy', method: 'agy-usage', takenAt: NOW.toISOString(), buckets: [], stale: false, error: SESSION_SECRET }];
    ports.skills.skills = [{ name: 'secreta', dir: path.join('C:', SESSION_SECRET), description: `clave ${FAKE_OPENAI_KEY}` }];
    const calls: [ConductorToolName, unknown][] = [
      ['crear_tareas', { plan: `plan con ${FAKE_API_KEY}` }],
      ['delegar', { taskId: 'api' }],
      ['estado', { taskId: 'api' }],
      ['estado', {}],
      ['cupos', {}],
      ['leer_memoria', { proyecto: 'demo', tarea: 'api' }],
      ['escribir_memoria', { proyecto: 'demo', nota: { tipo: 'decision', titulo: FAKE_API_KEY, texto: SESSION_SECRET } }],
      ['buscar_skills', { texto: 'secreta clave' }],
    ];
    const outputs: string[] = [];
    for (const [name, args] of calls) {
      if (name === 'delegar') ports.proposals.approve(['api']);
      const result = await tools.call(name, args);
      outputs.push(textOf(result));
    }
    expect(new Set(calls.map(([n]) => n)).size).toBe(CONDUCTOR_TOOL_NAMES.length);
    for (const text of outputs) {
      expect(text).not.toMatch(SECRET_PATTERN);
      expect(text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    }
    expect(outputs.join('\n')).toContain(REDACTED);
    expect(JSON.stringify(ports.memory.decisions)).not.toMatch(SECRET_PATTERN);
    // Lo que devolvió el planificador también se guardó tachado (propuestas y encargo enviado a la flota).
    expect(JSON.stringify(ports.proposals.list())).not.toMatch(SECRET_PATTERN);
    expect(JSON.stringify(ports.fleet.delegated)).not.toMatch(SECRET_PATTERN);
  });

  it('los errores de un puerto salen tachados y acotados', async () => {
    const { tools, ports } = setup();
    ports.skills.list = async () => {
      throw new Error(`EACCES leyendo ${FAKE_API_KEY} ${'x'.repeat(5_000)}`);
    };
    const result = await tools.call('buscar_skills', { texto: 'navegador' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/buscar_skills falló: EACCES/);
    expect(textOf(result)).not.toMatch(SECRET_PATTERN);
    expect(textOf(result).length).toBeLessThan(500);
  });

  it('acepta los secretos como función (claves que cambian en caliente)', async () => {
    let current = ['clave-temporal-1234'];
    const ports = fakePorts();
    ports.memory.context = 'clave-temporal-1234 y clave-temporal-5678';
    const tools = createConductorTools(ports, { secrets: () => current });
    expect(textOf(await tools.call('leer_memoria', { proyecto: 'demo' }))).not.toContain('clave-temporal-1234');
    current = ['clave-temporal-5678'];
    expect(textOf(await tools.call('leer_memoria', { proyecto: 'demo' }))).not.toContain('clave-temporal-5678');
  });
});

describe('modos de la mente y agente suelto', () => {
  it('plan: crear_tareas propone y delegar no está disponible aunque la tarea esté aprobada', async () => {
    const { tools, ports } = setup({}, { mode: () => 'plan' });
    const body = jsonOf(await tools.call('crear_tareas', { plan: 'plan' }));
    expect(body).toMatchObject({ estado: 'propuestas', pendientesDeAprobacion: 2 });
    expect(String(body.siguientePaso)).toMatch(/pasan solas a la flota/);
    ports.proposals.approve(['api']);
    const res = await tools.call('delegar', { taskId: 'api' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/modo plan/);
    expect(ports.fleet.delegated).toEqual([]);
  });

  it('auto y bypass: crear_tareas aprueba sola con autoApprove y delegar entrega', async () => {
    for (const mode of ['auto', 'bypass'] as const) {
      const ports = fakePorts();
      const approved: string[][] = [];
      const tools = createConductorTools(ports, {
        defaultProjectId: 'demo',
        mode: () => mode,
        autoApprove: (ids) => {
          approved.push([...ids]);
          return ports.proposals.approve(ids);
        },
      });
      const body = jsonOf(await tools.call('crear_tareas', { plan: 'plan' }));
      expect(body).toMatchObject({ estado: 'aprobadas', pendientesDeAprobacion: 0, aprobadas: 2, modo: mode });
      expect(String(body.siguientePaso)).toMatch(/delégalas con delegar/);
      expect(approved).toEqual([['api', 'ui']]);
      expect((await tools.call('delegar', { taskId: 'api' })).isError).toBeFalsy();
      expect(ports.fleet.delegated.map((t) => t.id)).toEqual(['api']);
    }
  });

  it('el modo se lee en cada llamada', async () => {
    let mode: 'plan' | 'auto' = 'auto';
    const { tools, ports } = setup({}, { mode: () => mode, autoApprove: (ids) => ports.proposals.approve(ids) });
    await tools.call('crear_tareas', { plan: 'plan' });
    mode = 'plan';
    expect(textOf(await tools.call('delegar', { taskId: 'api' }))).toMatch(/modo plan/);
    mode = 'auto';
    expect((await tools.call('delegar', { taskId: 'api' })).isError).toBeFalsy();
  });

  it('el plan de implementación llega íntegro al planificador (hasta el tope)', async () => {
    const { tools, ports } = setup();
    const plan = `Objetivo: x\n${'1. paso con rutas src/a/** y verificación npm test\n'.repeat(1500)}`.slice(0, MAX_PLAN_CHARS);
    expect(plan.length).toBeGreaterThan(20_000);
    expect((await tools.call('crear_tareas', { plan })).isError).toBeFalsy();
    expect(ports.planner.requests[0]?.planText).toBe(plan.trim());
  });

  it('una decisión de memoria admite un plan completo', async () => {
    const { tools, ports } = setup();
    const texto = 'p'.repeat(MAX_DECISION_CHARS);
    expect((await tools.call('escribir_memoria', { proyecto: 'demo', nota: { tipo: 'decision', titulo: 'Plan: x', texto } })).isError).toBeFalsy();
    expect(ports.memory.decisions[0]?.text).toBe(texto);
    await expectInvalid(tools, 'escribir_memoria', { proyecto: 'demo', nota: { tipo: 'decision', titulo: 'x', texto: `${texto}p` } });
  });

  it('agente suelto: sin crear_tareas, delegar, estado ni escribir_memoria; lectura sí', async () => {
    const { tools, ports } = setup({}, { standalone: true, defaultProjectId: undefined });
    for (const [name, args] of [
      ['crear_tareas', { plan: 'x', proyecto: 'demo' }],
      ['delegar', { taskId: 'api' }],
      ['estado', {}],
      ['escribir_memoria', { proyecto: 'demo', nota: { tipo: 'resumen', texto: 'x' } }],
    ] as const) {
      const res = await tools.call(name, args);
      expect(res.isError, name).toBe(true);
      expect(textOf(res)).toMatch(/en una conversación/);
    }
    expect(ports.planner.requests).toEqual([]);
    expect((await tools.call('cupos', {})).isError).toBeFalsy();
    expect((await tools.call('leer_memoria', { proyecto: 'demo' })).isError).toBeFalsy();
  });
});
