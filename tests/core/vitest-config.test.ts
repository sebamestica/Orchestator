import { afterEach, describe, expect, it, vi } from 'vitest';
import { configDefaults } from 'vitest/config';

// Las pruebas live (CLIs y APIs reales) deben quedar fuera de la recolección sin ORQ_LIVE=1:
// un skipIf dentro del archivo llega tarde, después de importar todo su grafo.
async function loadExclude(): Promise<string[]> {
  vi.resetModules();
  const { default: config } = await import('../../vitest.config.ts');
  return config.test?.exclude ?? [];
}

afterEach(() => vi.unstubAllEnvs());

describe('vitest.config.ts: las pruebas live no se cargan sin ORQ_LIVE=1', () => {
  it('sin ORQ_LIVE=1 excluye tests/live/** y conserva las exclusiones por defecto', async () => {
    vi.stubEnv('ORQ_LIVE', '');
    const exclude = await loadExclude();
    expect(exclude).toContain('tests/live/**');
    expect(exclude).toEqual(expect.arrayContaining(configDefaults.exclude));
  });

  it('con ORQ_LIVE=1 no excluye tests/live/**', async () => {
    vi.stubEnv('ORQ_LIVE', '1');
    const exclude = await loadExclude();
    expect(exclude).not.toContain('tests/live/**');
  });
});
