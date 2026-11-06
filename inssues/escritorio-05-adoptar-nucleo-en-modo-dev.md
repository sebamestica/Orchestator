# Con ORQ_UI_DEV=1, Berland adopta un núcleo que no acepta el origen 5174: la interfaz carga, pero /ws y todo POST o PATCH responden 403

- **Área:** Escritorio y arranque
- **Severidad:** baja
- **Archivos:** `apps/desktop/src/core-supervisor.ts:205`, `apps/desktop/src/core-supervisor.ts:162`, `apps/desktop/src/core-supervisor.ts:139`, `apps/desktop/src/lib/config.ts:101`, `src/ui/vite.config.ts:27`, `src/core/server/security.ts:61`, `src/core/server/app.ts:195`
- **Estado:** abierta

## Cómo ocurre

Contexto. Con `ORQ_UI_DEV=1` (`npm run desktop:dev`, `package.json:19`) la ventana carga la interfaz desde Vite en `http://127.0.0.1:5174` (`apps/desktop/src/lib/config.ts:66`). Llega al núcleo por el proxy `/__core` de Vite (`config.ts:101`: `url: '/__core'`, `wsUrl: 'ws://127.0.0.1:5174/__core/ws'`). El núcleo aplica `originGuard` a todas las rutas, `/ws` incluido (`src/core/server/app.ts:195`). Si una petición trae `Origin`, solo pasa cuando ese origen es el del propio núcleo o está en `ORQ_ALLOWED_ORIGINS`:

```ts
// src/core/server/security.ts:58-61
const raw = c.req.header('origin');
if (raw !== undefined) {
  const origin = raw.trim().toLowerCase();
  if (!allowed.has(origin) && origin !== ownOrigin(hostOf(c))) throw new ApiError(403, 'forbidden_origin', 'Origen no permitido');
```

El origen de desarrollo solo se agrega cuando Berland lanza el núcleo ella misma:

```ts
// apps/desktop/src/core-supervisor.ts:205
const allowedOrigins = config.uiDev ? [origin, UI_DEV_ORIGIN] : [origin];
```

Pasos:

1. Se abre Berland normal (`npm run desktop` o `Berland.lnk`). `launch()` arranca el núcleo con `ORQ_ALLOWED_ORIGINS` igual a solo `http://127.0.0.1:47811`, más lo que el usuario ya tuviera en esa variable (`core-supervisor.ts:205`, `apps/desktop/src/lib/node-path.ts:62-64`). Guarda la sesión cifrada, que contiene `port`, `pid`, `token` y `startedAt` pero no los orígenes (`apps/desktop/src/lib/session-file.ts:14-19`).
2. Se cierra la ventana con una tarea o un chat de la mente en curso. `decideOnClose` deja vivo el núcleo (`apps/desktop/src/lib/shutdown-policy.ts:25-27`). Lo mismo pasa si el cierre supera `CLOSE_TIMEOUT_MS` (`apps/desktop/src/main.ts:184`).
3. Se corren `npm run dev:ui` y `npm run desktop:dev`. Las dos variantes comparten `dataDir`, así que leen la misma `session.json` y el mismo perfil de `safeStorage` (`config.ts:80-81`, `main.ts:273`).
4. `doConnect` → `probeCore` responde `alive` → `adopt()` (`core-supervisor.ts:159`). `adopt()` comprueba el token con `runningTasks` y reutiliza el núcleo (`core-supervisor.ts:165-169`). No comprueba si acepta `http://127.0.0.1:5174`: `runningTasks` hace `GET` desde el proceso principal sin encabezado `Origin` (`apps/desktop/src/lib/core-client.ts:55`), así que siempre pasa la guardia.
5. La ventana carga `http://127.0.0.1:5174/`. Los `GET` del mismo origen (`fetch('/__core/...')`) van sin `Origin` y funcionan. Chromium sí manda `Origin` en el handshake del WebSocket y en todo `POST`, `PATCH` o `DELETE`. El proxy de Vite solo reescribe `Host` con `changeOrigin: true` (`src/ui/vite.config.ts:27`). Vite 8.3.5 reescribe `Origin` únicamente con la opción `rewriteWsOrigin`, y solo para WebSocket (`node_modules/vite/dist/node/chunks/node.js:19870-19880`), y aquí no está activada. El núcleo recibe `Host: 127.0.0.1:47811` y `Origin: http://127.0.0.1:5174`. `ownOrigin` da `http://127.0.0.1:47811`, el origen no está en la lista y la respuesta es `403 forbidden_origin`.

Resultado: la interfaz aparece, pero sin actualizaciones en vivo (`/ws` rechazado), y no se pueden mandar mensajes, aprobar, crear ni editar nada.

Pasa lo mismo con `ORQ_CORE_TOKEN` (`core-supervisor.ts:139-143`): se acepta un núcleo externo con solo validar el token, aunque se haya arrancado sin `ORQ_ALLOWED_ORIGINS=http://127.0.0.1:5174`.

Las pruebas no lo cubren. `tests/desktop/core-supervisor.test.ts` usa un `fakeFetch` que ignora `Origin`, y el caso de adopción (líneas 162-172) usa una configuración sin `ORQ_UI_DEV`. `tests/desktop/fake-core.ts` tampoco aplica la guardia de origen. Ninguno de los issues de `docs/plan/issues/` toca esta parte.

## Por qué pasa

Los orígenes que acepta un núcleo se fijan al lanzarlo, por entorno, y no se pueden consultar ni cambiar después. `CoreSupervisor` solo los ajusta en `launch()`. En los dos caminos que reutilizan un núcleo existente (`adopt()` con la sesión y `ORQ_CORE_TOKEN`) valida el token pero no el origen que usará la ventana (`config.appOrigin`). La comprobación del token tampoco puede detectarlo, porque se hace desde Node sin `Origin`.

## Solución posible

En `apps/desktop/src/lib/core-client.ts`, agregar una sonda de origen. `originGuard` corre antes de `bearerAuth` (`app.ts:194-215`), así que basta un `GET /health` con `Origin: <appOrigin>`:

```ts
export async function acceptsOrigin(origin: string, appOrigin: string, fetchImpl: FetchLike, timeoutMs = 3000): Promise<'yes' | 'no' | 'error'> {
  // 403 forbidden_origin = el núcleo rechazará el /ws y los POST de la ventana; 200/401 = la guardia lo deja pasar.
}
```

El `fetch` de Node (undici) permite poner `Origin`, y `FetchLike` ya acepta `headers`.

En `apps/desktop/src/core-supervisor.ts`, con `config.uiDev` (o, de forma general, cuando `config.appOrigin !== origin`), llamar a la sonda antes de `this.connected(...)` en `adopt()` (línea 169) y en la rama `ORQ_CORE_TOKEN` (línea 143). Si responde `no`, devolver `{ ok: false, ... }` con un mensaje claro, que `main.ts:233-235` ya muestra como página de estado. Por ejemplo: «Este núcleo no acepta la interfaz de desarrollo (5174)», con la pista «Ciérralo desde Berland sin -dev cuando terminen sus tareas, o arráncalo a mano con ORQ_ALLOWED_ORIGINS=http://127.0.0.1:5174 y usa ORQ_CORE_TOKEN». En el caso adoptado no conviene reiniciar el núcleo solo: tiene tareas en curso.

### Otras opciones

- **Guardar los orígenes en la sesión.** Agregar `allowedOrigins` a `CoreSession` (`session-file.ts`) al lanzar y compararlo en `adopt()`. Evita una petición, pero no sirve para `ORQ_CORE_TOKEN` y obliga a migrar el formato `v: 1`. La sonda mide lo que el núcleo acepta de verdad y cubre los dos caminos.
- **Reescribir `Origin` en el proxy de Vite** (`src/ui/vite.config.ts:27`): `rewriteWsOrigin: true` para el WebSocket y `configure: (proxy) => proxy.on('proxyReq', (r) => r.setHeader('origin', core))` para HTTP. Arregla el modo dev con cualquier núcleo y sin tocar el escritorio. A cambio, el servidor de Vite pasa a ser un puente que anula la defensa por origen: cualquier página que pueda hablar con 5174 llegaría al núcleo con el origen propio de este. El token bearer sigue exigido, así que el riesgo es acotado, pero se pierde una capa.
- **Lanzar siempre el núcleo aceptando también 5174**, aunque no sea modo dev. Es lo más simple, pero amplía la superficie del núcleo normal para un caso que solo existe al desarrollar.

La propuesta no es la única. Si se quiere tocar lo menos posible, puede bastar la sonda con su mensaje claro. La opción del proxy es más cómoda para quien desarrolla, pero cuesta en seguridad.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:** en `tests/desktop/core-supervisor.test.ts`, extender `fakeFetch` con `allowedOrigins?: string[]`. Si `init.headers?.Origin` existe y no está en la lista ni es `http://127.0.0.1:${PORT}`, debe responder `{ status: 403, json: async () => ({ error: { code: 'forbidden_origin' } }) }`. Escenarios:
  1. Configuración con `ORQ_UI_DEV: '1'`, sesión válida escrita con `encodeSession` (como en la línea 164) y `fakeFetch({ up: true, running: 1 })` sin 5174. `connect()` debe devolver `ok: false`, con un título que mencione 5174 o el origen de desarrollo, y no debe lanzar nada (`spawned.command` sin definir). Hoy devuelve `ok: true, ownership: 'adopted'`.
  2. Lo mismo con `allowedOrigins: ['http://127.0.0.1:5174']`: `connect()` debe devolver `ok: true, ownership: 'adopted'`.
  3. `ORQ_UI_DEV: '1'` con `ORQ_CORE_TOKEN` y un núcleo sin 5174: `ok: false`.
  4. Sin `ORQ_UI_DEV`: la adopción sigue igual que en la prueba actual (líneas 162-172).
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/desktop/core-supervisor.test.ts"` (o, desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/desktop/core-supervisor.test.ts`).
- **Verificación manual:** abrir Berland normal, lanzar una tarea larga y cerrar la ventana (el núcleo sigue vivo). Luego correr `npm run dev:ui` y `npm run desktop:dev`. Hoy la interfaz carga, y en DevTools (pestaña Network) se ven `403` en `/__core/ws` y en cualquier `POST`. Con el arreglo debe aparecer la página de estado con la explicación y la salida.
