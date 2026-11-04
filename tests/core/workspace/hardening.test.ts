import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLinks,
  ensureHooksDir,
  projectsOverlapProblem,
  removeAllLinks,
  worktreesRootProblem,
  type LinkFs,
} from '../../../src/core/workspace/index.ts';

// Revisión de Codex sobre c13: raíz de worktrees (H2), enlaces (H3) y quitar enlaces antes de borrar (H6).

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
function temp(prefix = 'orq-dura-'): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
const win = process.platform === 'win32';
const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramData: 'C:\\ProgramData', USERPROFILE: 'C:\\Users\\yo' };

describe.runIf(win)('worktreesRoot (H2)', () => {
  const repoPath = 'C:\\dev\\Vetworld';
  const problem = (worktreesRoot: string) => worktreesRootProblem({ repoPath, worktreesRoot }, env);

  it('acepta una raíz propia y rechaza relativas, volúmenes, sistema, usuarios y solapes con la copia', () => {
    expect(problem('C:\\dev\\.worktrees\\vetworld-orq')).toBeUndefined();
    expect(problem('D:\\worktrees\\vetworld')).toBeUndefined();
    const cases: [string, RegExp][] = [
      ['worktrees\\vw', /ruta absoluta/],
      ['C:\\', /raíz de un volumen/],
      ['D:', /ruta absoluta|raíz de un volumen/],
      ['C:\\Windows\\Temp\\wt', /carpeta del sistema/],
      ['c:\\program files\\wt', /carpeta del sistema/],
      ['C:\\ProgramData\\wt', /carpeta del sistema/],
      ['C:\\Users', /carpeta de usuarios ni el perfil/],
      ['C:\\Users\\yo', /carpeta de usuarios ni el perfil/],
      ['C:\\dev\\Vetworld\\.wt', /dentro de la copia del usuario/],
      ['C:\\dev', /no puede contener la copia del usuario/],
    ];
    for (const [root, message] of cases) expect(problem(root), root).toMatch(message);
  });

  it('mira la ruta real: una raíz que pasa por una junction hacia la copia se rechaza', () => {
    const base = temp();
    const repo = join(base, 'repo');
    mkdirSync(repo);
    symlinkSync(repo, join(base, 'parece-fuera'), 'junction');
    const why = worktreesRootProblem({ repoPath: repo, worktreesRoot: join(base, 'parece-fuera', 'wt') }, env);
    expect(why).toMatch(/dentro de la copia del usuario/);
    expect(why).toContain('ruta real');
  });

  it('dos proyectos no comparten copia ni raíz, ni una cuelga de la otra (también por junction)', () => {
    const base = temp();
    mkdirSync(join(base, 'b'));
    const a = { id: 'a', repoPath: join(base, 'a'), worktreesRoot: join(base, 'wt-a') };
    expect(projectsOverlapProblem(a, [{ id: 'b', repoPath: join(base, 'b'), worktreesRoot: join(base, 'wt-b') }])).toBeUndefined();
    expect(projectsOverlapProblem(a, [{ id: 'b', repoPath: join(base, 'a'), worktreesRoot: join(base, 'wt-b') }])).toMatch(/se solapan con las del proyecto b/);
    expect(projectsOverlapProblem(a, [{ id: 'b', repoPath: join(base, 'b'), worktreesRoot: join(base, 'wt-a', 'b') }])).toMatch(/se solapan/);
    expect(projectsOverlapProblem(a, [{ id: 'b', repoPath: join(base, 'b'), worktreesRoot: join(base, 'a', 'wt') }])).toMatch(/se solapan/);
    symlinkSync(join(base, 'b'), join(base, 'atajo'), 'junction');
    expect(projectsOverlapProblem({ ...a, worktreesRoot: join(base, 'atajo', 'wt') }, [{ id: 'b', repoPath: join(base, 'b'), worktreesRoot: join(base, 'wt-b') }])).toMatch(/se solapan/);
    // El mismo proyecto (al volver a registrarlo) no choca consigo mismo.
    expect(projectsOverlapProblem(a, [a])).toBeUndefined();
  });
});

describe('carpeta _hooks (H2)', () => {
  it('la crea con su pre-push y es idempotente', async () => {
    const dir = join(temp(), '_hooks');
    await ensureHooksDir(dir);
    const text = readFileSync(join(dir, 'pre-push'), 'utf8');
    expect(text).toContain('push bloqueado');
    await ensureHooksDir(dir);
    expect(readdirSync(dir)).toEqual(['pre-push']);
  });

  it.runIf(win)('no escribe a través de una junction ni pisa nada ajeno', async () => {
    const base = temp();
    // _hooks es una junction hacia los hooks reales de un repo: escribir pre-push los pisaría.
    const realHooks = join(base, 'repo', '.git', 'hooks');
    mkdirSync(realHooks, { recursive: true });
    writeFileSync(join(realHooks, 'pre-push'), '#!/bin/sh\n# del usuario\n');
    symlinkSync(realHooks, join(base, 'enlazado'), 'junction');
    await expect(ensureHooksDir(join(base, 'enlazado'))).rejects.toThrow(/enlace, junction o archivo/);
    expect(readFileSync(join(realHooks, 'pre-push'), 'utf8')).toBe('#!/bin/sh\n# del usuario\n');

    const foreign = join(base, 'ajeno');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'post-merge'), 'x');
    await expect(ensureHooksDir(foreign)).rejects.toThrow(/archivos ajenos \(post-merge\)/);
    expect(existsSync(join(foreign, 'pre-push'))).toBe(false);

    const other = join(base, 'otro');
    mkdirSync(other);
    writeFileSync(join(other, 'pre-push'), '#!/bin/sh\nexit 0\n');
    await expect(ensureHooksDir(other)).rejects.toThrow(/otro contenido/);
    expect(readFileSync(join(other, 'pre-push'), 'utf8')).toBe('#!/bin/sh\nexit 0\n');

    // pre-push como enlace duro a un archivo de fuera: reescribirlo cambiaría ese archivo.
    const shared = join(base, 'compartido.txt');
    const ours = join(base, 'nuestro');
    await ensureHooksDir(ours);
    writeFileSync(shared, readFileSync(join(ours, 'pre-push')));
    rmSync(join(ours, 'pre-push'));
    linkSync(shared, join(ours, 'pre-push'));
    await expect(ensureHooksDir(ours)).rejects.toThrow(/enlace o archivo compartido/);
  });
});

describe('enlaces: contención física (H3)', () => {
  function layout() {
    const base = temp();
    const repo = join(base, 'repo');
    const wt = join(base, 'wt');
    const outside = join(base, 'fuera');
    for (const d of [repo, wt, outside]) mkdirSync(d);
    writeFileSync(join(outside, 'secreto.txt'), 'de fuera');
    return { base, repo, wt, outside };
  }

  it('carpetas reales del repo: junction a su ruta real; archivos: copia, no enlace duro', async () => {
    const { repo, wt } = layout();
    mkdirSync(join(repo, 'node_modules', 'paquete'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'paquete', 'keep.txt'), 'no borrar');
    writeFileSync(join(repo, 'compartido.json'), '{"a":1}');
    const report = await createLinks(repo, wt, ['node_modules', 'compartido.json', 'no-existe']);
    expect(report).toEqual({ created: ['node_modules', 'compartido.json'], missing: ['no-existe'] });
    expect(lstatSync(join(wt, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(realpathSync.native(join(wt, 'node_modules'))).toBe(realpathSync.native(join(repo, 'node_modules')));
    expect(statSync(join(wt, 'compartido.json')).nlink).toBe(1);
    writeFileSync(join(wt, 'compartido.json'), 'cambiado en el worktree');
    expect(readFileSync(join(repo, 'compartido.json'), 'utf8')).toBe('{"a":1}');
  });

  it.runIf(win)('rechaza un origen que es (o cuelga de) una junction hacia fuera del repo', async () => {
    const { repo, wt, outside } = layout();
    symlinkSync(outside, join(repo, 'recursos'), 'junction');
    await expect(createLinks(repo, wt, ['recursos'])).rejects.toThrow(/sale del repo/);
    await expect(createLinks(repo, wt, ['recursos\\secreto.txt'])).rejects.toThrow(/sale del repo/);
    expect(readdirSync(wt)).toEqual([]);
    // Una junction que se queda dentro del repo sí sirve.
    mkdirSync(join(repo, 'datos'));
    symlinkSync(join(repo, 'datos'), join(repo, 'atajo'), 'junction');
    await expect(createLinks(repo, wt, ['atajo'])).resolves.toEqual({ created: ['atajo'], missing: [] });
  });

  it.runIf(win)('rechaza crear el enlace bajo una carpeta del worktree que es una junction hacia fuera', async () => {
    const { repo, wt, outside } = layout();
    mkdirSync(join(repo, 'a', 'b'), { recursive: true });
    symlinkSync(outside, join(wt, 'a'), 'junction');
    await expect(createLinks(repo, wt, ['a\\b'])).rejects.toThrow(/es un enlace, una junction o un archivo dentro del worktree/);
    expect(readdirSync(outside)).toEqual(['secreto.txt']);
  });

  it.runIf(win)('no crea nada fuera antes de rechazar: con `a` junction hacia fuera, «a\\b\\c» no deja `b` en el destino', async () => {
    const { repo, wt, outside } = layout();
    mkdirSync(join(repo, 'a', 'b', 'c'), { recursive: true });
    symlinkSync(outside, join(wt, 'a'), 'junction');
    await expect(createLinks(repo, wt, ['a\\b\\c'])).rejects.toThrow(/junction/);
    expect(readdirSync(outside)).toEqual(['secreto.txt']);
  });

  it.runIf(win)('rechaza cualquier junction descendiente en una carpeta compartida, hacia fuera o dentro del repo, con su ruta en el error', async () => {
    const { repo, wt, outside } = layout();
    mkdirSync(join(repo, 'recursos', 'sub'), { recursive: true });
    writeFileSync(join(repo, 'recursos', 'sub', 'propio.txt'), 'del repo');
    const externo = join(repo, 'recursos', 'sub', 'externo');
    symlinkSync(outside, externo, 'junction');
    await expect(createLinks(repo, wt, ['recursos'])).rejects.toThrow(`contiene un enlace o junction (${externo})`);
    expect(readdirSync(wt)).toEqual([]);
    // También una que se queda dentro del repo: llevaría a partes que no se revisan.
    rmSync(externo);
    mkdirSync(join(repo, 'datos'));
    const interno = join(repo, 'recursos', 'sub', 'interno');
    symlinkSync(join(repo, 'datos'), interno, 'junction');
    await expect(createLinks(repo, wt, ['recursos'])).rejects.toThrow(`contiene un enlace o junction (${interno})`);
    expect(readdirSync(wt)).toEqual([]);
  });

  it.runIf(win)('un ciclo de junctions dentro de la carpeta compartida se rechaza sin entrar en bucle', async () => {
    const { repo, wt } = layout();
    mkdirSync(join(repo, 'recursos', 'a'), { recursive: true });
    // recursos\a\vuelta → recursos (ciclo): si se siguiera, el recorrido no terminaría.
    symlinkSync(join(repo, 'recursos'), join(repo, 'recursos', 'a', 'vuelta'), 'junction');
    const t0 = Date.now();
    await expect(createLinks(repo, wt, ['recursos'])).rejects.toThrow(`contiene un enlace o junction (${join(repo, 'recursos', 'a', 'vuelta')})`);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(readdirSync(wt)).toEqual([]);
  });

  it.runIf(win)('regresión de la 3.ª revisión de Codex: recursos\\interno → repo\\datos y datos\\externo → fuera', async () => {
    const { repo, wt, outside } = layout();
    mkdirSync(join(repo, 'recursos'));
    mkdirSync(join(repo, 'datos'));
    symlinkSync(join(repo, 'datos'), join(repo, 'recursos', 'interno'), 'junction');
    symlinkSync(outside, join(repo, 'datos', 'externo'), 'junction');
    await expect(createLinks(repo, wt, ['recursos'])).rejects.toThrow(`contiene un enlace o junction (${join(repo, 'recursos', 'interno')})`);
    expect(readdirSync(wt)).toEqual([]);
    expect(readdirSync(outside)).toEqual(['secreto.txt']);
  });
});

describe('removeAllLinks: recorrido completo o nada (H6)', () => {
  type Entry = { name: string; isSymbolicLink(): boolean; isDirectory(): boolean };
  const dir = (name: string): Entry => ({ name, isSymbolicLink: () => false, isDirectory: () => true });
  const link = (name: string): Entry => ({ name, isSymbolicLink: () => true, isDirectory: () => false });
  const err = (code: string) => Object.assign(new Error(code), { code });

  function fakeFs(tree: Record<string, Entry[] | string>, unlinked: string[]): LinkFs {
    return {
      readdir: async (d) => {
        const v = tree[d];
        if (typeof v === 'string') throw err(v);
        if (!v) throw err('ENOENT');
        return v;
      },
      unlink: async (p) => {
        if (p.endsWith('retenido')) throw err('EBUSY');
        unlinked.push(p);
      },
      rmdir: async () => undefined,
    };
  }

  it('quita los enlaces de todo el árbol y solo tolera carpetas que desaparecieron (ENOENT)', async () => {
    const unlinked: string[] = [];
    const root = join('W', 'wt');
    const tree = { [root]: [dir('a'), dir('se-fue'), link('node_modules')], [join(root, 'a')]: [link('enlace')] };
    expect((await removeAllLinks(root, fakeFs(tree, unlinked))).sort()).toEqual([join(root, 'a', 'enlace'), join(root, 'node_modules')].sort());
  });

  it.each(['EACCES', 'EPERM', 'EIO', 'EMFILE'])('un %s al listar se propaga (el worktree no se borra)', async (code) => {
    const unlinked: string[] = [];
    const root = join('W', 'wt');
    const tree = { [root]: [dir('sin-permiso'), link('node_modules')], [join(root, 'sin-permiso')]: code };
    await expect(removeAllLinks(root, fakeFs(tree, unlinked))).rejects.toThrow(new RegExp(`no se pudo revisar .*sin-permiso.*${code}.*no se borra`));
  });

  it('un fallo al quitar un enlace también se propaga', async () => {
    const root = join('W', 'wt');
    await expect(removeAllLinks(root, fakeFs({ [root]: [link('retenido')] }, []))).rejects.toThrow(/EBUSY/);
  });
});
