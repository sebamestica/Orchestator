import { redactSecrets } from '../../shared/index.ts';

/** Tacha secretos en todos los textos de un valor JSON (tareas del planificador, eventos). */
export function redactDeep<T>(value: T, secrets: readonly string[]): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactSecrets(v, secrets);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
