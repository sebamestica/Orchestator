# Al cancelar una llamada que ya llegó al servidor, la puerta de Chrome no suelta el candado

- **Área:** Plugins y navegador
- **Severidad:** alta
- **Archivos:** `src/core/plugins/chrome-gate.ts:146`, `src/core/plugins/chrome-gate.ts:148`, `src/core/plugins/chrome-gate.ts:155`, `src/core/plugins/chrome-gate.ts:164`, `src/core/plugins/chrome-gate.ts:193`, `src/core/plugins/chrome-gate.ts:252`, `src/core/plugins/chrome-gate.ts:254`, `src/core/plugins/chrome.ts:40`, `src/core/chat/service.ts:501`, `src/core/chat/service.ts:885`, `C:\dev\agent-hub\tools\browser\node_modules\chrome-devtools-mcp\build\src\third_party\index.js:36704`, `…\third_party\index.js:36886`, `…\third_party\index.js:36902`
- **Estado:** abierta

## Cómo ocurre

Contexto. Todos los agentes de Berland (la mente, sus subagentes y la flota Claude/Codex) usan el servidor
`chrome-personal` a través de la puerta `src/core/plugins/chrome-gate.ts`, que arma `chromeServerSpec`
(`src/core/plugins/chrome.ts:101`). En la primera `tools/call` la puerta toma el candado
`C:\dev\agent-hub\locks\chrome-personal` y lo suelta tras `--idle-ms` (3 min, `chrome.ts:40`) **sin llamadas en
curso**. Lleva la cuenta de esas llamadas en `#inFlight`, y una entrada solo sale de ahí cuando llega la respuesta del
servidor:

```ts
// chrome-gate.ts:193-194
this.#inFlight.add(key);
this.#deps.toServer(line);

// chrome-gate.ts:164
if (msg && msg.method === undefined && msg.id !== undefined && msg.id !== null && this.#inFlight.delete(idKey(msg.id))) this.#armIdle();

// chrome-gate.ts:252 y 254
if (this.#closed || !this.#held || this.#inFlight.size > 0 || this.#waiting.size > 0) return;
...
if (this.#inFlight.size === 0 && this.#waiting.size === 0) void this.#release('inactividad');
```

La puerta solo atiende `notifications/cancelled` cuando la llamada **todavía espera el candado** (`#waiting`). Si la
llamada ya pasó al servidor, la notificación se reenvía tal cual y `#inFlight` no se toca:

```ts
// chrome-gate.ts:148-157
if (msg?.method === 'notifications/cancelled' && msg.params?.requestId !== undefined) {
  const waiting = this.#waiting.get(idKey(msg.params.requestId));
  if (waiting) { waiting.cancelled = true; return; }
}
if (msg?.method !== 'tools/call' || msg.id === undefined || msg.id === null) {
  this.#deps.toServer(line);
  return;
}
```

El servidor real (`chrome-devtools-mcp` 1.11.0 del hub, lanzado por `chrome-personal.cmd`) usa el SDK de MCP. Ese SDK
aborta la petición cancelada y **no responde nunca**, ni con resultado ni con error:

```js
// third_party/index.js:36670-36671: registra el manejador de la cancelación
this.setNotificationHandler("notifications/cancelled", (notification) => { this._oncancel(notification); ...
// third_party/index.js:36704-36707
async _oncancel(notification) {
  if (notification.params.requestId === void 0) return;
  this._requestHandlerAbortControllers.get(notification.params.requestId)?.abort(notification.params.reason);
}
// third_party/index.js:36886 (resultado) y 36902 (error)
if (abortController.signal.aborted) return;
```

Pasos:

1. Chrome está conectado. La mente (o un agente Claude o Codex) llama a una herramienta de `chrome-personal` que tarda
   unos segundos o más: `navigate_page` a una página lenta, `wait_for`, `take_snapshot` de una página grande, una traza
   o Lighthouse. La puerta toma el candado, mete el id en `#inFlight` (`chrome-gate.ts:193`) y pasa la llamada.
2. El usuario pulsa Interrumpir en el chat. `ChatService.interrupt` llama a `turn.session.interrupt()`
   (`src/core/chat/service.ts:501`), que a su vez llama a `this.#stream?.interrupt?.()`
   (`src/core/conductor/session.ts:483-485`). El turno se corta pero el proceso del SDK y sus servidores MCP siguen
   vivos. El cliente MCP aborta la llamada y manda `notifications/cancelled` con ese `requestId`. El binario de Claude
   Code trae el código del SDK que lo envía (`method:"notifications/cancelled",params:{requestId…`), y la propia puerta
   ya cuenta con recibir estas notificaciones (`chrome-gate.ts:17`, prueba `tests/core/plugins/chrome-gate.test.ts:180`).
3. Como el id no está en `#waiting`, la notificación se reenvía al servidor (`chrome-gate.ts:156`). El servidor aborta
   y se calla (`index.js:36886` / `36902`).
4. El id se queda en `#inFlight` para siempre. Cualquier llamada posterior de la misma sesión entra y sale de
   `#inFlight`, pero `#armIdle` sigue viendo `size > 0` por el id huérfano (`chrome-gate.ts:252`) y nunca arma el
   temporizador. El candado no tiene caducidad: `isAbandonedChromeHolder` (`chrome.ts`) solo lo libera si el pid del
   dueño ya no existe, y la puerta sigue viva.
5. El candado se suelta recién cuando termina el proceso de la puerta. En la mente eso pasa cuando la sesión se cierra
   por inactividad: 15 min sin uso (`service.ts:70`, `#scheduleIdle` en `service.ts:885-895`). Mientras el usuario
   siga chateando o haya subagentes trabajando (`service.ts:892`), eso no pasa nunca. Cada agente de la flota que pida
   Chrome espera 5 min (`DEFAULT_GATE_WAIT_MS`, `chrome.ts:39`) y recibe «El Chrome personal lo está usando … y no se
   liberó tras esperar 5 min» (`busyText`, `chrome-gate.ts:85-89`). Si el agente afectado es de la flota, el candado
   queda tomado hasta que termine su tarea.

## Por qué pasa

La puerta solo da por terminada una llamada en curso cuando recibe la respuesta del servidor (`chrome-gate.ts:164`).
Según MCP, el servidor no tiene que responder a una petición cancelada, y el SDK que usa `chrome-devtools-mcp` de
hecho no responde. La puerta no trata `notifications/cancelled` para los ids que ya pasó (`chrome-gate.ts:148-157`),
y `#inFlight` no tiene ningún tope de antigüedad.

## Solución posible

En `src/core/plugins/chrome-gate.ts`, dentro de `onClientLine`, después de mirar `#waiting`: si el `requestId` de
`notifications/cancelled` está en `#inFlight`, borrarlo, reenviar la notificación al servidor y llamar a
`this.#armIdle()`:

```ts
if (msg?.method === 'notifications/cancelled' && msg.params?.requestId !== undefined) {
  const key = idKey(msg.params.requestId);
  const waiting = this.#waiting.get(key);
  if (waiting) { waiting.cancelled = true; return; }
  if (this.#inFlight.delete(key)) {
    this.#deps.toServer(line);
    this.#armIdle();
    return;
  }
}
```

Si el servidor responde igual (la especificación lo permite), `onServerLine` no encuentra el id, no rearma nada y la
respuesta llega al cliente, que la ignora. Conviene actualizar el comentario de cabecera (`chrome-gate.ts:17`) para
que cubra también este caso.

### Otras opciones

- Guardar la hora de cada entrada (`Map<string, number>` en vez de `Set`) y descartar las que pasen de un tope
  (`toolTimeoutSec` del spec, hoy espera + 120 s, más un margen) antes de decidir el ocio. Esto cubre también las
  llamadas que se pierden sin cancelación explícita, por ejemplo un servidor que se cuelga o un cliente que corta por
  tiempo sin avisar. Lo mejor es combinarlo con la propuesta: la cancelación suelta el candado al momento y el tope
  sirve de red de seguridad.
- Contar el ocio desde la última actividad del cliente en vez de exigir `#inFlight` vacío. Es más simple, pero puede
  soltar el candado en medio de una llamada legítimamente larga (Lighthouse, trazas).

La propuesta no es la única salida. La más robusta probablemente sea la combinación de la cancelación explícita con un
tope de antigüedad.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta, en `tests/core/plugins/chrome-gate.test.ts`, junto a «una llamada cancelada mientras
  espera…» (línea 180). Usa el helper `gate(root, { idleMs: 30 })` con un `LockManager` real sobre `tempDir`:
  1. `t.call(7)` y `await until(() => t.toServer.length === 1)`. La llamada pasó al servidor y la puerta tiene el
     candado.
  2. `t.g.onClientLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }))`,
     sin llamar nunca a `t.reply(7)`.
  3. `await until(() => !t.g.holding)` y `expect(await exists(join(root, CHROME_LOCK))).toBe(false)`. Afirmar también
     que `t.forwarded()` contiene la `notifications/cancelled` (el servidor tiene que enterarse para abortar).
  4. Opcional: después, `t.call(8)` + `t.reply(8)` y comprobar que el candado se vuelve a soltar tras `idleMs`, o sea,
     que no quedó ningún id huérfano.
  Con el código actual el paso 3 se agota por tiempo, porque `holding` se queda en `true`.
- Comando (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/plugins/chrome-gate.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/plugins/chrome-gate.test.ts`).
- Verificación manual: con Chrome conectado, pedirle a la mente algo lento en `chrome-personal` (por ejemplo un
  `wait_for` de un texto que no aparece, o un `lighthouse_audit`) y pulsar Interrumpir mientras corre. Seguir
  chateando y, pasados más de 3 min, comprobar que `C:\dev\agent-hub\locks\chrome-personal` ya no existe y que la
  tarjeta de Plugins no muestra «En uso ahora por …». Hoy el candado sigue a nombre de la mente.
