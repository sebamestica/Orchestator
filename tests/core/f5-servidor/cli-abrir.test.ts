import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { openInBrowser, webUrl } from '../../../src/core/app/cli-commands.ts';
import { resolveUiDir, DEFAULT_UI_DIR } from '../../../src/core/app/f5-servidor.ts';

type SpawnArgs = { cmd: string; args: readonly string[]; opts: Record<string, unknown> };

function fakeSpawn(calls: SpawnArgs[]) {
  return ((cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;
    return child;
  }) as unknown as Parameters<typeof openInBrowser>[2];
}

describe('iniciar --abrir', () => {
  it('el enlace web lleva el token en el fragmento (#t=), que el navegador no envía al servidor', () => {
    expect(webUrl('http://127.0.0.1:47811', 'abc_DEF-123')).toBe('http://127.0.0.1:47811/#t=abc_DEF-123');
  });

  it('abre con rundll32 url.dll,FileProtocolHandler por spawn sin shell (la URL es un solo argumento)', () => {
    const calls: SpawnArgs[] = [];
    const url = webUrl('http://127.0.0.1:47811', 'x'.repeat(43));
    expect(openInBrowser(url, 'win32', fakeSpawn(calls))).toBe(true);
    expect(calls).toEqual([{ cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url], opts: expect.objectContaining({ shell: false, detached: true }) }]);
  });

  it('no abre nada fuera de Windows ni URLs que no sean las del núcleo (127.0.0.1, caracteres seguros)', () => {
    const calls: SpawnArgs[] = [];
    expect(openInBrowser('http://127.0.0.1:47811/#t=x', 'linux', fakeSpawn(calls))).toBe(false);
    expect(openInBrowser('https://evil.example/', 'win32', fakeSpawn(calls))).toBe(false);
    expect(openInBrowser('http://127.0.0.1:47811/" & calc', 'win32', fakeSpawn(calls))).toBe(false);
    expect(openInBrowser('http://localhost:47811/#t=x', 'win32', fakeSpawn(calls))).toBe(false);
    expect(calls).toEqual([]);
  });

  it('carpeta de la interfaz: ORQ_UI_DIR o dist/ui del repositorio', () => {
    expect(resolveUiDir({})).toBe(DEFAULT_UI_DIR);
    expect(DEFAULT_UI_DIR.replaceAll('\\', '/')).toMatch(/\/dist\/ui$/);
    expect(resolveUiDir({ ORQ_UI_DIR: '  ' })).toBe(DEFAULT_UI_DIR);
    const custom = resolveUiDir({ ORQ_UI_DIR: process.platform === 'win32' ? 'D:\\orq\\ui' : '/tmp/orq-ui' });
    expect(custom).toBe(process.platform === 'win32' ? 'D:\\orq\\ui' : '/tmp/orq-ui');
  });
});
