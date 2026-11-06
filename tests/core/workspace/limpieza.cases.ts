import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { disposeRepoTemplate, makeRepo, repoTemplatePath } from './helpers.ts';

// Va el último en `repos.test.ts`: borra la plantilla, y la siguiente prueba tendría que volver a crearla.
describe('limpieza de los repos temporales: no quedan restos en %TEMP%', () => {
  it('cleanup y disposeRepoTemplate borran la carpeta de la prueba y la plantilla', async () => {
    const t = makeRepo();
    const template = repoTemplatePath();
    expect(template && existsSync(template)).toBe(true);
    t.cleanup();
    await disposeRepoTemplate();
    expect(existsSync(t.base)).toBe(false);
    expect(existsSync(template ?? '')).toBe(false);
  });

  it.runIf(process.platform === 'win32')('una carpeta que Windows retiene al limpiar se borra al final', async () => {
    const t = makeRepo();
    // Un proceso con su cwd dentro durante 1,5 s: Windows no deja quitar la carpeta y rmSync no reintenta.
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { cwd: t.repo, stdio: 'ignore', windowsHide: true });
    await new Promise((r) => holder.once('spawn', r));
    t.cleanup();
    expect(existsSync(t.base)).toBe(true);
    await disposeRepoTemplate();
    expect(existsSync(t.base)).toBe(false);
  });
});
