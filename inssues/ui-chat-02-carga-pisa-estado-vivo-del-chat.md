# Al abrir o recargar un chat, la respuesta REST pisa lo que llegó por /ws mientras cargaba y el chat se queda en «trabajando» (o pierde la respuesta)

- **Área:** Interfaz: chat y composer
- **Severidad:** media
- **Archivos:** `src/ui/features/chat/store.ts:198-212`, `src/ui/features/chat/store.ts:287-296`, `src/ui/features/chat/store.ts:417-425`, `src/ui/features/chat/store.ts:476-487`, `src/ui/features/chat/use-chat-live.ts:50-58`, `src/core/chat/service.ts:494-514`, `src/core/chat/service.ts:838-861`, `src/core/chat/service.ts:762-769`, `src/core/chat/service.ts:885-895`, `src/ui/features/chat/ChatView.tsx:99`, `src/ui/features/chat/ChatView.tsx:110`, `src/ui/features/chat/ChatView.tsx:370-371`, `src/ui/features/composer/Composer.tsx:71`
- **Estado:** abierta

## Cómo ocurre

La vista de chat guarda el chat activo, sus mensajes y eventos en el store zustand `useChat`. Hay dos fuentes que lo
modifican: la carga REST `load()` y los mensajes de `/ws`, que `useChatLive` pasa a `applyLive` sin filtrar
(`use-chat-live.ts:50-51`, `default: useChat.getState().applyLive(message)`).

`load()` se llama desde `open()` (`store.ts:283-284`), desde `select()` (`store.ts:289-290`, que antes deja
`activeId: chatId` y `chat: null`) y desde `refresh()` (`store.ts:293-296`). `useChatLive` llama a `refresh()` cada vez
que `/ws` vuelve a quedar abierto (`use-chat-live.ts:54-58`).

`load()` pide en paralelo el chat y sus mensajes, y al volver reemplaza el estado sin mirar lo que haya llegado mientras
tanto (`store.ts:202-212`):

```ts
const [c, m] = await Promise.all([api.get<{ chat: Chat }>(base), api.get<{ messages: ChatMessage[] }>(`${base}/messages`)]);
if (!alive()) return;
...
set((s) => ({
  status: 'ready',
  error: null,
  chat: c.chat,
  chats: s.chats.some((x) => x.id === c.chat.id) ? s.chats.map((x) => (x.id === c.chat.id ? c.chat : x)) : upsertChat(s.chats, c.chat),
  messages: m.messages,
```

Mientras el `Promise.all` está pendiente, `activeId` ya es ese chat, así que `applyLive` sí aplica lo que llega por
`/ws` (`store.ts:479-487`):

```ts
set((st) => ({ chats: upsertChat(st.chats, chat), chat: st.activeId === chat.id ? chat : st.chat }));
...
if (message.message.chatId === s.activeId) set((st) => ({ messages: upsertMessage(st.messages, message.message) }));
```

Al terminar un turno, el núcleo publica primero el `chat_message` con la respuesta y después el `chat` en `idle`
(`service.ts:858` y `service.ts:860`, que difunde mediante `#update`, `service.ts:588-592`). Las dos lecturas REST son
peticiones distintas: el núcleo puede contestar `GET /chats/:id` antes del fin del turno y `GET /chats/:id/messages`
después.

Pasos:

1. La mente está terminando un turno y el usuario abre ese chat, o `/ws` se reconecta y se dispara `refresh()`.
2. `GET /chats/:id` sale con `state: 'running'`.
3. Termina el turno: llegan por `/ws` el `chat_message` y el `chat` con `state: 'idle'`. `applyLive` deja el chat en
   `idle` y agrega la respuesta.
4. Se resuelve el `Promise.all` y `set` vuelve a poner el `chat` viejo en `running` (y también su fila en `chats`,
   `store.ts:209`) y la foto `m.messages`.

Qué se ve:

- `running = chat?.state === 'running'` (`ChatView.tsx:99`): sigue «Pensando…» y el botón «Detener respuesta», porque
  el Composer recibe `isStreaming={running}` (`ChatView.tsx:370`). Con eso `canSend` queda en `false`
  (`Composer.tsx:71`: `const canSend = !locked && !isStreaming && ...`). No se puede mandar nada.
- Pulsar Detener no lo arregla. Sin turno en curso, `interrupt` del núcleo devuelve el chat sin difundir nada
  (`service.ts:498`, `if (!live || !turn) return chat;`) y la interfaz no usa la respuesta (`store.ts:421`,
  `await api.post<unknown>(...interrupt)`). El chat solo sale de ese estado si se cambia de chat o llega otro evento
  `chat`. El cierre por inactividad no lo difunde: `#scheduleIdle` llama a `#dropSession` (`service.ts:885-895`), que
  solo publica si había subagentes en segundo plano (`service.ts:766-769`).
- Variante: si la foto de mensajes se tomó antes del fin del turno pero llega después que el `chat_message` de `/ws`,
  `messages: m.messages` borra la respuesta. Como el último mensaje ya no es de la mente, los eventos sueltos se
  muestran como borrador (`ChatView.tsx:110`). Ese borrador no tiene el botón «Copiar respuesta» de `MessageList.tsx`.
  Además desaparece al mandar el siguiente mensaje: `splitTurns` asigna esos eventos al mensaje del usuario y no los
  guarda (`timeline.ts:171-176`).

Con la CPU cargada (Defender, varias sesiones) aumenta el tiempo entre las dos respuestas REST y crece la ventana.

## Por qué pasa

`load()` toma la respuesta REST como el estado más reciente y no la junta con lo que `/ws` aplicó durante la carga. No
compara `updatedAt` del chat y reemplaza los mensajes en lugar de unirlos (`store.ts:205-212`). Además, `interrupt()`
descarta el `{ chat }` que devuelve `POST /chats/:id/interrupt` (`routes.ts:216`, `store.ts:421`). Esa respuesta sería
la única forma de corregir el estado cuando el núcleo no tiene un turno que cortar.

## Solución posible

En `src/ui/features/chat/store.ts`:

1. En `load()`, dentro de `set((s) => …)`:
   - Mantener `s.chat` si `s.chat?.id === c.chat.id && s.chat.updatedAt > c.chat.updatedAt`, porque ya llegó por `/ws`
     algo más nuevo. Aplicar la misma regla a la fila de `chats`.
   - Unir los mensajes: partir de `m.messages` y aplicar `upsertMessage` (`timeline.ts:200`) con cada mensaje de
     `s.messages` que no esté en la foto. Los mensajes solo se agregan; un chat borrado llega por `chat_deleted`. Por eso
     unir no deja nada de más.
2. En `interrupt()`, leer `{ chat?: Chat }` y aplicarlo si sigue activo y no es más viejo que el actual:
   `set((s) => (r?.chat && s.chat?.id === r.chat.id && r.chat.updatedAt >= s.chat.updatedAt ? { chat: r.chat, chats: upsertChat(s.chats, r.chat) } : {}))`.
   Es la misma idea que `setMode` (`store.ts:370-373`), con la comparación de `updatedAt` agregada. Sin ella, una
   respuesta `running` que llegue después del `chat` `idle` de `/ws` volvería a trabar el chat.

`updatedAt` sirve para comparar porque el núcleo lo renueva en cada `#update` (`service.ts:588-589`).

### Otras opciones

- **Contador de versión por chat:** subirlo en `applyLive` con cada `chat` o `chat_message` del chat activo. Si `load()`
  ve que cambió durante la petición, descarta la respuesta y la vuelve a pedir, o la une como arriba. Es más robusto que
  comparar `updatedAt` cuando dos cambios caen en el mismo milisegundo. Por ejemplo, `#publishLive` difunde sin tocar
  `updatedAt` (`service.ts:596-598`).
- **Foto y búfer:** guardar en un búfer lo que llega por `/ws` mientras `load()` está en vuelo y volver a aplicarlo
  sobre la foto. Es el mismo patrón que ya se usa con `replay` por `seq` para los eventos.
- **Del lado del núcleo:** devolver chat y mensajes en una sola respuesta, sacados del mismo estado, con un número de
  versión. Así se quita la incoherencia entre las dos lecturas, aunque igual hace falta reconciliar con `/ws`.
  Que `interrupt` sin turno difunda el `chat` también daría una salida desde Detener.

La propuesta no es la única. Elegir entre comparar `updatedAt` y llevar un contador depende de cuánto se quiera tocar
el contrato con el núcleo.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta: agregar casos en `tests/ui/chat/chat-view.test.tsx`. El `fakeCore` de
  `tests/ui/chat/helpers.ts` responde en el acto, así que hay que envolver el `fetch` simulado (`vi.stubGlobal('fetch', …)`)
  para que `GET /chats/:id` espere una promesa diferida.
  1. *La carga no pisa lo vivo:* chat con `state: 'running'` en el núcleo y `GET /chats/:id` retenido. Con el `GET`
     pendiente, emitir por la live falsa un `chat_message` de la mente y `{ type: 'chat', chat: { ...chat, state: 'idle', updatedAt: <más nuevo> } }`.
     Después resolver el `GET` con `state: 'running'` y mensajes sin la respuesta. Afirmar que no está el botón
     «Detener respuesta», que el Composer deja enviar y que el texto de la respuesta sigue en el hilo con el botón
     «Copiar respuesta».
  2. *Detener aplica la respuesta:* dejar el store en `running`, sin eventos por `/ws`, con un `POST /chats/:id/interrupt`
     que devuelva `{ chat: { ...chat, state: 'idle', updatedAt: <más nuevo> } }`. Pulsar «Detener respuesta» y afirmar
     que la vista pasa a `idle`.
  3. *Detener no revive un running viejo:* emitir primero el `chat` `idle` por `/ws` y después resolver el `interrupt`
     con `state: 'running'` y un `updatedAt` más viejo. Afirmar que sigue en `idle`.
- Comando para correrla (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/chat/chat-view.test.tsx"`
  (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/chat/chat-view.test.tsx`).
- Verificación manual en la app: mandar a la mente una pregunta corta y, justo antes de que conteste, cambiar a otro chat
  y volver, o cortar y recuperar `/ws`. Repetir varias veces con la CPU cargada. El chat debe quedar en `idle` con la
  respuesta guardada y el Composer habilitado. Si alguna vez se queda en «Pensando…», «Detener» debe destrabarlo.
