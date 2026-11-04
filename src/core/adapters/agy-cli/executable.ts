import { resolveAgyCommand } from '../../quota/agy.ts';

export interface AgyExecutable {
  command: string;
  args: readonly string[];
}

/** Resuelve el comando ejecutable de agy y sus argumentos base. */
export function resolveAgyExecutable(explicit?: string | AgyExecutable): AgyExecutable {
  if (typeof explicit === 'object' && explicit !== null) {
    return explicit;
  }
  return {
    command: resolveAgyCommand(explicit),
    args: [],
  };
}
