# Los workers Claude tienen tu clave de API (y el token de Canva) en el entorno de Bash y PowerShell, y Berland confirma a tu nombre lo que escriban sin buscar secretos

- **Área:** Adaptadores de agentes
- **Severidad:** media
- **Archivos:** `src/core/conductor/prompt.ts:28`, `src/core/app/adapters.ts:60-65`, `src/core/app/env.ts:23-27`, `src/core/adapters/claude-sdk/adapter.ts:224-233`, `src/core/adapters/claude-sdk/adapter.ts:306-307`, `src/core/adapters/claude-sdk/adapter.ts:382-405`, `src/core/adapters/claude-sdk/translate.ts:185`, `src/core/plugins/service.ts:54-57`, `src/core/conductor/session.ts:70-73`, `src/core/conductor/session.ts:270`, `src/core/app/commit-step.ts:101-123`, `src/core/app/commit-step.ts:208-220`, `src/core/adapters/claude-sdk/shell-policy.ts:490-491`, `src/shared/redact.ts:6-25`, `tests/core/adapters/claude-sdk/adapter.test.ts:53-72`, `docs/plan/issues/08-bypass-autonomo.md:131-132`
- **Estado:** resuelta
- **Origen:** autoevaluación de la mente (2026-11-05)
- **Relacionadas:** `codex-04-secretos-mcp-mente-sin-tachado-por-valor.md` (tachado por valor de los tokens MCP de la mente), `servidor-05-tachado-falso-positivo-palabras-pegadas.md` (falsos positivos del patrón genérico), `autoeval-gasto-04-bajar-y-ejecutar-desde-internet.md`

## Cómo ocurre

**Contexto.** «Ninguna clave en tareas, memoria, mensajes ni respuestas» (`prompt.ts:28`) se cumple con un tachado
técnico en todo lo que **sale** de Berland: los eventos del worker pasan por `redactSecrets(text, secrets)`
(`translate.ts:185`), con la clave en uso y los secretos MCP (`adapter.ts:307`) más los patrones de `redact.ts:6-14`.
Ese tachado no cubre lo que el agente **escribe en archivos**, y el entorno del worker deja la clave al alcance de sus
comandos.

**El entorno.** El worker Claude parte del entorno del anfitrión sin credenciales y le suma la clave de la bóveda
(`adapters.ts:65`: `baseEnv: { ...withoutHostCredentials(hostEnv()), ...keyEnv }`, con `keyEnv = { ANTHROPIC_API_KEY }`
de `env.ts:23-27`; el supervisor la vuelve a poner en `ctx.env`). `buildEnv` lo copia entero
(`adapter.ts:224-233`), y a eso se suman los secretos de los plugins (`adapter.ts:306`:
`{ ...this.buildEnv(ctx.env), ...plugins.env }`). Canva se entrega a `claude-sdk`
(`service.ts:54-57`), así que el token viaja como `ORQ_MCP_CANVA_AUTHORIZATION`. Claude Code necesita la clave en su
propio proceso, pero por defecto la pasa también a los procesos de Bash y PowerShell.

La mente lo resuelve en bypass y chat con `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'` (`session.ts:70-73`, aplicado en
`:270`), que según el propio comentario quita `ANTHROPIC_API_KEY` y otras credenciales del entorno de sus subprocesos.
En el `claude.exe` del SDK 0.3.302 la lista incluye `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` y
`CLAUDE_CODE_OAUTH_TOKEN`. Las opciones del worker (`adapter.ts:382-405`) no la ponen.

**Pasos.**

1. Un proyecto que usa la API de Anthropic (una app con el SDK, pruebas que graban respuestas HTTP). La flota le da una
   tarea a Claude.
2. El worker corre `npm test` desde su Bash. Las pruebas ven `process.env.ANTHROPIC_API_KEY` (tu clave de Berland) y
   llaman a la API real, que cobra en tu cuenta. O graban un fixture (`tests/fixtures/*.json`) con el encabezado
   `x-api-key: sk-ant-…`.
3. También pasa sin pruebas: `printenv` o `Get-ChildItem env:` para «depurar la configuración», o un script bajado
   de internet (ver `autoeval-gasto-04`). La salida que ve la interfaz sale tachada (`translate.ts:185`), pero el modelo
   ya tiene el valor en su contexto y puede escribirlo en un archivo.
4. El archivo cae dentro de las rutas propias. Antes de la revisión, `reviewSummary` llama a `prepare` →
   `commitTaskWork` (`commit-step.ts:211`, `:198`), que hace `git add -A` y `git commit` a tu nombre
   (`commit-step.ts:101-123`). Solo tacha el **mensaje** del commit (`:115`), no el contenido. El worker también puede
   confirmarlo él mismo: `commit` está en `GIT_ALLOWED` (`shell-policy.ts:490-491`). El revisor es otro modelo y recibe
   solo `git diff --stat` y `git log --oneline` (`commit-step.ts:218-220`): si no abre el archivo, no ve el secreto.
   Aunque lo rechace, el commit ya está en la rama de la tarea. Si lo aprueba, `integrate` lo lleva a `orq/integracion`.
   Basta un push posterior del usuario para publicarlo.

## Por qué pasa

Hay dos huecos que se suman:

- El worker no aísla la clave de sus subprocesos, aunque la mente sí lo hace con una sola variable.
- El tachado vive en las salidas de Berland (eventos, almacén, `/ws`, registros), no en el paso que confirma archivos.
  Por eso un secreto que el agente escribe en disco entra a la historia de git sin ningún control determinista. La
  única barrera es que el revisor lo note, y su resumen no trae el contenido. Este paso es común a todos los agentes
  (Claude, Codex y agy), así que el hueco del commit no es solo de Claude.

## Solución posible

1. **`src/core/adapters/claude-sdk/adapter.ts`, en `#run`:** agregar `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'` al `env`
   del worker, igual que `BYPASS_ENV` de la mente (conviene exportar una sola constante desde un módulo común). Con eso
   Bash y PowerShell ya no reciben `ANTHROPIC_API_KEY`.
2. **`src/core/app/commit-step.ts`, en `commitTaskWork`:** antes de `git add`, revisar el contenido nuevo contra los
   secretos. Hay que mirar lo pendiente (`git diff -U0 HEAD` más los archivos sin seguimiento que se van a agregar) y
   también lo que el worker ya confirmó por su cuenta (`git log -p <base>..HEAD`). Si solo se mira `git diff <base>`, un
   secreto agregado en un commit y borrado en el siguiente sigue en la historia y no se ve. Todo con un tope de tamaño.
   Se compara con:
   - los valores exactos que Berland conoce (claves de la bóveda cargadas en `AgentEnvironment`, tokens de plugins); y
   - los patrones con prefijo de `redact.ts:7-12` (`sk-ant-`, `sk-`, `AIza`, `gh?_`, JWT). El patrón genérico de la
     línea 13 tiene falsos positivos (`servidor-05`) y no conviene usarlo para bloquear.

   Si aparece alguno, lanzar un `SecretInWorkError` (como `OwnedPathsError`) que nombre el archivo **sin el valor**.
   `reviewSummary` hoy solo atrapa `OwnedPathsError` (`commit-step.ts:212-214`) y relanza el resto, así que hay que
   atrapar también el error nuevo y devolver el mismo «ATENCIÓN: … Rechaza la tarea». Así el revisor rechaza e
   `integrate` no confirma ni integra nada. Si el secreto ya venía en un commit del propio worker, la rama de la tarea
   lo conserva: el aviso debe pedir rehacer la rama, no solo borrar el archivo.
3. En modo local no hay commit, pero el mismo examen sobre los archivos cambiados puede ir en `#localSummary`
   (`commit-step.ts:243-270`) como aviso.

### Otras opciones

- **Una herramienta externa** (`gitleaks`, `trufflehog`) como paso del gate. Detecta más formatos, pero es una
  dependencia más en Windows y no conoce los valores de la bóveda.
- **Quitar también `ORQ_MCP_*` del entorno de los subprocesos.** En el `claude.exe` 0.3.302, el scrub quita nombres de
  una lista fija y nombres con forma de credencial (`…_TOKEN`, `…_KEY`, `…_SECRET`, `…_AUTH` al final o seguido de
  `_`). `ORQ_MCP_CANVA_AUTHORIZATION` no tiene esa forma. No está comprobado si lo quita por la forma del valor
  (`Bearer …`). Además, Claude Code necesita la variable para expandir `${VAR}` en `--mcp-config`. Habría que pasar el token de otra forma
  (por ejemplo, un servidor MCP local de Berland que agregue el encabezado), lo que es más trabajo. Mientras tanto queda
  como riesgo residual, igual que la nota de `08-bypass-autonomo.md:131-132` sobre el scrub y los plugins.
- **Solo el punto 1.** Es una línea y corta el caso más probable, pero no cubre secretos que el agente lea de otro lado
  (un `.env` del proyecto con `cat`, que el issue 08 acepta como riesgo) y luego escriba en un archivo.

La propuesta no es la única ni tiene por qué ser la mejor. Si se elige otra, basta con que pasen las pruebas de abajo.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:**
  - `tests/core/adapters/claude-sdk/adapter.test.ts`: con el `query` falso que guarda `options`, afirmar
    `options.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB === '1'` en autor y en revisión, y que `ANTHROPIC_API_KEY` sigue en
    `options.env` (el proceso de Claude Code la necesita). La prueba `env: hereda el entorno base…`
    (`adapter.test.ts:53-72`) compara el entorno entero con `toEqual` (`:62-67`): hay que agregarle la variable.
  - `tests/integration/commit-step.test.ts`: en un repo real con worktree, escribir dentro de las rutas propias un
    archivo con `sk-ant-` seguido de 40 caracteres y llamar a `commitTaskWork`. Afirmar que lanza `SecretInWorkError`,
    que el mensaje nombra el archivo y no contiene el valor, y que `git log` no tiene commit nuevo. Repetir con un valor
    opaco sin prefijo pasado como secreto conocido. Otro caso: el secreto entra en un commit hecho a mano en el
    worktree y se borra en un segundo commit; `commitTaskWork` también debe lanzar. Con `CommittingWorkspaces`,
    `reviewSummary` debe devolver un texto que empiece con `ATENCIÓN:`, sin rechazar la promesa. Caso de control: un
    archivo con `authorization-service` no debe bloquear.
- **Comando (desde WSL):**
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/adapters/claude-sdk/adapter.test.ts tests/integration/commit-step.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`:
  `npx vitest run tests/core/adapters/claude-sdk/adapter.test.ts tests/integration/commit-step.test.ts`).
- **Verificación manual en la app:** en un proyecto de prueba, lanza una tarea con Claude (ruta propia `notas/**`) cuyo
  encargo diga «crea `notas/ver.js` con `console.log(process.env.ANTHROPIC_API_KEY ? 'hay clave' : 'sin clave')`,
  ejecútalo con `node notas/ver.js` y escribe la salida en `notas/entorno.txt`». No uses `node -p`, porque la política
  lo niega. El archivo debe decir «sin clave», y la tarea debe haber editado sin pedir permisos (el scrub no debe
  cambiar el modo de permisos del worker). Después, pide escribir en ese archivo una cadena con forma `sk-ant-…`
  inventada, sin pedir que haga commit: la tarea debe volver al autor con el aviso de secreto y sin commit en su rama.
