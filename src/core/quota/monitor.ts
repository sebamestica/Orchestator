import { z } from 'zod';
import { decidingBuckets, minRemainingFraction, quotaSnapshotSchema } from '../../shared/quota.ts';
import { redactSecrets } from '../../shared/index.ts';
import type { QuotaSnapshot } from '../../shared/quota.ts';
import type { QuotaProvider } from '../../shared/contracts.ts';

export interface QuotaAlert {
  agentId: string;
  groupId: string;
  window: QuotaSnapshot['buckets'][number]['window'];
  threshold: number;
  remainingFraction: number;
  takenAt: string;
}

export interface QuotaMonitorOptions {
  intervalMs?: number;
  thresholds?: number[];
  now?: () => Date;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  onSnapshot?: (snapshot: QuotaSnapshot) => void;
  onAlert?: (alert: QuotaAlert) => void;
}

/** Arranca la lectura periódica al construirlo; refresh permite la primera lectura inmediata. */
export class QuotaMonitor {
  private readonly providers = new Map<string, QuotaProvider>();
  private readonly snapshots = new Map<string, QuotaSnapshot>();
  private readonly pending = new Map<string, Promise<QuotaSnapshot>>();
  private readonly crossed = new Set<string>();
  private readonly thresholds: number[];
  private readonly options: QuotaMonitorOptions;
  private timer: unknown;
  private stopped = false;

  constructor(providers: Iterable<QuotaProvider>, options: QuotaMonitorOptions = {}) {
    this.options = options;
    this.thresholds = [...new Set(z.array(z.number().min(0).max(1)).parse(options.thresholds ?? [0.25, 0.1]))];
    const interval = z.number().int().positive().max(2_147_483_647).parse(options.intervalMs ?? 300_000);
    for (const provider of providers) {
      if (this.providers.has(provider.agentId)) throw new Error('Proveedor de cupo duplicado');
      this.providers.set(provider.agentId, provider);
    }
    if ((options.setInterval === undefined) !== (options.clearInterval === undefined)) throw new Error('Inyectar ambos temporizadores');
    this.timer = (options.setInterval ?? ((callback, ms) => setInterval(callback, ms)))(() => { void this.refresh(); }, interval);
  }

  latest(agentId: string): QuotaSnapshot | undefined {
    const snapshot = this.snapshots.get(agentId);
    return snapshot && structuredClone(snapshot);
  }

  all(): QuotaSnapshot[] { return [...this.snapshots.values()].map((snapshot) => structuredClone(snapshot)); }

  refresh(agentId: string): Promise<QuotaSnapshot>;
  refresh(): Promise<QuotaSnapshot[]>;
  refresh(agentId?: string): Promise<QuotaSnapshot> | Promise<QuotaSnapshot[]> {
    if (agentId === undefined) return Promise.all([...this.providers.keys()].map((id) => this.refresh(id)));
    const pending = this.pending.get(agentId);
    if (pending) return pending;
    const provider = this.providers.get(agentId);
    if (!provider) return Promise.reject<QuotaSnapshot>(new Error('Proveedor de cupo desconocido'));
    // Diferir read también captura throws síncronos y registra la promesa antes de invocarlo.
    const promise = Promise.resolve().then(async () => {
      let snapshot: QuotaSnapshot;
      try {
        snapshot = quotaSnapshotSchema.parse(await provider.read());
        if (snapshot.agentId !== agentId) throw new Error('El cupo pertenece a otro agente');
        if (snapshot.error !== undefined) throw new Error(snapshot.error);
        this.checkAlerts(snapshot);
      } catch (error: unknown) {
        const previous = this.snapshots.get(agentId);
        snapshot = { ...(previous ?? { agentId, method: 'none', takenAt: (this.options.now ?? (() => new Date()))().toISOString(), buckets: [] }),
          stale: true, error: redactSecrets(error instanceof Error ? error.message : 'Error al leer el cupo') };
      }
      this.snapshots.set(agentId, structuredClone(snapshot));
      this.notify(() => this.options.onSnapshot?.(structuredClone(snapshot)));
      return snapshot;
    }).finally(() => { this.pending.delete(agentId); });
    this.pending.set(agentId, promise);
    return promise;
  }

  onTaskDone(agentId: string): Promise<QuotaSnapshot> { return this.refresh(agentId); }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    (this.options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>)))(this.timer);
    this.timer = undefined;
  }

  private notify(callback: () => void): void {
    try { callback(); } catch { /* Un consumidor no debe interrumpir las lecturas. */ }
  }

  private checkAlerts(snapshot: QuotaSnapshot): void {
    if (minRemainingFraction(snapshot) === null) return;
    for (const bucket of decidingBuckets(snapshot)) {
      const remaining = bucket.remainingFraction;
      if (remaining === null) continue;
      for (const threshold of this.thresholds) {
        const key = JSON.stringify([snapshot.agentId, bucket.groupId, bucket.window, threshold]);
        if (remaining > threshold) { this.crossed.delete(key); continue; }
        if (this.crossed.has(key)) continue;
        this.crossed.add(key);
        this.notify(() => this.options.onAlert?.({ agentId: snapshot.agentId, groupId: bucket.groupId, window: bucket.window,
          threshold, remainingFraction: remaining, takenAt: snapshot.takenAt }));
      }
    }
  }
}

