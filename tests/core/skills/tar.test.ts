import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultTarPath, entryNameProblem, Tar } from '../../../src/core/skills/tar.ts';
import { cleanup, FIXTURES, tempDir, writeZip } from './helpers.ts';

const limits = { maxFiles: 100, maxTotalBytes: 1_000_000, maxFileBytes: 100_000, maxEntries: 200, maxDepth: 16 };

describe('entryNameProblem', () => {
  it.each([
    ['skill/SKILL.md'],
    ['skill/referencias/guía ñandú.md'],
    ['skill/d/'],
    ['./'],
    ['./skill/SKILL.md'],
    ['.agents/x.md'],
  ])('acepta %s', (name) => {
    expect(entryNameProblem(name)).toBeUndefined();
  });

  it.each([
    ['../evil.txt', /\.\./],
    ['s/../../evil.txt', /\.\./],
    ['/abs.txt', /absoluta/],
    ['C:/x.txt', /absoluta/],
    ['C:x.txt', /absoluta/],
    ['s/..\\evil2.txt', /«\\»/],
    ['s\\line\\nbreak', /«\\»/],
    ['s/a:b.txt', /no permitido/],
    ['s/CON', /reservado/],
    ['s/nul.txt', /reservado/],
    ['s/.. ', /punto o espacio/],
    ['s/...', /punto o espacio/],
    ['s/x?', /no permitido/],
  ])('rechaza %s', (name, re) => {
    expect(entryNameProblem(name)).toMatch(re);
  });
});

describe('Tar (tar.exe real)', () => {
  let dir: string;
  const tar = new Tar();
  beforeAll(async () => { dir = await tempDir('tar'); });
  afterAll(async () => { await cleanup(dir); });

  it('usa la ruta absoluta de System32 en Windows', () => {
    if (process.platform === 'win32') expect(defaultTarPath()).toMatch(/^[A-Za-z]:\\.*\\System32\\tar\.exe$/i);
    expect(path.isAbsolute(defaultTarPath())).toBe(true);
  });

  it('lista un zip sano sin problemas (ok.zip de c4)', async () => {
    const listing = await tar.list(path.join(FIXTURES, 'zips/ok.zip'), dir, limits);
    expect(listing.problems).toEqual([]);
    expect(listing.entries.map((e) => e.type)).toEqual(['-', '-']);
    expect(listing.entries[0]).toMatchObject({ name: 's/SKILL.md', size: 16 });
  });

  it('rechaza cada ruta maliciosa de mal.zip (c4)', async () => {
    const { problems } = await tar.list(path.join(FIXTURES, 'zips/mal.zip'), dir, limits);
    const bad = problems.map((p) => p.split(': ')[0]);
    expect(bad).toEqual(['../evil.txt', '/abs.txt', 's/..\\\\evil2.txt', 'C:/x.txt', 's/a:b.txt']);
  });

  it('detecta el enlace de lnk.zip (c4), invisible para tar -tf', async () => {
    const { problems, entries } = await tar.list(path.join(FIXTURES, 'zips/lnk.zip'), dir, limits);
    expect(entries.map((e) => e.name)).toContain('s/link');
    expect(problems).toEqual(['s/link: es un enlace']);
  });

  it('rechaza nombres con salto de línea, control o en blanco (bsdtar los escapa)', async () => {
    const zip = await writeZip(path.join(dir, 'raro.zip'), [['s/SKILL.md', 'x'], ['s/salto\nlinea.txt', 'a'], [' ', 'b'], ['s/ctl\u0001x', 'c']]);
    const { problems } = await tar.list(zip, dir, limits);
    expect(problems.some((p) => p.startsWith('listado inconsistente'))).toBe(true);
    expect(problems.some((p) => p.includes('salto\\nlinea.txt'))).toBe(true);
    expect(problems.some((p) => p.includes('ctl\\001x'))).toBe(true);
  });

  it('rechaza el truco «WorstFit»: tar.exe muestra ．．／ (ancho completo) como ../', async () => {
    const zip = await writeZip(path.join(dir, 'ancho.zip'), [['s/SKILL.md', 'x'], ['s/\uFF0E\uFF0E\uFF0Fevil.txt', 'c']]);
    const { problems } = await tar.list(zip, dir, limits);
    expect(problems).toEqual(['s/../evil.txt: segmento «..» no permitido: s/../evil.txt']);
  });

  it('aplica límites de archivos y bytes del listado', async () => {
    const zip = await writeZip(path.join(dir, 'grande.zip'), [['s/SKILL.md', 'x'], ['s/a.bin', Buffer.alloc(2000)]]);
    const { problems } = await tar.list(zip, dir, { ...limits, maxFiles: 1, maxTotalBytes: 1500, maxFileBytes: 1000 });
    expect(problems).toEqual([
      's/a.bin: 2000 bytes supera el máximo por archivo (1000)',
      '2 archivos supera el máximo (1)',
      '2001 bytes descomprimidos supera el máximo (1500)',
    ]);
  });
});
