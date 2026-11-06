# Codex arranca `chrome-personal` (puerta, cmd y chrome-devtools-mcp) con su tope de arranque por defecto, sin margen para un PC cargado

- **Área:** Plugins y navegador
- **Severidad:** baja
- **Archivos:** `src/core/adapters/codex-cli/index.ts:54`, `src/core/adapters/codex-cli/index.ts:57`, `src/core/plugins/mcp.ts:11`, `src/core/plugins/mcp.ts:20`, `src/core/plugins/chrome.ts:101`, `src/core/plugins/chrome.ts:109`, `src/core/plugins/chrome-gate.ts:155`, `src/core/plugins/chrome-gate.ts:291`, `src/core/plugins/mcp-probe.ts:26`, `src/core/plugins/service.ts:405`, `tests/live/chrome-personal.live.test.ts:88`
- **Estado:** resuelta

## Cómo ocurre

Cuando el plugin Chrome está conectado, Berland le entrega a cada ejecución de Codex el servidor `chrome-personal`, que
según el encargo es su único navegador (`CHROME_ONLY_NOTE`, `src/core/plugins/chrome.ts:63`). El servidor no es
`chrome-devtools-mcp` directo. Es la puerta, que corre en el Node del núcleo (`src/core/plugins/chrome.ts:101-110`):

```ts
command: gate.node ?? process.execPath,
args: chromeGateArgs(launcher, gate),
...
toolTimeoutSec: waitSec + 120,
```

Para que Codex reciba la respuesta a `initialize` tiene que arrancar toda esta cadena:

1. `node chrome-gate.ts`: Node 24 quita los tipos de `chrome-gate.ts` y carga sus imports (`../../shared/index.ts` con
   zod, `../locks/manager.ts`, `./chrome.ts`, etc.; `src/core/plugins/chrome-gate.ts:19-31`).
2. La puerta lanza `cmd.exe /c C:\dev\agent-hub\tools\browser\chrome-personal.cmd` (`chrome-gate.ts:291`,
   `defaultChromeLauncher` en `chrome.ts:55-57`).
3. Ese `.cmd` llama al shim de npm `node_modules\.bin\chrome-devtools-mcp.cmd`, que lanza otro `node` con
   `chrome-devtools-mcp` 1.11.0. Este carga `build/src/third_party/index.js` (7,9 MB, comprobado en
   `C:\dev\agent-hub\tools\browser\node_modules`).

La puerta no responde `initialize` ni `tools/list` por su cuenta. Pasa al servidor real todo lo que no sea
`tools/call` (`chrome-gate.ts:155-157`):

```ts
if (msg?.method !== 'tools/call' || msg.id === undefined || msg.id === null) {
  this.#deps.toServer(line);
  return;
}
```

El adaptador de Codex traduce el servidor a `-c mcp_servers.<n>.…` y solo agrega `enabled`,
`default_tools_approval_mode` y `tool_timeout_sec` (`src/core/adapters/codex-cli/index.ts:54-58`):

```ts
const common = (name: string, spec: McpServerMap[string]) => {
  set(name, 'enabled', 'true');
  set(name, 'default_tools_approval_mode', '"approve"');
  if (spec.toolTimeoutSec !== undefined) set(name, 'tool_timeout_sec', String(Math.max(1, Math.ceil(spec.toolTimeoutSec))));
};
```

Nunca escribe `startup_timeout_sec`. La configuración global del usuario tampoco lo hace: en
`~/.codex/config.toml` la tabla `[mcp_servers.chrome-personal]` solo trae `command` y `args`, mientras que
`node_repl` (120) y `blender` (60) sí lo suben. Los `-c` de Berland se mezclan con esa tabla, así que rige el valor por
defecto de Codex, que según su documentación es de 10 s. El binario instalado (codex-cli 0.165.0) acepta la clave y
falla con «MCP client startup timed out after … seconds. Add or adjust `startup_timeout_sec` in your config.toml».

El núcleo da mucho más tiempo a esta misma cadena:

- La prueba de conexión del plugin le da 30 s solo al lanzador, sin la puerta (`src/core/plugins/service.ts:405`,
  `startTimeoutMs: chromeOpts.startTimeoutMs ?? 30_000`). El motivo está en `src/core/plugins/mcp-probe.ts:26`:
  «Por defecto 30 s (un `.cmd` de npm tarda en un PC ocupado)».
- La prueba en vivo de la puerta le da 60 s al arranque (`tests/live/chrome-personal.live.test.ts:88`,
  `startTimeoutMs: 60_000`).

Pasos para que pase:

1. Conectar el plugin Chrome. «Probar conexión» queda en verde porque tiene 30 s.
2. Con la máquina cargada (por ejemplo, Defender escaneando los `node_modules` o el bundle de 7,9 MB), despachar una
   tarea a Codex.
3. Si la puerta, `cmd.exe`, el shim de npm y `chrome-devtools-mcp` tardan más de 10 s en responder `initialize` y
   `tools/list`, Codex abandona el servidor y sigue sin herramientas `chrome-personal`. Como Berland le apagó los
   navegadores propios (`codexBrowserOffArgs`, `index.ts:107-116`) y el encargo le prohíbe abrir otro, la tarea que
   necesitaba navegar no puede hacerlo, aunque la interfaz muestre el plugin como conectado.

## Por qué pasa

`McpStdioSpec` (`src/core/plugins/mcp.ts:11-21`) solo trae un tope por llamada (`toolTimeoutSec`) y ninguno de
arranque. Por eso `chromeServerSpec` no puede pedir más tiempo y `codexMcpArgs` no escribe
`mcp_servers.<n>.startup_timeout_sec`. Una cadena de dos Node y dos `cmd.exe` queda con los 10 s que Codex trae por
defecto, mientras el resto del núcleo da 30 s o 60 s a esa misma cadena. El issue 11
(`docs/plan/issues/11-chrome-personal.md:92`) solo se ocupó de `tool_timeout_sec`, que cubre la espera del candado.

## Solución posible

1. `src/core/plugins/mcp.ts`: agregar `startupTimeoutSec?: number` a `McpStdioSpec` (y a `McpHttpSpec` si se quiere
   un trato uniforme), documentado como «tope de arranque + `initialize` + `tools/list`, en segundos (Codex:
   `startup_timeout_sec`)».
2. `src/core/plugins/chrome.ts` (`chromeServerSpec`): fijar `startupTimeoutSec: 60`, el valor de la prueba en vivo, o
   una constante exportada `CHROME_STARTUP_TIMEOUT_SEC` que la prueba de conexión también use.
3. `src/core/adapters/codex-cli/index.ts` (`common` en `codexMcpArgs`): si viene, agregar
   `set(name, 'startup_timeout_sec', String(Math.max(1, Math.ceil(spec.startupTimeoutSec))))`.
4. Actualizar la expectativa exacta de `tests/core/plugins/adapters.test.ts:142-160`, que hoy compara la lista
   completa de argumentos.
5. Revisar el adaptador de Claude: hoy no fija `MCP_TIMEOUT` en el entorno del SDK. Conviene comprobar cuál es su
   valor por defecto y, si es corto, pasarlo desde el mismo `startupTimeoutSec`.

### Otras opciones

- Que la puerta conteste `initialize` y `tools/list` desde un catálogo guardado en la última prueba de conexión y
  lance `chrome-devtools-mcp` recién en la primera `tools/call`. Así el arranque visto por Codex dura solo lo que tarda
  el Node de la puerta, y un agente que no navega nunca lanza el segundo Node. Además ahorra CPU en cada ejecución.
  Es un cambio más grande (catálogo versionado, invalidarlo si cambia `chrome-devtools-mcp`, manejar el
  `notifications/initialized` diferido), pero ataca la causa.
- Bajar el costo de la cadena: lanzar `node …\chrome-devtools-mcp\build\src\bin\chrome-devtools-mcp.js` directo, sin
  `cmd.exe` ni los dos `.cmd`. Hoy el lanzador es el del hub, así que esto cambia el contrato con la skill.
- Subir solo el valor global en `~/.codex/config.toml`. Se descarta porque Berland no toca esa configuración
  (`index.ts:97-98`) y el valor tiene que viajar con cada ejecución.

La propuesta principal es la más chica, pero no la única. La puerta perezosa probablemente es la más optimizada.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta: en `tests/core/plugins/adapters.test.ts`, bloque «traducción a Codex CLI», un caso
  que arme `codexPluginArgs({ 'chrome-personal': chromeServerSpec(defaultChromeLauncher(), { agent: 'codex-main', task: 'tarea-codex', locksRoot: 'C:\\locks' }) })`
  y afirme que `args` contiene `'-c', 'mcp_servers.chrome-personal.startup_timeout_sec=60'` (o el valor de la
  constante). También que un servidor sin `startupTimeoutSec` (p. ej. `canva`) no lleva esa clave. Ajustar la
  expectativa exacta del caso `codexMcpArgs: -c mcp_servers.<n>.… sin secretos…`.
- Prueba en vivo opcional (sin cupo): en `tests/live/chrome-personal.live.test.ts`, el caso «el chrome-personal de
  Berland (la puerta) queda encendido y aprobado» (línea 63) puede afirmar además que `codex mcp get chrome-personal`
  muestra el `startup_timeout_sec` entregado.
- Comando (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/plugins/adapters.test.ts"`
  (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/core/plugins/adapters.test.ts`). La en vivo:
  `/mnt/c/dev/orquestador/scripts/win.sh "set ORQ_LIVE=1&& npx vitest run tests/live/chrome-personal.live.test.ts"`.
- Verificación manual: con la máquina ocupada, despachar a Codex una tarea que abra una página con `chrome-personal`.
  En su salida no debe aparecer «MCP client for `chrome-personal` failed to start» ni «MCP client startup timed out»,
  y debe haber un `mcp_tool_call` de `chrome-personal` completado.
