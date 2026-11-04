import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createToolGuard } from '../../../src/core/conductor/index.ts';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';

const allowedTools = ['mcp__orquestador__estado', 'Read', 'Grep', 'Glob', 'Agent'];

describe('guardia de herramientas (rutas de Windows)', () => {
  const guard = createToolGuard({ allowedTools, cwd: 'C:\\dev\\demo', readRoots: ['C:\\dev\\agent-hub\\skills'], pathApi: path.win32 });

  it('solo deja pasar las herramientas permitidas', () => {
    expect(guard.check('mcp__orquestador__estado', {})).toEqual({ allow: true });
    expect(guard.check('Agent', { description: 'x', prompt: 'y' })).toEqual({ allow: true });
    for (const name of ['Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'mcp__otro__borrar']) {
      const decision = guard.check(name, {});
      expect(decision.allow, name).toBe(false);
      if (!decision.allow) expect(decision.reason).toMatch(/no está permitido/);
    }
  });

  it('la lectura queda dentro del proyecto y de las raíces extra', () => {
    expect(guard.check('Read', { file_path: 'C:\\dev\\demo\\AGENTS.md' }).allow).toBe(true);
    expect(guard.check('Read', { file_path: 'src\\index.ts' }).allow).toBe(true);
    expect(guard.check('Read', { file_path: 'c:\\DEV\\demo\\PLAN.md' }).allow).toBe(true);
    expect(guard.check('Read', { file_path: 'C:\\dev\\agent-hub\\skills\\pdf\\SKILL.md' }).allow).toBe(true);
    expect(guard.check('Read', { file_path: 'C:\\Users\\yo\\.claude.json' }).allow).toBe(false);
    expect(guard.check('Read', { file_path: '..\\otro\\secreto.txt' }).allow).toBe(false);
    expect(guard.check('Read', { file_path: 'C:\\dev\\demo-hermano\\x.ts' }).allow).toBe(false);
    expect(guard.check('Read', { file_path: 42 }).allow).toBe(false);
    expect(guard.check('Grep', { pattern: 'TODO' }).allow).toBe(true);
    expect(guard.check('Grep', { pattern: 'TODO', path: 'C:\\Windows' }).allow).toBe(false);
    expect(guard.check('Glob', { pattern: '**/*.ts' }).allow).toBe(true);
    expect(guard.check('Glob', { pattern: 'C:/Users/**/*.json' }).allow).toBe(false);
    expect(guard.check('Glob', { pattern: '../**/*.env' }).allow).toBe(false);
    expect(guard.check('Grep', { pattern: 'x', glob: '../../**' }).allow).toBe(false);
  });

  it('no lee archivos típicos de credenciales ni dentro del proyecto', () => {
    for (const file of ['.env', '.env.local', 'certs\\server.pem', 'id_ed25519', '.npmrc', 'credentials.json', '.git-credentials']) {
      expect(guard.check('Read', { file_path: file }).allow, file).toBe(false);
    }
    expect(guard.check('Read', { file_path: 'docs\\environment.md' }).allow).toBe(true);
  });

  it('los subagentes no amplían permisos ni corren en remoto', () => {
    expect(guard.check('Agent', { prompt: 'x', mode: 'bypassPermissions' }).allow).toBe(false);
    expect(guard.check('Agent', { prompt: 'x', mode: 'acceptEdits' }).allow).toBe(false);
    expect(guard.check('Agent', { prompt: 'x', mode: 'plan' }).allow).toBe(true);
    expect(guard.check('Agent', { prompt: 'x', isolation: 'remote' }).allow).toBe(false);
  });
});

describe('guardia de herramientas (rutas POSIX)', () => {
  const guard = createToolGuard({ allowedTools, cwd: '/repo/demo', pathApi: path.posix });
  it('resuelve rutas relativas y absolutas', () => {
    expect(guard.check('Read', { file_path: '/repo/demo/a.ts' }).allow).toBe(true);
    expect(guard.check('Read', { file_path: '/etc/passwd' }).allow).toBe(false);
    expect(guard.check('Glob', { pattern: '/etc/*' }).allow).toBe(false);
    expect(guard.check('Glob', { pattern: 'src/**/*.ts', path: '/repo/demo' }).allow).toBe(true);
  });
});

describe('hook PreToolUse y canUseTool', () => {
  const guard = createToolGuard({ allowedTools, cwd: 'C:\\dev\\demo', pathApi: path.win32 });
  const signal = new AbortController().signal;
  const pre = (tool_name: string, tool_input: unknown): HookInput => ({
    hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'tu_1', session_id: 's', transcript_path: 't', cwd: 'C:\\dev\\demo',
  });

  it('el hook niega lo no permitido y no decide lo permitido', async () => {
    expect(await guard.hook(pre('Bash', { command: 'git push' }), 'tu_1', { signal })).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: expect.stringMatching(/Bash no está permitido/) },
    });
    expect(await guard.hook(pre('Read', { file_path: 'AGENTS.md' }), 'tu_1', { signal })).toEqual({});
  });

  it('canUseTool niega o permite con la misma regla', async () => {
    expect(await guard.canUseTool('Write', { file_path: 'x' }, { signal, toolUseID: 'tu_2', requestId: 'r2' })).toMatchObject({ behavior: 'deny' });
    expect(await guard.canUseTool('Read', { file_path: 'x.ts' }, { signal, toolUseID: 'tu_3', requestId: 'r3' })).toEqual({ behavior: 'allow', updatedInput: { file_path: 'x.ts' } });
  });
});

describe('guardia dinámica (modos, raíces, plugins y rutas vetadas)', () => {
  it('deny se consulta en cada llamada', () => {
    let blocked = true;
    const guard = createToolGuard({
      allowedTools: ['mcp__orquestador__delegar', 'Read'],
      cwd: 'C:\\dev\\demo',
      pathApi: path.win32,
      deny: (name) => (blocked && name === 'mcp__orquestador__delegar' ? 'modo plan' : undefined),
    });
    expect(guard.check('mcp__orquestador__delegar', { taskId: 'a' })).toEqual({ allow: false, reason: 'modo plan' });
    blocked = false;
    expect(guard.check('mcp__orquestador__delegar', { taskId: 'a' })).toEqual({ allow: true });
  });

  it('readRoots como función: las raíces nuevas valen desde la llamada siguiente', () => {
    const roots: string[] = [];
    const guard = createToolGuard({ allowedTools: ['Read', 'Glob'], cwd: 'C:\\dev\\demo', readRoots: () => roots, pathApi: path.win32 });
    expect(guard.check('Read', { file_path: 'D:\\fotos\\a.txt' }).allow).toBe(false);
    roots.push('D:\\');
    expect(guard.check('Read', { file_path: 'D:\\fotos\\a.txt' }).allow).toBe(true);
    expect(guard.check('Glob', { pattern: 'D:/fotos/**' }).allow).toBe(true);
  });

  it('denyPaths gana sobre las raíces (bóveda y base de datos)', () => {
    const guard = createToolGuard({
      allowedTools: ['Read'],
      cwd: 'C:\\dev\\demo',
      readRoots: ['C:\\'],
      denyPaths: ['C:\\Users\\yo\\AppData\\Local\\orquestador\\vault.json'],
      pathApi: path.win32,
    });
    expect(guard.check('Read', { file_path: 'C:\\Users\\yo\\AppData\\Local\\orquestador\\vault.json' }).allow).toBe(false);
    expect(guard.check('Read', { file_path: 'C:\\Users\\yo\\notas.md' }).allow).toBe(true);
  });

  it('mcp__<servidor>__* permite las herramientas de ese servidor y de ningún otro', () => {
    const guard = createToolGuard({ allowedTools: ['mcp__chrome__*', 'Read'], cwd: '/repo', pathApi: path.posix });
    expect(guard.check('mcp__chrome__navigate_page', {}).allow).toBe(true);
    expect(guard.check('mcp__chrome__', {}).allow).toBe(false);
    expect(guard.check('mcp__chromex__navigate_page', {}).allow).toBe(false);
    expect(guard.check('Bash', {}).allow).toBe(false);
  });
});
