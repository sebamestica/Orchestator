// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { fileGlyphOf } from '../../../src/ui/features/composer/file-glyph.ts';
import { growTextarea, hasFiles, isEditable, namePasted, pastedFiles } from '../../../src/ui/features/composer/files.ts';

const transfer = (types: string[], files: File[] = []) => ({ types, files }) as unknown as DataTransfer;

describe('utilidades del composer', () => {
  it('hasFiles solo reconoce arrastres con archivos', () => {
    expect(hasFiles(transfer(['Files']))).toBe(true);
    expect(hasFiles(transfer(['text/plain', 'text/uri-list']))).toBe(false);
    expect(hasFiles(null)).toBe(false);
    expect(hasFiles(undefined)).toBe(false);
  });

  it('pastedFiles toma los archivos salvo que el portapapeles traiga texto', () => {
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    expect(pastedFiles(transfer(['Files'], [png]))).toEqual([png]);
    expect(pastedFiles(transfer(['text/html', 'Files'], [png]))).toEqual([png]);
    expect(pastedFiles(transfer(['text/plain', 'Files'], [png]))).toEqual([]);
    expect(pastedFiles(null)).toEqual([]);
  });

  it('isEditable reconoce los campos de texto', () => {
    expect(isEditable(document.createElement('div'))).toBe(false);
    expect(isEditable(document.createElement('input'))).toBe(true);
    expect(isEditable(document.createElement('textarea'))).toBe(true);
    expect(isEditable(document.createElement('button'))).toBe(false);
    expect(isEditable(null)).toBe(false);
  });

  it('namePasted renombra las capturas genéricas y deja los nombres propios', () => {
    const generic = new File(['x'], 'image.PNG', { type: 'image/png', lastModified: 5 });
    const renamed = namePasted(generic, 3);
    expect(renamed.name).toBe('imagen-pegada-3.png');
    expect(renamed.type).toBe('image/png');
    expect(renamed.size).toBe(1);
    const own = new File(['x'], 'plano.png', { type: 'image/png' });
    expect(namePasted(own, 1)).toBe(own);
  });

  it('growTextarea crece con el contenido hasta el tope', () => {
    const area = document.createElement('textarea');
    Object.defineProperty(area, 'scrollHeight', { value: 500, configurable: true });
    growTextarea(area, 192);
    expect(area.style.height).toBe('192px');
    Object.defineProperty(area, 'scrollHeight', { value: 60, configurable: true });
    growTextarea(area, 192);
    expect(area.style.height).toBe('60px');
    expect(() => growTextarea(null, 192)).not.toThrow();
  });

  it('fileGlyphOf elige el icono por extensión', () => {
    expect(fileGlyphOf('notas.md').className).toBe('text-muted');
    expect(fileGlyphOf('datos.xlsx').className).toContain('emerald');
    expect(fileGlyphOf('main.ts').className).toContain('indigo');
    expect(fileGlyphOf('foto.JPG').className).toContain('violet');
    expect(fileGlyphOf('sin-extension').className).toBe('text-muted');
  });
});
