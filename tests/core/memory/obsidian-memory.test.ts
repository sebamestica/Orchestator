import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderBrief } from '../../../src/core/brief/render-brief.ts';
import { estimateTokens } from '../../../src/core/memory/context.ts';
import { parseNote } from '../../../src/core/memory/frontmatter.ts';
import { ObsidianMemory } from '../../../src/core/memory/obsidian-memory.ts';
import type { SessionSummary, TaskBrief } from '../../../src/shared/index.ts';
import { taskBriefSchema } from '../../../src/shared/index.ts';

const repo = path.resolve(import.meta.dirname, '../../..');

/** Consumo real grabado de Codex (`turn.completed.usage`) y de un registro de sesión (`token_count`). */
function realUsages(): { input: number; output: number }[] {
  const out: { input: number; output: number }[] = [];
  for (const file of ['fixtures/codex/exec-ok.jsonl', 'fixtures/codex/rollout-token-count.jsonl']) {
    for (const line of readFileSync(path.join(repo, file), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line) as { usage?: { input_tokens: number; output_tokens: number }; payload?: { info?: { last_token_usage?: { input_tokens: number; output_tokens: number } } } };
      const usage = ev.usage ?? ev.payload?.info?.last_token_usage;
      if (usage) out.push({ input: usage.input_tokens, output: usage.output_tokens });
    }
  }
  return out;
}

/** Secciones reales de PLAN.md como resúmenes de sesión (texto largo y variado, determinista). */
function planSections(): { title: string; text: string }[] {
  const plan = readFileSync(path.join(repo, 'PLAN.md'), 'utf8').replace(/\r\n/g, '\n');
  return plan.split(/\n(?=###? )/).slice(1).map((chunk) => {
    const [heading = '', ...rest] = chunk.split('\n');
    return { title: heading.replace(/^#+\s*/, '').replace(/^[\d.]+\s*/, ''), text: rest.join('\n').trim() };
  }).filter((s) => s.text.length > 200);
}

/** Encargos de la flota real del 2026-11-01 (ids, rutas y títulos de los BRIEF). */
const FLEET = [
  { taskId: 'c1-claude-sdk', agentId: 'claude-1', title: 'Adaptador del SDK de agentes de Claude', files: ['src/core/adapters/claude-sdk.ts', 'tests/core/adapters/claude-sdk.test.ts'] },
  { taskId: 'c2-orquestacion', agentId: 'claude-2', title: 'Cola de tareas y router por cupo', files: ['src/core/orchestrator/router.ts', 'src/core/orchestrator/queue.ts'] },
  { taskId: 'c3-workspace', agentId: 'claude-3', title: 'Worktrees y candados por tarea', files: ['src/core/workspace/worktree.ts'] },
  { taskId: 'c4-memoria', agentId: 'claude-4', title: 'Memoria en Obsidian y hub de skills', files: ['src/core/memory/obsidian-memory.ts', 'src/core/skills/skill-hub.ts'] },
  { taskId: 'c5-servidor', agentId: 'claude-5', title: 'Servidor local y WebSocket', files: ['src/core/server/app.ts'] },
  { taskId: 'codex-cli', agentId: 'codex', title: 'Adaptador de Codex CLI', files: ['src/core/adapters/codex-cli.ts'] },
  { taskId: 'agy-cli', agentId: 'agy', title: 'Adaptador de agy CLI', files: ['src/core/adapters/agy-cli.ts'] },
] as const;

function pick<T>(items: readonly T[], index: number): T {
  const item = items[index % items.length];
  if (item === undefined) throw new Error('fixture vacía');
  return item;
}

function fleetSessions(count: number): SessionSummary[] {
  const usages = realUsages();
  const sections = planSections();
  const out: SessionSummary[] = [];
  for (let k = 0; k < count; k++) {
    const member = pick(FLEET, k);
    const usage = pick(usages, k);
    const section = pick(sections, k);
    const day = String(1 + Math.floor(k / FLEET.length)).padStart(2, '0');
    out.push({
      projectId: 'orquestador',
      taskId: member.taskId,
      agentId: member.agentId,
      title: `${member.title} (${section.title})`,
      outcome: k % 5 === 4 ? 'handed_off' : 'ok',
      summary: section.text,
      filesChanged: [...member.files],
      inputTokens: usage.input,
      outputTokens: usage.output,
      costUsd: 0.103,
      at: `2026-10-${day}T1${k % 10}:00:00Z`,
    });
  }
  return out;
}

function task(overrides: Partial<TaskBrief> = {}): TaskBrief {
  return taskBriefSchema.parse({
    id: 'c4-memoria-v2', projectId: 'orquestador', title: 'Mejorar la memoria en Obsidian',
    objective: 'Afinar buildContext', ownedPaths: ['src/core/memory/**', 'tests/core/memory/**'],
    dependsOn: [], acceptance: ['pruebas en verde'], difficulty: 'medium', ...overrides,
  });
}

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await allFiles(full)));
    else out.push(full);
  }
  return out.sort();
}

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

let vault: string;
beforeEach(async () => { vault = await mkdtemp(path.join(os.tmpdir(), 'orq-boveda-')); });
afterEach(async () => { await rm(vault, { recursive: true, force: true }); });

describe('ObsidianMemory.recordSession', () => {
  it('crea notas válidas para Obsidian (frontmatter + enlaces que resuelven) y las relee', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    const [first, second] = fleetSessions(2) as [SessionSummary, SessionSummary];
    await memory.recordSession(first);
    await memory.recordSession({ ...second, agentId: first.agentId });

    const files = (await allFiles(vault)).map((f) => path.relative(vault, f).replace(/\\/g, '/'));
    expect(files).toEqual([
      'Orquestador/Agentes/claude-1.md',
      'Orquestador/Proyectos/orquestador/Contexto.md',
      `Orquestador/Sesiones/${first.at.slice(0, 10)}-c1-claude-sdk.md`,
      `Orquestador/Sesiones/${second.at.slice(0, 10)}-c2-orquestacion.md`,
    ]);
    expect(existsSync(path.join(vault, 'Orquestador', 'Decisiones'))).toBe(true);

    for (const rel of files) {
      const text = await readFile(path.join(vault, rel), 'utf8');
      const note = parseNote(text); // modo estricto: el YAML que escribimos no necesita tolerancia
      expect(note.hasFrontmatter, rel).toBe(true);
      expect(Array.isArray(note.data.tags), rel).toBe(true);
      const links = [...note.body.matchAll(WIKILINK)].map((m) => m[1] ?? '');
      expect(links.length, rel).toBeGreaterThan(0);
      for (const link of links) expect(existsSync(path.join(vault, `${link}.md`)), `${rel} → [[${link}]]`).toBe(true);
    }

    const session = parseNote(await readFile(path.join(vault, pick(files, 2)), 'utf8'));
    expect(session.data).toMatchObject({
      tipo: 'sesion', proyecto: 'orquestador', tarea: 'c1-claude-sdk', agente: 'claude-1', resultado: 'ok',
      fecha: first.at.slice(0, 10), at: first.at, tokens_entrada: first.inputTokens, tokens_salida: first.outputTokens,
      costo_usd: 0.103, archivos: first.filesChanged,
    });
    expect(session.body).toContain('[[Orquestador/Proyectos/orquestador/Contexto|orquestador]]');
    expect(session.body).toContain('[[Orquestador/Agentes/claude-1|claude-1]]');

    const agent = parseNote(await readFile(path.join(vault, pick(files, 0)), 'utf8'));
    expect(agent.data).toMatchObject({
      tipo: 'agente', sesiones: 2,
      tokens_entrada: first.inputTokens + second.inputTokens,
      tokens_salida: first.outputTokens + second.outputTokens,
      tokens_total: first.inputTokens + first.outputTokens + second.inputTokens + second.outputTokens,
      costo_usd: 0.206,
    });
    expect(agent.body.match(/\[\[Orquestador\/Sesiones\//g)).toHaveLength(2);

    const project = parseNote(await readFile(path.join(vault, pick(files, 1)), 'utf8'));
    expect(project.data).toMatchObject({ tipo: 'proyecto', sesiones: 2 });
    const log = project.body.slice(project.body.indexOf('## Bitácora'));
    expect(log.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(2);
  });

  it('es idempotente para la misma sesión y numera otra sesión de la misma tarea y día', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    const [s] = fleetSessions(1) as [SessionSummary];
    await memory.recordSession(s);
    await memory.recordSession(s);
    await memory.recordSession({ ...s, at: s.at.replace('T10', 'T11') });
    const sessions = await readdir(path.join(vault, 'Orquestador', 'Sesiones'));
    expect(sessions.sort()).toEqual([`${s.at.slice(0, 10)}-c1-claude-sdk-2.md`, `${s.at.slice(0, 10)}-c1-claude-sdk.md`]);
    const agent = parseNote(await readFile(path.join(vault, 'Orquestador', 'Agentes', 'claude-1.md'), 'utf8'));
    expect(agent.data.sesiones).toBe(2);
    expect(agent.data.tokens_entrada).toBe(2 * s.inputTokens);
  });

  it('suma bien con escrituras concurrentes', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    const sessions = fleetSessions(14).map((s) => ({ ...s, agentId: 'claude-1' }));
    await Promise.all(sessions.map((s) => memory.recordSession(s)));
    const agent = parseNote(await readFile(path.join(vault, 'Orquestador', 'Agentes', 'claude-1.md'), 'utf8'));
    expect(agent.data.sesiones).toBe(14);
    expect(agent.data.tokens_entrada).toBe(sessions.reduce((n, s) => n + s.inputTokens, 0));
    expect(agent.data.costo_usd).toBe(1.442);
  }, 60_000);

  it('tacha secretos en notas de sesión, bitácora y agente', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault, extraSecrets: ['secreto-del-usuario-123'] });
    const [s] = fleetSessions(1) as [SessionSummary];
    await memory.recordSession({
      ...s,
      title: 'Probé con sk-ant-api03-AAAAAAAAAAAAAAAAAAAA',
      summary: 'Usé ANTHROPIC_API_KEY=sk-ant-api03-BBBBBBBBBBBBBBBBBBBB y el token secreto-del-usuario-123.\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
      filesChanged: ['config/sk-or-v1-CCCCCCCCCCCCCCCCCCCCCCCC.json'],
    });
    for (const file of await allFiles(vault)) {
      const text = await readFile(file, 'utf8');
      expect(text).not.toMatch(/sk-ant-api03|sk-or-v1-C|secreto-del-usuario|abcdefghijklmnop/);
    }
    const session = await readFile(path.join(vault, 'Orquestador', 'Sesiones', `${s.at.slice(0, 10)}-c1-claude-sdk.md`), 'utf8');
    expect(session).toContain('[REDACTADO]');
  });

  it('valida la entrada y no escribe con ids que intenten salir de la bóveda', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    const [s] = fleetSessions(1) as [SessionSummary];
    for (const bad of [{ projectId: '../fuera' }, { taskId: '..\\..\\x' }, { agentId: 'C:/Windows' }, { at: 'ayer' }]) {
      await expect(memory.recordSession({ ...s, ...bad })).rejects.toThrow();
    }
    expect(await readdir(vault)).toEqual([]);
    expect(() => new ObsidianMemory({ vaultPath: vault, rootFolder: '../fuera' })).toThrow();
    expect(new ObsidianMemory({ vaultPath: vault, rootFolder: 'IA\\Orquestador' }).projectNote('orquestador')).toBe('IA/Orquestador/Proyectos/orquestador/Contexto');
  });

  it('conserva lo que el usuario edita a mano en Contexto.md', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    const [a, b] = fleetSessions(2) as [SessionSummary, SessionSummary];
    await memory.recordSession(a);
    const file = path.join(vault, 'Orquestador', 'Proyectos', 'orquestador', 'Contexto.md');
    const edited = (await readFile(file, 'utf8'))
      .replace(/%%.*%%/, 'Núcleo en TypeScript para Windows.')
      .replace('## Bitácora', '## Rutas clave\n- `src/shared/` contratos\n\n## Bitácora');
    await writeFile(file, edited.replace('tags:', 'cssclasses: [ancho]\ntags:'));
    await memory.recordSession(b);
    const after = await readFile(file, 'utf8');
    expect(after).toContain('Núcleo en TypeScript para Windows.');
    expect(after).toContain('## Rutas clave\n- `src/shared/` contratos');
    expect(parseNote(after).data).toMatchObject({ cssclasses: ['ancho'], sesiones: 2 });
  });

  it('registra decisiones en Decisiones/ con enlace al proyecto', async () => {
    const memory = new ObsidianMemory({ vaultPath: vault });
    const note = await memory.recordDecision({ projectId: 'orquestador', title: 'Usar node:sqlite en vez de better-sqlite3', text: 'Sin compilación nativa.', at: '2026-11-01T12:00:00Z', agentId: 'claude-4' });
    expect(note).toBe('Orquestador/Decisiones/2026-11-01-usar-node-sqlite-en-vez-de-better-sqlite3');
    const parsed = parseNote(await readFile(path.join(vault, `${note}.md`), 'utf8'));
    expect(parsed.data).toMatchObject({ tipo: 'decision', proyecto: 'orquestador', agente: 'claude-4' });
    expect(parsed.body).toContain('[[Orquestador/Proyectos/orquestador/Contexto|orquestador]]');
  });
});

describe('ObsidianMemory.buildContext', () => {
  async function seeded(count = 35, vaultPath = vault): Promise<ObsidianMemory> {
    const memory = new ObsidianMemory({ vaultPath });
    for (const s of fleetSessions(count)) await memory.recordSession(s);
    await memory.writeProjectSummary('orquestador', 'Núcleo del orquestador en TypeScript (Node 24, Windows). Contratos en `src/shared/`; cada módulo en `src/core/<módulo>`.', '2026-11-01T00:00:00Z');
    return memory;
  }

  // Bóveda de 35 sesiones compartida por las pruebas que solo leen (se crea una vez: cada sesión toma el candado).
  let shared: Promise<ObsidianMemory> | undefined;
  let sharedDir: string | undefined;
  const seededShared = () => {
    shared ??= mkdtemp(path.join(os.tmpdir(), 'orq-boveda-35-')).then((dir) => { sharedDir = dir; return seeded(35, dir); });
    return shared;
  };
  afterAll(async () => { if (sharedDir) await rm(sharedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  it('empieza por el resumen del proyecto y luego las sesiones pertinentes, más pertinentes primero', async () => {
    const memory = await seededShared();
    const context = await memory.buildContext('orquestador', task(), 4000);
    expect(context.startsWith('### Resumen del proyecto orquestador\nNúcleo del orquestador')).toBe(true);
    expect(context).not.toContain('## Bitácora');
    expect(context).not.toContain('%%');
    const items = context.split('\n').filter((l) => l.startsWith('- '));
    expect(items.length).toBeGreaterThan(0);
    // Las sesiones que tocaron src/core/memory/** (c4-memoria) van antes que el resto.
    expect(items[0]).toContain('c4-memoria');
    expect(context).toContain('(Orquestador/Sesiones/');
  }, 60_000);

  it('sin coincidencias solo manda el resumen del proyecto', async () => {
    const memory = await seeded(7);
    const context = await memory.buildContext('orquestador', task({ title: 'Instalador NSIS', ownedPaths: ['apps/desktop/**'] }), 4000);
    expect(context).toContain('### Resumen del proyecto');
    expect(context).not.toContain('### Sesiones');
  });

  it('la misma tarea (traspaso) es lo más pertinente', async () => {
    const memory = await seeded(14);
    const context = await memory.buildContext('orquestador', task({ id: 'codex-cli', title: 'Continuar tarea', ownedPaths: ['otra/ruta/**'] }), 3000);
    const items = context.split('\n').filter((l) => l.startsWith('- '));
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.slice(0, 2).every((l) => l.includes(' · codex-cli · '))).toBe(true);
  }, 60_000);

  it('respeta el presupuesto en todo el rango y es determinista', async () => {
    const memory = await seededShared();
    const other = new ObsidianMemory({ vaultPath: memory.vaultPath });
    for (const budget of [0, 1, 10, 37, 80, 150, 300, 700, 1500, 3000, 8000, 50_000]) {
      const a = await memory.buildContext('orquestador', task(), budget);
      expect(a.length, `presupuesto ${budget}`).toBeLessThanOrEqual(budget);
      // Otra instancia (sin estado compartido) da exactamente lo mismo; se comprueba en una muestra del rango.
      if ([37, 700, 8000].includes(budget)) expect(await other.buildContext('orquestador', task(), budget)).toBe(a);
    }
    expect(await memory.buildContext('orquestador', task(), Number.NaN)).toBe('');
    expect(await memory.buildContext('otro-proyecto', task(), 1000)).toBe('');
  }, 60_000);

  it('no filtra secretos aunque alguien los escriba a mano en las notas', async () => {
    const memory = await seeded(7);
    const dir = path.join(vault, 'Orquestador', 'Sesiones');
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name);
      const text = await readFile(file, 'utf8');
      await writeFile(file, text.replace('## Resumen\n', '## Resumen\nClave pegada: sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZ. '));
    }
    const contexto = path.join(vault, 'Orquestador', 'Proyectos', 'orquestador', 'Contexto.md');
    await writeFile(contexto, (await readFile(contexto, 'utf8')).replace('Núcleo', 'AIzaSyA1234567890abcdefghijklmnopqrstu Núcleo'));
    for (const budget of [60, 200, 1000, 5000]) {
      const context = await memory.buildContext('orquestador', task(), budget);
      expect(context).not.toMatch(/sk-ant|AIzaSy|ZZZZZZZZZZ/);
    }
    expect(await memory.buildContext('orquestador', task(), 5000)).toContain('[REDACTADO]');
  });

  it('mide el ahorro de tokens frente a mandar el historial completo', async ({ annotate }) => {
    const memory = await seededShared();
    const { context, savings } = await memory.measureContext('orquestador', task(), 2000);
    const full = await memory.fullHistory('orquestador');
    expect(savings.contextTokens).toBe(estimateTokens(context));
    expect(savings.fullTokens).toBe(estimateTokens(full));
    expect(savings.fullTokens).toBeGreaterThan(10_000);
    expect(savings.contextTokens).toBeLessThanOrEqual(500);
    expect(savings.savedTokens).toBe(savings.fullTokens - savings.contextTokens);
    expect(savings.savedRatio).toBeGreaterThan(0.95);

    // El encargo completo que recibe el agente (render-brief) con el contexto recortado frente al historial entero.
    const trimmedBrief = estimateTokens(renderBrief(task(), undefined, { memoryContext: context }));
    const fullBrief = estimateTokens(renderBrief(task(), undefined, { memoryContext: full }));
    expect(trimmedBrief).toBeLessThan(fullBrief / 10);
    await annotate(`35 sesiones, presupuesto 2000 car.: contexto ${savings.contextChars} car. ≈ ${savings.contextTokens} tokens; historial ${savings.fullChars} car. ≈ ${savings.fullTokens} tokens; ahorro ${savings.savedTokens} tokens (${(savings.savedRatio * 100).toFixed(1)} %). Encargo: ${trimmedBrief} vs ${fullBrief} tokens.`);
  });
});
