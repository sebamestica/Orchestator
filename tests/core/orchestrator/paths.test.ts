import { describe, expect, it } from 'vitest';
import { findOverlaps, normalizeOwnedPath, ownedPathProblem, pathsOverlap } from '../../../src/core/orchestrator/paths.ts';

/** Comprueba el solape en ambos sentidos: la relación debe ser simétrica. */
function overlap(a: string, b: string): boolean {
  const ab = pathsOverlap(a, b);
  expect(pathsOverlap(b, a), `simetría de «${a}» y «${b}»`).toBe(ab);
  return ab;
}

describe('normalizeOwnedPath', () => {
  it.each([
    ['src/core/a.ts', 'src/core/a.ts'],
    ['src\\core\\a.ts', 'src/core/a.ts'],
    ['.\\src\\core\\', 'src/core'],
    ['./src/a/', 'src/a'],
    ['././src//a///', 'src/a'],
    ['src\\\\a', 'src/a'],
    ['  src/a  ', 'src/a'],
    ['.', ''],
    ['./', ''],
    ['src/**', 'src/**'],
    // Normaliza barras, no mayúsculas: la comparación es la que ignora mayúsculas.
    ['SRC/Core/A.ts', 'SRC/Core/A.ts'],
  ])('«%s» → «%s»', (input, expected) => {
    expect(normalizeOwnedPath(input)).toBe(expected);
  });
});

describe('ownedPathProblem', () => {
  it.each(['src/a.ts', 'src/**', 'src\\core\\x', './src', '.', 'src/..foo/x', 'src/a..b.ts', '**/*.test.ts', 'src/{a,b}/**'])(
    'acepta «%s»',
    (path) => {
      expect(ownedPathProblem(path)).toBeUndefined();
    },
  );

  it.each(['', '   ', '\t'])('rechaza la ruta vacía %j', (path) => {
    expect(ownedPathProblem(path)).toBe('ruta vacía');
  });

  it.each(['!src/a', '  !src/**'])('rechaza la negación «%s»', (path) => {
    expect(ownedPathProblem(path)).toContain('no se admiten negaciones');
  });

  it.each(['C:\\dev\\x', 'c:/dev/x', 'C:foo', '/etc/passwd', '\\x', '\\\\servidor\\recurso'])('rechaza la ruta absoluta «%s»', (path) => {
    expect(ownedPathProblem(path)).toContain('debe ser relativa a la raíz del repo');
  });

  it.each(['..', '../x', 'src/../../x', 'src\\..\\x', './../x', 'src/..'])('rechaza «%s» porque sale del repo', (path) => {
    expect(ownedPathProblem(path)).toContain('no puede salir del repo');
  });

  it('cita la ruta original en el mensaje', () => {
    expect(ownedPathProblem('C:\\dev\\x')).toBe('«C:\\dev\\x»: debe ser relativa a la raíz del repo');
  });
});

describe('pathsOverlap', () => {
  describe('rutas sin comodines (archivo o carpeta con todo su contenido)', () => {
    it.each([
      ['src/a.ts', 'src/a.ts'],
      ['src/a', 'src/a/b.ts'],
      ['src/a/', 'src/a/b/c.ts'],
      ['src/a', 'src/a/**'],
      ['./src/a', 'src/a/b'],
      ['.', 'src/a.ts'],
      ['./', 'tests/x.test.ts'],
    ])('«%s» y «%s» se solapan', (a, b) => {
      expect(overlap(a, b)).toBe(true);
    });

    it.each([
      ['src/a', 'src/b'],
      ['src/a', 'src/ab'],
      ['src/ab', 'src/a'],
      ['src/a.ts', 'src/a.ts.bak'],
      ['src/core', 'src/core-x/y.ts'],
      ['src/a/b.ts', 'src/a/c.ts'],
      ['src', 'tests'],
      ['src/a/b', 'src/b/a'],
    ])('«%s» y «%s» no se solapan (el prefijo cuenta por segmentos)', (a, b) => {
      expect(overlap(a, b)).toBe(false);
    });
  });

  describe('** (cero o más segmentos)', () => {
    it.each([
      ['**', 'x/y/z.ts'],
      ['src/**', 'src'],
      ['src/**', 'src/a/b/c.ts'],
      ['src/**/x.ts', 'src/x.ts'],
      ['src/**/x.ts', 'src/a/b/c/x.ts'],
      ['**/*.test.ts', 'tests/core/a.test.ts'],
      ['**/a/**', '**/b/**'],
      ['src/**/*.ts', 'src/core/**'],
      ['src/**/z', 'src/a/**'],
    ])('«%s» y «%s» se solapan', (a, b) => {
      expect(overlap(a, b)).toBe(true);
    });

    it.each([
      ['src/**', 'tests/**'],
      ['src/**', 'lib/a.ts'],
      ['src/a/**', 'src/b'],
      ['src/**/x.ts', 'tests/x.ts'],
      ['src/core/**', 'src/ui/**'],
    ])('«%s» y «%s» no se solapan', (a, b) => {
      expect(overlap(a, b)).toBe(false);
    });
  });

  describe('* y ? (dentro de un segmento)', () => {
    it.each([
      ['src/*.ts', 'src/a.ts'],
      ['src/*', 'src/a/b/c.ts'],
      ['src/a*', 'src/*b'],
      ['src/*', 'src/**'],
      ['src/*/x.ts', 'src/**'],
      ['src/?.ts', 'src/a.ts'],
      ['src/a*b', 'src/ab'],
      ['src/**.ts', 'src/x.ts'],
    ])('«%s» y «%s» se solapan', (a, b) => {
      expect(overlap(a, b)).toBe(true);
    });

    it.each([
      ['src/*.ts', 'src/a.js'],
      ['src/*.ts', 'src/*.md'],
      ['src/*.ts', 'src/sub/x.js'],
      ['src/core/*.ts', 'src/ui/*.ts'],
      ['src/?.ts', 'src/ab.ts'],
      ['src/a?', 'src/b?'],
      ['src/a*', 'src/b*'],
      ['src/*/x.ts', 'lib/a/x.ts'],
    ])('«%s» y «%s» no se solapan', (a, b) => {
      expect(overlap(a, b)).toBe(false);
    });
  });

  describe('{a,b}, [..] y llaves sin cerrar', () => {
    it.each([
      ['src/{a,b}/**', 'src/b/x.ts'],
      ['src/{a,{b,c}}.ts', 'src/c.ts'],
      ['{src,lib}/a.ts', 'lib/**'],
      ['src/{a,b}/{x,y}.ts', 'src/b/y.ts'],
      // Una clase cuenta como «un carácter cualquiera»: conservador.
      ['src/[ab].ts', 'src/c.ts'],
      ['src/[!a].ts', 'src/a.ts'],
      // Llave sin cerrar o sin coma: literal.
      ['src/{a,b.ts', 'src/{a,b.ts'],
    ])('«%s» y «%s» se solapan', (a, b) => {
      expect(overlap(a, b)).toBe(true);
    });

    it.each([
      ['src/{a,b}/**', 'src/c/x.ts'],
      ['src/{a,{b,c}}.ts', 'src/d.ts'],
      ['src/{a,b}/**', 'src/{c,d}/**'],
      ['src/[ab].ts', 'src/cd.ts'],
      ['src/{a,b.ts', 'src/a.ts'],
      ['src/{a}.ts', 'src/a.ts'],
    ])('«%s» y «%s» no se solapan', (a, b) => {
      expect(overlap(a, b)).toBe(false);
    });

    it('con más de 64 variantes recurre al prefijo fijo + ** (conservador, pero no sale del prefijo)', () => {
      const many = 'src/{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}.ts'; // 128 variantes
      expect(overlap(many, 'src/cualquiera.md')).toBe(true);
      expect(overlap(many, 'src/sub/x')).toBe(true);
      expect(overlap(many, 'lib/a.ts')).toBe(false);
      const few = 'src/{a,b}{c,d}{e,f}.ts'; // 8 variantes: se expanden de verdad
      expect(overlap(few, 'src/ace.ts')).toBe(true);
      expect(overlap(few, 'src/cualquiera.md')).toBe(false);
    });

    it('con llaves en el primer segmento y demasiadas variantes, posee todo el repo', () => {
      const many = '{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}/x.ts';
      expect(overlap(many, 'otra/cosa.md')).toBe(true);
    });
  });

  describe('Windows: mayúsculas y barras invertidas', () => {
    it.each([
      ['SRC/Core/A.TS', 'src/core/a.ts'],
      ['src\\core\\a.ts', 'src/core/a.ts'],
      ['src\\core\\**', 'src/core/x/y.ts'],
      ['Src\\Core', 'src/core/a.ts'],
      ['src/*.TS', 'src/a.ts'],
      ['src/{A,B}/**', 'src/b/x.ts'],
      ['.\\src\\a\\', 'SRC/A/B.TS'],
    ])('«%s» y «%s» se solapan', (a, b) => {
      expect(overlap(a, b)).toBe(true);
    });

    it.each([
      ['SRC\\Core\\A.TS', 'src/core/b.ts'],
      ['Src\\Core\\**', 'src/ui/x.ts'],
    ])('«%s» y «%s» no se solapan', (a, b) => {
      expect(overlap(a, b)).toBe(false);
    });
  });

  describe('consecuencias de la semántica conservadora (documentadas en paths.ts)', () => {
    // Una ruta literal puede ser una carpeta: `src/a.ts/x.test.ts` existiría bajo ambas.
    it('una ruta literal se solapa con un glob más profundo bajo su carpeta padre', () => {
      expect(overlap('src/a.ts', 'src/**/*.test.ts')).toBe(true);
      expect(overlap('src/a.ts', '**/*.md')).toBe(true);
    });

    // `src/a.ts/b.md` coincide con los dos patrones porque cada patrón posee lo que hay debajo.
    it('dos globs por extensión bajo ** se solapan', () => {
      expect(overlap('src/**/*.ts', 'src/**/*.md')).toBe(true);
    });

    it('al mismo nivel y sin ** las extensiones distintas sí se separan', () => {
      expect(overlap('src/core/*.ts', 'src/core/*.md')).toBe(false);
    });
  });

  // Fallos encontrados por c9 (falsos negativos, contrarios a «ante la duda, hay solape»), ya corregidos.
  describe('fallos encontrados en paths.ts (corregidos)', () => {
    // normalizeOwnedPath quitaba solo el `./` inicial; ahora descarta todo segmento `.`.
    it('«src/./a» se solapa con «src/a/x.ts» (segmento «.» interior)', () => {
      expect(ownedPathProblem('src/./a')).toBeUndefined();
      expect(pathsOverlap('src/./a', 'src/a/x.ts')).toBe(true);
    });

    it('«src/a/.» se solapa con «src/a/x.ts» (segmento «.» final)', () => {
      expect(ownedPathProblem('src/a/.')).toBeUndefined();
      expect(pathsOverlap('src/a/.', 'src/a/x.ts')).toBe(true);
    });

    // tokenize trataba `@( | )` como literales; ahora ownedPathProblem rechaza los extglobs y, si llegan igual a
    // pathsOverlap, cada grupo cuenta como `*`.
    it('el extglob «src/@(a|b)/**» se solapa con «src/a/x.ts» (o se rechaza como ruta inválida)', () => {
      const problem = ownedPathProblem('src/@(a|b)/**');
      if (problem === undefined) expect(pathsOverlap('src/@(a|b)/**', 'src/a/x.ts')).toBe(true);
    });

    it.each([
      ['src/@(a|b)/**', 'src/b/x.ts'],
      ['src/+(a)', 'src/aa/x.ts'],
      ['src/x/!(b).ts', 'src/x/c.ts'],
      ['src/*(a|b)', 'src/ab'],
      ['src/?(a).ts', 'src/a.ts'],
    ])('rechaza el extglob %s y lo trata como solape conservador con %s', (glob, path) => {
      expect(ownedPathProblem(glob)).toContain('extglob no soportado');
      expect(overlap(glob, path)).toBe(true);
      expect(overlap(glob, 'lib/a.ts')).toBe(false); // fuera de su prefijo fijo sigue sin solaparse
    });

    it('normaliza segmentos «.» en cualquier posición', () => {
      expect(normalizeOwnedPath('src/./a')).toBe('src/a');
      expect(normalizeOwnedPath('src/a/.')).toBe('src/a');
      expect(normalizeOwnedPath('./src/./a/./')).toBe('src/a');
    });
  });

  describe('contra un oráculo de fuerza bruta (todas las rutas de hasta 4 segmentos)', () => {
    // Vocabulario sin clases `[..]` (paths.ts las aproxima a propósito).
    const vocabulary = ['a', 'b', '*', '**', '?', 'a*', '*.ts', '{a,x}'];
    const names = ['a', 'b', 'x', 'a.ts'];

    const patterns = [...vocabulary, ...vocabulary.flatMap((s) => vocabulary.map((t) => `${s}/${t}`))];
    const universe: string[][] = [];
    const grow = (prefix: string[]): void => {
      if (prefix.length) universe.push(prefix);
      if (prefix.length < 4) for (const n of names) grow([...prefix, n]);
    };
    grow([]);

    const segmentRegex = (glob: string): RegExp => {
      let src = '';
      for (const ch of glob) {
        if (ch === '*') src += '.*';
        else if (ch === '?') src += '.';
        else if (ch === '{') src += '(?:';
        else if (ch === ',') src += '|';
        else if (ch === '}') src += ')';
        else src += ch.replace(/[.\\^$+()|[\]]/g, '\\$&');
      }
      return new RegExp(`^${src}$`, 'i');
    };
    /** Coincidencia ruta-contra-patrón clásica, independiente del algoritmo patrón-contra-patrón de paths.ts. */
    const matches = (path: readonly string[], pattern: readonly string[]): boolean => {
      const [head, ...rest] = pattern;
      if (head === undefined) return path.length === 0;
      if (head === '**') return matches(path, rest) || (path.length > 0 && matches(path.slice(1), pattern));
      const [first, ...tail] = path;
      return first !== undefined && segmentRegex(head).test(first) && matches(tail, rest);
    };
    /** Un patrón posee lo que coincide y todo lo que haya debajo. */
    const owns = (path: readonly string[], pattern: string): boolean => {
      const segs = pattern.split('/');
      for (let k = 0; k <= path.length; k++) if (matches(path.slice(0, k), segs)) return true;
      return false;
    };

    it(`coincide en los ${(patterns.length * (patterns.length + 1)) / 2} pares de patrones del vocabulario`, () => {
      const owned = new Map(patterns.map((p) => [p, new Set(universe.filter((path) => owns(path, p)).map((path) => path.join('/')))]));
      const mismatches: string[] = [];
      let disjoint = 0;
      for (let i = 0; i < patterns.length; i++) {
        for (let j = i; j < patterns.length; j++) {
          const a = patterns[i] ?? '';
          const b = patterns[j] ?? '';
          const left = owned.get(a) ?? new Set<string>();
          const right = owned.get(b) ?? new Set<string>();
          const witness = [...left].find((path) => right.has(path));
          const actual = pathsOverlap(a, b);
          if (!actual) disjoint++;
          if (actual !== (witness !== undefined)) mismatches.push(`«${a}» × «${b}»: paths.ts=${actual}, testigo=${witness ?? 'ninguno'}`);
        }
      }
      expect(mismatches).toEqual([]);
      // El oráculo no es trivial: hay muchos pares en cada lado.
      expect(disjoint).toBeGreaterThan(500);
      expect((patterns.length * (patterns.length + 1)) / 2 - disjoint).toBeGreaterThan(500);
    });
  });
});

describe('findOverlaps', () => {
  it('sin tareas o sin solapes devuelve []', () => {
    expect(findOverlaps([])).toEqual([]);
    expect(
      findOverlaps([
        { id: 'a', ownedPaths: ['src/a/**'] },
        { id: 'b', ownedPaths: ['src/b/**', 'tests/b.test.ts'] },
        { id: 'c', ownedPaths: ['docs/**'] },
      ]),
    ).toEqual([]);
  });

  it('informa cada par una vez, con las rutas originales y en orden de tareas', () => {
    const overlaps = findOverlaps([
      { id: 'a', ownedPaths: ['src\\core\\**', 'docs/a.md'] },
      { id: 'b', ownedPaths: ['src/core/x.ts', 'src/ui/**'] },
      { id: 'c', ownedPaths: ['SRC/UI/Boton.tsx', 'docs/**'] },
    ]);
    expect(overlaps).toEqual([
      { taskA: 'a', pathA: 'src\\core\\**', taskB: 'b', pathB: 'src/core/x.ts' },
      { taskA: 'a', pathA: 'docs/a.md', taskB: 'c', pathB: 'docs/**' },
      { taskA: 'b', pathA: 'src/ui/**', taskB: 'c', pathB: 'SRC/UI/Boton.tsx' },
    ]);
  });

  it('informa todos los pares de rutas que chocan entre dos tareas', () => {
    const overlaps = findOverlaps([
      { id: 'a', ownedPaths: ['src/x.ts', 'src/y.ts'] },
      { id: 'b', ownedPaths: ['src/**'] },
    ]);
    expect(overlaps.map((o) => o.pathA)).toEqual(['src/x.ts', 'src/y.ts']);
  });

  it('no compara las rutas de una misma tarea entre sí', () => {
    expect(findOverlaps([{ id: 'a', ownedPaths: ['src/a', 'src/a/b.ts', 'src/**'] }])).toEqual([]);
  });

  it('salta las tareas con el mismo id (el id repetido lo informa validatePlan)', () => {
    expect(
      findOverlaps([
        { id: 'a', ownedPaths: ['src/**'] },
        { id: 'a', ownedPaths: ['src/x.ts'] },
      ]),
    ).toEqual([]);
  });

  // Rutas reales de los encargos de la flota F1 (2026-11-01). Las piezas que se separaron de otro encargo
  // (c6 de c1, c7 de c3, c8 de c4, c9 de c2, c10 de c5, codex-cupos de codex-cli) repiten rutas del original.
  const fleet = [
    { id: 'agy-cli', ownedPaths: ['src/core/adapters/agy-cli/**', 'src/core/quota/agy.ts', 'tests/core/adapters/agy-cli/**', 'tests/core/quota/agy.test.ts', 'tests/live/agy.live.test.ts', 'fixtures/agy/**'] },
    { id: 'agy-repo-ejemplo', ownedPaths: ['fixtures/repo-ejemplo/**', 'tests/fixtures/**'] },
    {
      id: 'c1-claude-sdk',
      ownedPaths: [
        'src/core/adapters/claude-sdk/**', 'src/core/adapters/api/**', 'src/core/quota/openrouter.ts', 'src/core/quota/response-headers.ts',
        'src/core/quota/manual-budget.ts', 'tests/core/adapters/claude-sdk/**', 'tests/core/adapters/api/**', 'tests/core/quota/openrouter.test.ts',
        'tests/core/quota/response-headers.test.ts', 'tests/core/quota/manual-budget.test.ts', 'tests/live/claude-sdk.live.test.ts',
        'tests/live/api.live.test.ts', 'fixtures/claude-sdk/**', 'fixtures/api/**',
      ],
    },
    { id: 'c10-docs-api', ownedPaths: ['docs/api/**', 'tests/docs/**'] },
    { id: 'c2-orquestacion', ownedPaths: ['src/core/orchestrator/**', 'tests/core/orchestrator/**'] },
    { id: 'c3-workspace', ownedPaths: ['src/core/workspace/**', 'src/core/locks/**', 'tests/core/workspace/**', 'tests/core/locks/**'] },
    { id: 'c4-memoria', ownedPaths: ['src/core/memory/**', 'src/core/skills/**', 'tests/core/memory/**', 'tests/core/skills/**', 'fixtures/skills/**'] },
    {
      id: 'c5-servidor',
      ownedPaths: [
        'src/core/server/**', 'src/core/store/**', 'src/core/vault/**', 'src/core/registry/**', 'src/core/config/**', 'src/core/main.ts',
        'tests/core/server/**', 'tests/core/store/**', 'tests/core/vault/**', 'tests/core/registry/**', 'tests/core/config/**', 'docs/api/**',
      ],
    },
    { id: 'c6-api', ownedPaths: ['src/core/adapters/api/**', 'tests/core/adapters/api/**', 'tests/live/api.live.test.ts', 'fixtures/api/**'] },
    { id: 'c7-locks', ownedPaths: ['src/core/locks/**', 'tests/core/locks/**'] },
    { id: 'c8-skills', ownedPaths: ['src/core/skills/**', 'tests/core/skills/**', 'fixtures/skills/**'] },
    { id: 'c9-orq-pruebas', ownedPaths: ['tests/core/orchestrator/plan.test.ts', 'tests/core/orchestrator/graph.test.ts', 'tests/core/orchestrator/paths.test.ts'] },
    { id: 'codex-cli', ownedPaths: ['src/core/adapters/codex-cli/**', 'src/core/quota/codex.ts', 'tests/core/adapters/codex-cli/**', 'tests/core/quota/codex.test.ts', 'tests/live/codex.live.test.ts', 'fixtures/codex/**'] },
    { id: 'codex-cupos', ownedPaths: ['src/core/quota/monitor.ts', 'src/core/quota/codex.ts', 'tests/core/quota/monitor.test.ts', 'tests/core/quota/codex.test.ts'] },
  ];

  it('detecta exactamente los solapes de los encargos reales de la flota', () => {
    const overlaps = findOverlaps(fleet);
    const pairs = [...new Set(overlaps.map((o) => `${o.taskA} ↔ ${o.taskB}`))];
    expect(pairs).toEqual([
      'c1-claude-sdk ↔ c6-api',
      'c10-docs-api ↔ c5-servidor',
      'c2-orquestacion ↔ c9-orq-pruebas',
      'c3-workspace ↔ c7-locks',
      'c4-memoria ↔ c8-skills',
      'codex-cli ↔ codex-cupos',
    ]);
    expect(overlaps).toHaveLength(4 + 1 + 3 + 2 + 3 + 2);
  });

  it('sin solapes cuando el encargo original cede las rutas de la pieza separada', () => {
    const c2 = {
      id: 'c2-orquestacion',
      ownedPaths: ['src/core/orchestrator/**', 'tests/core/orchestrator/queue.test.ts', 'tests/core/orchestrator/router.test.ts', 'tests/core/orchestrator/supervisor.test.ts', 'tests/core/orchestrator/fleet.test.ts'],
    };
    const c9 = fleet.find((t) => t.id === 'c9-orq-pruebas');
    expect(c9).toBeDefined();
    expect(findOverlaps([c2, ...(c9 ? [c9] : [])])).toEqual([]);
  });
});
