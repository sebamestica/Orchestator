import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_TOOL_NAMES, LEGACY_TOOL_NAME_ALIASES } from '@anthropic-ai/claude-agent-sdk';
import type { AgentDefinition, HookCallbackMatcher, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BLOCKED_TOOLS,
  BYPASS_TOOLS,
  CHAT_HIDDEN_TOOLS,
  DESTINATION_PROMPT_TEXT,
  CONDUCTOR_PROMPT_PREFIX,
  CONDUCTOR_TOOL_NAMES,
  ConductorSession,
  DEFAULT_CONDUCTOR_MODEL,
  MAX_IMAGE_BASE64_BYTES,
  SUBAGENT_TOOL,
  buildEnv,
  sdkSessionIdOf,
} from '../../../src/core/conductor/index.ts';
import type { ConductorSessionOptions, SdkMessageTranslator, TranslatorInit } from '../../../src/core/conductor/index.ts';
import type { AgentEvent } from '../../../src/shared/index.ts';
import { FAKE_API_KEY, SECRET_PATTERN, assistantText, fakePorts, readTurn, resultMessage, scriptedQuery, userText } from './fakes.ts';

const PROXY_KEY = 'clave-del-proxy-0123456789';
const BASE_ENV = { PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\yo', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ANTHROPIC_AUTH_TOKEN: 'token-heredado-abcdef' };

function session(extra: Partial<ConductorSessionOptions> = {}) {
  const q = scriptedQuery((m) => [assistantText(`eco: ${userText(m)}`), resultMessage('ok')]);
  const s = new ConductorSession({
    ports: fakePorts(),
    projectId: 'demo',
    cwd: 'C:\\dev\\demo',
    env: { ANTHROPIC_API_KEY: PROXY_KEY, ANTHROPIC_BASE_URL: 'http://203.0.113.7:18082' },
    baseEnv: BASE_ENV,
    query: q.fn,
    ...extra,
  });
  return { s, q };
}

function optionsOf(q: ReturnType<typeof scriptedQuery>): Options {
  const first = q.calls[0];
  if (!first) throw new Error('query no se llamó');
  return first.options;
}

describe('ConductorSession: opciones del SDK', () => {
  it('arma herramientas propias, solo lectura y subagentes, sin Bash ni edición', () => {
    const { s, q } = session();
    s.send('hola');
    const o = optionsOf(q);
    const own = CONDUCTOR_TOOL_NAMES.map((n) => `mcp__orquestador__${n}`);
    expect(o.mcpServers?.orquestador).toBe(s.tools.server);
    expect(Object.keys(o.mcpServers ?? {})).toEqual(['orquestador']);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.allowedTools).toEqual([...own, 'Read', 'Grep', 'Glob', 'Agent']);
    expect(o.tools).toEqual(['Read', 'Grep', 'Glob', 'Agent']);
    for (const banned of ['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit']) {
      expect(o.allowedTools).not.toContain(banned);
      expect(o.tools).not.toContain(banned);
      expect(o.disallowedTools).toContain(banned);
    }
    expect(o.disallowedTools).toEqual([...BLOCKED_TOOLS]);
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.allowDangerouslySkipPermissions).toBeUndefined();
    expect(o.settingSources).toEqual([]);
    s.close();
  });

  it('Task está habilitado: en el SDK instalado es el alias de Agent', () => {
    expect(SUBAGENT_TOOL).toBe('Agent');
    expect(LEGACY_TOOL_NAME_ALIASES.Task).toBe(SUBAGENT_TOOL);
    expect(BUILTIN_TOOL_NAMES).toContain(SUBAGENT_TOOL);
    for (const name of BLOCKED_TOOLS) expect(BUILTIN_TOOL_NAMES).toContain(name);
  });

  it('cwd del proyecto, modelo por defecto, esfuerzo, abortController y prompt con prefijo fijo', () => {
    const { s, q } = session();
    s.send('hola');
    const o = optionsOf(q);
    expect(o.cwd).toBe('C:\\dev\\demo');
    expect(o.model).toBe(DEFAULT_CONDUCTOR_MODEL);
    expect(DEFAULT_CONDUCTOR_MODEL).toBe('claude-opus-5-5');
    expect(o.effort).toBe('high');
    expect(o.abortController).toBeInstanceOf(AbortController);
    expect((o.systemPrompt as string[])[0]).toBe(CONDUCTOR_PROMPT_PREFIX);
    expect(o.maxBudgetUsd).toBeUndefined();
    expect(o.forwardSubagentText).toBe(true);
    s.close();
    expect(o.abortController?.signal.aborted).toBe(true);
    expect(q.closed).toBe(1);
  });

  it('modelo, esfuerzo, tope de gasto y turnos configurables', () => {
    const { s, q } = session({ model: 'claude-fable-5-1', effort: 'medium', maxBudgetUsd: 2.5, maxTurns: 12, settingSources: ['project'] });
    s.send('hola');
    expect(optionsOf(q)).toMatchObject({ model: 'claude-fable-5-1', effort: 'medium', maxBudgetUsd: 2.5, maxTurns: 12, settingSources: ['project'] });
    expect(s.model).toBe('claude-fable-5-1');
    s.close();
  });

  it('env: clave y URL de la bóveda, sin credenciales heredadas ni variables de un Claude Code anfitrión', () => {
    const { s, q } = session();
    s.send('hola');
    const env = optionsOf(q).env ?? {};
    expect(env.ANTHROPIC_API_KEY).toBe(PROXY_KEY);
    expect(env.ANTHROPIC_BASE_URL).toBe('http://203.0.113.7:18082');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.PATH).toBe('C:\\Windows');
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('orquestador/0.1.0');
    expect(s.warnings).toEqual(['La URL de la API usa HTTP sin cifrar: la clave y los prompts viajan en claro.']);
    s.close();
  });

  it('apiKey y baseUrl explícitos ganan; sin clave avisa', () => {
    expect(buildEnv({}, { ANTHROPIC_API_KEY: PROXY_KEY })).toEqual({ ANTHROPIC_API_KEY: PROXY_KEY, CLAUDE_AGENT_SDK_CLIENT_APP: 'orquestador/0.1.0' });
    const { s, q } = session({ apiKey: 'otra-clave-123456789', baseUrl: 'https://api.example.com' });
    s.send('hola');
    expect(optionsOf(q).env).toMatchObject({ ANTHROPIC_API_KEY: 'otra-clave-123456789', ANTHROPIC_BASE_URL: 'https://api.example.com' });
    expect(s.warnings).toEqual([]);
    s.close();
    const none = session({ env: {}, baseEnv: { PATH: 'x' } });
    expect(none.s.warnings).toEqual(['Falta ANTHROPIC_API_KEY: el orquestador solo funciona con la clave de API (no usa sesión de Claude Code).']);
  });

  it('la clave solo va en env: ni en el prompt ni en el resto de opciones', () => {
    const { s, q } = session({ notes: `mi clave es ${PROXY_KEY}` });
    s.send('hola');
    const rest = { ...optionsOf(q), env: undefined, mcpServers: undefined, abortController: undefined };
    const text = JSON.stringify(rest);
    expect(text).not.toContain(PROXY_KEY);
    expect(text).toContain('[REDACTADO]');
    s.close();
  });

  it('guardia enganchada como hook PreToolUse: niega Bash y Edit, deja pasar la lectura del proyecto', async () => {
    const { s, q } = session();
    s.send('hola');
    const o = optionsOf(q);
    expect(o.canUseTool).toBeUndefined();
    const matcher = (o.hooks?.PreToolUse as HookCallbackMatcher[] | undefined)?.[0];
    const hook = matcher?.hooks[0];
    if (!hook) throw new Error('falta la guardia');
    expect(matcher?.matcher).toBeUndefined();
    const signal = new AbortController().signal;
    const pre = (tool_name: string, tool_input: unknown) =>
      hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: 'p', cwd: 'C:\\dev\\demo' }, 't', { signal });
    expect(JSON.stringify(await pre('Bash', { command: 'git push' }))).toMatch(/"permissionDecision":"deny"/);
    expect(JSON.stringify(await pre('Edit', { file_path: 'a.ts' }))).toMatch(/"permissionDecision":"deny"/);
    expect(await pre('Read', { file_path: 'AGENTS.md' })).toEqual({});
    s.close();
  });

  it('subagente propio de solo lectura', () => {
    const { s, q } = session();
    s.send('hola');
    const agents = optionsOf(q).agents as Record<string, AgentDefinition>;
    const investigador = agents.investigador;
    expect(investigador?.tools).toEqual(['Read', 'Grep', 'Glob', 'mcp__orquestador__estado', 'mcp__orquestador__cupos', 'mcp__orquestador__leer_memoria', 'mcp__orquestador__buscar_skills']);
    expect(investigador?.permissionMode).toBe('dontAsk');
    s.close();
  });

  it('valida las opciones', () => {
    expect(() => session({ projectId: 'Con Espacios' })).toThrow();
    expect(() => session({ baseUrl: 'no es url' })).toThrow();
    expect(() => session({ apiKey: 'corta' })).toThrow();
    expect(() => session({ maxBudgetUsd: -1 })).toThrow();
  });
});

describe('ConductorSession: conversación', () => {
  it('send entrega mensajes de usuario a la query (arrancada una sola vez) y messages los devuelve', async () => {
    const { s, q } = session();
    const it = s.messages()[Symbol.asyncIterator]();
    s.send('primero');
    expect((await readTurn(it)).map((m) => m.type)).toEqual(['assistant', 'result']);
    s.send('segundo');
    const second = await readTurn(it);
    expect(JSON.stringify(second[0])).toContain('eco: segundo');
    expect(q.calls).toHaveLength(1);
    expect(q.received).toEqual([
      { type: 'user', message: { role: 'user', content: 'primero' }, parent_tool_use_id: null },
      { type: 'user', message: { role: 'user', content: 'segundo' }, parent_tool_use_id: null },
    ]);
    s.close();
    expect((await it.next()).done).toBe(true);
  });

  it('rechaza mensajes vacíos, un segundo lector y enviar tras cerrar', () => {
    const { s } = session();
    expect(() => s.send('   ')).toThrow();
    s.messages();
    expect(() => s.messages()).toThrow(/ya tiene un lector/);
    s.close();
    expect(s.closed).toBe(true);
    expect(() => s.send('hola')).toThrow(/cerrada/);
  });

  it('interrupt llega a la query', async () => {
    const { s, q } = session();
    s.send('hola');
    await s.interrupt();
    expect(q.interrupted).toBe(1);
    s.close();
  });

  it('events pasa cada mensaje por el traductor inyectado y tacha las claves', async () => {
    const inits: TranslatorInit[] = [];
    const seen: SDKMessage[] = [];
    const translator = (init: TranslatorInit): SdkMessageTranslator => {
      inits.push(init);
      let seq = 0;
      return {
        translate: (message): AgentEvent[] => {
          seen.push(message);
          if (message.type !== 'assistant') return [];
          const text = `${JSON.stringify(message.message.content)} ${PROXY_KEY} ${FAKE_API_KEY}`;
          return [{ sessionId: init.sessionId, agentId: init.agentId, seq: seq++, ts: '2026-11-01T22:00:00.000Z', type: 'text', payload: { text, role: 'assistant' } }];
        },
      };
    };
    const { s } = session({ translator, sessionId: 'sesion-1' });
    const it = s.events()[Symbol.asyncIterator]();
    s.send('hola');
    const first = await it.next();
    expect(inits).toEqual([{ agentId: 'orquestador', sessionId: 'sesion-1', cwd: 'C:\\dev\\demo', secrets: [PROXY_KEY] }]);
    expect(first.value).toMatchObject({ type: 'text', sessionId: 'sesion-1', agentId: 'orquestador' });
    expect(JSON.stringify(first.value)).toContain('eco: hola');
    expect(JSON.stringify(first.value)).not.toContain(PROXY_KEY);
    expect(JSON.stringify(first.value)).not.toMatch(SECRET_PATTERN);
    s.close();
    expect((await it.next()).done).toBe(true);
    expect(seen.map((m) => m.type)).toEqual(['assistant', 'result']);
  });

  it('events exige traductor; stderr sale tachado', () => {
    const lines: string[] = [];
    const { s, q } = session({ onStderr: (l) => lines.push(l) });
    expect(() => s.events()).toThrow(/traductor/);
    s.send('hola');
    optionsOf(q).stderr?.(`fallo con ${PROXY_KEY}`);
    expect(lines).toEqual(['fallo con [REDACTADO]']);
    s.close();
  });

  it('las herramientas de la sesión tachan la clave de la bóveda', async () => {
    const ports = fakePorts();
    ports.memory.context = `nota con ${PROXY_KEY}`;
    const { s } = session({ ports });
    const text = JSON.stringify(await s.tools.call('leer_memoria', { proyecto: 'demo' }));
    expect(text).not.toContain(PROXY_KEY);
    s.close();
  });
});

describe('ConductorSession: modos, agente suelto, plugins e imágenes', () => {
  const hookOf = (o: Options) => {
    const hook = (o.hooks?.PreToolUse as HookCallbackMatcher[] | undefined)?.[0]?.hooks[0];
    if (!hook) throw new Error('falta la guardia');
    const signal = new AbortController().signal;
    return async (tool_name: string, tool_input: unknown) =>
      JSON.stringify(await hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: 'p', cwd: 'C:\\dev\\demo' }, 't', { signal }));
  };

  it('plan: delegar fuera de allowedTools y bloqueada por la guardia; el modo se lee en cada llamada', async () => {
    let mode: 'plan' | 'auto' = 'plan';
    const { s, q } = session({ mode: () => mode });
    s.send('hola');
    const o = optionsOf(q);
    expect(s.mode).toBe('plan');
    expect(o.allowedTools).not.toContain('mcp__orquestador__delegar');
    expect(o.allowedTools).toContain('mcp__orquestador__crear_tareas');
    // La definición MCP no cambia (mismo prefijo de herramientas en caché en los tres modos).
    expect(o.mcpServers?.orquestador).toBe(s.tools.server);
    expect((o.systemPrompt as string[])[0]).toBe(CONDUCTOR_PROMPT_PREFIX);
    expect((o.systemPrompt as string[])[2]).toMatch(/## Modo: plan/);
    const pre = hookOf(o);
    expect(await pre('mcp__orquestador__delegar', { taskId: 'api' })).toMatch(/"permissionDecision":"deny"/);
    mode = 'auto';
    // Ya no la bloquea la guardia dinámica, pero sigue fuera de allowedTools hasta la sesión siguiente.
    expect(await pre('mcp__orquestador__delegar', { taskId: 'api' })).toMatch(/no está permitido/);
    s.close();
  });

  it('auto: delegar permitida; si el modo pasa a plan en medio del turno, la guardia la bloquea', async () => {
    let mode: 'plan' | 'auto' = 'auto';
    const { s, q } = session({ mode: () => mode });
    s.send('hola');
    const o = optionsOf(q);
    expect(o.allowedTools).toContain('mcp__orquestador__delegar');
    expect((o.systemPrompt as string[])[2]).toMatch(/## Modo: auto/);
    const pre = hookOf(o);
    expect(await pre('mcp__orquestador__delegar', { taskId: 'api' })).toBe('{}');
    mode = 'plan';
    expect(await pre('mcp__orquestador__delegar', { taskId: 'api' })).toMatch(/modo plan/);
    s.close();
  });

  it('agente suelto: sin herramientas de flota y prompt sin proyecto', async () => {
    const { s, q } = session({ projectId: null, mode: 'auto' });
    s.send('hola');
    const o = optionsOf(q);
    expect(s.projectId).toBeNull();
    for (const name of ['crear_tareas', 'delegar', 'estado', 'escribir_memoria']) expect(o.allowedTools).not.toContain(`mcp__orquestador__${name}`);
    expect(o.allowedTools).toEqual(['mcp__orquestador__cupos', 'mcp__orquestador__leer_memoria', 'mcp__orquestador__buscar_skills', 'Read', 'Grep', 'Glob', 'Agent']);
    expect((o.systemPrompt as string[])[2]).toMatch(/agente suelto/);
    expect(await hookOf(o)('mcp__orquestador__crear_tareas', { plan: 'x' })).toMatch(/"permissionDecision":"deny"/);
    s.close();
  });

  it('servidores MCP de plugins: van en mcpServers y sus herramientas en allowedTools', async () => {
    const fake = { type: 'stdio' as const, command: 'node', args: ['servidor-falso.js'] };
    const { s, q } = session({ mcpServers: { chrome: fake } });
    s.send('hola');
    const o = optionsOf(q);
    expect(o.mcpServers?.chrome).toEqual(fake);
    expect(o.mcpServers?.orquestador).toBe(s.tools.server);
    expect(o.allowedTools).toContain('mcp__chrome__*');
    expect(await hookOf(o)('mcp__chrome__navigate_page', { url: 'https://example.com' })).toBe('{}');
    s.close();
    expect(() => session({ mcpServers: { orquestador: fake } })).toThrow();
    expect(() => session({ mcpServers: { 'con espacio': fake } })).toThrow();
  });

  it('readRoots dinámico: additionalDirectories con el valor inicial y la guardia ve los cambios', async () => {
    const roots = ['C:\\dev\\agent-hub\\skills'];
    const { s, q } = session({ readRoots: () => roots, extraRoots: ['D:\\datos'], denyPaths: ['C:\\dev\\agent-hub\\skills\\vault.json'] });
    s.send('hola');
    const o = optionsOf(q);
    expect(o.additionalDirectories).toEqual(['D:\\datos', 'C:\\dev\\agent-hub\\skills']);
    expect((o.systemPrompt as string[])[2]).toMatch(/Carpetas extra de lectura: D:\\datos/);
    const pre = hookOf(o);
    expect(await pre('Read', { file_path: 'E:\\x\\a.md' })).toMatch(/deny/);
    roots.push('E:\\x');
    expect(await pre('Read', { file_path: 'E:\\x\\a.md' })).toBe('{}');
    expect(await pre('Read', { file_path: 'C:\\dev\\agent-hub\\skills\\vault.json' })).toMatch(/deny/);
    s.close();
  });

  it('send con imágenes: bloques image en base64 antes del texto; tope de 5 MB en base64', () => {
    const { s, q } = session();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    s.send('¿qué ves?', { images: [{ mediaType: 'image/png', data: png }] });
    s.send('', { images: [{ mediaType: 'image/webp', data: png }] });
    expect(q.calls).toHaveLength(1);
    expect(() => s.send('', { images: [{ mediaType: 'image/png', data: 'A'.repeat(MAX_IMAGE_BASE64_BYTES + 4), name: 'grande.png' }] })).toThrow(/«grande\.png» es demasiado grande.*5 MB en base64/);
    expect(() => s.send('x', { images: [{ mediaType: 'image/svg+xml' as 'image/png', data: png }] })).toThrow(/no admitido/);
    expect(() => s.send('x', { images: [{ mediaType: 'image/png', data: 'no es base64!' }] })).toThrow();
    expect(() => s.send('   ')).toThrow();
    s.close();
  });

  it('send con imágenes llega a la query como contenido en bloques', async () => {
    const { s, q } = session();
    const it = s.messages()[Symbol.asyncIterator]();
    const png = Buffer.from('imagen').toString('base64');
    s.send('mira', { images: [{ mediaType: 'image/png', data: png }] });
    await readTurn(it);
    expect(q.received[0]?.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
      { type: 'text', text: 'mira' },
    ]);
    s.close();
  });

  it('stream entrega cada mensaje con sus eventos; sdkSessionIdOf lee el session_id', async () => {
    const translator = (init: TranslatorInit): SdkMessageTranslator => ({
      translate: (message): AgentEvent[] =>
        message.type === 'result' ? [{ sessionId: init.sessionId, agentId: init.agentId, seq: 0, ts: '2026-11-01T22:00:00.000Z', type: 'done', payload: { ok: true, summary: PROXY_KEY } }] : [],
    });
    const { s } = session({ translator, sessionId: 'chat-1' });
    const it = s.stream()[Symbol.asyncIterator]();
    s.send('hola');
    const first = await it.next();
    const second = await it.next();
    expect(first.value?.message.type).toBe('assistant');
    expect(first.value?.events).toEqual([]);
    expect(second.value?.events[0]).toMatchObject({ type: 'done', sessionId: 'chat-1', payload: { summary: '[REDACTADO]' } });
    expect(sdkSessionIdOf(second.value?.message as SDKMessage)).toBe('sdk-session-1');
    expect(s.redact(`clave ${PROXY_KEY}`)).toBe('clave [REDACTADO]');
    s.close();
  });
});

describe('ConductorSession: bypass autónomo (edición y shell en el proyecto)', () => {
  let base = '';
  let project = '';
  let extra = '';
  let outside = '';
  let vault = '';
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'orq-bypass-'));
    project = join(base, 'proyecto');
    extra = join(base, 'extra');
    outside = join(base, 'fuera');
    for (const dir of [project, extra, outside, join(base, 'datos')]) mkdirSync(dir, { recursive: true });
    vault = join(base, 'datos', 'vault.json');
  });
  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  const guardAt = (o: Options, cwd: string) => {
    const hook = (o.hooks?.PreToolUse as HookCallbackMatcher[] | undefined)?.[0]?.hooks[0];
    if (!hook) throw new Error('falta la guardia');
    const signal = new AbortController().signal;
    return async (tool_name: string, tool_input: unknown): Promise<string> =>
      JSON.stringify(await hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: 'p', cwd }, 't', { signal }));
  };
  const open = (mode: ConductorSessionOptions['mode'], extraOpts: Partial<ConductorSessionOptions> = {}) =>
    session({ cwd: project, mode, extraRoots: [extra], readRoots: ['C:\\'], denyPaths: [vault, join(project, 'nucleo.db')], ...extraOpts });

  it('el SDK recibe edición y ejecución; el resto de BLOCKED_TOOLS sigue bloqueado', () => {
    const { s, q } = open('bypass');
    s.send('haz los guiones');
    const o = optionsOf(q);
    expect(BYPASS_TOOLS).toEqual(['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell']);
    for (const t of BYPASS_TOOLS) {
      expect(o.tools).toContain(t);
      expect(o.allowedTools).toContain(t);
      expect(o.disallowedTools).not.toContain(t);
      expect(BUILTIN_TOOL_NAMES).toContain(t);
    }
    expect(o.tools).toEqual(['Read', 'Grep', 'Glob', 'Agent', ...BYPASS_TOOLS]);
    expect(o.disallowedTools).toEqual(BLOCKED_TOOLS.filter((t) => !(BYPASS_TOOLS as readonly string[]).includes(t)));
    for (const t of ['Monitor', 'EnterWorktree', 'Workflow', 'CronCreate', 'RemoteTrigger']) expect(o.disallowedTools).toContain(t);
    expect(o.allowedTools).toContain('mcp__orquestador__delegar');
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.allowDangerouslySkipPermissions).toBeUndefined();
    // Bash y los MCP stdio no heredan la clave; el proceso del SDK sí la tiene.
    expect(o.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
    expect(o.env?.ANTHROPIC_API_KEY).toBe(PROXY_KEY);
    expect((o.systemPrompt as string[])[0]).toBe(CONDUCTOR_PROMPT_PREFIX);
    expect((o.systemPrompt as string[])[2]).toMatch(/## Modo: bypass[\s\S]*Hazlo tú mismo[\s\S]*No preguntes/);
    // El investigador sigue siendo de solo lectura.
    expect((o.agents as Record<string, AgentDefinition>).investigador?.tools).not.toContain('Bash');
    s.close();
  });

  it('la guardia escribe dentro del proyecto y de las carpetas extra; niega fuera, denyPaths, git push y rm -rf fuera', async () => {
    const { s, q } = open('bypass');
    s.send('hola');
    const pre = guardAt(optionsOf(q), project);
    expect(await pre('Write', { file_path: join(project, 'GUIONES.md'), content: '# Guiones' })).toBe('{}');
    expect(await pre('Edit', { file_path: join(project, 'src', 'a.ts'), old_string: 'a', new_string: 'b' })).toBe('{}');
    expect(await pre('Write', { file_path: join(extra, 'notas.md'), content: 'x' })).toBe('{}');
    expect(await pre('Write', { file_path: join(outside, 'x.md'), content: 'x' })).toMatch(/"deny".*solo puedes escribir dentro del proyecto/);
    expect(await pre('Write', { file_path: vault, content: '{}' })).toMatch(/"deny"/);
    expect(await pre('Write', { file_path: join(project, 'nucleo.db'), content: 'x' })).toMatch(/"deny".*datos del núcleo/);
    expect(await pre('Bash', { command: 'git status' })).toBe('{}');
    expect(await pre('Bash', { command: 'npm run -s check' })).toBe('{}');
    expect(await pre('Bash', { command: 'git push' })).toMatch(/"deny".*git push necesita la aprobación del usuario/);
    expect(await pre('PowerShell', { command: 'git push origin main' })).toMatch(/"deny"/);
    expect(await pre('Bash', { command: `rm -rf ${outside.replace(/\\/g, '/')}` })).toMatch(/"deny".*fuera del worktree/);
    expect(await pre('Bash', { command: 'rm -rf ../fuera' })).toMatch(/"deny"/);
    expect(await pre('Bash', { command: `type ${vault}` })).toMatch(/"deny".*datos del núcleo/);
    // La lectura sigue abierta a las unidades en bypass, salvo denyPaths.
    expect(await pre('Read', { file_path: join(outside, 'x.md') })).toBe('{}');
    expect(await pre('Read', { file_path: vault })).toMatch(/"deny"/);
    expect(await guardAt(optionsOf(q), outside)('Bash', { command: 'ls' })).toMatch(/"deny".*fuera del proyecto/);
    s.close();
  });

  it('plan y auto: edición y ejecución siguen bloqueadas en las opciones y en la guardia', async () => {
    for (const mode of ['plan', 'auto'] as const) {
      const { s, q } = open(mode);
      s.send('hola');
      const o = optionsOf(q);
      expect(o.tools, mode).toEqual(['Read', 'Grep', 'Glob', 'Agent']);
      expect(o.disallowedTools, mode).toEqual([...BLOCKED_TOOLS]);
      expect(o.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, mode).toBeUndefined();
      const pre = guardAt(o, project);
      for (const t of BYPASS_TOOLS) expect(o.allowedTools, `${mode} ${t}`).not.toContain(t);
      expect(await pre('Write', { file_path: join(project, 'a.md'), content: 'x' }), mode).toMatch(/"deny".*Write no está permitido/);
      expect(await pre('Bash', { command: 'git status' }), mode).toMatch(/"deny".*Bash no está permitido/);
      expect(await pre('Agent', { description: 'x', prompt: 'y', isolation: 'worktree' }), mode).toBe('{}');
      s.close();
    }
  });

  it('si el modo sale de bypass a mitad de sesión, la guardia niega edición y shell al instante', async () => {
    let mode: 'bypass' | 'plan' | 'auto' = 'bypass';
    const { s, q } = open(() => mode);
    s.send('hola');
    const pre = guardAt(optionsOf(q), project);
    expect(await pre('Write', { file_path: join(project, 'a.md'), content: 'x' })).toBe('{}');
    mode = 'auto';
    expect(await pre('Write', { file_path: join(project, 'a.md'), content: 'x' })).toMatch(/"deny".*solo está disponible en los modos bypass y chat/);
    mode = 'plan';
    expect(await pre('Bash', { command: 'git status' })).toMatch(/"deny".*solo está disponible en los modos bypass y chat/);
    mode = 'bypass';
    expect(await pre('Bash', { command: 'git status' })).toBe('{}');
    s.close();
  });

  it('agente suelto en bypass: sigue sin edición ni ejecución', () => {
    const { s, q } = open('bypass', { projectId: null });
    s.send('hola');
    const o = optionsOf(q);
    for (const t of BYPASS_TOOLS) expect(o.allowedTools).not.toContain(t);
    expect(o.disallowedTools).toEqual([...BLOCKED_TOOLS]);
    s.close();
  });
});

describe('ConductorSession: modo chat (como Claude Code, sin flota)', () => {
  let base = '';
  let folder = '';
  let extra = '';
  let outside = '';
  let vault = '';
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'orq-chat-modo-'));
    folder = join(base, 'carpeta');
    extra = join(base, 'extra');
    outside = join(base, 'fuera');
    for (const dir of [folder, extra, outside, join(base, 'datos')]) mkdirSync(dir, { recursive: true });
    vault = join(base, 'datos', 'vault.json');
  });
  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  const guardAt = (o: Options, cwd: string) => {
    const hook = (o.hooks?.PreToolUse as HookCallbackMatcher[] | undefined)?.[0]?.hooks[0];
    if (!hook) throw new Error('falta la guardia');
    const signal = new AbortController().signal;
    return async (tool_name: string, tool_input: unknown): Promise<string> =>
      JSON.stringify(await hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: 'p', cwd }, 't', { signal }));
  };
  const open = (mode: ConductorSessionOptions['mode'], extraOpts: Partial<ConductorSessionOptions> = {}) =>
    session({ cwd: folder, mode, extraRoots: [extra], denyPaths: [vault, join(folder, 'nucleo.db')], ...extraOpts });
  const hidden = CHAT_HIDDEN_TOOLS.map((n) => `mcp__orquestador__${n}`);

  it('con proyecto: herramientas de Claude Code, sin crear_tareas ni delegar (ni en allowedTools ni en el contexto)', () => {
    const { s, q } = open('chat', { recordDestination: async () => ({ kind: 'local', path: folder, git: 'none', worktrees: false }) });
    s.send('hola');
    const o = optionsOf(q);
    expect(CHAT_HIDDEN_TOOLS).toEqual(['crear_tareas', 'delegar']);
    expect(o.tools).toEqual(['Read', 'Grep', 'Glob', 'Agent', ...BYPASS_TOOLS]);
    for (const t of BYPASS_TOOLS) expect(o.allowedTools).toContain(t);
    for (const t of hidden) {
      expect(o.allowedTools).not.toContain(t);
      expect(o.disallowedTools).toContain(t);
    }
    for (const t of ['estado', 'cupos', 'leer_memoria', 'buscar_skills']) expect(o.allowedTools).toContain(`mcp__orquestador__${t}`);
    for (const t of ['Monitor', 'EnterWorktree', 'Workflow']) expect(o.disallowedTools).toContain(t);
    for (const t of BYPASS_TOOLS) expect(o.disallowedTools).not.toContain(t);
    expect(o.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('1');
    const prompt = o.systemPrompt as string[];
    expect(prompt[0]).toBe(CONDUCTOR_PROMPT_PREFIX);
    expect(prompt[2]).toMatch(/## Modo: chat[\s\S]*como Claude Code[\s\S]*No creas tareas ni delegas a la flota/);
    // Sin crear_tareas, el texto del destino no va.
    expect(prompt).not.toContain(DESTINATION_PROMPT_TEXT);
    s.close();
  });

  it('sin proyecto (agente suelto): también edita y ejecuta, con la carpeta del chat como raíz', async () => {
    const { s, q } = open('chat', { projectId: null });
    s.send('hola');
    const o = optionsOf(q);
    expect(o.allowedTools).toEqual(['mcp__orquestador__cupos', 'mcp__orquestador__leer_memoria', 'mcp__orquestador__buscar_skills', 'Read', 'Grep', 'Glob', 'Agent', ...BYPASS_TOOLS]);
    const prompt = (o.systemPrompt as string[])[2] ?? '';
    expect(prompt).toMatch(/Proyecto: ninguno \(agente suelto\)/);
    expect(prompt).toMatch(/## Modo: chat/);
    expect(prompt).not.toMatch(/## Agente suelto/);
    const pre = guardAt(o, folder);
    expect(await pre('Write', { file_path: join(folder, 'notas.md'), content: 'x' })).toBe('{}');
    expect(await pre('Write', { file_path: join(extra, 'notas.md'), content: 'x' })).toBe('{}');
    expect(await pre('Write', { file_path: join(outside, 'x.md'), content: 'x' })).toMatch(/"deny".*solo puedes escribir dentro/);
    expect(await pre('Bash', { command: 'git status' })).toBe('{}');
    expect(await pre('Bash', { command: 'git push' })).toMatch(/"deny".*git push/);
    expect(await pre('mcp__orquestador__crear_tareas', { plan: 'x' })).toMatch(/"deny"/);
    s.close();
  });

  it('la guardia acota la escritura y niega la flota: denyPaths, git push, rm -rf fuera, crear_tareas y delegar', async () => {
    const { s, q } = open('chat');
    s.send('hola');
    const pre = guardAt(optionsOf(q), folder);
    expect(await pre('Edit', { file_path: join(folder, 'src', 'a.ts'), old_string: 'a', new_string: 'b' })).toBe('{}');
    expect(await pre('Write', { file_path: join(folder, 'nucleo.db'), content: 'x' })).toMatch(/"deny".*datos del núcleo/);
    expect(await pre('Write', { file_path: vault, content: '{}' })).toMatch(/"deny"/);
    expect(await pre('Bash', { command: `rm -rf ${outside.replace(/\\/g, '/')}` })).toMatch(/"deny".*fuera del worktree/);
    expect(await pre('PowerShell', { command: 'git push origin main' })).toMatch(/"deny"/);
    // Fuera de allowedTools y, además, la guardia dinámica del modo chat.
    expect(await pre('mcp__orquestador__crear_tareas', { plan: 'x' })).toMatch(/"deny"/);
    expect(await pre('mcp__orquestador__delegar', { taskId: 'api' })).toMatch(/"deny"/);
    expect(await pre('mcp__orquestador__estado', {})).toBe('{}');
    // En chat no se leen las unidades enteras (eso es del bypass).
    expect(await pre('Read', { file_path: join(outside, 'x.md') })).toMatch(/"deny"/);
    s.close();
  });

  it('cambio de modo en una sesión viva: de chat a plan niega edición; de bypass a chat niega crear_tareas y delegar', async () => {
    let mode: 'chat' | 'plan' | 'bypass' = 'chat';
    const one = open(() => mode);
    one.s.send('hola');
    const pre = guardAt(optionsOf(one.q), folder);
    expect(await pre('Write', { file_path: join(folder, 'a.md'), content: 'x' })).toBe('{}');
    mode = 'plan';
    expect(await pre('Write', { file_path: join(folder, 'a.md'), content: 'x' })).toMatch(/"deny".*solo está disponible en los modos bypass y chat/);
    one.s.close();

    mode = 'bypass';
    const two = open(() => mode);
    two.s.send('hola');
    const pre2 = guardAt(optionsOf(two.q), folder);
    expect(await pre2('mcp__orquestador__delegar', { taskId: 'api' })).toBe('{}');
    mode = 'chat';
    expect(await pre2('mcp__orquestador__delegar', { taskId: 'api' })).toMatch(/"deny".*no está disponible en modo chat/);
    expect(await pre2('mcp__orquestador__crear_tareas', { plan: 'x' })).toMatch(/"deny".*no está disponible en modo chat/);
    expect(await pre2('Write', { file_path: join(folder, 'a.md'), content: 'x' })).toBe('{}');
    two.s.close();
  });
});

describe('ConductorSession: esfuerzo en vivo (setEffort)', () => {
  const withFlags = (flags?: 'ok' | 'reject') => {
    const q = scriptedQuery((m) => [assistantText(`eco: ${userText(m)}`), resultMessage('ok')], flags ? { flags } : {});
    const s = new ConductorSession({ ports: fakePorts(), projectId: 'demo', cwd: 'C:\\dev\\demo', apiKey: PROXY_KEY, baseEnv: BASE_ENV, query: q.fn });
    return { s, q };
  };

  it('antes del primer mensaje cambia las opciones del SDK', async () => {
    const { s, q } = withFlags();
    expect(s.effort).toBe('high');
    expect(await s.setEffort('low')).toBe(true);
    expect(s.effort).toBe('low');
    s.send('hola');
    expect(optionsOf(q).effort).toBe('low');
    s.close();
  });

  it('con la conversación en marcha usa applyFlagSettings({ effortLevel }) sin recrear el proceso', async () => {
    const { s, q } = withFlags('ok');
    s.send('hola');
    expect(await s.setEffort('high')).toBe(true);
    expect(q.flags).toEqual([]);
    expect(await s.setEffort('max')).toBe(true);
    expect(q.flags).toEqual([{ effortLevel: 'max' }]);
    expect(s.effort).toBe('max');
    expect(q.calls).toHaveLength(1);
    s.close();
    expect(await s.setEffort('low')).toBe(false);
  });

  it('si el SDK no lo permite o falla, devuelve false y la sesión sigue con su esfuerzo', async () => {
    const old = withFlags();
    old.s.send('hola');
    expect(await old.s.setEffort('low')).toBe(false);
    expect(old.s.effort).toBe('high');
    old.s.close();
    const failing = withFlags('reject');
    failing.s.send('hola');
    expect(await failing.s.setEffort('low')).toBe(false);
    expect(failing.q.flags).toEqual([{ effortLevel: 'low' }]);
    expect(failing.s.effort).toBe('high');
    failing.s.close();
  });
});
