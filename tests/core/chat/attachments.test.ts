import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStore, isTextual, normalizeMime, sanitizeFileName, sniffImage } from '../../../src/core/chat/index.ts';
import { SqliteStore } from '../../../src/core/store/index.ts';
import { GIF, JPEG, PNG, WEBP } from './helpers.ts';

let dir: string;
let store: SqliteStore;
let attachments: AttachmentStore;
const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orq-adjuntos-'));
  store = new SqliteStore({ path: ':memory:' });
  attachments = new AttachmentStore({ db: store.database, dir: join(dir, 'attachments'), maxBytes: 1024, now: () => new Date('2026-11-04T12:00:00.000Z') });
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe('tipo de adjunto', () => {
  it('image solo por la firma de png, jpeg, gif y webp', () => {
    expect([PNG, JPEG, GIF, WEBP].map(sniffImage)).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    expect(sniffImage(enc('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
    expect(sniffImage(new Uint8Array())).toBeUndefined();
  });

  it('text por tipo MIME o extensión de código; mime normalizado', () => {
    expect(isTextual('text/plain', 'a.bin')).toBe(true);
    expect(isTextual('application/json', 'x')).toBe(true);
    expect(isTextual('application/vnd.api+json', 'x')).toBe(true);
    expect(isTextual('application/octet-stream', 'main.ts')).toBe(true);
    expect(isTextual('application/octet-stream', 'Dockerfile')).toBe(true);
    expect(isTextual('application/pdf', 'informe.pdf')).toBe(false);
    expect(normalizeMime('Text/Plain; charset=utf-8')).toBe('text/plain');
    expect(normalizeMime('nada')).toBe('application/octet-stream');
    expect(normalizeMime(undefined)).toBe('application/octet-stream');
  });

  it('nombres seguros en Windows', () => {
    expect(sanitizeFileName('..\\..\\malo<>:"|?*.txt')).toBe('malo_______.txt');
    expect(sanitizeFileName('/etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('CON.txt')).toBe('_CON.txt');
    expect(sanitizeFileName('  ...  ')).toBe('archivo');
    expect(sanitizeFileName('a\u0000b\u001fc.md')).toBe('a_b_c.md');
    expect(sanitizeFileName(`${'x'.repeat(300)}.png`)).toMatch(/^x{116}\.png$/);
    expect(sanitizeFileName(`clave sk-ant-api03-${'Z'.repeat(40)}.txt`)).not.toMatch(/ZZZZ/);
  });
});

describe('AttachmentStore: subida', () => {
  it('guarda <dir>/<id>-<nombre saneado> con su tipo y tamaño', async () => {
    const a = await attachments.upload({ name: 'captura de pantalla.png', mime: 'image/png', bytes: PNG });
    expect(a).toMatchObject({ name: 'captura de pantalla.png', mime: 'image/png', size: PNG.byteLength, kind: 'image', source: 'upload', createdAt: '2026-11-04T12:00:00.000Z' });
    expect(a.path).toBe(join(dir, 'attachments', `${a.id}-captura de pantalla.png`));
    expect(new Uint8Array(await readFile(a.path))).toEqual(PNG);
    expect(attachments.get(a.id)).toEqual(a);
    expect((await attachments.read(a.id)).bytes).toEqual(PNG);
  });

  it('el tipo declarado no basta para ser imagen; texto y archivos', async () => {
    const fake = await attachments.upload({ name: 'falsa.png', mime: 'image/png', bytes: enc('<html>hola</html>') });
    expect(fake).toMatchObject({ kind: 'file', mime: 'application/octet-stream' });
    const realGif = await attachments.upload({ name: 'sin-tipo', bytes: GIF });
    expect(realGif).toMatchObject({ kind: 'image', mime: 'image/gif' });
    expect(await attachments.upload({ name: 'notas.md', mime: 'text/markdown', bytes: enc('# hola') })).toMatchObject({ kind: 'text', mime: 'text/markdown' });
    expect(await attachments.upload({ name: 'index.ts', mime: 'application/octet-stream', bytes: enc('export {}') })).toMatchObject({ kind: 'text' });
    expect(await attachments.upload({ name: 'informe.pdf', mime: 'application/pdf', bytes: enc('%PDF-1.7') })).toMatchObject({ kind: 'file', mime: 'application/pdf' });
  });

  it('límites: tope de tamaño y vacío', async () => {
    await expect(attachments.upload({ name: 'grande.bin', bytes: new Uint8Array(1025) })).rejects.toMatchObject({ code: 'too_large' });
    await expect(attachments.upload({ name: 'vacio.txt', bytes: new Uint8Array() })).rejects.toMatchObject({ code: 'invalid' });
    expect(await attachments.upload({ name: 'justo.bin', bytes: new Uint8Array(1024) })).toMatchObject({ size: 1024 });
  });

  it('remove borra el registro y la copia', async () => {
    const a = await attachments.upload({ name: 'a.txt', mime: 'text/plain', bytes: enc('a') });
    await attachments.remove(a.id);
    expect(attachments.get(a.id)).toBeUndefined();
    await expect(readFile(a.path)).rejects.toThrow();
  });
});

describe('AttachmentStore: por ruta', () => {
  it('registra un archivo local sin copiarlo', async () => {
    const file = join(dir, 'escritorio', 'foto.jpg');
    await mkdir(join(dir, 'escritorio'));
    await writeFile(file, JPEG);
    const a = await attachments.registerPath(file);
    expect(a).toMatchObject({ name: 'foto.jpg', mime: 'image/jpeg', kind: 'image', source: 'path', path: file, size: JPEG.byteLength });
    const pdf = join(dir, 'escritorio', 'informe.pdf');
    await writeFile(pdf, '%PDF-1.7');
    expect(await attachments.registerPath(pdf)).toMatchObject({ kind: 'file', mime: 'application/pdf' });
    const code = join(dir, 'escritorio', 'app.py');
    await writeFile(code, 'print(1)');
    expect(await attachments.registerPath(code)).toMatchObject({ kind: 'text', mime: 'text/plain' });
  });

  it('rechaza rutas relativas, inexistentes, carpetas y archivos de más de 20 MB (aquí el tope de prueba)', async () => {
    await expect(attachments.registerPath('relativa.txt')).rejects.toMatchObject({ code: 'invalid' });
    await expect(attachments.registerPath(join(dir, 'no-existe.txt'))).rejects.toMatchObject({ code: 'not_found' });
    await expect(attachments.registerPath(dir)).rejects.toMatchObject({ code: 'invalid' });
    const big = join(dir, 'grande.bin');
    await writeFile(big, new Uint8Array(1025));
    await expect(attachments.registerPath(big)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('al leer, vuelve a comprobar el archivo (pudo cambiar o desaparecer)', async () => {
    const file = join(dir, 'cambia.txt');
    await writeFile(file, 'corto');
    const a = await attachments.registerPath(file);
    await writeFile(file, new Uint8Array(2048));
    await expect(attachments.read(a.id)).rejects.toMatchObject({ code: 'too_large' });
    await rm(file);
    await expect(attachments.read(a.id)).rejects.toMatchObject({ code: 'not_found' });
    // Borrar un adjunto por ruta no toca el archivo original.
    await writeFile(file, 'otra vez');
    await attachments.remove(a.id);
    expect(await readFile(file, 'utf8')).toBe('otra vez');
  });
});
