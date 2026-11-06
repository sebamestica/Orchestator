# «Probar conexión» le quita Chrome a las sesiones nuevas mientras prueba, y al terminar deshace un «Desconectar» hecho durante la prueba

- **Área:** Plugins y navegador
- **Severidad:** baja
- **Archivos:** `src/core/plugins/service.ts:239`, `src/core/plugins/service.ts:242`, `src/core/plugins/service.ts:322`, `src/core/plugins/service.ts:325`, `src/core/plugins/service.ts:335`, `src/core/plugins/service.ts:356`, `src/core/plugins/service.ts:368`, `src/core/plugins/service.ts:402`, `src/core/plugins/service.ts:413`, `src/core/plugins/routes.ts:92`, `src/core/adapters/claude-sdk/adapter.ts:296`, `src/core/adapters/codex-cli/index.ts:159`, `src/ui/features/plugins/PluginsView.tsx:22`, `src/ui/features/plugins/PluginsView.tsx:72`, `src/ui/features/plugins/PluginsView.tsx:84`, `src/ui/app/App.tsx:33`
- **Estado:** resuelta

## Cómo ocurre

Contexto: el plugin Chrome guarda un único `status` en SQLite (`plugins_state`). Ese campo cumple dos funciones. La
tarjeta de Plugins lo muestra («Conectando», «Conectado»…), y `#collect` lo consulta para decidir si una ejecución
recibe el servidor `chrome-personal`. Cada adaptador pide su `grant` **una sola vez, al arrancar la ejecución**
(`claude-sdk/adapter.ts:296`, `codex-cli/index.ts:159`), y lo que recibe le sirve hasta que termina.

«Probar conexión» llama a `POST /plugins/chrome/connect`, que va a `#connectChrome` → `#probeChrome`. Lo primero que hace
la prueba es guardar `connecting`, aunque Chrome ya estuviera `connected`:

```ts
// service.ts:368
this.#save({ ...prev, profile: 'personal', agents, status: 'connecting', detail: 'Comprobando tu Chrome personal…', steps: chromeSteps() });
```

Después arranca el MCP con 30 s de margen para el inicio y, si el candado está libre, hasta 60 s más para `list_pages`,
que es cuando Chrome puede pedir que aceptes la conexión (`service.ts:402-407`). El cierre tiene otros 3 s de gracia
(`mcp-probe.ts:195`). La ventana va de unos segundos hasta unos 93 s.

### Efecto 1: las sesiones que arrancan durante la prueba se quedan sin navegador

`wants` solo entrega con `connected`:

```ts
// service.ts:322
const wants = (id: PluginId, s: PluginState) => s.status === 'connected' && PLUGIN_AGENT_KINDS[id].includes(kind) && ...
```

Con `connecting`, la rama de `service.ts:333-336` añade `NO_BROWSER_NOTE` («Esta sesión no tiene navegador (el plugin
Chrome de Berland no está conectado para ti). No abras ninguno…», `chrome.ts:68`) y no añade `chrome-personal`.

Pasos:
1. Chrome está «Conectado» y la flota está trabajando.
2. El usuario pulsa «Probar conexión» para ver el estado.
3. Mientras dura la prueba, la mente lanza una tarea de Claude o de Codex. Esa ejecución no recibe `chrome-personal`,
   recibe la nota de que no tiene navegador y queda así hasta que termina, aunque la prueba acabe bien un segundo
   después.

### Efecto 2: un «Desconectar» pulsado durante la prueba se pierde

Mientras dura la prueba, la tarjeta muestra «Desconectar», porque `active` cuenta también `connecting`:

```tsx
// PluginsView.tsx:72 y :84
const active = plugin.status === 'connected' || plugin.status === 'connecting';
{active && <Button variant="secondary" isDisabled={!!busy.chrome} ...>Desconectar</Button>}
```

`busy` es estado local de la vista (`PluginsView.tsx:22`). Si el usuario se va a otra vista y vuelve, el `switch` de
`App.tsx:33-34` desmonta y vuelve a montar `PluginsView`, `busy` vuelve a `{}` y el botón queda habilitado. Lo mismo
pasa con otra ventana que tenga la interfaz abierta, o con una llamada directa a la API. Ni la ruta
(`routes.ts:92-100`) ni `disconnect` (`service.ts:239-242`) revisan si hay una prueba en curso (`#chromeProbe`), y
guardan `disconnected` de inmediato.

Cuando la prueba termina, guarda su resultado sobre el estado que haya en ese momento:

```ts
// service.ts:413
return this.#save({ ...this.#state('chrome'), status: outcome.status, detail: outcome.detail, steps: [...outcome.steps, ...extraSteps] });
```

Si la prueba salió bien, `outcome.status` es `connected` (`chrome.ts:133-136`). El `disconnected` que acababa de guardar
el usuario se pierde, y las sesiones nuevas vuelven a recibir su Chrome personal aunque él lo había desconectado. La
tarjeta pasa a «Conectado» por `/ws` y no queda rastro del «Desconectar».

Nota: que una prueba **fallida** deje `error` y sin Chrome es coherente, porque la prueba dice que Chrome no responde. El
problema está en la ventana de la prueba y en pisar un cambio que hizo el usuario.

## Por qué pasa

- El mismo `status` significa «se está comprobando» (para la tarjeta) y decide la entrega (para `wants`). Un Chrome
  que ya estaba `connected` deja de entregarse solo porque alguien lo está comprobando.
- El guardado final de `#probeChrome` (`service.ts:413`) no compara el estado actual con el que dejó la prueba al empezar.
  Escribe su resultado aunque, entretanto, otro haya cambiado el estado con `disconnect`.
- Relacionado: si el núcleo se reinicia a mitad de una prueba, el constructor convierte el `connecting` en
  `disconnected` (`service.ts:162-165`). Un Chrome que estaba conectado queda desconectado solo porque se estaba
  probando.

## Solución posible

En `src/core/plugins/service.ts`:

1. **No bajar `status` al reprobar un Chrome conectado.** En `#probeChrome`, si `prev.status === 'connected'`, guardar el
   mismo `status` y poner solo `detail: 'Comprobando tu Chrome personal…'`. Si no estaba conectado, se mantiene
   `connecting`, como hoy. Así `wants` sigue entregando durante la prueba. El test
   `chrome.test.ts:51` («publica connecting → connected») no cambia, porque parte de `disconnected`.
2. **Generación para no pisar cambios ajenos.** Añadir un contador `#chromeGen` que `disconnect('chrome')` incremente.
   `#probeChrome` guarda el valor al empezar y, en los dos `#save` finales (`service.ts:377` y `:413`), si el contador
   cambió, no escribe el resultado y devuelve `this.status('chrome')`. También vale comparar `updatedAt` con el que guardó
   la prueba en la línea 368, aunque el contador no depende del reloj.

En `src/ui/features/plugins/PluginsView.tsx`, deshabilitar «Desconectar» mientras `plugin.status === 'connecting'` para
Chrome. Es un complemento, no la defensa: la guardia tiene que estar en el núcleo, porque la API se puede llamar desde
otra ventana o desde fuera de la interfaz.

### Otras opciones

- Que `disconnect('chrome')` espere a `#chromeProbe` antes de guardar, o que responda 409 (`PluginError('conflict')`,
  que ya existe) mientras hay una prueba en curso. Es más simple, pero esperar hasta 93 s en un `POST` es mala
  experiencia, y el 409 obliga al usuario a volver a intentar.
- Separar el estado en dos campos, por ejemplo `status` (lo que se entrega) y `probing: boolean` (lo que ve la
  tarjeta). Es más limpio, pero cambia el contrato Zod `pluginSchema` en `src/shared` y la interfaz.
- Usar un `AbortController` para que `disconnect` corte la prueba en curso: libera antes el candado y el proceso del MCP,
  pero es más código en `probeStdioMcp`.

La propuesta (status estable + generación) es la que menos toca, pero no es la única. Si en algún momento se agregan
más fuentes de cambio de estado, separar `status` de `probing` puede salir más barato a largo plazo.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta en `tests/core/plugins/chrome.test.ts`, usando `pluginHarness` con `chrome.probe` falso:
  1. Una primera prueba con `probe` que resuelve `ok` deja Chrome `connected`.
  2. Cambiar `probe` por uno que devuelve una promesa controlada a mano (`let resolve; new Promise(r => resolve = r)`) y
     lanzar `const p = h.service.connect('chrome', {})` sin `await`.
  3. Mientras sigue pendiente: `await h.service.grant({ agentId: 'claude-main', kind: 'claude-sdk', taskId: 't-1' })`
     debe traer `chrome-personal` en `servers` y no traer `NO_BROWSER_NOTE`. Hoy falla: trae `{}` y la nota.
  4. Llamar `await h.service.disconnect('chrome')`, resolver la prueba con un resultado `ok` y `await p`.
  5. Afirmar `h.service.status('chrome').status === 'disconnected'` y que un `grant` nuevo trae `NO_BROWSER_NOTE`.
     Hoy falla: queda `connected`.
  - En `tests/ui/plugins/PluginsView.test.tsx`, si se aplica el cambio de interfaz: con un Chrome en `connecting`
    (mensaje `/ws` como el de la línea 95), el botón «Desconectar Chrome» está deshabilitado o no aparece.
- Comando (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/plugins/chrome.test.ts tests/ui/plugins/PluginsView.test.tsx"`
  (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/core/plugins/chrome.test.ts tests/ui/plugins/PluginsView.test.tsx`).
- Verificación manual: con Chrome «Conectado», pulsar «Probar conexión» y, sin aceptar el aviso de Chrome, ir a otra
  vista, volver a Plugins y pulsar «Desconectar». Al aceptar el aviso o cuando termine la prueba, la tarjeta tiene que
  seguir en «Desconectado». Hoy pasa a «Conectado».
