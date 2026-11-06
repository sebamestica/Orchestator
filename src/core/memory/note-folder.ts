/**
 * Notas `.md` de una carpeta de la bóveda (`Sesiones/`, `Decisiones/`) ya parseadas, con caché por nombre, mtime y
 * tamaño: cada lectura hace un `readdir` y un `stat` por nota, y solo abre y parsea las nuevas o editadas. Así
 * `buildContext` no vuelve a abrir en cada encargo las notas de todos los proyectos.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseNote, type Frontmatter } from './frontmatter.ts';
import { assertRealInside, resolveInside } from './safe-fs.ts';

export interface FolderNote {
  /** Nombre del archivo, con `.md`. */
  name: string;
  data: Frontmatter;
  body: string;
  text: string;
}

interface Entry {
  mtimeMs: number;
  size: number;
  /** null: ilegible o con YAML que no entendemos (no rompe el contexto). */
  note: FolderNote | null;
}

/** Lecturas a la vez: pocas, para no saturar el disco ni el antivirus. */
const PARALLEL = 8;

async function mapLimited<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  return out;
}

export class NoteFolder {
  private readonly cache = new Map<string, Entry>();
  private readonly vaultPath: string;
  /** Ruta relativa a la bóveda, con `/`. */
  readonly folder: string;

  constructor(vaultPath: string, folder: string) {
    this.vaultPath = vaultPath;
    this.folder = folder;
  }

  /**
   * Notas de la carpeta en orden de nombre. La carpeta se comprueba una vez (ruta real dentro de la bóveda) y solo
   * se leen archivos normales: un enlace o junction dentro de ella se ignora. Carpeta inexistente: `[]`.
   */
  async list(): Promise<FolderNote[]> {
    const dir = resolveInside(this.vaultPath, this.folder);
    let names: string[];
    try {
      await assertRealInside(this.vaultPath, dir);
      names = (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name)
        .sort();
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return [];
      throw err;
    }
    const present = new Set(names);
    for (const name of this.cache.keys()) if (!present.has(name)) this.cache.delete(name);
    const notes = await mapLimited(names, (name) => this.load(dir, name));
    return notes.filter((n): n is FolderNote => n !== null);
  }

  private async load(dir: string, name: string): Promise<FolderNote | null> {
    const file = path.join(dir, name);
    let info: { mtimeMs: number; size: number };
    try {
      info = await stat(file);
    } catch {
      this.cache.delete(name);
      return null;
    }
    const cached = this.cache.get(name);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.note;
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      // Desapareció o está retenida: no se guarda en caché, se reintenta en la próxima lectura.
      this.cache.delete(name);
      return null;
    }
    let note: FolderNote | null = null;
    try {
      const { data, body } = parseNote(text, { lenient: true, skipBadLines: true });
      note = { name, data, body, text };
    } catch {
      // Nota editada a mano con YAML que no entendemos: no rompe el contexto.
    }
    this.cache.set(name, { mtimeMs: info.mtimeMs, size: info.size, note });
    return note;
  }
}
