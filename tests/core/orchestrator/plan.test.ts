import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PlanIssue, PlannerLlm, PlannerRequest, PlanResult } from '../../../src/core/orchestrator/plan.ts';
import { extractJsonArray, planToTasks, plannerSystemPrompt, validatePlan } from '../../../src/core/orchestrator/plan.ts';
import { REDACTED } from '../../../src/shared/index.ts';

const PROJECT = 'orquestador';

type RawTask = Record<string, unknown>;
/** Tarea tal como la escribiría el modelo planificador. */
const task = (id: string, ownedPaths: string[], dependsOn: string[] = [], extra: RawTask = {}): RawTask => ({
  id,
  projectId: PROJECT,
  title: `Tarea ${id}`,
  objective: `Implementar ${id} con pruebas Vitest en tests/.`,
  ownedPaths,
  dependsOn,
  acceptance: ['scripts/win.sh npm run -s check en verde'],
  difficulty: 'medium',
  ...extra,
});
const json = (value: unknown): string => JSON.stringify(value, null, 2);
const withoutProjectId = (raw: RawTask): RawTask => Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'projectId'));

const PLAN_TEXT = [
  '# Plan F1',
  '1. Contratos compartidos en src/shared.',
  '2. Adaptador de Codex CLI con sus pruebas, cuando estén los contratos.',
  '3. Documentación de la API local.',
].join('\n');

const GOOD = [
  task('contratos', ['src/shared/**'], [], { difficulty: 'high' }),
  task('adaptador-codex', ['src/core/adapters/codex-cli/**', 'tests/core/adapters/codex-cli/**'], ['contratos'], { suggestedAgent: 'codex' }),
  task('docs-api', ['docs/api/**'], [], { difficulty: 'low', suggestedAgent: 'agy', skillRefs: ['C:\\dev\\agent-hub\\skills\\x\\SKILL.md'] }),
];

// Secretos falsos con el formato de cada proveedor (redact.ts), armados para no parecer claves reales.
const SECRETS = {
  anthropic: `sk-ant-api03-${'x'.repeat(24)}`,
  openai: `sk-proj-${'y'.repeat(24)}`,
  github: `ghp_${'a'.repeat(36)}`,
  google: `AIza${'b'.repeat(35)}`,
};

interface ScriptedLlm {
  llm: PlannerLlm;
  requests: PlannerRequest[];
  remaining: () => number;
}

/** Modelo falso guionado: devuelve (o lanza) las respuestas en orden y guarda cada petición. */
function scriptedLlm(...replies: (string | Error)[]): ScriptedLlm {
  const queue = [...replies];
  const requests: PlannerRequest[] = [];
  return {
    requests,
    remaining: () => queue.length,
    llm: {
      async complete(request) {
        requests.push(request);
        const next = queue.shift();
        if (next === undefined) throw new Error('el guion del modelo falso se agotó');
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`falta el elemento ${index} (hay ${items.length})`);
  return item;
}
function expectOk(result: PlanResult): Extract<PlanResult, { ok: true }> {
  if (!result.ok) throw new Error(`se esperaba ok y llegó: ${json(result.issues)}`);
  return result;
}
function expectFail(result: PlanResult): Extract<PlanResult, { ok: false }> {
  if (result.ok) throw new Error(`se esperaba un fallo y llegaron ${result.tasks.length} tareas`);
  return result;
}
const codes = (issues: readonly PlanIssue[]): string[] => issues.map((i) => i.code);
/** Último mensaje (el de reparación) de la petición `index`. */
const repairText = (s: ScriptedLlm, index: number): string => {
  const messages = nth(s.requests, index).messages;
  return nth(messages, messages.length - 1).content;
};

describe('planToTasks', () => {
  describe('JSON válido a la primera', () => {
    it('una sola llamada; tareas validadas con valores por defecto', async () => {
      const s = scriptedLlm(json(GOOD));
      const result = expectOk(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT }));
      expect(result.attempts).toBe(1);
      expect(result.tasks.map((t) => t.id)).toEqual(['contratos', 'adaptador-codex', 'docs-api']);
      expect(nth(result.tasks, 0)).toMatchObject({ projectId: PROJECT, contextRefs: [], skillRefs: [], difficulty: 'high' });
      expect(nth(result.tasks, 1)).toMatchObject({ dependsOn: ['contratos'], suggestedAgent: 'codex' });
      expect(s.requests).toHaveLength(1);
    });

    it('manda el prompt de sistema fijo y el plan con el proyecto en un único mensaje de usuario', async () => {
      const s = scriptedLlm(json(GOOD));
      await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT });
      const request = nth(s.requests, 0);
      expect(request.system).toBe(plannerSystemPrompt());
      expect(request.messages).toHaveLength(1);
      const user = nth(request.messages, 0);
      expect(user.role).toBe('user');
      expect(user.content).toContain(`Proyecto: ${PROJECT}. Usa "projectId": "${PROJECT}" en todas las tareas.`);
      expect(user.content).toContain(`Plan:\n${PLAN_TEXT}`);
      expect(user.content).not.toContain('Tareas ya existentes');
    });

    it('acepta un bloque ```json con texto alrededor', async () => {
      const s = scriptedLlm(`Aquí tienes las tareas:\n\n\`\`\`json\n${json(GOOD)}\n\`\`\`\n\nAvísame si quieres cambios.`);
      expect(expectOk(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT })).attempts).toBe(1);
    });

    it('acepta un objeto { "tasks": [...] }', async () => {
      const s = scriptedLlm(json({ tasks: GOOD }));
      expect(expectOk(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT })).tasks).toHaveLength(3);
    });

    it('el projectId lo decide el orquestador, no el modelo', async () => {
      const s = scriptedLlm(json([task('otro', ['src/a/**'], [], { projectId: 'proyecto-ajeno' }), withoutProjectId(task('sin-proyecto', ['src/b/**']))]));
      const result = expectOk(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT }));
      expect(result.tasks.map((t) => t.projectId)).toEqual([PROJECT, PROJECT]);
    });

    it('acepta dependencias de tareas ya existentes (knownTaskIds) y las anuncia al modelo', async () => {
      const s = scriptedLlm(json([task('adaptador-codex', ['src/core/adapters/codex-cli/**'], ['contratos', 'base-repo'])]));
      const result = expectOk(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT, knownTaskIds: new Set(['contratos', 'base-repo']) }));
      expect(result.attempts).toBe(1);
      expect(nth(nth(s.requests, 0).messages, 0).content).toContain('Tareas ya existentes que puedes usar en dependsOn: contratos, base-repo.');
    });
  });

  describe('reparación', () => {
    it('JSON inválido se repara en el segundo intento', async () => {
      const broken = '```json\n[{"id": "contratos", "ownedPaths": ["src/shared/**"],\n```';
      const s = scriptedLlm(broken, json(GOOD));
      const result = expectOk(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT }));
      expect(result.attempts).toBe(2);
      expect(s.requests).toHaveLength(2);

      const [first, second] = [nth(s.requests, 0), nth(s.requests, 1)];
      expect(second.system).toBe(first.system);
      expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(nth(second.messages, 0)).toEqual(nth(first.messages, 0));
      expect(nth(second.messages, 1).content).toBe(broken);
      const repair = repairText(s, 1);
      expect(repair).toMatch(/^Tu respuesta tiene estos errores:\n- \[json\] JSON inválido: /);
      expect(repair).toMatch(/Corrígelos y responde de nuevo SOLO con el arreglo JSON completo de tareas\.$/);
    });

    it('una respuesta sin JSON también se repara', async () => {
      const s = scriptedLlm('Claro, aquí va el plan: primero los contratos y luego el adaptador.', json(GOOD));
      expect(expectOk(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT })).attempts).toBe(2);
      expect(repairText(s, 1)).toContain('- [json] ');
    });

    it('un error de esquema se devuelve con la tarea y el campo', async () => {
      const s = scriptedLlm(json([task('contratos', ['src/shared/**'], [], { difficulty: 'altisima' })]), json(GOOD));
      expect(expectOk(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT })).attempts).toBe(2);
      expect(repairText(s, 1)).toContain('- [schema] Tarea 0 (contratos): difficulty: ');
    });

    it('los solapes de ownedPaths se devuelven al modelo para que repare', async () => {
      const overlapping = [task('nucleo', ['src/core/**']), task('cola', ['src\\core\\orchestrator\\queue.ts'])];
      const fixed = [task('nucleo', ['src/core/adapters/**']), task('cola', ['src/core/orchestrator/queue.ts'])];
      const s = scriptedLlm(json(overlapping), json(fixed));
      const result = expectOk(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT }));
      expect(result.attempts).toBe(2);
      expect(result.tasks.map((t) => t.ownedPaths)).toEqual([['src/core/adapters/**'], ['src/core/orchestrator/queue.ts']]);
      expect(repairText(s, 1)).toContain(
        '- [overlap] Las tareas nucleo y cola se solapan: «src/core/**» y «src\\core\\orchestrator\\queue.ts» pueden tocar los mismos archivos. Cada archivo debe pertenecer a una sola tarea.',
      );
    });

    it('los ciclos se devuelven al modelo para que repare', async () => {
      const cyclic = [task('cola', ['src/q.ts'], ['router']), task('router', ['src/r.ts'], ['flota']), task('flota', ['src/f.ts'], ['cola'])];
      const fixed = [task('cola', ['src/q.ts']), task('router', ['src/r.ts'], ['cola']), task('flota', ['src/f.ts'], ['router'])];
      const s = scriptedLlm(json(cyclic), json(fixed));
      expect(expectOk(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT })).attempts).toBe(2);
      expect(repairText(s, 1)).toContain('- [cycle] Ciclo de dependencias: cola → router → flota → cola (→ = «depende de»).');
    });

    it('una tarea que depende de sí misma y una dependencia inexistente se devuelven al modelo', async () => {
      const s = scriptedLlm(json([task('cola', ['src/q.ts'], ['cola']), task('router', ['src/r.ts'], ['fantasma'])]), json(GOOD));
      expect(expectOk(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT })).attempts).toBe(2);
      const repair = repairText(s, 1);
      expect(repair).toContain('- [cycle] Tarea cola: depende de sí misma.');
      expect(repair).toContain('- [unknown_dependency] Tarea router: depende de «fantasma», que no existe.');
    });

    it('todos los errores de una respuesta van juntos en un solo mensaje de reparación', async () => {
      const messy = [
        task('cola', ['src/core/**']),
        task('cola', ['docs/cola.md']),
        task('router', ['C:\\dev\\orquestador\\src\\router.ts', 'src/core/router.ts'], ['fantasma']),
        task('Mal-Id', ['tests/x.test.ts']),
      ];
      const s = scriptedLlm(json(messy), json(GOOD));
      expect(expectOk(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT })).attempts).toBe(2);
      const listed = [...repairText(s, 1).matchAll(/^- \[(\w+)\]/gm)].map((m) => m[1]);
      expect(new Set(listed)).toEqual(new Set(['schema', 'duplicate_id', 'invalid_path', 'overlap', 'unknown_dependency']));
    });

    it('el historial crece por turnos y cada llamada recibe su propia copia', async () => {
      const s = scriptedLlm('uno', 'dos', json(GOOD));
      expect(expectOk(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT })).attempts).toBe(3);
      expect(s.requests.map((r) => r.messages.length)).toEqual([1, 3, 5]);
      const third = nth(s.requests, 2).messages;
      expect(third.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
      expect([nth(third, 1).content, nth(third, 3).content]).toEqual(['uno', 'dos']);
      expect(new Set(s.requests.map((r) => r.system)).size).toBe(1);
    });
  });

  describe('límite de intentos', () => {
    it('falla tras 2 intentos (maxRepairs: 1) con los errores del último y sin llamar más', async () => {
      const s = scriptedLlm('no sé hacerlo', '[]', json(GOOD));
      const result = expectFail(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT, maxRepairs: 1 }));
      expect(result.attempts).toBe(2);
      expect(s.requests).toHaveLength(2);
      expect(s.remaining()).toBe(1);
      expect(result.issues).toEqual([{ code: 'empty', message: 'El plan no tiene tareas.', taskIds: [] }]);
      expect(result.lastOutput).toBe('[]');
    });

    it('repara en el segundo intento con maxRepairs: 1 (último permitido)', async () => {
      const s = scriptedLlm('[', json(GOOD));
      expect(expectOk(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT, maxRepairs: 1 })).attempts).toBe(2);
    });

    it('por defecto: 1 intento + 2 reparaciones (3 llamadas) y luego falla', async () => {
      const cyclic = json([task('cola', ['src/q.ts'], ['router']), task('router', ['src/r.ts'], ['cola'])]);
      const s = scriptedLlm('{', '[]', cyclic, json(GOOD));
      const result = expectFail(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT }));
      expect(result.attempts).toBe(3);
      expect(s.requests).toHaveLength(3);
      expect(s.remaining()).toBe(1);
      expect(codes(result.issues)).toEqual(['cycle']);
      expect(nth(result.issues, 0).taskIds).toEqual(['cola', 'router']);
      expect(result.lastOutput).toBe(cyclic);
    });

    it('por defecto aún repara en el tercer intento', async () => {
      const s = scriptedLlm('{', '[]', json(GOOD));
      expect(expectOk(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT })).attempts).toBe(3);
    });

    it('maxRepairs: 0 → un solo intento, sin reparación', async () => {
      const s = scriptedLlm('[]', json(GOOD));
      const result = expectFail(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT, maxRepairs: 0 }));
      expect(result.attempts).toBe(1);
      expect(s.requests).toHaveLength(1);
    });
  });

  describe('errores del modelo y cancelación', () => {
    it('propaga la excepción del modelo en el primer intento', async () => {
      const s = scriptedLlm(new Error('cupo agotado (429)'));
      await expect(planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT })).rejects.toThrow('cupo agotado (429)');
    });

    it('propaga la excepción del modelo durante una reparación', async () => {
      const s = scriptedLlm('[]', new Error('conexión cortada'));
      await expect(planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT })).rejects.toThrow('conexión cortada');
      expect(s.requests).toHaveLength(2);
    });

    it('pasa el mismo AbortSignal en cada intento', async () => {
      const controller = new AbortController();
      const s = scriptedLlm('[]', '[]', json(GOOD));
      await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT, signal: controller.signal });
      expect(s.requests).toHaveLength(3);
      for (const request of s.requests) expect(request.signal).toBe(controller.signal);
    });
  });

  describe('secretos', () => {
    it('tacha los secretos del plan antes de mandarlo al modelo', async () => {
      const plan = [
        PLAN_TEXT,
        `Clave de Anthropic: ${SECRETS.anthropic}`,
        `OPENAI_API_KEY=${SECRETS.openai}`,
        `token ${SECRETS.github} y ${SECRETS.google}`,
        `Authorization: Bearer ${'t'.repeat(24)}`,
      ].join('\n');
      const s = scriptedLlm(json(GOOD));
      await planToTasks(plan, s.llm, { projectId: PROJECT });
      const sent = nth(nth(s.requests, 0).messages, 0).content;
      for (const secret of [...Object.values(SECRETS), 't'.repeat(24)]) expect(sent).not.toContain(secret);
      expect(sent.split(REDACTED).length - 1).toBeGreaterThanOrEqual(5);
      expect(sent).toContain('Adaptador de Codex CLI');
    });

    it('tacha los secretos de la respuesta en el historial reenviado y en lastOutput', async () => {
      const leaky = `No pude armar el JSON. Usé la clave ${SECRETS.anthropic}`;
      const s = scriptedLlm(leaky, leaky, leaky);
      const result = expectFail(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT }));
      expect(result.lastOutput).toBe(`No pude armar el JSON. Usé la clave ${REDACTED}`);
      for (const request of s.requests) {
        for (const m of request.messages) expect(m.content).not.toContain(SECRETS.anthropic);
      }
      expect(nth(nth(s.requests, 1).messages, 1).content).toContain(REDACTED);
    });

    // Corregido (hallazgo de c9): antes solo se tachaba `lastOutput`; ahora también las tareas devueltas.
    it('las tareas devueltas no llevan secretos aunque el modelo los escriba', async () => {
      const s = scriptedLlm(json([task('contratos', ['src/shared/**'], [], { objective: `Probar con la clave ${SECRETS.openai}` })]));
      const result = expectOk(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT }));
      expect(json(result.tasks)).not.toContain(SECRETS.openai);
    });

    // Corregido (hallazgo de c9): los mensajes de error copiaban el `id` crudo del modelo sin tachar.
    it('los errores devueltos no llevan secretos aunque el modelo los escriba', async () => {
      const s = scriptedLlm(json([task(`Clave ${SECRETS.anthropic}`, ['src/shared/**'])]));
      const result = expectFail(await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT, maxRepairs: 0 }));
      expect(json(result.issues)).not.toContain(SECRETS.anthropic);
    });
  });

  // Corregido (hallazgo de c9): `knownTaskIds` se recorría dos veces; ahora se materializa en un Set al empezar.
  it('knownTaskIds funciona con un iterable de un solo uso (Map.keys())', async () => {
    const existing = new Map([['contratos', { state: 'integrated' }]]);
    const plan = json([task('adaptador-codex', ['src/core/adapters/codex-cli/**'], ['contratos'])]);
    const s = scriptedLlm(plan, plan, plan);
    const result = await planToTasks(PLAN_TEXT, s.llm, { projectId: PROJECT, knownTaskIds: existing.keys() });
    expect(result).toMatchObject({ ok: true, attempts: 1 });
  });
});

describe('validatePlan', () => {
  it('un plan correcto no tiene errores', () => {
    const result = validatePlan(GOOD);
    expect(result.issues).toEqual([]);
    expect(result.tasks).toHaveLength(3);
  });

  it.each([null, 'texto', 42, true, {}, { tasks: 'no' }, { plan: [] }])('rechaza la forma %j', (raw) => {
    expect(validatePlan(raw)).toEqual({
      tasks: [],
      issues: [{ code: 'json', message: 'La respuesta debe ser un arreglo JSON de tareas.', taskIds: [] }],
    });
  });

  it.each([[[]], [{ tasks: [] }]])('rechaza el plan vacío %j', (raw) => {
    expect(validatePlan(raw).issues).toEqual([{ code: 'empty', message: 'El plan no tiene tareas.', taskIds: [] }]);
  });

  describe('esquema', () => {
    it('conserva las tareas válidas y explica cada error con índice, id y campo', () => {
      const result = validatePlan([task('contratos', ['src/shared/**']), task('router', [], [], { acceptance: [] }), 'no soy una tarea']);
      expect(result.tasks.map((t) => t.id)).toEqual(['contratos']);
      expect(codes(result.issues)).toEqual(['schema', 'schema', 'schema']);
      expect(result.issues.map((i) => i.message.split(':').slice(0, 2).join(':'))).toEqual([
        'Tarea 1 (router): ownedPaths',
        'Tarea 1 (router): acceptance',
        'Tarea 2: (tarea)',
      ]);
      expect(result.issues.map((i) => i.taskIds)).toEqual([['router'], ['router'], []]);
    });

    it.each([
      ['mayúsculas', 'Contratos'],
      ['un solo carácter', 'a'],
      ['espacios', 'mi tarea'],
      ['guion inicial', '-tarea'],
    ])('rechaza un id con %s', (_label, id) => {
      const result = validatePlan([task(id, ['src/a/**'])]);
      expect(result.tasks).toEqual([]);
      expect(nth(result.issues, 0)).toMatchObject({ code: 'schema', taskIds: [id] });
      expect(nth(result.issues, 0).message).toContain(`Tarea 0 (${id}): id: `);
    });

    it('rechaza campos que el esquema no conoce (strictObject)', () => {
      const result = validatePlan([task('contratos', ['src/shared/**'], [], { prioridad: 1 })]);
      expect(codes(result.issues)).toEqual(['schema']);
      expect(nth(result.issues, 0).message).toContain('Tarea 0 (contratos): (tarea): ');
      expect(nth(result.issues, 0).message).toContain('prioridad');
    });

    it('sin opts.projectId el projectId del modelo es obligatorio', () => {
      const raw = withoutProjectId(task('contratos', ['src/shared/**']));
      expect(nth(validatePlan([raw]).issues, 0).message).toContain('Tarea 0 (contratos): projectId: ');
      expect(validatePlan([raw], { projectId: PROJECT }).issues).toEqual([]);
    });
  });

  it('informa ids repetidos una vez por id', () => {
    const result = validatePlan([task('cola', ['src/a/**']), task('cola', ['src/b/**']), task('cola', ['src/c/**']), task('router', ['src/d/**'])]);
    expect(result.issues).toEqual([{ code: 'duplicate_id', message: 'El id «cola» se repite en 3 tareas.', taskIds: ['cola'] }]);
  });

  it.each([
    ['C:\\dev\\x.ts', 'debe ser relativa a la raíz del repo'],
    ['/etc/x', 'debe ser relativa a la raíz del repo'],
    ['../otro-repo/**', 'no puede salir del repo'],
    ['!src/secreto.ts', 'no se admiten negaciones'],
    ['   ', 'ruta vacía'],
  ])('rechaza la ruta propia %j', (path, problem) => {
    const issues = validatePlan([task('cola', [path])]).issues;
    const invalid = issues.filter((i) => i.code === 'invalid_path');
    expect(invalid).toHaveLength(1);
    const message = nth(invalid, 0).message;
    expect(message.startsWith('Tarea cola: ruta inválida ')).toBe(true);
    expect(message).toContain(problem);
    expect(message.endsWith('.')).toBe(true);
    expect(nth(invalid, 0).taskIds).toEqual(['cola']);
  });

  describe('solapes', () => {
    it('informa cada par de rutas que chocan, con las dos tareas', () => {
      const result = validatePlan([task('nucleo', ['src/core/**', 'tests/core/**']), task('cola', ['src/core/queue.ts', 'tests/core/queue.test.ts']), task('docs', ['docs/**'])]);
      expect(codes(result.issues)).toEqual(['overlap', 'overlap']);
      expect(result.issues.map((i) => i.taskIds)).toEqual([['nucleo', 'cola'], ['nucleo', 'cola']]);
      expect(nth(result.issues, 1).message).toContain('«tests/core/**» y «tests/core/queue.test.ts»');
    });

    it('rutas vecinas que no se solapan no son error', () => {
      const result = validatePlan([task('core', ['src/core/**']), task('core-ui', ['src/core-ui/**']), task('readme', ['README.md']), task('readme-en', ['README.en.md'])]);
      expect(result.issues).toEqual([]);
    });
  });

  describe('dependencias', () => {
    it('informa dependencias inexistentes', () => {
      const result = validatePlan([task('cola', ['src/q.ts'], ['contratos', 'fantasma'])]);
      expect(result.issues).toEqual([
        { code: 'unknown_dependency', message: 'Tarea cola: depende de «contratos», que no existe.', taskIds: ['cola'] },
        { code: 'unknown_dependency', message: 'Tarea cola: depende de «fantasma», que no existe.', taskIds: ['cola'] },
      ]);
    });

    it.each([
      { label: 'un Set', known: new Set(['contratos']) },
      { label: 'un arreglo', known: ['contratos'] },
    ])('acepta tareas existentes pasadas como $label', ({ known }) => {
      expect(validatePlan([task('cola', ['src/q.ts'], ['contratos'])], { knownTaskIds: known }).issues).toEqual([]);
    });

    // Corregido (hallazgo de c2): depender de una tarea que no pasó el esquema ya no suma un unknown_dependency
    // falso; el error de esquema de esa tarea basta.
    it('depender de una tarea que no pasó el esquema no cuenta como inexistente', () => {
      const result = validatePlan([task('contratos', ['src/shared/**'], [], { difficulty: 'x' }), task('cola', ['src/q.ts'], ['contratos'])]);
      expect(codes(result.issues)).toEqual(['schema']);
    });

    it('informa ciclos con sus tareas sin repetir y los autociclos aparte', () => {
      const result = validatePlan([task('cola', ['src/q.ts'], ['router']), task('router', ['src/r.ts'], ['cola']), task('flota', ['src/f.ts'], ['flota'])]);
      expect(result.issues).toEqual([
        { code: 'cycle', message: 'Ciclo de dependencias: cola → router → cola (→ = «depende de»).', taskIds: ['cola', 'router'] },
        { code: 'cycle', message: 'Tarea flota: depende de sí misma.', taskIds: ['flota'] },
      ]);
    });

    it('un DAG con dependencias compartidas es válido', () => {
      const result = validatePlan([task('base', ['src/base/**']), task('izq', ['src/izq/**'], ['base']), task('der', ['src/der/**'], ['base']), task('final', ['src/final/**'], ['izq', 'der'])]);
      expect(result.issues).toEqual([]);
    });
  });
});

describe('extractJsonArray', () => {
  const tasks = [{ id: 'cola' }, { id: 'router' }];

  it.each([
    ['arreglo pelado', json(tasks)],
    ['con espacios y saltos', `\n\n  ${json(tasks)}  \n`],
    ['bloque ```json', `\`\`\`json\n${json(tasks)}\n\`\`\``],
    ['bloque ``` sin lenguaje', `\`\`\`\n${json(tasks)}\n\`\`\``],
    ['bloque ```JSON en mayúsculas', `\`\`\`JSON\n${json(tasks)}\n\`\`\``],
    ['texto alrededor sin bloque', `Estas son las tareas: ${json(tasks)} ¿Sigo?`],
    ['primer bloque inválido y segundo válido', `\`\`\`json\n[{"id": \n\`\`\`\nCorrijo:\n\`\`\`json\n${json(tasks)}\n\`\`\``],
  ])('extrae el arreglo: %s', (_label, text) => {
    expect(extractJsonArray(text)).toEqual({ ok: true, value: tasks });
  });

  it('extrae un objeto { tasks } completo', () => {
    expect(extractJsonArray(json({ tasks }))).toEqual({ ok: true, value: { tasks } });
  });

  it('con prosa alrededor de { tasks } gana el arreglo interior (equivalente para validatePlan)', () => {
    expect(extractJsonArray(`Respuesta:\n${json({ tasks })}`)).toEqual({ ok: true, value: tasks });
  });

  it.each(['[{"id": "cola",', '```json\n{"id": \n```'])('falla con %j', (text) => {
    const result = extractJsonArray(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^JSON inválido: /);
  });

  // Corregido (hallazgo de c9): el mensaje «La respuesta no contiene JSON.» era inalcanzable.
  it.each(['', 'No puedo hacer eso.'])('una respuesta sin JSON (%j) dice «La respuesta no contiene JSON.»', (text) => {
    expect(extractJsonArray(text)).toEqual({ ok: false, error: 'La respuesta no contiene JSON.' });
  });

  // Corregido (hallazgo de c9): se cortaba desde el primer «[»; ahora se prueba cada tramo balanceado hasta el
  // primero que parsee.
  it('tolera corchetes en el texto previo al arreglo', () => {
    expect(extractJsonArray(`Plan [v2], 2 tareas:\n${json(tasks)}`)).toEqual({ ok: true, value: tasks });
  });
});

describe('plannerSystemPrompt', () => {
  it('es estable (caché de prompts) e incluye las reglas y el esquema JSON de TaskBrief', () => {
    const prompt = plannerSystemPrompt();
    expect(plannerSystemPrompt()).toBe(prompt);
    expect(prompt).toContain('Responde SOLO con un arreglo JSON de tareas');
    expect(prompt).toContain('No pueden solaparse entre tareas');
    expect(prompt).toContain('Solo ids existentes y sin ciclos');
    const schema: unknown = JSON.parse(prompt.split('\n').at(-1) ?? '');
    expect(schema).toMatchObject({ type: 'object', properties: { ownedPaths: { type: 'array' }, dependsOn: { type: 'array' } } });
    const { required } = z.object({ required: z.array(z.string()) }).parse(schema);
    expect(required).toEqual(expect.arrayContaining(['id', 'projectId', 'ownedPaths', 'dependsOn', 'acceptance', 'difficulty']));
    for (const optional of ['contextRefs', 'skillRefs', 'suggestedAgent']) expect(required).not.toContain(optional);
  });

  it('no lleva secretos', () => {
    expect(plannerSystemPrompt()).not.toContain(REDACTED);
  });
});
