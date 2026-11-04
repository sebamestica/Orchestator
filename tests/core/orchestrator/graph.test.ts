import { describe, expect, it } from 'vitest';
import type { DependencyNode } from '../../../src/core/orchestrator/graph.ts';
import { findCycles, topologicalOrder } from '../../../src/core/orchestrator/graph.ts';

const node = (id: string, ...dependsOn: string[]): DependencyNode => ({ id, dependsOn });

/** Comprueba que un ciclo devuelto es real: cerrado, sin repetir tareas y con cada paso «depende de». */
function expectValidCycle(nodes: readonly DependencyNode[], cycle: readonly string[]): void {
  const deps = new Map(nodes.map((n) => [n.id, n.dependsOn]));
  expect(cycle.length).toBeGreaterThanOrEqual(2);
  expect(cycle.at(0)).toBe(cycle.at(-1));
  const members = cycle.slice(0, -1);
  expect(new Set(members).size).toBe(members.length);
  for (let i = 0; i + 1 < cycle.length; i++) {
    const from = cycle[i] ?? '';
    const to = cycle[i + 1] ?? '';
    expect(deps.get(from), `${from} → ${to}`).toContain(to);
  }
}

/** Oráculo independiente (Kahn): ¿hay algún ciclo entre dependencias existentes? */
function hasCycleKahn(nodes: readonly DependencyNode[]): boolean {
  const ids = new Set(nodes.map((n) => n.id));
  const pending = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    const deps = [...new Set(n.dependsOn)].filter((d) => ids.has(d));
    pending.set(n.id, deps.length);
    for (const d of deps) dependents.set(d, [...(dependents.get(d) ?? []), n.id]);
  }
  const ready = [...pending].filter(([, count]) => count === 0).map(([id]) => id);
  let done = 0;
  for (let id = ready.pop(); id !== undefined; id = ready.pop()) {
    done++;
    for (const next of dependents.get(id) ?? []) {
      const left = (pending.get(next) ?? 0) - 1;
      pending.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  return done < ids.size;
}

/** PRNG determinista (mulberry32) para que las pruebas aleatorias sean reproducibles. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('findCycles', () => {
  describe('DAG válido', () => {
    it('sin tareas o sin dependencias no hay ciclos', () => {
      expect(findCycles([])).toEqual([]);
      expect(findCycles([node('a')])).toEqual([]);
      expect(findCycles([node('a'), node('b'), node('c')])).toEqual([]);
    });

    it('cadena y diamante no son ciclos', () => {
      expect(findCycles([node('c', 'b'), node('b', 'a'), node('a')])).toEqual([]);
      // d depende de b y c, que dependen de a: a se alcanza por dos caminos.
      expect(findCycles([node('d', 'b', 'c'), node('b', 'a'), node('c', 'a'), node('a')])).toEqual([]);
    });

    it('dependencias repetidas no son ciclos', () => {
      expect(findCycles([node('b', 'a', 'a'), node('a')])).toEqual([]);
    });

    it('una cadena de 2000 tareas no desborda la pila', () => {
      const chain = Array.from({ length: 2000 }, (_, i) => (i === 0 ? node('t0') : node(`t${i}`, `t${i - 1}`)));
      expect(findCycles(chain)).toEqual([]);
      expect(findCycles(chain.toReversed())).toEqual([]);
    });
  });

  describe('dependencias inexistentes', () => {
    it('se ignoran (las informa validatePlan como unknown_dependency)', () => {
      expect(findCycles([node('a', 'fantasma'), node('b', 'a', 'otra')])).toEqual([]);
    });

    it('no ocultan un ciclo real', () => {
      const nodes = [node('a', 'fantasma', 'b'), node('b', 'a')];
      expect(findCycles(nodes)).toEqual([['a', 'b', 'a']]);
    });

    it('una tarea que solo aparece en dependsOn no cierra un ciclo', () => {
      // «x» no es un nodo: a → x y x → a no se puede expresar, así que no hay ciclo.
      expect(findCycles([node('a', 'x'), node('b', 'x')])).toEqual([]);
    });
  });

  describe('autociclos', () => {
    it('una tarea que depende de sí misma', () => {
      expect(findCycles([node('a', 'a')])).toEqual([['a', 'a']]);
    });

    it('junto a otras dependencias y repetido, se informa una vez', () => {
      expect(findCycles([node('b', 'a'), node('a', 'a', 'a')])).toEqual([['a', 'a']]);
    });
  });

  describe('ciclos simples', () => {
    it('dos tareas que dependen entre sí, cerrado y en sentido «depende de»', () => {
      const nodes = [node('a', 'b'), node('b', 'a')];
      expect(findCycles(nodes)).toEqual([['a', 'b', 'a']]);
    });

    it('tres tareas: a → b → c → a', () => {
      const nodes = [node('a', 'b'), node('b', 'c'), node('c', 'a')];
      const cycles = findCycles(nodes);
      expect(cycles).toEqual([['a', 'b', 'c', 'a']]);
      for (const c of cycles) expectValidCycle(nodes, c);
    });

    it('el mismo ciclo empezando el recorrido desde otra tarea', () => {
      const nodes = [node('c', 'a'), node('a', 'b'), node('b', 'c')];
      expect(findCycles(nodes)).toEqual([['c', 'a', 'b', 'c']]);
    });

    it('un ciclo al que solo se llega desde una tarea fuera de él', () => {
      const nodes = [node('raiz', 'x'), node('x', 'y'), node('y', 'x')];
      expect(findCycles(nodes)).toEqual([['x', 'y', 'x']]);
    });

    it('dependencias repetidas dentro del ciclo no lo duplican', () => {
      expect(findCycles([node('a', 'b'), node('b', 'a', 'a')])).toEqual([['a', 'b', 'a']]);
    });
  });

  describe('varios ciclos', () => {
    it('dos ciclos disjuntos y un autociclo', () => {
      const nodes = [node('a', 'b'), node('b', 'a'), node('c', 'd'), node('d', 'c'), node('e', 'e'), node('f', 'a')];
      const cycles = findCycles(nodes);
      expect(cycles).toEqual([
        ['a', 'b', 'a'],
        ['c', 'd', 'c'],
        ['e', 'e'],
      ]);
    });

    it('ciclos que comparten una tarea se informan por separado', () => {
      // a ↔ b y b ↔ c: conjuntos {a,b} y {b,c}.
      const nodes = [node('a', 'b'), node('b', 'a', 'c'), node('c', 'b')];
      const cycles = findCycles(nodes);
      expect(cycles).toHaveLength(2);
      for (const c of cycles) expectValidCycle(nodes, c);
      expect(cycles.map((c) => [...new Set(c)].sort().join(','))).toEqual(['a,b', 'b,c']);
    });

    it('grafo completo de 3: ciclos válidos y sin conjuntos repetidos', () => {
      const nodes = [node('a', 'b', 'c'), node('b', 'a', 'c'), node('c', 'a', 'b')];
      const cycles = findCycles(nodes);
      expect(cycles.length).toBeGreaterThanOrEqual(1);
      for (const c of cycles) expectValidCycle(nodes, c);
      const keys = cycles.map((c) => [...new Set(c)].sort().join(','));
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  describe('contra el algoritmo de Kahn en 400 grafos aleatorios (semilla fija)', () => {
    it('DAG por construcción → sin ciclos; con una arista hacia atrás → ciclo válido', () => {
      const random = rng(20261101);
      for (let round = 0; round < 200; round++) {
        const size = 2 + Math.floor(random() * 12);
        const ids = Array.from({ length: size }, (_, i) => `t${i}`);
        // Solo dependencias hacia índices menores: DAG.
        const dag = ids.map((id, i) => node(id, ...ids.slice(0, i).filter(() => random() < 0.3), ...(random() < 0.2 ? ['fantasma'] : [])));
        expect(findCycles(dag), `DAG ronda ${round}`).toEqual([]);
        expect(hasCycleKahn(dag)).toBe(false);

        // Una arista de i hacia j ≥ i cierra un ciclo si j llega a i (siempre, si se fuerza el camino).
        const from = Math.floor(random() * size);
        const to = from + Math.floor(random() * (size - from));
        const withBack = dag.map((n, k) => {
          const deps = [...n.dependsOn];
          if (k > from && k <= to) deps.push(ids[k - 1] ?? ''); // camino to → … → from
          if (k === from) deps.push(ids[to] ?? '');
          return node(n.id, ...deps);
        });
        const cycles = findCycles(withBack);
        expect(cycles.length, `con ciclo ronda ${round}`).toBeGreaterThanOrEqual(1);
        expect(hasCycleKahn(withBack)).toBe(true);
        for (const c of cycles) expectValidCycle(withBack, c);
      }
    });

    it('grafos arbitrarios: hay ciclo según findCycles ⇔ hay ciclo según Kahn', () => {
      const random = rng(42);
      let cyclic = 0;
      for (let round = 0; round < 200; round++) {
        const size = 1 + Math.floor(random() * 10);
        const ids = Array.from({ length: size }, (_, i) => `t${i}`);
        const nodes = ids.map((id) => node(id, ...ids.filter(() => random() < 0.15)));
        const cycles = findCycles(nodes);
        expect(cycles.length > 0, `ronda ${round}: ${JSON.stringify(nodes)}`).toBe(hasCycleKahn(nodes));
        for (const c of cycles) expectValidCycle(nodes, c);
        const keys = cycles.map((c) => [...new Set(c)].sort().join(','));
        expect(new Set(keys).size).toBe(keys.length);
        if (cycles.length) cyclic++;
      }
      // La muestra tiene casos de los dos tipos.
      expect(cyclic).toBeGreaterThan(20);
      expect(cyclic).toBeLessThan(180);
    });
  });

  // Corregido (hallazgo de c9): `visit` era recursivo y una cadena de ~5000 dependencias lanzaba RangeError.
  // Ahora el recorrido es iterativo (pila explícita).
  it('una cadena de 100 000 dependencias no desborda la pila', () => {
    const chain = Array.from({ length: 100_000 }, (_, i) => (i === 0 ? node('t0') : node(`t${i}`, `t${i - 1}`)));
    expect(() => findCycles(chain.toReversed())).not.toThrow();
    const closed = [...chain, node('t0', 't99999')].slice(1);
    const cycles = findCycles(closed.toReversed());
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(100_001);
  });
});

describe('topologicalOrder', () => {
  it('pone cada tarea después de sus dependencias; entre las listas, la que llegó antes', () => {
    const nodes = [node('final', 'izq', 'der'), node('izq', 'base'), node('der', 'base', 'fantasma'), node('base'), node('suelta')];
    // Al principio están listas base (índice 3) y suelta (4); al liberarse, final (0) adelanta a suelta.
    expect(topologicalOrder(nodes)).toEqual({ order: ['base', 'izq', 'der', 'final', 'suelta'], blocked: [] });
  });

  it('deja aparte las tareas en ciclo y las que dependen de ellas', () => {
    const nodes = [node('a', 'b'), node('b', 'a'), node('c', 'a'), node('d'), node('e', 'd')];
    expect(topologicalOrder(nodes)).toEqual({ order: ['d', 'e'], blocked: ['a', 'b', 'c'] });
  });

  it('coincide con findCycles y con el oráculo en 200 grafos aleatorios (semilla fija)', () => {
    const random = rng(7);
    for (let round = 0; round < 200; round++) {
      const size = 1 + Math.floor(random() * 8);
      const ids = Array.from({ length: size }, (_, i) => `n${i}`);
      const nodes = ids.map((id) => node(id, ...ids.filter(() => random() < 0.2), ...(random() < 0.1 ? ['fantasma'] : [])));
      const { order, blocked } = topologicalOrder(nodes);
      expect(order.length + blocked.length).toBe(size);
      expect(blocked.length > 0).toBe(hasCycleKahn(nodes));
      expect(blocked.length > 0).toBe(findCycles(nodes).length > 0);
      const position = new Map(order.map((id, i) => [id, i]));
      for (const n of nodes) {
        if (!position.has(n.id)) continue;
        for (const d of n.dependsOn) if (ids.includes(d)) expect(position.get(d), `${n.id} depende de ${d}`).toBeLessThan(position.get(n.id) ?? -1);
      }
    }
  });

  it('no desborda con 100 000 tareas encadenadas ni con 100 000 tareas libres', () => {
    const chain = Array.from({ length: 100_000 }, (_, i) => (i === 0 ? node('t0') : node(`t${i}`, `t${i - 1}`)));
    expect(topologicalOrder(chain.toReversed()).order.slice(0, 3)).toEqual(['t0', 't1', 't2']);
    const free = Array.from({ length: 100_000 }, (_, i) => node(`f${i}`));
    expect(topologicalOrder(free).order.at(-1)).toBe('f99999');
  });
});
