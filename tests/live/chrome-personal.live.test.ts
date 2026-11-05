/**
 * Issue 11 — los agentes usan solo tu Chrome personal. Pruebas contra las CLIs y el Chrome reales.
 *
 * - `ORQ_LIVE=1`: sin cupo y sin tocar Chrome. Codex (`debug prompt-input`, `mcp get`) y agy (`-p "/permissions"`)
 *   no llaman al modelo. Comprueba que los argumentos de Berland apagan sus navegadores propios.
 * - `ORQ_LIVE_CHROME=1` además: toca tu Chrome (`list_pages`; Chrome puede pedir aceptar la conexión). Necesita la
 *   depuración remota activa en chrome://inspect/#remote-debugging.
 * - `ORQ_LIVE_CUPO=1` además: una ejecución corta de Codex (gasta cupo) que abre example.com en tu Chrome.
 *
 * Desde WSL:
 *   scripts/win.sh "set ORQ_LIVE=1&& npx vitest run tests/live/chrome-personal.live.test.ts"
 *   scripts/win.sh "set ORQ_LIVE=1&& set ORQ_LIVE_CHROME=1&& npx vitest run tests/live/chrome-personal.live.test.ts"
 *   scripts/win.sh "set ORQ_LIVE=1&& set ORQ_LIVE_CHROME=1&& set ORQ_LIVE_CUPO=1&& npx vitest run tests/live/chrome-personal.live.test.ts"
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agyBrowserOffArgs, AGY_BROWSER_DENY } from '../../src/core/adapters/agy-cli/index.ts';
import { resolveAgyExecutable } from '../../src/core/adapters/agy-cli/executable.ts';
import { codexBrowserOffArgs, codexPluginArgs } from '../../src/core/adapters/codex-cli/index.ts';
import { resolveCodexExecutable } from '../../src/core/adapters/codex-cli/executable.ts';
import { CHROME_LOCK, chromeGateArgs, chromeServerSpec, defaultChromeLauncher } from '../../src/core/plugins/chrome.ts';
import { probeStdioMcp } from '../../src/core/plugins/mcp-probe.ts';
import { runJsonl } from '../../src/core/process/run-jsonl.ts';

const run = promisify(execFile);
const LIVE = process.env.ORQ_LIVE === '1';
const CHROME = LIVE && process.env.ORQ_LIVE_CHROME === '1';
const CUPO = CHROME && process.env.ORQ_LIVE_CUPO === '1';

let dir = '';
beforeAll(async () => {
  if (LIVE) dir = await mkdtemp(join(tmpdir(), 'orq-chrome-live-'));
});
afterAll(async () => {
  // Windows puede tener la carpeta ocupada unos segundos tras cerrar las CLIs: no es un fallo de la prueba.
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => undefined);
});

const codex = (args: readonly string[]) => {
  const exe = resolveCodexExecutable();
  return run(exe.command, [...exe.args, ...args], { cwd: dir, maxBuffer: 64 << 20, windowsHide: true, timeout: 120_000 });
};

describe.skipIf(!LIVE)('Codex real: sus navegadores apagados por argumentos (sin cupo)', () => {
  it('el prompt ya no trae las skills de su navegador integrado ni de su Chrome', async () => {
    const { stdout } = await codex(['debug', 'prompt-input', ...codexBrowserOffArgs(), 'hola']);
    for (const marca of ['browser:control-in-app-browser', 'chrome:control-chrome', 'computer-use:computer-use', 'mcp__node_repl__js']) {
      expect(stdout, marca).not.toContain(marca);
    }
  }, 120_000);

  it('node_repl, chrome-agente y el chrome-personal global quedan apagados (existan o no)', async () => {
    for (const name of ['node_repl', 'chrome-personal', 'chrome-agente', 'chrome-devtools']) {
      const { stdout } = await codex([...codexBrowserOffArgs(), 'mcp', 'get', name]);
      expect(stdout, name).toContain(`${name} (disabled)`);
    }
  }, 120_000);

  it('el chrome-personal de Berland (la puerta) queda encendido y aprobado', async () => {
    const spec = chromeServerSpec(defaultChromeLauncher(), { agent: 'codex-live', task: 'prueba', locksRoot: join(dir, 'locks') });
    const { stdout } = await codex([...codexPluginArgs({ 'chrome-personal': spec }).args, 'mcp', 'get', 'chrome-personal']);
    expect(stdout).toContain('enabled: true');
    expect(stdout).toContain('default_tools_approval_mode: approve');
    expect(stdout).toContain('chrome-gate.ts');
  }, 120_000);
});

describe.skipIf(!LIVE)('agy real: su navegador propio bloqueado por argumentos (sin cupo)', () => {
  it('`-p "/permissions"` lista las reglas deny de la sesión', async () => {
    const exe = resolveAgyExecutable();
    // Sin `--disable-slash-commands`: con él, «/permissions» no se responde en local y va al modelo (gasta cupo).
    const settings = agyBrowserOffArgs().filter((a) => a !== '--disable-slash-commands');
    expect(agyBrowserOffArgs()).toContain('--disable-slash-commands');
    const { stdout } = await run(exe.command, [...exe.args, ...settings, '-p', '/permissions'], { cwd: dir, maxBuffer: 16 << 20, windowsHide: true, timeout: 60_000 });
    const lines = stdout.split(/\r?\n/);
    for (const rule of AGY_BROWSER_DENY) expect(lines.some((l) => l.endsWith(`\tdeny\t${rule}`)), rule).toBe(true);
  }, 90_000);
});

describe.skipIf(!CHROME)('Puerta real contra tu Chrome personal (toca Chrome)', () => {
  it('list_pages pasa por la puerta, con candado propio que se suelta al terminar', async () => {
    const locksRoot = join(dir, 'locks');
    const args = chromeGateArgs(defaultChromeLauncher(), { agent: 'codex-live', task: 'prueba', locksRoot });
    const result = await probeStdioMcp({ command: process.execPath, args, startTimeoutMs: 60_000, call: { name: 'list_pages', timeoutMs: 90_000 }, closeGraceMs: 5000 });
    expect(result, JSON.stringify(result).slice(0, 500)).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 2000));
    expect(await stat(join(locksRoot, CHROME_LOCK)).then(() => true, () => false)).toBe(false);
  }, 180_000);
});

describe.skipIf(!CUPO)('Codex real abre una página en tu Chrome personal (gasta cupo)', () => {
  it('usa chrome-personal (la puerta), no su navegador integrado', async () => {
    const spec = chromeServerSpec(defaultChromeLauncher(), { agent: 'codex-live', task: 'prueba-cupo', locksRoot: join(dir, 'locks') });
    const exe = resolveCodexExecutable();
    const prompt = 'Con el servidor MCP chrome-personal: abre https://example.com en una pestaña nueva (new_page), dime el título exacto de la página y cierra esa pestaña (close_page). No uses otro navegador.';
    const lines: string[] = [];
    let tool = false;
    for await (const line of runJsonl({
      command: exe.command,
      args: [...exe.args, 'exec', '--json', ...codexPluginArgs({ 'chrome-personal': spec }).args, '-s', 'read-only', '--skip-git-repo-check', '-C', dir, prompt],
      cwd: dir,
      timeoutMs: 240_000,
    })) {
      if (line.kind === 'exit') break;
      lines.push(line.line);
      if (line.kind === 'json' && /"mcp_tool_call"/.test(line.line) && /"server":"chrome-personal"/.test(line.line) && /"status":"completed"/.test(line.line)) tool = true;
    }
    const all = lines.join('\n');
    expect(all).not.toContain('requires approval');
    expect(tool, all.slice(-2000)).toBe(true);
    expect(all).toContain('Example Domain');
  }, 300_000);
});
