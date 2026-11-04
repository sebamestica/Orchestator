import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { runTool, Tar, type ToolRunner } from '../../../src/core/skills/tar.ts';

export const FIXTURES = path.resolve(import.meta.dirname, '../../../fixtures/skills');

export async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `orq-skills-${prefix}-`));
}

export async function copyFixture(name: string, dest: string): Promise<string> {
  const target = path.join(dest, name);
  await cp(path.join(FIXTURES, name), target, { recursive: true });
  return target;
}

export type ZipItem = [name: string, data: string | Buffer, mode?: number];

/**
 * Zip mínimo sin compresión (port de `mkzip.mjs`/`mkzip2.mjs` de c4): permite fabricar entradas que
 * ninguna herramienta normal crearía (`../x`, `C:/x`, enlaces con modo Unix 0o120777, nombres raros).
 */
export function buildZip(items: readonly ZipItem[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data, mode] of items) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.from(data);
    const crc = crc32(body);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // nombres en UTF-8
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(body.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(mode ? (3 << 8) | 20 : 20, 4); // 3 = Unix: los 16 bits altos son el modo
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(body.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    if (mode) ch.writeUInt32LE((mode << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export async function writeZip(file: string, items: readonly ZipItem[]): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buildZip(items));
  return file;
}

/** Archivos de una carpeta como entradas de zip bajo `prefix/` (recursivo, rutas con `/`). */
export async function zipItemsFrom(dir: string, prefix: string): Promise<ZipItem[]> {
  const out: ZipItem[] = [];
  for (const rel of await listFiles(dir)) out.push([`${prefix}/${rel}`, await readFile(path.join(dir, rel))]);
  return out;
}

export async function listFiles(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)));
    else out.push(r);
  }
  return out.sort();
}

/** Busca archivos con ese nombre en todo el árbol (para detectar marcas de scripts trampa). */
export async function findByName(dir: string, name: string): Promise<string[]> {
  const hits: string[] = [];
  for (const rel of await listFiles(dir).catch(() => [])) if (path.posix.basename(rel) === name) hits.push(rel);
  return hits;
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Hash del árbol calculado aparte (mismo formato que sha256sum) para contrastar con el del hub. */
export async function expectedTreeHash(dir: string): Promise<string> {
  const lines = [];
  for (const rel of await listFiles(dir)) lines.push(`${sha256(await readFile(path.join(dir, rel)))}  ${rel}\n`);
  return `sha256:${sha256(lines.join(''))}`;
}

export interface SpawnRecord { command: string; args: readonly string[] }

/** `tar` real, registrando cada proceso lanzado: las pruebas comprueban que nunca se lanza otra cosa. */
export function recordingTar(): { tar: Tar; spawns: SpawnRecord[] } {
  const spawns: SpawnRecord[] = [];
  const run: ToolRunner = (command, args, opts) => {
    spawns.push({ command, args });
    return runTool(command, args, opts);
  };
  return { tar: new Tar({ run }), spawns };
}

export async function cleanup(...dirs: string[]): Promise<void> {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
}
