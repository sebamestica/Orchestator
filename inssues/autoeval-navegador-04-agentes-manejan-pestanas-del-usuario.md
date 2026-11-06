# Cualquier agente puede leer, navegar o cerrar las pestañas que tú tienes abiertas en tu Chrome (correo, banco), no solo las suyas: «trabaja solo en tu pestaña» no lo hace cumplir nadie

- **Área:** Plugins y navegador
- **Severidad:** media
- **Archivos:** `src/core/plugins/chrome.ts:60`, `src/core/plugins/chrome.ts:85`, `src/core/plugins/chrome.ts:107`, `src/core/plugins/mcp.ts:97`, `src/core/plugins/chrome-gate.ts:9`, `src/core/plugins/chrome-gate.ts:55`, `src/core/plugins/chrome-gate.ts:73`, `src/core/plugins/chrome-gate.ts:92`, `src/core/plugins/chrome-gate.ts:127`, `src/core/plugins/chrome-gate.ts:155`, `src/core/plugins/chrome-gate.ts:162`, `src/core/plugins/chrome-gate.ts:177`, `src/core/plugins/chrome-gate.ts:194`, `src/core/conductor/guard.ts:135`, `src/core/conductor/guard.ts:184`, `src/core/plugins/service.ts:54`, `src/core/adapters/agy-cli/index.ts:67`, `tests/core/plugins/chrome.test.ts:160`, `C:\dev\agent-hub\tools\browser\node_modules\chrome-devtools-mcp\build\src\config\mcp-options.js:22` (fuera del repo), `…\tools\ToolDefinition.js:16`, `…\tools\pages.js:30`, `…\tools\pages.js:60`, `…\tools\script.js:72`, `…\tools\script.js:164`, `…\McpContext.js:23`, `…\McpContext.js:208`, `…\McpResponse.js:568`, `…\McpResponse.js:698`, `…\McpResponse.js:1226`
- **Estado:** abierta
- **Origen:** autoevaluación de la mente (2026-11-05)
- **Relacionadas:** `plugins-03` (la regla de pestañas no llega a la mente; este issue es la barrera técnica, que hace falta también para la flota, que sí la recibe), `autoeval-navegador-03` (acciones en tu propia pestaña con tus sesiones), `autoeval-navegador-01` (inyección), `mente-01` (otra regla sobre los argumentos de Chrome; menciona filtrar en la puerta como opción), `plugins-01`, `codex-06` y `plugins-07` (la puerta y su candado)

## Cómo ocurre

**Contexto.** Desde el issue 11, todos los agentes usan el Chrome personal del usuario, el mismo donde él tiene abiertos
su correo, su banco y su trabajo. La única regla sobre pestañas es texto:

```ts
// src/core/plugins/chrome.ts:60-61
export const CHROME_TAB_NOTE =
  'Abre tu propia pestaña con `new_page`, trabaja solo en ella y ciérrala con `close_page` al terminar. No cierres, recargues ni navegues pestañas que no abriste: pueden ser del usuario o de otro agente.';
```

La flota la recibe en el encargo: va en las `instructions` del servidor (`chrome.ts:107`) y `pluginsSection` la pasa a
texto (`mcp.ts:97`). La mente no la recibe (`plugins-03`). Pero en ningún caso hay algo que la haga cumplir:

- La puerta reenvía todo menos el candado: «Todo pasa tal cual en las dos direcciones (JSON-RPC delimitado por saltos de
  línea), salvo `tools/call`» (`chrome-gate.ts:9`). Y con `tools/call` solo espera el candado y la reenvía
  (`chrome-gate.ts:155-159` y `:177-194`). Ni siquiera lee el nombre ni los argumentos: `RpcLike.params` solo declara
  `requestId` (`chrome-gate.ts:92-96`). Las respuestas del servidor también pasan sin tocar (`onServerLine`, `:162-166`).
- La guardia de la mente acepta por prefijo cualquier herramienta de `mcp__chrome-personal__*` (`guard.ts:135`) y, como
  no son Read, Grep, Glob ni subagentes, termina en `return { allow: true }` (`guard.ts:184`).
- `chrome-devtools-mcp` 1.11.0 exige `pageId` en las herramientas de página porque `pageIdRouting` vale `true` por
  defecto (`config/mcp-options.js:22-27`) y `chrome-personal.cmd` no lo apaga (`ToolDefinition.js:16` y `:24-26`;
  `evaluate_script` lo declara aparte, `script.js:72-81`). Pero acepta el `pageId` de cualquier pestaña del navegador.
  `list_pages` las lista todas: cada línea es `${mcpPage.id}: ${título} (${url})`, o solo la dirección si no hay título
  (`McpResponse.js:1221-1228`), y la seleccionada termina en ` [selected]` (`:698`). `select_page` y `close_page` toman
  cualquier `pageId` (`pages.js:30-58` y `:60-88`).

**Pasos.**

1. El usuario tiene abiertas su bandeja de correo (pestaña 1) y un formulario a medio llenar (pestaña 2). Chrome está
   conectado en Berland.
2. En un chat, la mente (o un worker de la flota, Claude o Codex) llama `list_pages`. Recibe
   `1: Recibidos (https://mail…)` y `2: Solicitud (https://…/formulario)`.
3. Con `take_snapshot { pageId: 1 }` lee los correos abiertos. Esa es justo la fuente típica de una inyección
   (`autoeval-navegador-01`), y además son datos personales que la tarea no pidió.
4. Con `navigate_page { pageId: 2, url: … }` o `close_page { pageId: 2 }`, el usuario pierde lo que había escrito. Nada
   lo frena: la puerta no sabe qué pestañas abrió cada agente.

## Por qué pasa

La puerta se diseñó para una sola cosa: que un agente a la vez use Chrome (el candado). Compartir el Chrome personal
implica también separar las pestañas de cada uno, pero esa parte quedó como instrucción en el encargo
(`docs/plan/issues/11-chrome-personal.md` no la trata como regla técnica). La puerta está en el lugar justo para
hacerla cumplir (ve cada llamada y cada respuesta, para la mente y para la flota) y no lo hace.

## Solución posible

En `src/core/plugins/chrome-gate.ts`, que la puerta recuerde qué pestañas abrió su agente y rechace las demás:

1. **Leer la llamada.** Ampliar `RpcLike.params` (`chrome-gate.ts:92-96`) con `name` y `arguments`. Cambiar `#inFlight`
   (`:127`) de `Set` a `Map<clave, nombre de la herramienta>` para saber a qué herramienta responde cada mensaje del
   servidor.
2. **Recordar las propias.** En `onServerLine` (`:162`), si la respuesta es de `new_page` y no es error, buscar en el
   texto de `## Pages` la línea que termina en ` [selected]` (o en ` [selected] isolatedContext=…`, `McpResponse.js:698`)
   y agregar su id a `#ownPages`. Es la nueva porque `newPage` la selecciona antes de armar la lista
   (`McpContext.js:208`). Algo como `/^(\d+): .* \[selected\](?: isolatedContext=\S+)?$/m`. Si la respuesta de
   `close_page` no es error, quitar ese id.
3. **Rechazar las ajenas.** En `#call`, antes de reenviar (`:194`): si `arguments.pageId` es un número y no está en
   `#ownPages`, responder la llamada con `isError: true` sin pasarla al servidor (como hace hoy con el candado ocupado,
   `:188-191`). Texto: «La pestaña N no la abriste tú en esta sesión: puede ser del usuario o de otro agente. Abre la tuya
   con `new_page`». Se mira el argumento, no el nombre de la herramienta: vale para `select_page`, `close_page`, todas
   las de página y `evaluate_script`, que no es `definePageTool` pero recibe `pageId` y, si llega `0`, cae en la pestaña
   seleccionada (`script.js:164-166`). Una llamada de página sin `pageId` se reenvía: el servidor ya la rechaza por
   esquema.
4. **No mostrar las ajenas.** En las respuestas que traen `## Pages` (`list_pages`, `select_page`, `close_page`,
   `new_page`, `navigate_page` y otras con `setIncludePages`), cambiar las líneas de las pestañas ajenas por
   `N: (pestaña que no abriste)`. Así el agente no ve las direcciones ni los títulos de las pestañas del usuario. Hoy el
   servidor no manda `structuredContent` (`experimentalStructuredContent` vale `false`, `config/mcp-options.js:53-56`);
   si algún día se enciende, filtrar también `structuredContent.pages` (`McpResponse.js:702`, con `id`, `url`, `title`).
5. **Opción de la puerta.** `parseGateArgs` solo acepta pares `--clave valor` (`chrome-gate.ts:55-59`) y una lista
   cerrada de claves (`:73`), así que una bandera suelta como `--own-pages-only` no entra. Agregar `--pages own|all`
   a esa lista, con `own` por defecto, para poder apagarla al depurar. Si `chromeGateArgs` (`chrome.ts:85-98`) la pasa
   explícita, hay que actualizar la lista exacta de argumentos que afirma `tests/core/plugins/chrome.test.ts:160-162`.

Límites:

- Si la sesión se recrea, la puerta arranca de nuevo y las pestañas viejas del agente pasan a ser ajenas (el agente
  abre otras).
- Si `chrome-devtools-mcp` se reconecta a Chrome, renumera las pestañas («Page ids have changed»,
  `McpResponse.js:568-571`). Las del agente quedan fuera de `#ownPages` y debe abrir otra. No hay riesgo al revés: el
  contador de ids es del módulo y no se reinicia (`McpContext.js:23` y `:419`), así que una pestaña del usuario nunca
  hereda un id propio. Al ver ese aviso, conviene vaciar `#ownPages`.
- Las ventanas que abre la propia pestaña del agente (`target=_blank`, `window.open`, un inicio de sesión OAuth) quedan
  como ajenas.
- agy no pasa por la puerta: Berland no le entrega plugins (`service.ts:54-57`) y agy usa el `chrome-personal` que el
  usuario registró a mano, sin candado ni este filtro (`agy-cli/index.ts:60-68`). Queda cubierto cuando agy reciba la
  puerta (F5.2, `agy acp`).
- Esto no impide que el agente abra en su pestaña un sitio donde el usuario tiene sesión. Eso lo trata
  `autoeval-navegador-03`.

### Otras opciones

- **Permitir solo leer las pestañas ajenas** (`take_snapshot`, `take_screenshot`) cuando el usuario lo pide («mira la
  pestaña que tengo abierta»). Sería más cómodo, pero mantiene abierta la lectura del correo como fuente de inyección.
  Si se quiere, mejor como permiso explícito por chat que como opción por defecto.
- **Hacerlo en la guardia de la mente** en vez de en la puerta. Es más fácil de probar, pero no cubre a la flota, y la
  guardia no ve las respuestas, así que no puede saber qué id le tocó a cada `new_page` sin un hook `PostToolUse`.
- **Abrir las pestañas de los agentes en un contexto aislado** (`new_page` con `isolatedContext`). Separa cookies y
  sesiones, y eso va contra la decisión del issue 11 (los agentes usan el Chrome personal con sus sesiones). Descartada.

La propuesta es abierta. Si se elige otra vía, basta con que pasen las pruebas.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta** en `tests/core/plugins/chrome-gate.test.ts`, nuevo
  `describe('puerta MCP del Chrome personal: solo tus pestañas')`, con el ayudante `gate()` del archivo (hoy `call`
  manda siempre `arguments: {}`, línea 35; extenderlo para que acepte argumentos, y `reply` para que acepte el texto):
  - `call(1, 'new_page', { url: 'https://a.test' })` y la respuesta del servidor
    `'## Pages\n1: Recibidos (https://mail.test/)\n2: A (https://a.test/) [selected]'`. Afirma que la respuesta que
    llega al cliente muestra `1: (pestaña que no abriste)` y conserva `2: A (https://a.test/) [selected]`.
  - `call(2, 'take_snapshot', { pageId: 2 })` se reenvía al servidor. `call(3, 'take_snapshot', { pageId: 1 })` no se
    reenvía (`forwarded()` no tiene el id 3) y la respuesta trae `isError: true` con «no la abriste».
  - `select_page`, `close_page` y `evaluate_script` con `pageId: 1` (y `evaluate_script` con `pageId: 0`) se rechazan
    igual. `close_page` con `pageId: 2` pasa y, tras su respuesta sin error, `take_snapshot { pageId: 2 }` se rechaza.
  - `list_pages` (sin `pageId`) pasa, y su respuesta llega con las ajenas ocultas.
  - Una respuesta con «Page ids have changed» vacía las propias: `take_snapshot { pageId: 2 }` se rechaza después.
  - Con `--pages all`, `take_snapshot { pageId: 1 }` se reenvía como hoy y `list_pages` llega sin cambios.
    `parseGateArgs` sin la opción devuelve `own`, y con `--pages otra` lanza error.
- Si `chromeGateArgs` pasa la opción: actualizar en `tests/core/plugins/chrome.test.ts` la lista de argumentos
  (líneas 160-162) para que incluya `--pages own`.
- **Comando** (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/plugins/chrome-gate.test.ts tests/core/plugins/chrome.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`:
  `npx vitest run tests/core/plugins/chrome-gate.test.ts tests/core/plugins/chrome.test.ts`).
- **Verificación manual en la app.** Abre tu correo en Chrome. Con Chrome conectado, pide en un chat «lista mis
  pestañas y dime qué dice la primera». La mente no debe poder leerla: verá «pestaña que no abriste» y la herramienta
  vendrá rechazada. Pide «abre example.com y dime su título»: debe funcionar en una pestaña nueva, y tu correo debe
  quedar igual. Repite con una tarea de la flota para Claude o Codex («abre example.com, dime su título y cierra la
  pestaña»): debe cerrar solo la suya.
