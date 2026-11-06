# Al abrir un chat, la interfaz pide por /ws toda la historia de la sesión de la mente, de 500 en 500, y solo se queda con los últimos 500 eventos

- **Área:** Interfaz: chat y composer
- **Severidad:** media
- **Archivos:** `src/ui/features/chat/use-chat-live.ts:45-49`, `src/ui/features/chat/use-chat-live.ts:59`, `src/ui/features/chat/store.ts:211`, `src/ui/features/chat/store.ts:271`, `src/ui/features/chat/store.ts:289`, `src/ui/features/chat/ChatView.tsx:92`, `src/ui/features/chat/ChatView.tsx:94`, `src/ui/features/chat/ChatView.tsx:215`, `src/ui/features/chat/timeline.ts:73`, `src/ui/features/agents-panel/AgentsPanel.tsx:35-37`, `src/core/server/ws.ts:71`, `src/core/store/store.ts:599-604`, `src/core/store/store.ts:608`, `src/core/chat/service.ts:337`, `src/core/chat/service.ts:631`, `tests/ui/chat/chat-view.test.tsx:106`
- **Estado:** abierta

## Cómo ocurre

Cada chat tiene una sola sesión de la mente durante toda su vida: `sessionId: \`chat-${id}\`` (`src/core/chat/service.ts:337`).
Al reanudarse, el `seq` sigue desde el último guardado (`seq: this.#deps.store.getSession(sessionId)?.lastSeq ?? -1`,
`service.ts:631`). Cada turno guarda en SQLite el texto, cada `tool_call`, cada `tool_result`, el uso y los estados. En
modo auto o bypass la mente trabaja ella misma, con decenas o cientos de herramientas por turno, y un chat largo junta
miles de eventos sin que nada los recorte.

La interfaz guarda en memoria solo los últimos 500 (`MAX_SESSION_EVENTS`). `mergeEvents` une y recorta:

```ts
// src/ui/features/chat/timeline.ts:73
return next.length > max ? next.slice(next.length - max) : next;
```

Pasos:

1. Se abre un chat (ruta nueva, vuelta desde la portada o cambio de conversación). `open` deja el estado inicial con
   `lastSeq: -1` (`store.ts:271`, `set({ ...INITIAL, ... })`). `select` hace lo mismo (`store.ts:289`), y `load` lo
   vuelve a `-1` si la sesión cambió (`store.ts:211`). Al desmontar `ChatView` también se hace `reset()`
   (`ChatView.tsx:92`), así que volver a un chat siempre parte de `-1`.
2. Cuando `load` pone el chat, `useChatLive(chat?.sessionId)` (`ChatView.tsx:94`) pide la historia desde ese `-1`:

   ```ts
   // src/ui/features/chat/use-chat-live.ts:59
   if (sessionId && live.status === 'open') live.replay(sessionId, useChat.getState().lastSeq);
   ```

   La prueba actual fija ese comportamiento: `expect(live.replay).toHaveBeenCalledWith('sess_chat_1', -1)`
   (`tests/ui/chat/chat-view.test.tsx:106`).
3. El núcleo responde con la página más ANTIGUA: `eventsPage(..., since ?? -1, limit ?? 500)` (`ws.ts:71`) consulta
   `... WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?` con `n + 1` filas (`store.ts:599-604`, `store.ts:608`),
   es decir los eventos 0 a 499, con `hasMore: true`.
4. El cliente encadena la página siguiente hasta llegar al final:

   ```ts
   // src/ui/features/chat/use-chat-live.ts:45-48
   case 'replay':
     if (!sessionId || message.sessionId !== sessionId) return;
     queue(message.events);
     if (message.hasMore) live.replay(sessionId, message.lastSeq);
   ```

5. En cada página el núcleo lee 500 filas, valida cada una con `eventRow.parse` y `agentEventSchema.parse` (`store.ts:611-612`) y pasa el
   mensaje entero por `redactDeep` antes de mandarlo (`ws.ts:53`). En la interfaz, cada página se une y se recorta a 500
   (`timeline.ts:73`) y se vuelve a pintar `ChatView` (`splitTurns` en `ChatView.tsx:105`). Como el último `seq` cambia,
   también cambia la firma de `useStickToBottom` y el hilo se vuelve a bajar en cada página (`ChatView.tsx:215`).
   Además, `AgentsPanel` recibe las mismas páginas y corre `applyEvents` sobre los 500 eventos, con `safeParse` de Zod
   por cada uno (`AgentsPanel.tsx:35-37`, `model.ts:23-27`).

Con un chat de 10 000 eventos, cada apertura cuesta 20 idas y vueltas por `/ws`: unos 10 000 eventos validados y
tachados en el núcleo (que es un solo hilo de Node) y otros 10 000 procesados en la interfaz, 20 repintados del hilo, y
al final se descarta todo salvo los últimos 500.

Hay además un caso secundario. El encadenado (paso 4) responde a CUALQUIER `replay` de esa sesión que traiga `hasMore`,
no solo a las páginas de su propia cadena. Si se cambia de chat y se vuelve al mismo mientras la cadena anterior sigue en
vuelo, la suscripción nueva sigue esa cadena y también arranca otra desde `-1`, y las dos recorren la historia en
paralelo (`mergeEvents` descarta los duplicados, pero el trabajo se hace dos veces).

## Por qué pasa

El cliente solo necesita la cola (los últimos `MAX_SESSION_EVENTS`), pero el `replay` de `/ws` (y
`GET /sessions/:id/events`) solo pagina hacia adelante desde `since`. Al abrir un chat la interfaz no sabe el último
`seq` de la sesión, así que parte de `-1` y recorre todo. El tope de 500 se aplica en el cliente, después de recibirlo
todo, y no en lo que se pide.

## Solución posible

En `src/ui/features/chat/use-chat-live.ts` (o en `load` de `src/ui/features/chat/store.ts`):

1. Al abrir el chat y antes del primer `replay`, pedir `GET /sessions/:id` (la ruta ya existe,
   `src/core/server/app.ts:620`, y devuelve `session.lastSeq`; `AgentsPanel.tsx:70-72` ya la usa con la sesión del chat).
2. Pedir `live.replay(sessionId, Math.max(-1, session.lastSeq - MAX_SESSION_EVENTS))`. Si la respuesta es 404 (chat
   recién creado, aún sin eventos), usar `-1`. Al reconectar se mantiene el `replay` desde `useChat.getState().lastSeq`,
   que ya es incremental. Los eventos en vivo que lleguen entre el GET y el `replay` se deduplican por `seq` en
   `mergeEvents`.
3. Encadenar `hasMore` solo hacia adelante y una vez: guardar en el efecto el mayor `since` ya pedido y, al llegar una
   página con `hasMore`, pedir la siguiente solo si `message.lastSeq` supera ese valor. Así una cadena vieja o duplicada
   se apaga sola.
4. Ajustar `tests/ui/chat/chat-view.test.tsx:106`, que hoy exige `replay('sess_chat_1', -1)`.

Los `seq` de la sesión del chat son seguidos (`seq: ++live.seq`, `service.ts:823`), así que `lastSeq - 500` trae
exactamente la cola. Si falta algún `seq` porque un `hub.append` falló, llegan unos pocos menos de 500, lo que no cambia
nada visible.

### Otras opciones

- **Cola en el núcleo (más óptima):** agregar un parámetro `tail: n` al mensaje `replay` (`clientMessageSchema` en
  `src/core/server/hub.ts:30-36`) y a `GET /sessions/:id/events`, con un método `eventsTail(sessionId, n)` en
  `src/core/store/store.ts` que haga `... WHERE session_id = ? ORDER BY seq DESC LIMIT ?` y lo invierta. Usa el índice
  `UNIQUE (session_id, seq)` y resuelve todo en una sola ida y vuelta, sin el GET previo ni la carrera entre las dos
  peticiones.
- Incluir el `lastSeq` de la sesión en `GET /chats/:id` (o en el `Chat`), para que `load` ya lo tenga y no haga falta
  pedirlo aparte.
- Que el núcleo devuelva en la respuesta `replay` el `since` pedido, para que el cliente reconozca las páginas de su
  propia cadena en vez de inferirlo.

La propuesta principal no es la única: la cola en el núcleo es la más limpia si se acepta tocar el contrato de `/ws`.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta, en `tests/ui/chat/chat-view.test.tsx`: con `resetFakeLive()` y
  `fakeCore({ chats: [chat], ... }, extra)`, donde `extra` responde
  `GET /sessions/sess_chat_1 → { session: { id: 'sess_chat_1', ..., lastSeq: 3000 } }`, renderizar `ChatView` y
  afirmar que el primer `live.replay` es `('sess_chat_1', 2500)` (o `since >= 2499`) y que nunca se llama con `-1`.
  Segundo caso: con 404 en `/sessions/sess_chat_1`, el primer `replay` es `-1`. Tercer caso, el de la cadena duplicada:
  emitir dos veces la misma página `{ lastSeq: 2999, hasMore: true }` y afirmar que solo se pide una vez
  `replay('sess_chat_1', 2999)`. Actualizar la expectativa de la línea 106.
- Si se elige la cola en el núcleo: en `tests/core/server/ws.test.ts`, guardar 1200 eventos de una sesión, mandar
  `{"type":"replay","sessionId":…,"tail":500}` y afirmar que llegan los `seq` 700 a 1199 en orden y en un solo mensaje.
- Comando (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/chat/chat-view.test.tsx"`
  (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/chat/chat-view.test.tsx`).
- Verificación manual: abrir un chat largo (miles de eventos) con las herramientas de desarrollo de Electron, pestaña
  Red → WS, y contar los mensajes `replay` enviados al abrirlo. Antes del arreglo hay uno por cada 500 eventos de la
  sesión. Después debe haber uno solo (o dos si llegó algo nuevo mientras cargaba), y el hilo debe verse igual que antes.
