import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_STDIN_BYTES, readLimited, type CliIo } from '../../src/core/app/cli-io.ts';
import { runCli, type MakeComposition } from '../../src/core/app/cli.ts';
import { compose, type Composition } from '../../src/core/app/compose.ts';
import { MemoryVault } from '../../src/core/vault/index.ts';
import { USER_BASE_URL, anthropicRoutes, cleanupDirs, fakeKey, leakyAdapter, mockFetch, planJson, tempDir } from './helpers.ts';

afterEach(cleanupDirs);

interface FakeIo extends CliIo {
  stdout: string[];
  stderr: string[];
}

function fakeIo(env: Record<string, string | undefined>, stdin = ''): FakeIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (l) => void stdout.push(l),
    err: (l) => void stderr.push(l),
    env,
    stdinIsTty: stdin === '',
    readStdin: async () => stdin,
    lines: async function* () {
      for (const l of stdin.split('\n')) yield l;
    },
    waitForStop: async () => undefined,
  };
}

/** Composición compartida entre órdenes (como la misma carpeta de datos), con red y adaptador falsos. */
async function sharedComposition(seen: { agentId: string; env: Readonly<Record<string, string>> }[] = []) {
  const dir = await tempDir();
  const vault = new MemoryVault();
  const net = mockFetch(anthropicRoutes(planJson('orquestador')));
  const opened: Composition[] = [];
  const make: MakeComposition = (io) => {
    const comp = compose({
      env: { ...io.env, ORQ_DATA_DIR: dir },
      config: { port: 0, quotaRefreshMs: 0 },
      vault,
      memoryDir: `${dir}/memoria`,
      skillsHubDir: `${dir}/hub`,
      detectors: [],
      anthropicFetch: net.fetch,
      claude: { sdkVersion: '0.3.302' },
      constructors: { claudeSdk: (o) => leakyAdapter(o.config, seen) },
    });
    opened.push(comp);
    return comp;
  };
  return { make, net, opened };
}

describe('cli', () => {
  it('agregar-claude toma la clave del entorno, avisa del http:// y nunca la imprime; agentes la omite', async () => {
    const key = fakeKey();
    const { make } = await sharedComposition();
    const io = fakeIo({ ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: USER_BASE_URL });
    expect(await runCli(['agregar-claude', '--presupuesto', '2'], io, make)).toBe(0);
    expect(io.stdout.join('\n')).toContain('Prueba: autenticado=true');
    expect(io.stderr.some((l) => l.includes('conexión sin cifrar'))).toBe(true);
    expect(io.stdout.join('\n')).toMatch(/Agente claude registrado: la clave quedó solo en la bóveda DPAPI/);

    const list = fakeIo({});
    expect(await runCli(['agentes'], list, make)).toBe(0);
    expect(list.stdout[0]).toMatch(/^claude {2}claude-sdk\/anthropic .* url=http:\/\/203\.0\.113\.7:18082 {2}clave=en la bóveda {2}presupuesto=2/);
    expect(JSON.stringify([io.stdout, io.stderr, list.stdout])).not.toContain(key);

    const again = fakeIo({ ANTHROPIC_API_KEY: key });
    expect(await runCli(['agregar-claude'], again, make)).toBe(2);
    expect(again.stderr.join('\n')).toContain('--reemplazar');
  });

  it('rechaza la clave como argumento y acepta --stdin', async () => {
    const key = fakeKey();
    const { make } = await sharedComposition();
    for (const argv of [['agregar-claude', `--api-key=${key}`], ['agregar-claude', key], ['agregar-claude', '--clave', 'x']]) {
      const io = fakeIo({});
      expect(await runCli(argv, io, make)).toBe(2);
      expect(io.stderr.join('\n')).toContain('nunca va como argumento');
      expect(io.stderr.join('\n')).not.toContain(key);
    }
    const io = fakeIo({}, `${key}\n`);
    expect(await runCli(['agregar-claude', '--stdin', '--url', 'https://api.anthropic.com'], io, make)).toBe(0);
    expect(io.stderr).toEqual([]);
  });

  it('probar-claude ejecuta con la clave de la bóveda aunque el entorno no tenga ninguna', async () => {
    const key = fakeKey();
    const seen: { agentId: string; env: Readonly<Record<string, string>> }[] = [];
    const { make } = await sharedComposition(seen);
    expect(await runCli(['agregar-claude', '--url', USER_BASE_URL], fakeIo({ ANTHROPIC_API_KEY: key }), make)).toBe(0);

    const io = fakeIo({});
    expect(await runCli(['probar-claude'], io, make)).toBe(0);
    expect(seen).toEqual([{ agentId: 'claude', env: { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: USER_BASE_URL } }]);
    const out = io.stdout.join('\n');
    expect(out).toContain('Credenciales en el entorno de este proceso: ninguna');
    expect(out).toContain('Respuesta: OK, mi clave es [REDACTADO]');
    expect(out).toMatch(/costo 0\.0010 USD/);
    expect(out).not.toContain(key);
  });

  it('stdin: tope de 16 KiB mientras se lee y plazo (hallazgo 4 de la revisión de Codex)', async () => {
    expect(await readLimited(Readable.from(['clave-corta\n']))).toBe('clave-corta\n');
    let produced = 0;
    const endless = Readable.from((function* () {
      for (;;) {
        produced++;
        yield Buffer.alloc(4096, 97);
      }
    })());
    await expect(readLimited(endless)).rejects.toThrow(/más de 16384 bytes/);
    expect(produced).toBeLessThan(40); // se corta: no lee el flujo entero
    await expect(readLimited(new PassThrough(), MAX_STDIN_BYTES, 50)).rejects.toThrow(/no terminó en 0 s/);
  });

  it('sin orden muestra la ayuda; una orden desconocida falla', async () => {
    const { make } = await sharedComposition();
    const help = fakeIo({});
    expect(await runCli([], help, make)).toBe(2);
    expect(help.stdout[0]).toMatch(/^Uso: node src\/core\/app\/cli\.ts/);
    expect(await runCli(['volar'], fakeIo({}), make)).toBe(2);
  });
});
