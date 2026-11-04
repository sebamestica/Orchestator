import { join, posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULT_PORT,
  DEFAULT_QUOTA_REFRESH_MS,
  defaultDataDir,
  loadCoreConfig,
  LOOPBACK_HOST,
  resolveDataPaths,
} from '../../../src/core/config/index.ts';

const WIN_HOME = 'C:\\Users\\prueba';

describe('defaultDataDir', () => {
  it('Windows: %LOCALAPPDATA%\\orquestador', () => {
    expect(defaultDataDir({ platform: 'win32', env: { LOCALAPPDATA: 'D:\\Local' }, home: WIN_HOME })).toBe('D:\\Local\\orquestador');
  });

  it('Windows sin LOCALAPPDATA: <home>\\AppData\\Local\\orquestador', () => {
    expect(defaultDataDir({ platform: 'win32', env: {}, home: WIN_HOME })).toBe(win32.join(WIN_HOME, 'AppData', 'Local', 'orquestador'));
    expect(defaultDataDir({ platform: 'win32', env: { LOCALAPPDATA: '   ' }, home: WIN_HOME })).toBe('C:\\Users\\prueba\\AppData\\Local\\orquestador');
  });

  it('ORQ_DATA_DIR reemplaza la carpeta en cualquier plataforma', () => {
    expect(defaultDataDir({ platform: 'win32', env: { ORQ_DATA_DIR: 'E:\\datos', LOCALAPPDATA: 'D:\\Local' }, home: WIN_HOME })).toBe('E:\\datos');
    expect(defaultDataDir({ platform: 'linux', env: { ORQ_DATA_DIR: '/srv/orq' }, home: '/home/u' })).toBe('/srv/orq');
  });

  it('fuera de Windows: $XDG_DATA_HOME o ~/.local/share', () => {
    expect(defaultDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/data' }, home: '/home/u' })).toBe('/data/orquestador');
    expect(defaultDataDir({ platform: 'darwin', env: {}, home: '/home/u' })).toBe(posix.join('/home/u', '.local', 'share', 'orquestador'));
  });
});

describe('resolveDataPaths', () => {
  it('pone la base de datos y la bóveda dentro de la carpeta, con reemplazos', () => {
    expect(resolveDataPaths('base')).toEqual({ dataDir: 'base', dbPath: join('base', 'orquestador.db'), vaultPath: join('base', 'vault.json') });
    expect(resolveDataPaths('base', { dbPath: 'otra.db' })).toEqual({ dataDir: 'base', dbPath: 'otra.db', vaultPath: join('base', 'vault.json') });
    expect(resolveDataPaths('base', { vaultPath: 'v.json' }).vaultPath).toBe('v.json');
  });
});

describe('loadCoreConfig', () => {
  const base = { platform: 'win32' as const, home: WIN_HOME };

  it('valores por defecto seguros', () => {
    const c = loadCoreConfig({ ...base, env: { LOCALAPPDATA: 'D:\\Local' } });
    expect(c.port).toBe(DEFAULT_PORT);
    expect(c.port).toBe(47811);
    expect(c.host).toBe(LOOPBACK_HOST);
    expect(c.host).toBe('127.0.0.1');
    expect(c.allowedOrigins).toEqual([]);
    expect(c.quotaRefreshMs).toBe(DEFAULT_QUOTA_REFRESH_MS);
    expect(c.powershellPath).toBe('powershell.exe');
    expect(c.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(c.dataDir).toBe('D:\\Local\\orquestador');
    expect(c.dbPath).toBe(join('D:\\Local\\orquestador', 'orquestador.db'));
    expect(c.vaultPath).toBe(join('D:\\Local\\orquestador', 'vault.json'));
  });

  it('lee y valida las variables ORQ_*', () => {
    const c = loadCoreConfig({
      ...base,
      env: {
        ORQ_DATA_DIR: 'E:\\orq',
        ORQ_DB_PATH: 'E:\\otra\\db.sqlite',
        ORQ_VAULT_PATH: 'E:\\otra\\vault.json',
        ORQ_PORT: ' 50000 ',
        ORQ_QUOTA_REFRESH_MS: '60000',
        ORQ_TIMEZONE: 'America/Santiago',
        ORQ_ALLOWED_ORIGINS: 'http://localhost:5173, app://orquestador,,',
        ORQ_POWERSHELL: 'pwsh.exe',
      },
    });
    expect(c).toMatchObject({
      dataDir: 'E:\\orq',
      dbPath: 'E:\\otra\\db.sqlite',
      vaultPath: 'E:\\otra\\vault.json',
      port: 50000,
      quotaRefreshMs: 60000,
      timeZone: 'America/Santiago',
      allowedOrigins: ['http://localhost:5173', 'app://orquestador'],
      powershellPath: 'pwsh.exe',
      host: '127.0.0.1',
    });
  });

  it('las variables vacías se ignoran y los reemplazos ganan al entorno', () => {
    const c = loadCoreConfig({
      ...base,
      env: { ORQ_PORT: '', ORQ_DB_PATH: 'E:\\env.db', LOCALAPPDATA: 'D:\\Local' },
      overrides: { port: 0, dbPath: 'F:\\override.db', allowedOrigins: ['app://x'] },
    });
    expect(c.port).toBe(0);
    expect(c.dbPath).toBe('F:\\override.db');
    expect(c.allowedOrigins).toEqual(['app://x']);
    expect(loadCoreConfig({ ...base, env: { ORQ_PORT: '' } }).port).toBe(DEFAULT_PORT);
  });

  it('el host es siempre 127.0.0.1', () => {
    const c = loadCoreConfig({ ...base, env: { HOST: '0.0.0.0', ORQ_HOST: '0.0.0.0' } });
    expect(c.host).toBe('127.0.0.1');
  });

  it('ORQ_PORT inválido → ConfigError que nombra la variable sin repetir el valor', () => {
    for (const port of ['abc', '70000', '-1', '1.5']) {
      let err: unknown;
      try {
        loadCoreConfig({ ...base, env: { ORQ_PORT: port } });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain('ORQ_PORT');
      expect((err as Error).message).not.toContain(port);
    }
  });

  it('zona horaria inválida → ConfigError', () => {
    expect(() => loadCoreConfig({ ...base, env: { ORQ_TIMEZONE: 'Marte/Olympus' } })).toThrow(ConfigError);
    expect(() => loadCoreConfig({ ...base, env: {}, overrides: { timeZone: 'No/Existe' } })).toThrow(/Zona horaria inválida/);
  });

  it('ORQ_QUOTA_REFRESH_MS negativo → ConfigError', () => {
    expect(() => loadCoreConfig({ ...base, env: { ORQ_QUOTA_REFRESH_MS: '-5' } })).toThrow(ConfigError);
  });
});
