# Si el proceso del SDK de la mente termina solo, el chat sigue anunciando subagentes que ya no existen y el núcleo no se apaga al cerrar la ventana

- **Área:** Mente y chat
- **Severidad:** media
- **Archivos:** `src/core/chat/service.ts:779`, `src/core/chat/service.ts:798`, `src/core/chat/service.ts:803`, `src/core/chat/service.ts:762`, `src/core/chat/service.ts:291`, `src/core/chat/service.ts:887`, `src/core/chat/service.ts:738`, `src/core/conductor/session.ts:464`, `src/ui/features/chat/ChatView.tsx:359`, `src/ui/features/agents-panel/model.ts:74`, `apps/desktop/src/lib/core-client.ts:67`
- **Estado:** abierta
- **Fusiona:** `codex-07-caida-flujo-sdk-deja-investigadores-fantasma.md` (revisión de Codex), que describía el mismo
  defecto. Ese archivo se borró. Este informe lo había calificado de severidad baja y Codex de media; se deja **media**
  porque, además del aviso falso, impide que el núcleo se apague al cerrar la ventana. Los números de línea que citó
  Codex en su informe original (`:285`, `:752`, `:776`) estaban corridos; los de aquí son los del código actual.
- **Relacionadas:** `uso-real-06` (las sesiones hijas quedan `running` en la tienda) y `uso-real-05` (lo mismo tras un
  reinicio del núcleo). Conviene un solo helper que cierre los subagentes en memoria y en la tienda.

## Cómo ocurre

Desde el issue 7 (`docs/plan/issues/07-agentes-en-segundo-plano.md`), `ChatService` lleva en memoria los subagentes de la
mente que siguen trabajando (`Live.background`, `service.ts:152-156`). El conjunto se llena y se vacía con los `status`
de las sesiones hijas (`#trackBackground`, `service.ts:875-883`). Esos `status` los genera el traductor a partir de
`task_started`/`task_progress`/`task_notification` del SDK (`translate.ts:493-519`). El conjunto solo se vacía de tres
formas:

- llega un `status` terminal de cada hijo (`task_notification`);
- `#dropSession` (`service.ts:762-776`), que corre en `close`, `delete`, `shutdown`, en el plazo de gracia de
  `interrupt` y en el cierre por inactividad;
- se crea una sesión nueva en `#ensureSession` (`service.ts:738-742`, «Los subagentes de un proceso anterior ya no existen»).

Si el proceso del SDK muere por su cuenta, no pasa ninguna de las tres. Causas posibles: una caída del CLI, un error
fatal de la API o un corte de `maxBudgetUsd`, que se pasa en `service.ts:733`. Este último no lo verifiqué contra el SDK.

Pasos:

1. La mente lanza N investigadores en segundo plano (Agent asíncrono) y cierra su turno. `live.background.size === N` y
   `live.turn` queda `undefined`. Es el flujo que cubre `tests/core/chat/background.test.ts:98-118`.
2. El iterador de `session.stream()` lanza una excepción (el proceso del SDK terminó) o se acaba. Como el CLI murió, no
   llega ningún `task_notification` de los hijos. `ConductorSession.stream()` (`src/core/conductor/session.ts:464-471`)
   solo traduce mensajes: al terminar no emite ningún cierre de los hijos.
3. En `#read`, el `catch` solo avisa si hay un turno de esa sesión:

   ```ts
   // service.ts:798-802
   } catch (err) {
     if (this.#repo.get(chatId) && live.turn?.session === session && !live.turn.interrupted) {
       this.#emit(chatId, live, { type: 'error', payload: { code: 'crash', ... } });
     }
     this.#log(`chat ${chatId}: la sesión terminó con error: ${oneLine(err)}`);
   ```

   Sin turno, el usuario no recibe ningún aviso. Solo queda una línea en el log.
4. El `finally` suelta la sesión pero no toca `background`:

   ```ts
   // service.ts:803-810
   } finally {
     if (live.session === session) {
       live.session = undefined;
       live.key = undefined;
     }
     const turn = live.turn;
     if (turn?.session === session) this.#finishTurn(chatId, live, turn, undefined);
   }
   ```

5. `#withLive` (`service.ts:291-295`) sigue devolviendo `backgroundTasks: N` en `GET /chats` y `GET /chats/:id`. Con eso:
   - `ChatView.tsx:359` sigue mostrando `BackgroundLine` («N agentes siguen trabajando en segundo plano: la mente te
     responde aquí cuando terminen», `BackgroundLine.tsx:4-8`). Esa respuesta no va a llegar.
   - El panel derecho pone a la mente en «Trabajando en segundo plano» (`agents-panel/model.ts:68` y `:74`).
   - El escritorio cuenta el chat como ocupado (`core-client.ts:67`:
     `c.state === 'running' || (c.backgroundTasks ?? 0) > 0`) y `core-supervisor.ts:272-273` con `shutdown-policy.ts:25-26` no apaga el núcleo al
     cerrar la ventana.
6. Tampoco hay ningún temporizador que lo arregle después: `#scheduleIdle` sale enseguida si no hay sesión
   (`service.ts:887`, `if (!live.session) return;`).

El estado falso dura hasta el próximo mensaje a ese chat. Ese mensaje crea una sesión nueva y limpia el conjunto en
`service.ts:738-742`. Si nadie vuelve a escribir en ese chat, la ventana nunca apaga el núcleo.

Lo mismo pasa si el proceso muere **con** un turno abierto y había subagentes lanzados en un turno anterior. El `catch`
emite el error y el `finally` cierra el turno, pero `backgroundTasks` sigue en N.

Ninguna prueba lo cubre. `tests/core/chat/background.test.ts` solo prueba cuatro salidas: el hijo que termina
(`:98`, `:120`), el cambio de ajustes (`:135`, `:157`) y los plugins (`:179`). La `query` falsa de esa prueba
(`injectableQuery`, `:24-70`) no permite simular que el proceso muera.

## Por qué pasa

El cierre de sesión está repartido en dos sitios. `#dropSession` limpia `background` y difunde el chat
(`service.ts:766-769`). La salida natural de `#read` (`service.ts:803-807`) copia solo la mitad de ese cierre: suelta
`session` y `key`, pero deja `background` como estaba. Además, el `catch` da por hecho que, sin turno abierto, nadie
espera nada de la sesión. Con subagentes en segundo plano, la interfaz le prometió al usuario una respuesta.

## Solución posible

En `src/core/chat/service.ts`, dentro de `#read`:

1. En el `finally`, antes de soltar `live.session`, anotar si la sesión que termina es la viva
   (`const wasLive = live.session === session`). Esta condición deja fuera los cierres de `#dropSession`, que ya
   pusieron `live.session = undefined`, y la sesión vieja que reemplazó `#ensureSession`, que ya limpió `background`.
2. Si `wasLive && live.background.size > 0`:
   - guardar `n = live.background.size`, vaciar `live.background` y llamar a `this.#publishLive(chatId)`;
   - si **no** hay turno de esta sesión (o sí lo hay pero el `catch` no emitió nada), emitir en la sesión principal un
     `error` con `code: 'crash'` y un texto como «La sesión de la mente terminó; los N subagentes en segundo plano se
     detuvieron. Escríbele para retomar». Así el usuario ve por qué no llega la respuesta.
   - opcional: guardar ese aviso como mensaje `assistant` (o de sistema) en el historial con `#repo.addMessage` y
     difundirlo con `chat_message`. Así lo ve también quien abra el chat más tarde.
3. Revisar el `catch`: cuando no hay turno pero sí `background`, debe avisar igual. Lo más simple es dejar el aviso en
   el `finally` del punto 2, que corre tanto si el iterador lanza como si se acaba.

### Otras opciones

- **Reutilizar `#dropSession`** desde el `finally` cuando `live.session === session`. Ya limpia `session`, `key` y
  `background`, y difunde el chat. Llamaría a `session.close()` sobre un proceso muerto, pero `close()` sale si ya está
  cerrada y, si no lo está, solo termina la cola, aborta y llama `stream.close` (`src/core/conductor/session.ts:488-494`), así que es
  inocuo. Así queda un solo sitio que sabe cerrar la sesión y no se repite la lógica. El aviso al usuario hay que
  añadirlo aparte.
- **Marcar también como terminadas las sesiones hijas en la tienda.** Los registros de los subagentes quedan en
  `running` en `sessions` (`store.ts:551-565`). Esta propuesta no los toca, y `#dropSession` tampoco. Si el panel o el
  historial de sesiones los muestra como activos, conviene emitir un `status` `failed` (o un `done` con `ok: false`)
  por cada id de `background` antes de vaciarlo. Así se arreglan a la vez el contador en memoria y lo guardado. Es más
  completo, pero toca más.
- Lo propuesto no es la única salida. Otra opción, más general: que `ConductorSession` exponga un evento o promesa de
  «terminó» y que `ChatService` cierre todo en un único manejador. Así cualquier forma de terminar (caída, aborto,
  cierre) pasaría por el mismo código.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta, en `tests/core/chat/background.test.ts`:
  - Ampliar `injectableQuery` con `crash(err)`, que haga que el iterador de `stream` lance `err` en la siguiente
    vuelta, y con `end()`, que lo termine con `return`. También sirve una `query` falsa propia que emita
    `launchScript` y después lance.
  - Escenario A (sin turno): `send('investiga')` y `settle`. Comprobar `backgroundTasks === 1`. Después `q.crash(new
    Error('Claude Code process exited with code 1'))` y esperar con `waitFor`. Afirmar:
    - `b.service.get(chat.id).backgroundTasks` es `undefined`;
    - el último `b.sent('chat')` trae el chat sin `backgroundTasks`;
    - el hub recibió un evento `error` en `chat.sessionId`, sin `parentSessionId`, que menciona los subagentes
      detenidos;
    - `b.service.sessionOf(chat.id)` es `undefined`.
  - Escenario B (fin limpio del iterador, sin excepción): igual que A, pero con `q.end()`: el iterador hace `return` sin
    `task_notification`. Afirmar lo mismo.
  - Escenario C (no debe avisar de más): tras `b.service.close(chat.id)` con un subagente vivo, el hub no recibe un
    `error` extra ni un segundo `chat`. `#dropSession` ya limpió, y `live.session !== session`.
  - Regresión: las pruebas de `background.test.ts` (`:98-200`) siguen pasando.
- Comando para correrla (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/chat/background.test.ts"` (o desde PowerShell en
  `C:\dev\orquestador`: `npx vitest run tests/core/chat/background.test.ts`).
- Verificación manual en la app:
  1. En un chat, pedirle a la mente una investigación con subagentes en segundo plano y esperar a que cierre su turno.
     Debe aparecer la línea «N agentes siguen trabajando…».
  2. Matar a mano el proceso hijo `claude` de esa sesión, no el núcleo.
  3. Antes del arreglo, la línea sigue ahí y el panel dice «Trabajando en segundo plano». Además, al cerrar la ventana,
     el log del escritorio dice que no se apaga porque hay trabajo en curso.
  4. Después del arreglo, la línea desaparece, el chat muestra el aviso de que la sesión terminó y al cerrar la ventana
     el núcleo se apaga (si no hay otras tareas activas).
