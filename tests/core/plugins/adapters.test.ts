import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGY_BROWSER_DENY, AgyCliAdapter } from '../../../src/core/adapters/agy-cli/index.ts';
import { ClaudeSdkAdapter, claudeMcpOptions } from '../../../src/core/adapters/claude-sdk/adapter.ts';
import { decideToolUse, mcpToolAllowed } from '../../../src/core/adapters/claude-sdk/permissions.ts';
import { CodexCliAdapter, codexBrowserOffArgs, codexMcpArgs, codexPluginArgs } from '../../../src/core/adapters/codex-cli/index.ts';
import { createAdapterFactory } from '../../../src/core/app/adapters.ts';
import { CHROME_ONLY_NOTE, CHROME_TAB_NOTE, chromeGateArgs, chromeServerSpec, mcpSecrets, type McpGrant, type McpGrantRequest, type McpServerMap, type McpServerSource } from '../../../src/core/plugins/index.ts';
import type { JsonlLine, JsonlProcessOptions } from '../../../src/core/process/run-jsonl.ts';
import { agentConfigSchema, agentEventSchema, taskBriefSchema, type AgentEvent, type RunContext } from '../../../src/shared/index.ts';
import { config as claudeConfig, ctx as claudeCtx, fakeQuery, loadJsonl, task as claudeTask } from '../adapters/claude-sdk/helpers.ts';

const TOKEN = 'tok-canva-PRUEBA-0123456789abcdefghij';
const LAUNCHER = 'C:\\dev\\agent-hub\\tools\\browser\\chrome-personal.cmd';
const CMD = 'C:\\Windows\\System32\\cmd.exe';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const GATE = { agent: 'codex-main', task: 'tarea-codex', locksRoot: 'C:\\dev\\agent-hub\\locks', node: NODE, script: 'C:\\b\\chrome-gate.ts', waitMs: 300_000, idleMs: 180_000 };
const GATE_ARGS = chromeGateArgs({ command: CMD, args: ['/c', LAUNCHER] }, GATE);

const servers: McpServerMap = {
  'chrome-personal': chromeServerSpec({ command: CMD, args: ['/c', LAUNCHER] }, GATE),
  canva: { type: 'http', url: 'https://mcp.canva.com/mcp', headers: { Authorization: `Bearer ${TOKEN}` }, instructions: 'Usa Canva solo para la tarea.' },
};

function fakeSource(map: McpServerMap = servers, notes: string[] = []) {
  const calls: McpGrantRequest[] = [];
  let releases = 0;
  const source: McpServerSource = async (req) => {
    calls.push(req);
    const grant: McpGrant = { servers: map, notes, release: async () => { releases++; } };
    return grant;
  };
  return { source, calls, get releases() { return releases; } };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function worktree(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'orq-plugins-adapters-'));
  dirs.push(d);
  return d;
}
async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(agentEventSchema.parse(e));
  return out;
}
const exit: JsonlLine = { kind: 'exit', code: 0, signal: null, timedOut: false, aborted: false };

describe('traducción a Claude SDK', () => {
  it('claudeMcpOptions: stdio tal cual y los secretos como ${VAR} con su valor en env', () => {
    const out = claudeMcpOptions({ ...servers, otro: { type: 'stdio', command: 'node', args: ['s.js'], env: { API_KEY: 'secreto-largo-123' } } });
    expect(out.mcpServers['chrome-personal']).toEqual({ type: 'stdio', command: NODE, args: GATE_ARGS });
    expect(GATE_ARGS.slice(-4)).toEqual(['--', CMD, '/c', LAUNCHER]);
    expect(out.mcpServers.canva).toEqual({ type: 'http', url: 'https://mcp.canva.com/mcp', headers: { Authorization: '${ORQ_MCP_CANVA_AUTHORIZATION}' } });
    expect(out.mcpServers.otro).toEqual({ type: 'stdio', command: 'node', args: ['s.js'], env: { API_KEY: '${ORQ_MCP_OTRO_API_KEY}' } });
    expect(out.env).toEqual({ ORQ_MCP_CANVA_AUTHORIZATION: `Bearer ${TOKEN}`, ORQ_MCP_OTRO_API_KEY: 'secreto-largo-123' });
    expect(JSON.stringify(out.mcpServers)).not.toContain(TOKEN);
  });

  it('run: mcpServers, env, nota en el prompt, política mcp__<servidor>__* y tokens tachados', async () => {
    const leaky = JSON.parse(JSON.stringify(loadJsonl('subagent-run.jsonl')).replaceAll('OK ARANDANO', `OK ARANDANO ${TOKEN}`)) as unknown[];
    const fq = fakeQuery(leaky);
    const src = fakeSource(servers, ['Aviso de prueba.']);
    const adapter = new ClaudeSdkAdapter({ config: claudeConfig, query: fq.query, baseEnv: {}, plugins: src.source });
    const events = await collect(adapter.run(claudeTask, claudeCtx()));

    expect(src.calls).toEqual([{ agentId: 'claude-main', kind: 'claude-sdk', taskId: 'tarea-prueba', signal: expect.any(AbortSignal) }]);
    expect(src.releases).toBe(1);
    const options = fq.calls[0]?.options as Options;
    expect(options.strictMcpConfig).toBe(true);
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['chrome-personal', 'canva']);
    expect(options.mcpServers?.canva).toEqual({ type: 'http', url: 'https://mcp.canva.com/mcp', headers: { Authorization: '${ORQ_MCP_CANVA_AUTHORIZATION}' } });
    expect(options.env?.ORQ_MCP_CANVA_AUTHORIZATION).toBe(`Bearer ${TOKEN}`);
    const prompt = options.systemPrompt as { append?: string };
    expect(prompt.append).toContain('## Plugins del orquestador');
    expect(prompt.append).toContain(CHROME_TAB_NOTE);
    expect(prompt.append).toContain(CHROME_ONLY_NOTE);
    expect(prompt.append).toContain('Aviso de prueba.');

    const allow = async (tool: string) => (await options.canUseTool?.(tool, {}, { signal: new AbortController().signal, suggestions: [], toolUseID: 'x' } as never))?.behavior;
    expect(await allow('mcp__chrome-personal__new_page')).toBe('allow');
    expect(await allow('mcp__canva__get-design')).toBe('allow');
    expect(await allow('mcp__chrome-agente__new_page')).toBe('deny');
    expect(await allow('ListMcpResourcesTool')).toBe('deny');

    const text = JSON.stringify(events);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('[REDACTADO]');
    expect(events[0]).toMatchObject({ type: 'status', payload: { detail: expect.stringContaining('plugins: chrome-personal, canva') } });
  });

  it('sin plugins no cambia nada; si la fuente falla, la sesión sigue sin plugins', async () => {
    const fq = fakeQuery(loadJsonl('subagent-run.jsonl'));
    await collect(new ClaudeSdkAdapter({ config: claudeConfig, query: fq.query, baseEnv: {} }).run(claudeTask, claudeCtx()));
    expect(fq.calls[0]?.options.mcpServers).toEqual({});
    const fq2 = fakeQuery(loadJsonl('subagent-run.jsonl'));
    const broken: McpServerSource = async () => {
      throw new Error(`bóveda caída ${TOKEN}`);
    };
    const events = await collect(new ClaudeSdkAdapter({ config: claudeConfig, query: fq2.query, baseEnv: {}, plugins: broken }).run(claudeTask, claudeCtx()));
    expect(fq2.calls[0]?.options.mcpServers).toEqual({});
    expect((fq2.calls[0]?.options.systemPrompt as { append?: string }).append).toContain('Los plugins no están disponibles');
    expect(JSON.stringify(fq2.calls[0]?.options.systemPrompt)).not.toContain(TOKEN);
    expect(events.at(-1)).toMatchObject({ type: 'done', payload: { ok: true } });
  });

  it('suelta los candados aunque la ejecución se corte antes de empezar', async () => {
    const src = fakeSource();
    const ac = new AbortController();
    ac.abort();
    const events = await collect(new ClaudeSdkAdapter({ config: claudeConfig, query: fakeQuery([]).query, baseEnv: {}, plugins: src.source }).run(claudeTask, claudeCtx({ signal: ac.signal })));
    expect(events.map((e) => e.type)).toEqual(['status', 'error', 'done']);
    expect(src.releases).toBe(1);
  });

  it('política: solo servidores exactos entregados (sin comodines ni prefijos)', async () => {
    expect(mcpToolAllowed('mcp__canva__x', ['canva'])).toBe(true);
    expect(mcpToolAllowed('mcp__canva-falso__x', ['canva'])).toBe(false);
    expect(mcpToolAllowed('mcp__canva__', ['canva'])).toBe(false);
    expect(mcpToolAllowed('mcp__canva', ['canva'])).toBe(false);
    expect((await decideToolUse('C:\\wt', 'mcp__canva__x', {}, { mcpServers: ['canva'] })).behavior).toBe('allow');
    expect((await decideToolUse('C:\\wt', 'mcp__canva__x', {}, {})).behavior).toBe('deny');
  });
});

describe('traducción a Codex CLI', () => {
  const config = agentConfigSchema.parse({ id: 'codex-main', kind: 'codex-cli', provider: 'openai', displayName: 'Codex' });
  const task = taskBriefSchema.parse({ id: 'tarea-codex', projectId: 'p1', title: 'T', objective: 'O', ownedPaths: ['a.txt'], dependsOn: [], acceptance: ['ok'], difficulty: 'low' });

  it('codexMcpArgs: -c mcp_servers.<n>.… sin secretos en argumentos, encendidos y aprobados', () => {
    const out = codexMcpArgs({
      ...servers,
      otro: { type: 'http', url: 'https://x.example/mcp', headers: { 'X-Org': 'org-secreta-123' } },
      local: { type: 'stdio', command: 'node', args: ['s.js', 'con "comillas"'], env: { API_KEY: 'secreto-largo-123' } },
    });
    const on = (n: string) => ['-c', `mcp_servers.${n}.enabled=true`, '-c', `mcp_servers.${n}.default_tools_approval_mode="approve"`];
    expect(out.args).toEqual([
      '-c', `mcp_servers.chrome-personal.command=${JSON.stringify(NODE)}`,
      '-c', `mcp_servers.chrome-personal.args=[${GATE_ARGS.map((a) => JSON.stringify(a)).join(',')}]`,
      ...on('chrome-personal'),
      '-c', 'mcp_servers.chrome-personal.tool_timeout_sec=420',
      '-c', 'mcp_servers.canva.url="https://mcp.canva.com/mcp"',
      '-c', 'mcp_servers.canva.bearer_token_env_var="ORQ_MCP_CANVA_TOKEN"',
      ...on('canva'),
      '-c', 'mcp_servers.otro.url="https://x.example/mcp"',
      '-c', 'mcp_servers.otro.env_http_headers={"X-Org"="ORQ_MCP_OTRO_X_ORG"}',
      ...on('otro'),
      '-c', 'mcp_servers.local.command="node"',
      '-c', 'mcp_servers.local.args=["s.js","con \\"comillas\\""]',
      '-c', 'mcp_servers.local.env_vars=["API_KEY"]',
      ...on('local'),
    ]);
    expect(out.env).toEqual({ ORQ_MCP_CANVA_TOKEN: TOKEN, ORQ_MCP_OTRO_X_ORG: 'org-secreta-123', API_KEY: 'secreto-largo-123' });
    const argv = out.args.join(' ');
    for (const s of [TOKEN, 'org-secreta-123', 'secreto-largo-123']) expect(argv).not.toContain(s);
  });

  it('run: args, entorno del hijo, nota en el encargo (stdin) y eventos tachados', async () => {
    const lines = (await readFile(new URL('../../../fixtures/codex/exec-ok.jsonl', import.meta.url), 'utf8')).trim().split(/\r?\n/)
      .map((line): JsonlLine => ({ kind: 'json', line, value: JSON.parse(line) as unknown }));
    const run = vi.fn(async function* (o: JsonlProcessOptions) {
      void o;
      yield { kind: 'stderr', line: `aviso con ${TOKEN}` } as JsonlLine;
      yield* lines;
      yield exit;
    });
    const src = fakeSource();
    const adapter = new CodexCliAdapter(config, { runner: run, executable: { command: 'node', args: ['codex.js'] }, plugins: src.source });
    const ctx: RunContext = { worktreePath: await worktree(), env: { CODEX_HOME: 'C:\\codex' }, signal: new AbortController().signal, timeoutMs: 1000 };
    const events = await collect(adapter.run(task, ctx));
    const opts = run.mock.calls[0]?.[0];
    const plugins = codexPluginArgs(servers);
    // Primero el esfuerzo de razonamiento (issue 6), después el navegador apagado y los servidores MCP.
    expect(opts?.args.slice(0, 5 + plugins.args.length)).toEqual(['codex.js', 'exec', '--json', '-c', 'model_reasoning_effort="low"', ...plugins.args]);
    expect(opts?.args).toContain('plugins.chrome@openai-bundled.enabled=false');
    expect(opts?.args).toContain('mcp_servers.node_repl.enabled=false');
    // El chrome-personal que entrega Berland (la puerta) no se apaga: se enciende y se aprueba.
    expect(opts?.args).not.toContain('mcp_servers.chrome-personal.enabled=false');
    expect(opts?.args).toContain('mcp_servers.chrome-personal.default_tools_approval_mode="approve"');
    expect(opts?.args).toContain('mcp_servers.canva.bearer_token_env_var="ORQ_MCP_CANVA_TOKEN"');
    expect(opts?.args.join(' ')).not.toContain(TOKEN);
    expect(opts?.env).toEqual({ CODEX_HOME: 'C:\\codex', ORQ_MCP_CANVA_TOKEN: TOKEN });
    expect(opts?.stdin).toContain('## Plugins del orquestador');
    expect(opts?.stdin).toContain(CHROME_TAB_NOTE);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
    expect(events[0]).toMatchObject({ type: 'status', payload: { state: 'starting', detail: 'plugins: chrome-personal, canva' } });
    expect(events.at(-1)).toMatchObject({ type: 'done', payload: { ok: true } });
    expect(src.releases).toBe(1);
  });

  it('sin plugins: sus navegadores apagados, también el chrome-personal global (fuera del candado)', async () => {
    const run = vi.fn(async function* (o: JsonlProcessOptions) {
      void o;
      yield exit;
    });
    const ctx: RunContext = { worktreePath: await worktree(), env: {}, signal: new AbortController().signal, timeoutMs: 1000 };
    await collect(new CodexCliAdapter(config, { runner: run, executable: { command: 'node', args: ['codex.js'] } }).run(task, ctx));
    const off = codexBrowserOffArgs();
    expect(run.mock.calls[0]?.[0].args.slice(0, 7 + off.length)).toEqual(['codex.js', 'exec', '--json', '-c', 'model_reasoning_effort="low"', ...off, '-s', 'workspace-write']);
    expect(off).toContain('mcp_servers.chrome-personal.enabled=false');
  });

  it('codexBrowserOffArgs: plugins, funciones y servidores de navegador de Codex, cada servidor válido exista o no', () => {
    expect(codexBrowserOffArgs()).toEqual([
      '-c', 'plugins.browser@openai-bundled.enabled=false',
      '-c', 'plugins.chrome@openai-bundled.enabled=false',
      '-c', 'plugins.computer-use@openai-bundled.enabled=false',
      '-c', 'plugins.unified-computer-use@openai-bundled.enabled=false',
      '-c', 'features.browser_use=false',
      '-c', 'features.browser_use_external=false',
      '-c', 'features.in_app_browser=false',
      '-c', 'features.computer_use=false',
      '-c', 'mcp_servers.node_repl.command="cmd.exe"', '-c', 'mcp_servers.node_repl.enabled=false',
      '-c', 'mcp_servers.chrome-personal.command="cmd.exe"', '-c', 'mcp_servers.chrome-personal.enabled=false',
      '-c', 'mcp_servers.chrome-agente.command="cmd.exe"', '-c', 'mcp_servers.chrome-agente.enabled=false',
      '-c', 'mcp_servers.chrome-devtools.command="cmd.exe"', '-c', 'mcp_servers.chrome-devtools.enabled=false',
    ]);
    // Sin comillas en la clave del plugin: `-c` divide la ruta por puntos (con comillas no tiene efecto).
    expect(codexBrowserOffArgs().join(' ')).not.toContain('"chrome@');
    expect(codexBrowserOffArgs(['chrome-personal']).join(' ')).not.toContain('chrome-personal');
  });
});

describe('agy y la fábrica de adaptadores', () => {
  it('agy no recibe servidores MCP: sus navegadores propios bloqueados por argumentos, sin archivos de configuración', async () => {
    const config = agentConfigSchema.parse({ id: 'agy-main', kind: 'agy-cli', provider: 'antigravity', displayName: 'agy' });
    const task = taskBriefSchema.parse({ id: 'tarea-agy', projectId: 'p1', title: 'T', objective: 'O', ownedPaths: ['a.txt'], dependsOn: [], acceptance: ['ok'], difficulty: 'low' });
    const lines = (await readFile(new URL('../../../fixtures/agy/stream-ok.jsonl', import.meta.url), 'utf8')).trim().split(/\r?\n/)
      .map((line): JsonlLine => ({ kind: 'json', line, value: JSON.parse(line) as unknown }));
    const run = vi.fn(async function* (o: JsonlProcessOptions) {
      void o;
      yield* lines;
      yield exit;
    });
    const wt = await worktree();
    await collect(new AgyCliAdapter(config, { runner: run, executable: { command: 'agy.exe', args: [] } }).run(task, { worktreePath: wt, env: {}, signal: new AbortController().signal, timeoutMs: 1000 }));
    const args = run.mock.calls[0]?.[0].args ?? [];
    expect(args).toContain('--disable-slash-commands');
    const settings = args[args.indexOf('--settings') + 1] ?? '';
    expect(JSON.parse(settings)).toEqual({ permissions: { deny: [...AGY_BROWSER_DENY] } });
    expect(AGY_BROWSER_DENY).toContain('mcp(chrome_devtools/*)');
    expect(AGY_BROWSER_DENY).toContain('mcp(chrome-agente/*)');
    expect(args.join(' ')).not.toMatch(/mcpServers|mcp_config|mcp add/i);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(join(wt, '.orq'))).toEqual(['BRIEF-tarea-agy.md']);
  });

  it('createAdapterFactory pasa la fuente de plugins a Claude y a Codex (no a agy)', () => {
    const src = fakeSource();
    const seen: Record<string, unknown> = {};
    const factory = createAdapterFactory({
      spentUsd: () => () => 0,
      plugins: src.source,
      hostEnv: () => ({}),
      constructors: {
        claudeSdk: (o) => {
          seen.claude = o.plugins;
          return { config: o.config, probe: async () => { throw new Error('x'); }, run: async function* () { /* nada */ } };
        },
        codexCli: (c, o) => {
          seen.codex = o?.plugins;
          return { config: c, probe: async () => { throw new Error('x'); }, run: async function* () { /* nada */ } };
        },
        agyCli: (c) => {
          seen.agy = 'sin opciones';
          return { config: c, probe: async () => { throw new Error('x'); }, run: async function* () { /* nada */ } };
        },
      },
    });
    factory(claudeConfig, { apiKey: 'sk-ant-api03-FALSAparaPRUEBAS0123456789abcdefABCDEF' });
    factory(agentConfigSchema.parse({ id: 'codex-main', kind: 'codex-cli', provider: 'openai', displayName: 'Codex' }), {});
    factory(agentConfigSchema.parse({ id: 'agy-main', kind: 'agy-cli', provider: 'antigravity', displayName: 'agy' }), {});
    expect(seen).toEqual({ claude: src.source, codex: src.source, agy: 'sin opciones' });
  });

  it('mcpSecrets reúne encabezados, tokens Bearer y variables', () => {
    expect(mcpSecrets({ ...servers, s: { type: 'stdio', command: 'x', args: [], env: { K: 'valor-secreto' } } }).sort()).toEqual([`Bearer ${TOKEN}`, TOKEN, 'valor-secreto'].sort());
  });
});
