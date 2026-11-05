/** `crear_tareas.destino` (issue 2): validación, cuándo se anota, qué recibe quien lo guarda y el texto del prompt. */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import {
  CONDUCTOR_PROMPT_PREFIX,
  ConductorSession,
  DESTINATION_PROMPT_TEXT,
  MAX_DESTINATION_CHARS,
  createConductorTools,
  type ConductorQueryFn,
  type ConductorToolsOptions,
  type DestinationRequest,
} from '../../../src/core/conductor/index.ts';
import type { ChangesTarget } from '../../../src/shared/index.ts';
import { FAKE_API_KEY, FakePlanner, NOW, SECRET_PATTERN, SESSION_SECRET, brief, fakePorts, jsonOf, textOf } from './fakes.ts';

const REMOTE: ChangesTarget = { kind: 'remote', path: 'C:\\dev\\demo', remote: { name: 'origin', url: 'https://github.com/a/b' }, branch: 'main', configured: true };

function setup(opts: ConductorToolsOptions = {}) {
  const calls: { projectId: string; destination: DestinationRequest | null }[] = [];
  const ports = fakePorts();
  const tools = createConductorTools(ports, {
    defaultProjectId: 'demo',
    now: () => NOW,
    secrets: [SESSION_SECRET],
    recordDestination: (input) => {
      calls.push(input);
      return input.destination === null ? { kind: 'local', path: 'C:\\dev\\demo', git: 'local', worktrees: false } : REMOTE;
    },
    ...opts,
  });
  return { ports, tools, calls };
}

describe('crear_tareas: destino', () => {
  it('sin destino no anota nada ni lo menciona', async () => {
    const { tools, calls } = setup();
    const body = jsonOf(await tools.call('crear_tareas', { plan: 'plan' }));
    expect(calls).toEqual([]);
    expect(body).not.toHaveProperty('destino');
  });

  it('con destino lo anota después de proponer las tareas y lo resume para la mente', async () => {
    const { tools, calls, ports } = setup();
    const result = await tools.call('crear_tareas', { plan: 'plan', destino: { remoto: ' origin ', rama: 'main' } });
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([{ projectId: 'demo', destination: { remoto: 'origin', rama: 'main' } }]);
    expect((await ports.proposals.list()).map((e) => e.approval)).toEqual(['proposed', 'proposed']);
    expect(jsonOf(result).destino).toEqual({
      guardado: true,
      tipo: 'remoto',
      remoto: 'https://github.com/a/b',
      nombre: 'origin',
      rama: 'main',
      configurado: true,
      nota: expect.stringMatching(/no se sube nada.*aprobación explícita del usuario/),
    });
  });

  it('null: el usuario pidió volver a local', async () => {
    const { tools, calls } = setup();
    const body = jsonOf(await tools.call('crear_tareas', { plan: 'plan', destino: null }));
    expect(calls).toEqual([{ projectId: 'demo', destination: null }]);
    expect(body.destino).toMatchObject({ guardado: true, tipo: 'local', carpeta: 'C:\\dev\\demo' });
  });

  it('un remoto sin configurar avisa para decírselo al usuario', async () => {
    const { tools } = setup({ recordDestination: () => ({ ...REMOTE, remote: { name: 'upstream', url: '' }, configured: false }) });
    const body = jsonOf(await tools.call('crear_tareas', { plan: 'plan', destino: { remoto: 'upstream' } }));
    expect(body.destino).toMatchObject({ remoto: 'upstream', configurado: false, aviso: expect.stringMatching(/no está configurado en la carpeta/) });
  });

  it('las claves del remoto se tachan antes de llegar a quien lo guarda y nunca salen en la respuesta', async () => {
    const { tools, calls } = setup();
    const result = await tools.call('crear_tareas', { plan: 'plan', destino: { remoto: `https://${SESSION_SECRET}@github.com/a/b?k=${FAKE_API_KEY}` } });
    expect(JSON.stringify(calls)).not.toMatch(SECRET_PATTERN);
    expect(textOf(result)).not.toMatch(SECRET_PATTERN);
  });

  it('un plan que falla, tareas de otro proyecto o un agente suelto no anotan el destino', async () => {
    const failing = setup();
    failing.ports.planner.result = { ok: false, issues: [{ code: 'x', message: 'mal', taskIds: [] }] };
    expect((await failing.tools.call('crear_tareas', { plan: 'plan', destino: { remoto: 'origin' } })).isError).toBe(true);
    expect(failing.calls).toEqual([]);

    const foreign = setup();
    foreign.ports.planner.result = { ok: true, tasks: [brief('ajena', { projectId: 'otro' })] };
    expect((await foreign.tools.call('crear_tareas', { plan: 'plan', destino: { remoto: 'origin' } })).isError).toBe(true);
    expect(foreign.calls).toEqual([]);

    const solo = setup({ standalone: true });
    expect((await solo.tools.call('crear_tareas', { plan: 'plan', destino: { remoto: 'origin' } })).isError).toBe(true);
    expect(solo.calls).toEqual([]);
  });

  it('si guardarlo falla o la sesión no guarda destinos, las tareas quedan propuestas y la respuesta lo avisa', async () => {
    const broken = setup({
      recordDestination: () => {
        throw new Error(`base de datos ocupada ${SESSION_SECRET}`);
      },
    });
    const r1 = await broken.tools.call('crear_tareas', { plan: 'plan', destino: { remoto: 'origin' } });
    expect(r1.isError).toBeFalsy();
    expect(jsonOf(r1).destino).toEqual({ guardado: false, aviso: expect.stringMatching(/^No se pudo guardar el destino: base de datos ocupada/) });
    expect(textOf(r1)).not.toMatch(SECRET_PATTERN);
    expect((await broken.ports.proposals.list()).length).toBe(2);

    const ports = fakePorts();
    const bare = createConductorTools(ports, { defaultProjectId: 'demo', now: () => NOW });
    const r2 = await bare.call('crear_tareas', { plan: 'plan', destino: { remoto: 'origin' } });
    expect(jsonOf(r2).destino).toMatchObject({ guardado: false, aviso: expect.stringMatching(/no guarda el destino/) });
  });

  it.each([
    [{ remoto: '' }],
    [{ remoto: '   ' }],
    [{ remoto: 'x'.repeat(MAX_DESTINATION_CHARS + 1) }],
    [{ remoto: 'origin', rama: '--force' }],
    [{ remoto: 'origin', rama: 'a..b' }],
    [{ remoto: 'origin', rama: 'con espacio' }],
    [{ remoto: 'origin', extra: true }],
    [{ rama: 'main' }],
    ['origin'],
  ])('rechaza destino %j', async (destino) => {
    const { tools, calls, ports } = setup();
    const result = await tools.call('crear_tareas', { plan: 'plan', destino });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/entrada inválida/);
    expect(calls).toEqual([]);
    expect((ports.planner as FakePlanner).requests).toEqual([]);
  });
});

describe('sesión: texto del prompt sobre destino', () => {
  function optionsOf(extra: Partial<ConstructorParameters<typeof ConductorSession>[0]>): Options {
    const captured: Options[] = [];
    const query: ConductorQueryFn = ({ options }) => {
      captured.push(options);
      return (async function* () {})();
    };
    const s = new ConductorSession({ ports: fakePorts(), projectId: 'demo', cwd: 'C:\\dev\\demo', query, now: () => NOW, ...extra });
    s.send('hola');
    s.close();
    const o = captured[0];
    if (!o) throw new Error('sin opciones');
    return o;
  }

  it('con recordDestination va como bloque propio al final; el prefijo y el contexto no cambian', () => {
    const plain = optionsOf({}).systemPrompt as string[];
    const withTarget = optionsOf({ recordDestination: () => REMOTE }).systemPrompt as string[];
    expect(plain).toHaveLength(3);
    expect(withTarget).toHaveLength(4);
    expect(withTarget[0]).toBe(CONDUCTOR_PROMPT_PREFIX);
    expect(withTarget.slice(0, 3)).toEqual(plain);
    expect(withTarget[3]).toBe(DESTINATION_PROMPT_TEXT);
    expect(DESTINATION_PROMPT_TEXT).toMatch(/Solo si el usuario indicó explícitamente un repositorio donde subir los cambios/);
    expect(DESTINATION_PROMPT_TEXT).toMatch(/omite destino/);
  });

  it('un agente suelto no recibe el texto ni guarda destinos', async () => {
    const calls: unknown[] = [];
    const record = () => {
      calls.push(1);
      return REMOTE;
    };
    expect(optionsOf({ projectId: null, recordDestination: record }).systemPrompt).toHaveLength(3);
    const s = new ConductorSession({ ports: fakePorts(), projectId: null, cwd: 'C:\\dev\\demo', recordDestination: record, query: () => (async function* () {})() });
    expect((await s.tools.call('crear_tareas', { plan: 'plan', destino: { remoto: 'origin' } })).isError).toBe(true);
    expect(calls).toEqual([]);
    s.close();
  });
});
