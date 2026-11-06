# Tras un reinicio del núcleo, el chat que estaba respondiendo queda «Libre» sin respuesta ni aviso, y sus subagentes perdidos no dejan rastro

- **Área:** Evidencia de uso real (chat con la mente, arranque del núcleo)
- **Severidad:** media
- **Archivos:** `src/core/chat/service.ts:256`, `src/core/chat/db.ts:229`, `src/core/chat/db.ts:231`, `src/core/chat/service.ts:150`, `src/core/chat/service.ts:631`, `src/core/chat/service.ts:838`, `src/core/store/store.ts:520`, `src/core/app/fleet-service.ts:258`, `src/core/conductor/session.ts:382`, `src/ui/features/agents-panel/model.ts:72`, `tests/core/chat/service.test.ts:238`
- **Estado:** resuelta

## Cómo ocurre

Cada chat tiene un estado guardado en `chat_chats.state` (`idle`, `running`, `error`, `closed`). Mientras la mente
responde, el chat está en `running`. La respuesta solo se guarda en el historial cuando el turno termina: el único
camino que agrega un mensaje de la mente es `#finishTurn` (`src/core/chat/service.ts:838-863`), que necesita el
proceso vivo del SDK. Los subagentes que la mente lanza en segundo plano se cuentan solo en memoria, en
`Live.background` (`src/core/chat/service.ts:150-156`), y ese conjunto nace vacío en cada arranque
(`src/core/chat/service.ts:631`, `background: new Set()`).

Pasos:

1. El usuario escribe en un chat. `send` guarda su mensaje y deja el chat en `running`.
2. Opcional: la mente lanza uno o más subagentes en segundo plano (`Agent`/`Task`).
3. El núcleo se cierra antes de que termine el turno (cierre de la app, caída o reinicio).
4. Al volver a arrancar, el constructor de `ChatService` llama a:

   ```ts
   // src/core/chat/service.ts:256
   this.#repo.resetRunning(this.#iso());
   ```

   ```ts
   // src/core/chat/db.ts:229-232
   /** Al arrancar el núcleo no hay turnos vivos: los que quedaron `running` vuelven a `idle`. */
   resetRunning(at: string): number {
     return Number(this.#db.stmt(`UPDATE chat_chats SET state = 'idle', updated_at = ? WHERE state = 'running'`).run(at).changes);
   }
   ```

   El número que devuelve ni siquiera se registra en el log. No se guarda ningún mensaje ni evento, y no se publica nada.
5. En la interfaz, `mindRow` (`src/ui/features/agents-panel/model.ts:72-80`) muestra «Libre» y «Lista para ayudarte»,
   porque el chat está `idle` y `backgroundTasks` no aparece (el conjunto en memoria está vacío). En el hilo, el último
   mensaje es el del usuario y no hay respuesta. Si se guardaron eventos del turno, `ChatView` muestra el borrador sin
   el indicador de «pensando» (`src/ui/features/chat/ChatView.tsx:110`), pero nada dice que se cortó.

La prueba actual deja fijado ese comportamiento sin aviso: `tests/core/chat/service.test.ts:238-260` pone un chat en
`running`, crea otro `ChatService` y espera `state === 'idle'` y mensajes `['user', 'assistant']`, sin ningún aviso.

Las tareas de la flota sí quedan marcadas. `recoverOrphans` las pasa a `failed` con «interrumpida al reiniciar el
núcleo» (`src/core/app/fleet-service.ts:73` y `:238-252`). Con los chats no pasa nada parecido.

Los subagentes tampoco dejan rastro en la base. Sus sesiones se guardan en `sessions` con `parent_session_id` igual al
`sessionId` del chat y con `agent_id` de la mente, porque el traductor recibe `agentId: this.agentId`, que es
`CONDUCTOR_AGENT_ID` (`src/core/conductor/session.ts:229` y `:382`). Al arrancar, `cancelOpenSessions` las salta,
porque excluye a ese agente (`src/core/app/fleet-service.ts:258`,
`store.cancelOpenSessions({ exceptAgents: [CONDUCTOR_AGENT_ID] })`; `src/core/store/store.ts:520-526`). Quedan en
`running` en la base para siempre, aunque su proceso ya no existe, y el chat no dice nada de ellas.

El caso real del reporte es el chat faf636ea: un mensaje del usuario a las 01:36:04Z quedó sin respuesta, y al arrancar,
a las 02:20:26Z, el chat volvió a `idle`. El chat ec3e1f2b tenía tres subagentes en segundo plano y se perdieron. Esto
coincide con el flujo del código (no reabrí la base de datos en vivo).

## Por qué pasa

`resetRunning` arregla el estado pero no deja constancia: un `UPDATE` sin mensaje, sin evento y sin publicación por el
hub. La cuenta de subagentes vive solo en memoria (`Live.background`), así que tras el reinicio no queda nada que la
interfaz pueda mostrar. Y como los subagentes comparten `agent_id` con la mente, `cancelOpenSessions` no cierra sus
sesiones. El chat no tiene un camino de recuperación como el que tienen las tareas.

## Solución posible

1. `src/core/chat/db.ts`: que `resetRunning(at)` devuelva los chats afectados (`id`, `session_id`), por ejemplo con
   `UPDATE … WHERE state = 'running' RETURNING id, session_id`, o leyéndolos antes en la misma transacción.
2. Agregar `openChildSessions(sessionId)` en `ChatDb` o `ChatRepo`: lee
   `SELECT id FROM sessions WHERE parent_session_id = ? AND state IN ('starting','running','waiting')`, y después las
   cierra como `cancelled` con `ended_at` (lo que `cancelOpenSessions` no hace con ellas).
3. `src/core/chat/service.ts`, en el constructor, por cada chat afectado:
   - Agregar un aviso al historial con `#repo.addMessage`. El esquema solo admite los roles `user` y `assistant`
     (`src/shared/api.ts:170`), así que sería un mensaje `assistant` con un texto fijo, por ejemplo: «La respuesta se
     cortó porque el núcleo se cerró (último evento a las HH:MM). Vuelve a enviar tu mensaje.» La hora puede salir de
     `sessions.updated_at` de `chat.sessionId`, que es la hora del último evento.
   - Si había sesiones hijas abiertas, sumar al texto: «N subagentes en segundo plano se perdieron al reiniciar».
   - Aunque el último mensaje sea de la mente, avisar igual: un turno autónomo (`#beginAutonomousTurn`,
     `service.ts:865`) también deja el chat en `running`.
   - Registrar en el log cuántos chats se recuperaron. Publicar por el hub (`chat` y `chat_message`) sirve de poco,
     porque en el constructor todavía no hay clientes conectados; lo que cuenta es que quede guardado.
4. Ajustar `tests/core/chat/service.test.ts:258`, que hoy espera `['user', 'assistant']`, para que incluya el aviso.

### Otras opciones

- Agregar un rol `notice` o `system` a `chatMessageSchema` y mostrarlo con otro estilo en `MessageList`. Es más limpio,
  porque no se hace pasar el aviso por respuesta de la mente, pero toca el contrato, la interfaz y las pruebas de la UI.
- En vez de un mensaje, guardar un evento `error` (código `interrupted`) en la sesión del chat con
  `seq = lastSeq + 1`. `ChatView` ya muestra los eventos que siguen al último mensaje como borrador
  (`ChatView.tsx:110`), así que el aviso aparecería sin cambiar el esquema. Es más frágil: si después llega un mensaje
  de la mente, ese evento queda como un paso más de su respuesta.
- Avisar solo en la interfaz: si el último mensaje es del usuario y el chat está `idle`, mostrar «sin respuesta». No
  necesita migración, pero no distingue un reinicio de otros casos y no sirve para los subagentes.
- Reenviar el último mensaje solo es arriesgado, sobre todo en modo bypass, porque puede repetir efectos.
- Puede haber algo mejor: guardar en la base, en cada cambio, el conjunto de subagentes vivos (o una columna
  `interrupted_at` en `chat_chats`). Así la recuperación no depende de inferirlo desde `sessions`. Esta propuesta no es
  la única posible.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta, en `tests/core/chat/service.test.ts`, junto a «otro arranque del núcleo…»:
  1. Con `bench()`, crear un chat, mandar un turno, dejar el chat en `running` y agregar a mano un mensaje del usuario
     sin respuesta.
  2. Escribir dos eventos `status` `running` con `parentSessionId = chat.sessionId` (`b.store.append`), para que queden
     dos sesiones hijas abiertas.
  3. `shutdown()` y construir otro `ChatService` sobre la misma base.
  4. Afirmar que el estado es `idle`, que `messages(chat.id).at(-1)` es el aviso, que el aviso dice «se cortó» y
     «2 subagentes», que `store.listSessions({ parentSessionId: chat.sessionId })` ya no tiene ninguna `running`, y
     que con un chat `idle` no se agrega ningún aviso.
- Comando (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/chat/service.test.ts"`
  (o, desde PowerShell en C:\dev\orquestador: `npx vitest run tests/core/chat/service.test.ts`).
- Verificación manual: mandar un mensaje que lance subagentes en segundo plano y cerrar Berland mientras «Pensando».
  Al volver a abrir, el chat debe mostrar el aviso con la hora y la cantidad de subagentes perdidos.
