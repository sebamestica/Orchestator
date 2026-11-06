import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { symlinkSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFolderPicker,
  createZipPicker,
  currentBranch,
  deduceGate,
  encodePowerShell,
  FolderError,
  hasCommits,
  isSystemEntry,
  listFolder,
  listRoots,
  normalizeFolderPath,
  slugifyProjectId,
  suggestProjectId,
  type SpawnFn,
} from '../../../src/core/fs/folders.ts';
import { folderInspectionSchema, fsListResponse } from '../../../src/shared/index.ts';
import { cleanupDirs, gitInit, gitInitWithCommit, makeF5App, tempDir, writeFiles } from './helpers.ts';

afterEach(cleanupDirs);

const isWin = process.platform === 'win32';

describe('GET /fs/list', () => {
  it('lista una carpeta real: carpetas primero, isGitRepo, sin archivos de sistema', async () => {
    const root = await tempDir();
    await mkdir(join(root, 'zeta-repo', '.git'), { recursive: true });
    await mkdir(join(root, 'Árbol'));
    await mkdir(join(root, 'alfa'));
    await mkdir(join(root, '$Recycle.Bin'));
    await writeFiles(root, { 'b.txt': 'b', 'A.md': 'a', 'desktop.ini': '', 'NTUSER.DAT': '', 'Thumbs.db': '' });
    const t = makeF5App();
    const res = await t.req('GET', `/fs/list?path=${encodeURIComponent(root)}`);
    expect(res.status).toBe(200);
    const body = fsListResponse.parse(res.json);
    expect(body.path).toBe(normalizeFolderPath(root));
    expect(body.parent).toBe(join(body.path, '..'));
    expect(body.entries.map((e) => e.name)).toEqual(['alfa', 'Árbol', 'zeta-repo', 'A.md', 'b.txt']);
    expect(body.entries.find((e) => e.name === 'zeta-repo')).toEqual({ name: 'zeta-repo', path: join(body.path, 'zeta-repo'), isDir: true, isGitRepo: true });
    expect(body.entries.find((e) => e.name === 'alfa')?.isGitRepo).toBe(false);
    expect(body.entries.find((e) => e.name === 'A.md')).toMatchObject({ isDir: false, isGitRepo: false });
  });

  it('pone un tope de entradas (2000 por defecto)', async () => {
    const root = await tempDir();
    await Promise.all(Array.from({ length: 30 }, (_, i) => writeFile(join(root, `f${String(i).padStart(2, '0')}.txt`), '')));
    await mkdir(join(root, 'sub'));
    const capped = await listFolder(root, { maxEntries: 10 });
    expect(capped.entries).toHaveLength(10);
    expect(capped.entries[0]?.name).toBe('sub');
  });

  it('sin path: las raíces habituales y las unidades que existen', async () => {
    const t = makeF5App();
    const res = await t.req('GET', '/fs/list');
    expect(res.status).toBe(200);
    const body = fsListResponse.parse(res.json);
    // `?path=` vacío es lo mismo que sin path.
    expect((await t.req('GET', '/fs/list?path=')).json).toEqual(body);
    expect(body).toMatchObject({ path: '', parent: null });
    expect(body.entries.length).toBeGreaterThan(0);
    for (const e of body.entries) expect(e.isDir).toBe(true);
    if (isWin) {
      expect(body.entries.map((e) => e.path)).toContain('C:\\');
      expect(body.entries.some((e) => e.name === 'Perfil')).toBe(true);
    }
  });

  it('raíces en Windows con perfil y escritorio de OneDrive inyectados', async () => {
    if (!isWin) return;
    const home = await tempDir();
    const onedrive = join(home, 'OneDrive - Org');
    await mkdir(join(onedrive, 'Escritorio'), { recursive: true });
    const roots = await listRoots({ platform: 'win32', home, env: { OneDrive: onedrive } });
    expect(roots.entries.find((e) => e.name === 'Escritorio')?.path).toBe(join(onedrive, 'Escritorio'));
    expect(roots.entries.find((e) => e.name === 'Perfil')?.path).toBe(home);
  });

  it('ruta relativa → 400; inexistente → 404; un archivo → 400', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'x.txt': 'x' });
    const t = makeF5App();
    expect((await t.req('GET', '/fs/list?path=relativa%2Fcarpeta')).status).toBe(400);
    expect((await t.req('GET', `/fs/list?path=${encodeURIComponent(join(root, 'no-existe'))}`)).status).toBe(404);
    expect((await t.req('GET', `/fs/list?path=${encodeURIComponent(join(root, 'x.txt'))}`)).status).toBe(400);
  });

  it('reconoce archivos de sistema por nombre', () => {
    for (const n of ['$Recycle.Bin', 'System Volume Information', 'pagefile.sys', 'NTUSER.DAT{abc}.TM.blf', 'ntuser.ini', 'Mis documentos', 'Configuración local', '~$borrador.docx', '.git', 'AppData']) {
      expect(isSystemEntry(n), n).toBe(true);
    }
    for (const n of ['Escritorio', 'dev', '.vscode', 'Documents', 'node_modules']) expect(isSystemEntry(n), n).toBe(false);
  });
});

describe('POST /projects/inspect', () => {
  const inspect = async (dir: string) => {
    const t = makeF5App();
    const res = await t.req('POST', '/projects/inspect', { body: { path: dir } });
    expect(res.status).toBe(200);
    return folderInspectionSchema.parse(res.json);
  };

  it('package.json: check gana a gate y a test; enlaza node_modules; git real', async () => {
    const dir = join(await tempDir(), 'Mi Proyecto Ñandú');
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    gitInitWithCommit(dir, 'desarrollo');
    await writeFiles(dir, { 'package.json': JSON.stringify({ scripts: { test: 'vitest run', gate: 'node gate.js', check: 'tsc && vitest' } }) });
    const r = await inspect(dir);
    expect(r).toMatchObject({
      suggestedId: 'mi-proyecto-nandu',
      suggestedName: 'Mi Proyecto Ñandú',
      isGitRepo: true,
      gate: [{ command: 'npm', args: ['run', '-s', 'check'] }],
      links: ['node_modules'],
      warnings: [],
    });
    expect(await currentBranch(dir)).toBe('desarrollo');
  });

  it('package.json: gate si no hay check; test si solo hay test (no el de relleno de npm init)', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      'a/package.json': JSON.stringify({ scripts: { gate: 'npm run lint', test: 'jest' } }),
      'b/package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      'c/package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      'd/package.json': '{ esto no es json',
    });
    expect((await deduceGate(join(root, 'a'))).gate).toEqual([{ command: 'npm', args: ['run', '-s', 'gate'] }]);
    expect((await deduceGate(join(root, 'b'))).gate).toEqual([{ command: 'npm', args: ['run', '-s', 'test'] }]);
    expect((await deduceGate(join(root, 'c'))).gate).toBeNull();
    const broken = await deduceGate(join(root, 'd'));
    expect(broken.gate).toBeNull();
    expect(broken.warnings.join(' ')).toMatch(/package.json no es JSON válido/);
  });

  it('pyproject con pytest o pytest.ini → python -m pytest -q', async () => {
    const root = await tempDir();
    await writeFiles(root, {
      'py1/pyproject.toml': '[project]\nname = "x"\n[tool.pytest.ini_options]\naddopts = "-q"\n',
      'py2/pytest.ini': '[pytest]\n',
      'py3/pyproject.toml': '[project]\nname = "sin-pruebas"\n',
    });
    const pytest = [{ command: 'python', args: ['-m', 'pytest', '-q'] }];
    expect((await inspect(join(root, 'py1'))).gate).toEqual(pytest);
    expect((await inspect(join(root, 'py2'))).gate).toEqual(pytest);
    expect((await inspect(join(root, 'py3'))).gate).toBeNull();
  });

  it('sin gate ni git: gate null, sin enlaces y con avisos', async () => {
    const dir = join(await tempDir(), 'notas');
    await writeFiles(dir, { 'README.md': '# notas' });
    const r = await inspect(dir);
    expect(r).toMatchObject({ suggestedId: 'notas', isGitRepo: false, gate: null, links: [] });
    expect(r.warnings.join(' | ')).toMatch(/No es un repositorio git/);
    expect(r.warnings.join(' | ')).toMatch(/No se encontró una verificación \(gate\)/);
  });

  it('carpeta inexistente → 404; relativa → 400', async () => {
    const t = makeF5App();
    expect((await t.req('POST', '/projects/inspect', { body: { path: join(await tempDir(), 'nada') } })).status).toBe(404);
    expect((await t.req('POST', '/projects/inspect', { body: { path: 'src' } })).status).toBe(400);
  });

  it('ids: normalizados a idSchema y con sufijo si ya existen', () => {
    expect(slugifyProjectId('  Vetworld  ')).toBe('vetworld');
    expect(slugifyProjectId('Año 2026 — Clínica')).toBe('ano-2026-clinica');
    expect(slugifyProjectId('x')).toBe('x-proyecto');
    expect(slugifyProjectId('···')).toBe('proyecto');
    expect(slugifyProjectId('a'.repeat(100))).toHaveLength(64);
    expect(suggestProjectId('Vetworld', new Set(['vetworld', 'vetworld-2']))).toBe('vetworld-3');
  });
});

describe('POST /projects/from-folder', () => {
  it('repo git con gate: registra con workspace (worktrees, rama actual, integración, enlaces y gate)', async () => {
    const dir = join(await tempDir(), 'Clinica');
    await mkdir(join(dir, 'node_modules'), { recursive: true });
    gitInitWithCommit(dir, 'trabajo');
    await writeFiles(dir, { 'package.json': JSON.stringify({ scripts: { check: 'vitest run' } }) });
    const t = makeF5App();
    const res = await t.req('POST', '/projects/from-folder', { body: { path: dir, name: 'Clínica veterinaria' } });
    expect(res.status, res.text).toBe(201);
    const project = (res.json as { project: Record<string, unknown> }).project;
    expect(project).toMatchObject({
      id: 'clinica',
      name: 'Clínica veterinaria',
      repoPath: normalizeFolderPath(dir),
      workspace: {
        worktreesRoot: isWin ? 'C:\\dev\\.worktrees\\clinica-orq' : expect.any(String),
        baseBranch: 'trabajo',
        integrationBranch: 'orq/integracion',
        links: ['node_modules'],
        gate: [{ command: 'npm', args: ['run', '-s', 'check'], timeoutMs: 1_800_000 }],
      },
    });
    expect(t.store.getProject('clinica')?.workspace?.gate).toHaveLength(1);

    // La misma carpeta otra vez, o el mismo id: 409.
    expect((await t.req('POST', '/projects/from-folder', { body: { path: dir, id: 'otra-clinica' } })).status).toBe(409);
    const other = join(await tempDir(), 'clinica');
    await mkdir(other);
    expect((await t.req('POST', '/projects/from-folder', { body: { path: other, id: 'clinica' } })).status).toBe(409);
  });

  it('sin git (aunque haya gate) o sin gate: registra sin workspace', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'sin-git/package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'sin-gate/README.md': '#' });
    gitInit(join(root, 'sin-gate'));
    const t = makeF5App();
    for (const [name, id] of [['sin-git', 'sin-git'], ['sin-gate', 'propio']] as const) {
      const res = await t.req('POST', '/projects/from-folder', { body: { path: join(root, name), ...(id !== name ? { id } : {}) } });
      expect(res.status, res.text).toBe(201);
      const project = (res.json as { project: Record<string, unknown> }).project;
      expect(project).toMatchObject({ id, name });
      expect(project.workspace).toBeUndefined();
    }
  });

  it('la misma carpeta local por una junction: 409, ya es un proyecto', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'real/README.md': '#' });
    symlinkSync(join(root, 'real'), join(root, 'alias'), isWin ? 'junction' : 'dir');
    const t = makeF5App();
    expect((await t.req('POST', '/projects/from-folder', { body: { path: join(root, 'real') } })).status).toBe(201);
    const res = await t.req('POST', '/projects/from-folder', { body: { path: join(root, 'alias'), id: 'alias' } });
    expect(res.status, res.text).toBe(409);
    expect(res.text).toMatch(/ya está registrada como el proyecto real/);
  });

  it('repo git SIN commits (caso marketing), aunque tenga gate: modo local, sin workspace, con aviso', async () => {
    const root = await tempDir();
    const dir = join(root, 'marketing');
    await writeFiles(root, { 'marketing/package.json': JSON.stringify({ scripts: { check: 'node -e 0' } }) });
    gitInit(dir);
    expect(await hasCommits(dir)).toBe(false);
    const t = makeF5App();
    const inspect = await t.req('POST', '/projects/inspect', { body: { path: dir } });
    expect((inspect.json as { warnings: string[] }).warnings.join('\n')).toMatch(/aún no tiene commits: se trabajará en local/);
    const res = await t.req('POST', '/projects/from-folder', { body: { path: dir } });
    expect(res.status, res.text).toBe(201);
    expect((res.json as { project: Record<string, unknown> }).project.workspace).toBeUndefined();
  });

  it('hasCommits: con un commit sí (también por packed-refs); HEAD separado sí', async () => {
    const root = await tempDir();
    const dir = join(root, 'repo');
    await writeFiles(root, { 'repo/a.txt': 'a' });
    gitInit(dir);
    const g = (...args: string[]) => execFileSync('git', ['-c', 'user.name=u', '-c', 'user.email=u@l', ...args], { cwd: dir, stdio: 'pipe', windowsHide: true }).toString();
    g('add', '.');
    g('commit', '-q', '-m', 'uno');
    expect(await hasCommits(dir)).toBe(true);
    g('pack-refs', '--all');
    expect(await hasCommits(dir)).toBe(true);
    g('checkout', '-q', '--detach');
    expect(await hasCommits(dir)).toBe(true);
  });

  it('carpetas que empiezan por «authorization»: se listan, se abren y se registran con su ruta real', async () => {
    const root = await tempDir();
    const dir = join(root, 'authorization-service-backend');
    const app = join(dir, 'app');
    await mkdir(app, { recursive: true });
    gitInitWithCommit(dir);
    await writeFiles(dir, { 'package.json': JSON.stringify({ scripts: { check: 'vitest run' } }) });
    const t = makeF5App();

    const parent = await t.req('GET', `/fs/list?path=${encodeURIComponent(root)}`);
    expect(parent.status).toBe(200);
    expect(parent.text).not.toContain('[REDACTADO]');
    const entry = fsListResponse.parse(parent.json).entries.find((e) => e.name === 'authorization-service-backend');
    expect(entry?.path).toBe(join(normalizeFolderPath(root), 'authorization-service-backend'));
    expect((await t.req('GET', `/fs/list?path=${encodeURIComponent(entry?.path ?? '')}`)).status).toBe(200);

    for (const [path, id] of [[dir, 'authorization-service-backend'], [app, 'app']] as const) {
      const res = await t.req('POST', '/projects/from-folder', { body: { path } });
      expect(res.status, res.text).toBe(201);
      expect(res.text).not.toContain('[REDACTADO]');
      expect(t.store.getProject(id)?.repoPath).toBe(normalizeFolderPath(path));
    }
  });

  it('valida el cuerpo con Zod e informa carpetas inexistentes con 404', async () => {
    const t = makeF5App();
    expect((await t.req('POST', '/projects/from-folder', { body: { path: 'C:\\x', id: 'No Válido' } })).status).toBe(400);
    expect((await t.req('POST', '/projects/from-folder', { body: { path: join(await tempDir(), 'nada') } })).status).toBe(404);
  });
});

/** Proceso falso de `spawn` con la salida indicada. */
function fakeSpawn(result: { stdout?: string; code?: number; stderr?: string }, calls: { cmd: string; args: readonly string[]; opts: unknown }[]): SpawnFn {
  return ((cmd: string, args: readonly string[], opts: unknown) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      if (result.stdout) child.stdout.write(result.stdout);
      if (result.stderr) child.stderr.write(result.stderr);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', result.code ?? 0));
    });
    return child;
  }) as unknown as SpawnFn;
}

describe('POST /fs/pick-zip', () => {
  it('con el selector inyectado responde el .zip elegido o null; sin él, 501', async () => {
    const answers = ['C:\\Descargas\\mi-skill.zip', null];
    const t = makeF5App({ pickZip: async () => answers.shift() ?? null });
    expect((await t.req('POST', '/fs/pick-zip')).json).toEqual({ path: 'C:\\Descargas\\mi-skill.zip' });
    expect((await t.req('POST', '/fs/pick-zip')).json).toEqual({ path: null });
    expect((await makeF5App().req('POST', '/fs/pick-zip')).status).toBe(501);
  });
});

describe('POST /fs/pick-folder', () => {
  it('con el selector inyectado responde la carpeta elegida o null', async () => {
    const answers = ['C:\\dev\\Vetworld', null];
    const t = makeF5App({ pickFolder: async () => answers.shift() ?? null });
    expect((await t.req('POST', '/fs/pick-folder')).json).toEqual({ path: 'C:\\dev\\Vetworld' });
    expect((await t.req('POST', '/fs/pick-folder')).json).toEqual({ path: null });
  });

  it('sin selector configurado: 501', async () => {
    const res = await makeF5App().req('POST', '/fs/pick-folder');
    expect(res.status).toBe(501);
    expect(res.json).toMatchObject({ error: { code: 'not_configured' } });
  });

  it('PowerShell por -EncodedCommand, sin shell, con -STA y el ejecutable de la configuración', async () => {
    const calls: { cmd: string; args: readonly string[]; opts: unknown }[] = [];
    const pick = createFolderPicker({ powershellPath: 'C:\\PS\\powershell.exe', platform: 'win32', spawnFn: fakeSpawn({ stdout: '\uFEFFC:/Users/Yo/Proyectos/Clínica\r\n' }, calls) });
    expect(await pick()).toBe('C:\\Users\\Yo\\Proyectos\\Clínica');
    const call = calls[0];
    expect(call?.cmd).toBe('C:\\PS\\powershell.exe');
    expect(call?.opts).toMatchObject({ shell: false });
    expect(call?.args).toContain('-STA');
    const encoded = call?.args[call.args.indexOf('-EncodedCommand') + 1] ?? '';
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(script).toContain('System.Windows.Forms.FolderBrowserDialog');
    expect(encodePowerShell(script)).toBe(encoded);
  });

  it('cancelar → null; un fallo de PowerShell → FolderError; fuera de Windows → unsupported', async () => {
    const calls: { cmd: string; args: readonly string[]; opts: unknown }[] = [];
    expect(await createFolderPicker({ powershellPath: 'powershell.exe', platform: 'win32', spawnFn: fakeSpawn({ stdout: '' }, calls) })()).toBeNull();
    await expect(createFolderPicker({ powershellPath: 'powershell.exe', platform: 'win32', spawnFn: fakeSpawn({ code: 1, stderr: 'Add-Type falló' }, calls) })()).rejects.toThrow(FolderError);
    await expect(createFolderPicker({ powershellPath: 'powershell.exe', platform: 'linux' })()).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('selector de .zip: OpenFileDialog filtrado a *.zip, ruta normalizada o null al cancelar', async () => {
    const calls: { cmd: string; args: readonly string[]; opts: unknown }[] = [];
    const pick = createZipPicker({ powershellPath: 'C:\\PS\\powershell.exe', platform: 'win32', spawnFn: fakeSpawn({ stdout: '\uFEFFC:/Users/Yo/Descargas/mi-skill.zip\r\n' }, calls) });
    expect(await pick()).toBe('C:\\Users\\Yo\\Descargas\\mi-skill.zip');
    const encoded = calls[0]?.args[calls[0].args.indexOf('-EncodedCommand') + 1] ?? '';
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    expect(script).toContain('System.Windows.Forms.OpenFileDialog');
    expect(script).toContain('|*.zip');
    expect(await createZipPicker({ powershellPath: 'powershell.exe', platform: 'win32', spawnFn: fakeSpawn({ stdout: '' }, calls) })()).toBeNull();
    await expect(createZipPicker({ powershellPath: 'powershell.exe', platform: 'linux' })()).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('un solo diálogo a la vez: dos peticiones simultáneas comparten la respuesta', async () => {
    const calls: { cmd: string; args: readonly string[]; opts: unknown }[] = [];
    const pick = createFolderPicker({ powershellPath: 'powershell.exe', platform: 'win32', spawnFn: fakeSpawn({ stdout: 'D:\\obra' }, calls) });
    const [a, b] = await Promise.all([pick(), pick()]);
    expect([a, b]).toEqual(['D:\\obra', 'D:\\obra']);
    expect(calls).toHaveLength(1);
    await pick();
    expect(calls).toHaveLength(2);
  });
});
