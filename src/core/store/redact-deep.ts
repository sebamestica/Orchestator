import { redactSecrets } from '../../shared/index.ts';

/**
 * Tacha secretos en todas las cadenas de un valor JSON (objetos y arreglos anidados).
 * Se tacha campo por campo en lugar del JSON serializado para no romper el formato.
 */
export function redactDeep<T>(value: T, extraSecrets: readonly string[] = []): T {
  return walk(value, extraSecrets, 0) as T;
}

function walk(value: unknown, extra: readonly string[], depth: number): unknown {
  if (typeof value === 'string') return redactSecrets(value, extra);
  if (value === null || typeof value !== 'object' || depth > 64) return value;
  if (Array.isArray(value)) return value.map((v) => walk(v, extra, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = walk(v, extra, depth + 1);
  return out;
}
