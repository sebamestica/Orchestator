import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // Caché dentro del checkout: en worktrees node_modules es un enlace a la copia principal
  // y los agentes con sandbox (Codex) no pueden escribir fuera de su carpeta.
  cacheDir: '.orq/vite-cache',
  test: {
    // Las pruebas de la interfaz (tests/ui/**/*.test.tsx) declaran `// @vitest-environment happy-dom`.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Las pruebas live (CLIs y APIs reales) ni se cargan sin ORQ_LIVE=1: su skipIf llega después de importar
    // todo su grafo. Dentro de ellas siguen los skipIf por clave y plataforma.
    exclude: [...configDefaults.exclude, ...(process.env.ORQ_LIVE === '1' ? [] : ['tests/live/**'])],
    environment: 'node',
    // Media CPU por suite: la flota corre varios gates y checks a la vez, y sin tope cada uno abre
    // availableParallelism() - 1 forks. VITEST_MAX_WORKERS, si está puesta, sigue mandando.
    maxWorkers: '50%',
    // 60 s: con la flota corriendo pruebas en paralelo en 4 núcleos, pruebas de 1 s llegaron a tardar 20 s.
    // Una prueba colgada de verdad sigue fallando.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
