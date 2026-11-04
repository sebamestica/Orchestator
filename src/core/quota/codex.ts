import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { quotaSnapshotSchema, redactSecrets } from '../../shared/index.ts';
import type { QuotaBucket, QuotaProvider, QuotaSnapshot } from '../../shared/index.ts';
import { readCodexAppServer } from '../adapters/codex-cli/app-server.ts';

const percent = z.number().min(0).max(100);
const epoch = z.number().int().nonnegative().max(8_640_000_000_000);
const windowSchema = z.object({ usedPercent: percent, resetsAt: epoch.nullish(), windowDurationMins: z.number().positive().nullish() });
const limitsSchema = z.object({ limitId: z.string().nullish(), limitName: z.string().nullish(), primary: windowSchema.nullish(), secondary: windowSchema.nullish() });
const serverSchema = z.object({ rateLimits: limitsSchema.nullish(), rateLimitsByLimitId: z.record(z.string(), limitsSchema).nullish() });
const rolloutWindow = z.object({ used_percent: percent, resets_at: epoch.nullish(), window_minutes: z.number().positive().nullish() });
const rolloutSchema = z.object({ timestamp: z.iso.datetime(), type: z.literal('event_msg'), payload: z.object({ type: z.literal('token_count'),
  rate_limits: z.object({ limit_id: z.string().nullish(), limit_name: z.string().nullish(), primary: rolloutWindow.nullish(), secondary: rolloutWindow.nullish() }) }) });

type Limits = z.infer<typeof limitsSchema>;
function buckets(limits: Limits, fallbackId = 'codex'): QuotaBucket[] {
  const result: QuotaBucket[] = [];
  for (const [key, window] of [['primary', '5h'], ['secondary', 'weekly']] as const) {
    const data = limits[key];
    if (!data) continue;
    result.push({ groupId: limits.limitId || fallbackId, groupName: limits.limitName || limits.limitId || fallbackId,
      window, remainingFraction: 1 - data.usedPercent / 100,
      ...(data.resetsAt == null ? {} : { resetAt: new Date(data.resetsAt * 1000).toISOString() }) });
  }
  return result;
}

export interface CodexQuotaOptions {
  readAppServer?: () => Promise<unknown>;
  sessionsDir?: string;
  now?: () => Date;
}

/** Elige por timestamp del evento. El mtime solo ordena/poda registros; ignora líneas truncadas.
 * onOpen instrumenta los intentos de apertura sin exponer el contenido del registro.
 * La poda presupone registros locales cuyo mtime no fue restaurado a una fecha anterior al evento.
 */
export async function readLatestCodexRollout(directory: string, onOpen?: (file: string) => void): Promise<{ takenAt: string; buckets: QuotaBucket[] } | undefined> {
  let latest: { takenAt: string; buckets: QuotaBucket[] } | undefined;
  const files: { path: string; modified: number }[] = [];
  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) { await visit(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const metadata = await stat(file).catch(() => undefined);
      if (metadata) files.push({ path: file, modified: metadata.mtimeMs });
    }
  }
  await visit(directory);
  files.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path));
  for (const { path: file, modified } of files) {
    if (latest && modified < Date.parse(latest.takenAt)) break;
    onOpen?.(file);
    const input = createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let value: unknown;
        try { value = JSON.parse(line); } catch { continue; }
        const parsed = rolloutSchema.safeParse(value);
        if (!parsed.success) continue;
        const event = parsed.data;
        const limits = event.payload.rate_limits;
        const convert = (data: z.infer<typeof rolloutWindow> | null | undefined) => data ? { usedPercent: data.used_percent, resetsAt: data.resets_at, windowDurationMins: data.window_minutes } : null;
        const found = buckets({ limitId: limits.limit_id, limitName: limits.limit_name, primary: convert(limits.primary), secondary: convert(limits.secondary) });
        if (found.length && (!latest || Date.parse(event.timestamp) >= Date.parse(latest.takenAt))) latest = { takenAt: event.timestamp, buckets: found };
      }
    } catch { /* Un archivo puede desaparecer o rotar mientras se lee. */ }
    finally { lines.close(); input.destroy(); }
  }
  return latest;
}

export class CodexQuotaProvider implements QuotaProvider {
  readonly agentId: string;
  private readonly options: CodexQuotaOptions;
  constructor(agentId: string, options: CodexQuotaOptions = {}) { this.agentId = agentId; this.options = options; }

  async read(): Promise<QuotaSnapshot> {
    const now = (this.options.now ?? (() => new Date()))();
    const base = { agentId: this.agentId, method: 'codex-ratelimits' as const };
    try {
      const response = serverSchema.parse(await (this.options.readAppServer ?? readCodexAppServer)());
      const byId = response.rateLimitsByLimitId;
      const found = byId && Object.keys(byId).length ? Object.entries(byId).flatMap(([id, limits]) => buckets(limits, id)) : response.rateLimits ? buckets(response.rateLimits) : [];
      if (found.length) return quotaSnapshotSchema.parse({ ...base, takenAt: now.toISOString(), buckets: found, stale: false });
    } catch { /* Sin sesión, RPC no disponible o versión incompatible: probar registros locales. */ }
    try {
      const directory = this.options.sessionsDir ?? join(process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.codex'), 'sessions');
      const latest = await readLatestCodexRollout(directory);
      if (latest) return quotaSnapshotSchema.parse({ ...base, ...latest, stale: now.getTime() - Date.parse(latest.takenAt) > 600_000 });
    } catch { /* No hay acceso al respaldo. */ }
    return quotaSnapshotSchema.parse({ ...base, takenAt: now.toISOString(), buckets: [], stale: true,
      error: redactSecrets('No se pudo leer el cupo desde app-server ni desde los registros de sesión de Codex') });
  }
}
