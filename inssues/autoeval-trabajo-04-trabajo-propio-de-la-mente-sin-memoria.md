# Lo que la mente cambia ella misma en modo bypass o chat no queda en la memoria del proyecto: la flota y los chats siguientes no saben qué tocó ni por qué

- **Área:** Mente y chat
- **Severidad:** media
- **Archivos:** `src/core/chat/service.ts:134-139`, `src/core/chat/service.ts:814-836`, `src/core/chat/service.ts:838-862`, `src/core/orchestrator/fleet.ts:353`, `src/core/orchestrator/fleet.ts:698`, `src/core/orchestrator/fleet.ts:706-749`, `src/core/conductor/ports.ts:110-115`, `src/core/conductor/prompt.ts:54`, `src/core/conductor/prompt.ts:56-63`, `src/core/conductor/prompt.ts:144-152`, `src/core/conductor/prompt.ts:154-162`, `src/core/adapters/claude-sdk/translate.ts:122`, `src/core/adapters/claude-sdk/translate.ts:468-475`, `src/core/workspace/manager.ts:123-126`, `src/shared/contracts.ts:47-63`
- **Estado:** resuelta
- **Origen:** autoevaluación de la mente (2026-11-05), afirmación 1 («entre sesiones solo recuerda lo guardado en la memoria del proyecto»)
- **Relacionadas:** `autoeval-trabajo-01` (las decisiones guardadas tampoco se leen), `datos-03` y `datos-05` (`recordSession` y `buildContext`)

## Cómo ocurre

**Contexto.** La memoria de un proyecto se llena sola solo con el trabajo de la flota. Al cerrar cada tarea,
`#recordSessions` escribe una nota por turno de autor en `Sesiones/`, con los archivos cambiados y el resumen
(`fleet.ts:353` y `:706-749`). `buildContext`, lo que lee `leer_memoria` y lo que la flota recibe en cada encargo
(`fleet.ts:698`), se arma con esas notas.

Desde los issues 8 y 10, la mente también trabaja sola. En `bypass` con proyecto y en `chat` edita, crea archivos y
corre comandos en la carpeta del proyecto (`prompt.ts:144-152` y `:154-162`), y por regla no hace commits («Tus cambios
quedan en la carpeta tal cual: no cambies de rama ni hagas commits», `prompt.ts:151` y `:160`). Ese trabajo no se
anota en ninguna parte de la memoria:

- `ChatService` guarda el texto de la respuesta en SQLite (`#finishTurn`, `service.ts:838-862`) y los eventos en el hub
  (`#emit`, `service.ts:814-836`). No llama a la memoria.
- El puerto de memoria de la mente ni siquiera tiene `recordSession`: solo `buildContext`, `recordDecision` y
  `writeProjectSummary` (`ports.ts:110-115`).
- Lo único que queda es `escribir_memoria`, si la mente decide usarla. En `bypass` la «Forma de trabajar» lo pide
  («Registra en memoria las decisiones importantes», `prompt.ts:63`). En `chat` el prompt dice lo contrario: «En chat
  no orquestas…, y la forma de trabajar de abajo no aplica» (`prompt.ts:54`), y `MODE_TEXT.chat` no menciona la
  memoria. Así, en `chat` nada le pide leerla ni escribirla.

Berland sí sabe buena parte de lo que cambió la mente: el traductor emite un `file_change` por cada Write, Edit,
MultiEdit o NotebookEdit confirmado (`FILE_TOOLS`, `translate.ts:122`, y `:468-475`), con la ruta relativa al
proyecto. Esto vale también para sus subagentes (`general-purpose` incluido), que llegan con `parentSessionId`. Lo que
cambia por Bash o PowerShell (`sed -i`, `npm install`, `git mv`, scripts) no emite ningún `file_change`.

**Pasos.**

1. En un chat del proyecto P, en modo `chat`, el usuario pide «renombra `formatDate` a `formatearFecha` en todo
   `src/`». La mente edita 12 archivos con Edit y responde. No hay commit.
2. Más tarde se delega a la flota una tarea de P que toca esas rutas. Su `BRIEF.md` trae el contexto de memoria
   (`fleet.ts:698`). No dice nada del cambio de nombre: solo trae las sesiones de otros agentes. En modo local el
   agente encuentra los archivos ya cambiados sin saber por qué. En modo worktrees es peor: el worktree sale de la rama
   de integración (`workspace/manager.ts:123-126`), así que el cambio sin commit ni siquiera está en su copia, y nada se
   lo advierte. Al integrar puede chocar con lo que la mente dejó en la carpeta.
3. Un chat nuevo de P (o el mismo después de compactar) llama a `leer_memoria`. Tampoco aparece. La mente ve la carpeta
   con cambios sin commit que nadie explica, y solo puede reconstruir qué pasó con `git diff`, si la carpeta es git.
   Si no lo es (el modo local lo permite: «No le pidas al usuario commits, git init ni ramas», `prompt.ts:98`), no
   queda ningún rastro.

**Evidencia en la bóveda real** (`C:\dev\orquestador-memoria\Orquestador\Sesiones`, solo lectura): las 13 notas son
de `agy` (2), `claude` (5) y `codex` (6). No hay ninguna de `orquestador`. La mente sí escribió en esa bóveda ese día
(por ejemplo, la decisión `Decisiones/2026-11-05-retener-t5-y-t11-…`, con `agente: orquestador`, en bypass), así que la
bóveda funciona. Esa nota habla de aprobar y delegar tareas, no de cambios que la mente hiciera ella misma, así que no
prueba que se haya perdido alguno. Solo muestra que, si los hubo, no hay dónde verlos.

## Por qué pasa

La memoria se diseñó cuando la mente solo planificaba y delegaba, y el registro de sesiones quedó dentro de la flota.
Cuando la mente pasó a hacer cambios ella misma (bypass y chat), su turno no se sumó a ese registro, y en el modo
`chat` el prompt además la saca de la rutina de leer y escribir memoria.

## Solución posible

1. **`src/core/conductor/ports.ts:110`:** sumar `recordSession` a `ConductorMemoryPort`
   (`Pick<MemoryStore, 'buildContext' | 'recordSession'>`). `ObsidianMemory` ya lo implementa
   (`src/shared/contracts.ts:63`), y `f5-chat.ts:112` ya pasa `comp.memory`.
2. **`src/core/chat/service.ts`:**
   - En `Turn` (`service.ts:134-139`) agregar `files: Set<string>` y `ranShell: boolean`. En `#emit`, sumar
     `out.payload.path` de cada `file_change` de la sesión principal y de sus subagentes (cualquier evento del chat
     mientras `live.turn` existe, no solo `main`), y marcar `ranShell` si hay un `tool_call` de Bash o PowerShell.
     Las rutas absolutas (carpetas extra, fuera del proyecto) se pueden dejar fuera o anotar aparte.
   - En `#finishTurn`, si el chat tiene proyecto, el modo actúa (`modeActs`, `src/core/conductor/session.ts:64`) y
     `turn.files` no está vacío o `turn.ranShell`, llamar a
     `this.#deps.ports.memory.recordSession({ projectId, taskId: \`chat-${chatId}\`, agentId: CONDUCTOR_AGENT_ID,
     title: chat.title.trim() || 'Cambios de la mente', outcome: ok ? 'ok' : 'failed',
     summary: turn.session.redact(final).slice(0, 2000), filesChanged: [...turn.files], inputTokens, outputTokens,
     costUsd, at })` sin esperar. Si el turno corrió comandos, el resumen lo dice («además corrió comandos: los archivos
     que tocaron no se detectan»). En un proyecto en modo worktrees, el resumen dice también que los cambios quedaron
     sin commit en la carpeta del proyecto y no están en la rama de integración. Un fallo solo va al log, igual que en
     `fleet.ts:745-749`. Los tokens del turno salen de los `usage` ya calculados como diferencias (`live.delta`). Si no
     se quieren sumar al total de `Agentes/orquestador.md`, se pasa 0 y se deja el costo en el chat.
   - `chat-<uuid>` cabe en `idSchema` (`src/shared/agents.ts:4`, hasta 64 caracteres en minúsculas). Cada turno es una
     nota nueva (`<fecha>-chat-<uuid>-n`, `obsidian-memory.ts:326-335`).
   - Las Conversaciones (sin proyecto) no se registran: no tienen memoria de proyecto.
3. **`src/core/conductor/prompt.ts:154-162` (`MODE_TEXT.chat`):** con proyecto, una línea que pida
   `leer_memoria` antes de un cambio grande y `escribir_memoria` cuando el usuario decida algo que deba durar.

### Otras opciones

- **Una nota por chat y por día** en vez de una por turno, actualizada en cada turno con los archivos acumulados.
  Ensucia menos la bitácora, pero `recordSession` hoy no actualiza (es idempotente por tarea, agente y hora,
  `obsidian-memory.ts:262`), así que haría falta un método nuevo.
- **Registrar al cerrar la sesión** (inactividad, `close` o `delete`) con todo lo que cambió. Junta menos notas, pero
  si el núcleo muere antes, no queda nada.
- **Solo el texto del prompt** (punto 3) sin registro automático. Es lo más barato, pero vuelve a depender de que la
  mente se acuerde, que es justo la debilidad que ella misma describió. Además, mientras siga abierta
  `autoeval-trabajo-01`, lo que guarde como decisión con `escribir_memoria` tampoco vuelve en `leer_memoria` ni en el
  `BRIEF.md`; solo el resumen vivo (`tipo: resumen`) llega.
- **Archivos por `git status` en vez de por `file_change`**: en carpetas git, tomar `git status --porcelain` al empezar
  y al terminar el turno y anotar la diferencia. Detecta también lo que cambian Bash y PowerShell, pero no sirve en
  carpetas sin git, mezcla cambios del usuario o de una tarea de la flota en modo local que trabaje a la vez, y cuesta
  un proceso `git` por turno.

La propuesta no es la única y puede haber una mejor. Basta con que las pruebas de abajo pasen.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta** en `tests/core/chat/service.test.ts` (o un archivo nuevo
  `tests/core/chat/memoria-turno.test.ts` con el mismo `bench`):
  - Sumar a `FakeMemory` (`tests/core/conductor/fakes.ts:96`) un `sessions: SessionSummary[]` y `recordSession`.
  - Chat del proyecto `demo` en modo `chat`. La `query` falsa emite un `assistant` con `tool_use` `Write`
    (`file_path: <repo>/notas.md`), el `user` con su `tool_result` correcto y un `result` `success`. Afirmar que
    `memory.sessions` tiene una entrada con `projectId: 'demo'`, `taskId: 'chat-<id>'`, `agentId: 'orquestador'`,
    `filesChanged: ['notas.md']` y `outcome: 'ok'`.
  - El mismo turno sin `Write` (solo texto): `memory.sessions` queda vacío.
  - Un turno con un `tool_use` `Bash` y su `tool_result` correcto, sin `Write`: `memory.sessions` tiene una entrada con
    `filesChanged: []` y un resumen que avisa que corrió comandos.
  - Un `Write` hecho por un subagente (mensaje con `parent_tool_use_id` de un `Agent`): su ruta entra en
    `filesChanged` del turno.
  - El mismo turno en una Conversación (`projectId: null`) o en modo `plan`: queda vacío.
  - Si `recordSession` lanza, el turno igual termina y el chat queda `idle`.
- **Comando** (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/chat tests/core/conductor && npm run -s typecheck"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/chat tests/core/conductor; npm run -s typecheck`).
  El `typecheck` hace falta porque `ConductorMemoryPort` cambia y `FakeMemory` tiene que implementar `recordSession`.
- **Verificación manual:** en un chat de un proyecto de prueba, en modo chat, pedir que cree `notas.md`. En Obsidian
  debe aparecer una nota nueva en `Orquestador/Sesiones/` con `agente: orquestador` y `archivos: [notas.md]`, y una línea
  en la bitácora de `Proyectos/<proyecto>/Contexto.md`. En un chat nuevo del mismo proyecto, `leer_memoria` debe
  nombrarla.
