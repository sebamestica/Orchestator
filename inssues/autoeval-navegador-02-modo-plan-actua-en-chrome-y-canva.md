# En modo plan (y en auto) la mente hace clic, rellena formularios y ejecuta JavaScript en tu Chrome, y confirma cambios en Canva, sin tu aprobación

- **Área:** Mente y chat
- **Severidad:** alta
- **Archivos:** `src/shared/api.ts:17`, `src/core/conductor/prompt.ts:14`, `src/core/conductor/prompt.ts:134`, `src/core/conductor/prompt.ts:180`, `src/core/conductor/session.ts:65`, `src/core/conductor/session.ts:298`, `src/core/conductor/session.ts:314`, `src/core/conductor/session.ts:320`, `src/core/conductor/session.ts:363`, `src/core/conductor/guard.ts:117`, `src/core/conductor/guard.ts:135`, `src/core/conductor/guard.ts:165`, `src/core/conductor/guard.ts:184`, `src/core/chat/service.ts:665`, `src/core/chat/service.ts:680`, `src/core/chat/service.ts:706`, `src/core/chat/service.ts:715`, `src/core/chat/service.ts:732`, `src/core/plugins/service.ts:54`, `src/core/plugins/service.ts:322`, `src/core/plugins/service.ts:342`, `src/core/plugins/service.ts:366`, `src/core/app/f5-chat.ts:77`, `src/ui/features/plugins/PluginsView.tsx:55`, `tests/core/conductor/session.test.ts:261`, `tests/core/conductor/session.test.ts:323`, `C:\dev\agent-hub\tools\browser\node_modules\chrome-devtools-mcp\build\src\tools\input.js:135` (fuera del repo), `…\tools\script.js:64`, `…\tools\pages.js:132`, `…\tools\pages.js:154`, `…\config\mcp-options.js:124`, `…\utils\url.js:197`
- **Estado:** abierta
- **Origen:** autoevaluación de la mente (2026-11-05)
- **Relacionadas:** `mente-01` (lectura por `file://` y `upload_file` en todos los modos), `plugins-03` (la mente no recibe las reglas de Chrome y Canva), `autoeval-navegador-01` (inyección), `autoeval-navegador-03` (confirmación en chat y bypass; hacer juntas), `ui-resto-05` (textos de los modos)

## Cómo ocurre

**Contexto.** El contrato de los modos dice que en `plan` nada se ejecuta sin aprobación:

```ts
// src/shared/api.ts:17
 * - `plan`: la mente lee, investiga y propone tareas; nada se ejecuta sin que el usuario apruebe.
```

El prompt lo repite (`prompt.ts:134`), y el prefijo dice que fuera de bypass y chat la mente no ejecuta: delega
(`prompt.ts:14`). Una Conversación sin proyecto en modo plan, auto o bypass tampoco actúa: «Si quiere que hagas cambios
o ejecutes algo tú mismo, sugiérele el modo chat» (`prompt.ts:180`). El código lo cumple para archivos y comandos:
`modeActs` (`session.ts:65-67`) decide si hay edición y shell, y la guardia los niega en vivo fuera de esos modos
(`session.ts:320-322`).

Con los plugins no pasa lo mismo. Cada servidor entra en `allowedTools` con comodín, en cualquier modo:

```ts
// src/core/conductor/session.ts:298
...plugins.map(([name]) => `mcp__${name}__*`),
```

La guardia convierte el comodín en prefijo (`guard.ts:117-118`, `:135`). El `deny` dinámico (`session.ts:314-324`) no
mira los plugins, y `precheck` termina en `return { allow: true };` (`guard.ts:184`). Con `permissionMode: 'dontAsk'`
(`session.ts:363`) no hay ningún aviso al usuario. `ChatService` entrega los plugins sin mirar el modo
(`chat/service.ts:706` y `:732`), y lo mismo hacen la mente y sus subagentes `general-purpose`, que pasan por el mismo
hook.

**Pasos.**

1. Chrome y Canva están conectados en Plugins. La interfaz no deja elegir qué agentes los reciben: conecta con un
   cuerpo vacío (`PluginsView.tsx:55`, `api.post(…/connect, {})`), así que `agents` conserva lo anterior, que por
   defecto es la lista vacía (`plugins/service.ts:366` y `:480`). Con la lista vacía lo recibe cualquier agente
   (`plugins/service.ts:322`). Por la API tampoco se puede separar a la mente del worker Claude: los dos usan el mismo id
   de agente (`f5-chat.ts:77` pide los plugins con `mind.id`, y `resolveMind` elige un agente `claude-sdk` de la flota,
   `chat/service.ts:199-213`).
2. El usuario abre un chat en modo **plan** y pide: «revisa el formulario de contacto de https://ejemplo.test y dime qué
   campos tiene».
3. La mente (o una instrucción escondida en la página, ver `autoeval-navegador-01`) llama
   `mcp__chrome-personal__fill_form` y luego `mcp__chrome-personal__click` sobre «Enviar». La guardia aprueba las dos y el
   formulario se envía desde el Chrome personal, con las sesiones del usuario.
4. Con `mcp__chrome-personal__evaluate_script` puede correr cualquier función en la página
   (`async () => await fetch(…)` es el ejemplo de la propia herramienta, `script.js:86`). Con `navigate_page` y el
   parámetro `initScript` (`pages.js:154` y `:183-184`), también. Y sin `initScript`: `navigate_page` o `new_page` con
   una URL `javascript:` o `data:` ejecutan código, porque el MCP solo las rechaza con `--no-javascript-evaluation`
   (`utils/url.js:197-199`) y `javascriptEvaluation` vale `true` por defecto (`config/mcp-options.js:124-128`);
   `chrome-personal.cmd` no lo desactiva.
5. Con Canva, `mcp__canva__commit-editing-transaction` guarda los cambios en un diseño real, y
   `mcp__canva__upload-asset-from-url` hace que Canva descargue una URL que elige el modelo. Las dos pasan en plan.

**Evidencia.**

- `tests/core/conductor/session.test.ts:323` deja fijado el comportamiento actual: en la sesión por defecto (sin modo),
  con un servidor llamado `chrome`, `mcp__chrome__navigate_page` vuelve `'{}'` (permitida). No hay ningún caso que
  pruebe una herramienta de plugin en modo plan.
- `chrome-devtools-mcp` 1.11.0 marca como no solo-lectura (`readOnlyHint: false`) `click`, `fill`, `fill_form`,
  `type_text`, `press_key`, `drag`, `upload_file`, `hover` (`input.js:135`, `:409`, `:504`, `:440`, `:614`, `:465`,
  `:546`, `:225`), `evaluate_script` (`script.js:64-70`), `handle_dialog`, `close_page` y `resize_page` (`pages.js:297`,
  `:60`, `:259`). Berland no usa esa información. Tampoco serviría tal cual: el MCP marca igual `new_page` y
  `navigate_page` (`pages.js:91-95`, `:132-136`), que hacen falta para investigar en plan.

## Por qué pasa

La regla de los modos se escribió para las herramientas integradas: cuando el issue 8 (`ee6b125`) dio edición y shell a
bypass, y luego a chat, `modeActs` y el `deny` los encendieron y apagaron por modo. Los plugins habían entrado a la mente
antes, en el mismo commit que los modos (`9b7d84a`), como un bloque `mcp__<servidor>__*`, «todo el servidor o nada», y
nunca pasaron por esa regla. Con el issue 11 (`de896ce`) ese bloque pasó a ser el Chrome personal del usuario, con sus
sesiones abiertas. La guardia no distingue una herramienta de lectura (`take_snapshot`) de una que actúa (`click`) o que
publica (`commit-editing-transaction`).

## Solución posible

1. **Clasificar las herramientas de los plugins en un módulo nuevo `src/core/conductor/plugin-policy.ts`.** Una función
   `pluginToolClass(server, tool, input)` que devuelva `lectura`, `accion`, `script` o `publicar`:
   - `chrome-personal`, **lectura**: `list_pages`, `select_page`, `get_tab_id`, `take_snapshot`, `take_screenshot`,
     `wait_for`, `list_console_messages`, `get_console_message`, `list_network_requests`, `get_network_request`,
     `get_css_styles`, `performance_analyze_insight`. Y `new_page` y `navigate_page` solo si no traen `initScript` y su
     `url` (si la hay) es `http:`, `https:` o `about:blank`, normalizada con `new URL()`; `navigate_page` con `type`
     `back`, `forward` o `reload` también. Lo que mente-01 agrega sobre `file:` y `filePath` se suma encima.
   - `chrome-personal`, **script**: `evaluate_script`, y `new_page`/`navigate_page` con `initScript` o con cualquier
     otro esquema (`javascript:`, `data:`, `vbscript:`…). Así la regla no depende de que mente-01 esté hecha.
   - `chrome-personal`, **accion**: todo lo demás (`click`, `fill`, `fill_form`, `type_text`, `press_key`, `drag`,
     `hover`, `upload_file`, `handle_dialog`, `close_page`, `emulate`, `resize_page`, trazas, `lighthouse_audit`…).
     Una herramienta que no está en la lista cuenta como acción: así, una versión nueva del MCP no abre un hueco.
   - `canva`, **lectura**: las que empiezan por `get-`, `list-` o `search-`, y `resolve-shortlink`. **publicar**: todo
     lo demás (`start-editing-transaction`, `perform-editing-operations`, `commit-editing-transaction`,
     `upload-asset-from-url`, `generate-design`, `resize-design`, `autofill-design`, `reply-to-comment`…). Conviene
     comparar el nombre tratando igual guiones y guiones bajos.
2. **`src/core/conductor/session.ts`, en el `deny` de la guardia (`session.ts:314-324`).** Recibir también `input` (la
   guardia ya lo pasa, `guard.ts:165`) y, si `!modeActs(mode(), standalone)`, negar toda herramienta de plugin que no
   sea `lectura`. Mensaje sugerido: «`<herramienta>` cambia algo fuera de Berland y en el modo `<modo>` no actúas: pídele
   al usuario que pase a chat o bypass, o propón una tarea». El `deny` lee el modo vigente en cada llamada
   (`chat/service.ts:715`), así que la regla rige también cuando el modo cambia con subagentes trabajando y la sesión
   no se recrea (`chat/service.ts:680-690`). A diferencia de `delegar`, que sigue fuera de `allowedTools` hasta la
   sesión siguiente (`session.test.ts:283-285`), las herramientas de plugin están siempre en `allowedTools`: al pasar
   a chat quedan habilitadas sin esperar.
3. **`src/core/conductor/prompt.ts`, en `MODE_TEXT.plan` y `MODE_TEXT.auto`.** Una línea: en Chrome y Canva solo lees
   (navegar y mirar); para rellenar, enviar o publicar, el usuario cambia a chat o bypass.

### Otras opciones

- **No entregar los plugins en plan.** Lo más simple: `ChatService` omite `mcpServers` si `chat.mode === 'plan'`. Se
  pierde la investigación con el navegador justo en el modo de investigar. Además falla mientras haya subagentes
  trabajando: el modo está en la clave de forma (`chat/service.ts:665-675`), pero con subagentes vivos la sesión no se
  recrea (`:680-690`), y una sesión abierta en chat que pasa a plan conserva los plugins hasta que terminen.
- **Aplicarlo solo a plan y dejar auto como está.** Auto promete aprobar y delegar tareas, no que la mente actúe. Si el
  usuario prefiere que en auto la mente sí rellene formularios, basta con usar `mode() === 'plan'` en vez de `modeActs`.
- **Elegir en Plugins qué agentes reciben cada plugin, con la mente aparte.** Hoy no se puede: la interfaz no tiene
  selector y la mente comparte id con el worker Claude. Sirve como complemento, no reemplaza la regla por modo.

La propuesta es abierta. Si se elige otra vía, basta con que pasen las pruebas de abajo. Riesgo que queda: en plan,
`navigate_page` sigue pudiendo llevar datos en la URL. Eso lo tratan `autoeval-navegador-01` (no seguir instrucciones
de páginas) y `autoeval-navegador-03` (confirmar sitios nuevos).

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta.**
  - `tests/core/conductor/plugin-policy.test.ts` (nuevo): `pluginToolClass('chrome-personal', 'take_snapshot', {})`
    devuelve `lectura`; `click`, `fill_form` y `herramienta_nueva` devuelven `accion`; `evaluate_script` y
    `navigate_page` con `{ initScript: 'x' }` devuelven `script`, y también `navigate_page` con
    `{ url: 'javascript:alert(1)' }`, `{ url: 'JAVASCRIPT:alert(1)' }` y `new_page` con `{ url: 'data:text/html,x' }`;
    `navigate_page` con `{ url: 'https://a.test' }` o `{ type: 'back' }` devuelve `lectura`.
    `pluginToolClass('canva', 'get-design-content', {})` devuelve `lectura`, y `commit-editing-transaction` y
    `upload-asset-from-url` devuelven `publicar`.
  - `tests/core/conductor/session.test.ts`, casos nuevos dentro de
    `describe('ConductorSession: modos, agente suelto, plugins e imágenes')` (línea 260), que es donde está `hookOf`
    (línea 261); o sacar `hookOf` al nivel del archivo y abrir un `describe('ConductorSession: plugins según el modo')`.
    Con `let mode: MindMode = 'plan'`, `fake = { type: 'stdio', command: 'node', args: ['x.js'] }` y
    `fakeHttp = { type: 'http', url: 'https://mcp.canva.test/mcp' }`, usa
    `session({ mode: () => mode, mcpServers: { 'chrome-personal': fake, canva: fakeHttp } })`.
    Con `mode = 'plan'`, `take_snapshot` y `navigate_page` con `https://example.com` vuelven `'{}'`. `click`,
    `fill_form`, `evaluate_script`, `navigate_page` con `javascript:alert(1)`, `upload_file`, `handle_dialog`,
    `mcp__canva__commit-editing-transaction` y una herramienta desconocida vuelven `"permissionDecision":"deny"` con
    el motivo del modo. Cambia `mode = 'chat'` y `click` vuelve a `'{}'`. Repite con `mode = 'auto'`, y con
    `projectId: null` en modo plan y en modo bypass (Conversación: bypass sin proyecto no actúa, `session.ts:65-67`).
- **Comando** (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/conductor/plugin-policy.test.ts tests/core/conductor/session.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`:
  `npx vitest run tests/core/conductor/plugin-policy.test.ts tests/core/conductor/session.test.ts`).
- **Verificación manual en la app.** Con Chrome conectado, abre un chat en modo plan y pide «abre
  https://httpbin.org/forms/post, rellena el nombre con Prueba y envíalo». La mente debe abrir la página y leerla, pero
  `fill` y `click` deben volver negadas con el motivo del modo. Pasa a modo chat con Shift+Tab y repite: ahí sí se
  permite (y, con `autoeval-navegador-03`, pide confirmación).
