/**
 * Validación de las respuestas de agentes antes de tocar el store. Copia de los esquemas de
 * `src/core/server/schemas.ts` (la interfaz solo puede importar tipos del núcleo); las aserciones
 * de tipo de abajo fallan en el typecheck si se desalinean.
 */
import { z } from 'zod';
import { agentConfigSchema, idSchema, probeResultSchema, quotaMethodSchema } from '../../../shared/index.ts';
import type { AgentRecord, DetectResponse, ProbeResponse } from '../../api/types.ts';

const isoTs = z.iso.datetime();

export const agentRecordSchema = z.strictObject({
  config: agentConfigSchema,
  quotaMethod: quotaMethodSchema.nullable(),
  lastProbe: probeResultSchema.nullable(),
  createdAt: isoTs,
  updatedAt: isoTs,
});
export const agentResponse = z.strictObject({ agent: agentRecordSchema });
export const probeResponse = z.strictObject({ agent: agentRecordSchema, probe: probeResultSchema });
export const addAgentResponse = z.strictObject({ agent: agentRecordSchema, probe: probeResultSchema.nullable() });
export const detectResponse = z.strictObject({
  detected: z.array(
    z.strictObject({
      id: idSchema,
      kind: z.enum(['codex-cli', 'agy-cli']),
      provider: z.enum(['codex', 'antigravity']),
      displayName: z.string(),
      executable: z.string(),
      argsPrefix: z.array(z.string()),
      version: z.string().optional(),
    }),
  ),
  added: z.array(agentRecordSchema),
});

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const aligned: [Same<z.infer<typeof agentRecordSchema>, AgentRecord>, Same<z.infer<typeof probeResponse>, ProbeResponse>, Same<z.infer<typeof detectResponse>, DetectResponse>] = [
  true,
  true,
  true,
];
void aligned;

/** Error de una respuesta del núcleo que no cumple el contrato; `errorText` lo muestra tal cual. */
export class InvalidResponseError extends Error {}

export function parseResponse<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new InvalidResponseError(`El núcleo devolvió ${what} con un formato inesperado; no se cambió nada.`);
  return parsed.data;
}
