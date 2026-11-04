/**
 * Genera docs/api/openapi.json y docs/api/orquestador.postman_collection.json desde los contratos Zod.
 *
 *   scripts/win.sh "node docs/api/generate.ts"           escribe los dos archivos
 *   scripts/win.sh "node docs/api/generate.ts --check"   falla si no están al día (no escribe)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertNoSecrets, buildOpenApi, buildPostman } from './build.ts';

export const OPENAPI_FILE = 'openapi.json';
export const POSTMAN_FILE = 'orquestador.postman_collection.json';

export interface RenderedFile {
  name: string;
  path: string;
  content: string;
}

/** Contenido exacto de los dos archivos (JSON con 2 espacios y salto de línea final). */
export function renderFiles(): RenderedFile[] {
  const files = [
    { name: OPENAPI_FILE, doc: buildOpenApi() },
    { name: POSTMAN_FILE, doc: buildPostman() },
  ];
  return files.map(({ name, doc }) => {
    const content = `${JSON.stringify(doc, null, 2)}\n`;
    assertNoSecrets(content, name);
    return { name, path: fileURLToPath(new URL(name, import.meta.url)), content };
  });
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  } catch {
    return '';
  }
}

export function main(args: readonly string[]): number {
  const checkOnly = args.includes('--check');
  let stale = 0;
  for (const file of renderFiles()) {
    const current = readOrEmpty(file.path);
    const changed = current !== file.content;
    if (checkOnly) {
      if (changed) {
        stale++;
        process.stderr.write(`desactualizado: docs/api/${file.name}\n`);
      }
      continue;
    }
    if (changed) writeFileSync(file.path, file.content, 'utf8');
    process.stdout.write(`${changed ? 'escrito' : 'sin cambios'}: docs/api/${file.name} (${Buffer.byteLength(file.content)} bytes)\n`);
  }
  if (checkOnly) {
    process.stdout.write(stale ? `${stale} archivo(s) desactualizado(s): ejecuta node docs/api/generate.ts\n` : 'openapi.json y la colección de Postman están al día\n');
  }
  return stale ? 1 : 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
