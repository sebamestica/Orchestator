# Issue 11 — Los agentes usan tu Chrome personal, nunca otro navegador

Estado: hecho, salvo las pruebas en vivo que tocan Chrome o gastan cupo (las corre el usuario) · Commit: uno solo, a nombre del usuario y sin trailers

## Lo que pidió el usuario
«No me deja que los agentes tengan acceso directo a mi Chrome personal: en vez de eso se abre una pestaña de Chrome
que no tiene nada que ver con mi Chrome […] Iniciar sesión en una página en la que ya estoy registrado es más tardado.»
Lo mismo para Canva y los plugins que vengan.

## Diagnóstico verificado (2026-11-04)

Todo se comprobó en solo lectura: sin tocar el Chrome del usuario, sin gastar cupo (`codex debug prompt-input`,
`codex mcp list/get`, `agy mcp list`, `agy -p "/permissions"` no llaman al modelo) y sin cambiar ninguna
configuración global.

### 1. La herramienta del hub sí usa el Chrome real
- `C:\dev\agent-hub\tools\browser\chrome-personal.cmd` lanza `chrome-devtools-mcp@1.11.0 --autoConnect`.
- `node_modules\chrome-devtools-mcp\build\src\BrowserManager.js:317-400`: con `--autoConnect` solo **se conecta**
  (canal estable → `DevToolsActivePort` de `%LOCALAPPDATA%\Google\Chrome\User Data`). Si no puede, lanza
  «Could not connect to Chrome… chrome://inspect/#remote-debugging». Nunca abre un Chrome propio.
- Conecta recién en la primera herramienta, no en `initialize` ni en `tools/list`.

### 2. El perfil: Default
- `User Data\Local State`: `profile.last_used = "Default"`. Hay dos perfiles: `Default` («S_», con sesión de Google
  y activo hoy) y `Profile 6` («chat58», sin uso desde hace meses).
- `User Data\DevToolsActivePort` existe (puerto 9222, 21:18): la depuración remota está activa ahora.
- Las pestañas nuevas por CDP se abren en el perfil del contexto por defecto del navegador, que es el último usado.
  Hoy es Default. Si el usuario pasa a otro perfil, las pestañas nuevas irán allí: la interfaz lo avisa.

### 3. ¿Quién abre el Chrome ajeno?
| Vía | Evidencia | Efecto |
|---|---|---|
| **Claude Code en WSL** (A0, workers de la flota) | `/home/sebastian/.claude.json` → `mcpServers.chrome-agente` = `cmd.exe /c …\chrome-agente.cmd`. Procesos vivos 12968/19452 (`chrome-agente.cmd`) e hijos `chrome-devtools-mcp --userDataDir C:\dev\agent-hub\tools\browser\chrome-profile`, padres `wsl.exe` 16808/23036 | **Este es el Chrome «que no tiene nada que ver»**: perfil aislado `tools\browser\chrome-profile` (último uso hoy, 21:34). El Claude Code de Windows (`C:\Users\SEBASTIAN\.claude.json`) solo tiene `chrome-personal` |
| **Guía del hub** | `tools\browser\README.md:9`: `chrome-agente.cmd` «Recomendado»; skill `navegador-chrome:12` lo da como plan B | Los agentes lo eligen cuando `chrome-personal` falla |
| **Codex** | `~/.codex/config.toml`: plugins `browser@`, `chrome@`, `computer-use@`, `unified-computer-use@openai-bundled` activos y `mcp_servers.node_repl` (motor de esos plugins: `BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab,mcpapps"`). `codex debug prompt-input` muestra al modelo las skills `browser:control-in-app-browser` («in-app Browser… It can have existing signed-in sessions») y `chrome:control-chrome`, que dicen «treat that as mandatory reading before browser work» | Codex prefiere su navegador integrado (`iab`) |
| **Codex no puede usar `chrome-personal`** | `.orq/diag/vig-codex-over.json` del worktree viejo: `mcp_tool_call chrome-personal new_page` → «MCP tool call requires approval, but approval policy is never». `codex exec` no pide aprobaciones y las herramientas del MCP no traen `readOnlyHint` | Aunque Berland le entregue Chrome, Codex no puede llamarlo y busca otro camino (web, `iab`) |
| **Codex usa `chrome-personal` fuera del candado** | `~/.codex/config.toml` → `mcp_servers.chrome-personal`. Proceso 8112 (`chrome-personal.cmd`) hijo del daemon `codex.exe app-server` | Si Berland no le entrega Chrome, igual lo tiene, sin candado |
| **agy** | `agy mcp list`: `chrome-personal` (global, fuera del candado). Su subagente de navegador usa un Chrome DevTools MCP propio (`chrome_devtools`, `chrome-devtools-mcp@1.12.0` en el binario) y solo se invoca con `/browser`. El perfil aparte `~/.gemini/antigravity-browser-profile` es del IDE/App (sin uso desde mayo). El plugin `chrome-devtools-plugin` 0.21.0 no tiene componentes (`agy plugin list`) | Navegador propio de agy alcanzable solo por `/browser` |
| **Berland: dos agentes a la vez** | `src/core/plugins/service.ts:235-249`: el candado `chrome-personal` se toma **por sesión** con `lockWaitMs ?? 0`; la segunda sesión no recibe el servidor («esta sesión no lo recibe», `:248`) | El segundo agente queda sin Chrome y busca otro navegador |
| **Berland: perfil aislado oculto** | `service.ts:326` (`body.profile ?? prev.profile`), `PluginsView.tsx:18` (perfil local, siempre «personal» al abrir) y `:68-71` (selector deshabilitado al estar conectado). `Plugin` no trae el perfil | Si alguna vez se eligió «agente», la ventana muestra «personal» y los agentes reciben `chrome-agente`. Hoy no: `plugins_state` dice `chrome · connected · profile personal` (lectura con `scripts/diagnostico-chrome/leer-plugins-state.mjs` del worktree viejo) |
| **La mente** | `src/core/app/f5-chat.ts:73`: usa `mcpServersFor`, sin `grant` | La mente maneja Chrome sin candado |

### 4. Canva
- El MCP de Canva va por OAuth con la cuenta del usuario (`service.ts:300-302`). Ninguna instrucción del repo manda
  a manejar Canva por un navegador aparte: `CANVA_NOTE` no habla de navegador. La skill del hub `canva-navegador`
  usa `chrome-personal`.

### 5. Opciones de las CLIs (verificadas sin cupo)
- **Codex 0.165.0:** `-c` divide la ruta por puntos sin comillas: `-c plugins.chrome@openai-bundled.enabled=false`
  funciona y quita las skills `browser:`, `chrome:` y `computer-use:` del prompt. La forma con comillas
  (`plugins."chrome@…"`) no hace nada.
- `--disable browser_use` (y otras funciones) no cambia el prompt.
- `-c mcp_servers.<n>.enabled=false` desactiva un servidor que existe. Si no existe, Codex no arranca («invalid
  transport»). Con `command` + `enabled=false` el servidor queda válido y apagado exista o no (comprobado con
  `codex mcp get`).
- `default_tools_approval_mode` admite `auto | prompt | writes | approve`. Codex valida el valor.
- **agy 1.5.0:** `--settings` no admite `mcpServers` ni opciones de navegador. Sí admite
  `permissions.deny`: `agy --settings '{"permissions":{"deny":["mcp(chrome_devtools/*)"]}}' -p "/permissions"`
  imprime la regla, y no se guarda en disco. `--disable-slash-commands` evita que `-p "/browser …"` se expanda.
  Lo confirma la prueba en vivo: con ese argumento, `-p "/permissions"` ya no se responde en local y va al modelo.

## Diseño

### Una sola vía: `chrome-personal` con «puerta»
- El plugin Chrome tiene **un solo perfil**: tu Chrome personal (`--autoConnect`, perfil del contexto por defecto, hoy
  Default). Se quitan el perfil `agente`, sus pasos y la opción en la interfaz.
  - `connect` con `profile: 'agente'` responde 400 con el motivo.
  - Un estado guardado con `agente` pasa a «desconectado» al arrancar, con el aviso.
- A todos los agentes (Claude, Codex, la mente y sus subagentes) se les entrega el servidor `chrome-personal`:
  `node src/core/plugins/chrome-gate.ts … -- cmd.exe /c C:\dev\agent-hub\tools\browser\chrome-personal.cmd`.
- La **puerta** (`chrome-gate.ts`) es un proxy MCP por stdio:
  - Deja pasar `initialize`, `tools/list` y todo lo demás.
  - En el primer `tools/call` toma el candado `chrome-personal` de `C:\dev\agent-hub\locks` y **espera** si otro lo
    tiene (5 min por llamada).
  - Si sigue ocupado, responde la herramienta con un error claro: quién lo tiene, «no abras otro navegador, reintenta
    o dilo en tu informe».
  - Suelta el candado tras 3 min sin llamadas o al terminar la sesión.
  - Si el dueño anterior murió sin soltarlo (misma máquina, pid muerto, candado de Berland), lo libera.
  - Así un agente que no navega no bloquea a nadie, y la mente queda bajo el mismo candado.
- `grant()` ya no toma el candado por sesión. Al soltar la sesión limpia el candado si su puerta murió sin soltarlo.
- Si Chrome no está conectado o el agente no está elegido, la sesión recibe la nota «esta sesión no tiene navegador:
  no abras ninguno».
- Notas para los agentes (`chrome.ts`): «es tu Chrome personal; usa solo `chrome-personal`; nunca abras otro
  navegador (ni el integrado de tu CLI, ni Playwright, ni un perfil aparte)».

### Codex sin navegador propio (solo argumentos de Berland)
- `-c plugins.{browser,chrome,computer-use,unified-computer-use}@openai-bundled.enabled=false`.
- `-c features.{browser_use,browser_use_external,in_app_browser,computer_use}=false`.
- `node_repl`, `chrome-agente`, `chrome-devtools` y `chrome-personal` (este último cuando Berland no lo entrega)
  quedan como `command="cmd.exe"` + `enabled=false`.
- Cada servidor que entrega Berland va con `enabled=true` y `default_tools_approval_mode="approve"` (sin esto Codex no
  puede llamarlo en `exec`). Chrome además lleva `tool_timeout_sec`, que cubre la espera de la puerta.

### agy sin navegador propio (solo argumentos)
- `--disable-slash-commands` y `--settings '{"permissions":{"deny":["mcp(chrome_devtools/*)","mcp(chrome-devtools/*)","mcp(chrome-agente/*)","mcp(playwright/*)"]}}'`.
- agy sigue viendo su `chrome-personal` global, que es el Chrome correcto pero **sin la puerta**: agy no recibe
  servidores por sesión (F5.2: `agy acp`). Propuesta para el hub en el informe.

### Interfaz de plugins
- Tarjeta de Chrome con el estado real, leído al pedir `GET /plugins` y cada 15 s mientras la vista está abierta:
  - conectado o no;
  - depuración remota activa (`DevToolsActivePort`);
  - perfil donde se abren las pestañas nuevas (`Local State`);
  - quién la usa ahora (candado `chrome-personal`).
- Botón «Probar conexión»: es el `connect` actual con `list_pages`. Sin selector de perfil.
- Por contrato (`Plugin` no se toca), el estado vivo va en `detail` separado por « · ». La interfaz lo muestra en líneas.

### Plugins futuros
Todo plugin que use la sesión del usuario (su navegador, su cuenta) sigue el mismo molde:
1. **Una sola vía:** el servidor del hub o el MCP oficial con la cuenta del usuario (OAuth en la bóveda), nunca una
   copia aislada.
2. **Recurso exclusivo → puerta:** si el recurso no admite dos agentes a la vez, se envuelve con la puerta
   (`chrome-gate.ts` recibe `--lock <nombre>`): candado perezoso por llamada, espera y error claro.
3. **Apagar lo equivalente de cada CLI** por argumentos de Berland (`codexBrowserOffArgs`, `AGY_BROWSER_DENY`), nunca
   en la configuración global.
4. **Estado vivo en la tarjeta** (conexión, cuenta o perfil, quién lo usa) y un «Probar conexión».

## Rutas propias
- `src/core/plugins/**` (`chrome.ts`, `chrome-gate.ts`, `service.ts`, `mcp.ts`, `routes.ts`, `index.ts`).
- `src/core/locks/manager.ts` e `index.ts`: solo `releaseAbandoned`.
- `src/core/adapters/codex-cli/index.ts`: solo los argumentos de navegador y plugins.
- `src/core/adapters/agy-cli/index.ts`: solo esos argumentos.
- `src/ui/features/plugins/**`.
- Pruebas: `tests/core/plugins/**`, `tests/core/adapters/**`, `tests/ui/plugins/**` y `tests/live/chrome-personal.live.test.ts`.
- `docs/plan/issues/11-chrome-personal.md`; `docs/api/*.json` regenerados (cambia la descripción de `POST /plugins/:id/connect`).
- Fuera de mi zona (propuesto en el informe): `src/core/adapters/claude-sdk/adapter.ts`, `src/shared/api.ts`,
  `src/core/app/adapters.ts`, skills y lanzadores del hub, `/home/sebastian/.claude.json`.

## Criterios de aceptación
1. Codex se lanza con sus plugins de navegador, funciones de navegador y `node_repl` apagados, y con los servidores
   de Berland en `approve` (prueba de argumentos exactos).
2. agy se lanza con `--disable-slash-commands` y las reglas `deny` de navegadores propios (prueba de argumentos).
3. Ningún agente recibe `chrome-agente` ni `--userDataDir`; `connect` con `agente` responde 400; un estado guardado
   con `agente` queda desconectado.
4. La puerta serializa el Chrome personal: dos puertas a la vez, la segunda espera hasta que la primera suelta;
   ocupado más allá de la espera → error claro; dueño muerto → se libera; sin `tools/call` no toma el candado.
5. La interfaz muestra el estado vivo (perfil, depuración remota, quién lo usa) y el botón «Probar conexión», sin
   selector de perfil.
6. `npm run -s check` en verde, con cifras reales.

## Resultado (2026-11-04)
- `npm run -s check`: verde. 139 archivos de prueba aprobados y 11 saltados (150); 1749 pruebas aprobadas y 26
  saltadas (1775); `build:ui` y `build:desktop` compilan.
- `tests/live/chrome-personal.live.test.ts` con `ORQ_LIVE=1`: 4 aprobadas, sin cupo y sin tocar Chrome.
  - El prompt de Codex ya no trae `browser:`, `chrome:`, `computer-use:` ni `mcp__node_repl__js`.
  - `codex mcp get` dice `(disabled)` para `node_repl`, `chrome-personal`, `chrome-agente` y `chrome-devtools`.
  - El `chrome-personal` de Berland queda `enabled: true` y `default_tools_approval_mode: approve`.
  - `agy -p "/permissions"` lista las 4 reglas deny.
- Las 2 restantes (`ORQ_LIVE_CHROME=1` y `ORQ_LIVE_CUPO=1`) no se ejecutaron: tocan el Chrome del usuario o gastan
  cupo de Codex.
