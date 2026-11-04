/** Conexión en vivo simulada (sustituye a `getLive()` de src/ui/api/live.ts en las pruebas). */
import { vi } from 'vitest';
import type { LiveMessage, LiveStatus } from '../../../src/ui/api/live.ts';

export class FakeLive {
  status: LiveStatus = 'open';
  readonly listeners = new Set<(m: LiveMessage) => void>();
  readonly statusListeners = new Set<(s: LiveStatus) => void>();
  readonly replay = vi.fn((_sessionId: string, _since?: number, _limit?: number) => undefined);

  subscribe(listener: (m: LiveMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (s: LiveStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  emit(message: LiveMessage): void {
    for (const l of this.listeners) l(message);
  }

  setStatus(status: LiveStatus): void {
    this.status = status;
    for (const l of this.statusListeners) l(status);
  }
}

let current = new FakeLive();

export function resetFakeLive(): FakeLive {
  current = new FakeLive();
  return current;
}

export function getFakeLive(): FakeLive {
  return current;
}
