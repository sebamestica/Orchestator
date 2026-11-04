import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookCallbackMatcher, HookInput, Options, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeSdkAdapter, ClaudeSdkTranslator, decideToolUse } from '../../../../src/core/adapters/claude-sdk/index.ts';
import { FAKE_KEY, collect, config, ctx, fakeQuery, loadJsonl, payload, task } from './helpers.ts';

/**
 * Reproducciones de la revisión de seguridad de Codex (agent-hub/revisiones/2026-11-01-c1-permisos-codex.md).
 * Cada bloque corresponde a un hallazgo; deben fallar con la política anterior y pasar con la nueva.
 */

let root = '';
let WT = ''; // worktree de la tarea
let OUT = ''; // carpeta fuera del worktree
const fwd = (p: string) => p.replace(/\\/g, '/');

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'orq-permisos-'));
  WT = join(root, 'wt');
  OUT = join(root, 'fuera');
  mkdirSync(join(WT, 'src'), { recursive: true });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(WT, 'a.txt'), 'a');
  writeFileSync(join(OUT, 'existente.txt'), 'x');
  // Junction dentro del worktree que apunta fuera (no requiere permisos de administrador en Windows).
  symlinkSync(OUT, join(WT, 'enlace'), 'junction');
  writeFileSync(join(WT, 'CLAUDE.md'), '@AGENTS.md\n');
  writeFileSync(join(WT, 'AGENTS.md'), '# Reglas\nLa palabra clave es ARANDANO.\n');
  mkdirSync(join(WT, '.claude'));
  writeFileSync(join(WT, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash', 'Write', 'mcp__fs__write_file'] } }));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

async function decision(tool: string, input: Record<string, unknown>, opts?: Parameters<typeof decideToolUse>[3]) {
  return (await decideToolUse(WT, tool, input, opts)).behavior;
}
const bash = (command: string) => decision('Bash', { command });
const ps = (command: string) => decision('PowerShell', { command });

describe('hallazgo 3 (ALTA): comandos prohibidos que eludían las regex', () => {
  const denied = [
    'git "push"',
    "git 'push' origin main",
    'g\\it push',
    'git -c alias.ship=push ship',
    'git -calias.x=push x',
    'git clean --force',
    'git clean --forc -d',
    'npm --registry=https://registry.npmjs.org publish',
    'npm publish --access public',
    'git ship',
    'G=git; $G push',
    'git $(echo push)',
    'git `echo push`',
    'eval "git push"',
    'bash -c "git push"',
    "sh -c 'git push --force'",
    'cmd /c "git push"',
    'powershell -Command "git push"',
    'powershell -EncodedCommand ZwBpAHQAIABwAHUAcwBoAA==',
    'git config remote.origin.pushurl https://example.com/x.git',
    'git config --global alias.p push',
    'git remote set-url origin https://example.com/x.git',
    'git --git-dir=C:/otro/.git status',
    'git --work-tree C:/otro status',
    'GIT_DIR=C:/otro/.git git status',
    'export GIT_DIR=C:/otro/.git',
    'git branch -D vieja',
    'git branch -fd vieja',
    'git reset --ha HEAD~1',
    'git rebase -i main',
    'echo push | xargs git',
    'git status; git push',
    'git status && git push',
    'git status || git push',
    'git status\ngit push',
    'GIT.EXE push',
    '/usr/bin/git push',
    'env git push',
    'git -C ../otro-repo commit -m x',
    'gh pr create --fill',
  ];
  for (const command of denied) {
    it(`deniega: ${JSON.stringify(command)}`, async () => {
      expect(await bash(command)).toBe('deny');
    });
  }

  const allowed = [
    'git status',
    'git log --oneline -5',
    'git commit -m "feat(core): push de los cambios"',
    'git diff -- src/push.ts',
    'git add -A && git commit -m "fix: x"',
    'git -C . status',
    'git branch',
    'git reset HEAD a.txt',
    'npm run -s check',
    'npx vitest run tests/core',
    'echo push',
    'git stash list',
  ];
  for (const command of allowed) {
    it(`permite: ${JSON.stringify(command)}`, async () => {
      expect(await bash(command)).toBe('allow');
    });
  }

  it('PowerShell: mismas reglas para git', async () => {
    expect(await ps("git 'push'")).toBe('deny');
    expect(await ps('& git push')).toBe('deny');
    expect(await ps('git `pu`sh')).toBe('deny');
    expect(await ps('$c = "push"; git $c')).toBe('deny');
    expect(await ps('Invoke-Expression "git push"')).toBe('deny');
    expect(await ps('git status; git log -1')).toBe('allow');
  });
});

describe('hallazgo 4 (ALTA): escrituras de Bash/PowerShell fuera del worktree', () => {
  it('deniega redirecciones y comandos de archivos con destino fuera', async () => {
    const out = fwd(OUT);
    for (const command of [
      `echo x > ${out}/x.txt`,
      `echo x >> "${OUT}\\x.txt"`,
      `cp a.txt ${out}/`,
      `mv a.txt ${out}/b.txt`,
      `rm -rf ${out}`,
      `mkdir ${out}/nueva`,
      'touch ../fuera.txt',
      `tee ${out}/x.txt < a.txt`,
      `cd ${out} && rm existente.txt`,
      `echo x 2> ${out}/err.log`,
      `node -e "require('fs').writeFileSync('${out}/x','d')"`,
      `python -c "open('${out}/x','w')"`,
      'echo x > ~/x.txt',
      'echo x > /tmp/x.txt',
      'echo x > "$HOME/x.txt"',
      `ln -s ${out} enlace2`,
    ]) {
      expect(await bash(command), command).toBe('deny');
    }
    for (const command of [
      `Set-Content ${OUT}\\x.txt dato`,
      `"dato" | Out-File -FilePath ${OUT}\\x.txt`,
      `Copy-Item a.txt -Destination ${OUT}\\`,
      `Move-Item a.txt ${OUT}\\b.txt`,
      `New-Item -ItemType File -Path ${OUT}\\n.txt`,
      `Remove-Item ${OUT} -Recurse -Force`,
      `Set-Content -Pa ${OUT}\\x.txt -Value dato`,
      `Add-Content -LiteralPath:${OUT}\\x.txt dato`,
      `[IO.File]::WriteAllText('${OUT}\\x.txt', 'd')`,
      `New-Item -ItemType Junction -Path enlace3 -Target ${OUT}`,
      `del ${OUT}\\existente.txt`,
      `"x" > ${OUT}\\x.txt`,
    ]) {
      expect(await ps(command), command).toBe('deny');
    }
    expect(await bash(`powershell -Command "Set-Content ${OUT}\\x.txt dato"`)).toBe('deny');
    expect(await bash(`cmd /c "echo x > ${OUT}\\x.txt"`)).toBe('deny');
  });

  it('permite escrituras dentro del worktree y copiar desde fuera hacia dentro', async () => {
    for (const command of [
      'echo x > salida.txt',
      'echo x >> src/log.txt',
      `cp ${fwd(OUT)}/existente.txt ./copia.txt`,
      'rm -rf dist',
      'mkdir -p src/nuevo',
      'echo x > /dev/null 2>&1',
      `cd src && echo x > y.txt`,
      `echo x > "${WT}\\src\\z.txt"`,
    ]) {
      expect(await bash(command), command).toBe('allow');
    }
    for (const command of ['Set-Content .\\x.txt dato', 'npm run build > $null', `Copy-Item ${OUT}\\existente.txt .\\copia.txt`, 'Remove-Item .\\dist -Recurse']) {
      expect(await ps(command), command).toBe('allow');
    }
  });
});

describe('hallazgo 5 (ALTA): junctions y enlaces dentro del worktree', () => {
  it('deniega escribir a través de una junction que sale del worktree', async () => {
    expect(await decision('Write', { file_path: join(WT, 'enlace', 'x.txt'), content: '' })).toBe('deny');
    expect(await decision('Edit', { file_path: join(WT, 'enlace', 'existente.txt'), old_string: 'x', new_string: 'y' })).toBe('deny');
    expect(await decision('Write', { file_path: 'enlace/sub/nuevo.txt', content: '' })).toBe('deny');
    expect(await bash('echo x > enlace/x.txt')).toBe('deny');
    expect(await ps('Set-Content .\\enlace\\x.txt dato')).toBe('deny');
  });

  it('permite archivos nuevos en carpetas nuevas del worktree', async () => {
    expect(await decision('Write', { file_path: join(WT, 'src', 'nueva', 'b.ts'), content: '' })).toBe('allow');
    expect(await decision('Edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' })).toBe('allow');
  });

  it('no deja editar la configuración ejecutable del repo', async () => {
    expect(await decision('Write', { file_path: join(WT, '.claude', 'settings.json'), content: '{}' })).toBe('deny');
    expect(await decision('Write', { file_path: join(WT, '.git'), content: 'gitdir: C:/otro' })).toBe('deny');
    expect(await decision('Write', { file_path: '.mcp.json', content: '{}' })).toBe('deny');
  });
});

describe('hallazgo 2 (ALTA): herramientas desconocidas y MCP', () => {
  it('deniega por defecto las herramientas fuera de la lista', async () => {
    expect(await decision('mcp__fs__write_file', { path: join(OUT, 'x.txt'), content: 'x' })).toBe('deny');
    expect(await decision('HerramientaNueva', {})).toBe('deny');
    expect(await decision('WebFetch', { url: 'https://example.com', prompt: 'x' })).toBe('deny');
    expect(await decision('EnterWorktree', {})).toBe('deny');
  });

  it('permite las integradas de la lista y las configuradas a mano', async () => {
    expect(await decision('Read', { file_path: join(WT, 'a.txt') })).toBe('allow');
    expect(await decision('Grep', { pattern: 'x', path: 'src' })).toBe('allow');
    expect(await decision('Glob', { pattern: 'src/**/*.ts' })).toBe('allow');
    expect(await decision('TodoWrite', { todos: [] })).toBe('allow');
    expect(await decision('Agent', { description: 'x', prompt: 'y', subagent_type: 'general-purpose' })).toBe('allow');
    expect(await decision('mcp__orq__estado', {}, { extraTools: ['mcp__orq__estado'] })).toBe('allow');
  });

  it('las lecturas fuera del worktree solo en las rutas de lectura autorizadas', async () => {
    expect(await decision('Read', { file_path: join(OUT, 'existente.txt') })).toBe('deny');
    expect(await decision('Glob', { pattern: `${fwd(OUT)}/**/*` })).toBe('deny');
    expect(await decision('Grep', { pattern: 'clave', path: OUT })).toBe('deny');
    expect(await decision('Read', { file_path: join(OUT, 'existente.txt') }, { readRoots: [OUT] })).toBe('allow');
  });
});

/** Ejecuta el primer hook PreToolUse configurado por el adaptador. */
async function runHook(options: Options, tool: string, toolInput: Record<string, unknown>): Promise<SyncHookJSONOutput> {
  const matchers = options.hooks?.PreToolUse as HookCallbackMatcher[] | undefined;
  const hook = matchers?.[0]?.hooks[0];
  if (!hook) throw new Error('sin hook PreToolUse');
  const input = { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, tool_use_id: 't1', session_id: 's', transcript_path: 'x', cwd: WT } as HookInput;
  return (await hook(input, 't1', { signal: new AbortController().signal })) as SyncHookJSONOutput;
}

describe('hallazgo 1 (ALTA): la política se aplica antes que reglas y modo', () => {
  it('registra un hook PreToolUse que deniega aunque settings.json del proyecto permita Bash', async () => {
    const fake = fakeQuery(loadJsonl('subagent-run.jsonl'));
    await collect(new ClaudeSdkAdapter({ config, query: fake.query }).run(task, ctx({ worktreePath: WT })));
    const options = fake.calls[0]?.options as Options;
    const out = await runHook(options, 'Bash', { command: 'git "push"' });
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
    const ok = await runHook(options, 'Bash', { command: 'git status' });
    expect(ok.hookSpecificOutput).toMatchObject({ permissionDecision: 'allow' });
  });

  it('no carga la configuración ejecutable del proyecto y pasa CLAUDE.md/AGENTS.md por el prompt de sistema', async () => {
    const fake = fakeQuery(loadJsonl('subagent-run.jsonl'));
    await collect(new ClaudeSdkAdapter({ config, query: fake.query }).run(task, ctx({ worktreePath: WT })));
    const options = fake.calls[0]?.options as Options;
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
    const append = (options.systemPrompt as { append?: string }).append ?? '';
    expect(append).toContain('ARANDANO');
    expect(append).not.toContain('permissions');
  });

  it('el hook falla cerrado: un error en la política deniega', async () => {
    const fake = fakeQuery(loadJsonl('subagent-run.jsonl'));
    await collect(new ClaudeSdkAdapter({ config, query: fake.query }).run(task, ctx({ worktreePath: WT })));
    const out = await runHook(fake.calls[0]?.options as Options, 'Write', { file_path: 42 });
    expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
  });
});

describe('hallazgo 6 (MEDIA): todos los campos de texto de los eventos se tachan', () => {
  it('file_change.path no deja pasar la clave', () => {
    const tr = new ClaudeSdkTranslator({ agentId: 'claude-main', sessionId: 'main', secrets: [FAKE_KEY], cwd: WT });
    const events = [
      { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'w', name: 'Write', input: { file_path: `src/${FAKE_KEY}.txt`, content: '' } }] } },
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'w', content: 'ok' }] } },
      { type: 'system', subtype: 'task_started', task_id: FAKE_KEY, description: 'x' },
    ].flatMap((m) => tr.translate(m));
    expect(payload(events, 'file_change')).toHaveLength(1);
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain(FAKE_KEY);
  });
});

describe('endurecimiento adicional (revisión propia tras el arreglo)', () => {
  it('bash: palabras clave, variables que lanzan programas, awk y sed', async () => {
    for (const command of [
      'if git push; then echo ok; fi',
      'while git push; do :; done',
      "EDITOR=\"sh -c 'git push'\" git commit",
      'GIT_SSH_COMMAND=x git fetch',
      'npm_config_global=true npm i paquete',
      "awk 'BEGIN{system(\"git push\")}'",
      "sed -i 's/a/b/e' a.txt",
      'git fetch --upload-pack=x origin',
      'git fetch origin main:flota/c2',
      'git pull --rebase',
      'git archive --remote=x --exec=y HEAD',
    ]) {
      expect(await bash(command), command).toBe('deny');
    }
    for (const command of ['echo $(git push)', 'x=$(rm -rf ../fuera)', 'echo "hoy $(git -c alias.x=push x)"', 'git commit -m "$(cat <<EOF\n$(git push)\nEOF\n)"']) {
      expect(await bash(command), command).toBe('deny');
    }
    for (const command of [
      "sed -i 's/a/b/' a.txt",
      'git fetch origin',
      'git pull',
      "awk '{print $1}' a.txt",
      'for f in a b; do echo $f; done',
      'git commit -m "$(cat <<\'EOF\'\nfeat(core): mensaje (con paréntesis)\n\nCo-Authored-By: x\nEOF\n)"',
      'echo "rama: $(git rev-parse --abbrev-ref HEAD)"',
    ]) {
      expect(await bash(command), command).toBe('allow');
    }
  });

  it('PowerShell: operadores de llamada, métodos .NET, tuberías y bloques', async () => {
    for (const command of [
      "&('gi'+'t') push",
      `(Get-Item ${OUT}\\existente.txt).Delete()`,
      `$f = Get-Item ${OUT}\\existente.txt; $f.Delete()`,
      `Get-ChildItem ${OUT} | Remove-Item`,
      'if ($true) { git push }',
      '. .\\script.ps1',
      "$env:GIT_DIR = 'C:\\otro\\.git'",
      'git status; $x = git push',
    ]) {
      expect(await ps(command), command).toBe('deny');
    }
    expect(await ps('Write-Output "x: $(git push)"')).toBe('deny');
    for (const command of ['Get-Content a.txt | Set-Content b.txt', '$n = 3', 'Get-ChildItem src | Select-Object Name', '.\\script.ps1', 'Write-Output "hoy: $(Get-Date)"']) {
      expect(await ps(command), command).toBe('allow');
    }
  });

  it('cmd: if, for /f y call', async () => {
    expect(await bash('cmd /c "if exist a.txt git push"')).toBe('deny');
    expect(await bash("cmd /c \"for /f %i in ('git push') do echo %i\"")).toBe('deny');
    expect(await bash('cmd /c "call git push"')).toBe('deny');
    expect(await bash('cmd /c "dir /b"')).toBe('allow');
  });

  it('la carpeta de la sesión y los subagentes deben quedar dentro del worktree', async () => {
    expect(await decision('Bash', { command: 'ls' }, { cwd: OUT })).toBe('deny');
    expect(await decision('Bash', { command: 'echo x > b.txt' }, { cwd: join(WT, 'src') })).toBe('allow');
    expect(await decision('Bash', { command: 'echo x > ../../fuera/b.txt' }, { cwd: join(WT, 'src') })).toBe('deny');
    expect(await decision('Agent', { description: 'x', prompt: 'y', isolation: 'worktree' })).toBe('deny');
  });
});

describe('fixture real: el hook deniega git "push" en una sesión del SDK', () => {
  it('la denegación llega como tool_result con error y la escritura permitida como file_change', () => {
    const tr = new ClaudeSdkTranslator({ agentId: 'claude-main', sessionId: 'main', cwd: 'C:\\orq-fixture\\worktree' });
    const events = loadJsonl('hook-deny.jsonl').flatMap((m) => tr.translate(m));
    const calls = payload(events, 'tool_call');
    const results = payload(events, 'tool_result');
    const push = calls.find((p) => p.name === 'Bash');
    expect(push?.inputSummary).toBe('git "push"');
    const denied = results.find((r) => r.callId === push?.callId);
    expect(denied).toMatchObject({ ok: false, summary: expect.stringContaining('Bloqueado por el orquestador: git push necesita la aprobación del usuario') });
    expect(payload(events, 'file_change')).toEqual([{ path: 'hook-ok.txt', change: 'add' }]);
    expect(events.at(-1)?.payload).toMatchObject({ ok: true });
    expect(events.filter((e) => e.type === 'raw')).toEqual([]);
  });
});
