import type { AddressInfo } from 'node:net';
import { createAdaptorServer, type ServerType, type WebSocketServerLike } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { LOOPBACK_HOST } from '../config/index.ts';
import { createApp, type AppDeps, type CoreApp } from './app.ts';
import { loopbackHosts } from './security.ts';

export interface StartServerOptions extends Omit<AppDeps, 'allowedHosts'> {
  /** Puerto (0 = uno libre, útil en pruebas). Siempre se escucha en 127.0.0.1. */
  port: number;
  /** Tamaño máximo de un mensaje WebSocket del cliente. */
  maxWsPayloadBytes?: number;
}

export interface RunningServer {
  url: string;
  wsUrl: string;
  host: typeof LOOPBACK_HOST;
  port: number;
  core: CoreApp;
  server: ServerType;
  close(): Promise<void>;
}

/** Levanta la API local en 127.0.0.1 (REST + `/ws`). Nunca en otra interfaz. */
export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  let port = opts.port;
  const core = createApp({ ...opts, allowedHosts: () => loopbackHosts(port) });
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxWsPayloadBytes ?? 64 * 1024 });
  const server = createAdaptorServer({
    fetch: core.app.fetch,
    hostname: LOOPBACK_HOST,
    websocket: { server: wss as unknown as WebSocketServerLike },
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(opts.port, LOOPBACK_HOST, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  port = address.port;
  // Solo ahora este proceso es el núcleo: si `listen` falló (p. ej. EADDRINUSE), la base del núcleo vivo sigue intacta.
  core.recover();
  let closed: Promise<void> | undefined;
  return {
    url: `http://${LOOPBACK_HOST}:${port}`,
    wsUrl: `ws://${LOOPBACK_HOST}:${port}/ws`,
    host: LOOPBACK_HOST,
    port,
    core,
    server,
    close() {
      closed ??= (async () => {
        // Los sockets ya actualizados a WebSocket no los sigue el servidor HTTP: se esperan aparte
        // para que sus manejadores `close` (que se desuscriben del hub) hayan corrido al terminar.
        const clientsClosed = [...wss.clients].map(
          (client) => new Promise<void>((resolve) => {
            if (client.readyState === client.CLOSED) resolve();
            else client.once('close', () => resolve());
          }),
        );
        const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const client of wss.clients) client.terminate();
        wss.close();
        if ('closeAllConnections' in server) server.closeAllConnections();
        await Promise.all([...clientsClosed, serverClosed]);
      })();
      return closed;
    },
  };
}
