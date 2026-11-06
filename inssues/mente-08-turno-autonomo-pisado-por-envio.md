# Si la mente arranca sola un turno mientras `send` espera, el turno del usuario lo pisa y el chat queda libre con el mensaje sin procesar

- **Área:** Mente y chat
- **Severidad:** baja
- **Archivos:** `src/core/chat/service.ts:419`, `src/core/chat/service.ts:421`, `src/core/chat/service.ts:433`, `src/core/chat/service.ts:456`, `src/core/chat/service.ts:471`, `src/core/chat/service.ts:483`, `src/core/chat/service.ts:683`, `src/core/chat/service.ts:794`, `src/core/chat/service.ts:796`, `src/core/chat/service.ts:839`, `src/core/chat/service.ts:865`, `src/core/conductor/session.ts:399`
- **Estado:** abierta

## Cómo ocurre

Desde el issue 7 (`docs/plan/issues/07-agentes-en-segundo-plano.md`), cuando termina un subagente en segundo plano, la
mente puede seguir sola y abrir un turno sin mensaje del usuario. `#read` lo detecta y lo registra como un turno más
(`service.ts:794`):

```ts
if (!live.turn && live.session === session && startsMainTurn(update.message)) this.#beginAutonomousTurn(chatId, live, session);
```

`#beginAutonomousTurn` (`service.ts:865-872`) solo crea `live.turn` y pone `busy = true`. Lo único que mira para no
abrir turno es `live.turn`. No sabe si hay un `send` en curso.

`send` marca `busy` antes de cualquier espera (`service.ts:419-421`), pero `live.turn` se asigna mucho después, en
`service.ts:471`, sin volver a mirar:

```ts
live.busy = true;                                                   // 421
...
const { bytes } = await this.#readAttachment(a.id);                 // 433 (cada imagen)
...
const session = await this.#ensureSession(chatId, live, input.effort); // 456
...
live.turn = { session, texts: [], interrupted: false };             // 471
```

Con subagentes vivos, `#ensureSession` siempre espera `alive.setEffort(effort)` (`service.ts:680-683`). Si el esfuerzo del
turno no es el de la sesión viva, `ConductorSession.setEffort` hace un viaje de ida y vuelta al proceso del SDK
(`applyFlagSettings`) con un tope de 10 s (`session.ts:399-422`, `EFFORT_TIMEOUT_MS = 10_000` en `session.ts:102`). Durante
esa espera el bucle `#read` sigue consumiendo mensajes del SDK.

Pasos:

1. La mente lanzó uno o más subagentes en segundo plano y cerró su turno: `live.turn` está vacío, `busy = false` y
   `live.background.size > 0`.
2. El usuario envía un mensaje con un esfuerzo distinto del vigente (la barra de esfuerzo) o con una imagen. Pasa la
   guardia de `service.ts:419`, `send` pone `busy = true` y queda esperando en `setEffort` (hasta 10 s) o en la lectura
   del adjunto.
3. En esa espera termina un subagente. El SDK emite `init` o un `assistant` principal, y `#read` abre un turno
   autónomo A (`service.ts:794` → `865`). El chat pasa a `running`.
4. `send` sigue. Guarda el mensaje del usuario y hace `live.turn = {…}` (`service.ts:471`). A queda huérfano y los
   textos que ya había juntado se pierden. Después, `session.send(text)` encola el mensaje del usuario en la entrada
   del SDK, que todavía está en el turno A.
5. Llega el `result` de A. Como `live.turn?.session === session` (`service.ts:796`), `#finishTurn` cierra el turno del
   usuario (`service.ts:839-841`: `live.turn = undefined; live.busy = false`) y deja el chat en `idle` (`service.ts:859`).
   El SDK todavía no procesó el mensaje del usuario.

Qué se ve:

- **El chat queda `idle` y `busy = false` con un mensaje del usuario sin procesar.** La guardia de `service.ts:419`
  deja pasar otro envío, justo lo que dice evitar el comentario de `service.ts:420`. La respuesta al mensaje del
  usuario llega después como otro turno autónomo (`service.ts:794`). Se guarda, pero mientras tanto la interfaz dice
  que la mente está libre. Si en ese hueco el usuario escribe otra vez, se arrastra el mismo desfase: la respuesta
  anterior cierra el turno del mensaje nuevo.
- **Pérdida de texto, solo por el camino de respaldo.** Si el `result` de A es correcto y trae `result`, se guarda ese
  texto completo (`service.ts:846`) y no se pierde nada respecto de un turno normal. Si A termina en error, se
  interrumpe o trae `result` vacío, la respuesta se arma con `turn.texts`. Ahí solo están los textos posteriores a la
  pisada, y los de A anteriores a `service.ts:471` no llegan al historial.

Ninguna prueba cubre esto. `tests/core/chat/background.test.ts` inyecta el turno autónomo entre envíos, nunca durante
uno, y su `query` falsa no tiene `applyFlagSettings`, así que la espera de `setEffort` nunca dura más de un microtask.

## Por qué pasa

`send` reserva el chat con `busy` y abre el turno con `live.turn`. Entre las dos cosas hay esperas (`service.ts:433`,
`service.ts:456` → `683`). `#beginAutonomousTurn` decide solo por `live.turn` (`service.ts:794`), y `send` asigna
`live.turn` sin comprobar si alguien lo ocupó en ese hueco (`service.ts:471`). El modelo del servicio es «un `result`
cierra el turno abierto». Por eso el `result` de A cierra el turno del usuario, aunque el SDK le debe todavía la
respuesta a ese mensaje.

## Solución posible

En `src/core/chat/service.ts`, en `send`, justo después de `await this.#ensureSession(...)` (`service.ts:456`), antes de
guardar el mensaje del usuario:

```ts
if (live.turn) throw new ChatError('conflict', 'La mente empezó a responder sola: espera a que termine o interrúmpela');
```

Así no se guarda el mensaje, no se envía al SDK y no se pisa A. El `catch` de `service.ts:482-490` ya respeta el turno
vivo: con `live.turn` puesto no toca `busy`, que queda en `true` por A. Falta un ajuste. Hoy ese `catch` tampoco
quita `addedRoots` cuando hay turno (`service.ts:483-487`), y las carpetas de los adjuntos del envío rechazado
seguirían legibles para la mente. Hay que sacar `for (const root of addedRoots) live.roots.delete(root)` fuera del
`if (!live.turn)` (sin quitar raíces que ya estaban: `addedRoots` solo guarda las nuevas, `service.ts:445`).

La interfaz ya trata `conflict` como «la mente todavía está respondiendo». El texto del composer queda para reenviar.

### Otras opciones

- **Indicador `live.sending`** que impida a `#beginAutonomousTurn` abrir turno durante un envío (lo que proponía el
  reporte). Evita que se pierdan textos, pero no arregla lo principal: el `result` de A seguiría cerrando el turno del
  usuario y el chat quedaría `idle` con el mensaje pendiente.
- **Adoptar el turno autónomo:** si después de las esperas hay `live.turn`, no rechazar. Guardar el mensaje, enviarlo y
  llevar un contador `live.pending` de mensajes del usuario encolados en el SDK. `#finishTurn` dejaría `busy`/`idle`
  solo cuando ese contador llegue a 0 y abriría el turno siguiente por su cuenta. Es mejor para el usuario (no ve un
  409 por una carrera que no puede ver), pero cambia el modelo de turnos y depende de cómo el SDK atiende un mensaje
  que llega en mitad de un turno: puede contestarlo como turno propio o meterlo en el turno en curso. Hay que
  confirmarlo con el SDK real antes de elegirla.
- **Esperar a que A termine** y recién entonces enviar (una cola en `send`). Sirve, pero deja la petición HTTP colgada
  todo lo que dure el turno autónomo.

La guardia de 409 es la más corta y no depende del comportamiento del SDK, aunque no es la única salida.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta, en `tests/core/chat/background.test.ts`:
  - Darle a `injectableQuery` un `applyFlagSettings` controlado por la prueba: devuelve una promesa que la prueba
    resuelve a mano. Se agrega en el `Object.assign` del stream junto a `close` e `interrupt`.
  - Escenario: `send('investiga')` con `launchScript` (deja un subagente vivo, `backgroundTasks === 1`) y `settle`.
    Sin `await`, lanzar `send(chat.id, { text: 'rápido', effort: 'low' })`, que queda esperando en `applyFlagSettings`.
    Mientras tanto, `q.inject([taskDone('t1','tu1',sid), sdkInit(sid), sdkText('A1', sid)])` y `waitFor` hasta ver
    `state === 'running'`. Resolver `applyFlagSettings`.
  - Afirmaciones con la solución propuesta: el `send` rechaza con `{ code: 'conflict' }`, el script de la `query` nunca
    recibe el mensaje `rápido` y el historial no tiene ese mensaje. Después,
    `q.inject([sdkResult(undefined, sid, 0.01, 'error_during_execution')])`: el historial termina en un `assistant` que
    contiene `A1`, y el chat no pasa a `idle` antes de ese `result`.
  - Con la alternativa de adoptar el turno, las afirmaciones cambian: el chat sigue `running` (y `send` responde 409)
    hasta que llegue el `result` de la respuesta al mensaje del usuario, y el historial guarda las dos respuestas.
  - Caso de raíces: el mismo escenario con un adjunto de archivo (no imagen). Después del 409, `#rootsFor` ya no
    incluye su carpeta. Se ve en las `readRoots()` que recibe la `query` en el turno siguiente.
- Comando (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/chat/background.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/chat/background.test.ts`).
- Verificación manual en la app: pedirle a la mente un investigador en segundo plano. Justo antes de que termine,
  enviar un mensaje con otro nivel en la barra de esfuerzo. Con el arreglo aparece «La mente empezó a responder
  sola…» y el chat sigue en `running` hasta que termina el turno autónomo. Sin el arreglo, el chat puede quedar
  `idle` mientras la mente todavía contesta.
