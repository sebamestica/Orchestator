import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FALLBACK_PRICE,
  classifyClaudeError,
  codeFromText,
  commandName,
  decideToolUse,
  estimateCostUsd,
  insecureUrlWarning,
  isInside,
  parseBash,
  parsePowerShell,
  priceOf,
  shellCommandProblem,
  taskReadRoots,
} from '../../../../src/core/adapters/claude-sdk/index.ts';
import { task } from './helpers.ts';

let WT = '';
beforeAll(() => {
  WT = mkdtempSync(join(tmpdir(), 'orq-politica-'));
});
afterAll(() => {
  if (WT) rmSync(WT, { recursive: true, force: true });
});

describe('política de herramientas', () => {
  it('bloquea comandos que necesitan aprobación del usuario', async () => {
    for (const cmd of [
      'git push',
      'git push origin flota/c1',
      'cd x && git -C repo push --force',
      'git reset --hard HEAD~1',
      'git rebase main',
      'git branch -D vieja',
      'git branch --delete vieja',
      'git clean -fdx',
      'npm publish',
      'npx vercel deploy --prod',
    ]) {
      expect(await shellCommandProblem(cmd, 'bash', WT), cmd).toBeDefined();
    }
  });

  it('permite el trabajo normal', async () => {
    for (const cmd of ['git status', 'git commit -m "feat: x"', 'git log --oneline', 'git branch', 'git reset HEAD archivo.ts', 'npm run -s check', 'npx vitest run', 'echo push']) {
      expect(await shellCommandProblem(cmd, 'bash', WT), cmd).toBeUndefined();
    }
  });

  it('los mensajes de denegación explican el motivo', async () => {
    const denied = await decideToolUse(WT, 'Bash', { command: 'git push' });
    expect(denied).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/^Bloqueado por el orquestador: git push necesita la aprobación del usuario/) });
    expect((await decideToolUse(WT, 'PowerShell', { command: 'git reset --hard' })).behavior).toBe('deny');
    expect((await decideToolUse(WT, 'Bash', {})).behavior).toBe('deny');
  });

  it('isInside resuelve rutas relativas contra el worktree', () => {
    expect(isInside(WT, WT)).toBe(true);
    expect(isInside(WT, join(WT, 'a', 'b'))).toBe(true);
    expect(isInside(WT, join(WT, '..', 'fuera'))).toBe(false);
  });

  it('el encargo autoriza la lectura de sus skills y notas', () => {
    const t = { ...task, skillRefs: ['C:\\dev\\agent-hub\\skills\\flota\\SKILL.md', 'relativa.md'], contextRefs: ['C:\\notas\\Contexto.md'] };
    expect(taskReadRoots(t)).toEqual(['C:\\dev\\agent-hub\\skills\\flota', 'C:\\notas\\Contexto.md']);
  });
});

describe('tokenizador de shells', () => {
  it('bash: comillas, escapes, separadores, redirecciones y heredocs', () => {
    const p = parseBash("git 'pu'\"sh\" o\\rigin; echo x >> a.txt 2>&1 && cat <<'EOF' > b.txt\n$(no se ejecuta)\nEOF\nls");
    expect(p.problems).toEqual([]);
    expect(p.commands.map((c) => c.words.map((w) => w.text))).toEqual([['git', 'push', 'origin'], ['echo', 'x'], ['cat'], ['ls']]);
    expect(p.commands[1]?.redirects.map((r) => [r.op, r.target.text])).toEqual([['>>', 'a.txt']]);
    expect(p.commands[2]?.redirects.map((r) => [r.op, r.target.text])).toEqual([['>', 'b.txt']]);
    const sub = parseBash('git commit -m "$(cat <<\'EOF\'\nfeat: x (con paréntesis)\nEOF\n)" && echo $(date)');
    expect(sub.problems).toEqual([]);
    expect(sub.commands.map((c) => c.words.map((w) => w.text))).toEqual([['cat'], ['git', 'commit', '-m', '$(…)'], ['date'], ['echo', '$(…)']]);
    expect(sub.commands[1]?.words[3]?.dynamic).toBe(true);
    expect(parseBash('echo $(id').problems).toEqual(['sustitución de comandos $( ) sin cerrar']);
    expect(parseBash('cat <<EOF\n$(id)\nEOF').problems).toEqual(['sustitución de comandos dentro de un heredoc']);
    expect(parseBash("echo 'abierta").problems).toEqual(['comilla simple sin cerrar']);
    expect(parseBash('gi? push').commands[0]?.words[0]?.glob).toBe(true);
  });

  it('PowerShell: backtick como escape, comillas dobladas y bloques', () => {
    const p = parsePowerShell("& 'git' `pu`sh; 1..3 | ForEach-Object { git status } # comentario");
    expect(p.commands.map((c) => c.words.map((w) => w.text))).toEqual([['git', 'push'], ['1..3'], ['ForEach-Object'], ['git', 'status']]);
    expect(parsePowerShell("'it''s'").commands[0]?.words[0]?.text).toBe("it's");
    const ps = parsePowerShell('Write-Output "hoy: $(Get-Date)"; $(git status)');
    expect(ps.problems).toEqual([]);
    expect(ps.commands.map((c) => c.words.map((w) => w.text))).toEqual([['Get-Date'], ['Write-Output', 'hoy: $(…)'], ['git', 'status']]);
  });

  it('normaliza nombres de comandos', () => {
    expect(commandName('C:\\Program Files\\Git\\cmd\\GIT.EXE')).toBe('git');
    expect(commandName('/usr/bin/git')).toBe('git');
    expect(commandName('Set-Content')).toBe('set-content');
  });
});

describe('errores y avisos', () => {
  it('clasifica texto de error', () => {
    expect(codeFromText('Invalid API key · Please run /login')).toBe('auth');
    expect(codeFromText('Credit balance is too low')).toBe('quota_exhausted');
    expect(codeFromText('API Error: 429 Too Many Requests')).toBe('quota_exhausted');
    expect(codeFromText('ECONNRESET')).toBeUndefined();
    expect(classifyClaudeError({ httpStatus: 500, texts: ['Internal'] }, 'crash')).toBe('crash');
    expect(classifyClaudeError({ assistantError: 'authentication_failed' })).toBe('auth');
  });

  it('avisa solo para http://', () => {
    expect(insecureUrlWarning('http://203.0.113.7')).toMatch(/conexión sin cifrar/);
    expect(insecureUrlWarning('https://api.anthropic.com')).toBeUndefined();
    expect(insecureUrlWarning(undefined)).toBeUndefined();
  });
});

describe('estimación de costo', () => {
  it('usa los precios públicos por modelo, con caché', () => {
    expect(estimateCostUsd('claude-opus-5-5', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 })).toBeCloseTo(4 + 20 + 0.2 + 5, 9);
    expect(priceOf('anthropic.claude-sonnet-5-5')).toMatchObject({ input: 2, output: 10 });
    expect(priceOf('claude-opus-5-5[1m]')).toMatchObject({ input: 4 });
    expect(priceOf('modelo-raro')).toBe(FALLBACK_PRICE);
    expect(priceOf(undefined)).toBe(FALLBACK_PRICE);
  });
});
