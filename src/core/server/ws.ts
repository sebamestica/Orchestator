import { upgradeWebSocket } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';
import { redactDeep, type SqliteStore } from '../store/index.ts';
import { ApiError } from './errors.ts';
import { clientMessageSchema, type EventHub, type HubMessage } from './hub.ts';
import { offeredProtocols, WS_PROTOCOL } from './security.ts';

export interface WsDeps {
  hub: EventHub;
  store: Pick<SqliteStore, 'eventsPage'>;
  version: string;
  now: () => Date;
}

const OPEN = 1;

/**
 * `/ws`: al conectar envía `hello` y luego todo lo que publica el hub (eventos, cupos, tareas, agentes).
 * El cliente puede pedir `{"type":"replay","sessionId":"…","since":<seq>}` para recuperar lo perdido
 * tras reconectar (los eventos en vivo pueden llegar antes que la respuesta: deduplicar por `seq`).
 * La autenticación y el Host se comprueban antes, en el handshake HTTP (`Authorization: Bearer` o, desde el
 * navegador, el subprotocolo `orq, orq.bearer.<token>`). Con subprotocolos, el primero debe ser `orq`: `ws` responde
 * el primero que se ofrece, así el token nunca vuelve en la respuesta.
 */
export function createWsHandlers(deps: WsDeps): MiddlewareHandler[] {
  const requireUpgrade: MiddlewareHandler = async (c, next) => {
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      throw new ApiError(426, 'upgrade_required', 'Conecta por WebSocket (Upgrade: websocket)');
    }
    const protocols = offeredProtocols(c.req.header('sec-websocket-protocol'));
    if (protocols.length > 0 && protocols[0] !== WS_PROTOCOL) {
      throw new ApiError(400, 'invalid_request', `Subprotocolo no admitido: ofrece primero «${WS_PROTOCOL}»`);
    }
    const env: unknown = c.env;
    if (typeof env !== 'object' || env === null || !('incoming' in env)) {
      throw new ApiError(501, 'not_configured', 'WebSocket disponible solo en el servidor HTTP');
    }
    await next();
  };

  const upgrade = upgradeWebSocket(() => {
    let unsubscribe: (() => void) | undefined;
    return {
      onOpen(_evt, ws) {
        const send = (message: HubMessage) => {
          if (ws.readyState === OPEN) ws.send(JSON.stringify(redactDeep(message)));
        };
        send({ type: 'hello', serverTime: deps.now().toISOString(), version: deps.version });
        unsubscribe = deps.hub.subscribe(send);
      },
      onMessage(evt, ws) {
        const send = (message: HubMessage) => {
          if (ws.readyState === OPEN) ws.send(JSON.stringify(redactDeep(message)));
        };
        let data: unknown;
        try {
          data = typeof evt.data === 'string' ? JSON.parse(evt.data) : undefined;
        } catch {
          data = undefined;
        }
        const parsed = clientMessageSchema.safeParse(data);
        if (!parsed.success) {
          send({ type: 'error', error: { code: 'invalid_request', message: 'Mensaje inválido: usa {"type":"replay",…} o {"type":"ping"}' } });
          return;
        }
        const msg = parsed.data;
        if (msg.type === 'ping') {
          send({ type: 'pong' });
          return;
        }
        send({ type: 'replay', sessionId: msg.sessionId, ...deps.store.eventsPage(msg.sessionId, msg.since ?? -1, msg.limit ?? 500) });
      },
      onClose() {
        unsubscribe?.();
        unsubscribe = undefined;
      },
      onError() {
        unsubscribe?.();
        unsubscribe = undefined;
      },
    };
  });

  return [requireUpgrade, upgrade];
}
