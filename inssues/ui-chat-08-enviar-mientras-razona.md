# Mientras la mente razona no se le puede escribir: hay que detener el turno para mandarle lo que faltó

- **Área:** Interfaz: chat y composer
- **Severidad:** media
- **Archivos:** `src/core/chat/service.ts:505-511`, `src/core/chat/routes.ts:204`, `src/shared/api.ts:196-203`, `src/core/conductor/session.ts:462-485`, `src/core/conductor/session.ts:521-523`, `src/ui/features/composer/Composer.tsx:70-72`, `src/ui/features/composer/Composer.tsx:146-148`, `src/ui/features/composer/Composer.tsx:222-226`, `src/ui/features/chat/ChatView.tsx:100`, `src/ui/features/chat/ChatView.tsx:372-373`, `src/ui/features/chat/store.ts:447-460`
- **Estado:** abierta

## Cómo ocurre

Pedido del usuario: «Yo puedo tener a los agentes trabajando, pero si quiero agregar algo más para decirle algo tengo
que pausar todo y ahí recién enviar lo que me faltó. Me gustaría una opción de enviar mensajes mientras razona, y que
tenga la opción de aprobar que el envío sea inmediato, o que espere hasta que termine, o que lo pueda enviar más tarde.»

Pasos:

1. En un chat, mandar un encargo largo. El chat pasa a `running` y la mente trabaja (herramientas, subagentes).
2. Escribir en el Composer algo que faltó («y revisa también los tests») y pulsar Enter.
3. No pasa nada: el botón de la derecha es «Detener respuesta» y Enter no envía. La única salida es detener el turno,
   esperar a que la mente quede libre y recién ahí mandar el mensaje. Lo que la mente ya había avanzado en ese turno se
   corta.

Si el mensaje llega igual al núcleo (otra pestaña, Postman), la respuesta es un 409 «La mente todavía está
respondiendo: espera o interrumpe el turno».

## Por qué pasa

Las dos puntas cierran el paso:

- **Núcleo.** `ChatService.send` rechaza todo mensaje con un turno en curso (`src/core/chat/service.ts:511`):

  ```ts
  if (live.busy) throw new ChatError('conflict', 'La mente todavía está respondiendo: espera o interrumpe el turno');
  ```

  La ruta lo documenta así (`src/core/chat/routes.ts:204`: «Con un turno en curso, 409») y el cuerpo
  `sendMessageBody` (`src/shared/api.ts:196-203`) no tiene forma de decir cuándo entregar el mensaje.
- **Interfaz.** `ChatView` pasa `isStreaming={running}` al Composer (`ChatView.tsx:100` y `:372`). Con eso,
  `canSend` es `false` (`Composer.tsx:70-72`, `!isStreaming`), `send` sale sin hacer nada (`Composer.tsx:147`) y el
  botón pasa a ser «Detener respuesta» (`Composer.tsx:222-226`). `store.send` (`store.ts:447-460`) solo sabe mandar un
  turno nuevo.

Y no es una limitación del SDK. La sesión de la mente ya usa entrada en streaming: `ConductorSession.send`
(`src/core/conductor/session.ts:462-485`) empuja cada mensaje a la cola de entrada del `query` del SDK, y el SDK acepta
mensajes nuevos mientras trabaja. `SDKUserMessage` trae `priority?: 'now' | 'next' | 'later'`
(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`), y el `result` de un turno informa `queued_turn_count`, los
envíos del usuario que siguen en cola. Un mensaje que llega a mitad de turno se incorpora al turno entre dos rondas de
herramientas, o queda en cola y corre como turno propio al terminar.

## Solución posible

Cuando la mente trabaja, que el Composer deje escribir y, al enviar, pregunte cuándo entregar el mensaje:

- **Ahora.** El mensaje entra al turno en curso. El núcleo lo guarda en el hilo y lo empuja a la entrada del SDK con
  `priority: 'next'`: el SDK lo incorpora entre dos rondas de herramientas, sin cortar lo que la mente ya hizo. Si el
  turno termina antes, el SDK lo corre como turno propio y el núcleo lo recibe como un turno autónomo
  (`#beginAutonomousTurn`), con su respuesta guardada.
- **Al terminar.** El núcleo lo deja en una cola del chat (en memoria, en el `Live` del chat) y lo manda solo cuando
  termina el turno, de a uno y en orden. El chat lleva la cola en un campo `queued` (como `backgroundTasks`), así que la
  interfaz la ve por `/ws` aunque se cambie de chat. En el hilo se ve «En cola» con un botón para quitarlo
  (`DELETE /chats/:id/queue/:queuedId`).
- **Más tarde.** El mensaje queda guardado en la interfaz como pendiente de ese chat, sin enviarse. Se ve sobre el
  Composer con «Enviar» y «Borrar».

En el contrato, cambios opcionales y compatibles: `delivery?: 'now' | 'after-turn'` en `sendMessageBody`, `queued?` en
`chatSchema` y una respuesta `{ queued, chat }` para el mensaje encolado. Sin `delivery`, el núcleo sigue respondiendo
409 con un turno en curso: los clientes de hoy no cambian y dos envíos simultáneos siguen sin arrancar dos turnos.

Con la mente libre, enviar funciona como hoy.

### Otras opciones

- **«Ahora» como interrupción.** Cortar el turno (`interrupt`) y mandar el mensaje en cuanto el SDK lo cierre. Es lo
  que hace hoy el usuario a mano: se pierde lo que la mente estaba haciendo (una herramienta a medias, un plan sin
  terminar). Con el SDK aceptando mensajes en el turno, no hace falta.
- **`priority: 'now'`.** El SDK aborta la herramienta en curso para atender el mensaje. Es más inmediato pero corta
  trabajo a medias; `'next'` espera solo a que termine la herramienta en curso.
- **Cola de «al terminar» en la interfaz.** Más simple, pero se pierde al cambiar de chat o cerrar la ventana, y dos
  ventanas podrían mandar el mismo mensaje dos veces.
- **Guardar la cola en SQLite.** Sobreviviría a un reinicio del núcleo, pero hay que decidir qué hacer con un mensaje en
  cola cuando el turno que esperaba murió con el reinicio. Se puede sumar después.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta, núcleo** (`tests/core/chat/`):
  - con un turno en curso, `send(chatId, { text, delivery: 'after-turn' })` no lanza `conflict`: devuelve el mensaje
    encolado y el chat lo muestra en `queued`. Al terminar el turno se envía solo y, con dos encolados, salen en orden,
    uno por turno. Quitar uno con `unqueue` lo saca de la cola y no se envía;
  - con un turno en curso, `delivery: 'now'` guarda el mensaje en el hilo enseguida y lo entrega a la entrada del SDK
    con `priority: 'next'`; la respuesta queda en el historial;
  - sin `delivery`, con un turno en curso, sigue el 409.
- **Prueba automatizada propuesta, interfaz** (`tests/ui/chat/`): con el chat en `running`, escribir y enviar muestra
  las tres opciones; «Ahora» y «Al terminar» mandan `delivery` en el cuerpo; un chat con `queued` muestra «En cola» y
  «Quitar» llama a `DELETE /chats/:id/queue/:queuedId`; «Más tarde» deja el pendiente sobre el Composer sin ningún
  `POST`, y su «Enviar» lo manda.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/chat/enviar-en-curso.test.ts tests/ui/chat/enviar-en-curso.test.tsx"`.
- **Verificación manual:** mandar un encargo largo, escribir otro mensaje mientras la mente trabaja y probar las tres
  opciones. «Ahora» aparece en el hilo y la mente lo toma en el mismo turno; «Al terminar» aparece «En cola» y se
  manda solo al terminar; «Más tarde» queda sobre el Composer hasta pulsar «Enviar».
