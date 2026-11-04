import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build, defineConfig, type Plugin, type UserConfig } from 'vite';

// Proceso principal y preload de Electron, en CommonJS (el preload con `sandbox: true` no admite ESM, y el
// main en CJS corre su código antes del evento `ready`, que hace falta para `app.setPath`).
// Son dos compilaciones: así el preload queda en un único archivo sin trozos compartidos que `require`.
const root = fileURLToPath(new URL('../..', import.meta.url));
const outDir = fileURLToPath(new URL('./out', import.meta.url));
const external = ['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

function config(entry: string, name: string, first: boolean, plugins: Plugin[] = []): UserConfig {
  return {
    root,
    publicDir: false,
    logLevel: 'warn',
    cacheDir: fileURLToPath(new URL('../../.orq/vite-cache-desktop', import.meta.url)),
    plugins,
    build: {
      outDir,
      emptyOutDir: first,
      target: 'node22',
      minify: false,
      sourcemap: false,
      reportCompressedSize: false,
      copyPublicDir: false,
      lib: { entry: fileURLToPath(new URL(entry, import.meta.url)), formats: ['cjs'], fileName: () => `${name}.js` },
      rolldownOptions: { external },
    },
  };
}

/** `out/package.json`: nombre visible de la app y CommonJS para los `.js` (la raíz del repo es ESM). */
const appManifest: Plugin = {
  name: 'orq-desktop-manifest',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'package.json',
      source: `${JSON.stringify({ name: 'berland', productName: 'Berland', version: '0.1.0', private: true, type: 'commonjs', main: 'main.js' }, null, 2)}\n`,
    });
  },
};

/** Tras el main, compila el preload en su propio paquete. */
const preloadBuild: Plugin = {
  name: 'orq-desktop-preload',
  apply: 'build',
  async closeBundle() {
    await build({ ...config('./src/preload.ts', 'preload', false), configFile: false });
  },
};

export default defineConfig(config('./src/main.ts', 'main', true, [appManifest, preloadBuild]));
