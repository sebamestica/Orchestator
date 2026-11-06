# El texto y los adjuntos sin enviar del Composer se quedan al cambiar de conversación y se mandan a la otra

- **Área:** Interfaz: chat y composer
- **Severidad:** baja
- **Archivos:** `src/ui/app/App.tsx:26`, `src/ui/app/App.tsx:28`, `src/ui/features/chat/ChatView.tsx:148-161`, `src/ui/features/chat/ChatView.tsx:311-312`, `src/ui/features/chat/ChatView.tsx:361-374`, `src/ui/features/composer/Composer.tsx:59`, `src/ui/features/composer/Composer.tsx:69`, `src/ui/features/composer/Composer.tsx:146-156`, `src/ui/features/composer/useAttachments.ts:19`, `src/ui/features/chat/components/ChatHeader.tsx:146-149`, `src/ui/features/chat/components/ChatHeader.tsx:165-168`, `src/ui/features/chat/store.ts:287-291`, `src/ui/features/chat/store.ts:298-320`, `src/core/chat/service.ts:424`, `src/core/chat/service.ts:443-447`
- **Estado:** abierta

## Cómo ocurre
Cada proyecto (y «Conversaciones», sin proyecto) se ve en una sola `ChatView`. En su encabezado, el selector de
conversaciones permite pasar a otro chat o crear uno nuevo, y abajo está el Composer, donde se escribe el mensaje y se
juntan los adjuntos.

Pasos:
1. En la conversación A de un proyecto, escribir un mensaje y adjuntar un archivo (en Electron, soltando un archivo
   del disco), sin enviarlo.
2. Abrir «Conversaciones del proyecto» y elegir la conversación B, o pulsar «Nueva conversación».
3. B se carga, pero el campo sigue mostrando el texto de A y la bandeja sigue con el adjunto de A.
4. Al pulsar Enter, el mensaje pensado para A se manda a B.

Evidencia:
- `ChatView` lleva `key` por proyecto, no por chat, así que cambiar de conversación no la vuelve a montar
  (`src/ui/app/App.tsx:26` y `:28`):
  ```tsx
  return <ChatView key={`p:${route.projectId}`} projectId={route.projectId} {...(route.chatId ? { chatId: route.chatId } : {})} />;
  return <ChatView key="suelto" projectId={null} ... />;
  ```
- El selector solo navega (`ChatHeader.tsx:146-149` → `ChatView.tsx:311` `onSelect={(id) => toChat(id)}`), y la
  vista cambia el chat activo en el store sin tocar el Composer: `select` vacía mensajes, propuestas y eventos, pero
  el borrador no está ahí (`store.ts:287-291`). «Nueva conversación» hace lo mismo con `createChat`, que pone el chat
  nuevo como activo (`ChatView.tsx:172-175`, `store.ts:298-320`).
- El Composer se dibuja siempre en el pie, con las mismas props y sin `key` (`ChatView.tsx:361-374`). Su borrador es
  estado local: `const [text, setText] = useState('');` (`Composer.tsx:59`) y `useAttachments(onAttach)`
  (`Composer.tsx:69`, `useAttachments.ts:19`). Nada lo limpia al cambiar de chat; solo se vacía después de un envío
  aceptado (`Composer.tsx:153-156`).
- Durante la carga de B el campo queda deshabilitado (`canWrite` falso, `ChatView.tsx:230` y `:372`) pero conserva el
  texto, y vuelve a habilitarse con él.
- Al enviar, `onSubmit` toma el chat activo del store en ese momento, es decir B
  (`ChatView.tsx:150`: `let current = useChat.getState().chat;`, y `:158` `store.send(current.id, ...)`).
- Los adjuntos no están atados a un chat: se registran con `POST /attachments` o `/attachments/by-path` sin chat
  (`src/core/chat/routes.ts:265-299`) y el núcleo los acepta en cualquier envío (`service.ts:424`,
  `#attachment(id)` en `service.ts:601-605`). Si el adjunto es un archivo por ruta, su carpeta pasa a ser legible por
  la mente de B: `live.roots.add(root)` (`service.ts:443-447`); solo se retira si el envío falla (`service.ts:486`).

El texto queda a la vista al llegar a B, así que no es un envío oculto; el riesgo es no notarlo y mandar a otra
conversación un mensaje (y un permiso de lectura sobre una carpeta) que era para la primera.

Relación con otra issue: `inssues/agy-21-aviso-adjunto-20mb-no-se-puede-cerrar.md` ya nota que el estado del
Composer cruza de chat, pero solo trata el aviso de 20 MB y deja el borrador como «un cambio de comportamiento
aparte». Esta issue es ese cambio.

## Por qué pasa
El borrador (texto y bandeja de adjuntos) vive dentro del Composer, que es una sola instancia para todas las
conversaciones del proyecto. No se reinicia ni se guarda por chat activo, y el envío siempre va al chat que esté activo
cuando se pulsa Enter.

## Solución posible
Guardar el borrador por conversación, siguiendo el patrón que ya existe para el esfuerzo (`efforts` por chat y
`draftEffort` antes de que exista el chat, que `createChat` pasa al chat nuevo en `store.ts:299-309`):
1. En `src/ui/features/chat/store.ts`, añadir `drafts: Record<string, string>` (texto por id de chat) y `draftText`
   para la conversación aún sin crear, con una acción `setDraft(text)` que escriba en el chat activo o en `draftText`.
   En `createChat`, pasar `draftText` al id nuevo, igual que `draftEffort`.
2. En `src/ui/features/composer/Composer.tsx`, aceptar `text`/`onTextChange` opcionales (controlado desde fuera); si no
   llegan, seguir con el estado local de hoy, para no romper otros usos.
3. En `src/ui/features/chat/ChatView.tsx`, pasar el borrador del chat activo y `setDraft`, y vaciar la bandeja de
   adjuntos al cambiar de chat activo (por ejemplo, con una prop `resetKey={activeId}` que llame a
   `attachments.clear()` en un efecto, salvo en el paso de `null` al chat que se acaba de crear).

Cuidado con la solución más corta, `key={activeId ?? 'nuevo'}` en el `<Composer>`: el primer mensaje de una
conversación sin crear pasa por `createChat` dentro de `onSubmit` (`ChatView.tsx:151-154`), que cambia `activeId` de
`null` al id nuevo mientras el Composer espera la respuesta. Con esa `key` el Composer se volvería a montar a mitad
del envío y, si el `POST /chats/:id/messages` falla (`store.send` devuelve `false`, `store.ts:411-413`), el texto que
el Composer conservaría hoy (`Composer.tsx:153`) se perdería. Si se usa una `key`, no debe cambiar en ese paso
(`null` → chat creado por el propio envío), solo cuando el usuario elige otra conversación.

### Otras opciones
La propuesta no es la única y puede haber una más simple:
- Dar al Composer una `key` que la vista solo cambia en las navegaciones del usuario (`onSelect` con otro id, `onNew`,
  `goLatest`, borrar el chat activo), no al crear el chat desde el primer envío. Es poco código y empieza cada chat
  vacío, pero pierde el borrador al ir y volver, y no cubre un cambio de ruta que llegue por otro camino.
- Mantener el borrador pero avisar en el Composer («Este borrador se escribió en otra conversación») hasta que el
  usuario lo edite o lo descarte. Evita perder texto, aunque añade un aviso más en el pie.
- Limpiar solo los adjuntos al cambiar de chat y dejar el texto. Corta el caso más delicado (la carpeta que pasa a ser
  legible por la mente de B) con un cambio mínimo, pero deja el texto cruzando de conversación.
- Atar los adjuntos al chat en el núcleo (registrar con `chatId` y rechazar en `send` los de otro chat) como defensa
  adicional; es un cambio de contrato más grande y no resuelve el texto.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta en `tests/ui/chat/chat-view.test.tsx` (usa `FakeComposer`, que guarda su propio texto;
  si el borrador pasa al store, ajustar el falso para que use `text`/`onTextChange` cuando lleguen):
  - Escenario «el borrador no pasa a otra conversación»: `fakeCore` con dos chats A y B; `render(<ChatView
    projectId="demo" chatId="chat_aaa111" />)`; escribir «para A» en `getByLabelText('Mensaje')`; abrir «Conversaciones
    del proyecto» y elegir B; como la prueba no monta `App`, simular la ruta con `rerender(<ChatView projectId="demo"
    chatId="chat_bbb222" />)` (misma instancia, como hace `App.tsx:26`). Afirmar que el campo está vacío y que, al
    pulsar «Enviar», no hay ningún `POST /chats/chat_bbb222/messages` con `text: 'para A'`. Si se guarda por chat,
    afirmar además que con `rerender(... chatId="chat_aaa111")` el campo vuelve a mostrar «para A».
  - Escenario de regresión «el primer envío fallido no borra el texto»: `fakeCore` sin chats y un `extra` que responda
    `{ status: 500, body: { error: { code: 'internal', message: 'falla' } } }` a `POST /chats/chat_new001/messages`;
    escribir «hola», pulsar «Enviar» y afirmar que, tras el aviso «No se pudo enviar», el campo sigue con «hola».
  - En `tests/ui/composer/Composer.test.tsx`, si se añade el vaciado de la bandeja por cambio de chat: montar el
    Composer, adjuntar un archivo, volver a renderizar con otro `resetKey` y afirmar que la bandeja quedó vacía.
- Comando para correrlas (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/chat/chat-view.test.tsx tests/ui/composer/Composer.test.tsx"`
  (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/chat/chat-view.test.tsx tests/ui/composer/Composer.test.tsx`).
- Verificación manual en la app: en un proyecto con dos conversaciones, escribir un texto y soltar un archivo en A,
  pasar a B con el selector y comprobar que el campo y la bandeja están vacíos (y que al volver a A el texto
  reaparece, si se guarda por chat). Repetir desde un proyecto sin conversaciones: escribir, enviar con el núcleo
  caído y comprobar que el texto no se pierde.
