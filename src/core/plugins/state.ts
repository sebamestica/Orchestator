/**
 * Estado de los plugins en SQLite (`plugins_state`). Solo lo visible: estado, detalle, pasos, agentes y perfil.
 * Los tokens viven en la bóveda (DPAPI) y en memoria, nunca aquí; el detalle y los pasos se tachan al guardar.
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { chromeProfileSchema, idSchema, pluginIdSchema, pluginStatusSchema, redactSecrets, type PluginId } from '../../shared/index.ts';

export const pluginStateSchema = z.strictObject({
  id: pluginIdSchema,
  status: pluginStatusSchema,
  detail: z.string().max(500).optional(),
  agents: z.array(idSchema).max(50),
  steps: z.array(z.string().max(500)).max(20),
  /** Solo Chrome. */
  profile: chromeProfileSchema.optional(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type PluginState = z.infer<typeof pluginStateSchema>;

const rowSchema = z.object({
  id: z.string(),
  status: z.string(),
  detail: z.string().nullable(),
  agents: z.string(),
  steps: z.string(),
  profile: z.string().nullable(),
  updated_at: z.string(),
});

export class PluginStateStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS plugins_state (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      detail TEXT,
      agents TEXT NOT NULL,
      steps TEXT NOT NULL,
      profile TEXT,
      updated_at TEXT NOT NULL
    )`);
  }

  /** Estado guardado (undefined si nunca se tocó o la fila no es válida). */
  get(id: PluginId): PluginState | undefined {
    const raw = this.db.prepare('SELECT id, status, detail, agents, steps, profile, updated_at FROM plugins_state WHERE id = ?').get(id);
    const row = rowSchema.safeParse(raw);
    if (!row.success) return undefined;
    let agents: unknown;
    let steps: unknown;
    try {
      agents = JSON.parse(row.data.agents);
      steps = JSON.parse(row.data.steps);
    } catch {
      return undefined;
    }
    const parsed = pluginStateSchema.safeParse({
      id: row.data.id,
      status: row.data.status,
      ...(row.data.detail !== null ? { detail: row.data.detail } : {}),
      agents,
      steps,
      ...(row.data.profile !== null ? { profile: row.data.profile } : {}),
      updatedAt: row.data.updated_at,
    });
    return parsed.success ? parsed.data : undefined;
  }

  /** Guarda (tachando detalle y pasos con los secretos que se pasen). */
  put(state: PluginState, secrets: readonly string[] = []): PluginState {
    const clean = pluginStateSchema.parse({
      ...state,
      ...(state.detail !== undefined ? { detail: redactSecrets(state.detail, secrets).slice(0, 500) } : {}),
      steps: state.steps.map((s) => redactSecrets(s, secrets).slice(0, 500)),
    });
    this.db
      .prepare(
        `INSERT INTO plugins_state (id, status, detail, agents, steps, profile, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, detail = excluded.detail, agents = excluded.agents,
           steps = excluded.steps, profile = excluded.profile, updated_at = excluded.updated_at`,
      )
      .run(clean.id, clean.status, clean.detail ?? null, JSON.stringify(clean.agents), JSON.stringify(clean.steps), clean.profile ?? null, clean.updatedAt);
    return clean;
  }
}
