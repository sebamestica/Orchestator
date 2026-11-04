import { homedir } from 'node:os';
import { join, win32, posix } from 'node:path';
import { z } from 'zod';

/** Puerto por defecto del servidor local (fijo para que Postman y Electron lo encuentren). */
export const DEFAULT_PORT = 47811;
/** Única interfaz en la que escucha el servidor. */
export const LOOPBACK_HOST = '127.0.0.1';
/** Lectura periódica de cupos (PLAN §4.3: cada 5 min). */
export const DEFAULT_QUOTA_REFRESH_MS = 5 * 60_000;

export interface DataPaths {
  dataDir: string;
  dbPath: string;
  vaultPath: string;
}

export interface PathEnv {
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
}

/**
 * Carpeta de datos del núcleo: `%LOCALAPPDATA%\orquestador` en Windows; `ORQ_DATA_DIR` la reemplaza.
 * Fuera de Windows (solo desarrollo) usa `$XDG_DATA_HOME/orquestador` o `~/.local/share/orquestador`.
 */
export function defaultDataDir(opts: PathEnv = {}): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const override = env.ORQ_DATA_DIR?.trim();
  if (override) return override;
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA?.trim() || win32.join(home, 'AppData', 'Local');
    return win32.join(local, 'orquestador');
  }
  const xdg = env.XDG_DATA_HOME?.trim() || posix.join(home, '.local', 'share');
  return posix.join(xdg, 'orquestador');
}

/** Rutas de SQLite y de la bóveda dentro de la carpeta de datos (cada una se puede reemplazar). */
export function resolveDataPaths(dataDir: string, overrides: Partial<Omit<DataPaths, 'dataDir'>> = {}): DataPaths {
  return {
    dataDir,
    dbPath: overrides.dbPath ?? join(dataDir, 'orquestador.db'),
    vaultPath: overrides.vaultPath ?? join(dataDir, 'vault.json'),
  };
}

const portSchema = z.coerce.number().int().min(0).max(65535);
const csv = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

/** Variables de entorno que entiende el núcleo (todas opcionales). Se validan con Zod. */
const envSchema = z.object({
  ORQ_DATA_DIR: z.string().min(1).optional(),
  ORQ_DB_PATH: z.string().min(1).optional(),
  ORQ_VAULT_PATH: z.string().min(1).optional(),
  ORQ_PORT: portSchema.optional(),
  ORQ_QUOTA_REFRESH_MS: z.coerce.number().int().min(0).optional(),
  ORQ_TIMEZONE: z.string().min(1).optional(),
  ORQ_ALLOWED_ORIGINS: csv.optional(),
  ORQ_POWERSHELL: z.string().min(1).optional(),
});

export interface CoreConfig extends DataPaths {
  port: number;
  host: typeof LOOPBACK_HOST;
  quotaRefreshMs: number;
  /** Zona horaria para agrupar el uso por día. */
  timeZone: string;
  /** Orígenes (encabezado Origin) aceptados; por defecto ninguno: sin Origin o rechazo. */
  allowedOrigins: string[];
  powershellPath: string;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Lee la configuración del entorno, con valores por defecto seguros. */
export function loadCoreConfig(opts: PathEnv & { overrides?: Partial<CoreConfig> } = {}): CoreConfig {
  const rawEnv = opts.env ?? process.env;
  const picked = Object.fromEntries(
    Object.keys(envSchema.shape)
      .map((k) => [k, rawEnv[k]?.trim()])
      .filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = envSchema.safeParse(picked);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new ConfigError(`Variables de entorno inválidas: ${fields}`);
  }
  const env = parsed.data;
  const o = opts.overrides ?? {};
  const dataDir = o.dataDir ?? defaultDataDir({ ...opts, env: rawEnv });
  const dbPath = o.dbPath ?? env.ORQ_DB_PATH;
  const vaultPath = o.vaultPath ?? env.ORQ_VAULT_PATH;
  const merged: CoreConfig = {
    ...resolveDataPaths(dataDir, { ...(dbPath ? { dbPath } : {}), ...(vaultPath ? { vaultPath } : {}) }),
    port: o.port ?? env.ORQ_PORT ?? DEFAULT_PORT,
    host: LOOPBACK_HOST,
    quotaRefreshMs: o.quotaRefreshMs ?? env.ORQ_QUOTA_REFRESH_MS ?? DEFAULT_QUOTA_REFRESH_MS,
    timeZone: o.timeZone ?? env.ORQ_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    allowedOrigins: o.allowedOrigins ?? env.ORQ_ALLOWED_ORIGINS ?? [],
    powershellPath: o.powershellPath ?? env.ORQ_POWERSHELL ?? 'powershell.exe',
  };
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: merged.timeZone });
  } catch {
    throw new ConfigError(`Zona horaria inválida: ${merged.timeZone}`);
  }
  return merged;
}
