# La mente lanza los subagentes que trae el SDK (general-purpose, Plan, Explore, claude), no el `investigador` de Berland: reciben tu Chrome personal, Canva y las herramientas de la flota, sin las reglas de Berland

- **Área:** Mente y chat
- **Severidad:** media
- **Archivos:** `src/core/conductor/session.ts:75`, `src/core/conductor/session.ts:83`, `src/core/conductor/session.ts:266`, `src/core/conductor/session.ts:294`, `src/core/conductor/session.ts:360`, `src/core/conductor/session.ts:362`, `src/core/conductor/session.ts:364`, `src/core/conductor/session.ts:367`, `src/core/conductor/session.ts:521`, `src/core/conductor/guard.ts:19`, `src/core/conductor/guard.ts:73`, `src/core/conductor/guard.ts:78`, `src/core/conductor/guard.ts:175`, `src/core/conductor/guard.ts:180`, `src/core/conductor/guard.ts:184`, `src/core/conductor/prompt.ts:42`, `src/core/chat/service.ts:708`, `src/core/adapters/claude-sdk/permissions.ts:93`, `src/core/adapters/claude-sdk/translate.ts:83`, `tests/core/conductor/guard.test.ts:16`, `tests/core/conductor/guard.test.ts:230`, `tests/core/conductor/session.test.ts:157`, `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:44`, `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:185`, `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:784`, `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:806`, `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` (CLI 2.1.302: agentes integrados y `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS`)
- **Estado:** abierta
- **Origen:** autoevaluación de la mente (2026-11-05), afirmación 8 («subagentes con permisos amplios: general-purpose y claude tienen todas las herramientas»)
- **Relacionadas:** `mente-01` (un `general-purpose` también puede leer por `file://`), `plugins-03` (las reglas de Chrome y Canva no llegan a la mente; si se ponen en su prompt de sistema, tampoco llegan a estos subagentes), `autoeval-navegador-02` (Chrome y Canva actúan en modo plan), `autoeval-trabajo-03` (los pasos de los subagentes no se ven en el chat), `autoeval-gasto-01` (gasto de los subagentes), `mente-06` y `uso-real-06` (ciclo de vida de estos mismos subagentes; otro problema)

## Cómo ocurre

**Contexto.** Berland define un solo subagente para la mente: `investigador`, que «solo lee» y tiene una lista cerrada de
herramientas (`session.ts:75-87`):

```ts
// session.ts:83
tools: [...READ_ONLY_TOOLS, mcpToolName('estado'), mcpToolName('cupos'), mcpToolName('leer_memoria'), mcpToolName('buscar_skills')],
```

La sesión lo pasa con `agents: { ...CONDUCTOR_SUBAGENTS }` (`session.ts:367`) y el prompt le dice a la mente:
«Los subagentes tienen tus mismos límites (el investigador solo lee); dales un encargo acotado» (`prompt.ts:42`).

El SDK no reemplaza sus agentes integrados por los de `agents`: los suma. En el CLI 2.1.302 la lista integrada
(`OHe()`) siempre trae `general-purpose` con `tools:["*"]`, y según la sesión también `claude` (`tools:["*"]`),
`Explore`, `Plan` y `statusline-setup`. Después se suman los de `agents`. Solo la vacía la variable
`CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` en una sesión no interactiva (`pTe()` devuelve `"none"`). Berland no la pone
(`buildEnv`, `session.ts:521-532`). La descripción de la herramienta Agent dice además que, **sin `subagent_type`,
arranca un `general-purpose`**. Un agente sin `tools` hereda todas las herramientas de la sesión (`sdk.d.ts:44`).

La guardia no mira qué tipo de subagente se pide. Para `Agent`/`Task` solo revisa `mode` e `isolation`
(`guard.ts:175-183`) y luego `return { allow: true }` (`guard.ts:184`). Además, el SDK ignora `mode`
(«Deprecated; ignored», `sdk-tools.d.ts:806`). La palanca real es `subagent_type` (`sdk-tools.d.ts:784`), y esa no se
revisa.

**Pasos.**

1. Chrome y Canva conectados. Chat de un proyecto en modo `plan` o `auto`.
2. La mente llama `Agent { description, prompt }` sin `subagent_type`, o con `general-purpose`, `Plan`, `Explore` o
   `claude` (y `fork`, si el CLI lo ofrece en esa sesión: depende de un indicador interno y no aparece en las
   transcripciones).
3. La guardia aprueba. El subagente recibe todas las herramientas de la sesión: Read, Grep, Glob, Agent (puede lanzar
   otros subagentes), las 32 de `chrome-personal` (incluidas `evaluate_script`, `fill_form` y `upload_file`), las 46 de
   `canva` y las de la flota (`crear_tareas`, `delegar`, `escribir_memoria`). Su prompt de sistema es el de Claude Code
   («You are an agent for Claude Code…»), sin las reglas de Berland: ni «sin push», ni «sin secretos», ni las notas de
   Chrome.
4. Si una página que el subagente está leyendo trae instrucciones escondidas, ese subagente puede usar el Chrome
   personal con tus sesiones, editar en Canva o, en `auto`, crear tareas que se aprueban solas. La mente solo ve su
   informe final.

**Evidencia.**

- **Lo que ve la mente.** En la Conversación del 2026-11-05 donde la mente hizo su autoevaluación
  (`%USERPROFILE%\.claude\projects\C--Users-SEBASTIAN-AppData-Local-berland-conversaciones-05d4169d-…\1a9ddd83-….jsonl`),
  el adjunto `agent_listing_delta` lista `claude`, `Explore`, `general-purpose`, `investigador`, `Plan` y
  `statusline-setup`, con `builtInTypes` = los cinco que no son de Berland. El mensaje de sistema muestra
  «- general-purpose: … (Tools: \*)» y «- claude: … (Tools: \*)». De ahí salió la afirmación 8, no de la
  configuración global del usuario.
- **Lo que usa la mente.** Hay 22 subagentes de la mente en las transcripciones locales (`…\subagents\*.meta.json` de
  las sesiones cuyo prompt empieza con «Eres el orquestador»). Solo 3 son `investigador`. Los otros: 8
  `general-purpose`, 7 `Explore`, 3 `Plan` y 1 `claude`.
  - Chat de `marketing`, 2026-11-05 01:22:38Z, modo sin edición (herramientas de la sesión: Agent, Glob, Grep, Read,
    `canva`, `chrome-personal`, `orquestador`). La mente lanzó tres `general-purpose` en paralelo sobre Instagram con el
    Chrome personal. Usaron `evaluate_script` 12, 18 y 19 veces, más `navigate_page` y `take_screenshot`. Las reglas
    («SOLO LECTURA», «PROHIBIDO iniciar sesión, dar like…») las escribió la mente en el encargo. Ninguna barrera las
    sostenía.
  - Chat de `radio-example`, 2026-11-05 00:54Z: un `Plan`, el agente «arquitecto de planes», usó
    `mcp__chrome-personal__evaluate_script` 17 veces y `emulate` 4 veces.
  - Un `general-purpose` del chat de `orquestador` (2026-11-05 00:41Z) lanzó 6 subagentes anidados (`spawnDepth: 2`):
    4 `Explore`, 1 `claude` y 1 `general-purpose`.
- **Los planes de Berland asumen otra cosa.** `docs/plan/issues/07-agentes-en-segundo-plano.md:9` habla de «4
  investigadores» a las 00:20:41 del chat de `marketing`. Según su `.meta.json` eran 3 `general-purpose` y 1 `Explore`.
  La idea de un «investigador con modelo barato» (`docs/plan/issues/06-razonamiento-modelos.md:222`) no rige si la
  mente no usa el `investigador`.
- **Lo que sí funciona.** No hay escalada por encima de la mente:
  - En `plan` y `auto`, `tools: builtins` (`session.ts:294`, `:360`) no incluye Bash, Edit ni Write, y
    `disallowedTools` los vuelve a quitar (`session.ts:362`). Las herramientas registradas en esas sesiones lo
    confirman: ningún subagente tuvo Bash, Edit ni Write.
  - En `bypass` y `chat` sí los tienen, igual que la mente.
  - El hook de la guardia sí ve las llamadas de los subagentes (`sdk.d.ts:185`: `agent_id` «Present only when the hook
    fires from within a subagent»). Hay rechazos reales dentro de transcripciones de subagentes, por ejemplo un `Plan`
    de `radio-example`: «PreToolUse:Grep hook error: Grep: solo puedes leer dentro del proyecto…».
  - El hueco es de mínimo privilegio y de reglas, no de permisos.
- **Hueco menor en el mismo bloque.** Fuera de `bypass` y `chat` la guardia deja pedir `isolation: 'worktree'`
  (`guard.ts:180`), y la prueba lo da por bueno (`guard.test.ts:230-235`). El CLI crea entonces un worktree de git
  (`git worktree add`) en `<proyecto>/.claude/worktrees/` con su rama. Así, en modo plan, la mente escribe en `.git` y
  en el proyecto sin Edit ni Bash. Si el repo tiene un hook `post-checkout` (husky, por ejemplo), lo ejecuta. Lo del
  hook no lo comprobé en vivo. La flota ya niega cualquier `isolation` (`permissions.ts:93`).
- **Pruebas.** Ninguna lo cubre. `guard.test.ts:16` acepta `Agent` sin `subagent_type`.
  `tests/core/conductor/session.test.ts:157-165` solo mira la definición de `investigador`, no qué otros tipos quedan
  disponibles.
- **El propio Berland ya lo da por hecho en otro lado.** `src/core/adapters/claude-sdk/translate.ts:83` rotula una
  llamada `Agent` sin `subagent_type` como `general-purpose` (`str(i.subagent_type) ?? 'general-purpose'`).
- **Comprobado en el binario 2.1.302** (`claude.exe`): `pTe()` devuelve `"none"` solo con
  `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` y `we()` (`!isInteractive()`), y entonces `OHe()` devuelve `[]`. La
  descripción de Agent dice «If omitted, the general-purpose agent is used». Con la variable puesta, el CLI exige el
  tipo: «subagent_type is required: the general-purpose agent is not available in this session».

## Por qué pasa

Berland asumió que `agents: { investigador }` fija el conjunto de subagentes, y que la guardia frena lo peligroso al
revisar `mode`. Ninguna de las dos cosas es así en el SDK 0.3.302 / CLI 2.1.302. Los agentes integrados siguen
disponibles y uno de ellos es el tipo por defecto. Cada uno trae su propio prompt de sistema. `mode` no se usa, y
`subagent_type`, que es lo que de verdad elige las herramientas y el prompt, pasa sin revisar. Por eso la «lista
cerrada» de `investigador` (`session.ts:83`) protege solo cuando la mente lo elige. Y las reglas que viven en el prompt
de la mente (`prompt.ts:27-28`, y las de Chrome si se arregla `plugins-03` por esa vía) no llegan a los subagentes.

## Solución posible

1. **`src/core/conductor/guard.ts`.** Nueva opción `subagentTypes?: readonly string[]`. En la rama de `SUBAGENT_TOOLS`
   de `precheck` (`guard.ts:175`), si la opción viene, exigir `typeof args.subagent_type === 'string'` y que esté en
   la lista. Si no, negar con un motivo que diga qué tipos hay: «Solo puedes lanzar estos subagentes: investigador.
   Indica subagent_type». Así quedan fuera `general-purpose` (también por omisión), `claude`, `Explore`, `Plan`,
   `statusline-setup` y `fork`. De paso, negar `isolation: 'worktree'` en todos los modos, como la flota
   (`permissions.ts:93`), y quitar o comentar la comprobación de `mode`, que el SDK ignora.
2. **`src/core/conductor/session.ts`.**
   - Pasar `subagentTypes: Object.keys(agents)` a `createToolGuard` (`session.ts:307`), con el mismo objeto que va en
     `agents` (`session.ts:367`).
   - Agregar `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1'` al entorno de la sesión (`session.ts:266-271`). Así la mente
     ya no ve los cinco tipos integrados en su lista, y se ahorran rechazos y tokens. La variable no figura en
     `sdk.d.ts`: la verifiqué en el binario 2.1.302. Por eso la barrera es la guardia, que no depende de la versión.
3. **Si se quiere mantener la investigación web con subagentes** (el uso real de `marketing` y `radio-example`): agregar
   a `CONDUCTOR_SUBAGENTS` un `navegador`, solo cuando `chrome-personal` esté entre los plugins de la sesión. Sin `tools`
   (hereda) y con `disallowedTools: ['mcp__canva', 'Agent', ...BYPASS_TOOLS, mcpToolName('crear_tareas'),
   mcpToolName('delegar'), mcpToolName('escribir_memoria')]`. `sdk.d.ts:47-50` acepta `mcp__<servidor>` para quitar un
   servidor entero. Su `prompt` lleva «solo lectura», `CHROME_TAB_NOTE` y la nota personal de `src/core/plugins/chrome.ts`
   (coordinar con `plugins-03`).
4. **`src/core/conductor/prompt.ts:42`.** Decir la verdad: «Agent (subagentes): solo `investigador` (y `navegador`, si
   hay Chrome). Indica siempre `subagent_type`; otros tipos se niegan». Cambia el prefijo en caché una vez. Hay que
   hacerlo a propósito (`prompt.ts:4-7`).

### Otras opciones

- **Solo la variable de entorno.** Es una línea, pero depende de una variable no documentada: si el SDK la cambia, los
  integrados vuelven sin aviso. Tampoco está claro que frene `fork` (que hereda todo el contexto y las herramientas
  de la mente), porque `fork` se habilita aparte de `OHe()`.
- **Solo la guardia.** La barrera queda, pero la mente sigue viendo seis tipos y va a intentar los integrados. Gasta
  turnos en rechazos.
- **Redefinir los integrados con el mismo nombre.** El CLI fusiona los agentes por `agentType` y el de `agents` pisa al
  integrado. Una definición propia de `general-purpose` con las herramientas de `investigador` hace que la llamada por
  omisión caiga en algo acotado. Falta comprobar en vivo el orden de esa fusión.
- **Filtrar por `agent_type` en el hook.** `input.agent_type` llega en cada llamada de un subagente
  (`sdk.d.ts:189-191`). La guardia podría negar Chrome, Canva y la flota a todo tipo que no sea `navegador`. Es más
  flexible, pero no saca a los integrados de la lista ni les da las reglas.
- **`appendSubagentSystemPrompt`.** `sdk.mjs` lo reenvía al CLI (`initConfig`), pero `sdk.d.ts` no lo declara. Serviría
  para que todos los subagentes reciban las reglas de Berland. Como no está documentado, es solo un complemento.

La propuesta no es la única y puede haber una mejor. Basta con que pasen las pruebas de abajo.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta** en `tests/core/conductor/guard.test.ts`, nuevo
  `it('solo deja lanzar los subagentes de Berland')`:
  - Arma `createToolGuard({ allowedTools, cwd: 'C:\\dev\\demo', pathApi: path.win32, subagentTypes: ['investigador'] })`.
  - Afirma que `check('Agent', { description: 'x', prompt: 'y', subagent_type: 'investigador' })` da `allow: true`.
  - Afirma que `general-purpose`, `claude`, `Explore`, `Plan`, `statusline-setup` y `fork` dan `allow: false`, con un
    motivo que nombra `investigador`.
  - Afirma que `Agent` sin `subagent_type` se niega, y que `Task` con `subagent_type: 'general-purpose'` también.
  - Cambia la prueba de `guard.test.ts:230-235`: `readOnly.check('Agent', { …, isolation: 'worktree' }).allow` pasa a
    `false`.
- En `tests/core/conductor/session.test.ts`, nuevo `it('solo el investigador como subagente')`:
  - `optionsOf(q).env?.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` vale `'1'`.
  - `Object.keys(optionsOf(q).agents ?? {})` es `['investigador']`.
  - El hook de `optionsOf(q).hooks.PreToolUse[0].hooks[0]`, con
    `{ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'x', prompt: 'y', subagent_type: 'general-purpose' }, … }`,
    devuelve `permissionDecision: 'deny'`. Lo mismo con `agent_id: 'a1', agent_type: 'investigador'` (un subagente que
    intenta lanzar otro).
  - Con `subagent_type: 'investigador'` devuelve `{}`.
  - Si se agrega `navegador`: con `mcpServers: { 'chrome-personal': … }`, `agents.navegador.disallowedTools` contiene
    `'mcp__canva'` y `mcp__orquestador__crear_tareas`. Sin Chrome, `navegador` no está.
- **Comando** (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/conductor/guard.test.ts tests/core/conductor/session.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`:
  `npx vitest run tests/core/conductor/guard.test.ts tests/core/conductor/session.test.ts`).
- **Prueba en vivo opcional** (gasta saldo) en `tests/live/conductor.live.test.ts`: afirmar que el primer mensaje
  `system`/`init` trae `agents` igual a `['investigador']` (`SDKSystemMessage.agents`). Desde WSL:
  `WSLENV=ANTHROPIC_API_KEY/w:ANTHROPIC_BASE_URL/w /mnt/c/dev/orquestador/scripts/win.sh "set ORQ_LIVE=1&& npx vitest run tests/live/conductor.live.test.ts"`.
- **Verificación manual en la app:**
  - Con Chrome conectado, abrir un chat en modo plan y pedir «lanza un subagente general-purpose que abra
    https://example.com en mi Chrome». La llamada debe volver negada con el motivo de la guardia.
  - Pedir «usa un investigador para contar los archivos de src/core/chat» debe seguir funcionando.
  - En `%USERPROFILE%\.claude\projects\<carpeta del chat>\<sesión>\subagents\`, los `.meta.json` nuevos solo deben
    decir `"agentType":"investigador"` (o `navegador`).
