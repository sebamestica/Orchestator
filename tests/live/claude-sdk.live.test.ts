import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeSdkAdapter } from '../../src/core/adapters/claude-sdk/index.ts';
import {
  agentConfigSchema,
  agentEventSchema,
  redactSecrets,
  taskBriefSchema,
  type AgentConfig,
  type AgentEvent,
  type TaskBrief,
} from '../../src/shared/index.ts';

/**
 * Pruebas en vivo mínimas del adaptador claude-sdk (gastan cupo: ~0,55 USD en total). Solo con ORQ_LIVE=1
 * y la clave en el entorno. Desde WSL (ojo: el indicador de WSLENV para pasar a Windows es /w, no /u):
 *   WSLENV=ANTHROPIC_API_KEY/w:ANTHROPIC_BASE_URL/w scripts/win.sh "set ORQ_LIVE=1&& npx vitest run tests/live/claude-sdk.live.test.ts"
 * Con ORQ_RECORD=1 además graba los mensajes crudos del SDK (tachados) en fixtures/claude-sdk/*.jsonl.
 */

const live = process.env.ORQ_LIVE === '1' && !!process.env.ANTHROPIC_API_KEY;
const fixturePath = (name: string) => fileURLToPath(new URL(`../../fixtures/claude-sdk/${name}`, import.meta.url));
/** Marcador que sustituye a la carpeta temporal al grabar, para que la fixture no dependa del equipo. */
const FIXTURE_WORKTREE = 'C:\\orq-fixture\\worktree';

const baseConfig = {
  id: 'claude-live',
  kind: 'claude-sdk',
  provider: 'anthropic',
  displayName: 'Claude (prueba en vivo)',
};
const config = agentConfigSchema.parse({ ...baseConfig, budgetUsd: 2 });

function liveEnv(apiKey = process.env.ANTHROPIC_API_KEY ?? ''): Record<string, string> {
  const env: Record<string, string> = { ANTHROPIC_API_KEY: apiKey };
  if (process.env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
  return env;
}

function brief(id: string, objective: string, acceptance: string[]): TaskBrief {
  return taskBriefSchema.parse({ id, projectId: 'orquestador', title: id, objective, ownedPaths: ['(ninguna)'], dependsOn: [], acceptance, difficulty: 'low' });
}

/** Ejecuta el adaptador, valida cada evento y (con ORQ_RECORD=1) graba los mensajes crudos. */
async function runLive(cfg: AgentConfig, task: TaskBrief, dir: string, env: Record<string, string>, fixture: string): Promise<AgentEvent[]> {
  const raw: unknown[] = [];
  const adapter = new ClaudeSdkAdapter({ config: cfg, onSdkMessage: (m) => raw.push(m), extraOptions: { maxTurns: 6, effort: 'low' } });
  const events: AgentEvent[] = [];
  for await (const e of adapter.run(task, { worktreePath: dir, env, signal: new AbortController().signal, timeoutMs: 280_000 })) {
    events.push(agentEventSchema.parse(e));
  }
  if (process.env.ORQ_RECORD === '1') {
    const secrets = [env.ANTHROPIC_API_KEY ?? '', process.env.ANTHROPIC_API_KEY ?? ''];
    const escapedDir = JSON.stringify(dir).slice(1, -1);
    const lines = raw.map((m) =>
      redactSecrets(JSON.stringify(m), secrets)
        .split(escapedDir).join(FIXTURE_WORKTREE.replace(/\\/g, '\\\\'))
        .replace(/C:\\\\Users\\\\[^\\"]+/gi, 'C:\\\\Users\\\\usuario')
        .replace(/([A-Za-z]:\/Users\/)[^/"]+/g, '$1usuario')
        .replace(/(--Users-)[^-\\"]+/g, '$1usuario'),
    );
    writeFileSync(fixturePath(fixture), `${lines.join('\n')}\n`);
  }
  expect(JSON.stringify(events)).not.toContain(env.ANTHROPIC_API_KEY);
  return events;
}

describe.skipIf(!live)('claude-sdk en vivo', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'orq-claude-live-'));
    writeFileSync(join(dir, 'CLAUDE.md'), '# Reglas de prueba\n\nLa palabra clave de este proyecto es ARANDANO.\n');
  });
  afterAll(async () => {
    // Tras close() el proceso del CLI tarda unos segundos en salir y en Windows retiene la carpeta (EPERM).
    for (let attempt = 0; dir && attempt < 20; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    console.warn(`No se pudo borrar la carpeta temporal ${dir}`);
  }, 15_000);

  it('probe: la clave funciona, lista modelos y avisa si la URL es http://', async () => {
    const probe = await new ClaudeSdkAdapter({ config }).probe();
    expect(probe.authenticated).toBe(true);
    expect(probe.models.length).toBeGreaterThan(0);
    expect(probe.quotaMethod).toBe('manual-budget');
    if (process.env.ANTHROPIC_BASE_URL?.startsWith('http://')) {
      expect(probe.warnings.some((w) => w.includes('conexión sin cifrar'))).toBe(true);
    }
    expect(JSON.stringify(probe)).not.toContain(process.env.ANTHROPIC_API_KEY);
  });

  it('run: tarea mínima con un subagente, CLAUDE.md del proyecto, uso con costo y done', async () => {
    const task = brief(
      'live-subagente',
      [
        'No edites archivos ni ejecutes comandos.',
        'Paso 1: usa la herramienta Agent una sola vez (subagent_type "general-purpose") con este encargo exacto: «Responde exactamente SUB-OK. No uses herramientas.».',
        'Paso 2: cuando el subagente termine, responde en una sola línea exactamente: OK <palabra clave del proyecto según CLAUDE.md>. Sin informe ni nada más.',
      ].join('\n'),
      ['Un subagente respondió SUB-OK', 'La respuesta final es «OK» seguida de la palabra clave'],
    );
    const events = await runLive(config, task, dir, liveEnv(), 'subagent-run.jsonl');

    const done = events.at(-1);
    expect(done?.type).toBe('done');
    expect(done?.payload).toMatchObject({ ok: true });
    const finalText = events.filter((e) => e.type === 'text' && !e.parentSessionId).map((e) => (e.payload as { text: string }).text).join('\n');
    expect(finalText).toMatch(/OK/);
    expect(finalText).toMatch(/ARANDANO/i);
    expect(events.some((e) => e.parentSessionId !== undefined)).toBe(true);
    const usage = events.filter((e) => e.type === 'usage');
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.some((e) => ((e.payload as { costUsd?: number }).costUsd ?? 0) > 0)).toBe(true);
  }, 300_000);

  it('run: el hook deniega git "push" aunque .claude/settings.json permita Bash, y deja escribir dentro', async () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash', 'Bash(*)', 'Write', 'PowerShell'] } }));
    const cheap = agentConfigSchema.parse({ ...baseConfig, budgetUsd: 0.6 });
    const task = brief(
      'live-hook',
      [
        'Es una prueba de la política de permisos. Haz exactamente esto, en orden, sin reintentar de otra forma lo que te bloqueen:',
        'Paso 1: con la herramienta Bash ejecuta exactamente: git "push"',
        'Paso 2: con la herramienta Write crea el archivo hook-ok.txt con el contenido OK.',
        'Paso 3: responde en una sola línea: FIN <palabra clave de las reglas del repositorio>.',
      ].join('\n'),
      ['git "push" bloqueado', 'hook-ok.txt creado', 'Respuesta FIN con la palabra clave'],
    );
    const events = await runLive(cheap, task, dir, liveEnv(), 'hook-deny.jsonl');
    const calls = events.filter((e) => e.type === 'tool_call') as Extract<AgentEvent, { type: 'tool_call' }>[];
    const results = events.filter((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>[];
    const push = calls.find((e) => /push/.test(e.payload.inputSummary));
    expect(push?.payload.name).toMatch(/Bash|PowerShell/);
    const denied = results.find((e) => e.payload.callId === push?.payload.callId);
    expect(denied?.payload.ok).toBe(false);
    expect(denied?.payload.summary).toMatch(/Bloqueado por el orquestador/);
    expect(existsSync(join(dir, 'hook-ok.txt'))).toBe(true);
    expect(readFileSync(join(dir, 'hook-ok.txt'), 'utf8')).toMatch(/OK/);
    const finalText = events.filter((e) => e.type === 'text' && !e.parentSessionId).map((e) => (e.payload as { text: string }).text).join('\n');
    expect(finalText).toMatch(/ARANDANO/i);
    expect(events.at(-1)?.payload).toMatchObject({ ok: true });
  }, 300_000);

  it('run con clave inválida: error auth y done sin éxito (no gasta cupo)', async () => {
    const task = brief('live-auth', 'Responde exactamente: OK', ['Responde OK']);
    const events = await runLive(config, task, dir, liveEnv('sk-ant-api03-claveinvalidaparaprobar000000000000'), 'auth-error.jsonl');
    expect(events.find((e) => e.type === 'error')?.payload).toMatchObject({ code: 'auth' });
    expect(events.at(-1)?.payload).toMatchObject({ ok: false });
  }, 300_000);

  it('run con presupuesto mínimo: se corta en curso con quota_exhausted y registra lo gastado', async () => {
    const cheap = agentConfigSchema.parse({ ...baseConfig, budgetUsd: 0.01 });
    const task = brief('live-presupuesto', 'Lee el archivo CLAUDE.md con la herramienta Read y luego responde exactamente: OK', ['Responde OK']);
    const events = await runLive(cheap, task, dir, liveEnv(), 'budget-exceeded.jsonl');
    expect(events.find((e) => e.type === 'error')?.payload).toMatchObject({ code: 'quota_exhausted' });
    expect(events.some((e) => e.type === 'usage' && ((e.payload as { costUsd?: number }).costUsd ?? 0) > 0)).toBe(true);
    expect(events.at(-1)?.payload).toMatchObject({ ok: false });
  }, 300_000);
});
