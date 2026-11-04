# API local del orquestador: OpenAPI y Postman

Esta carpeta documenta la API REST + WebSocket del núcleo, que escucha solo en `127.0.0.1` (puerto 47811 por defecto).

| Archivo | Para qué sirve |
|---|---|
| `orquestador.postman_collection.json` | Colección de Postman v2.1, con las peticiones agrupadas por tema, ejemplos de cuerpo y de respuesta, y autenticación `Bearer {{token}}` definida en la colección. |
| `openapi.json` | Especificación OpenAPI 3.1, con los esquemas de entrada y salida, los errores y los ejemplos. |
| `generate.ts` | Script que genera los dos archivos anteriores. |
| `source.ts` | Lee las rutas reales del servidor: `createApp(...).routes` de `src/core/server/`, con SQLite y bóveda en memoria, sin escuchar en ningún puerto. |
| `routes.ts` | Lo que solo necesita la documentación: valores de los parámetros de ruta, respuestas de ejemplo y scripts de Postman. Tiene una entrada por cada ruta del servidor, y la generación falla si alguna sobra o falta. |
| `schemas.ts`, `examples.ts`, `build.ts` | Ids de componente y descripciones para los esquemas Zod del servidor (que usan los contratos de `src/shared/`), los datos de ejemplo (cada uno se valida contra el esquema del servidor) y el armado de los dos archivos con `z.toJSONSchema`. |

Rutas, esquemas, códigos de estado, códigos de error y ejemplos de petición salen del servidor. Si el servidor cambia, las pruebas de `tests/docs/` fallan hasta que se regenere. Los JSON se generan con el script: no los edites a mano. Para regenerarlos o comprobar que están al día:

```bash
scripts/win.sh "node docs/api/generate.ts"           # escribe openapi.json y la colección
scripts/win.sh "node docs/api/generate.ts --check"   # falla si no están al día (no escribe nada)
```

En PowerShell, desde la raíz del repo, el comando es `node docs/api/generate.ts`. El aviso `ExperimentalWarning: SQLite` que aparece al ejecutarlo es normal.

Pruebas: `tests/docs/api.test.ts` compara los dos JSON con el generador y `openapi.json` con `createApp(...).routes`. `tests/docs/postman-run.test.ts` ejecuta cada petición de la colección contra el servidor real en proceso.

## 1. Importar en Postman

1. En Postman abre **Import**, elige `docs/api/orquestador.postman_collection.json` y se crea la colección **Orquestador — API local**. Si la importas otra vez después de regenerarla, Postman la reemplaza porque el id de la colección es fijo.
2. Abre la colección y entra en la pestaña **Variables**:
   - `baseUrl` vale `http://127.0.0.1:47811`. Cámbiala solo si arrancas el núcleo con otro puerto (`ORQ_PORT`).
   - `token` empieza vacía. Lo que va ahí se explica en el paso 2.
   - `apiKey` empieza vacía y solo se usa en `POST /agents`.
   - `agentId`, `projectId`, `planId`, `taskId`, `sessionId` y `skillName` son los valores de los parámetros de ruta (`/agents/:id`, …). `POST /agents`, `POST /plans` y `POST /tasks` los actualizan solos con el id que devuelve el servidor.

No hace falta importar `openapi.json` para usar la colección. Si lo importas, Postman crea una segunda colección con las mismas rutas.

## 2. Conseguir el token

El núcleo genera un token aleatorio cada vez que arranca y lo imprime en una línea JSON por la salida estándar. Desde la raíz del repo, en PowerShell:

```powershell
node src/core/main.ts
```

```json
{"ready":true,"url":"http://127.0.0.1:47811","wsUrl":"ws://127.0.0.1:47811/ws","token":"…"}
```

Copia el valor de `token` en la variable `token` de la colección, en la columna **Current value**. El valor actual queda solo en tu equipo: Postman no lo sincroniza ni lo exporta. Todas las peticiones heredan la autenticación de la colección (`Authorization: Bearer {{token}}`). Cuando reinicies el núcleo, el token cambia y hay que volver a copiarlo.

Los registros del núcleo salen por la salida de errores y nunca incluyen el token, los encabezados ni los cuerpos de las peticiones.

## 3. Prueba rápida con `/health`

En Postman abre **Sistema → /health** y pulsa **Send**. La respuesta esperada es:

```json
{ "ok": true, "version": "0.1.0", "startedAt": "2026-11-01T21:30:00.000Z", "uptimeMs": 93500 }
```

Como todas las rutas, `/health` exige el token. Un `200` confirma a la vez que el núcleo está arriba y que el token es válido. Si responde `401 unauthorized`, el token falta o es de un arranque anterior. Si no responde nada, el núcleo no está corriendo o usa otro puerto.

Lo mismo con `curl.exe` en PowerShell:

```powershell
curl.exe -s -H "Authorization: Bearer <token>" http://127.0.0.1:47811/health
```

## 4. Agregar un agente con tu clave

1. Pon la clave en la variable `apiKey`, solo en **Current value**.
2. Envía **Agentes → /agents** (POST). El cuerpo ya usa `"apiKey": "{{apiKey}}"`. El núcleo guarda la clave en la bóveda (DPAPI de Windows), prueba el agente y responde `201` con el agente y el resultado de la prueba.
3. La respuesta **nunca** trae la clave, solo `secretRef`, que es la referencia en la bóveda. La pestaña **Tests** de la petición lo comprueba.
4. Cuando termines, borra el valor de `apiKey`.

Codex y agy no necesitan clave: **Agentes → /agents/detect** los busca y registra los que encuentre.

## 5. Flujo típico

1. `POST /projects`: registra el repo (`id`, `name`, `repoPath`) y, para que la flota pueda trabajar en él, `workspace` con los enlaces, `postCreate` y el `gate` (obligatorio). Sin `workspace`, la flota rechaza las tareas del proyecto. Receta completa: [docs/proyectos/vetworld.md](../proyectos/vetworld.md).
2. `POST /plans`: envía `{ "projectId", "text" }` con el plan en texto. Devuelve las tareas propuestas en estado `pending` y guarda `planId` y `taskId`.
3. `GET /plans/:id` revisa el plan. Después, `POST /plans/:id/approve` aprueba todas las tareas, o `POST /tasks/:id/approve` aprueba una (con `agentId` opcional para fijar el agente).
4. `GET /sessions?taskId=…` y después `GET /sessions/:id/events?since=-1` muestran los eventos. Para pedir solo los nuevos, repite con `since` igual al `lastSeq` de la respuesta anterior mientras `hasMore` sea `true`.
5. `GET /quotas` muestra el cupo restante, y `POST /quotas/refresh` lo vuelve a leer en el momento.
6. `GET /usage?groupBy=agent,day` da los tokens y el costo por agente y por día (`groupBy` acepta `agent`, `day`, `session` y `model`).

## 6. WebSocket `/ws`

Las colecciones v2.1 no guardan peticiones WebSocket, así que esta se crea a mano en Postman con **New → WebSocket**:

- URL: `ws://127.0.0.1:47811/ws`
- Encabezado: `Authorization: Bearer <token>`

`/ws` exige el token en el handshake: en el encabezado `Authorization` (Postman, Node con `ws`, proceso principal de Electron) o, desde el navegador, que no puede mandar encabezados, como subprotocolo `Sec-WebSocket-Protocol: orq, orq.bearer.<token>` (`orq` primero; el servidor responde `orq`). El token nunca va en la URL, y el servidor tampoco lo acepta en una cookie ni en la consulta.

Al conectar, el servidor envía `{"type":"hello",…}`. Luego transmite `event`, `quota`, `task`, `agent` y `agent_deleted` a medida que ocurren. Tú puedes enviar dos mensajes:

- `{"type":"ping"}`: el servidor responde `{"type":"pong"}`.
- `{"type":"replay","sessionId":"…","since":5}`: el servidor responde `{"type":"replay","events":[…],"lastSeq":…,"hasMore":…}` con los eventos que te perdiste. Los eventos en vivo pueden llegar antes que esa respuesta, así que descarta los duplicados por `seq`.

La forma de cada mensaje está en `openapi.json`, en los esquemas `WsServerMessage` y `WsClientMessage`.

## 6b. Interfaz web

`GET /`, `/index.html` y `/assets/*` sirven la interfaz compilada (`dist/ui`, o la carpeta de `ORQ_UI_DIR`) **sin token**: solo archivos estáticos, sin listar carpetas ni seguir `..`. Todo lo demás sigue exigiendo el token. `node src/core/app/cli.ts iniciar` imprime el enlace `web: http://127.0.0.1:47811/#t=<token>` (con `--abrir` lo abre en el navegador predeterminado): la interfaz toma el token del fragmento, lo borra de la barra y lo guarda solo en `sessionStorage`. Si la interfaz no está compilada, `/` responde 404 con el aviso de ejecutar `npm run build:ui`.

## 7. Errores

Todas las respuestas de error tienen la forma `{"error":{"code":"…","message":"…"}}`. Con `422` llegan también `warnings` (prueba de agente) o `issues` (plan inválido).

| HTTP | `code` | Cuándo |
|---|---|---|
| 400 | `invalid_request`, `invalid_json` | La entrada no cumple el esquema o el cuerpo no es JSON. |
| 401 | `unauthorized` | Falta el token o no es válido. |
| 403 | `forbidden_host`, `forbidden_origin` | El encabezado Host no es `127.0.0.1:<puerto>` ni `localhost:<puerto>`, o la petición trae un `Origin` de navegador que no es el del propio núcleo (`http://127.0.0.1:<puerto>`) ni uno de `ORQ_ALLOWED_ORIGINS`. |
| 404 | `not_found` | El recurso o la ruta no existen. |
| 409 | `conflict` | El recurso ya existe, o la tarea está en un estado que no permite la operación. |
| 413 | `payload_too_large` | El cuerpo supera 1 MiB. |
| 415 | `unsupported_media_type` | Falta `Content-Type: application/json`. La colección ya lo envía. |
| 422 | `probe_failed`, `plan_invalid` | La clave fue rechazada o el agente no está disponible, o el planificador no logró armar un plan válido. |
| 426 | `upgrade_required` | Se pidió `/ws` sin WebSocket. |
| 501 | `not_configured` | El módulo que atiende la ruta (planificador, cupos, skills, memoria) no está conectado en este arranque. |

Postman arma el encabezado Host a partir de la URL. Usa siempre `127.0.0.1` o `localhost`: con la IP de tu red o con otro nombre, el servidor responde `403`.
