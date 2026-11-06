# Cuando el SDK compacta la conversación de la mente, el chat no lo muestra: el usuario no sabe que la mente resumió lo anterior y puede haber perdido detalles

- **Área:** Interfaz: chat y composer
- **Severidad:** baja
- **Archivos:** `src/core/adapters/claude-sdk/translate.ts:532-545`, `src/shared/events.ts:37`, `src/ui/features/chat/timeline.ts:9`, `src/ui/features/chat/timeline.ts:16-24`, `src/ui/features/chat/timeline.ts:77-121`, `src/ui/features/chat/timeline.ts:139-140`, `src/ui/features/chat/components/MessageList.tsx:37-43`, `src/ui/features/chat/components/LiveReply.tsx:89-127`, `src/ui/features/chat/components/LiveReply.tsx:144`, `src/ui/features/agents-panel/model.ts:45-50`, `src/core/conductor/session.ts:366`, `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3810-3816`, `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:6032-6040`
- **Estado:** resuelta
- **Origen:** autoevaluación de la mente (2026-11-05), afirmación 3 («en tareas largas pierde detalles del principio»)
- **Relacionadas:** `autoeval-trabajo-01` (después de compactar, la mente solo puede recuperar decisiones con `leer_memoria`), `autoeval-trabajo-02` (al compactar, el prompt de sistema salta al de la última sesión), `ui-chat-03` (pasos que se pierden del hilo), `ui-chat-05` (la interfaz solo conserva los últimos 500 eventos de la sesión, así que una marca hecha solo con eventos se pierde al recargar un chat largo)

## Cómo ocurre

**Contexto.** En un chat largo, el SDK compacta solo la conversación de la mente: reemplaza los turnos viejos por un
resumen. Es el momento en que la mente «pierde detalles del principio», como ella misma dijo. El SDK lo avisa de dos
formas:

- `system/compact_boundary` con `trigger` y `pre_tokens` cuando termina (`sdk.d.ts:3810-3816`).
- `system/status` con `status: 'compacting'` mientras compacta, y `compact_result: 'success' | 'failed'` con
  `compact_error` al final (`sdk.d.ts:6032-6040`). El mismo mensaje trae también `status: 'requesting'` o `null`.

El traductor convierte el primero en un `status` con el detalle «contexto compactado». El segundo no tiene caso propio
(no está en la lista de avisos ignorados de `translate.ts:532-541`) y sale como `raw`:

```ts
// src/core/adapters/claude-sdk/translate.ts:542-545
case 'compact_boundary':
  return [this.status('running', 'contexto compactado')];
default:
  return [this.#raw(`claude-sdk:system/${base.data.subtype}`, message)];
```

El hilo del chat descarta los dos: `buildReply` no hace nada con `status` ni con `raw` (`timeline.ts:116-117`:
`default: break;`). En un turno ya guardado, `AssistantMessage` solo pinta los pasos que deja pasar `activityOf`
(herramientas, archivos y errores, `timeline.ts:139-140`) y después el texto guardado como un solo bloque
(`MessageList.tsx:38-43`). La fila «Mente» del panel muestra el detalle del último evento (`model.ts:49`), así que
«contexto compactado» se ve unos segundos hasta que llega el próximo texto o herramienta, y solo si el panel está
abierto.

**Pasos.**

1. Un chat (en cualquier modo) lleva horas trabajando. En un turno el SDK compacta. Mientras tanto, el usuario ve
   «Pensando…» (`LiveReply.tsx:144`) durante decenas de segundos, sin explicación.
2. El turno sigue y termina. En el hilo no queda ninguna marca de que la mente ahora trabaja con un resumen.
3. El usuario sigue dando por hecho que la mente recuerda una restricción que dio al principio («no toques
   `src/legacy`»). La mente ya no la tiene, salvo que haya quedado en el resumen o en la memoria.
4. Si la compactación falla (`compact_result: 'failed'`), el aviso termina como `raw` y tampoco se ve. El turno
   siguiente puede fallar por contexto lleno sin que nada lo anticipe.

Tampoco hay ningún hook que ayude a la mente después de compactar: la sesión solo registra `PreToolUse`
(`session.ts:366`).

## Por qué pasa

La compactación se trató como un aviso interno del SDK, igual que los latidos, y no como un cambio de estado de la
conversación que le importa al usuario. La vista de chat solo sabe pintar texto, herramientas, archivos y errores
(`LiveItem`, `timeline.ts:16-24`).

## Solución posible

1. **`src/shared/events.ts`:** exportar un `detail` fijo, por ejemplo `COMPACTED_DETAIL = 'contexto compactado'`, para
   que núcleo e interfaz reconozcan el mismo `status` sin cambiar el contrato de eventos (`events.ts:37`). Va en
   `shared` porque la interfaz no importa valores del núcleo.
2. **`src/core/adapters/claude-sdk/translate.ts`:** usar esa constante en `compact_boundary` y agregar
   `case 'status'`. Con `status: 'compacting'` emitir `status('running', 'compactando el contexto')`. Con
   `compact_result: 'failed'` emitir un `error` con `compact_error` (el texto ya pasa por `this.redact` en `#event`).
   Con `requesting`, `null` o `compact_result: 'success'` devolver `[]`, para que el caso nuevo no siga dejando `raw`.
3. **`src/ui/features/chat/timeline.ts`:** sumar a `LiveItem` un ítem `{ kind: 'compact'; key }` y crearlo en
   `buildReply` cuando llega un `status` con `COMPACTED_DETAIL`. Hacer que `activityOf` lo deje pasar, o exponer aparte
   si el turno compactó, para que el turno guardado no lo pierda.
4. **`src/ui/features/chat/components/LiveReply.tsx`:** en la respuesta en curso, pintarlo en su lugar del turno
   (caso nuevo en `ItemRow` o en `groupItems`) como un separador discreto: «La mente resumió la conversación para seguir.
   Si algo del principio es importante, recuérdaselo». Sin `role="alert"`.
5. **`src/ui/features/chat/components/MessageList.tsx`:** en un turno guardado el texto es un solo bloque
   (`message.text`), así que el separador no puede ir entre dos partes de la respuesta. Mostrarlo como una línea antes
   del texto, junto a `ActivitySummary`: «En este turno la mente resumió la conversación…».

### Otras opciones

- **Marca durable en el núcleo.** La interfaz guarda solo los últimos 500 eventos de la sesión (`MAX_SESSION_EVENTS`,
  `timeline.ts:9`; ver `ui-chat-05`). En un chat largo, que es justo donde se compacta, el evento queda fuera al
  recargar y la marca desaparece. Si se quiere que dure, el núcleo puede guardar el momento de la compactación (un
  campo del chat como `lastCompactedAt`, o un mensaje con un `kind` propio) y la interfaz anclarlo por `at`, igual que
  propone `ui-chat-03` para los errores.
- **Ayudar a la mente además del usuario:** registrar un hook `SessionStart` con `source: 'compact'` (`sdk.d.ts:6656`)
  que devuelva `additionalContext` con lo que Berland sabe con certeza: las propuestas de este chat con su estado, el
  destino de los cambios y la indicación de releer la memoria con `leer_memoria`. Sirve más una vez resuelto
  `autoeval-trabajo-01`. Hay que comprobar antes que el SDK dispara ese evento en los hooks en proceso.
- **Mostrar el uso de contexto** en la cabecera del chat (por ejemplo «contexto 82 %»), para que el usuario vea venir la
  compactación. Necesita leer el uso que trae el SDK, y es más trabajo que el separador.

La propuesta no es la única y puede haber una mejor. Basta con que las pruebas de abajo pasen.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:**
  - `tests/core/adapters/claude-sdk/translate.test.ts`: `{ type: 'system', subtype: 'status', status: 'compacting' }`
    produce un `status` «compactando el contexto»;
    `{ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'x' }` produce un
    `error` con «x»; `{ type: 'system', subtype: 'status', status: 'requesting' }` no produce ningún evento (ni `raw`).
    `compact_boundary` sigue dando un `status` con `COMPACTED_DETAIL`.
  - `tests/ui/chat/helpers.ts`: agregar `ev.status(seq, sec, detail)`.
  - `tests/ui/chat/timeline.test.tsx`: `buildReply([text(0, 1, 'a'), status(1, 2, COMPACTED_DETAIL), text(2, 3, 'b')])`
    devuelve los ítems `text`, `compact`, `text`, en ese orden, y `activityOf` de ese borrador conserva la marca.
  - `tests/ui/chat/chat-view.test.tsx`: un turno guardado (mensaje por REST y eventos por el `replay` del live falso) con
    ese evento muestra el texto del separador dentro de ese mensaje de la mente, antes del texto de la respuesta, y sin
    `role="alert"`. Un turno en curso con los eventos `text`, `status`, `text` lo muestra entre las dos partes.
- **Comando** (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/adapters/claude-sdk/translate.test.ts tests/ui/chat"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/adapters/claude-sdk/translate.test.ts tests/ui/chat`).
- **Verificación manual:** en un chat largo, o forzando una compactación con un chat lleno de adjuntos de texto, esperar
  el turno en que el SDK compacta. Mientras compacta, el panel «Mente» debe decir «compactando el contexto». El hilo
  debe mostrar el separador en ese punto del turno y, al terminar, la línea en ese mensaje de la mente. Al recargar la
  vista la línea debe seguir ahí mientras el evento esté entre los últimos 500 de la sesión (o siempre, si se eligió la
  marca durable).
