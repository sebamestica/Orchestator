/** Guardia del borrado del almacenamiento: nunca fuera de la raíz, nunca un camino protegido, nunca a través de un enlace. */
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInside, overlaps, removeTree, safetyProblem, treeSize } from '../../../src/core/storage-stats/index.ts';

let dir: string;
let root: string;
let project: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orq-almacen-fs-'));
  root = join(dir, 'berland-conversaciones');
  project = join(dir, 'proyecto');
  mkdirSync(join(root, 'chat-0001', 'sub'), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'main.ts'), 'export {};\n');
  writeFileSync(join(root, 'chat-0001', 'sub', 'a.txt'), 'x'.repeat(700));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const none = { protectedPaths: [], keepRoots: [] };

describe('isInside / overlaps', () => {
  it('compara rutas por componentes (no por prefijo de texto)', () => {
    expect(isInside(join(dir, 'a'), join(dir, 'a', 'b'))).toBe(true);
    expect(isInside(join(dir, 'a'), join(dir, 'a'))).toBe(false);
    expect(isInside(join(dir, 'a'), join(dir, 'ab'))).toBe(false);
    expect(overlaps(join(dir, 'a'), join(dir, 'a', 'b'))).toBe(true);
    expect(overlaps(join(dir, 'a', 'b'), join(dir, 'a'))).toBe(true);
    expect(overlaps(join(dir, 'a'), join(dir, 'b'))).toBe(false);
  });
});

describe('safetyProblem', () => {
  it('acepta una carpeta de conversación dentro de su raíz', async () => {
    expect(await safetyProblem(join(root, 'chat-0001'), root, none)).toBeUndefined();
  });

  it('rechaza la raíz misma, lo de fuera y las rutas con ..', async () => {
    expect(await safetyProblem(root, root, none)).toBe('está fuera de la carpeta de Berland');
    expect(await safetyProblem(project, root, none)).toBe('está fuera de la carpeta de Berland');
    expect(await safetyProblem(join(root, '..', 'proyecto'), root, none)).toBe('está fuera de la carpeta de Berland');
  });

  it('rechaza lo que es, contiene o está dentro de un camino protegido', async () => {
    const rules = { protectedPaths: [join(root, 'chat-0001', 'sub')], keepRoots: [] };
    expect(await safetyProblem(join(root, 'chat-0001'), root, rules)).toBe('toca un proyecto, la bóveda, la base o la memoria');
    expect(await safetyProblem(join(root, 'chat-0001', 'sub', 'a.txt'), root, rules)).toBe('toca un proyecto, la bóveda, la base o la memoria');
  });

  it('rechaza lo que contiene la carpeta de datos, pero acepta lo de dentro', async () => {
    const data = join(root, 'chat-0001');
    const rules = { protectedPaths: [], keepRoots: [data] };
    expect(await safetyProblem(data, root, rules)).toBe('contiene la carpeta de datos de Berland');
    expect(await safetyProblem(join(data, 'sub'), join(root, 'chat-0001'), rules)).toBeUndefined();
  });

  it('rechaza lo que solo parece estar dentro porque su carpeta es una junction hacia fuera', async () => {
    symlinkSync(project, join(root, 'puente'), 'junction');
    expect(await safetyProblem(join(root, 'puente', 'main.ts'), root, none)).toBe('su ruta real está fuera de la carpeta de Berland');
    // La junction en sí sí se puede quitar (como enlace).
    expect(await safetyProblem(join(root, 'puente'), root, none)).toBeUndefined();
  });

  it('rechaza lo que ya no existe', async () => {
    expect(await safetyProblem(join(root, 'nada', 'x'), root, none)).toBe('ya no existe');
  });
});

describe('removeTree y treeSize', () => {
  it('borra el árbol con archivos de solo lectura y quita las junctions sin entrar en ellas', async () => {
    const target = join(root, 'chat-0001');
    symlinkSync(project, join(target, 'enlace'), 'junction');
    const ro = join(target, 'solo-lectura.txt');
    writeFileSync(ro, 'y'.repeat(300));
    chmodSync(ro, 0o444);
    expect(await treeSize(target)).toEqual({ bytes: 1000, files: 2 });
    expect(await removeTree(target)).toEqual({ bytes: 1000, files: 2 });
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(project, 'main.ts'), 'utf8')).toBe('export {};\n');
  });

  it('el presupuesto corta el recorrido y lo marca', async () => {
    const budget = { left: 1, truncated: false };
    await treeSize(root, budget);
    expect(budget.truncated).toBe(true);
  });
});
