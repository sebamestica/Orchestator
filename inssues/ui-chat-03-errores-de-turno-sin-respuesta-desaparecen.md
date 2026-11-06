# El error y los pasos de un turno que terminó sin respuesta desaparecen del hilo cuando el usuario manda otro mensaje

- **Área:** Interfaz: chat y composer
- **Severidad:** media
- **Archivos:** `src/ui/features/chat/timeline.ts:160`, `src/ui/features/chat/timeline.ts:176`, `src/ui/features/chat/components/MessageList.tsx:73`, `src/ui/features/chat/ChatView.tsx:105`, `src/ui/features/chat/ChatView.tsx:110`, `src/core/chat/service.ts:847`
- **Estado:** abierta

## Cómo ocurre

Contexto. El hilo del chat sale de dos fuentes: los mensajes guardados (`ChatMessage`, solo `user` o `assistant`, `src/shared/api.ts:170`) y los `AgentEvent` de la sesión de la mente (texto, herramientas, errores, uso), que llegan por `/ws` y por `replay`. `splitTurns` reparte los eventos entre los mensajes según su `ts`, y lo que queda después del último mensaje es el borrador en vivo (`LiveReply`).

El núcleo solo guarda un mensaje de la mente si el turno dejó texto:

```ts
// src/core/chat/service.ts:846-848
const ok = result?.success === true && result.data.subtype === 'success' && result.data.is_error !== true;
const final = ok && result.data.result?.trim() ? result.data.result : turn.texts.join('\n\n');
if (final.trim()) {
```

Cuando el turno falla, el traductor del SDK emite un evento `error` con el motivo y después `done` (`src/core/adapters/claude-sdk/translate.ts:577-590`). El texto sintético de un error de la API no se emite como `text` (`translate.ts:417`). Si la sesión se cae, el núcleo emite «La conversación con la mente se cortó: …» (`service.ts:800`) y cierra el turno en el `finally` (`service.ts:809`). En los dos casos `turn.texts` queda vacío, no se guarda ningún mensaje de la mente y el chat pasa a `state: 'error'` (`service.ts:860`). Lo mismo pasa si el usuario corta con «Detener» antes de que la mente escriba texto: las herramientas que alcanzó a correr quedan solo como eventos.

Pasos:

1. El usuario manda U1. El turno falla sin texto (cupo agotado, error de la API, sesión cortada) o se interrumpe tras correr algunas herramientas.
2. Mientras U1 es el último mensaje, esos eventos caen en `pending`. Como el último mensaje no es de la mente, `showDraft` es verdadero y el error se ve en `LiveReply`:
   ```ts
   // src/ui/features/chat/ChatView.tsx:110
   const showDraft = running || (draft.items.length > 0 && messages.at(-1)?.role !== 'assistant');
   ```
3. El usuario reintenta con U2 (el composer no se bloquea por `chat.state === 'error'`: `canWrite` depende solo del estado de carga, `ChatView.tsx:230`). El núcleo guarda U2 con un `at` posterior a los eventos del turno fallido (`service.ts:458-466`).
4. `splitTurns` le da a U2 los eventos con `ts` en (U1.at, U2.at], que son justo los del turno fallido, y los descarta porque U2 es de usuario:
   ```ts
   // src/ui/features/chat/timeline.ts:171-176
   while (i < list.length && time(list[i]?.ts ?? '') <= until) { ... chunk.push(e); i++; }
   if (m && m.role === 'assistant' && chunk.length) byMessage.set(m.id, chunk);
   ```
5. `MessageList` solo pinta pasos dentro de `AssistantMessage`. `UserMessage` no recibe eventos (`MessageList.tsx:73`). El hilo queda U1 → U2 → A2, sin el motivo del fallo ni las herramientas que corrió el primer turno.

Al recargar el chat pasa lo mismo, porque el `replay` trae los mismos eventos y `splitTurns` los vuelve a repartir igual. Tampoco queda otra pista visible: `ChatHeader` solo marca « · trabajando» cuando el estado es `running` (`ChatHeader.tsx:105`), así que el `state: 'error'` del chat no se muestra en ninguna parte.

La prueba actual de `splitTurns` (`tests/ui/chat/timeline.test.tsx:67-85`) solo cubre turnos que cierran con un mensaje de la mente. No hay caso con dos mensajes de usuario seguidos, y `tests/ui/chat/helpers.ts:75-86` no tiene ayudante para eventos `error`.

## Por qué pasa

`splitTurns` da por hecho que cada turno cierra con un mensaje `assistant` guardado. El núcleo no cumple eso cuando el turno termina sin texto (`service.ts:848`). Los eventos de ese turno quedan en el trozo del siguiente mensaje de usuario, y `timeline.ts:176` los tira sin avisar. Mientras no llega otro mensaje se ven porque siguen en `pending`, y por eso el problema solo aparece al reintentar o al recargar después de reintentar.

## Solución posible

En la interfaz, sin tocar el núcleo:

1. `src/ui/features/chat/timeline.ts`: agregar a `Turns` un mapa `orphanByUser: Map<string, AgentEvent[]>`. En `splitTurns`, cuando el trozo cae antes de un mensaje `user` y el mensaje anterior también es `user` (un turno sin respuesta guardada), guardar el trozo con la clave del id de ese mensaje de usuario anterior. Conviene quedarse solo con trozos que tengan algún paso (`tool_*`, `file_change`, `error`), para no anclar eventos sueltos como el `usage` que la prueba actual pone entre `a1` y `u2`.
2. `src/ui/features/chat/components/MessageList.tsx`: recibir `orphanByUser` y, después del `UserMessage`, mostrar un bloque de «turno sin respuesta». Ese bloque lleva `ActivitySummary` con los pasos y, si hubo `error`, la fila del error a la vista con un texto como «Este turno terminó sin respuesta». La fila no debe llevar `role="alert"` al pintarse desde el historial, porque si no un lector de pantalla anuncia errores viejos en cada carga.
3. `src/ui/features/chat/ChatView.tsx:105` y `:285`: pasar `turns.orphanByUser` a `MessageList`.

### Otras opciones

- **Guardar el fallo en el núcleo.** En `#finishTurn` (`src/core/chat/service.ts:838`), cuando el turno no es `ok`, no fue interrumpido y `final` está vacío, guardar un mensaje de la mente con el motivo (el último `error` emitido en el turno). El historial REST lo conservaría aunque los eventos salgan de los últimos `MAX_SESSION_EVENTS` (500) que guarda la interfaz (`timeline.ts:9`), y `splitTurns` funcionaría sin cambios. El costo: el motivo quedaría como texto normal de la mente. Para distinguirlo habría que extender `chatMessageSchema` (`src/shared/api.ts:167`) con un campo de tipo `kind: 'error'` y adaptar repo y migración. El caso de «Detener» sin texto seguiría necesitando el arreglo en la interfaz para no perder las herramientas.
- **Anclar los eventos huérfanos al siguiente mensaje de la mente** (A2) en lugar de a U1. Es más simple en `splitTurns`, pero mezcla los pasos de dos turnos y el error parecería parte de la respuesta que sí funcionó.
- Las dos capas se pueden combinar: el núcleo deja constancia durable del fallo y la interfaz muestra los pasos sueltos. Lo propuesto arriba es una opción entre varias, y puede haber una más limpia, por ejemplo que el núcleo marque el cierre de cada turno con un evento propio para no depender de comparar `ts`.

Hay un caso parecido que conviene revisar con el mismo arreglo. Si un turno autónomo de la mente (`#beginAutonomousTurn`, `service.ts:865`) falla sin texto después de una respuesta guardada, sus eventos quedan en `pending` y `showDraft` es falso apenas termina, porque el último mensaje es `assistant`. Ese error tampoco se ve nunca.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:**
  - `tests/ui/chat/helpers.ts`: agregar `ev.error(seq, sec, message)` que arme `{ type: 'error', payload: { code: 'unknown', message } }`.
  - `tests/ui/chat/timeline.test.tsx`, en `describe('splitTurns')`: mensajes `[u1 (at 10), u2 (at 50), a2 (at 80)]` y eventos `[call(0, 12, 'c1', 'Read', 'a.ts'), error(1, 15, 'Se agotó el cupo'), text(2, 60, 'listo')]`. Hoy `byMessage` no tiene el error ni la herramienta y `pending` está vacío. Tras el arreglo, `orphanByUser.get('u1')` debe tener los seq `[0, 1]`, `byMessage.get('a2')` debe tener `[2]` y `pending` debe seguir vacío. Agregar también un caso que confirme que el `usage` suelto de la prueba actual (seq 2, entre `a1` y `u2`) no genera un huérfano.
  - `tests/ui/chat/chat-view.test.tsx`: renderizar ese escenario (mensajes por REST y eventos por el `replay` del live falso) y esperar que aparezcan «Se agotó el cupo» y el texto de turno sin respuesta entre los dos mensajes de usuario. Afirmar que no hay `role="alert"` para ese error del historial.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/chat/timeline.test.tsx tests/ui/chat/chat-view.test.tsx"` (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/ui/chat/timeline.test.tsx tests/ui/chat/chat-view.test.tsx`).
- **Verificación manual:** en un chat, mandar un mensaje y pulsar «Detener» justo después de que la mente lance una herramienta y antes de que escriba texto (o provocar un fallo, por ejemplo con el cupo agotado). Mandar un segundo mensaje y esperar la respuesta. El primer turno debe seguir mostrando sus pasos o su error debajo del primer mensaje, también después de recargar la vista.
