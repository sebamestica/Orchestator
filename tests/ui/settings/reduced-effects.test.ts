import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// «Menos efectos» marca <html data-effects="reduced">. jsdom no resuelve la cascada de Tailwind, así que se
// comprueba el CSS y las clases en los fuentes.
const UI = fileURLToPath(new URL('../../../src/ui/', import.meta.url));
const css = readFileSync(join(UI, 'styles/index.css'), 'utf8');

/** Reglas de primer nivel o dentro de una @media: selector → cuerpo. */
function rules(source: string): { selectors: string[]; body: string }[] {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: (m[1] ?? '').split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
    body: m[2] ?? '',
  }));
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(path);
    return e.name.endsWith('.tsx') ? [path] : [];
  });
}

describe('ajuste «Menos efectos»', () => {
  it('detiene las animaciones con data-effects="reduced", no solo con prefers-reduced-motion', () => {
    const stopped = rules(css)
      .filter((r) => /animation\s*:\s*none/.test(r.body))
      .flatMap((r) => r.selectors);
    for (const cls of ['.animate-enter', '.drop-overlay', '.agent-activity', '.agent-change', '.animate-spin', '.animate-pulse']) {
      expect(stopped, cls).toContain(`[data-effects="reduced"] ${cls}`);
    }
  });

  it('el desenfoque pasa siempre por --glass-backdrop: ningún componente usa backdrop-blur-*', () => {
    const offenders = tsxFiles(UI).filter((f) => /\bbackdrop-blur-/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.slice(UI.length))).toEqual([]);
  });

  it('la barra de actividad del panel usa la clase que apaga la regla', () => {
    const row = readFileSync(join(UI, 'features/agents-panel/ActivityRowView.tsx'), 'utf8');
    expect(row).toMatch(/className="agent-activity /);
  });
});
