# Si la transcripción del SDK ya no existe, el chat no vuelve a responder: cada mensaje reanuda con el mismo id

- **Área:** Mente y chat
- **Severidad:** media
- **Archivos:** `src/core/chat/service.ts:657`, `src/core/chat/service.ts:731`, `src/core/chat/service.ts:780-787`, `src/core/chat/service.ts:798-809`, `src/core/chat/service.ts:860`, `src/core/chat/db.ts:128-130`, `src/core/conductor/session.ts:375`
- **Estado:** resuelta

## Cómo ocurre

Cada chat guarda en `chat_chats.sdk_session_id` el `session_id` del Agent SDK. La sesión viva se cierra cuando el
chat queda ocioso (`#scheduleIdle`, `service.ts:885-894`) o cuando se reinicia el núcleo. El mensaje siguiente la
vuelve a crear con `resume` (`service.ts:657` y `service.ts:731`):

```ts
const { chat, sdkSessionId } = this.#require(chatId);
...
...(sdkSessionId ? { resume: sdkSessionId } : {}),
```

`ConductorSession` pasa ese valor tal cual a las opciones del SDK (`session.ts:375`), y el SDK lo convierte en
`--resume <id>` para el CLI (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`, `if(w)W.push(Be("--resume",w))`).

La transcripción vive en `%USERPROFILE%\.claude\projects\<cwd codificado>\<id>.jsonl`. Berland no cambia
`CLAUDE_CONFIG_DIR` (`buildEnv`, `session.ts:521-532`, no lo toca), así que la carpeta es la misma que usa el Claude
Code interactivo del usuario. Por defecto, Claude Code borra las transcripciones que llevan más de
`cleanupPeriodDays` días sin escribirse: 30, según `sdk.d.ts:6905-6907`. El `settings.json` del usuario no cambia ese
valor, y la mente corre con `settingSources: []` (`session.ts:369`), o sea con los valores por defecto.

Pasos:

1. Un chat guarda `sdk_session_id = S` y nadie lo usa durante más de 30 días. En ese tiempo cualquier Claude Code del
   usuario (el interactivo, un worker de la flota o la propia mente) borra `S.jsonl`. Pasa lo mismo si el usuario
   limpia `.claude\projects` a mano.
2. El usuario escribe en ese chat. `send` llama a `#ensureSession`, que crea la sesión con `resume: S`
   (`service.ts:456` → `service.ts:731`).
3. En modo `--print`, el CLI no encuentra la conversación, escribe el error y sale con código 1. En el binario
   `claude-agent-sdk-win32-x64/claude.exe`, la rama `entrypoint:"print"` hace
   `Bo(\`${hC} ${D.sessionId}\`, s.outputFormat), Ns(1)`, con `hC = "No conversation found with session ID:"`. El
   SDK convierte esa salida en `Error("Claude Code process exited with code 1…")` (`getProcessExitError` en
   `sdk.mjs`).
4. `#read` captura el error, emite «La conversación con la mente se cortó: …» y cierra el turno sin resultado. El
   chat queda en `error` (`service.ts:798-809` y `service.ts:860`).
5. No llegó ningún mensaje del SDK, así que `sdkSessionId` sigue siendo `S`. Es el único sitio que lo escribe
   (`service.ts:780-787`):

   ```ts
   const sdkId = sdkSessionIdOf(update.message);
   if (sdkId && sdkId !== known) {
     known = sdkId;
     this.#repo.update(chatId, { sdkSessionId: sdkId });
   ```

6. El mensaje siguiente repite los pasos 2 a 5 con el mismo `S`. Cambiar de modo, de esfuerzo o de agente de la mente
   no ayuda, porque ningún camino pone `sdkSessionId: null`: en todo `src/` solo aparece la escritura de la línea 787.
   La única salida es abrir un chat nuevo. El historial de `chat_messages` se sigue viendo, pero la mente ya no puede
   continuar esa conversación.

Ninguna prueba cubre el caso. En `tests/core/chat/*.test.ts`, `resume` solo se usa en escenarios donde la
reanudación sale bien (`service.test.ts:219-236`, `background.test.ts:154`, `chat-mode.test.ts:82`). Los issues de
hoy (`docs/plan/issues/01` a `13`) tampoco tocan este flujo: el 10 menciona `resume` solo para recrear la sesión al
cambiar el esfuerzo.

## Por qué pasa

El servicio da por buena para siempre la `sdk_session_id` guardada. No comprueba que la transcripción siga existiendo
ni tiene un camino de recuperación cuando la reanudación falla antes del primer mensaje del SDK. La columna solo
cambia cuando llega un mensaje con `session_id`, y un `resume` fallido no produce ninguno.

## Solución posible

En `src/core/chat/service.ts`:

1. En `#read`, anotar si llegó algún mensaje del SDK (por ejemplo `let seen = false`, que pasa a `true` en el primer
   `update`) y si la sesión se abrió con `resume`. Para eso `#ensureSession` puede guardar en `live` el id con el que
   reanudó.
2. En el `catch` de `#read`: si la sesión usó `resume`, `seen` sigue en `false` y el error trae
   `No conversation found with session ID` (el texto del CLI llega en la cola de stderr del error del SDK y también
   por `onStderr`), entonces:
   - `this.#repo.update(chatId, { sdkSessionId: null })`;
   - emitir un aviso visible: «No se pudo reanudar la conversación anterior (el SDK ya no tiene su transcripción);
     sigo sin ese contexto».
3. Reintentar una sola vez el turno pendiente sin `resume`. Para eso `Turn` tiene que guardar el `text` y las
   `images` que se pasaron a `session.send` (`service.ts:474`). El reintento llama a `#ensureSession` (que ya no ve
   `sdkSessionId`) y reenvía. Si se prefiere no reintentar solo, basta con el paso 2: el mensaje siguiente del usuario
   ya funciona.
4. Opcional: al abrir la sesión nueva, anteponer al primer mensaje un resumen corto de los últimos N `chat_messages`
   del chat, para no perder del todo el contexto.

El aviso y el reintento solo deben correr con esa causa concreta. Un proceso que muere antes del `init` por otro
motivo (falta el ejecutable, una señal, la red) no debe borrar un id que sigue siendo válido.

### Otras opciones

- **Comprobar antes de reanudar:** `getSessionInfo(S, { dir: chat.cwd })` del SDK (`sdk.d.ts:888`) devuelve
  `undefined` si no está el archivo, y entonces se abre sin `resume`. Así se ahorra lanzar un proceso que falla.
  Ojo: también devuelve `undefined` si la sesión «no tiene un resumen extraíble», así que podría descartar sesiones
  válidas y cortas. Conviene probarlo con el SDK real o mirar directamente si existe el `.jsonl`. Esa ruta depende
  del formato interno de `.claude\projects`, que es más frágil.
- **Subir la retención:** pasar `cleanupPeriodDays` alto en la configuración de la mente solo protege de la limpieza
  que hacen los procesos de la mente. No cubre la del Claude Code interactivo ni la de los workers, ni el borrado
  manual. Mitiga, pero no arregla.
- **Guardar las transcripciones aparte:** dar a la mente su propio `CLAUDE_CONFIG_DIR`, o un `sessionStore` (alpha en
  `sdk.d.ts:1849-1858`), dentro de los datos de Berland. Así no las toca la limpieza del Claude Code del usuario.
  Pero el cambio es más grande: credenciales, ajustes y otras rutas dependen de esa carpeta. Además, la limpieza
  propia del proceso seguiría corriendo.

La propuesta no es la única ni tiene por qué ser la mejor. La recuperación en el `catch` cubre cualquier causa de
pérdida, y la comprobación previa evita el proceso fallido. Combinar las dos sería lo más robusto.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:** `tests/core/chat/resume-perdido.test.ts`, con `bench` y `chatQuery` de
  `tests/core/chat/helpers.ts`:
  1. `bench({ idleMs: 50, turn })`, donde `turn` es `echoTurn` salvo cuando `ctx.options.resume === 'sdk-1'`: ahí
     lanza `new Error('Claude Code process exited with code 1\nNo conversation found with session ID: sdk-1')`.
  2. Primer `send` sobre un chat de `demo`: termina bien y guarda `sdk-1`, igual que en `service.test.ts:219-236`.
  3. Esperar a que la sesión ociosa se cierre (`b.q.closed === 1`).
  4. Segundo `send`: afirmar que `b.q.calls[1].options.resume === 'sdk-1'`, que el hub publicó el aviso de «no se
     pudo reanudar», y que `sdk_session_id` quedó en `null` o con el id nuevo (`SELECT sdk_session_id FROM
     chat_chats WHERE id = ?` sobre `b.store.database`).
  5. Con reintento automático: afirmar que `b.q.calls[2].options.resume` es `undefined`, que el turno terminó con
     `result success`, que el chat quedó `idle` y que la respuesta «eco: …» está en los mensajes. Sin reintento: un
     tercer `send` llega sin `resume` y termina bien.
  6. Caso negativo: un error que no trae `No conversation found` (por ejemplo `spawn ENOENT`) deja `sdk-1` sin tocar.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/chat/resume-perdido.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/chat/resume-perdido.test.ts`).
- **Verificación manual en la app:** con Berland detenido, en un chat de prueba, mover a otra carpeta su archivo
  `%USERPROFILE%\.claude\projects\<cwd codificado>\<sdk_session_id>.jsonl`. Arrancar Berland y escribir en ese chat:
  debe salir el aviso y la mente debe responder, en el mismo turno o en el siguiente. Antes del arreglo, cada mensaje
  termina en «La conversación con la mente se cortó: Claude Code process exited with code 1».
