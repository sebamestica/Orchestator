import { describe, expect, it } from 'vitest';
import { childEnv, isStrippedEnvName } from '../../src/core/process/child-env.ts';
import { runJsonl } from '../../src/core/process/run-jsonl.ts';

// Hallazgo de la revisión de Codex: Codex, agy y git heredaban la clave de Claude del proceso del núcleo.
describe('childEnv: los procesos hijos no heredan credenciales', () => {
  const base = {
    PATH: 'C:\\bin', APPDATA: 'C:\\x', anthropic_api_key: 'sk-ant-heredada-0000000000', ANTHROPIC_BASE_URL: 'http://srv',
    OPENAI_API_KEY: 'sk-heredada', GEMINI_API_KEY: 'g', CLAUDECODE: '1', ORQ_API_KEY: 'k', GITHUB_TOKEN: 'se-queda',
  };

  it('quita las credenciales de IA y las variables de una sesión de Claude Code, sin distinguir mayúsculas', () => {
    const env = childEnv({}, base);
    expect(env).toEqual({ PATH: 'C:\\bin', APPDATA: 'C:\\x', GITHUB_TOKEN: 'se-queda' });
    expect(isStrippedEnvName('Anthropic_Api_Key')).toBe(true);
  });

  it('deja pasar los secretos explícitos del propio agente', () => {
    expect(childEnv({ ANTHROPIC_API_KEY: 'propia' }, base).ANTHROPIC_API_KEY).toBe('propia');
  });

  it('runJsonl no pasa al hijo la clave del proceso padre', async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-padre-1234567890abcdef';
    try {
      const lines: string[] = [];
      for await (const line of runJsonl({
        command: process.execPath,
        args: ['-e', 'process.stdout.write(JSON.stringify({ k: process.env.ANTHROPIC_API_KEY ?? null, p: !!process.env.PATH }) + "\\n")'],
        cwd: process.cwd(),
        timeoutMs: 20_000,
      })) if (line.kind === 'json') lines.push(line.line);
      expect(lines).toEqual([JSON.stringify({ k: null, p: true })]);
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = before;
    }
  });
});
