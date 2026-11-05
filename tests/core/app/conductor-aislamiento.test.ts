/**
 * Issue 9 en la terminal (`createConductor`): la mente del proyecto ve solo sus tareas, las skills del hub y del
 * proyecto (no las de la carpeta del núcleo) y no lee la memoria de Obsidian con Read/Grep/Glob.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compose, type Composition } from '../../../src/core/app/compose.ts';
import { createConductor } from '../../../src/core/app/conductor.ts';
import { MemoryVault } from '../../../src/core/vault/index.ts';
import { USER_BASE_URL, anthropicRoutes, cleanupDirs, fakeKey, mockFetch, planJson, tempDir } from '../../integration/helpers.ts';
import { assistantText, brief, jsonOf, resultMessage, scriptedQuery, textOf } from '../conductor/fakes.ts';

const comps: Composition[] = [];
afterEach(async () => {
  for (const c of comps.splice(0)) c.close();
  await cleanupDirs();
});

const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n`;

async function setup(readRoots?: (dir: string) => string[]) {
  const dir = await tempDir('orq-c27-terminal-');
  const demo = path.join(dir, 'demo');
  const nucleo = path.join(dir, 'nucleo');
  const skills: [string, string, string][] = [
    [path.join(dir, 'hub', 'skills'), 'comun', 'Navegador comun del hub.'],
    [path.join(demo, '.agents', 'skills'), 'propia', 'Navegador propio de demo.'],
    [path.join(nucleo, '.agents', 'skills'), 'ajena', 'Navegador de la carpeta del nucleo.'],
  ];
  for (const [root, name, description] of skills) {
    await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, name, 'SKILL.md'), skillMd(name, description));
  }
  const comp = compose({
    env: { ORQ_DATA_DIR: path.join(dir, 'datos') },
    config: { port: 0, quotaRefreshMs: 0 },
    vault: new MemoryVault(),
    memoryDir: path.join(dir, 'memoria'),
    skillsHubDir: path.join(dir, 'hub'),
    projectDir: nucleo,
    detectors: [],
    anthropicFetch: mockFetch(anthropicRoutes(planJson('demo'))).fetch,
    hostEnv: () => ({ PATH: 'C:\\Windows' }),
    claude: { sdkVersion: '0.3.302' },
  });
  comps.push(comp);
  await comp.registry.addAgentFromKey({ provider: 'anthropic', apiKey: fakeKey(), baseUrl: USER_BASE_URL, displayName: 'Claude', id: 'claude', budgetUsd: 2 });
  const q = scriptedQuery(() => [assistantText('listo'), resultMessage('listo')]);
  const conductor = await createConductor(comp, { projectId: 'demo', cwd: demo, query: q.fn, quotaTimeoutMs: 1_000, ...(readRoots ? { readRoots: readRoots(dir) } : {}) });
  return { dir, demo, comp, q, conductor };
}

describe('conductor de la terminal: acotado al proyecto', () => {
  it('estado y el planificador solo ven las tareas de demo', async () => {
    const { comp, conductor } = await setup();
    try {
      comp.fleet.queue.add(brief('cola-demo', { projectId: 'demo' }));
      comp.fleet.queue.add(brief('cola-otro', { projectId: 'otro' }));
      const tools = conductor.session.tools;
      const summary = jsonOf(await tools.call('estado', {}));
      expect(summary).toMatchObject({ proyecto: 'demo', total: 1 });
      expect((summary.tareas as { id: string }[]).map((t) => t.id)).toEqual(['cola-demo']);
      expect(textOf(await tools.call('estado', { taskId: 'cola-otro' }))).toMatch(/no es de este proyecto \(demo\)/);
      expect(textOf(await tools.call('escribir_memoria', { proyecto: 'otro', nota: { tipo: 'resumen', texto: 'x' } }))).toMatch(/solo puedes escribir/);
    } finally {
      await conductor.close();
    }
  });

  it('buscar_skills: las del hub y las del proyecto, no las de la carpeta del núcleo', async () => {
    const { conductor } = await setup();
    try {
      const body = jsonOf(await conductor.session.tools.call('buscar_skills', { texto: 'navegador' }));
      expect((body.skills as { nombre: string }[]).map((s) => s.nombre).sort()).toEqual(['comun', 'propia']);
    } finally {
      await conductor.close();
    }
  });

  it('Read/Grep/Glob no entran en la memoria de Obsidian ni en la base del núcleo', async () => {
    // La carpeta de todo el banco se puede leer: lo que niegue el acceso a la memoria es `denyPaths`.
    const { dir, demo, comp, q, conductor } = await setup((root) => [root]);
    try {
      const reader = (async () => {
        for await (const e of conductor.session.events()) if (e.type === 'done') break;
      })();
      conductor.session.send('hola');
      await reader;
      const hooks = q.calls[0]?.options.hooks?.PreToolUse as { hooks: ((...a: unknown[]) => Promise<unknown>)[] }[] | undefined;
      const pre = hooks?.[0]?.hooks[0];
      const use = async (tool_name: string, tool_input: Record<string, unknown>) =>
        JSON.stringify(await pre?.({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: 'p', cwd: demo }, 't', { signal: new AbortController().signal }));
      expect(q.calls[0]?.options.additionalDirectories).toEqual([dir]);
      const vault = comp.memory.vaultPath;
      expect(await use('Read', { file_path: path.join(vault, 'Orquestador', 'Proyectos', 'otro', 'Contexto.md') })).toMatch(/deny.*credenciales/);
      expect(await use('Grep', { pattern: 'otro', path: vault })).toMatch(/deny.*credenciales/);
      expect(await use('Read', { file_path: comp.config.dbPath })).toMatch(/deny.*credenciales/);
      expect(await use('Read', { file_path: comp.config.vaultPath })).toMatch(/deny.*credenciales/);
      expect(await use('Read', { file_path: path.join(demo, '.agents', 'skills', 'propia', 'SKILL.md') })).toBe('{}');
    } finally {
      await conductor.close();
    }
  });
});
