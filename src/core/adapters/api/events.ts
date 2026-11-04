import type { AgentEvent, ErrorCode, Usage } from '../../../shared/index.ts';
import { agentEventSchema, redactSecrets } from '../../../shared/index.ts';

type Payload<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>['payload'];
type SessionState = Payload<'status'>['state'];

export interface EventFactoryOptions {
  sessionId: string;
  agentId: string;
  now: () => Date;
  /** Secretos extra que se tachan en todo texto (la clave y los valores de `ctx.env`). */
  secrets: readonly string[];
}

/** Tacha recursivamente todo texto de un valor JSON simple. */
function redactDeep<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === 'string') return redactSecrets(value, secrets) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => redactDeep(v, secrets)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, secrets);
    return out as T;
  }
  return value;
}

/**
 * Los proveedores transmiten el texto en fragmentos de pocos caracteres: una clave repetida por el modelo puede quedar
 * partida entre dos eventos y escapar del tachado por evento. Este búfer tacha el texto acumulado y solo retiene la cola
 * que coincide con el comienzo de alguna clave conocida, así que ninguna sale partida y el resto fluye sin demora.
 */
export class RedactingTextBuffer {
  readonly #secrets: readonly string[];
  #pending = '';

  constructor(secrets: readonly string[]) {
    // Mismo umbral que redactSecrets: los valores cortos no se tratan como secretos.
    this.#secrets = secrets.filter((s) => s.length >= 8);
  }

  /** Agrega un fragmento y devuelve la parte que ya se puede emitir (tachada). */
  push(text: string): string {
    const pending = redactSecrets(this.#pending + text, this.#secrets);
    const hold = this.#partialTail(pending);
    this.#pending = pending.slice(pending.length - hold);
    return pending.slice(0, pending.length - hold);
  }

  /** Lo retenido, al terminar (o cortarse) la transmisión. */
  flush(): string {
    const rest = redactSecrets(this.#pending, this.#secrets);
    this.#pending = '';
    return rest;
  }

  /** Largo del sufijo más largo de `text` que es prefijo propio de alguna clave. */
  #partialTail(text: string): number {
    let hold = 0;
    for (const secret of this.#secrets) {
      for (let k = Math.min(secret.length - 1, text.length); k > hold; k--) {
        if (text.endsWith(secret.slice(0, k))) {
          hold = k;
          break;
        }
      }
    }
    return hold;
  }
}

/**
 * Crea eventos normalizados con `seq` creciente: cada uno pasa por `redactSecrets` y por `agentEventSchema`
 * antes de salir del adaptador.
 */
export class EventFactory {
  readonly #opts: EventFactoryOptions;
  #seq = 0;

  constructor(opts: EventFactoryOptions) {
    this.#opts = opts;
  }

  get sessionId(): string {
    return this.#opts.sessionId;
  }

  status(state: SessionState, detail?: string): AgentEvent {
    return this.#make('status', detail === undefined ? { state } : { state, detail });
  }

  text(text: string, role: Payload<'text'>['role'] = 'assistant'): AgentEvent {
    return this.#make('text', { text, role });
  }

  usage(usage: Usage): AgentEvent {
    return this.#make('usage', usage);
  }

  error(code: ErrorCode, message: string): AgentEvent {
    return this.#make('error', { code, message });
  }

  done(ok: boolean, summary?: string): AgentEvent {
    return this.#make('done', summary === undefined ? { ok } : { ok, summary });
  }

  #make<T extends AgentEvent['type']>(type: T, payload: Payload<T>): AgentEvent {
    const event = {
      sessionId: this.#opts.sessionId,
      agentId: this.#opts.agentId,
      seq: this.#seq++,
      ts: this.#opts.now().toISOString(),
      type,
      payload: redactDeep(payload, this.#opts.secrets),
    };
    return agentEventSchema.parse(event);
  }
}
