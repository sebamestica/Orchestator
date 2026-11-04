import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgyCliAdapter } from '../../src/core/adapters/agy-cli/index.ts';
import { CodexCliAdapter } from '../../src/core/adapters/codex-cli/index.ts';
import { SqliteStore } from '../../src/core/store/index.ts';
import {
  agentConfigSchema,
  taskBriefSchema,
  type AgentAdapter,
  type AgentConfig,
  type AgentEvent,
  type RunContext,
  type TaskBrief,
} from '../../src/shared/index.ts';

interface AgentResultRow {
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationSeconds: number;
}

interface ClaudeAdapterModule {
  ClaudeSdkAdapter: new (opts: { config: AgentConfig }) => AgentAdapter;
}

const claudeAdapterPath = join(process.cwd(), 'src', 'core', 'adapters', 'claude-sdk', 'index.ts');
// La clave llega desde WSL con WSLENV=ANTHROPIC_API_KEY/w:ANTHROPIC_BASE_URL/w (con /w).
const hasClaudeSdk = existsSync(claudeAdapterPath) && !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(process.env.ORQ_LIVE !== '1')('Aceptación F1: los agentes responden y el consumo queda guardado', () => {
  let storeDir: string;
  let store: SqliteStore;
  const results: AgentResultRow[] = [];

  beforeAll(async () => {
    storeDir = await mkdtemp(join(tmpdir(), 'orq-f1-store-'));
    store = new SqliteStore({ path: join(storeDir, 'f1-store.db') });
  });

  afterAll(async () => {
    if (results.length > 0) {
      const tableLines = [
        '',
        '=== Tabla de Consumo Real por Agente (F1 Aceptación) ===',
        'Agente | Modelo | Tokens Entrada | Tokens Salida | Costo (USD) | Duración (s)',
        '---|---|---|---|---|---',
        ...results.map((r) =>
          [
            r.agentId,
            r.model,
            String(r.inputTokens),
            String(r.outputTokens),
            r.costUsd > 0 ? `$${r.costUsd.toFixed(4)}` : '0',
            r.durationSeconds.toFixed(2),
          ].join(' | '),
        ),
        '========================================================',
        '',
      ];
      console.warn(tableLines.join('\n'));
    }
    if (store) {
      store.close();
    }
    if (storeDir) {
      try {
        await rm(storeDir, { recursive: true, force: true });
      } catch {
        // Ignorar en Windows si hay retención temporal de archivos
      }
    }
  });

  async function executeAgentTest(adapter: AgentAdapter, config: AgentConfig): Promise<void> {
    const tempDir = await mkdtemp(join(tmpdir(), `orq-f1-wt-${config.id}-`));

    try {
      const gitInit = spawnSync('git', ['init'], { cwd: tempDir, shell: false });
      expect(gitInit.status).toBe(0);
      spawnSync('git', ['config', 'user.name', 'Orquestador Test'], { cwd: tempDir, shell: false });
      spawnSync('git', ['config', 'user.email', 'orquestador@local'], { cwd: tempDir, shell: false });
      await writeFile(join(tempDir, 'README.md'), '# F1 Acceptance Worktree\n', 'utf8');
      await writeFile(join(tempDir, 'AGENTS.md'), '# Reglas\nResponde exactamente: OK. No modifiques archivos.\n', 'utf8');
      spawnSync('git', ['add', '.'], { cwd: tempDir, shell: false });
      spawnSync('git', ['commit', '-m', 'initial'], { cwd: tempDir, shell: false });

      const task: TaskBrief = taskBriefSchema.parse({
        id: `task-${config.id}`,
        projectId: 'f1-live',
        title: `Prueba en vivo F1 - ${config.displayName}`,
        objective: 'Responde exactamente: OK. No modifiques archivos.',
        ownedPaths: ['README.md'],
        dependsOn: [],
        acceptance: ['Responde exactamente: OK'],
        difficulty: 'low',
      });

      const controller = new AbortController();
      const ctx: RunContext = {
        worktreePath: tempDir,
        env: {},
        signal: controller.signal,
        timeoutMs: 180_000,
      };

      const start = performance.now();
      const events: AgentEvent[] = [];
      let sessionId: string | undefined;

      for await (const event of adapter.run(task, ctx)) {
        sessionId = event.sessionId;
        events.push(event);
        store.append(event);
      }

      const durationSeconds = (performance.now() - start) / 1000;

      // 1. Verificación de eventos emitidos
      expect(sessionId).toBeDefined();
      if (!sessionId) {
        throw new Error('sessionId no fue emitido');
      }

      const doneEvents = events.filter((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done');
      expect(doneEvents.length).toBeGreaterThan(0);
      const lastDone = doneEvents[doneEvents.length - 1];
      expect(lastDone?.payload.ok).toBe(true);

      const textEvents = events.filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text');
      const fullText = textEvents.map((e) => e.payload.text).join(' ');
      const textHasOk = textEvents.some((e) => e.payload.text.includes('OK')) || fullText.includes('OK');
      expect(textHasOk).toBe(true);

      const usageEvents = events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage');
      expect(usageEvents.length).toBeGreaterThan(0);
      expect(usageEvents.some((e) => e.payload.inputTokens > 0)).toBe(true);

      // 2. Verificación de persistencia y consultas en SQLite
      const storedEvents = store.eventsSince(sessionId, -1);
      expect(storedEvents.length).toBe(events.length);
      expect(storedEvents.some((e) => e.type === 'done' && e.payload.ok)).toBe(true);
      expect(storedEvents.some((e) => e.type === 'usage' && e.payload.inputTokens > 0)).toBe(true);

      const storedTextEvents = storedEvents.filter((e): e is Extract<AgentEvent, { type: 'text' }> => e.type === 'text');
      const storedFullText = storedTextEvents.map((e) => e.payload.text).join(' ');
      expect(storedTextEvents.some((e) => e.payload.text.includes('OK')) || storedFullText.includes('OK')).toBe(true);

      const agentUsage = store.usageTotals({ groupBy: ['agent'], agentId: config.id });
      expect(agentUsage.length).toBe(1);
      const agentRow = agentUsage[0];
      if (!agentRow) {
        throw new Error('No se encontró el registro de uso del agente en SQLite');
      }
      expect(agentRow.agentId).toBe(config.id);
      expect(agentRow.inputTokens).toBeGreaterThan(0);
      expect(agentRow.entries).toBeGreaterThan(0);

      const sessionUsage = store.usageTotals({ groupBy: ['session'], sessionId });
      expect(sessionUsage.length).toBe(1);
      const sessionRow = sessionUsage[0];
      if (!sessionRow) {
        throw new Error('No se encontró el registro de uso de la sesión en SQLite');
      }
      expect(sessionRow.sessionId).toBe(sessionId);
      expect(sessionRow.inputTokens).toBeGreaterThan(0);
      expect(sessionRow.entries).toBeGreaterThan(0);

      results.push({
        agentId: config.id,
        model: config.model ?? 'default',
        inputTokens: agentRow.inputTokens,
        outputTokens: agentRow.outputTokens,
        costUsd: agentRow.costUsd,
        durationSeconds,
      });

      console.warn(
        `[F1 Aceptación] ${config.id} (${config.model ?? 'default'}): OK en ${durationSeconds.toFixed(2)}s | Tokens: in=${agentRow.inputTokens}, out=${agentRow.outputTokens} | Costo: ${agentRow.costUsd > 0 ? `$${agentRow.costUsd.toFixed(4)}` : '0'}`,
      );
    } finally {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignorar en Windows si hay retención temporal de archivos
      }
    }
  }

  it(
    'Codex CLI responde OK y su consumo queda registrado en SQLite',
    async () => {
      const config = agentConfigSchema.parse({
        id: 'codex-live',
        kind: 'codex-cli',
        provider: 'codex',
        displayName: 'Codex CLI Live',
      });
      const adapter = new CodexCliAdapter(config);
      await executeAgentTest(adapter, config);
    },
    240_000,
  );

  it(
    'agy CLI responde OK y su consumo queda registrado en SQLite',
    async () => {
      const config = agentConfigSchema.parse({
        id: 'agy-live',
        kind: 'agy-cli',
        provider: 'antigravity',
        displayName: 'Antigravity CLI Live',
        model: 'gemini-3.8-flash-low',
      });
      const adapter = new AgyCliAdapter(config);
      await executeAgentTest(adapter, config);
    },
    240_000,
  );

  it.skipIf(!hasClaudeSdk)(
    'Claude SDK responde OK y su consumo queda registrado en SQLite',
    async () => {
      const claudeModule = (await import(
        /* @vite-ignore */ pathToFileURL(claudeAdapterPath).href
      )) as ClaudeAdapterModule;
      const config = agentConfigSchema.parse({
        id: 'claude-live',
        kind: 'claude-sdk',
        provider: 'anthropic',
        displayName: 'Claude SDK Live',
        budgetUsd: 1,
      });
      const adapter = new claudeModule.ClaudeSdkAdapter({ config });
      await executeAgentTest(adapter, config);
    },
    240_000,
  );
});
