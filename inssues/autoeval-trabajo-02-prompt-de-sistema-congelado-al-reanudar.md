# Al cambiar de modo, sumar una carpeta extra o retomar el chat otro día, la mente sigue leyendo el contexto de la primera sesión: cree estar en el modo viejo, con la fecha y los cupos de entonces

- **Área:** Mente y chat
- **Severidad:** alta (el modo por defecto es `plan`, `src/shared/api.ts:72`, así que casi todo chat que pasa a bypass o
  chat cae en esto; en el uso real de 2026-11-04 y 2026-11-05 le pasó a 4 de los 6 chats, ver «Evidencia en uso real»).
  La guardia sigue el modo vigente, así que no abre permisos de más: lo que falla es lo que la mente cree, dice y planea.
- **Archivos:** `src/core/conductor/session.ts:148-153`, `src/core/conductor/session.ts:342-357`, `src/core/conductor/session.ts:375`, `src/core/conductor/prompt.ts:4-7`, `src/core/conductor/prompt.ts:54`, `src/core/conductor/prompt.ts:103-129`, `src/core/conductor/prompt.ts:176-181`, `src/core/chat/service.ts:6-9`, `src/core/chat/service.ts:665-676`, `src/core/chat/service.ts:693`, `src/core/chat/service.ts:708-735`, `src/shared/api.ts:72`, `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2404-2431`, `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2447-2458`, `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:4578-4580`, `tests/core/chat/service.test.ts:308-318`
- **Estado:** abierta
- **Origen:** autoevaluación de la mente (2026-11-05), afirmaciones 2 («da por hecho un estado que no existe») y 3 («contexto limitado»)
- **Relacionadas:** `codex-03` (quitar una carpeta extra no revoca la sesión viva), `plugins-03` y `autoeval-navegador-01` (proponen más texto en el prompt, que también quedaría congelado en los chats existentes), `ui-resto-05` (textos de los modos)

## Cómo ocurre

**Contexto.** Berland arma el prompt de sistema de la mente como un arreglo de tres bloques: prefijo fijo, marcador
dinámico y «Contexto de esta sesión» (`session.ts:342-357`, `prompt.ts:187-189`). El contexto lleva el modo y sus
reglas, la carpeta y las carpetas extra, el modo de trabajo (local o worktrees), la fecha y los cupos al iniciar
(`prompt.ts:103-129`). El diseño cuenta con que un cambio entre por la sesión siguiente:

```ts
// src/core/conductor/session.ts:149-151
 * Modo de la mente. Con una función, la guardia y las herramientas la leen en cada llamada; `allowedTools` y el
 * texto del prompt salen del valor al crear la sesión (un cambio rige desde la sesión siguiente).
```

`ChatService` recrea la sesión cuando cambia el modo, las carpetas o los plugins (`service.ts:665-676` y `:693`), o
cuando la sesión se cerró por 15 minutos de inactividad, y siempre la **reanuda** con el `session_id` del SDK
(`service.ts:731`: `...(sdkSessionId ? { resume: sdkSessionId } : {})`).

El SDK 0.3.302 graba el prompt de sistema la primera vez y en cada `resume` reutiliza lo grabado, no lo que se le pasa:

```ts
// node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2415-2425
 * - **Omitted or `snapshot: true` (the default):** … every later
 *   request and `resume` / `continue` sends the record as-is — a different
 *   `append` or `prompt` passed on a later launch of the same session is
 *   ignored until compaction or a new session.
 * …
 * A bare string / `string[]` prompt follows the default; use
 * `{ type: 'custom', prompt, snapshot: false }` to opt it out.
```

Berland pasa un `string[]` pelado (`session.ts:342`), así que queda en el comportamiento por defecto. En el CLI que trae
el SDK (`@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`, `VERSION:"2.1.302"`) la función
minificada que lo decide (`dYe`) graba siempre, salvo con `systemPromptSnapshot === false` o con la variable
`CLAUDE_CODE_SIMPLE`:
`function dYe(e){if(e.systemPromptSnapshot===!1)return!1;return e.systemPromptSnapshot===!0||…||!JOe()}` y
`function JOe(){return a.CLAUDE_CODE_SIMPLE}`. La función que arma el prompt de cada pedido (`Pm`) solo exige además que
la consulta no sea un `bareFork` ni `auxiliary`; no mira la cuenta. Es decir, la nota de `sdk.d.ts:2428-2431` («recording
is rolling out… where it is not yet enabled for the account… `snapshot` has no effect») no frena nada en este CLI. Al
reanudar, si hay un `prompt_snapshot` en la transcripción y no hay un `prompt_render_point` posterior, devuelve
`systemPrompt: C.systemPrompt` con `source: "from_snapshot"`. Se puede ver con
`grep -a -o "function dYe(e){.\{0,200\}" claude.exe` (o, más rápido, buscando `source:"from_snapshot"` con un script
que lea el binario por bytes).

El CLI tiene una salida, apagada por defecto: con la variable `CLAUDE_CODE_HOST_PROMPT_SUPERSEDES_RECORD`, en el primer
turno compara el prompt que pasa el anfitrión con el grabado (`rus`: ¿están todos sus bloques en el registro?) y, si
no coinciden, agrega un `prompt_render_point` («`set_model_system_prompt`») para que se vuelva a armar y grabar
(`let ad=a.CLAUDE_CODE_HOST_PROMPT_SUPERSEDES_RECORD` … `takeSystemPromptDelivered` … `prompt_snapshot_host_supersede`).
La variable no aparece en `sdk.d.ts`; solo en la tabla de variables de `sdk.mjs`. Berland no define ninguna de las tres
(`grep -rn "HOST_PROMPT_SUPERSEDES\|CLAUDE_CODE_SIMPLE\|systemPromptSnapshot\|snapshot: false" src` no encuentra
nada).

**Pasos** (el más común, porque el propio prompt lo sugiere):

1. El usuario abre una Conversación en el modo por defecto y escribe. La primera sesión graba un contexto con
   `STANDALONE_TEXT`: «No hay proyecto ni flota… Si quiere que hagas cambios o ejecutes algo tú mismo, sugiérele el
   modo chat (Shift+Tab)» (`prompt.ts:176-181`).
2. El usuario pulsa Shift+Tab y pasa a `chat`. En el mensaje siguiente cambia la clave de la sesión, `ChatService` la
   cierra y crea otra con `mode: chat`, `tools` con Edit/Write/Bash y `resume` (`service.ts:708-735`).
3. El CLI reanuda con el prompt grabado. La mente sigue leyendo el texto de la Conversación y no el de
   `## Modo: chat` (`prompt.ts:154-162`), y el prefijo le dice «Fuera de los modos bypass y chat no editas código».
   Puede volver a sugerir el modo chat, decir que no puede editar o desconocer las reglas del modo (adjuntos,
   concisión según el esfuerzo, no hacer commits).

Lo mismo pasa con:

- **plan → auto o bypass** en un chat de proyecto: la mente sigue creyendo que debe esperar la aprobación, o al revés.
  La guardia sí lee el modo vigente (`session.ts:314-324`), así que los permisos se cumplen. Lo que falla es lo que la
  mente dice y planea.
- **Carpetas extra nuevas:** la guardia ya deja leerlas, pero el contexto grabado no las nombra (`prompt.ts:111`).
- **Fecha y cupos:** un chat que se retoma días después sigue diciendo «Fecha: <día de la primera sesión>» y los cupos
  de ese momento (`prompt.ts:112-122`).

Todo vuelve a cuadrar recién cuando el SDK compacta la conversación. En ese momento el prompt salta de golpe al de la
última sesión.

**Evidencia en uso real.** Las transcripciones del SDK de los chats de Berland
(`%USERPROFILE%\.claude\projects\<carpeta>\<sdk_session_id>.jsonl`) guardan cada registro como una línea
`{"type":"attachment","attachment":{"type":"prompt_snapshot","systemPrompt":[…]}}`. Cruzándolas con
`chat_messages.mode` de `%LOCALAPPDATA%\orquestador\orquestador.db` (leída sobre una copia):

| Chat | Modo de los mensajes del usuario | `## Modo:` de cada `prompt_snapshot` |
|---|---|---|
| `2e211f13` (orquestador, sesión `247d5e92`) | plan; bypass desde 2026-11-04T17:27:05Z (9 mensajes) | plan en 15:05:52, 15:05:57 y 17:29:35 |
| `2013a413` (professional, `65d54be8`) | plan; bypass desde 2026-11-05T00:57:23Z (5 mensajes) | plan en 00:29:32, 00:31:46 y 00:57:38 |
| `00831801` (orquestador, `bfe8c550`) | plan; bypass desde 2026-11-05T00:38:13Z (6 mensajes, hasta el 06 a las 00:31Z) | plan en 00:36:59, 00:37:32 y 18:40:31 |
| `faf636ea` (radio-example, `033c9a73`) | plan; bypass desde 2026-11-05T01:36:04Z | plan en 00:48:41 y 00:48:53 |

Ningún registro de esos chats dice `## Modo: bypass`, aunque todos sus turnos posteriores se hicieron en bypass y
varios fueron procesos nuevos tras horas de ocio (por ejemplo, el de 18:40 del chat `00831801`). La propia mente lo
notó en `00831801` (01:11:42Z): «El servidor las aprobó solas porque está en modo bypass, aunque esta sesión empezó en
modo plan». La fecha también queda fija: el chat `ec3e1f2b` (marketing, `5e9a1faf`) se retomó el 2026-11-05 a las
00:11Z y 00:34Z y sus registros siguen diciendo «- Fecha: 2026-11-04». Para verlo en un chat (WSL):
`grep '"type":"prompt_snapshot"' <transcripción>.jsonl | grep -o '## Modo: [a-z]*\|- Fecha: [0-9-]*' | uniq -c`.

Las pruebas actuales no pueden verlo: usan una `query` falsa y solo miran las opciones que recibe. Por ejemplo,
`tests/core/chat/service.test.ts:308-318` afirma que la sesión reanudada recibe `## Modo: plan` con `resume: 'sdk-1'`.
Eso es cierto en las opciones, pero el CLI real no lo envía.

## Por qué pasa

Berland supone que el prompt de sistema se vuelve a leer en cada sesión del SDK. El SDK actual lo graba por
conversación y lo mantiene en las reanudaciones. Como Berland reanuda siempre la misma conversación, su único canal para
contarle a la mente qué cambió (el contexto dinámico) queda congelado en el primer valor.

## Solución posible

1. **`src/core/conductor/session.ts:342`:** pasar el prompt como
   `systemPrompt: { type: 'custom', prompt: [...buildConductorSystemPrompt(...), ...destino], snapshot: false }`.
   Dentro de una sesión el texto no cambia (se arma una vez en el constructor), así que el prefijo sigue igual y en
   caché. Solo cambia el bloque dinámico al recrear la sesión, que es justo cuando Berland quiere que cambie. El costo:
   al cambiar el contexto se pierde una vez la caché de la conversación y, con razonamiento extendido, los bloques de
   pensamiento anteriores (`sdk.d.ts:2407-2412`). Al recrear por inactividad la caché ya estaba fría.
2. **`src/core/conductor/prompt.ts:54` y el comentario de `session.ts:149-151`:** dejar escrito que el cambio rige
   porque el prompt no se graba (`snapshot: false`), para que nadie lo revierta por ahorrar caché.

### Otras opciones

- **Mantener la grabación y pedirle al CLI que la reemplace cuando el prompt cambie:** definir
  `CLAUDE_CODE_HOST_PROMPT_SUPERSEDES_RECORD=1` en el entorno de la sesión (en `buildEnv`, `session.ts:266-271`). Con
  eso el CLI 2.1.302 compara el prompt nuevo con el grabado y, si un bloque cambió, vuelve a armarlo y grabarlo. Dentro
  de una conversación sin cambios conserva la caché igual que hoy. Es la opción que menos toca, pero la variable no está
  documentada en `sdk.d.ts`: puede cambiar o desaparecer en otra versión del SDK, así que solo sirve acompañada de la
  prueba en vivo de abajo.
- **Mantener el prompt grabado y avisar el cambio en el mensaje.** Guardar por chat el último contexto enviado y, si el
  nuevo difiere, anteponer al mensaje siguiente una línea como `effortNote` (`prompt.ts:171`): «[Cambió el contexto de
  la sesión: modo chat; carpetas extra: …]». Conserva la caché, pero el aviso queda como texto del usuario, con menos
  autoridad que el prompt de sistema, y hay que mantener el diff.
- **Hook `SessionStart` con `source: 'resume'`** que devuelva `additionalContext` con `renderSessionContext` vigente
  (`sdk.d.ts:6656` y `:6678-6681`). Hay que comprobar antes que el SDK dispara ese evento en los hooks en proceso para
  una sesión reanudada.
- **No reanudar al cambiar de modo:** una sesión nueva sin `resume` tomaría el prompt nuevo, pero se pierde la
  conversación, que es lo que `resume` protege.

La propuesta no es la única y puede haber una mejor. Basta con que la prueba en vivo de abajo pase.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:**
  - `tests/core/conductor/session.test.ts`, caso nuevo «el prompt de sistema no se graba»: afirmar que
    `options.systemPrompt` es `{ type: 'custom', snapshot: false, prompt: [CONDUCTOR_PROMPT_PREFIX, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, expect.stringMatching(/## Modo: plan/)] }`.
    Hay que adaptar las afirmaciones que hoy hacen `o.systemPrompt as string[]` (`session.test.ts:87`, `:279-335`,
    `:437-438`, `:554` y `:567`, `tests/core/chat/service.test.ts:281-359`, `tests/core/chat/chat-mode.test.ts:49` y
    `:68`, `tests/core/conductor/destino.test.ts:150-167`, `tests/core/chat/target.test.ts:102` y `:197`) para que lean
    `.prompt`. Si se elige la variable de entorno en vez de `snapshot: false`, el caso afirma en cambio que
    `options.env.CLAUDE_CODE_HOST_PROMPT_SUPERSEDES_RECORD` es `'1'`.
  - `tests/live/chat.live.test.ts`, caso nuevo «al cambiar de modo, la mente reanudada conoce el modo nuevo»: chat de
    proyecto en `plan`, primer turno «Según tu contexto de sesión, ¿en qué modo estás? Responde solo con la palabra.»
    y esperar `/plan/i`. `service.patch(chat.id, { mode: 'chat' })`, misma pregunta y esperar `/chat/i`. Hoy debería
    fallar en el segundo turno (responde «plan»). Gasta saldo: esfuerzo bajo y el tope de 0,50 USD que ya usa el archivo.
- **Comando** (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/conductor/session.test.ts tests/core/chat"`
  y, para la prueba en vivo, `WSLENV=ANTHROPIC_API_KEY/w:ANTHROPIC_BASE_URL/w /mnt/c/dev/orquestador/scripts/win.sh "set ORQ_LIVE=1&& npx vitest run tests/live/chat.live.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/conductor/session.test.ts tests/core/chat` y
  `$env:ORQ_LIVE='1'; npx vitest run tests/live/chat.live.test.ts`).
- **Verificación manual:** abrir una Conversación, escribir «hola», pasar a modo chat con Shift+Tab y preguntar «¿en qué
  modo estás y puedes editar archivos?». Debe responder que está en modo chat y que sí puede editar. Repetir en un chat
  de proyecto pasando de plan a bypass (el caso que se vio en uso real), dejando pasar 15 minutos antes del mensaje
  siguiente para que se recree por ocio. Con la opción de la variable de entorno, además, la última línea
  `prompt_snapshot` de la transcripción (comando de «Evidencia en uso real») debe decir el modo nuevo.
