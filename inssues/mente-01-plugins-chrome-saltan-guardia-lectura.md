# Con el plugin Chrome, la mente lee por `file://` archivos que la guardia le niega (otros proyectos, la memoria de Obsidian y credenciales), en todos los modos

- **Área:** Mente y chat
- **Severidad:** alta
- **Archivos:** `src/core/conductor/guard.ts:10`, `src/core/conductor/guard.ts:117`, `src/core/conductor/guard.ts:135`, `src/core/conductor/guard.ts:163`, `src/core/conductor/guard.ts:184`, `src/core/conductor/session.ts:298`, `src/core/conductor/session.ts:314`, `src/core/conductor/session.ts:358`, `src/core/app/f5-chat.ts:77`, `src/core/chat/service.ts:706`, `src/core/chat/service.ts:732`, `src/core/plugins/service.ts:55`, `src/core/plugins/service.ts:325`, `src/core/plugins/chrome.ts:55`, `src/core/plugins/chrome-gate.ts:155`, `src/core/plugins/chrome-gate.ts:194`, `C:\dev\agent-hub\tools\browser\chrome-personal.cmd:3` (fuera del repo)
- **Estado:** resuelta

## Cómo ocurre

**Contexto.** La guardia de la mente (`createToolGuard`) promete que la lectura no sale de la carpeta del proyecto ni de las raíces extra, y que nunca toca archivos de credenciales ni las rutas de `denyPaths`. Esas rutas son la bóveda, la base del núcleo y la memoria de Obsidian `C:\dev\orquestador-memoria`, que tiene los datos de todos los proyectos (issue 9, `src/core/app/conductor.ts:127`):

```ts
// guard.ts:10-12
 * - La lectura queda dentro de la carpeta del proyecto y de las raíces extra (…); nunca toca archivos típicos de
 *   credenciales (.env, claves privadas…) ni las rutas de `denyPaths` (bóveda y base de datos del núcleo).
```

Desde el issue 11, la mente recibe el plugin Chrome como servidor `chrome-personal`. `PLUGIN_AGENT_KINDS.chrome` incluye `claude-sdk` (`plugins/service.ts:55`), `mindPlugins` lo pide con ese tipo (`f5-chat.ts:77`) y `ChatService` se lo pasa a la sesión **en cualquier modo**, sin mirar `chat.mode` (`chat/service.ts:706` y `:732`).

**Pasos.**

1. El plugin Chrome está conectado y el usuario tiene abierto un chat del proyecto A en modo `plan`. En ese modo, Read, Grep y Glob solo ven la carpeta de A y las raíces extra.
2. La mente llama `mcp__chrome-personal__navigate_page { url: "file:///C:/dev/orquestador-memoria/" }` (o `new_page` con esa URL). Lo mismo puede hacer un subagente `general-purpose`, que hereda las herramientas MCP y pasa por el mismo hook, o una inyección escondida en una página web que la mente esté leyendo.
3. La guardia aprueba la llamada. La puerta `chrome-gate.ts` la reenvía sin mirar sus argumentos. `chrome-devtools-mcp` 1.11.0 deja navegar a `file:` porque el lanzador no lo desactiva. Chrome muestra el índice de la carpeta y `take_snapshot` (o `evaluate_script` con `document.body.innerText`) devuelve los nombres. Al navegar a `…/<otro-proyecto>/Contexto.md` devuelve su contenido. Pasa igual con `file:///C:/dev/<otro-proyecto>/.env`, `file:///C:/Users/<u>/.codex/auth.json` o `file:///C:/Users/<u>/.ssh/id_ed25519`. Read negaría todas esas rutas por `inside`, `SENSITIVE_FILE` o `denyPaths` (`guard.ts:142-145`).
4. Con lo leído en contexto, la mente puede sacarlo por cualquier formulario o URL del Chrome personal, que tiene las sesiones abiertas del usuario (`fill`, `type_text`, `navigate_page` a `https://…?q=…`).

**Evidencia.**

- `session.ts:298`: cada plugin entra en `allowedTools` con comodín: `...plugins.map(([name]) => \`mcp__${name}__*\`)`.
- `guard.ts:117-118` y `:135`: el comodín se vuelve prefijo y `isAllowed` acepta cualquier herramienta del servidor.
- `guard.ts:163-184`: `precheck` solo revisa argumentos de `READ_TOOLS` (Read, Grep, Glob) y de `Agent`/`Task`. Para todo lo demás termina en `return { allow: true };` (línea 184).
- `session.ts:314-324`: el `deny` dinámico de la sesión solo bloquea la flota sin proyecto, `delegar` en plan, `crear_tareas`/`delegar` en chat y la edición o el shell fuera de bypass/chat. No restringe ningún plugin, ni siquiera en `plan`.
- `chrome-gate.ts:155-159` y `:194`: un `tools/call` solo espera el candado y sigue con `this.#deps.toServer(line)`. Los argumentos no se revisan.
- `chrome.ts:55-56`: el lanzador es `cmd.exe /c chrome-personal.cmd` y no agrega opciones. `chrome-personal.cmd:3` (hub) ejecuta `chrome-devtools-mcp --autoConnect --usageStatistics=false --performanceCrux=false --screenshotMaxWidth 1280 --workspace C:\dev %*`, sin `--no-file-navigations`.
- En `chrome-devtools-mcp` 1.11.0 (`C:\dev\agent-hub\tools\browser\node_modules\chrome-devtools-mcp\build\src`), `fileNavigations` vale `true` por defecto (`config/mcp-options.js:130-135`). `validateUrl` rechaza `file:` solo `if (fileNavigations === false && targetsFileScheme(parsed))` (`utils/url.js:201`), y `navigate_page`/`new_page` la llaman sin validar la ruta en disco (`tools/pages.js:114` y `:176`).
- No hay prueba que lo cubra. `tests/core/conductor/guard.test.ts:121-127` solo comprueba que el comodín permite el servidor exacto. `tests/core/chat/service.test.ts:575` y `tests/core/conductor/session.test.ts:323` prueban `navigate_page` con `https://example.com`.

**Correcciones al reporte original.**

- `f5-chat.ts:347` y `:364` no existen, porque el archivo tiene 132 líneas. La entrega a la mente está en `f5-chat.ts:77` y `:118`, y en `chat/service.ts:706` y `:732`.
- `upload_file` de `C:\Users\<u>\.ssh\id_ed25519` **sí lo frena** `chrome-devtools-mcp`. El parámetro es `filePaths` (arreglo) y pasa por `validatePath` (`ToolHandler.js:163-186`, `McpContext.js:131-185`), que solo acepta las raíces `--workspace C:\dev`, la carpeta temporal y las raíces que anuncie el cliente. Lo que no frena es subir archivos de **cualquier parte de `C:\dev`**: la memoria `C:\dev\orquestador-memoria`, los `.env` de otros proyectos o el propio `C:\dev\orquestador`. Si el cliente anunciara como raíces las unidades locales de bypass, la restricción desaparece.
- `take_screenshot`, `take_heapsnapshot` y las trazas también escriben con `filePath` en cualquier parte de `C:\dev`, en modo plan. El MCP fuerza la extensión (`.png`, `.heapsnapshot`; `McpContext.js:186-191` y `:531-535`), así que no pueden pisar código, pero sí escribir y sobrescribir imágenes y volcados en otros proyectos. Es un efecto secundario. Lo grave es la lectura por `file://`.

## Por qué pasa

La guardia valida argumentos solo para las herramientas integradas que conoce. Las de los plugins entran por prefijo y se aprueban sin mirar qué hacen (`guard.ts:184`). El servidor `chrome-personal` trae herramientas que leen archivos locales: navegar a `file:`, `upload_file` y los `filePath` de salida. Ninguna capa de Berland las acota: la guardia, el `deny` de la sesión y la puerta las dejan pasar. El MCP de Chrome solo limita los `filePath` a `C:\dev` y deja `file:` abierto. Así, lo que la guardia le niega a Read (rutas fuera del proyecto, `SENSITIVE_FILE`, `denyPaths`) se lee igual por el navegador.

## Solución posible

1. **`src/core/conductor/guard.ts`, en `precheck`.** Agregar reglas para las herramientas del servidor de Chrome (`mcp__chrome-personal__…`; conviene importar el nombre de `CHROME_SERVER` o recibirlo como opción `browserServer`):
   - En `navigate_page` y `new_page`, si viene `url`, aceptar solo `http:`, `https:` y `about:blank`, y negar `file:`, `view-source:` (que envuelve `file:`), `data:`, `javascript:`, `blob:`, `filesystem:`, `chrome:` y `devtools:`. Normalizar con `new URL()` en minúsculas, como hace `targetsFileScheme`, para que `FILE:` o `view-source:FILE:` no se escapen.
   - En `upload_file`, pasar cada elemento de `filePaths` por `checkPath`, con las mismas raíces de lectura, `SENSITIVE_FILE` y `denyPaths`.
   - En los `filePath` de salida (`take_screenshot`, `take_heapsnapshot`, `performance_stop_trace`, `screencast_start`), exigir que la ruta quede dentro de `writeRoots`. Sin `writeRoots`, es decir fuera de bypass y chat, negarlos si traen `filePath`; sin `filePath` el resultado vuelve inline o a la carpeta temporal.
2. **Defensa en profundidad, en `src/core/plugins/chrome.ts:55`.** Hacer que `defaultChromeLauncher` agregue `--no-file-navigations` a los argumentos. El `.cmd` del hub los reenvía con `%*`, así que con eso también quedan cubiertos la flota (Claude y Codex), que comparte el mismo lanzador, y cualquier herramienta futura que navegue.

### Otras opciones

- **Filtrar en `chrome-gate.ts`.** Es el proxy común a la mente y a la flota: rechazar ahí los `tools/call` con URL `file:` o con `filePaths` y `filePath` fuera de una lista cubre a todos los agentes de una vez. A cambio, la puerta tendría que conocer las raíces de cada sesión, que hoy no recibe, y eso la vuelve más compleja.
- **Solo la opción de `chrome-devtools-mcp`.** Agregar `--no-file-navigations` y restringir `--workspace` a la carpeta del proyecto en vez de `C:\dev` cuesta poco y no toca la guardia. El propio MCP advierte que no es un sandbox: no cubre pestañas `file:` que ya estaban abiertas, a las que se llega con `select_page`.
- **`disallowedTools` de la mente.** Poner `mcp__chrome-personal__upload_file` y `take_heapsnapshot` en la lista corta la subida y el volcado, pero no la lectura por `file://`.
- **Política de Chrome `URLBlocklist: ["file://*"]`.** Lo resuelve en el navegador para todos, pero afecta el uso personal de Chrome por parte del usuario.

La propuesta no es la única. Lo más sólido es combinar la regla en la guardia, que deja la promesa de `guard.ts:10-12` cumplida y probada, con la opción del MCP, que es barata y cubre la flota.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta** en `tests/core/conductor/guard.test.ts`, nuevo `describe('herramientas del Chrome personal')`:
  - Arma `createToolGuard({ allowedTools: ['mcp__chrome-personal__*'], cwd: 'C:\\p', denyPaths: ['C:\\dev\\orquestador-memoria'], pathApi: path.win32 })`.
  - Afirma que `decide('mcp__chrome-personal__navigate_page', { url: 'file:///C:/dev/orquestador-memoria/' })` devuelve `allow: false`, y lo mismo con `{ url: 'FILE:///C:/x' }`, `{ url: 'view-source:file:///C:/x' }` y `new_page` con `file:`.
  - Afirma que `navigate_page` con `https://example.com`, `new_page` con `about:blank` y `navigate_page` con `{ type: 'back' }` siguen en `allow: true`.
  - Afirma que `upload_file` con `filePaths: ['C:\\p\\informe.pdf']` se permite, y que se niega con `['C:\\dev\\otro\\.env']` (fuera de las raíces), con `['C:\\p\\id_ed25519']` (`SENSITIVE_FILE`) y con `['C:\\dev\\orquestador-memoria\\x.md']` (`denyPaths`).
  - Afirma que `take_screenshot` con `filePath: 'C:\\dev\\otro\\a.png'` se niega sin `writeRoots` y se permite con `writeRoots: ['C:\\p']` y `filePath: 'C:\\p\\a.png'`.
- Si se agrega la opción del lanzador: en `tests/core/plugins/chrome.test.ts`, afirmar que `defaultChromeLauncher().args` incluye `--no-file-navigations`.
- **Comando** (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/conductor/guard.test.ts tests/core/plugins/chrome.test.ts"` (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/conductor/guard.test.ts tests/core/plugins/chrome.test.ts`).
- **Verificación manual:** con Chrome conectado, abrir un chat en modo plan y pedirle a la mente que abra `file:///C:/dev/orquestador-memoria/` en el Chrome personal. La herramienta debe volver negada con el motivo de la guardia. Pedirle que abra `https://example.com` debe seguir funcionando.
