export interface DependencyNode {
  id: string;
  dependsOn: readonly string[];
}

/**
 * Ciclos de dependencias. Cada ciclo se devuelve cerrado: `['a', 'b', 'a']` = a depende de b y b de a.
 * Se informa un ciclo por cada conjunto distinto de tareas; las dependencias inexistentes se ignoran.
 * Recorrido en profundidad **iterativo** (pila explícita): no desborda la pila con cadenas largas.
 */
export function findCycles(nodes: readonly DependencyNode[]): string[][] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const color = new Map<string, 'gray' | 'black'>();
  /** Camino gris actual y la posición de cada tarea en él. */
  const path: string[] = [];
  const position = new Map<string, number>();
  const seen = new Set<string>();
  const cycles: string[][] = [];
  const frames: { id: string; deps: readonly string[]; next: number }[] = [];

  const enter = (id: string): void => {
    color.set(id, 'gray');
    position.set(id, path.length);
    path.push(id);
    frames.push({ id, deps: byId.get(id)?.dependsOn ?? [], next: 0 });
  };

  for (const node of nodes) {
    if (color.has(node.id)) continue;
    enter(node.id);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (!frame) break;
      if (frame.next >= frame.deps.length) {
        frames.pop();
        path.pop();
        position.delete(frame.id);
        color.set(frame.id, 'black');
        continue;
      }
      const dep = frame.deps[frame.next++];
      if (dep === undefined || !byId.has(dep)) continue;
      const c = color.get(dep);
      if (c === undefined) {
        enter(dep);
      } else if (c === 'gray') {
        const cycle = path.slice(position.get(dep) ?? 0);
        const key = [...cycle].sort().join('\u0000');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push([...cycle, dep]);
        }
      }
    }
  }
  return cycles;
}

export interface TopologicalOrder {
  /** Tareas en un orden en que cada una va después de sus dependencias (estable: respeta el orden de entrada). */
  order: string[];
  /** Tareas que no se pueden ordenar: están en un ciclo o dependen de una que lo está. */
  blocked: string[];
}

/** Orden topológico (Kahn). Las dependencias inexistentes se ignoran, como en `findCycles`. */
export function topologicalOrder(nodes: readonly DependencyNode[]): TopologicalOrder {
  const ids = new Set(nodes.map((n) => n.id));
  const pending = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const index = new Map<string, number>();
  for (const [i, n] of nodes.entries()) {
    if (index.has(n.id)) continue;
    index.set(n.id, i);
    const deps = [...new Set(n.dependsOn)].filter((d) => ids.has(d));
    pending.set(n.id, deps.length);
    for (const d of deps) {
      const list = dependents.get(d);
      if (list) list.push(n.id);
      else dependents.set(d, [n.id]);
    }
  }
  // Montículo por posición de entrada: entre las listas sale primero la que llegó antes (orden estable).
  const heap = new MinHeap((id: string) => index.get(id) ?? 0);
  for (const [id, count] of pending) if (count === 0) heap.push(id);
  const order: string[] = [];
  for (let id = heap.pop(); id !== undefined; id = heap.pop()) {
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const left = (pending.get(next) ?? 0) - 1;
      pending.set(next, left);
      if (left === 0) heap.push(next);
    }
  }
  const placed = new Set(order);
  const blocked = [...index.keys()].filter((id) => !placed.has(id));
  return { order, blocked };
}

class MinHeap<T> {
  readonly #items: T[] = [];
  readonly #key: (item: T) => number;
  constructor(key: (item: T) => number) {
    this.#key = key;
  }
  push(item: T): void {
    const a = this.#items;
    a.push(item);
    for (let i = a.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (!this.#less(i, parent)) break;
      this.#swap(i, parent);
      i = parent;
    }
  }
  pop(): T | undefined {
    const a = this.#items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.#less(l, m)) m = l;
        if (r < a.length && this.#less(r, m)) m = r;
        if (m === i) break;
        this.#swap(i, m);
        i = m;
      }
    }
    return top;
  }
  #less(i: number, j: number): boolean {
    const x = this.#items[i];
    const y = this.#items[j];
    return x !== undefined && y !== undefined && this.#key(x) < this.#key(y);
  }
  #swap(i: number, j: number): void {
    const a = this.#items;
    const x = a[i];
    const y = a[j];
    if (x === undefined || y === undefined) return;
    a[i] = y;
    a[j] = x;
  }
}
