import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const core = process.env.ORQ_CORE_URL ?? 'http://127.0.0.1:47811';

// La interfaz se compila a dist/ui y la sirve el núcleo en 127.0.0.1 (escritorio y web usan la misma).
export default defineConfig({
  root,
  base: './',
  cacheDir: fileURLToPath(new URL('../../.orq/vite-cache-ui', import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('../../dist/ui', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    // En desarrollo, la API del núcleo pasa por el mismo origen.
    proxy: { '/__core': { target: core, changeOrigin: true, rewrite: (p) => p.replace(/^\/__core/, ''), ws: true } },
  },
});
