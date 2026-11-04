import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FrontmatterError, parseNote, serializeFrontmatter, stringifyNote, updateNote, type Frontmatter } from '../../../src/core/memory/frontmatter.ts';

/** Copias de SKILL.md reales (C:\dev\agent-hub\skills y ~/.codex/skills, 2026-11-01). */
const datos = path.resolve(import.meta.dirname, 'datos');

describe('frontmatter: serializador', () => {
  it('relee exactamente lo que escribe, incluidos textos que YAML confundiría con otros tipos', () => {
    const data: Frontmatter = {
      tipo: 'sesion',
      fecha: '2026-11-01',
      at: '2026-11-01T21:51:00Z',
      parece_booleano: 'yes',
      parece_nulo: 'null',
      parece_numero: '0123',
      exponente: '1e3',
      con_dos_puntos: 'clave: valor',
      con_almohadilla: 'texto # no es comentario',
      guion_inicial: '- no es lista',
      comillas: 'dice "hola" y \'chao\'',
      multilinea: 'línea 1\nlínea 2',
      unicode: 'ñandú · ☃ · 😀',
      separador_unicode: 'a\u2028b\u0085c',
      vacio: '',
      numero: 22572,
      decimal: 0.103,
      negativo: -5,
      verdad: true,
      falso: false,
      nada: null,
      lista: ['src/core/memory/**', 'con espacio', 'yes', 3, null],
      lista_vacia: [],
      mapa: { a: 1, b: 'dos', c: true },
    };
    const text = stringifyNote(data, '# Cuerpo');
    expect(text.startsWith('---\n')).toBe(true);
    const parsed = parseNote(text);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.data).toEqual(data);
    expect(parsed.body).toBe('# Cuerpo\n');
  });

  it('deja sin comillas las fechas y los identificadores (Obsidian los muestra como fecha y texto)', () => {
    const yaml = serializeFrontmatter({ fecha: '2026-11-01', proyecto: 'orquestador', agente: 'claude-4', tags: ['orquestador/sesion'] });
    expect(yaml).toBe('fecha: 2026-11-01\nproyecto: orquestador\nagente: claude-4\ntags:\n  - orquestador/sesion');
  });

  it('rechaza claves peligrosas o inválidas y números no finitos', () => {
    expect(() => serializeFrontmatter({ __proto__x: 1, ['__proto__']: 1 } as Frontmatter)).toThrow(FrontmatterError);
    expect(() => serializeFrontmatter({ 'con espacio': 1 })).toThrow(FrontmatterError);
    expect(() => serializeFrontmatter({ n: Number.NaN })).toThrow(FrontmatterError);
  });
});

describe('frontmatter: lector', () => {
  it('lee listas en bloque y en línea, bloques | y >, comentarios y CRLF', () => {
    const text = [
      '---',
      'name: mi-skill # comentario',
      'tags: [a, "b, c", \'d\']',
      'aliases:',
      '- uno',
      '- dos',
      'literal: |',
      '  línea 1',
      '  línea 2',
      'plegado: >-',
      '  una',
      '  frase',
      'description: texto largo',
      '  que sigue en otra línea',
      '---',
      'cuerpo',
    ].join('\r\n');
    const { data, body } = parseNote(text);
    expect(data).toEqual({
      name: 'mi-skill',
      tags: ['a', 'b, c', 'd'],
      aliases: ['uno', 'dos'],
      literal: 'línea 1\nlínea 2\n',
      plegado: 'una frase',
      description: 'texto largo que sigue en otra línea',
    });
    expect(body).toBe('cuerpo');
  });

  it('sin bloque inicial devuelve el texto como cuerpo', () => {
    expect(parseNote('# Hola\n')).toEqual({ data: {}, body: '# Hola\n', hasFrontmatter: false, unsupported: [] });
  });

  it('rechaza anclas, alias, etiquetas, __proto__, claves repetidas y bloques sin cierre', () => {
    const bad = ['a: &x 1', 'a: *x', 'a: !!python/object x', '__proto__: 1', 'a: 1\na: 2', 'a:\n  b:\n    c: 1'];
    for (const yaml of bad) expect(() => parseNote(`---\n${yaml}\n---\n`), yaml).toThrow(FrontmatterError);
    expect(() => parseNote('---\na: 1\n')).toThrow(FrontmatterError);
  });

  it('el modo tolerante guarda como texto lo no soportado y descarta __proto__', () => {
    const text = '---\nname: x\nmetadata: {"a": {"b": 1}}\n__proto__: 1\n---\n';
    const { data, unsupported } = parseNote(text, { lenient: true });
    expect(data).toEqual({ name: 'x', metadata: '{"a": {"b": 1}}' });
    expect(unsupported).toEqual(['metadata', '__proto__']);
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
  });

  it('lee SKILL.md reales de este PC (agent-hub y Codex)', () => {
    const cases = [['skill-flota-orquestador.md', 'flota-orquestador'], ['skill-navegador-chrome.md', 'navegador-chrome'], ['skill-codex-metadata.md', 'music']] as const;
    for (const [file, name] of cases) {
      const { data } = parseNote(readFileSync(path.join(datos, file), 'utf8'), { lenient: true });
      expect(data.name).toBe(name);
      expect(typeof data.description).toBe('string');
    }
    const flota = parseNote(readFileSync(path.join(datos, 'skill-flota-orquestador.md'), 'utf8'));
    expect(String(flota.data.description)).toContain('C:\\dev');
    // `metadata: {…}` (JSON en línea) no está en el subconjunto: estricto lanza, tolerante lo guarda como texto.
    const codex = readFileSync(path.join(datos, 'skill-codex-metadata.md'), 'utf8');
    expect(() => parseNote(codex)).toThrow(FrontmatterError);
    expect(parseNote(codex, { lenient: true }).unsupported).toEqual(['metadata']);
  });
});

describe('frontmatter: updateNote y skipBadLines (revisión agy, hallazgo 3)', () => {
  it('actualiza solo las claves pedidas y deja el resto del YAML tal cual', () => {
    const text = '---\ntipo: proyecto\nsesiones: 2\ntags:\n  - a\n  - b\nraro:valor\n\tcon-tab: 1\nsesiones: 99\n---\n# Cuerpo\n';
    const out = updateNote(text, { sesiones: 3, tags: ['x'], nueva: 'sí' }, (b) => `${b}más\n`);
    expect(out).toBe('---\ntipo: proyecto\nsesiones: 3\ntags:\n  - x\nraro:valor\n\tcon-tab: 1\nsesiones: 99\nnueva: "sí"\n---\n# Cuerpo\nmás\n');
    expect(updateNote('# sin frontmatter\n', { a: 1 })).toBe('---\na: 1\n---\n# sin frontmatter\n');
    expect(updateNote('---\nsin cierre\n', { a: 1 })).toBe('---\na: 1\n---\n---\nsin cierre\n');
  });

  it('skipBadLines descarta líneas raras solo si se pide; lenient solo sigue lanzando con ellas', () => {
    const text = '---\nname: x\nraro:valor\n\tcon-tab: 1\n---\n';
    expect(() => parseNote(text, { lenient: true })).toThrow(FrontmatterError);
    expect(parseNote(text, { lenient: true, skipBadLines: true })).toMatchObject({ data: { name: 'x' }, unsupported: ['línea 2', 'línea 3'] });
    expect(() => parseNote('---\nname: x\n', { lenient: true, skipBadLines: true })).toThrow(FrontmatterError);
  });
});
