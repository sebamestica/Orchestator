import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { AgyQuotaProvider, resolveAgyCommand } from '../../src/core/quota/agy.ts';
import { CodexQuotaProvider } from '../../src/core/quota/codex.ts';
import { readCodexAppServer } from '../../src/core/adapters/codex-cli/app-server.ts';
import { runJsonl } from '../../src/core/process/run-jsonl.ts';
import { redactSecrets } from '../../src/shared/index.ts';
import type { QuotaBucket } from '../../src/shared/index.ts';

// Lectores independientes: no importan los parsers ni el lector de sesiones del proveedor.
const usageSchema = z.object({ command: z.object({ name: z.literal('usage'), data: z.object({
  groups: z.array(z.object({ name: z.string().min(1), buckets: z.array(z.object({
    window: z.enum(['5h', 'weekly', 'daily', 'monthly', 'total', 'custom']),
    remaining_fraction: z.number().min(0).max(1).nullable(), reset_time: z.iso.datetime().optional(),
  })) })),
}) }) });
const sessionWindow = z.object({ used_percent: z.number().min(0).max(100), resets_at: z.number().int().nonnegative().max(8_640_000_000_000).nullish() });
const sessionSchema = z.object({ timestamp: z.iso.datetime(), type: z.literal('event_msg'), payload: z.object({
  type: z.literal('token_count'), rate_limits: z.object({ limit_id: z.string().nullish(),
    primary: sessionWindow.nullish(), secondary: sessionWindow.nullish(),
  }),
}) });
type SessionReading = z.infer<typeof sessionSchema>;

async function latestSession(directory: string): Promise<SessionReading | undefined> {
  let latest: SessionReading | undefined;
  async function visit(folder: string): Promise<void> {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name);
      if (entry.isDirectory()) { await visit(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const input = createReadStream(file, { encoding: 'utf8' });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          let raw: unknown;
          try { raw = JSON.parse(line); } catch { continue; } // Un escritor activo puede dejar una ultima linea incompleta.
          const parsed = sessionSchema.safeParse(raw);
          if (!parsed.success || (!parsed.data.payload.rate_limits.primary && !parsed.data.payload.rate_limits.secondary)) continue;
          if (!latest || Date.parse(parsed.data.timestamp) >= Date.parse(latest.timestamp)) latest = parsed.data;
        }
      } finally { lines.close(); input.destroy(); }
    }
  }
  await visit(directory);
  return latest;
}

interface Comparison { group: string; window: string; core: QuotaBucket | undefined; remaining: number | null; reset?: string | undefined }
function compare(source: string, rows: Comparison[], tolerance: number, checkReset: boolean): void {
  const percent = (fraction: number | null | undefined) => fraction == null ? '?' : (fraction * 100).toFixed(2);
  console.warn(redactSecrets([
    'Fuente | Grupo | Ventana | Nucleo % | Referencia % | Reinicio nucleo | Reinicio referencia',
    ...rows.map((row) => [source, row.group, row.window, percent(row.core?.remainingFraction), percent(row.remaining), row.core?.resetAt ?? '-', row.reset ?? '-'].join(' | ')),
  ].join('\n')));
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.core, 'Falta grupo/ventana en el nucleo').toBeDefined();
    if (row.remaining === null) expect(row.core?.remainingFraction).toBeNull();
    else {
      expect(row.core?.remainingFraction).toBeTypeOf('number');
      expect(Math.abs(((row.core?.remainingFraction ?? -1) - row.remaining) * 100)).toBeLessThanOrEqual(tolerance + 1e-9);
    }
    if (checkReset) {
      expect(Boolean(row.core?.resetAt), 'Reinicio presente en ambas fuentes').toBe(Boolean(row.reset));
      // Con el cupo intacto (100 %), agy informa el reinicio como «ahora + ventana»: se mueve entre dos lecturas
      // separadas por segundos. Se tolera la distancia entre lecturas (≤ 60 s), no un reinicio distinto.
      if (row.core?.resetAt && row.reset) {
        expect(Math.abs(Date.parse(row.core.resetAt) - Date.parse(row.reset))).toBeLessThanOrEqual(RESET_TOLERANCE_MS);
      }
    }
  }
}

const RESET_TOLERANCE_MS = 60_000;

describe.skipIf(process.env.ORQ_LIVE !== '1')('Aceptacion F2: cupos sin generar turnos ni tokens', () => {
  it('agy coincide con una lectura independiente de /usage (<= 1 punto)', async () => {
    const core = await new AgyQuotaProvider().read();
    let raw: unknown;
    let successfulExit = false;
    for await (const line of runJsonl({ command: resolveAgyCommand(), args: ['-p', '/usage', '--output-format', 'json'], cwd: process.cwd(), timeoutMs: 30_000 })) {
      if (line.kind === 'json') raw = line.value;
      if (line.kind === 'exit') successfulExit = line.code === 0 && !line.aborted && !line.timedOut;
    }
    expect(successfulExit).toBe(true);
    const reference = usageSchema.parse(raw);
    expect(core.stale).toBe(false);
    const rows = reference.command.data.groups.flatMap((group) => group.buckets.map((bucket): Comparison => ({
      group: group.name, window: bucket.window,
      core: core.buckets.find((b) => b.groupName === group.name && b.window === bucket.window),
      remaining: bucket.remaining_fraction, reset: bucket.reset_time,
    })));
    compare('agy /usage', rows, 1, true);
    expect(core.buckets).toHaveLength(rows.length);
  }, 90_000);

  it('Codex app-server coincide con el ultimo rate_limits local (<= 2 puntos)', async () => {
    // Impide que el respaldo del proveedor produzca una comparacion del registro consigo mismo.
    let appServerResponded = false;
    const core = await new CodexQuotaProvider('codex', { readAppServer: async () => {
      const response = await readCodexAppServer();
      appServerResponded = true;
      return response;
    }, sessionsDir: join(process.cwd(), '.orq', 'respaldo-deshabilitado-aceptacion'),
    }).read();
    expect(appServerResponded).toBe(true);
    expect(core.stale).toBe(false);
    expect(core.error).toBeUndefined();
    const home = process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? homedir(), '.codex');
    const reference = await latestSession(join(home, 'sessions'));
    expect(reference, 'No hay rate_limits validos en las sesiones locales').toBeDefined();
    if (!reference) throw new Error('Falta referencia local de Codex');
    const ageSeconds = (Date.parse(core.takenAt) - Date.parse(reference.timestamp)) / 1000;
    console.warn('Codex: app-server=%s; registro=%s; antiguedad respecto a lectura=%s s; tolerancia=2 puntos. Un registro antiguo puede diferir tras consumo o reinicio.', core.takenAt, reference.timestamp, ageSeconds.toFixed(1));
    const limits = reference.payload.rate_limits;
    const rows: Comparison[] = [];
    for (const [key, window] of [['primary', '5h'], ['secondary', 'weekly']] as const) {
      const bucket = limits[key];
      if (!bucket) continue;
      const group = limits.limit_id || 'codex';
      rows.push({ group, window, core: core.buckets.find((b) => b.groupId === group && b.window === window),
        remaining: 1 - bucket.used_percent / 100,
        reset: bucket.resets_at == null ? undefined : new Date(bucket.resets_at * 1000).toISOString(),
      });
    }
    compare('Codex sessions/rate_limits', rows, 2, false);
  }, 120_000);
});
