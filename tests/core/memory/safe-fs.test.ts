import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertRealInside, resolveInside, safeSegments, UnsafePathError, writeFileAtomic } from '../../../src/core/memory/safe-fs.ts';

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'orq-safefs-'));
  outside = await mkdtemp(path.join(os.tmpdir(), 'orq-fuera-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('resolveInside', () => {
  it('acepta rutas relativas normales', () => {
    expect(resolveInside(root, 'Orquestador/Sesiones/2026-11-01-c4.md')).toBe(path.join(root, 'Orquestador', 'Sesiones', '2026-11-01-c4.md'));
    expect(safeSegments('./a//b/c.md')).toEqual(['a', 'b', 'c.md']);
  });

  it('rechaza .., rutas absolutas, unidades, UNC, flujos NTFS y nombres reservados', () => {
    const bad = [
      '../fuera.md', 'a/../../fuera.md', 'a\\..\\..\\fuera.md', '/etc/passwd', 'C:\\Windows\\x.md', 'C:x.md',
      '\\\\servidor\\recurso\\x.md', 'nota.md:flujo', 'CON', 'nul.md', 'com1.txt', 'termina-en-punto.', 'a\u0000b', '', '.',
    ];
    for (const rel of bad) expect(() => resolveInside(root, rel), JSON.stringify(rel)).toThrow(UnsafePathError);
  });
});

describe('writeFileAtomic', () => {
  it('escribe con temporal + rename, crea carpetas y no deja temporales', async () => {
    const target = path.join(root, 'a', 'b', 'nota.md');
    await writeFileAtomic(root, target, 'uno');
    await writeFileAtomic(root, target, 'dos');
    expect(await readFile(target, 'utf8')).toBe('dos');
    expect(await readdir(path.dirname(target))).toEqual(['nota.md']);
  });

  it('no escribe fuera de la raíz ni sobre la raíz', async () => {
    await expect(writeFileAtomic(root, path.join(root, '..', 'fuera.md'), 'x')).rejects.toThrow(UnsafePathError);
    await expect(writeFileAtomic(root, root, 'x')).rejects.toThrow(UnsafePathError);
  });

  it('no sigue un junction o enlace que apunta fuera de la raíz', async () => {
    const link = path.join(root, 'enlace');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(writeFileAtomic(root, path.join(link, 'robado.md'), 'x')).rejects.toThrow(UnsafePathError);
    await expect(assertRealInside(root, path.join(link, 'otro', 'x.md'))).rejects.toThrow(UnsafePathError);
    expect(existsSync(path.join(outside, 'robado.md'))).toBe(false);
  });

  it('acepta enlaces que se quedan dentro de la raíz', async () => {
    await mkdir(path.join(root, 'real'));
    await writeFile(path.join(root, 'real', 'x.md'), 'x');
    const link = path.join(root, 'alias');
    await symlink(path.join(root, 'real'), link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(assertRealInside(root, path.join(link, 'x.md'))).resolves.toBeUndefined();
  });
});
