import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildIco, encodePng, ICON_SIZES, renderIcon } from './icon.ts';

// Uso (Node 24 de Windows): node apps/desktop/tools/make-icon.ts [vista-previa.png]
// Escribe apps/desktop/assets/icon.ico; con un argumento, también un PNG de 256 para mirarlo.
const ico = buildIco();
const target = fileURLToPath(new URL('../assets/icon.ico', import.meta.url));
writeFileSync(target, ico);
process.stdout.write(`${target}: ${ico.length} bytes, tamaños ${ICON_SIZES.join(', ')}\n`);
const preview = process.argv[2];
if (preview) {
  writeFileSync(preview, encodePng(renderIcon(256), 256, 256));
  process.stdout.write(`vista previa: ${preview}\n`);
}
