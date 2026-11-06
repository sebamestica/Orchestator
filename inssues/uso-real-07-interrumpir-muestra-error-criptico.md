# Al detener un turno de la mente, el chat muestra el error rojo «[ede_diagnostic] result_type=user …» y la sesión del chat queda `failed`

- **Área:** Evidencia de uso real (chat con la mente)
- **Severidad:** baja
- **Archivos:** `src/core/adapters/claude-sdk/translate.ts:577`, `src/core/adapters/claude-sdk/translate.ts:589`, `src/core/adapters/claude-sdk/translate.ts:590`, `src/core/chat/service.ts:499`, `src/core/chat/service.ts:795`, `src/core/chat/service.ts:799`, `src/core/chat/service.ts:860`, `src/core/store/store.ts:553`, `src/ui/features/chat/timeline.ts:106`, `src/ui/features/chat/components/LiveReply.tsx:114`
- **Estado:** abierta

## Cómo ocurre

Contexto. Cada chat tiene una sesión larga del Claude Agent SDK (`ConductorSession`). `ChatService.#read` recorre `session.stream()`: cada mensaje del SDK llega ya traducido a `AgentEvent` por `ClaudeSdkTranslator` y se reenvía tal cual al hub (que lo guarda en `events` y actualiza `sessions`). El botón «Detener» llama a `POST /chats/:id/interrupt` → `ChatService.interrupt()`, que marca el turno y pide al SDK que lo corte:

```ts
// src/core/chat/service.ts:499-501
turn.interrupted = true;
try {
  await turn.session.interrupt();
```

Cuando el SDK corta el turno, responde con un `result` de subtipo `error_during_execution` cuyo `errors[0]` es un texto interno de diagnóstico. El traductor trata todo subtipo distinto de `success` como fallo:

```ts
// src/core/adapters/claude-sdk/translate.ts:577 y 589-590
const failed = r.is_error || r.subtype !== 'success';
...
out.push(this.error(code, `${reason}${status}`));
out.push(this.done(false, r.result ?? reason));
```

`#read` reenvía esos eventos sin mirar si el turno fue interrumpido (`service.ts:795`: `for (const event of update.events) this.#emit(chatId, live, event);`). Así:

- El hub guarda el `done` con `ok: false` y la sesión del chat pasa a `failed` (`store.ts:553`: `state = e.payload.ok ? 'done' : 'failed';`). Queda así hasta el siguiente turno.
- La interfaz convierte el `error` en un paso rojo (`timeline.ts:106-107` → `LiveReply.tsx:114-119`, `role="alert"`, `text-danger`). Si la mente no alcanzó a escribir texto, no se guarda mensaje de la mente y el borrador sigue a la vista (`ChatView.tsx:110`), así que el usuario ve el error rojo justo debajo de su mensaje. Si hubo texto, el error aparece en el resumen de actividad como «· 1 con error» (`LiveReply.tsx:191`, `:203`).

El estado del chat sí queda bien, porque `#finishTurn` tiene en cuenta la interrupción (`service.ts:860`: `state: ok || turn.interrupted ? 'idle' : 'error'`). Y el caso de la sesión cortada ya calla el error cuando hubo interrupción (`service.ts:799`: `... && !live.turn.interrupted`). El error que trae el propio `result` no pasa por ningún filtro de ese tipo.

Pasos:

1. Abrir un chat o una Conversación y mandar un mensaje.
2. Mientras la mente piensa, pulsar «Detener».
3. El timeline muestra en rojo «[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null» (o `stop_reason=tool_use` si estaba usando una herramienta), y en `sessions` la fila `chat-<id>` queda `failed`.

Evidencia en la base real (copia de solo lectura de `%LOCALAPPDATA%\orquestador\orquestador.db` + WAL): hay 7 eventos `error` con `code: "unknown"` y ese mensaje (ids 2928, 3082, 3129, 3137, 6065, 8969, 9283), en 4 chats distintos, entre el 2026-11-04 y el 2026-11-05. El último es de hoy, con el código actual: sesión `chat-05d4169d-…`, seq 0 `status running «pensando»` (14:29:11.690Z), seq 2 `usage`, seq 3 `error` «[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null» y seq 4 `done {ok:false, summary:"[ede_diagnostic] …"}` (14:29:21.409Z). Tres segundos después empieza otro turno (seq 5, 14:29:24Z). En `nucleo-escritorio.log` hay varios `POST /chats/:id/interrupt 200`, uno por cada corte.

La prueba actual del caso («409 con un turno en curso; interrumpir corta el turno y deja el chat ocioso», `tests/core/chat/service.test.ts:141-162`) ya devuelve un `error_during_execution` tras interrumpir, pero solo comprueba el estado del chat y los mensajes, no los eventos. Por eso no lo detecta.

## Por qué pasa

`ChatService` sabe que el turno se interrumpió (`turn.interrupted`, `service.ts:499`) y lo usa para el estado del chat (`service.ts:860`) y para no mostrar el error de sesión cortada (`service.ts:799`). En cambio, los eventos del `result` de ese turno los pasa al hub sin cambios (`service.ts:795`). El traductor no sabe nada de la interrupción y convierte el `error_during_execution` esperado en `error` + `done(false)` (`translate.ts:577-590`). El hub y la interfaz lo tratan como un fallo de verdad.

## Solución posible

En `src/core/chat/service.ts`, dentro de `#read`, antes del bucle de `#emit` (línea 795): si el mensaje es un `result` del turno en curso, el turno está `interrupted` y el subtipo no es `success`, se reescriben los eventos de ese mensaje:

- se mantienen los `usage` (el gasto del turno cortado se tiene que contar);
- se quitan los `error` de la sesión principal;
- el `done(false)` se cambia por `status { state: 'cancelled', detail: 'interrumpido por ti' }`. Así la sesión queda `cancelled`, que es lo que pasó. `idle` no sirve: no está en `sessionStateSchema` (`src/shared/events.ts:13`). Otra opción es `done { ok: true, summary: 'Interrumpido por ti' }`, pero marcaría la sesión como `done`.

`#finishTurn` no cambia: ya deja el chat `idle` y guarda el texto parcial. Para que el usuario vea el corte sin el texto interno, se puede añadir en la interfaz una línea gris «Interrumpido» cuando el último `status` del turno sea `cancelled` (en `timeline.ts`, como un item nuevo que no cuente como error).

Hay que mantener el comportamiento de hoy cuando el `error_during_execution` llega sin que el usuario haya interrumpido: ese sí es un fallo real y tiene que seguir mostrándose y dejando el chat en `error`.

### Otras opciones

- **Avisar al traductor.** `ClaudeSdkTranslator` podría recibir un indicador o un callback `interrupted()` (o un método `markInterrupted()` que `ConductorSession.interrupt()` llame antes de `#stream.interrupt()`), y emitir `status cancelled` en lugar de `error` + `done(false)`. Queda más cerca del origen y valdría también para otros usos del traductor, pero el traductor también lo usa la flota, y allí hay que revisar que una cancelación de tarea no deje de verse como cancelación.
- **Filtrar en la interfaz.** Ocultar los `error` cuyo mensaje empiece por «[ede_diagnostic]». Es lo más rápido, pero depende de un texto interno del SDK que puede cambiar, y la sesión seguiría quedando `failed` en la base y en `GET /sessions`.
- **Hacerlo de forma general.** Antes de mandar al hub, `ChatService` podría marcar con el motivo «interrumpido» todos los eventos de cierre de un turno interrumpido. Esto cubre el `result` y cualquier otra señal de fallo que el SDK añada más adelante.

La propuesta no es la única. Elegir entre `ChatService` y el traductor depende de si se quiere el mismo trato para la flota.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta, en `tests/core/chat/service.test.ts`:
  1. Ampliar el caso de la línea 141 (o añadir uno al lado): el `TurnFn` espera `ctx.stopped` y devuelve `sdkInit('sdk-1')`, `sdkText('a medias', 'sdk-1')` y `{ ...sdkResult(undefined, 'sdk-1', 0.001, 'error_during_execution'), errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'] }`. Llamar a `send()`, después a `interrupt()` y `settle()`. Comprobar que:
     - en `b.events(chat.sessionId)` no hay ningún evento `error` ni ningún `done` con `ok: false`, y sí el `usage` del turno;
     - `b.store.getSession(chat.sessionId)?.state` no es `'failed'` (con la propuesta, `'cancelled'`);
     - `b.service.get(chat.id).state` es `'idle'` y el mensaje «a medias» queda guardado (como hoy).
  2. Caso de control: el mismo `result` `error_during_execution`, pero sin llamar a `interrupt()`. Debe seguir llegando el `error`, la sesión debe quedar `failed` y el chat en `'error'`.
- Comando para correrla (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/chat/service.test.ts"` (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/chat/service.test.ts`).
- Verificación manual en la app: abrir una Conversación nueva, mandar un mensaje y pulsar «Detener» a los pocos segundos. No debe salir ningún aviso rojo ni «· 1 con error», el composer queda libre y, si se añade la línea gris, se ve «Interrumpido». En la base, la fila `sessions` del chat no debe quedar `failed`.
