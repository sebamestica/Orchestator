# La mente sigue usando tu Chrome personal (y Canva) después de «Desconectar», mientras su sesión siga viva

- **Área:** Plugins y navegador
- **Severidad:** alta
- **Archivos:** `src/core/app/f5-chat.ts:71`, `src/core/app/f5-chat.ts:74`, `src/core/app/f5-chat.ts:101`, `src/core/app/f5-chat.ts:118`, `src/core/chat/service.ts:665`, `src/core/chat/service.ts:673`, `src/core/chat/service.ts:676`, `src/core/chat/service.ts:681`, `src/core/chat/service.ts:699`, `src/core/chat/service.ts:706`, `src/core/conductor/session.ts:295`, `src/core/plugins/service.ts:239`, `src/core/plugins/service.ts:342`, `src/core/plugins/service.ts:488`, `src/core/plugins/chrome-gate.ts:177`
- **Estado:** resuelta

## Cómo ocurre

Contexto: cada chat con la mente tiene una `ConductorSession` viva (un proceso del Agent SDK). Se crea con el primer
mensaje y se cierra tras 15 min sin uso. En cada mensaje, `#ensureSession` compara una «clave de forma» y, si sale
igual, reutiliza la sesión. Los servidores MCP de los plugins (`chrome-personal`, a través de la puerta
`chrome-gate.ts`, y `canva`, con el Bearer) y sus `allowedTools` (`mcp__<servidor>__*`) se fijan al crear la sesión.

Pasos:

1. Chrome está conectado en Plugins. Abres un chat y mandas un mensaje. Se crea la sesión. `mind.env` refresca la
   caché de plugins de la mente, y la sesión arranca con `chrome-personal` y `mcp__chrome-personal__*` permitido.
2. En Plugins pulsas «Desconectar» en Chrome. La tarjeta dice «Desconectado: los agentes no reciben navegador (ni otro
   Chrome).». Lo único que hace es guardar el estado y publicar `{type:'plugin'}`:
   `src/core/plugins/service.ts:241-242`
   ```ts
   if (id === 'chrome') {
     return this.#save({ ...s, status: 'disconnected', detail: 'Desconectado: los agentes no reciben navegador (ni otro Chrome).', steps: chromeSteps() });
   ```
   Nadie escucha ese evento en el núcleo (`grep "'plugin'" src/core` solo encuentra la publicación en
   `plugins/service.ts:492` y el tipo en `server/hub.ts:25`).
3. Mandas otro mensaje en el mismo chat. `#ensureSession` arma la clave con `mcpServersFor`, que en producción lee la
   caché de `mindPlugins` sin refrescarla:
   `src/core/app/f5-chat.ts:74` y `:118`
   ```ts
   servers: (agentId: string) => cache.get(agentId)?.mcpServers ?? {},
   ...
   mcpServersFor: wiring.mcpServersFor ?? ((agentId) => plugins?.servers(agentId) ?? {}),
   ```
   `src/core/chat/service.ts:673-684`
   ```ts
   plugins: Object.keys(plugins).sort(),
   ...
   const key = keyOf(this.#deps.mcpServersFor?.(mind.id) ?? {});
   ...
   const sameShape = live.key === key;
   ...
   if (sameShape && applied) return alive;
   ```
   La caché solo se refresca dentro de `mind.env` (`f5-chat.ts:101`), y `#ensureSession` llama a `mind.env` en
   `service.ts:699`, es decir, después de haber decidido recrear la sesión. La clave sale igual (sigue diciendo
   `chrome-personal`) y se reutiliza la sesión vieja.
4. Esa sesión sigue teniendo `chrome-personal` en `mcpServers` y `mcp__chrome-personal__*` en `allowedTools`, que se
   calculó una sola vez (`src/core/conductor/session.ts:288-300`). La guardia `PreToolUse` usa esa lista fija. La
   puerta tampoco revisa el estado del plugin en cada `tools/call`: solo toma el candado y reenvía
   (`src/core/plugins/chrome-gate.ts:177-195`). Resultado: la mente sigue manejando tu Chrome personal, con tus
   sesiones abiertas, después de que lo desconectaste.

El plazo de 15 min corre desde el último uso: `send` cancela el temporizador antes de cada turno
(`service.ts:454-455`) y lo vuelve a armar al terminar (`#scheduleIdle`, `service.ts:885-895`). Si sigues
conversando, la ventana no se cierra nunca. Con subagentes en segundo plano la sesión tampoco se recrea aunque la
clave cambie (`service.ts:681-689`).

El caso contrario también pasa: si conectas Chrome o Canva con un chat abierto, la caché sigue vacía, la clave no
cambia y la mente no recibe el plugin hasta que la sesión se cierre por inactividad o cambie otro ajuste de la forma
(modo, modelo, carpetas).

Canva: el Bearer se lee al armar la sesión (`src/core/plugins/service.ts:340-342`) y `claudeMcpOptions` lo pasa como
variable de entorno del proceso del SDK (`src/core/adapters/claude-sdk/adapter.ts:177`). La clave solo compara nombres
de servidores, no el token. Cuando `CanvaConnector` renueva el token en segundo plano (`canva.ts:280-282`), la sesión
vieja se queda con el anterior y, al vencer, Canva falla para la mente sin que la sesión se recree. Al desconectar
Canva sin que el servidor confirme la revocación (`service.ts:248`, «el servidor no confirmó la revocación»), la
sesión viva puede seguir usando un token que todavía es válido.

Las pruebas actuales no cubren esto. `tests/core/chat/service.test.ts:558-577` solo revisa el primer turno. En
`tests/core/chat/f5-chat.test.ts:63`, `mcpServersFor` se inyecta por `wiring` y eso se salta la caché de `mindPlugins`.

## Por qué pasa

- `mcpServersFor` de la mente es síncrono (`ChatServiceDeps`, `service.ts:114`). Para cumplirlo, `mindPlugins`
  devuelve la última lectura de la caché (`f5-chat.ts:71-86`), y esa caché solo se refresca al crear una sesión. La
  clave de forma se calcula con datos que únicamente cambian cuando la sesión ya se va a recrear, así que un cambio de
  plugin nunca hace que se recree.
- La clave solo guarda `Object.keys(plugins)` (`service.ts:673`), no la configuración (`command`, `args`, `url`) ni una
  versión del token.
- Ningún cambio de plugin invalida las sesiones vivas: `PluginService.#save` publica `{type:'plugin'}` al hub
  (`service.ts:488-497`), pero `ChatService` no lo escucha.
- Ni la puerta de Chrome ni la guardia de la mente vuelven a mirar el estado del plugin en cada llamada.

## Solución posible

1. `src/core/chat/service.ts` y `src/core/app/f5-chat.ts`: refrescar los plugins antes de calcular la clave. Por
   ejemplo, agregar a `ChatServiceDeps.mind` un `refreshPlugins?(agentId): Promise<void>` (en f5-chat,
   `plugins.refresh`) y llamarlo al inicio de `#ensureSession`, antes de `keyOf`. Otra forma es que `mcpServersFor`
   sea async. `PluginService.#collect` solo lee SQLite y la bóveda, así que es barato.
2. Poner en la clave una huella por servidor en vez del nombre solo: un hash de `type`, `command`, `args` y `url` y de
   los valores de `env` y `headers` (`claudeMcpOptions` devuelve los valores reales en `env`). Se guarda solo el
   hash, nunca el token. Así una renovación del token de Canva también recrea la sesión, que se reanuda con `resume`
   y no pierde contexto.
3. Al desconectar: que `chatRouteModule` se suscriba a los mensajes `{type:'plugin'}` del hub (o reciba un callback
   desde `PluginService`). Cuando un plugin pase a `disconnected` o `error`, `ChatService` cierra las sesiones que
   están libres (sin turno ni subagentes) y marca las demás para recrearlas al terminar. Hoy, con subagentes vivos,
   se mantiene la sesión vieja (regla del issue 7) y eso deja Chrome abierto.

### Otras opciones

- **Revocar en la propia puerta:** antes de cada `tools/call`, `chrome-gate.ts` revisa una marca de «Chrome
  desconectado». Puede ser un archivo junto al candado en `locksRoot` que escribe `PluginService.disconnect` y borra
  `connect`. Si la marca existe, la puerta responde con error sin pasar la llamada. Así también corta a las
  ejecuciones de la flota que ya están en curso, que tienen el mismo problema porque `grant` entrega
  `chrome-personal` al empezar la ejecución. Probablemente sea la opción más sólida para Chrome, porque no depende de
  recrear sesiones.
- **Guardia en caliente:** la guardia `PreToolUse` de la mente niega `mcp__<plugin>__*` según el estado actual del
  plugin, que se lee en cada llamada, igual que ya se hace con el modo (`mode: () => this.#modeOf(chatId)`). Corta de
  inmediato y no mata a los subagentes, pero el proceso MCP sigue vivo hasta que la sesión se recree.
- Para Canva, otra salida es que el MCP HTTP pase por un proxy local del núcleo que pone el token vigente en cada
  petición. Así ninguna sesión guarda el token.

Estas opciones no se excluyen: lo mejor es combinar la guardia o la puerta (corte inmediato) con la clave por huella
(que la forma se actualice sola). La propuesta de arriba es una forma de hacerlo, no la única.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta: en `tests/core/chat/f5-chat.test.ts`, un caso nuevo que use `chatRouteModule(comp,
  { query, settings, drives, onReady })` sin `mcpServersFor` en `wiring`, para pasar por la caché real de
  `mindPlugins`.
  1. Marcar Chrome como conectado escribiendo el estado en la base (`new PluginStateStore(comp.store.database).put({
     id: 'chrome', status: 'connected', agents: [], steps: [], profile: 'personal', updatedAt })`). El lanzador por
     defecto no se ejecuta, solo se arma su comando.
  2. Crear un chat y mandar un mensaje. Afirmar que `q.calls[0].options.mcpServers` tiene `chrome-personal` y que
     `allowedTools` contiene `mcp__chrome-personal__*`.
  3. `await comp.plugins.disconnect('chrome')`, mandar otro mensaje y esperar a que termine.
  4. Afirmar que `q.calls` tiene 2 entradas, que `q.calls[1].options.mcpServers` no tiene `chrome-personal`, que
     `allowedTools` no tiene `mcp__chrome-personal__*` y que `q.calls[1].options.resume` es el `session_id` del
     primer turno. Si se elige la guardia en caliente, afirmar en su lugar que la guardia de la sesión viva niega
     `mcp__chrome-personal__list_pages`.
  5. Caso inverso: empezar con Chrome desconectado, conectarlo después del primer turno y afirmar que el segundo turno
     sí recibe `chrome-personal`.
  6. Si se implementa la huella: con una `mcpServersFor` inyectada que devuelve el mismo servidor `canva` con otro
     valor en `headers.Authorization`, afirmar que la sesión se recrea y que la clave guardada no contiene el token.
  Hoy el paso 4 falla porque `q.calls` tiene una sola entrada.
- Comando para correrla (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/chat/f5-chat.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/chat/f5-chat.test.ts`).
- Verificación manual en la app: con Chrome conectado, abre un chat y pídele a la mente «lista mis pestañas». Pulsa
  Desconectar en Plugins › Chrome y, en el mismo chat, vuelve a pedir «lista mis pestañas». Tiene que responder que
  no tiene navegador (o que la herramienta está denegada), no listar tus pestañas. Al revés: con un chat abierto,
  conecta Chrome y comprueba que el siguiente mensaje ya puede usarlo.
