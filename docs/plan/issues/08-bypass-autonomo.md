# Issue 8 — El modo bypass es autónomo de verdad

Estado: hecho, sin commit (A0 confirma a nombre del usuario) · Worktree `C:\dev\orquestador-wt\c26-bypass`, rama `flota/c26-bypass` (sale de `main` `d746f2f`)

## Lo que dijo el usuario
«El modo bypass no está funcionando: sigue generando planes y preguntando cosas. La idea es que si doy una idea, el
mismo agente de la cabeza busque la forma, por donde sea, de lograr la tarea que le estoy entregando.»

En una conversación real en bypass, la mente respondió «Yo no puedo escribir GUIONES.md ni renderizar; eso lo hace la
flota» y «No tengo ninguna herramienta para editar dependencias de tareas, así que no puedo quitarla». Además terminó
cada respuesta con una lista «Necesito de ti / Pendiente de ti».

## Objetivo
En bypass, la mente trabaja como un Claude Code autónomo que tiene la flota a mano:
1. hace las cosas ella misma cuando es más rápido que delegar;
2. no pregunta ni pide confirmación, salvo ante un bloqueo real;
3. no muestra planes al usuario;
4. persiste: si algo falla, prueba otra vía.

En los modos plan y auto no cambia nada.

## Diagnóstico (en `main` `d746f2f`)
- **Prompt fijo** (`src/core/conductor/prompt.ts`). El prefijo en caché le dice a la mente que no actúe ni en bypass:
  - `:13`: «Tú no editas código ni ejecutas comandos: delegas.»
  - `:53`: «En ningún modo editas archivos, ejecutas comandos…»
  - `:31` y `:59`: le pide mostrar las tareas al usuario («Muéstraselas al usuario resumidas», «Presenta las tareas»).
  - `:56`: «Si falta algo que cambie el plan, pregunta».
  - `:65`: el estilo pide terminar con «lo que necesitas del usuario». De ahí salen las listas «Necesito de ti».
- **Texto del modo** (`prompt.ts:140-144`). `MODE_TEXT.bypass` solo dice «como auto, más leer fuera de la carpeta».
  No le da autonomía ni le prohíbe preguntar.
- **Herramientas** (`src/core/conductor/session.ts`):
  - `:35-47`: `BLOCKED_TOOLS` siempre incluye Bash, PowerShell, Edit, Write y NotebookEdit.
  - `:256`: los builtins son siempre `READ_ONLY_TOOLS` más `Agent`.
  - `:312-314`: `tools` y `disallowedTools` no dependen del modo.
- **Guardia** (`src/core/conductor/guard.ts`):
  - `:96`: niega toda herramienta fuera de `allowedTools`.
  - `:44`: solo sabe validar rutas de lectura. No tiene regla de escritura ni de shell.
  - `:51`: el mensaje de negación dice «El orquestador no edita archivos ni ejecuta comandos».
- **Fuera de mis rutas:**
  - `src/core/conductor/tools.ts:420` (`nextStep`): tras aprobar en auto o bypass le dice «delégalas … e informa al usuario».
  - `tests/core/chat/service.test.ts:340-345` afirma que bypass «sigue sin edición ni ejecución».

## Diseño
### Herramientas y guardia (solo bypass, y solo con proyecto)
- `session.ts`:
  - `BYPASS_TOOLS = Edit, Write, NotebookEdit, Bash, PowerShell`.
  - Con `mode === 'bypass'` y proyecto, esas herramientas entran en `tools` y `allowedTools`, y salen de
    `disallowedTools`. El resto de `BLOCKED_TOOLS` sigue bloqueado (Monitor, worktrees, Workflow, Cron, RemoteTrigger).
  - El agente suelto no cambia: no tiene flota ni texto de modo, y queda para el issue 10.
- La guardia recibe dos opciones nuevas:
  - `writeRoots`: el proyecto y las carpetas extra del chat;
  - `shellRoot`: el proyecto.
- El hook y `canUseTool` pasan a una decisión asíncrona (`decide`). `check` sigue síncrono: decide igual que antes la
  lectura, los subagentes y MCP, y niega siempre edición y shell, que necesitan disco o la política de shell.
- **Edición** (Edit, Write, NotebookEdit):
  - la ruta debe quedar dentro de una raíz de escritura;
  - nunca en `denyPaths` (bóveda y base del núcleo) ni en archivos de credenciales;
  - la ruta real se comprueba con `writeProblem` de `shell-policy.ts`, que sigue junctions y enlaces y protege `.git`,
    `.claude/` y `.mcp.json`.
- **Shell** (Bash, PowerShell):
  - pasa por `shellCommandProblem` de `src/core/adapters/claude-sdk/shell-policy.ts`, la misma de los workers, con el
    proyecto como raíz y el `cwd` del hook como carpeta actual;
  - si esa carpeta sale del proyecto, se niega;
  - se niega también un comando que nombre una ruta de `denyPaths`.
  - Así siguen prohibidos el push, el despliegue, `rebase`, `reset --hard`, borrar ramas y escribir fuera del proyecto.
- **Cambio de modo a mitad de sesión.** Con subagentes vivos, la sesión no se recrea (issue 7). Por eso la guardia
  dinámica niega `BYPASS_TOOLS` en cuanto el modo deja de ser bypass.
- **Subagentes.** En bypass se niega `isolation: 'worktree'`: la escritura vale en la carpeta del proyecto, y un
  worktree caería en `.claude/`, que está protegida.
- **Entorno.** En bypass se agrega `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, para que Bash y los servidores MCP stdio no
  hereden `ANTHROPIC_API_KEY`. El proceso del SDK conserva la clave.

### Prompt
- **Prefijo.** Sigue idéntico en los tres modos. Solo cambian las frases que contradecían al bypass:
  - «Fuera del modo bypass no editas código ni ejecutas comandos: delegas.»
  - la sección «Modos»;
  - mostrar las tareas, preguntar, presentar y el estilo «lo que necesitas del usuario», que quedan sujetos al modo.
- **`MODE_TEXT.bypass`** (contexto dinámico):
  - autonomía: «hazlo tú mismo»;
  - herramientas y límites de escritura y shell;
  - «No preguntes ni pidas confirmación», salvo un bloqueo real;
  - plan interno sin mostrarlo;
  - nada de «Necesito de ti»;
  - persistir;
  - lectura fuera del proyecto;
  - en modo local, no editar mientras la flota trabaja en la carpeta;
  - prohibiciones de siempre.
- **`src/shared/api.ts`.** Cambia solo el comentario de `mindModeSchema`.

## Rutas propias
- `src/core/conductor/prompt.ts`, `src/core/conductor/session.ts`, `src/core/conductor/guard.ts`.
  `src/core/conductor/tools.ts` queda fuera.
- El comentario de `mindModeSchema` en `src/shared/api.ts`.
- `tests/core/conductor/**`.
- Este documento.

## Criterios de aceptación (Vitest)
1. En bypass, el SDK recibe Edit, Write, NotebookEdit, Bash y PowerShell en `tools` y `allowedTools`, y no en
   `disallowedTools`.
2. La guardia de bypass:
   - permite escribir dentro del proyecto y de las carpetas extra;
   - niega escribir fuera, en `denyPaths`, en `.git` y en archivos de credenciales;
   - niega `git push` y `rm -rf` fuera del proyecto;
   - permite `git status` y comandos normales dentro.
3. En plan y auto, esas herramientas siguen bloqueadas en las opciones y en la guardia. Si el modo sale de bypass a
   mitad de sesión, la guardia las niega.
4. El prefijo es idéntico byte a byte en los tres modos.
5. `MODE_TEXT.bypass` contiene «no preguntes» y la instrucción de hacerlo ella misma.
6. `npm run -s check` en verde, con cifras reales.

## Resultado
- **Pruebas nuevas:**
  - `tests/core/conductor/guard.test.ts`: 7, en disco real, con una junction que sale del proyecto;
  - `tests/core/conductor/session.test.ts`: 5, que cubren opciones del SDK, guardia, plan y auto, cambio de modo a
    mitad de sesión y agente suelto;
  - `tests/core/conductor/prompt.test.ts`: 2, sobre el prefijo idéntico en los tres modos y `MODE_TEXT.bypass`.
- **Fuera de mis rutas:** `tests/core/chat/service.test.ts:340-346`. Afirmaba que bypass seguía sin edición ni
  ejecución. Ahora afirma lo contrario, y que en auto siguen bloqueadas.
- **`scripts/win.sh npm run -s check`:** exit 0 (typecheck, lint, test, build:ui y build:desktop).
  - Archivos de prueba: 138 aprobados y 10 saltados, de 148.
  - Pruebas: 1740 aprobadas y 20 saltadas, de 1760.
- **Pendiente** (otro dueño): en `src/core/conductor/tools.ts:420`, `nextStep`. Tras aprobar en bypass, el texto
  debería decir «delégalas y sigue» sin «informa al usuario».

## Riesgos que quedan
- **Ejecución.** La política de shell no aísla el sistema operativo. Un script que la mente escriba en el proyecto
  (`node x.js`, `npm run x`) puede escribir fuera o leer cualquier archivo. Es el mismo riesgo residual de los workers.
- **Lectura por shell.** La lectura por shell no pasa por la guardia de Read. Solo se cortan las rutas obvias de la
  bóveda y de la base del núcleo, no rutas relativas ni variables. `.env` dentro del proyecto se puede leer con `cat`.
- **Red.** `curl` y `wget` se permiten; solo se vigila adónde escriben. La salida a la red no se controla.
- **`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`.** Quita credenciales por nombre o forma del valor. Si un plugin MCP stdio de la
  mente necesita un token con ese aspecto, en bypass podría quedarse sin él. No está probado en vivo.
- **Caché.** En bypass la lista de herramientas cambia, así que su caché de prompt es aparte de la de plan y auto. El
  prefijo de texto sí es idéntico.
