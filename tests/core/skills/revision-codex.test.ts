/**
 * Reproducciones de los 4 hallazgos de la revisión de Codex (2026-11-01-c8-skills-codex.md).
 * Cada prueba fallaba con el código anterior y pasa con la corrección.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillHub, SkillHubError } from '../../../src/core/skills/hub.ts';
import { skillsLockSchema } from '../../../src/core/skills/schemas.ts';
import { Tar, type ToolRunner } from '../../../src/core/skills/tar.ts';
import { copyTree, walkTree } from '../../../src/core/skills/tree.ts';
import { cleanup, copyFixture, expectedTreeHash, FIXTURES, recordingTar, tempDir, writeZip, type SpawnRecord, type ZipItem } from './helpers.ts';

let dir: string;
let hubDir: string;
let spawns: SpawnRecord[];
let hub: SkillHub;

beforeEach(async () => {
  dir = await tempDir('revision');
  hubDir = path.join(dir, 'agent-hub');
  const rec = recordingTar();
  spawns = rec.spawns;
  hub = new SkillHub({ hubDir, projectDir: path.join(dir, 'proyecto'), tar: rec.tar });
});
afterEach(async () => { await cleanup(dir); });

async function rejection(p: Promise<unknown>): Promise<SkillHubError> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(SkillHubError);
  return err as SkillHubError;
}

const SKILL = '---\nname: bomba\ndescription: Skill de prueba con muchas carpetas.\n---\n';

describe('hallazgo 1 (alta): junction en la raíz de la cuarentena', () => {
  it('approve rechaza una cuarentena sustituida por una junction NTFS y no instala nada', async () => {
    const review = await hub.importSkill(path.join(FIXTURES, 'navegador-chrome'));
    // Mismos archivos (mismo hash), pero fuera de la cuarentena y enlazados con una junction real.
    const externa = path.join(dir, 'externa');
    await rename(review.path, externa);
    await symlink(externa, review.path, 'junction');
    expect((await lstat(review.path)).isSymbolicLink()).toBe(true);

    const err = await rejection(hub.approve(review.id));
    expect(err.code).toBe('TAMPERED');
    const instalada = path.join(hubDir, 'skills', 'navegador-chrome');
    expect(await lstat(instalada).then(() => 'existe', () => 'no existe')).toBe('no existe');
    expect(await readFile(path.join(hubDir, 'skills.lock.json'), 'utf8').catch(() => 'sin lock')).toBe('sin lock');
  });

  it('walkTree rechaza una raíz que es junction salvo que se pida seguirla', async () => {
    const real = await copyFixture('navegador-chrome', path.join(dir, 'real'));
    const enlace = path.join(dir, 'enlace');
    await symlink(real, enlace, 'junction');
    const limits = { maxFiles: 10, maxTotalBytes: 1e6, maxFileBytes: 1e6, maxEntries: 10, maxDepth: 4 };
    const walk = await walkTree(enlace, limits);
    expect(walk.problems).toEqual(['(raíz): es un enlace simbólico o junction']);
    expect(walk.files).toEqual([]);
    expect((await walkTree(enlace, limits, { followRoot: true })).files.map((f) => f.path)).toEqual(['SKILL.md']);
  });
});

describe('hallazgo 2 (alta): cambios entre la comprobación y el uso', () => {
  it('un cambio en la cuarentena después del hash no llega a instalarse (lo instalado = lo registrado)', async () => {
    let enAprobacion: (() => void) | undefined;
    const reloj = new SkillHub({
      hubDir,
      projectDir: path.join(dir, 'proyecto'),
      // El reloj se consulta en mitad de approve: aquí simula a otro proceso que escribe en la cuarentena.
      now: () => {
        const hook = enAprobacion;
        enAprobacion = undefined;
        hook?.(); // síncrono: el cambio ocurre exactamente en este punto de approve
        return new Date();
      },
    });
    await reloj.approve((await reloj.importSkill(path.join(FIXTURES, 'con-scripts'))).id);
    const segunda = await reloj.importSkill(path.join(FIXTURES, 'con-scripts'));
    const script = path.join(segunda.path, 'scripts', 'instalar.sh');
    enAprobacion = () => { writeFileSync(script, '#!/bin/sh\necho inyectado\n'); };
    const resultado = await reloj.approve(segunda.id, { replace: true }).then((e) => e, (e: unknown) => e);

    // El reloj se consulta después del hash final (nombre de la copia de respaldo): se instala la
    // copia privada ya hasheada, así que el cambio en la cuarentena no llega a la skill instalada.
    expect(resultado).not.toBeInstanceOf(Error);
    expect(enAprobacion).toBeUndefined(); // el cambio sí se hizo
    const instalada = path.join(hubDir, 'skills', 'con-scripts');
    const lock = skillsLockSchema.parse(JSON.parse(await readFile(path.join(hubDir, 'skills.lock.json'), 'utf8')));
    expect(await expectedTreeHash(instalada)).toBe(lock.skills['con-scripts']?.treeHash);
    expect(await readFile(path.join(instalada, 'scripts', 'instalar.sh'), 'utf8')).not.toMatch(/inyectado/);
    expect((await readdir(path.join(hubDir, 'skills'))).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('copyTree no sigue una junction que sustituye a una subcarpeta después del recorrido', async () => {
    const src = await copyFixture('con-scripts', path.join(dir, 'origen'));
    const limits = { maxFiles: 100, maxTotalBytes: 1e6, maxFileBytes: 1e6, maxEntries: 100, maxDepth: 8 };
    const walk = await walkTree(src, limits);
    // Después del recorrido, `referencias/` pasa a ser una junction a una carpeta con otro contenido.
    const secreta = path.join(dir, 'secreta');
    await mkdir(secreta);
    await writeFile(path.join(secreta, 'guía ñandú.md'), 'contenido ajeno');
    await rename(path.join(src, 'referencias'), path.join(dir, 'referencias-original'));
    await symlink(secreta, path.join(src, 'referencias'), 'junction');

    const dest = path.join(dir, 'copia');
    await expect(copyTree(src, dest, walk)).rejects.toThrow(/enlace|fuera/);
    const copiado = await readFile(path.join(dest, 'referencias', 'guía ñandú.md'), 'utf8').catch(() => 'no copiado');
    expect(copiado).not.toBe('contenido ajeno');
  });
});

describe('hallazgo 3 (media): bomba de carpetas y profundidad', () => {
  it('un zip con miles de carpetas vacías se rechaza antes de extraer', async () => {
    const items: ZipItem[] = [['bomba/SKILL.md', SKILL]];
    for (let i = 0; i < 300; i++) items.push([`bomba/d${i}/`, '', 0o040755]);
    const zip = await writeZip(path.join(dir, 'in', 'bomba.zip'), items);
    const limited = new SkillHub({ hubDir, tar: recordingTar().tar, limits: { maxFiles: 50, maxEntries: 100 } });
    const err = await rejection(limited.importSkill(zip));
    expect(err.code).toBe('UNSAFE_ENTRY');
    expect(err.details.some((d) => /entradas/.test(d))).toBe(true);
  });

  it('el listado se corta en cuanto supera el máximo de entradas (no lo acumula entero)', async () => {
    let produced = 0;
    // tar falso que no acabaría nunca: solo se detiene si se le aborta.
    const run: ToolRunner = async function* (_command, args, opts) {
      const verbose = args[0] === '-tvf';
      while (!opts.signal?.aborted && produced < 1_000_000) {
        produced++;
        yield { kind: 'out', line: verbose ? `drwxr-xr-x  0 0 0 0 nov. 01 22:00 s/d${produced}/` : `s/d${produced}/` };
        if (produced % 50 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      yield { kind: 'exit', code: null, timedOut: false, aborted: true };
    };
    const tar = new Tar({ run, tarPath: 'C:\\falso\\tar.exe' });
    const listing = await tar.list('x.zip', dir, { maxFiles: 10, maxTotalBytes: 1e6, maxFileBytes: 1e6, maxEntries: 100, maxDepth: 8 });
    expect(listing.problems).toContain('más de 100 entradas en el zip (máximo 100): listado interrumpido');
    expect(produced).toBeLessThan(1000);
    expect(listing.entries.length).toBeLessThanOrEqual(101);
  });

  it('un zip demasiado profundo se rechaza antes de extraer', async () => {
    const deep = `bomba/${Array.from({ length: 30 }, (_, i) => `n${i}`).join('/')}/x.txt`;
    const zip = await writeZip(path.join(dir, 'in', 'hondo.zip'), [['bomba/SKILL.md', SKILL], [deep, 'x']]);
    const err = await rejection(hub.importSkill(zip));
    expect(err.code).toBe('UNSAFE_ENTRY');
    expect(err.details.some((d) => /profundidad/.test(d))).toBe(true);
    expect(spawns.some((s) => s.args[0] === '-x')).toBe(false);
  });

  it('una carpeta con demasiadas subcarpetas vacías se rechaza al recorrerla', async () => {
    const src = path.join(dir, 'in', 'bomba');
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, 'SKILL.md'), SKILL);
    for (let i = 0; i < 150; i++) await mkdir(path.join(src, `d${i}`));
    const limited = new SkillHub({ hubDir, limits: { maxFiles: 50, maxEntries: 100 } });
    expect((await rejection(limited.importSkill(src))).code).toBe('LIMIT');
  });
});

describe('hallazgo 4 (media): candado del lock entre procesos', () => {
  it('dos procesos que aprueban a la vez no pierden registros de skills.lock.json', async () => {
    const porProceso = 3;
    const ids: string[] = [];
    for (let i = 0; i < porProceso * 2; i++) {
      // Skills con bastantes archivos para que las aprobaciones se solapen de verdad.
      const src = path.join(dir, 'in', `s${i}`);
      await mkdir(path.join(src, 'refs'), { recursive: true });
      await writeFile(path.join(src, 'SKILL.md'), `---\nname: s${i}\ndescription: Skill ${i} de la prueba de dos procesos.\n---\n`);
      for (let f = 0; f < 60; f++) await writeFile(path.join(src, 'refs', `r${f}.md`), `ref ${i}.${f}\n`);
      ids.push((await hub.importSkill(src)).id);
    }
    const go = path.join(dir, 'go');
    const script = path.resolve(import.meta.dirname, 'aprobar-proceso.ts');
    const children = [ids.slice(0, porProceso), ids.slice(porProceso)].map((mine) => {
      const child = spawn(process.execPath, [script, hubDir, go, ...mine], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      const ready = new Promise<void>((resolve) => { const t = setInterval(() => { if (out.includes('listo')) { clearInterval(t); resolve(); } }, 5); });
      const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) => child.on('close', (code) => resolve({ code, out, err })));
      return { ready, done };
    });
    await Promise.all(children.map((c) => c.ready));
    await writeFile(go, 'ya');
    const results = await Promise.all(children.map((c) => c.done));
    for (const r of results) expect(r, r.err).toMatchObject({ code: 0, out: 'listo\nhecho\n' });

    const lock = skillsLockSchema.parse(JSON.parse(await readFile(path.join(hubDir, 'skills.lock.json'), 'utf8')));
    expect(Object.keys(lock.skills).sort()).toEqual(['s0', 's1', 's2', 's3', 's4', 's5']);
    expect(await lstat(path.join(hubDir, 'skills.lock.json.candado')).then(() => 'queda', () => 'liberado')).toBe('liberado');
  }, 60_000);
});
