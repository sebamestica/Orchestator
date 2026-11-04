import { z } from 'zod';

/**
 * Candados que define la skill `local-compute-scheduling` del hub
 * (`C:\dev\agent-hub\skills\local-compute-scheduling`; carpetas en `C:\dev\agent-hub\locks\<nombre>`).
 * Usar estos nombres para que los agentes de todos los proyectos y el núcleo respeten los mismos recursos.
 * `blender-mcp` y `slicer-mcp`: la sesión interactiva de Blender o de Slicer y su MCP, con un único dueño.
 */
export const KNOWN_LOCKS = ['gpu', 'heavy-cpu-1', 'heavy-cpu-2', 'e2e', 'blender-mcp', 'slicer-mcp'] as const;
export type KnownLock = (typeof KNOWN_LOCKS)[number];

/**
 * Recurso → carpetas-candado que lo representan. Cada carpeta admite un solo dueño:
 * `heavy-cpu` tiene dos para permitir 2 trabajos pesados a la vez (tabla de la skill); los demás, uno.
 */
export const LOCK_POOLS = {
  gpu: ['gpu'],
  'heavy-cpu': ['heavy-cpu-1', 'heavy-cpu-2'],
  e2e: ['e2e'],
  'blender-mcp': ['blender-mcp'],
  'slicer-mcp': ['slicer-mcp'],
} as const satisfies Record<string, readonly KnownLock[]>;
export type LockPool = keyof typeof LOCK_POOLS;

/**
 * Marca de una carpeta apartada durante una liberación: `<nombre>.releasing.<pid>.<aleatorio>`.
 * Reservada: ningún candado puede llamarse así.
 */
export const RELEASING_MARK = '.releasing.';

/** Nombres de dispositivo de Windows: `mkdir con` no crea una carpeta normal. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/;

/**
 * Nombre de candado: una sola carpeta dentro de la raíz. Minúsculas (Windows no distingue
 * mayúsculas, así `GPU` y `gpu` no pueden ser dos candados), sin separadores, sin `..`,
 * sin punto final (Windows lo descarta) y sin nombres reservados.
 */
export const lockNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'solo minúsculas, dígitos, punto, guion y guion bajo; sin separadores; máx. 64')
  .refine((name) => !name.includes('..'), 'no puede contener ..')
  .refine((name) => !name.endsWith('.'), 'no puede terminar en punto')
  .refine((name) => !WINDOWS_RESERVED.test(name), 'nombre reservado en Windows')
  .refine((name) => !name.includes(RELEASING_MARK), `${RELEASING_MARK} está reservado para las liberaciones en curso`);

/** Si `entry` es una carpeta apartada por una liberación, el nombre del candado al que pertenece. */
export function releasingLockName(entry: string): string | undefined {
  const match = /^(.+)\.releasing\.\d+\.[0-9a-f]{8}$/.exec(entry);
  return match?.[1] !== undefined && lockNameSchema.safeParse(match[1]).success ? match[1] : undefined;
}
