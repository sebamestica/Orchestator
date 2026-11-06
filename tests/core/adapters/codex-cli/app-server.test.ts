import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }));
import { readCodexAppServer } from '../../../../src/core/adapters/codex-cli/app-server.ts';

function server() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    pid: undefined as number | undefined, exitCode: null as number | null, signalCode: null as string | null });
  mocks.spawn.mockReturnValue(child);
  const requests: unknown[] = [];
  child.stdin.on('data', (data: Buffer) => { requests.push(JSON.parse(data.toString()) as unknown); });
  return { child, requests, reply: (value: unknown) => child.stdout.write(`${JSON.stringify(value)}\n`) };
}
const realPlatform = process.platform;
function asWindows() { Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }); }
/** Hijo de Windows con PID: el lanzador npm deja un `codex.exe` nieto que solo `taskkill /T` alcanza. */
function windowsServer() {
  asWindows();
  const fixture = server();
  fixture.child.pid = 1234;
  const killer = Object.assign(new EventEmitter(), { unref: vi.fn() });
  mocks.spawn.mockReturnValueOnce(fixture.child).mockReturnValueOnce(killer);
  return { ...fixture, killer };
}
afterEach(() => {
  vi.useRealTimers(); vi.clearAllMocks(); mocks.spawn.mockReset();
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

describe('app-server Codex stdio', () => {
  it('espera initialize, notifica initialized y consulta cupo con stdin abierto', async () => {
    const { child, requests, reply } = server();
    const promise = readCodexAppServer({ command: 'node', args: ['codex.js'] });
    expect(requests).toEqual([{ method: 'initialize', id: 0, params: { clientInfo: { name: 'orquestador', title: 'Orquestador local', version: '0.1.0' } } }]);
    reply({ method: 'notification', params: {} });
    expect(requests).toHaveLength(1);
    reply({ id: 0, result: { userAgent: 'codex' } });
    expect(requests.slice(1)).toEqual([{ method: 'initialized', params: {} }, { method: 'account/rateLimits/read', id: 1 }]);
    expect(child.stdin.writableEnded).toBe(false);
    reply({ id: 1, result: { rateLimits: null } });
    await expect(promise).resolves.toEqual({ rateLimits: null });
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(mocks.spawn).toHaveBeenCalledWith('node', ['codex.js', 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: expect.any(Object) });
    // El app-server de Codex no hereda credenciales de otros proveedores (revisión cruzada).
    const env = (mocks.spawn.mock.calls[0]?.[2] as { env: Record<string, string> }).env;
    expect(Object.keys(env).some((k) => k.toUpperCase() === 'ANTHROPIC_API_KEY')).toBe(false);
  });
  it('rechaza errores RPC y limpia el proceso', async () => {
    const { child, reply } = server();
    const promise = readCodexAppServer();
    reply({ id: 0, error: { code: -32000, message: 'Sin sesión' } });
    await expect(promise).rejects.toThrow('rechazó');
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it('rechaza JSON inválido', async () => {
    const { child } = server();
    const promise = readCodexAppServer();
    child.stdout.write('no-json\n');
    await expect(promise).rejects.toThrow('JSON inválido');
  });
  it('maneja error de spawn y cierre temprano', async () => {
    let fixture = server();
    let promise = readCodexAppServer();
    fixture.child.emit('error', new Error('EPERM'));
    await expect(promise).rejects.toThrow('iniciar');
    fixture = server();
    promise = readCodexAppServer();
    fixture.child.emit('close', 1);
    await expect(promise).rejects.toThrow('sin respuesta');
  });
  it('corta por timeout y libera el hijo', async () => {
    vi.useFakeTimers();
    const { child } = server();
    const promise = readCodexAppServer(undefined, 50);
    const check = expect(promise).rejects.toThrow('Timeout');
    await vi.advanceTimersByTimeAsync(50);
    await check;
    expect(child.kill).toHaveBeenCalledOnce();
  });
});

describe('app-server Codex en Windows: el cierre del árbol no bloquea el núcleo', () => {
  function answer(reply: (value: unknown) => void) {
    reply({ id: 0, result: { userAgent: 'codex' } });
    reply({ id: 1, result: { rateLimits: null } });
  }
  it('resuelve sin spawnSync y mata con taskkill asíncrono antes de child.kill', async () => {
    const { child, reply, killer } = windowsServer();
    const promise = readCodexAppServer({ command: 'node', args: ['codex.js'] });
    answer(reply);
    await expect(promise).resolves.toEqual({ rateLimits: null });
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    const [cmd, args] = mocks.spawn.mock.calls[1] as [string, string[]];
    expect(cmd.toLowerCase().endsWith('taskkill.exe')).toBe(true);
    expect(args).toEqual(['/pid', '1234', '/T', '/F']);
    // Si el lanzador muere antes de que taskkill recorra el árbol, el codex.exe nativo queda huérfano.
    expect(child.kill).not.toHaveBeenCalled();
    killer.emit('exit', 0);
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it('no lanza taskkill si el hijo ya terminó (camino close)', async () => {
    const { child } = windowsServer();
    const promise = readCodexAppServer();
    child.exitCode = 1;
    child.emit('close', 1);
    await expect(promise).rejects.toThrow('sin respuesta');
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(child.kill).not.toHaveBeenCalled();
  });
  it('si taskkill no arranca, no hay excepción y child.kill sirve de respaldo', async () => {
    const { child, reply, killer } = windowsServer();
    const promise = readCodexAppServer();
    answer(reply);
    await expect(promise).resolves.toEqual({ rateLimits: null });
    expect(() => killer.emit('error', new Error('ENOENT'))).not.toThrow();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });
});
