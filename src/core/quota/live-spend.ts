/**
 * Gasto en curso de los procesos vivos que cobran a la clave de un agente (sesiones de la mente y ejecuciones Claude de
 * la flota): lo que cada uno lleva gastado desde su último `usage` guardado en SQLite. Sumado al gasto registrado da el
 * saldo común en vivo, para que dos procesos a la vez no reciban el mismo saldo.
 */

export interface LiveSpendEntry {
  /** Gasto del proceso que aún no está guardado en SQLite (USD; lo no finito o negativo cuenta como 0). */
  set(usd: number): void;
  /** El proceso terminó: lo suyo ya quedó guardado (o se perdió con él). */
  close(): void;
}

export class LiveSpend {
  readonly #open = new Map<string, Set<{ usd: number }>>();

  /** Abre la cuenta en curso de un proceso que gasta con la clave de `agentId`. */
  open(agentId: string): LiveSpendEntry {
    const slot = { usd: 0 };
    const slots = this.#open.get(agentId) ?? new Set();
    this.#open.set(agentId, slots);
    slots.add(slot);
    return {
      set: (usd) => {
        slot.usd = Number.isFinite(usd) && usd > 0 ? usd : 0;
      },
      close: () => {
        slots.delete(slot);
        if (!slots.size && this.#open.get(agentId) === slots) this.#open.delete(agentId);
      },
    };
  }

  /** Suma de lo que llevan sin guardar los procesos vivos de `agentId`. */
  inFlightUsd(agentId: string): number {
    let sum = 0;
    for (const slot of this.#open.get(agentId) ?? []) sum += slot.usd;
    return sum;
  }
}
