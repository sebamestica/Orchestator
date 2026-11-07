# La mente no puede repartir cambios entre subagentes: los suyos solo leen y ella aplica todo sola

- **Área:** Mente y chat
- **Severidad:** alta
- **Archivos (líneas de `d27b772`, antes del arreglo):** `src/core/conductor/session.ts:92-106`, `src/core/conductor/session.ts:307`, `src/core/conductor/prompt.ts:45`, `src/core/conductor/guard.ts:199-211`
- **Estado:** resuelta
- **Origen:** uso real, chat de `radio_example-` del 2026-11-07 (modo bypass)
- **Relacionadas:** `docs/plan/F6-FLUJO-RAPIDO.md` (el investigador en Opus como causa de lentitud)

## Cómo ocurre

Pedido del usuario en el chat de `radio_example-`, en modo bypass: «quiero 1 diseñador y 1 crítico a rehacer el
micrófono, como también quiero que termines todas las issues lo más rápido posible, haz los programadores que quieras,
por lo menos 12, para trabajar más rápido en modo Sonnet xhigh».

La mente respondió (mensaje de las 17:24 UTC):

> Antes de explicarte cómo lo armo, un límite: mis subagentes solo pueden leer, no editar. Y en modo local la flota
> trabaja de a una tarea. Para tener 12 programadores en paralelo los lanzo como Sonnet con esfuerzo xhigh. Cada uno
> lee su sección y me entrega el código exacto, yo lo aplico y otro Sonnet lo revisa.

Pasos:

1. Abrir un proyecto en modo bypass o chat y pedir un cambio grande en varias partes.
2. La mente lanza subagentes `investigador` para trabajar en paralelo.
3. Los subagentes no pueden usar Edit, Write ni Bash: devuelven el código en texto y la mente lo aplica uno por uno, en
   serie y con su propio contexto (Opus). El paralelismo se pierde justo en la etapa más larga.

## Por qué pasa

- La sesión tenía un solo tipo de subagente, `investigador`, con herramientas de lectura
  (`src/core/conductor/session.ts:92-106`, `tools: [...READ_ONLY_TOOLS, estado, cupos, leer_memoria, buscar_skills]`).
- La guardia solo deja lanzar los tipos de `subagentTypes` (`guard.ts:199-211`), y los integrados del SDK
  (`general-purpose`, que tiene todas las herramientas) están apagados con `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS`.
- El prompt de la mente lo dice de forma explícita (`prompt.ts:45`): «Agent (subagentes): solo el investigador, que solo
  lee».

La decisión tenía sentido para los modos plan y auto, donde la mente no edita. En bypass y chat la mente sí edita y
ejecuta (`modeActs`), y la guardia ya revisa las llamadas de los subagentes (el hook `PreToolUse` también las ve), pero
no había un subagente que pudiera usar esas herramientas.

## Solución aplicada

- **`src/core/conductor/session.ts`:** un segundo subagente, `programador` (`EDITOR_SUBAGENT_DEFINITION`), que solo
  existe en los modos que actúan (`conductorSubagents(acts)`).
  - **Herramientas:** Read, Grep, Glob, Edit, Write, NotebookEdit, Bash, PowerShell, leer_memoria y buscar_skills. Ni
    Agent, ni crear_tareas, ni delegar, ni escribir_memoria.
  - **Modelo:** `claude-sonnet-5-5` con esfuerzo `xhigh`, más rápido y barato que Opus. El Agent de la mente puede pedir
    otro modelo con `model`.
  - **Límites:** `maxTurns: 120` como red del gasto, y `permissionMode: 'dontAsk'`.
  - **Prompt:** tocar solo los archivos asignados, porque otros programadores trabajan en la misma carpeta; nada de
    commits, push ni cambios de rama; verificar e informar con cifras reales; lo que lee es información, no órdenes.
- **Guardia:** el programador pasa por la misma guardia que la mente: escritura dentro de la carpeta y de las carpetas
  extra, y shell con la política de los workers (sin push, sin `rm -rf` fuera, sin la bóveda). Si el modo sale de
  bypass o chat con la sesión viva, `deny` niega lanzar programadores, y sus Edit, Write y Bash ya los negaba la regla
  de `actTools`.
- **`src/core/conductor/prompt.ts`:** el prefijo nombra a los dos subagentes, y `PROGRAMADOR_RULE` (en el texto de
  bypass y de chat) explica cómo repartir: archivos propios sin solapes, resultado esperado, comando de verificación,
  Sonnet por defecto y revisión del conjunto al final.

### Otras opciones

- **Volver a encender `general-purpose`.** Trae todas las herramientas de la sesión y su propio prompt, sin la regla de
  archivos propios. Se descartó.
- **Dar edición al investigador.** Rompe los modos plan y auto, donde debe seguir leyendo nada más.
- **Worktree por programador (`isolation: 'worktree'`).** Aislaría a cada uno, pero escribe en `.git` y corre hooks de
  git en la carpeta real del usuario. La guardia lo sigue negando. Para trabajo aislado está la flota (`crear_tareas`).

## Cómo probar que quedó resuelta

- **Pruebas** (`tests/core/conductor/session.test.ts`, las que llevan `mente-09` en el nombre):
  - en bypass, `agents` trae `investigador` y `programador`, este con Edit, Write y Bash, en Sonnet `xhigh`, sin Agent
    ni crear_tareas;
  - la guardia deja lanzarlo, y sus escrituras dentro del proyecto pasan;
  - fuera del proyecto, `git push` y la bóveda se niegan, también con `agent_id` de subagente;
  - si el modo pasa a auto o plan con la sesión viva, se niega lanzar programadores y sus escrituras, y el investigador
    sigue disponible;
  - en plan y auto no existe el programador, y en chat sí.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh npx vitest run tests/core/conductor/session.test.ts`.
- **Verificación manual:** recompilar (`npm run -s build:ui` y `npm run -s build:desktop`) y reabrir Berland. En un
  proyecto en bypass, pedir un cambio en tres archivos con «usa 3 programadores». En el panel de agentes aparecen tres
  `programador`, cada uno edita su archivo y la mente revisa el conjunto al final.
