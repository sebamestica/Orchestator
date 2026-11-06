# En el hilo del chat, cada resultado de herramienta se corta a 300 caracteres y los pasos de los subagentes no aparecen: el usuario no puede comprobar de dónde sacó la mente sus cifras

- **Área:** Interfaz: chat y composer
- **Severidad:** media
- **Archivos:** `src/core/adapters/claude-sdk/translate.ts:38`, `src/core/adapters/claude-sdk/translate.ts:57-66`, `src/core/adapters/claude-sdk/translate.ts:69-72`, `src/core/adapters/claude-sdk/translate.ts:322-330`, `src/core/adapters/claude-sdk/translate.ts:441`, `src/core/adapters/claude-sdk/translate.ts:459-467`, `src/core/app/f5-chat.ts:116`, `src/core/conductor/tools.ts:29`, `src/core/conductor/tools.ts:113-114`, `src/core/conductor/prompt.ts:42`, `src/core/conductor/prompt.ts:67`, `src/core/conductor/session.ts:76-87`, `src/ui/features/chat/use-chat-live.ts:42-44`, `src/ui/features/chat/timeline.ts:91-101`, `src/ui/features/chat/components/LiveReply.tsx:78-85`, `src/ui/features/chat/components/LiveReply.tsx:103-108`, `src/ui/features/agents-panel/model.ts:45-56`, `src/ui/features/agents-panel/model.ts:72-80`, `src/core/server/app.ts:630`
- **Estado:** abierta
- **Origen:** autoevaluación de la mente (2026-11-05), afirmaciones 2 («se equivoca con mucha seguridad») y 4 («repite lo que devuelve una herramienta sin poder comprobarlo»)
- **Relacionadas:** `ui-chat-03` (los pasos de un turno fallido desaparecen), `ui-chat-05` (el hilo solo guarda los últimos 500 eventos), `ui-resto-04` (la fila «Mente» del panel), `uso-real-06` (las sesiones hijas de la mente en la tienda, que la solución leería)
- **Revisión (2026-11-05):** las citas se verificaron contra `63748b8`. Se corrigió: la fila «Mente» del panel es
  `model.ts:72-80` (no solo `:45-50`) y muestra la acción más reciente de la mente **o** de un subagente; la opción
  nueva va en `TranslatorOptions` (`translate.ts:57-66`) y no hace falta tocar `TranslatorInit` de `ports.ts`; la
  prueba de `f5-chat` y la de la vista se reescribieron para que se puedan armar con los helpers que existen
  (`chatQuery`, `fakeCore(…, extra)`; no hay `fetchMock`). Se agregó que la «Entrada» también se corta a 300.

## Cómo ocurre

**Contexto.** El prompt le pide a la mente «Cifras exactas tomadas de las herramientas; nunca inventes estados, cupos
ni resultados» (`prompt.ts:67`). La única forma que tiene el usuario de comprobarlo es abrir los pasos del turno
(«N pasos», `ActivitySummary`) y mirar el «Resultado» de cada herramienta (`LiveReply.tsx:103-108`). Ese resultado no es
lo que vio la mente:

- La mente recibe hasta 8.000 caracteres de cada herramienta propia (`tools.ts:29` y `:113-114`) y la salida de Read,
  Grep, Bash y los plugins con los topes propios del SDK, muy por encima de 300.
- El traductor guarda como `tool_result.summary` solo los primeros 300, en una sola línea:

```ts
// src/core/adapters/claude-sdk/translate.ts:38 y :467
export const SUMMARY_MAX = 300;
out.push(this.#event('tool_result', { callId, ok, summary: truncate(this.redact(toolResultText(content))) }, target, targetParent));
```

La interfaz pinta ese resumen tal cual en «Resultado» (`timeline.ts:95-101`, `LiveReply.tsx:106`). No hay forma de ver
el resto: el evento ya llegó cortado al núcleo y así se guardó en SQLite. La «Entrada» tiene el mismo tope
(`inputSummary: truncate(…)`, `translate.ts:441`): el `plan` de `crear_tareas`, un comando Bash largo o los argumentos
JSON de una herramienta MCP también se ven cortados en «…».

Los subagentes quedan aún más ocultos. El prompt le pide a la mente usarlos «para investigar en paralelo sin llenar tu
contexto» (`prompt.ts:42`), y el `investigador` debe devolver «cifras exactas» (`session.ts:81`). Sus herramientas y su
texto salen en una sesión hija, con `sessionId` = id de la llamada `Agent` y `parentSessionId` = la sesión del chat
(`translate.ts:322-330`). La vista del chat solo acepta eventos de la sesión principal:

```ts
// src/ui/features/chat/use-chat-live.ts:43
if (sessionId && message.event.sessionId === sessionId) queue([message.event]);
```

En el hilo queda una sola fila `Agent · investigador: <descripción>`, y como resultado los primeros 300 caracteres de
su informe (`translate.ts:459-467`). El panel derecho tampoco lo suple: su fila «Mente» muestra en una sola línea la
acción más reciente entre la mente y todos sus subagentes (`mindRow`, `model.ts:72-80`, con el texto de `actionText`,
`:45-56`), y el panel está oculto bajo `lg`. Los eventos de cada subagente sí están guardados en SQLite como una sesión
propia (`appendEvent` crea la fila de `sessions`) y se pueden pedir por `GET /sessions/:id/events` (`app.ts:630`), pero
ninguna vista del chat lo hace (en `src/ui/features/chat` no hay ninguna referencia a `parentSessionId` ni a
`/events`).

**Pasos.**

1. En un chat de proyecto, el usuario pregunta «¿cuánto cupo le queda a Codex y cuántas tareas fallaron?».
2. La mente llama a `cupos()` y a `estado()`. Cada respuesta es un JSON de varios cientos o miles de caracteres: por
   agente, `restantePct`, `reinicio`, `ventanas`, `leido` y `desactualizado`; y la lista de tareas con sus estados.
3. La mente responde con cifras. El usuario abre los pasos y en «Resultado» ve, por ejemplo, el comienzo del primer
   agente de `cupos` terminado en «…». Si la cifra que citó la mente está más allá del carácter 300, el usuario no
   puede comprobarla.
4. Si la mente delegó la investigación en un `investigador`, el usuario ni siquiera ve qué archivos leyó ni qué buscó.
   Solo ve 300 caracteres de la conclusión.

La prueba actual fija el recorte para la entrada (`tests/core/adapters/claude-sdk/translate.test.ts:231-241`). No hay
prueba de la interfaz con resultados largos ni con eventos de subagentes en el chat.

## Por qué pasa

`SUMMARY_MAX` se pensó para las tarjetas y el panel de la flota, donde basta una línea. El chat reutiliza el mismo
traductor (`ClaudeSdkTranslator`) y el mismo evento, así que el detalle que debería servir para verificar es el mismo
resumen de una línea. Además, el hilo se arma con una sola sesión, y el SDK pone el trabajo de los subagentes en
sesiones hijas.

## Solución posible

1. **`src/core/adapters/claude-sdk/translate.ts`:** agregar a `TranslatorOptions` (`:57-66`) un `resultMax` opcional
   (por defecto `SUMMARY_MAX`) y usarlo en `tool_result.summary` (`:467`); si se quiere, también un `inputMax` para
   `inputSummary` (`:441`). En el chat (`src/core/app/f5-chat.ts:116`) pasar
   `translator: (init) => new ClaudeSdkTranslator({ ...init, resultMax: 8_000 })`, el mismo tope de
   `MAX_OUTPUT_CHARS`. `TranslatorInit` (`conductor/ports.ts:138-144`) no cambia: lo arma `ConductorSession` y el
   tope lo agrega quien construye el traductor. Como una sola instancia traduce la sesión principal y las hijas,
   vale para la mente y sus subagentes. La flota (`adapter.ts:311`) y la terminal antigua (`app/conductor.ts:187`)
   siguen con 300. Mantener el tachado (`this.redact`) y, para los resultados largos, no aplanar los saltos de línea,
   para que un JSON o un archivo se lean.
2. **`src/ui/features/chat/components/LiveReply.tsx`:** en la fila de una herramienta `Agent`/`Task`, al desplegarla,
   pedir `GET /sessions/<callId>/events` (los eventos de los mensajes del subagente van a la sesión `callId`,
   `translate.ts:322-330`; solo algunos `status` de `task_*` pueden caer en `task-*`, ver `uso-real-06`) y mostrar sus
   pasos con el mismo `ItemRow`, sangrados. Con el subagente en curso, sumar en `use-chat-live.ts:43` los eventos con
   `parentSessionId === sessionId` a un mapa aparte por `sessionId`, sin mezclarlos con el texto de la mente.
3. **`Detail`** (`LiveReply.tsx:78-85`) ya tiene scroll (`max-h-64 overflow-auto`), así que aguanta 8.000 caracteres.
   Conviene agregar un botón «Copiar».

### Otras opciones

- **Guardar el resultado completo aparte** (tabla `tool_outputs` por `callId`, o un archivo en el directorio de datos) y
  dejar el evento con 300 caracteres. Mantiene livianos `/ws` y el `replay` (ver `ui-chat-05`), y la interfaz lo pide
  solo al desplegar. Es más trabajo: ruta nueva, retención y limpieza en Ajustes › Almacenamiento.
- **Subir `SUMMARY_MAX` para todos.** Es la más simple, pero engorda los eventos de la flota, que ya pesan en el
  `replay` del tablero.
- **Mostrar los subagentes solo en el panel derecho**, con una lista de pasos al hacer clic en la fila. Deja el hilo
  limpio, pero el panel está oculto bajo `lg` (`agy-12`).

La propuesta no es la única y puede haber una mejor. Basta con que las pruebas de abajo pasen.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:**
  - `tests/core/adapters/claude-sdk/translate.test.ts`, caso nuevo «con resultMax el resultado no se corta a 300»:
    `new ClaudeSdkTranslator({ ...init, resultMax: 8000 })` y un mensaje `user` con un `tool_result` de 5.000
    caracteres. Afirmar que `summary.length === 5000`. Con el traductor por defecto debe seguir en 300 (`SUMMARY_MAX`).
  - `tests/core/chat/f5-chat.test.ts`: ampliar `setup()` para recibir el `TurnFn` de `chatQuery` (hoy fija
    `echoTurn`). Con un guion que emita `sdkInit`, un `assistant` con `tool_use` `Read` (id `r1`), un `user` con su
    `tool_result` de 5.000 caracteres y `sdkResult`, mandar un mensaje y esperar a que el chat salga de `running`.
    Afirmar que en `comp.store.eventsSince(chat.sessionId)` el `tool_result` de `r1` tiene `summary.length === 5000`.
  - `tests/ui/chat/chat-view.test.tsx`, junto a «arma texto por deltas y herramientas plegadas desde /ws»: emitir por
    `live.emit` un `ev.call(…, 'a1', 'Agent', 'investigador: revisar')` y su `ev.result(…, 'a1', true, …)`. Pasar a
    `fakeCore(init, extra)` un `extra` que responda a `GET /sessions/a1/events` con
    `{ sessionId: 'a1', events: [<tool_call Read de src/x.ts con sessionId a1>], lastSeq, hasMore: false }`. Al
    desplegar la fila del subagente debe verse «src/x.ts». Afirmar también que un `tool_result` de 2.000 caracteres
    se ve completo en «Resultado».
- **Comando** (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/adapters/claude-sdk/translate.test.ts tests/core/chat/f5-chat.test.ts tests/ui/chat/chat-view.test.tsx"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/adapters/claude-sdk/translate.test.ts tests/core/chat/f5-chat.test.ts tests/ui/chat/chat-view.test.tsx`).
- **Verificación manual:** en un chat de proyecto, pedir «dime el cupo de cada agente» y abrir los pasos. El
  «Resultado» de `cupos` debe mostrar el JSON entero, y cada cifra de la respuesta debe estar ahí. Luego pedir «usa un
  subagente para revisar src/core/chat y dime cuántos archivos tiene». La fila del subagente, al desplegarla, debe
  mostrar sus `Glob`/`Read`.
