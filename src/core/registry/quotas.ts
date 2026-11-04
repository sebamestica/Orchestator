import { quotaSnapshotSchema, redactSecrets, type QuotaSnapshot } from '../../shared/index.ts';
import { redactDeep, type AgentRecord } from '../store/index.ts';
import type { AgentRegistry, QuotaProviderFactory } from './registry.ts';

export interface QuotaRefreshError {
  agentId: string;
  message: string;
}

export interface QuotaRefreshResult<R> {
  quotas: R[];
  errors: QuotaRefreshError[];
}

export interface QuotaRefresherOptions<R> {
  registry: Pick<AgentRegistry, 'list' | 'require' | 'secretsFor'>;
  factory: QuotaProviderFactory;
  /** Guarda y difunde la foto (p. ej. `EventHub.publishQuota`). */
  publish: (snapshot: QuotaSnapshot) => R;
  timeoutMs?: number;
}

/**
 * Lee el cupo de los agentes habilitados con los `QuotaProvider` de la fábrica inyectada.
 * Los fallos de un agente no detienen a los demás; sus mensajes se tachan.
 */
export class QuotaRefresher<R> {
  private readonly opts: QuotaRefresherOptions<R>;
  private running: Promise<QuotaRefreshResult<R>> | undefined;

  constructor(opts: QuotaRefresherOptions<R>) {
    this.opts = opts;
  }

  /** Con `agentId` lee solo ese agente (aunque esté deshabilitado). Las lecturas completas no se solapan. */
  refresh(agentId?: string): Promise<QuotaRefreshResult<R>> {
    if (agentId) return this.run([this.opts.registry.require(agentId)]);
    this.running ??= this.run(this.opts.registry.list().filter((a) => a.config.enabled)).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(agents: AgentRecord[]): Promise<QuotaRefreshResult<R>> {
    const results = await Promise.all(agents.map((a) => this.readOne(a)));
    const quotas: R[] = [];
    const errors: QuotaRefreshError[] = [];
    for (const r of results) {
      if (!r) continue;
      if ('error' in r) errors.push(r.error);
      else quotas.push(r.quota);
    }
    return { quotas, errors };
  }

  private async readOne(agent: AgentRecord): Promise<{ quota: R } | { error: QuotaRefreshError } | undefined> {
    const timeoutMs = this.opts.timeoutMs ?? 30_000;
    let secrets: { apiKey?: string } = {};
    let timer: NodeJS.Timeout | undefined;
    try {
      secrets = await this.opts.registry.secretsFor(agent.config);
      const provider = await this.opts.factory(agent, secrets);
      if (!provider) return undefined;
      const raw = await Promise.race([
        provider.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`sin respuesta en ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
      const parsed = quotaSnapshotSchema.safeParse(raw);
      if (!parsed.success) throw new Error('foto de cupo inválida');
      // La foto viene de otro módulo (y a veces del proveedor): se tacha también con la clave conocida,
      // que puede ser opaca y no coincidir con ningún patrón.
      const snapshot = redactDeep({ ...parsed.data, agentId: agent.config.id }, secrets.apiKey ? [secrets.apiKey] : []);
      return { quota: this.opts.publish(snapshot) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: { agentId: agent.config.id, message: redactSecrets(msg, secrets.apiKey ? [secrets.apiKey] : []).slice(0, 300) } };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
