import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createToolGuard } from '../../../src/core/conductor/index.ts';
import type { ToolGuard } from '../../../src/core/conductor/index.ts';
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

describe('guardia de bypass: escritura y shell (disco real)', () => {
  const tools = ['Read', 'Grep', 'Glob', 'Agent', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell'];
  let base = '';
  let root = '';
  let extra = '';
  let outside = '';
  let data = '';
  let vault = '';
  let guard: ToolGuard;
  const pre = (tool_name: string, tool_input: unknown, cwd = root): HookInput => ({
    hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'tu', session_id: 's', transcript_path: 't', cwd,
  });
  const signal = new AbortController().signal;
  const allowed = async (tool: string, input: unknown, cwd?: string) => (await guard.decide(tool, input, cwd)).allow;
  const reason = async (tool: string, input: unknown, cwd?: string) => {
    const d = await guard.decide(tool, input, cwd);
    return d.allow ? '' : d.reason;
  };

  beforeAll(() => {
    base = mkdtempSync(path.join(tmpdir(), 'orq-guardia-'));
    root = path.join(base, 'proyecto');
    extra = path.join(base, 'extra');
    outside = path.join(base, 'fuera');
    data = path.join(base, 'datos-nucleo');
    for (const dir of [root, extra, outside, data, path.join(root, 'src'), path.join(root, '.git')]) mkdirSync(dir, { recursive: true });
    vault = path.join(data, 'vault.json');
    symlinkSync(outside, path.join(root, 'enlace'), 'junction');
    writeFileSync(path.join(outside, 'doc.txt'), 'fuera');
    writeFileSync(path.join(root, 'src', 'a.ts'), 'a');
    writeFileSync(vault, '{}');
    // Como «Configuración local» → AppData\Local: otro nombre para la carpeta de datos del núcleo.
    symlinkSync(data, path.join(root, 'datos'), 'junction');
    symlinkSync(path.join(root, 'src'), path.join(root, 'alias'), 'junction');
    mkdirSync(path.join(root, '.claude'));
    symlinkSync(path.join(root, '.git'), path.join(root, 'alias-git'), 'junction');
    symlinkSync(path.join(root, '.claude'), path.join(root, 'alias-claude'), 'junction');
    guard = createToolGuard({
      allowedTools: tools,
      cwd: root,
      readRoots: [extra, 'C:\\'],
      writeRoots: [root, extra],
      shellRoot: root,
      denyPaths: [vault, path.join(root, 'nucleo.db')],
    });
  });
  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('permite escribir dentro del proyecto y de las carpetas extra', async () => {
    expect(await allowed('Write', { file_path: path.join(root, 'GUIONES.md'), content: '# Guiones' })).toBe(true);
    expect(await allowed('Write', { file_path: 'src/nuevo/modulo.ts', content: 'x' })).toBe(true);
    expect(await allowed('Edit', { file_path: path.join(root, 'src', 'a.ts'), old_string: 'a', new_string: 'b' })).toBe(true);
    expect(await allowed('NotebookEdit', { notebook_path: path.join(root, 'analisis.ipynb'), new_source: 'x' })).toBe(true);
    expect(await allowed('Write', { file_path: path.join(extra, 'notas.md'), content: 'x' })).toBe(true);
  });

  it('niega escribir fuera, en denyPaths, en .git, en credenciales y a través de una junction', async () => {
    expect(await reason('Write', { file_path: path.join(outside, 'x.md'), content: 'x' })).toMatch(/solo puedes escribir dentro del proyecto/);
    expect(await reason('Write', { file_path: '../fuera/x.md', content: 'x' })).toMatch(/solo puedes escribir dentro del proyecto/);
    // La bóveda queda fuera de las raíces de escritura aunque se pueda leer el disco entero.
    expect(await allowed('Write', { file_path: vault, content: '{}' })).toBe(false);
    // denyPaths gana aunque la ruta esté dentro del proyecto.
    expect(await reason('Write', { file_path: path.join(root, 'nucleo.db'), content: 'x' })).toMatch(/datos del núcleo/);
    expect(await reason('Edit', { file_path: path.join(root, '.git', 'config'), old_string: 'a', new_string: 'b' })).toMatch(/protegida/);
    expect(await reason('Write', { file_path: path.join(root, '.env'), content: 'X=1' })).toMatch(/credenciales/);
    expect(await reason('Write', { file_path: path.join(root, 'enlace', 'x.md'), content: 'x' })).toMatch(/ruta real/);
    expect(await allowed('Write', { content: 'sin ruta' })).toBe(false);
    expect(await allowed('Write', { file_path: 42 })).toBe(false);
  });

  it('la lectura sigue junctions: no sale de las raíces ni llega a denyPaths por otro nombre', async () => {
    const strict = createToolGuard({ allowedTools: tools, cwd: root, readRoots: [extra] });
    const read = async (tool: string, input: unknown) => {
      const d = await strict.decide(tool, input);
      return d.allow ? '' : d.reason;
    };
    expect(await read('Read', { file_path: path.join(root, 'enlace', 'doc.txt') })).toMatch(/ruta real/);
    expect(await read('Read', { file_path: 'enlace/doc.txt' })).toMatch(/ruta real/);
    expect(await read('Grep', { pattern: 'x', path: 'enlace' })).toMatch(/ruta real/);
    expect(await read('Glob', { path: root, pattern: path.join(root, 'enlace', '*') })).toMatch(/ruta real/);
    expect(await read('Glob', { pattern: 'enlace/**/*.txt' })).toMatch(/ruta real/);
    // Con el disco entero como raíz (bypass), la bóveda sigue vetada aunque se nombre a través de una junction.
    expect(await reason('Read', { file_path: path.join(root, 'datos', 'vault.json') })).toMatch(/credenciales/);
    // Control: una junction interna y la lectura normal siguen permitidas.
    expect(await read('Read', { file_path: path.join(root, 'alias', 'a.ts') })).toBe('');
    expect(await read('Read', { file_path: 'src/a.ts' })).toBe('');
    expect(await read('Grep', { pattern: 'x' })).toBe('');
    expect(await allowed('Read', { file_path: path.join(outside, 'doc.txt') })).toBe(true);
  });

  it('una junction interna hacia .git o .claude no deja escribir en ellas', async () => {
    expect(await reason('Write', { file_path: path.join(root, 'alias-git', 'config'), content: 'x' })).toMatch(/protegida/);
    expect(await reason('Edit', { file_path: 'alias-claude/settings.json', old_string: 'a', new_string: 'b' })).toMatch(/protegida/);
    expect(await reason('Write', { file_path: path.join(root, 'alias-git', 'hooks', 'nuevo', 'x'), content: 'x' })).toMatch(/protegida/);
    expect(await reason('PowerShell', { command: 'Add-Content alias-git\\config x' })).toMatch(/protegida/);
    expect(await reason('Bash', { command: 'echo x >> alias-git/config' })).toMatch(/protegida/);
    expect(await allowed('Write', { file_path: path.join(root, 'alias', 'nuevo.ts'), content: 'x' })).toBe(true);
  });

  it('el shell pasa por la política de los workers con el proyecto como raíz', async () => {
    for (const command of ['git status', 'git diff --stat', 'npm run -s check', 'npx vitest run', 'echo hola > notas.txt', 'rm -rf build', 'mkdir -p docs/guiones']) {
      expect(await allowed('Bash', { command }), command).toBe(true);
    }
    expect(await allowed('PowerShell', { command: 'Get-ChildItem src' })).toBe(true);
    expect(await reason('Bash', { command: 'git push' })).toMatch(/Bash bloqueado por la guardia: git push necesita la aprobación del usuario/);
    expect(await reason('Bash', { command: 'git add -A && git push origin main --force' })).toMatch(/git push/);
    expect(await reason('PowerShell', { command: 'git push origin flota/x' })).toMatch(/git push/);
    expect(await reason('Bash', { command: `rm -rf ${outside.replace(/\\/g, '/')}` })).toMatch(/fuera del worktree/);
    expect(await reason('Bash', { command: 'rm -rf ../fuera' })).toMatch(/fuera del worktree/);
    expect(await reason('PowerShell', { command: `Remove-Item -Recurse -Force ${outside}` })).toMatch(/fuera del worktree/);
    for (const command of ['git reset --hard HEAD~1', 'git rebase main', 'git branch -D vieja', 'npm publish', 'npx vercel deploy --prod']) {
      expect(await allowed('Bash', { command }), command).toBe(false);
    }
    expect(await allowed('Bash', { command: '' })).toBe(false);
  });

  it('el shell no nombra la bóveda ni la carpeta de datos del núcleo, ni trabaja fuera del proyecto', async () => {
    expect(await reason('PowerShell', { command: `Get-Content ${vault}` })).toMatch(/datos del núcleo/);
    expect(await reason('Bash', { command: `cat ${vault.replace(/\\/g, '/')}` })).toMatch(/datos del núcleo/);
    expect(await reason('Bash', { command: `cd ${data} && cat vault.json` })).toMatch(/datos del núcleo/);
    expect(await reason('Bash', { command: 'git status' }, outside)).toMatch(/fuera del proyecto/);
    expect(await allowed('Bash', { command: 'git status' }, path.join(root, 'src'))).toBe(true);
  });

  it('con la sesión fuera del proyecto, un comando que empieza volviendo con cd se evalúa; el resto se niega', async () => {
    const fwdRoot = root.replace(/\\/g, '/');
    expect(await allowed('Bash', { command: `cd ${fwdRoot}` }, outside)).toBe(true);
    expect(await allowed('PowerShell', { command: `Set-Location ${root}; Get-ChildItem` }, outside)).toBe(true);
    expect(await allowed('Bash', { command: `cd ${fwdRoot}/src && git status` }, outside)).toBe(true);
    expect(await allowed('PowerShell', { command: `pushd ${root}` }, outside)).toBe(true);
    expect(await reason('Bash', { command: 'git status' }, outside)).toMatch(/fuera del proyecto.*cd /);
    expect(await reason('Bash', { command: `cd ${fwdRoot} && git push` }, outside)).toMatch(/git push/);
    expect(await allowed('Bash', { command: `cd ${outside.replace(/\\/g, '/')}` }, outside)).toBe(false);
    // Por tubería el cd corre en otro proceso: lo que sigue no se ejecuta en el proyecto.
    expect(await allowed('Bash', { command: `cd ${fwdRoot} | ls` }, outside)).toBe(false);
    expect(await guard.hook(pre('Bash', { command: `cd ${fwdRoot}` }, outside), 'tu', { signal })).toEqual({});
  });

  it('check síncrono nunca aprueba edición ni shell; el hook y canUseTool usan la decisión completa', async () => {
    expect(guard.check('Write', { file_path: path.join(root, 'a.md'), content: 'x' }).allow).toBe(false);
    expect(guard.check('Bash', { command: 'git status' }).allow).toBe(false);
    expect(guard.check('Read', { file_path: path.join(root, 'a.md') })).toEqual({ allow: true });
    expect(await guard.hook(pre('Write', { file_path: path.join(root, 'a.md'), content: 'x' }), 'tu', { signal })).toEqual({});
    expect(await guard.hook(pre('Bash', { command: 'git status' }), 'tu', { signal })).toEqual({});
    expect(JSON.stringify(await guard.hook(pre('Bash', { command: 'git push' }), 'tu', { signal }))).toMatch(/"permissionDecision":"deny"/);
    expect(JSON.stringify(await guard.hook(pre('Bash', { command: 'ls' }, outside), 'tu', { signal }))).toMatch(/fuera del proyecto/);
    expect(await guard.canUseTool('Write', { file_path: path.join(outside, 'x'), content: 'x' }, { signal, toolUseID: 'a', requestId: 'r' })).toMatchObject({ behavior: 'deny' });
    expect(await guard.canUseTool('Bash', { command: 'git status' }, { signal, toolUseID: 'b', requestId: 'r' })).toEqual({ behavior: 'allow', updatedInput: { command: 'git status' } });
  });

  it('con escritura, los subagentes no se van a un worktree propio; sin escritura no cambia nada', async () => {
    expect(await reason('Agent', { description: 'x', prompt: 'y', isolation: 'worktree' })).toMatch(/sin worktree propio/);
    expect(await allowed('Agent', { description: 'x', prompt: 'y' })).toBe(true);
    const readOnly = createToolGuard({ allowedTools: ['Read', 'Agent'], cwd: root });
    expect(readOnly.check('Agent', { description: 'x', prompt: 'y', isolation: 'worktree' }).allow).toBe(true);
  });

  it('sin writeRoots ni shellRoot, Edit y Bash se niegan aunque estén permitidos', async () => {
    const bare = createToolGuard({ allowedTools: tools, cwd: root });
    expect((await bare.decide('Write', { file_path: path.join(root, 'a.md'), content: 'x' })).allow).toBe(false);
    expect((await bare.decide('Bash', { command: 'git status' })).allow).toBe(false);
  });
});
