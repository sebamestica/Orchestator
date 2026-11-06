import { z } from 'zod';
import { idSchema, quotaMethodSchema } from './agents.ts';

export const quotaBucketSchema = z.strictObject({
  /** Grupo de modelos que comparte el cupo (agy: «Gemini Models», «Claude and GPT models»). */
  groupId: z.string().min(1),
  groupName: z.string().min(1),
  window: z.enum(['5h', 'daily', 'weekly', 'monthly', 'total', 'custom']),
  /** 0–1. Null si el proveedor solo informa unidades. */
  remainingFraction: z.number().min(0).max(1).nullable(),
  remainingUnits: z.strictObject({ amount: z.number(), unit: z.enum(['usd', 'tokens', 'requests']) }).optional(),
  resetAt: z.iso.datetime().optional(),
  /** True en los buckets del grupo que gasta el modelo del agente (agy). Si alguno lo lleva, solo esos deciden el cupo. */
  inUse: z.boolean().optional(),
});
export type QuotaBucket = z.infer<typeof quotaBucketSchema>;

export const quotaSnapshotSchema = z.strictObject({
  agentId: idSchema,
  method: quotaMethodSchema,
  takenAt: z.iso.datetime(),
  buckets: z.array(quotaBucketSchema),
  /** True si viene de una lectura antigua (p. ej. último registro de sesión de Codex). */
  stale: z.boolean(),
  error: z.string().optional(),
});
export type QuotaSnapshot = z.infer<typeof quotaSnapshotSchema>;

/** Buckets que deciden el cupo: los marcados `inUse` si hay alguno; si no, todos. */
export function decidingBuckets(snapshot: QuotaSnapshot): QuotaBucket[] {
  const inUse = snapshot.buckets.filter((b) => b.inUse === true);
  return inUse.length ? inUse : snapshot.buckets;
}

/** Fracción restante más baja entre los buckets que deciden (la que limita primero). Null si no hay datos. */
export function minRemainingFraction(snapshot: QuotaSnapshot): number | null {
  const values = decidingBuckets(snapshot).map((b) => b.remainingFraction).filter((v): v is number => v !== null);
  return values.length ? Math.min(...values) : null;
}
