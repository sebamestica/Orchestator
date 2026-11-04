import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { redactSecrets } from '../../shared/redact.ts';
import { assertRealInside, renameWithRetry, writeFileAtomic } from '../memory/safe-fs.ts';
import { FileLockBusyError, withFileLock } from '../vault/file-lock.ts';
import { readSkillMeta, skillNameSchema, type SkillMeta } from './skill-md.ts';
import {
  QUARANTINE_ID_RE,
  skillReviewSchema,
  skillsLockSchema,
  type LockEntry,
  type SkillReview,
  type SkillSource,
  type SkillsLock,
} from './schemas.ts';
import { Tar, TarError } from './tar.ts';
import {
  copyTree,
  detectLicense,
  inspectFiles,
  moveDir,
  samePath,
  sha256File,
  TreeChangedError,
  treeHash,
  TreeLimitError,
  walkTree,
  type FileInfo,
  type WalkOptions,
  type WalkResult,
} from './tree.ts';

/** Carpeta común de los agentes de este PC (skills, cuarentena, candados). */
export const AGENT_HUB_DIR = 'C:\\dev\\agent-hub';

export interface SkillLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxZipBytes: number;
  /** Entradas totales (archivos + carpetas): frena las bombas de carpetas vacías. */
  maxEntries: number;
  /** Segmentos de ruta como máximo. */
  maxDepth: number;
}
export const DEFAULT_LIMITS: SkillLimits = {
  maxFiles: 2000,
  maxTotalBytes: 50 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  maxZipBytes: 50 * 1024 * 1024,
  maxEntries: 4000,
  maxDepth: 16,
};

export interface SkillHubOptions {
  /** Carpeta del hub (por defecto `C:\dev\agent-hub`); de ella salen las rutas por defecto. */
  hubDir?: string;
  /** Proyecto cuyas `.agents/skills` se listan (por defecto, la carpeta actual). */
  projectDir?: string;
  /** Raíces donde se buscan skills, en orden de prioridad. Por defecto: `<hub>/skills` y `<proyecto>/.agents/skills`. */
  roots?: readonly string[];
  /** Raíz donde `approve` instala. Por defecto `<hub>/skills`. */
  installRoot?: string;
  /** Cuarentena. Por defecto `<hub>/skills-entrantes`. */
  quarantineDir?: string;
  /** Por defecto `skills.lock.json` junto a la raíz de instalación (`<hub>/skills.lock.json`). */
  lockPath?: string;
  /** Destino por defecto de `exportSkill`. Por defecto `<hub>/skills-exportadas`. */
  exportDir?: string;
  tar?: Tar;
  limits?: Partial<SkillLimits>;
  now?: () => Date;
}

export type SkillHubErrorCode =
  | 'NOT_FOUND'
  | 'AMBIGUOUS'
  | 'EXISTS'
  | 'INVALID_ARCHIVE'
  | 'UNSAFE_ENTRY'
  | 'INVALID_SKILL'
  | 'LIMIT'
  | 'TAMPERED'
  | 'INVALID_LOCK'
  | 'BUSY'
  | 'TAR_FAILED';

export class SkillHubError extends Error {
  override readonly name = 'SkillHubError';
  readonly code: SkillHubErrorCode;
  readonly details: readonly string[];
  constructor(code: SkillHubErrorCode, message: string, details: readonly string[] = []) {
    super(details.length ? `${message}:\n- ${details.join('\n- ')}` : message);
    this.code = code;
    this.details = details;
  }
}

/** Skill encontrada por `list()`. */
export interface SkillEntry {
  /** `name` del frontmatter (o la carpeta si el frontmatter no es válido). */
  name: string;
  folder: string;
  dir: string;
  root: string;
  description?: string;
  license?: string;
  /** False si el frontmatter no es válido o `name` no coincide con la carpeta. */
  valid: boolean;
  problems: string[];
}

export interface QuarantinedSkill extends SkillReview {
  /** Carpeta de la skill en cuarentena. */
  path: string;
}

export interface ExportResult {
  name: string;
  path: string;
  /** SHA-256 del zip creado. */
  sha256: string;
  treeHash: string;
  fileCount: number;
  totalBytes: number;
  /** Hash registrado en `skills.lock.json`, si la skill se instaló con `approve`. */
  lockTreeHash?: string;
}

const PREVIEW_CHARS = 8000;
const REVIEW_SUFFIX = '.revision.json';

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

async function readMagic(path: string): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Como `exists`, pero sin seguir un enlace final (una junction rota también cuenta). */
async function lexists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return false;
    throw err;
  }
}

/**
 * `writeFileAtomic` (c4) y, después, comprobación de que el destino sigue dentro de `root`.
 * Reduce la ventana TOCTOU de `writeFileAtomic` (comprueba la carpeta y luego escribe); el arreglo
 * de fondo está propuesto para `safe-fs.ts` en el informe.
 */
async function writeInside(root: string, target: string, content: string): Promise<void> {
  await writeFileAtomic(root, target, content);
  await assertRealInside(root, target);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return false;
    throw err;
  }
}

/**
 * Hub de skills: lista las instaladas, importa a cuarentena (carpeta o zip), revisa, aprueba
 * (instala y registra en `skills.lock.json`), rechaza y exporta a zip.
 * Regla: nunca se ejecuta, importa ni interpreta un archivo de una skill; solo se leen bytes.
 * El único proceso que se lanza es `tar.exe` por ruta absoluta y sin shell.
 */
export class SkillHub {
  readonly roots: readonly string[];
  readonly installRoot: string;
  readonly quarantineDir: string;
  readonly lockPath: string;
  readonly exportDir: string;
  readonly limits: SkillLimits;
  private readonly tar: Tar;
  private readonly now: () => Date;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(opts: SkillHubOptions = {}) {
    const hub = opts.hubDir ?? AGENT_HUB_DIR;
    const globalRoot = join(hub, 'skills');
    this.roots = (opts.roots ?? [globalRoot, join(opts.projectDir ?? process.cwd(), '.agents', 'skills')]).map((r) => resolve(r));
    this.installRoot = resolve(opts.installRoot ?? opts.roots?.[0] ?? globalRoot);
    this.quarantineDir = resolve(opts.quarantineDir ?? join(hub, 'skills-entrantes'));
    this.lockPath = resolve(opts.lockPath ?? join(dirname(this.installRoot), 'skills.lock.json'));
    this.exportDir = resolve(opts.exportDir ?? join(hub, 'skills-exportadas'));
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.tar = opts.tar ?? new Tar();
    this.now = opts.now ?? (() => new Date());
  }

  // ───────────────────────────── listar ─────────────────────────────

  /** Skills de cada raíz (carpetas con `SKILL.md`; se omiten las ocultas). Valida frontmatter y nombre = carpeta. */
  async list(): Promise<SkillEntry[]> {
    const out: SkillEntry[] = [];
    for (const root of this.roots) {
      let names: string[];
      try {
        names = (await readdir(root)).sort();
      } catch (err) {
        if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) continue;
        throw err;
      }
      for (const folder of names) {
        if (folder.startsWith('.')) continue;
        const dir = join(root, folder);
        let text: string;
        try {
          if (!(await stat(dir)).isDirectory()) continue;
          text = await readFile(join(dir, 'SKILL.md'), 'utf8');
        } catch (err) {
          if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR') || isErrno(err, 'EISDIR')) continue;
          throw err;
        }
        const { meta, problems } = readSkillMeta(text, folder);
        const entry: SkillEntry = { name: meta?.name ?? folder, folder, dir, root, valid: problems.length === 0, problems };
        if (meta) entry.description = meta.description;
        if (meta?.license !== undefined) entry.license = meta.license;
        out.push(entry);
      }
    }
    return out;
  }

  // ───────────────────────────── importar ─────────────────────────────

  /** Copia una skill (carpeta o `.zip`) a la cuarentena y devuelve su informe de revisión. No instala nada. */
  async importSkill(origin: string): Promise<QuarantinedSkill> {
    const src = resolve(origin);
    let st;
    try {
      st = await stat(src);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) throw new SkillHubError('NOT_FOUND', `no existe el origen ${src}`);
      throw err;
    }
    await mkdir(this.quarantineDir, { recursive: true });
    if (st.isDirectory()) return this.importFolder(src);
    if (st.isFile()) return this.importZip(src, st.size);
    throw new SkillHubError('INVALID_ARCHIVE', `${src} no es una carpeta ni un archivo`);
  }

  private stamp(): string {
    const iso = this.now().toISOString(); // 2026-11-01T22:15:03.123Z
    return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}-${randomBytes(3).toString('hex')}`;
  }

  private async walk(dir: string, opts: WalkOptions = {}): Promise<WalkResult> {
    try {
      return await walkTree(dir, this.limits, opts);
    } catch (err) {
      if (err instanceof TreeLimitError) throw new SkillHubError('LIMIT', `la skill supera los límites: ${err.message}`);
      throw err;
    }
  }

  private async importFolder(src: string): Promise<QuarantinedSkill> {
    const walk = await this.walk(src, { followRoot: true }); // el origen lo elige el usuario
    if (walk.problems.length) throw new SkillHubError('UNSAFE_ENTRY', `carpeta rechazada (${src})`, walk.problems);
    if (!walk.files.some((f) => f.path === 'SKILL.md')) throw new SkillHubError('INVALID_SKILL', `${src} no tiene SKILL.md en su raíz`);
    const stamp = this.stamp();
    const staging = join(this.quarantineDir, `.tmp-${stamp}`);
    await assertRealInside(this.quarantineDir, staging);
    try {
      await this.copyChecked(src, staging, walk, { followRoot: true }, 'UNSAFE_ENTRY');
      const source: SkillSource = { kind: 'folder', path: redactSecrets(src) };
      return await this.finalize(staging, stamp, source, basename(src), walk.skipped);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  private async importZip(src: string, size: number): Promise<QuarantinedSkill> {
    if (!src.toLowerCase().endsWith('.zip')) throw new SkillHubError('INVALID_ARCHIVE', `solo se aceptan carpetas o archivos .zip: ${src}`);
    if (size > this.limits.maxZipBytes) throw new SkillHubError('LIMIT', `el zip pesa ${size} bytes (máximo ${this.limits.maxZipBytes})`);
    const stamp = this.stamp();
    const staging = join(this.quarantineDir, `.tmp-${stamp}`);
    // Se trabaja sobre una copia privada: lo listado, lo extraído y el SHA-256 son el mismo archivo
    // aunque alguien cambie el original entre medias.
    const zip = `${staging}.zip`;
    await assertRealInside(this.quarantineDir, staging);
    try {
      await copyFile(src, zip, fsConstants.COPYFILE_EXCL);
      if ((await stat(zip)).size > this.limits.maxZipBytes) throw new SkillHubError('LIMIT', `el zip supera ${this.limits.maxZipBytes} bytes`);
      // bsdtar lee muchos formatos (tar, 7z, rar, cpio…): se exige la firma de zip para no abrir otro por error.
      const magic = await readMagic(zip);
      if (magic.length < 4 || magic.readUInt32LE(0) !== 0x04034b50) throw new SkillHubError('INVALID_ARCHIVE', `${basename(src)} no es un zip (firma ${magic.toString('hex')})`);

      let listing;
      try {
        listing = await this.tar.list(zip, this.quarantineDir, this.limits);
      } catch (err) {
        if (err instanceof TarError) throw new SkillHubError('TAR_FAILED', `${basename(src)}: ${err.message}`);
        throw err;
      }
      if (listing.problems.length) throw new SkillHubError('UNSAFE_ENTRY', `zip rechazado (${basename(src)}), no se extrajo nada`, listing.problems);

      const zipSha = await sha256File(zip);
      await mkdir(staging);
      try {
        await this.tar.extract(zip, staging);
      } catch (err) {
        if (err instanceof TarError) throw new SkillHubError('TAR_FAILED', `${basename(src)}: ${err.message}`);
        throw err;
      }
      // Segunda defensa: lo extraído tampoco puede tener enlaces ni tipos especiales.
      const walk = await this.walk(staging);
      if (walk.problems.length) throw new SkillHubError('UNSAFE_ENTRY', `zip rechazado tras extraer (${basename(src)})`, walk.problems);
      for (const skipped of walk.skipped) await rm(join(staging, skipped), { recursive: true, force: true });

      let root = staging;
      let topFolder: string | undefined;
      if (!walk.files.some((f) => f.path === 'SKILL.md')) {
        const top = (await readdir(staging, { withFileTypes: true })).filter((e) => !walk.skipped.includes(e.name));
        const only = top[0];
        if (top.length !== 1 || !only?.isDirectory() || !walk.files.some((f) => f.path === `${only.name}/SKILL.md`)) {
          throw new SkillHubError('INVALID_SKILL', 'el zip debe tener SKILL.md en la raíz o una única carpeta de primer nivel con SKILL.md');
        }
        topFolder = only.name;
        root = join(staging, only.name);
      }
      const source: SkillSource = { kind: 'zip', path: redactSecrets(src), sha256: zipSha };
      if (topFolder !== undefined) source.topFolder = topFolder;
      return await this.finalize(root, stamp, source, topFolder, walk.skipped);
    } finally {
      await rm(staging, { recursive: true, force: true });
      await rm(zip, { force: true });
    }
  }

  /** Valida la copia, la mueve a `<cuarentena>/<nombre>-<marca>` y escribe su informe de revisión. */
  private async finalize(root: string, stamp: string, source: SkillSource, originalFolder: string | undefined, skipped: string[]): Promise<QuarantinedSkill> {
    const walk = await this.walk(root);
    if (walk.problems.length) throw new SkillHubError('UNSAFE_ENTRY', 'la copia en cuarentena no es segura', walk.problems);
    const skillMd = await readFile(join(root, 'SKILL.md'), 'utf8');
    const { meta, problems, unsupported } = readSkillMeta(skillMd);
    if (!meta || problems.length) throw new SkillHubError('INVALID_SKILL', 'SKILL.md no es válido', problems);

    const id = `${meta.name}-${stamp}`;
    const dest = join(this.quarantineDir, id);
    await assertRealInside(this.quarantineDir, dest);
    await renameWithRetry(root, dest);
    try {
      return await this.describe(id, meta, source, dest, walk, originalFolder, skipped, unsupported, skillMd);
    } catch (err) {
      await rm(dest, { recursive: true, force: true });
      throw err;
    }
  }

  private async describe(
    id: string,
    meta: SkillMeta,
    source: SkillSource,
    dest: string,
    walk: WalkResult,
    originalFolder: string | undefined,
    skipped: string[],
    unsupported: string[],
    skillMd: string,
  ): Promise<QuarantinedSkill> {
    const files = await inspectFiles(dest, walk.files);
    const warnings: string[] = [];
    if (originalFolder !== undefined && originalFolder !== meta.name) warnings.push(`la carpeta de origen se llama «${originalFolder}»; se instalará como «${meta.name}»`);
    if (unsupported.length) warnings.push(`claves de frontmatter guardadas como texto o descartadas: ${unsupported.join(', ')}`);
    if (skipped.length) warnings.push(`se omitió ${skipped.join(', ')} (puede traer hooks ejecutables)`);
    const installed = (await this.list()).filter((s) => s.name === meta.name);
    for (const s of installed) warnings.push(`ya existe «${meta.name}» en ${s.dir}: aprobar exigirá reemplazarla`);
    const review = await this.buildReview(id, meta, source, dest, files, skipped, warnings, skillMd);
    await writeInside(this.quarantineDir, join(this.quarantineDir, `${id}${REVIEW_SUFFIX}`), `${JSON.stringify(review, null, 2)}\n`);
    return { ...review, path: dest };
  }

  private async buildReview(
    id: string,
    meta: SkillMeta,
    source: SkillSource,
    dir: string,
    files: FileInfo[],
    skipped: string[],
    warnings: string[],
    skillMd: string,
  ): Promise<SkillReview> {
    const scripts = files.flatMap((f) => (f.script ? [{ path: f.path, reasons: f.script }] : []));
    const license = await detectLicense(dir, files, meta.license);
    if (scripts.length) warnings.unshift(`${scripts.length} archivo(s) ejecutable(s) o script(s): revísalos antes de aprobar (el hub nunca los ejecuta)`);
    if (license.declared === undefined && license.files.length === 0) warnings.push('sin licencia declarada ni archivo LICENSE');
    return skillReviewSchema.parse({
      version: 1,
      id,
      name: meta.name,
      description: redactSecrets(meta.description),
      importedAt: this.now().toISOString(),
      source,
      fileCount: files.length,
      totalBytes: files.reduce((n, f) => n + f.size, 0),
      treeHash: treeHash(files),
      files,
      scripts,
      license,
      skipped,
      warnings,
      skillMdPreview: redactSecrets(skillMd.slice(0, PREVIEW_CHARS)),
    });
  }

  // ───────────────────────────── cuarentena ─────────────────────────────

  /** Skills en cuarentena con su informe (las entradas con informe ilegible se omiten). */
  async quarantine(): Promise<QuarantinedSkill[]> {
    let names: string[];
    try {
      names = await readdir(this.quarantineDir);
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return [];
      throw err;
    }
    const out: QuarantinedSkill[] = [];
    for (const file of names.sort()) {
      if (!file.endsWith(REVIEW_SUFFIX)) continue;
      const id = file.slice(0, -REVIEW_SUFFIX.length);
      if (!QUARANTINE_ID_RE.test(id)) continue;
      const parsed = skillReviewSchema.safeParse(parseJson(await readFile(join(this.quarantineDir, file), 'utf8')));
      if (!parsed.success || parsed.data.id !== id) continue;
      const path = join(this.quarantineDir, id);
      if (await exists(path)) out.push({ ...parsed.data, path });
    }
    return out;
  }

  /** Busca por id exacto (`<nombre>-<marca>`) o por nombre si hay una sola entrada con ese nombre. */
  async getReview(nameOrId: string): Promise<QuarantinedSkill> {
    const all = await this.quarantine();
    const exact = all.find((r) => r.id === nameOrId);
    if (exact) return exact;
    const byName = all.filter((r) => r.name === nameOrId);
    if (byName.length === 0) throw new SkillHubError('NOT_FOUND', `no hay ninguna skill «${nameOrId}» en cuarentena`);
    if (byName.length > 1) throw new SkillHubError('AMBIGUOUS', `hay varias «${nameOrId}» en cuarentena; indica el id`, byName.map((r) => r.id));
    return byName[0] as QuarantinedSkill;
  }

  /**
   * Instala la skill revisada en la raíz de instalación y la registra en `skills.lock.json`.
   * Con `replace`, la versión instalada se guarda en `<cuarentena>/.reemplazadas/`.
   *
   * Pasos, con un candado entre procesos (`<lock>.candado`) durante toda la aprobación:
   * 1. La carpeta de cuarentena debe ser una carpeta real en su sitio (no un enlace ni junction).
   * 2. Se copia a una carpeta privada con nombre aleatorio dentro de la raíz de instalación,
   *    volviendo a comprobar cada archivo justo antes de copiarlo.
   * 3. El hash final se calcula sobre esa copia privada: lo que se instala es lo que se hashea, y
   *    debe coincidir con el de la revisión. Cambios posteriores en la cuarentena ya no cuentan.
   * 4. Justo antes del `rename` se comprueba otra vez que la copia sigue siendo una carpeta real.
   *
   * Riesgo residual: Node no expone en Windows operaciones ligadas a handles (`openat`,
   * `O_NOFOLLOW`, bloqueo de carpetas), así que un proceso del mismo usuario que escriba en la raíz
   * de instalación podría tocar la copia privada entre el hash final y el `rename` (milisegundos, en
   * una carpeta de nombre aleatorio). Un atacante con esos permisos ya podría editar las skills
   * instaladas directamente.
   */
  approve(nameOrId: string, opts: { replace?: boolean } = {}): Promise<LockEntry> {
    return this.exclusive(() => this.approveNow(nameOrId, opts.replace === true));
  }

  private async approveNow(nameOrId: string, replace: boolean): Promise<LockEntry> {
    const review = await this.getReview(nameOrId);
    const lock = await this.readLock(); // si el lock está roto, se falla antes de mover nada
    await this.assertRealDir(this.quarantineDir, review.path);
    const walk = await this.walk(review.path);
    if (walk.problems.length || walk.skipped.length) throw new SkillHubError('TAMPERED', 'la cuarentena cambió desde la revisión', [...walk.problems, ...walk.skipped]);

    await mkdir(this.installRoot, { recursive: true });
    const privateDir = join(this.installRoot, `.tmp-aprobar-${randomBytes(8).toString('hex')}`);
    await assertRealInside(this.installRoot, privateDir);
    const dest = join(this.installRoot, review.name);
    try {
      await this.copyChecked(review.path, privateDir, walk, {}, 'TAMPERED');
      const privateWalk = await this.walk(privateDir);
      if (privateWalk.problems.length || privateWalk.skipped.length) throw new SkillHubError('TAMPERED', 'la copia privada no es segura', privateWalk.problems);
      const current = treeHash(await inspectFiles(privateDir, privateWalk.files));
      if (current !== review.treeHash) throw new SkillHubError('TAMPERED', `la skill cambió desde la revisión (${review.treeHash} → ${current}); vuelve a importarla`);
      const { meta } = readSkillMeta(await readFile(join(privateDir, 'SKILL.md'), 'utf8'));
      if (meta?.name !== review.name) throw new SkillHubError('TAMPERED', 'el nombre de SKILL.md cambió desde la revisión');

      await assertRealInside(this.installRoot, dest);
      if (await lexists(dest)) {
        if (!replace) throw new SkillHubError('EXISTS', `ya existe ${dest}; usa replace para reemplazarla`);
        const backupDir = join(this.quarantineDir, '.reemplazadas');
        await mkdir(backupDir, { recursive: true });
        await moveDir(dest, join(backupDir, `${review.name}-${this.stamp()}`), this.limits);
      }
      await this.assertRealDir(this.installRoot, privateDir);
      await renameWithRetry(privateDir, dest);
      await this.assertRealDir(this.installRoot, dest);
    } finally {
      await rm(privateDir, { recursive: true, force: true });
    }

    const entry: LockEntry = {
      name: review.name,
      description: review.description,
      source: review.source,
      treeHash: review.treeHash,
      fileCount: review.fileCount,
      totalBytes: review.totalBytes,
      scripts: review.scripts.map((s) => s.path),
      license: review.license,
      quarantineId: review.id,
      importedAt: review.importedAt,
      approvedAt: this.now().toISOString(),
    };
    lock.skills[review.name] = entry;
    lock.updatedAt = entry.approvedAt;
    await this.writeLock(lock);
    // La cuarentena ya no hace falta (rm borra un enlace sin seguirlo).
    await rm(review.path, { recursive: true, force: true });
    await rm(join(this.quarantineDir, `${review.id}${REVIEW_SUFFIX}`), { force: true });
    return entry;
  }

  /** Descarta una skill en cuarentena (carpeta e informe). Devuelve el id descartado. */
  reject(nameOrId: string): Promise<string> {
    return this.exclusive(async () => {
      const review = await this.getReview(nameOrId);
      await rm(review.path, { recursive: true, force: true });
      await rm(join(this.quarantineDir, `${review.id}${REVIEW_SUFFIX}`), { force: true });
      return review.id;
    });
  }

  /** `target`, hijo directo de `root`, debe ser una carpeta real (no enlace ni junction) cuya ruta real esté en su sitio. */
  private async assertRealDir(root: string, target: string): Promise<void> {
    const st = await lstat(target).catch(() => undefined);
    if (!st?.isDirectory() || st.isSymbolicLink()) throw new SkillHubError('TAMPERED', `${target} no es una carpeta real (¿enlace o junction?)`);
    const [realRoot, real] = await Promise.all([realpath(root), realpath(target)]);
    if (!samePath(real, join(realRoot, basename(target)))) throw new SkillHubError('TAMPERED', `${target} apunta fuera de ${root} (${real})`);
  }

  private async copyChecked(src: string, dest: string, walk: WalkResult, opts: { followRoot?: boolean }, code: SkillHubErrorCode): Promise<void> {
    try {
      await copyTree(src, dest, walk, opts);
    } catch (err) {
      if (err instanceof TreeChangedError) throw new SkillHubError(code, 'la carpeta cambió mientras se copiaba', [err.message]);
      throw err;
    }
  }

  /**
   * Serializa aprobar/rechazar: dentro del proceso con una cola, y entre procesos con un candado
   * de `mkdir` atómico (`src/core/vault/file-lock.ts`) que libera candados de procesos muertos.
   */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const locked = async (): Promise<T> => {
      try {
        return await withFileLock(`${this.lockPath}.candado`, fn, { timeoutMs: 120_000, staleMs: 10 * 60_000 });
      } catch (err) {
        if (err instanceof FileLockBusyError) throw new SkillHubError('BUSY', `otro proceso tiene el candado ${this.lockPath}.candado`);
        throw err;
      }
    };
    const run = this.pending.then(locked, locked);
    this.pending = run.catch(() => undefined);
    return run;
  }

  // ───────────────────────────── lock ─────────────────────────────

  async readLock(): Promise<SkillsLock> {
    let text: string;
    try {
      text = await readFile(this.lockPath, 'utf8');
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return { version: 1, updatedAt: this.now().toISOString(), skills: {} };
      throw err;
    }
    const parsed = skillsLockSchema.safeParse(parseJson(text));
    if (!parsed.success) throw new SkillHubError('INVALID_LOCK', `${this.lockPath} no es válido`, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    return parsed.data;
  }

  private async writeLock(lock: SkillsLock): Promise<void> {
    const sorted: SkillsLock = { ...lock, skills: Object.fromEntries(Object.entries(lock.skills).sort(([a], [b]) => (a < b ? -1 : 1))) };
    await writeInside(dirname(this.lockPath), this.lockPath, `${JSON.stringify(skillsLockSchema.parse(sorted), null, 2)}\n`);
  }

  // ───────────────────────────── exportar ─────────────────────────────

  /**
   * Crea un zip de una skill instalada con `tar -a -c -f` (nombres en UTF-8). Se empaqueta una copia
   * validada (sin enlaces y sin `.git`), así el zip contiene exactamente los archivos del hash.
   */
  async exportSkill(name: string, opts: { dest?: string } = {}): Promise<ExportResult> {
    const checked = skillNameSchema.safeParse(name);
    if (!checked.success) throw new SkillHubError('NOT_FOUND', `nombre de skill no válido: ${name}`);
    const skill = (await this.list()).find((s) => s.valid && s.name === name);
    if (!skill) throw new SkillHubError('NOT_FOUND', `no hay ninguna skill válida «${name}» en ${this.roots.join(', ')}`);
    const walk = await this.walk(skill.dir, { followRoot: true }); // puede estar enlazada con una junction
    if (walk.problems.length) throw new SkillHubError('UNSAFE_ENTRY', `no se exporta ${skill.dir}`, walk.problems);

    const stamp = this.stamp();
    const dest = resolve(opts.dest ?? join(this.exportDir, `${name}-${stamp}.zip`));
    if (!dest.toLowerCase().endsWith('.zip')) throw new SkillHubError('INVALID_ARCHIVE', `el destino debe acabar en .zip: ${dest}`);
    if (await exists(dest)) throw new SkillHubError('EXISTS', `ya existe ${dest}`);
    await mkdir(dirname(dest), { recursive: true });

    const stagingParent = join(dirname(dest), `.tmp-export-${stamp}`);
    try {
      const staging = join(stagingParent, name);
      await this.copyChecked(skill.dir, staging, walk, { followRoot: true }, 'UNSAFE_ENTRY');
      const files = await inspectFiles(staging, walk.files);
      try {
        await this.tar.createZip(dest, stagingParent, name);
      } catch (err) {
        await rm(dest, { force: true });
        if (err instanceof TarError) throw new SkillHubError('TAR_FAILED', err.message);
        throw err;
      }
      const result: ExportResult = {
        name,
        path: dest,
        sha256: await sha256File(dest),
        treeHash: treeHash(files),
        fileCount: files.length,
        totalBytes: files.reduce((n, f) => n + f.size, 0),
      };
      const locked = (await this.readLock()).skills[name];
      if (locked) result.lockTreeHash = locked.treeHash;
      return result;
    } finally {
      await rm(stagingParent, { recursive: true, force: true });
    }
  }
}
