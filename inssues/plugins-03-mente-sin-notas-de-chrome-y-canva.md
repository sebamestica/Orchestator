# La mente maneja tu Chrome personal y tu Canva sin las reglas que sí reciben los agentes de la flota

- **Área:** Plugins y navegador
- **Severidad:** media
- **Archivos:** `src/core/plugins/service.ts:272`, `src/core/plugins/service.ts:273`, `src/core/plugins/service.ts:319`, `src/core/plugins/service.ts:335`, `src/core/plugins/service.ts:342`, `src/core/plugins/chrome.ts:59`, `src/core/plugins/chrome.ts:107`, `src/core/plugins/mcp.ts:96`, `src/core/plugins/mcp.ts:102`, `src/core/adapters/claude-sdk/adapter.ts:164`, `src/core/adapters/claude-sdk/adapter.ts:379`, `src/core/adapters/codex-cli/index.ts:172`, `src/core/app/f5-chat.ts:77`, `src/core/chat/service.ts:706`, `src/core/chat/service.ts:732`, `src/core/conductor/session.ts:288`, `src/core/conductor/session.ts:342`, `src/core/conductor/prompt.ts:127`
- **Estado:** resuelta

## Cómo ocurre

Contexto: los plugins (Chrome personal por la puerta `chrome-gate.ts`, y Canva) llegan a cada agente de dos formas.
Una es la configuración del servidor MCP. La otra son reglas en texto: las notas del permiso (`McpGrant.notes`, por
ejemplo «esta sesión no tiene navegador») y las `instructions` de cada servidor. Para Chrome, esas `instructions` son
`CHROME_ONLY_NOTE`, `CHROME_TAB_NOTE` y `PERSONAL_NOTE`:

```ts
// src/core/plugins/chrome.ts:59-66 y 107
export const CHROME_TAB_NOTE = 'Abre tu propia pestaña con `new_page`, trabaja solo en ella y ciérrala con `close_page` al terminar. No cierres, recargues ni navegues pestañas que no abriste…';
const PERSONAL_NOTE = 'Entra solo a los sitios que pide la tarea, no escribas contraseñas ni datos de pago y no envíes formularios…';
export const NO_BROWSER_NOTE = 'Esta sesión no tiene navegador… No abras ninguno: ni el integrado de tu CLI, ni Playwright, ni otro Chrome.';
…
    instructions: `${CHROME_ONLY_NOTE} ${CHROME_TAB_NOTE} ${PERSONAL_NOTE}`,
```

La flota convierte todo eso en texto: `pluginsSection(grant)` (`src/core/plugins/mcp.ts:102`, que usa `mcpNotes` en
`mcp.ts:96`) arma la sección «## Plugins del orquestador» y el adaptador de Claude la agrega al prompt de sistema
(`src/core/adapters/claude-sdk/adapter.ts:379-381`, `systemPrompt.append: rules`). El de Codex hace lo mismo
(`src/core/adapters/codex-cli/index.ts:172`).

La mente no recibe nada de eso:

1. `mindPlugins` (`src/core/app/f5-chat.ts:71-87`) pide `comp.plugins.mcpServersFor(agentId, 'claude-sdk')`, y esa
   función devuelve solo los servidores y descarta las notas que arma `#collect`:
   ```ts
   // src/core/plugins/service.ts:272-273
   async mcpServersFor(agentId: string, kind: AgentKind, taskId?: string): Promise<McpServerMap> {
     return (await this.#collect(agentId, kind, taskId)).servers;
   ```
   Cuando Chrome no está conectado, `#collect` agrega `NO_BROWSER_NOTE` a `notes` (`service.ts:333-336`), y ahí se
   pierde. Si la sesión de Canva venció, el aviso «Canva no está disponible…» (`service.ts:346` y `350`) corre la misma
   suerte.
2. `claudeMcpOptions` (`adapter.ts:164-181`) copia `type`, `command`, `args`, `env`, `url` y `headers`, pero no
   `instructions`. Así se pierden también `CHROME_*_NOTE` y `CANVA_NOTE` (`service.ts:75`, asignada en `service.ts:342`).
3. `ChatService.#ensureSession` le pasa a `ConductorSession` solo `mcpServers: plugins` (`src/core/chat/service.ts:706`
   y `732`), sin `notes`. `ConductorSession` mete esos servidores en `allowedTools` como `mcp__chrome-personal__*` en
   todos los modos, también en plan (`src/core/conductor/session.ts:288-299`). El único texto variable de su prompt es
   `opts.notes`, las «Notas del usuario» (`session.ts:352`, `prompt.ts:127`), y el chat nunca lo llena. El prompt de la
   mente no dice nada de pestañas, contraseñas ni otros navegadores: solo «Codex CLI … navegador del usuario»
   (`prompt.ts:18`).
4. El servidor tampoco aporta reglas propias: la puerta deja pasar `initialize` sin cambios (`chrome-gate.ts:9`), y
   chrome-devtools-mcp 1.11.0 no declara `instructions` (en `build/src/*.js` no aparece esa clave).

Pasos para verlo:

1. Chrome está conectado en Plugins. Abres un chat en modo auto, bypass o chat y le pides a la mente «abre
   example.com y revisa X».
2. La mente tiene `mcp__chrome-personal__*`, pero ninguna regla de uso. chrome-devtools-mcp exige un `pageId` en las
   herramientas de página (lo explico abajo), así que la mente primero llama a `list_pages`. Esa lista trae tus
   pestañas y marca con ` [selected]` la que el servidor eligió al conectarse, que es la primera del navegador
   (`McpContext.js:451-459`, `McpResponse.js:698`). Como nada le dice «abre tu propia pestaña con `new_page`», puede
   hacer `navigate_page` o `reload` con el `pageId` de una pestaña tuya, y pierdes lo que tenías abierto.
3. Tampoco recibe «no escribas contraseñas ni datos de pago ni envíes formularios», y eso que es tu Chrome con tus
   sesiones abiertas. Le falta también «nunca abras otro navegador»: en bypass y chat tiene Bash y podría lanzar
   Playwright. Y cuando Chrome está apagado no recibe `NO_BROWSER_NOTE`, ni recibe `CANVA_NOTE` («no confirmes cambios
   ni borres diseños»).

Corrección al reporte original: dice que la mente podría llamar `navigate_page` **sin** `pageId` y actuar sobre la
pestaña seleccionada. En esta instalación no pasa así. `pageIdRouting` vale `true` por defecto
(`chrome-devtools-mcp/build/src/config/mcp-options.js:22-27`) y `chrome-personal.cmd` no lo desactiva. Con eso,
`pageId: zod.number()` es obligatorio (`tools/ToolDefinition.js:16` y `24-26`) y el esquema se valida en modo estricto
(`ToolHandler.js:210`). Una llamada sin `pageId` falla en la validación. El riesgo real es que la mente elija el
`pageId` de una pestaña tuya. Por lo mismo, la alternativa de «exigir `pageId` en las notas» no alcanza: ya se exige.

## Por qué pasa

Las reglas de los plugins viajan en `McpGrant.notes` y en `spec.instructions`, y solo las pasan a texto los adaptadores
de la flota (`pluginsSection`). La mente toma otro camino (`mcpServersFor` → `claudeMcpOptions` → `ChatService` →
`ConductorSession`) que conserva solo la configuración de los servidores: pierde las notas en `service.ts:273` y las
`instructions` en `adapter.ts:164-181`. El diseño del issue 11 (`docs/plan/issues/11-chrome-personal.md:69` y `80-84`)
decía que la mente y sus subagentes recibirían `chrome-personal` y que «la sesión» sin Chrome recibiría la nota sin
navegador, pero el commit `de896ce` solo conectó esas notas en los adaptadores de la flota.

## Solución posible

1. `src/core/plugins/service.ts`: agregar `async forMind(agentId: string): Promise<{ servers: McpServerMap; notes: string[] }>`,
   que devuelva lo que arma `#collect(agentId, 'claude-sdk')` sin perder `notes`. También sirve cambiar
   `mcpServersFor` para que devuelva las dos cosas.
2. `src/core/app/f5-chat.ts` (`mindPlugins`): con el mapa neutro, guardar en la caché
   `section: pluginsSection({ servers, notes })` junto a `mcpServers` y `env`, calculada **antes** de
   `claudeMcpOptions`, que descarta `instructions`. Exponerla con una función nueva del cableado, por ejemplo
   `mindPluginRules(agentId): string`.
3. `src/core/chat/service.ts`: recibir esa función en las dependencias (al lado de `mcpServersFor`, `service.ts:113-114`),
   pasarla a `ConductorSession` e incluir el texto en `keyOf` (`service.ts:665-675`). Así, conectar o desconectar
   Chrome (que cambia la nota) recrea la sesión, igual que pasa hoy cuando cambian los nombres de los servidores.
4. `src/core/conductor/session.ts`: nueva opción `pluginRules?: string` que se agrega como un elemento más de
   `systemPrompt` (`session.ts:342-356`), aparte de las «Notas del usuario» para no mezclar su origen. Debe aparecer
   también cuando no hay servidores pero sí notas (Chrome apagado → `NO_BROWSER_NOTE`, sobre todo en bypass y chat,
   donde la mente tiene Bash).

### Otras opciones

- **Que la puerta escriba las reglas en `initialize`.** `chrome-gate.ts` ya ve pasar `initialize`. Podría agregar
  `result.instructions` con `CHROME_ONLY_NOTE`, `CHROME_TAB_NOTE` y `PERSONAL_NOTE`, por ejemplo con un argumento
  `--instructions`. Claude Code muestra al modelo las instrucciones de cada servidor MCP («MCP Server Instructions»),
  así que llegarían a la mente sin tocar el chat. A cualquier cliente de la puerta también, aunque falta comprobar que
  lleguen a los subagentes y a Codex. No cubre `NO_BROWSER_NOTE` (sin Chrome no hay puerta) ni `CANVA_NOTE` (Canva es
  HTTP directo), así que habría que combinarla con la propuesta para esas dos.
- **Que `claudeMcpOptions` devuelva también `rules`** (el `pluginsSection` del mapa que recibe). Cualquier usuario de
  Claude tendría las reglas sin otra llamada, pero seguirían faltando las `notes`, que no están en el mapa.
- La propuesta no es la única ni la más corta. La opción más sólida probablemente combina las dos: la puerta lleva sus
  reglas en `initialize` (valen para cualquier cliente y para los subagentes) y la mente recibe las `notes` del permiso
  por su prompt.

## Cómo probar que quedó resuelta

- Pruebas automatizadas propuestas:
  - `tests/core/plugins/chrome.test.ts`: con Chrome conectado, `forMind('claude-main')` devuelve `chrome-personal`
    con `instructions` que contienen `CHROME_TAB_NOTE`. Con Chrome desconectado, devuelve `servers: {}` y
    `notes: [NO_BROWSER_NOTE]`.
  - `tests/core/chat/service.test.ts` (bloque «ChatService: plugins para la mente», hoy en la línea 558): `bench` con
    `mcpServersFor` que entrega `chrome-personal` y `mindPluginRules` que entrega
    `pluginsSection({ servers: { 'chrome-personal': chromeServerSpec(…) }, notes: [] })`. Tras un turno,
    `optionsOf(b).systemPrompt` unido contiene `CHROME_TAB_NOTE` y «no escribas contraseñas». Un segundo caso sin
    servidores y con `notes: [NO_BROWSER_NOTE]` afirma que el prompt contiene `NO_BROWSER_NOTE`. Un tercero afirma que
    cambiar el texto de las reglas recrea la sesión (cambia la clave de forma).
  - `tests/core/conductor/session.test.ts`: `ConductorSession` con `pluginRules: 'X'` entrega a la `query` falsa un
    `systemPrompt` que incluye `X`. Sin la opción, el prompt queda igual que hoy.
- Comando (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/plugins/chrome.test.ts tests/core/chat/service.test.ts tests/core/conductor/session.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/plugins/chrome.test.ts tests/core/chat/service.test.ts tests/core/conductor/session.test.ts`).
- Verificación manual en la app:
  - Con Chrome conectado, abre un chat nuevo y pregúntale a la mente «¿qué reglas tienes para usar el Chrome?». Debe
    nombrar `new_page`/`close_page`, «no escribas contraseñas» y «nunca abras otro navegador». Hoy no las conoce.
  - Desconecta Chrome, abre un chat en bypass y pídele abrir una página. Debe decir que no tiene navegador, sin
    intentar Playwright por Bash.
