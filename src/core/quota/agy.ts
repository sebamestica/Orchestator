import path from 'node:path';
import { z } from 'zod';
import type { QuotaBucket, QuotaProvider, QuotaSnapshot } from '../../shared/index.ts';
import { quotaSnapshotSchema } from '../../shared/index.ts';
import { runJsonl } from '../process/run-jsonl.ts';

const agyBucketRawSchema = z.strictObject({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  window: z.string(),
  remaining_fraction: z.number().nullable().optional(),
  reset_time: z.string().optional(),
});

const agyGroupRawSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  buckets: z.array(agyBucketRawSchema),
});

const agyUsageOutputSchema = z.object({
  status: z.string().optional(),
  command: z.object({
    name: z.literal('usage'),
    data: z.object({
      description: z.string().optional(),
      groups: z.array(agyGroupRawSchema),
    }),
  }),
});

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';
}

function mapWindow(windowRaw: string): QuotaBucket['window'] {
  if (windowRaw === '5h' || windowRaw === 'daily' || windowRaw === 'weekly' || windowRaw === 'monthly' || windowRaw === 'total') {
    return windowRaw;
  }
  return 'custom';
}

/** Resuelve la ruta del ejecutable de agy según plataforma o variables de entorno. */
export function resolveAgyCommand(explicitCommand?: string): string {
  if (explicitCommand) return explicitCommand;
  if (process.env.AGY_BIN) return process.env.AGY_BIN;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe');
  }
  return 'agy';
}

type AgyGroupRaw = z.infer<typeof agyGroupRawSchema>;

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Familias de un grupo: la primera palabra de cada modelo de «Models within this group: …» y la del nombre. */
function groupFamilies(group: AgyGroupRaw): Set<string> {
  const listed = /models within this group:\s*(.+)/i.exec(group.description ?? '')?.[1] ?? '';
  const families = listed.split(',').map((model) => words(model)[0]);
  return new Set([...families, words(group.name)[0]].filter((f): f is string => f !== undefined));
}

/** Único grupo cuyo cupo gasta `model`; undefined si no encaja en ninguno o encaja en varios. */
function groupForModel(groups: AgyGroupRaw[], model: string | undefined): AgyGroupRaw | undefined {
  if (!model) return undefined;
  const modelWords = new Set(words(model));
  const matches = groups.filter((group) => [...groupFamilies(group)].some((family) => modelWords.has(family)));
  return matches.length === 1 ? matches[0] : undefined;
}

export interface ParseAgyUsageOptions {
  /** Modelo con que se lanza el agente: marca `inUse` los buckets de su grupo para que solo esos decidan el cupo. */
  model?: string;
}

/** Convierte la salida JSON de `agy -p "/usage" --output-format json` en un QuotaSnapshot. */
export function parseAgyUsage(
  rawJson: unknown,
  agentId: string,
  takenAt: string = new Date().toISOString(),
  options: ParseAgyUsageOptions = {},
): QuotaSnapshot {
  const parsed = agyUsageOutputSchema.parse(rawJson);
  const inUseGroup = groupForModel(parsed.command.data.groups, options.model);
  const buckets: QuotaBucket[] = parsed.command.data.groups.flatMap((group) => {
    const groupId = slugify(group.name);
    const inUse = group === inUseGroup;
    return group.buckets.map((b): QuotaBucket => {
      const window = mapWindow(b.window);
      const remainingFraction =
        typeof b.remaining_fraction === 'number'
          ? Math.max(0, Math.min(1, b.remaining_fraction))
          : null;

      let resetAt: string | undefined;
      if (b.reset_time) {
        const check = z.iso.datetime().safeParse(b.reset_time);
        if (check.success) resetAt = check.data;
      }

      return {
        groupId,
        groupName: group.name,
        window,
        remainingFraction,
        ...(resetAt ? { resetAt } : {}),
        ...(inUse ? { inUse } : {}),
      };
    });
  });

  return quotaSnapshotSchema.parse({
    agentId,
    method: 'agy-usage',
    takenAt,
    buckets,
    stale: false,
  });
}

export interface AgyQuotaProviderOptions {
  agentId?: string;
  /** Modelo de la configuración del agente; decide qué grupo de cupo cuenta. */
  model?: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
}

/** Proveedor de cupo para agy CLI. Ejecuta `/usage` sin gastar tokens. */
export class AgyQuotaProvider implements QuotaProvider {
  readonly agentId: string;
  private readonly model: string | undefined;
  private readonly command: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;

  constructor(optsOrAgentId: string | AgyQuotaProviderOptions = {}) {
    const opts = typeof optsOrAgentId === 'string' ? { agentId: optsOrAgentId } : optsOrAgentId;
    this.agentId = opts.agentId ?? 'agy';
    this.model = opts.model;
    this.command = resolveAgyCommand(opts.command);
    this.cwd = opts.cwd ?? process.cwd();
    this.timeoutMs = opts.timeoutMs ?? 30000;
  }

  async read(): Promise<QuotaSnapshot> {
    let lastJson: unknown = undefined;
    let exitCode: number | null = null;
    let stderrText = '';

    for await (const line of runJsonl({
      command: this.command,
      args: ['-p', '/usage', '--output-format', 'json'],
      cwd: this.cwd,
      timeoutMs: this.timeoutMs,
    })) {
      if (line.kind === 'json') {
        lastJson = line.value;
      } else if (line.kind === 'stderr') {
        stderrText += line.line + '\n';
      } else if (line.kind === 'exit') {
        exitCode = line.code;
      }
    }

    if (lastJson) {
      return parseAgyUsage(lastJson, this.agentId, undefined, { model: this.model });
    }

    return quotaSnapshotSchema.parse({
      agentId: this.agentId,
      method: 'agy-usage',
      takenAt: new Date().toISOString(),
      buckets: [],
      stale: true,
      error: `No se pudo obtener el cupo de agy (exit code: ${exitCode}): ${stderrText.trim()}`,
    });
  }
}
