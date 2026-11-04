import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { compose, type Composition } from '../../src/core/app/compose.ts';
import { acquire, release, type LockHandle } from '../../src/core/locks/index.ts';
import { INTEGRATION_DIR } from '../../src/core/workspace/index.ts';
import { taskBriefSchema, type TaskBrief, type Workspace } from '../../src/shared/index.ts';

/**
 * Aceptación de F3 (gasta saldo de la clave de Claude, tope 3 USD, y cupo de Codex y agy). Las 3 tareas del repo de
 * ejemplo en paralelo con la flota real: claude (clave desde la bóveda), codex y agy; revisión cruzada; integración
 * solo con el gate `node --test`. Ejecutar como mucho 2 veces. Desde WSL:
 *   WSLENV=ANTHROPIC_API_KEY/w:ANTHROPIC_BASE_URL/w scripts/win.sh "set ORQ_LIVE=1&& npx vitest run tests/live/f3-acceptance.live.test.ts"
 */
const live = process.env.ORQ_LIVE === '1' && !!process.env.ANTHROPIC_API_KEY && process.platform === 'win32';
const fixture = (rel: string) => fileURLToPath(new URL(`../../fixtures/repo-ejemplo/${rel}`, import.meta.url));
const PROJECT = 'repo-ejemplo';
const ASSIGN: Record<string, string> = { 'task-slug': 'claude', 'task-case': 'codex', 'task-truncate': 'agy' };

interface ExecRow { taskId: string; role: 'autor' | 'revisor'; agentId: string; input: number; output: number; cost: number }

describe.skipIf(!live)('Aceptación F3: flota real con claude, codex y agy', () => {
  const key = process.env.ANTHROPIC_API_KEY ?? '';
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  let root = '';
  let worktreesRoot = '';
  const log: string[] = [];
  let comp: Composition | undefined;
  let lock: LockHandle | undefined;

  afterAll(async () => {
    if (lock) await release(lock.name, lock).catch((err: unknown) => console.warn(`no se liberó el candado e2e: ${String(err)}`));
    process.env.ANTHROPIC_API_KEY = key;
    if (baseUrl) process.env.ANTHROPIC_BASE_URL = baseUrl;
    // Worktrees fuera con el gestor de c3 (quita los enlaces antes de `git worktree remove`); luego la carpeta temporal.
    if (!root) return;
    const leftovers: Workspace[] = existsSync(worktreesRoot)
      ? readdirSync(worktreesRoot).filter((d) => !d.startsWith('_h')).map((d) => ({ taskId: d, path: join(worktreesRoot, d), branch: d === '_integracion' ? 'orq/integracion' : `orq/${d}` }))
      : [];
    for (const w of leftovers) await comp?.workspaces.remove(w).catch((err: unknown) => console.warn(`no se quitó ${w.path}: ${String(err)}`));
    await comp?.shutdown();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => console.warn(`No se pudo borrar ${root}`));
  }, 120_000);

  it('3 tareas en paralelo, revisión cruzada, integración con gate y nada fuera de la rama de integración', async () => {
    // Recurso compartido de la flota (skill local-compute-scheduling): una prueba e2e a la vez.
    lock = await acquire('e2e', { agent: 'c12', task: 'aceptacion-f3' }, { timeoutMs: 10 * 60_000, retryMs: 5_000 });
    root = mkdtempSync(join(tmpdir(), 'orq-f3-'));
    const repo = join(root, 'repo');
    worktreesRoot = join(root, 'wt');
    const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=Usuario', '-c', 'user.email=usuario@local', ...args], { cwd, encoding: 'utf8' });
    // Repo del usuario desde la plantilla, con un remoto local para comprobar que el push está bloqueado.
    cpSync(fixture('plantilla'), repo, { recursive: true });
    const remote = join(root, 'remoto.git');
    expect(spawnSync('git', ['init', '-q', '--bare', remote]).status).toBe(0);
    for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-q', '-m', 'plantilla'], ['remote', 'add', 'origin', remote]]) expect(git(repo, ...args).status).toBe(0);
    const mainBefore = git(repo, 'rev-parse', 'main').stdout.trim();
    expect(spawnSync('node', ['--test'], { cwd: repo, encoding: 'utf8' }).status).toBe(0);

    const rows: ExecRow[] = [];
    const times = new Map<string, { start?: number; end?: number }>();
    comp = compose({
      env: { ORQ_DATA_DIR: join(root, 'datos') },
      config: { port: 0, quotaRefreshMs: 0 },
      memoryDir: join(root, 'memoria'),
      detectors: [],
      workspaceProjects: [{ id: PROJECT, repoPath: repo, worktreesRoot, gate: [{ command: 'node', args: ['--test'] }] }],
      claude: { extraOptions: { maxTurns: 40, effort: 'low' } },
      fleet: {
        concurrency: 3,
        timeoutMs: 20 * 60_000,
        onExecuted: (task, _opts, result) => {
          const review = task.id.endsWith('-revision');
          for (const a of result.attempts) {
            rows.push({ taskId: review ? task.id.slice(0, -'-revision'.length) : task.id, role: review ? 'revisor' : 'autor', agentId: a.agentId, input: a.usage.inputTokens, output: a.usage.outputTokens, cost: a.usage.costUsd ?? 0 });
          }
        },
      },
      log: (l) => log.push(l),
    });
    const c = comp;

    // Agentes: la clave de Claude entra a la bóveda DPAPI y desaparece del entorno; Codex y agy con su sesión.
    await c.registry.addAgentFromKey({ provider: 'anthropic', apiKey: key, ...(baseUrl ? { baseUrl } : {}), displayName: 'Claude', id: 'claude', budgetUsd: 3 });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    c.registry.put({ id: 'codex', kind: 'codex-cli', provider: 'codex', displayName: 'Codex', quotaFloor: 0 });
    c.registry.put({ id: 'agy', kind: 'agy-cli', provider: 'antigravity', displayName: 'agy', model: 'gemini-3.8-flash-low', quotaFloor: 0 });
    for (const id of ['codex', 'agy']) expect((await c.registry.probe(id)).probe).toMatchObject({ installed: true, authenticated: true });

    const tasks: TaskBrief[] = (JSON.parse(readFileSync(fixture('tareas.json'), 'utf8')) as unknown[]).map((t) => taskBriefSchema.parse({ ...(t as object), suggestedAgent: ASSIGN[(t as { id: string }).id] }));
    const { fleet } = await c.fleet.runtime();
    c.fleet.queue.on((ch) => {
      const t = times.get(ch.taskId) ?? {};
      if (ch.to === 'running' && t.start === undefined) t.start = Date.parse(ch.at);
      if (['integrated', 'failed', 'cancelled'].includes(ch.to)) t.end = Date.parse(ch.at);
      times.set(ch.taskId, t);
    });
    c.fleet.queue.addAll(tasks);
    const report = await fleet.run();

    // Tabla por tarea: autor, revisor, resultado, tokens, costo y duración.
    const table = report.tasks.map((r) => {
      const mine = rows.filter((x) => x.taskId === r.taskId);
      const t = times.get(r.taskId) ?? {};
      return {
        tarea: r.taskId,
        autor: r.authors.join('→'),
        revisor: r.reviewers.join('→'),
        resultado: r.state,
        tokens: `${mine.reduce((n, x) => n + x.input, 0)}/${mine.reduce((n, x) => n + x.output, 0)}`,
        costoUsd: Number(mine.reduce((n, x) => n + x.cost, 0).toFixed(4)),
        segundos: t.start && t.end ? Math.round((t.end - t.start) / 1000) : null,
        detalle: r.detail ?? r.integration?.gateSummary.split('\n')[0] ?? '',
      };
    });
    console.warn(`\nF3 por tarea:\n${JSON.stringify(table, null, 1)}\nF3 por ejecución:\n${JSON.stringify(rows)}\nAvisos: ${JSON.stringify(log.slice(-30))}`);

    // 1. Las 3 integradas, cada agente autor de una y revisada por otro.
    expect(report.states).toEqual({ 'task-slug': 'integrated', 'task-case': 'integrated', 'task-truncate': 'integrated' });
    for (const r of report.tasks) {
      expect(r.authors).toEqual([ASSIGN[r.taskId]]);
      expect(r.reviewers.length).toBeGreaterThan(0);
      expect(r.reviewers.some((x) => r.authors.includes(x))).toBe(false);
    }
    // 2. Gate en verde en la rama de integración final, con las 3 implementaciones.
    const integration = join(worktreesRoot, INTEGRATION_DIR);
    expect(spawnSync('node', ['--test'], { cwd: integration, encoding: 'utf8' }).status).toBe(0);
    for (const f of ['src/slug.mjs', 'src/case.mjs', 'src/truncate.mjs']) expect(git(repo, 'show', `orq/integracion:${f}`).stdout).not.toBe(readFileSync(fixture(`plantilla/${f}`), 'utf8'));
    // 3. Eventos y uso de los 3 agentes en SQLite.
    const usage = c.store.usageTotals({ groupBy: ['agent'] });
    for (const id of ['claude', 'codex', 'agy']) {
      const row = usage.find((u) => u.agentId === id);
      expect(row && row.inputTokens + row.outputTokens).toBeGreaterThan(0);
      expect(c.store.listSessions({ agentId: id }).length).toBeGreaterThan(0);
    }
    expect(c.spentUsd('claude')).toBeLessThanOrEqual(3);
    // 4. Una nota de sesión por tarea en la memoria temporal.
    const notes = readdirSync(join(root, 'memoria', 'Orquestador', 'Sesiones'));
    for (const t of tasks) expect(notes.filter((n) => n.includes(t.id))).toHaveLength(1);
    // 5. La copia del usuario no se tocó: misma rama y commit, árbol limpio, nada empujado al remoto.
    expect(git(repo, 'branch', '--show-current').stdout.trim()).toBe('main');
    expect(git(repo, 'rev-parse', 'main').stdout.trim()).toBe(mainBefore);
    expect(git(repo, 'status', '--porcelain').stdout).toBe('');
    // 6. git push falla en los worktrees (integración y uno de tarea nuevo), también con --no-verify.
    const probe = await c.workspaces.create(PROJECT, taskBriefSchema.parse({ ...tasks[0], id: 'probar-push', ownedPaths: ['nada.txt'] }));
    for (const wt of [integration, probe.path]) {
      expect(git(wt, 'push', 'origin', 'HEAD:refs/heads/fuga').status).not.toBe(0);
      expect(git(wt, 'push', '--no-verify', remote, 'HEAD:refs/heads/fuga').status).not.toBe(0);
    }
    await c.workspaces.remove(probe);
    expect(spawnSync('git', ['--git-dir', remote, 'for-each-ref'], { encoding: 'utf8' }).stdout.trim()).toBe('');
    expect(JSON.stringify([table, rows, log])).not.toContain(key);
  }, 45 * 60_000);
});
