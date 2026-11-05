# Issue 9 — El contexto entre proyectos no debe mezclarse

Estado: hecho, sin commit (A0 confirma) · Rama: `flota/c27-contexto` (sale de `main`, `d746f2f`)

## Lo que dijo el usuario
«He notado que el contexto entre proyectos se está mezclando. Eso no debe pasar, porque pueden llegar a confundirse las
tareas y demás.»

## Lo que mostraron los datos reales
Base `orquestador.db` (solo lectura) y bóveda `C:\dev\orquestador-memoria`. Proyectos: `orquestador`, `marketing`,
`professional` y `radio-example`.

1. **`estado` sin `taskId` lista la cola de todos los proyectos.**
   - Evento 3179, 2026-11-04T18:07:36Z, chat `2e211f13…` (proyecto `orquestador`): `total: 6`, con
     `analisis-mercado-instagram` y `analisis-mercado-instagram-b` (de `marketing`).
   - Eventos 7473 y 8065, 2026-11-05T01:15 y 01:21, chat `00831801…` (`orquestador`): aparece `contexto-github`
     (de `professional`). La mente lo dijo al usuario: «`contexto-github` (Claude): falló. No es de este plan».
   - Evento 7961, 01:18:44Z: el subagente `investigador` del chat de `radio-example` llamó a `estado {}` y vio
     `ayuda-ia`, `chrome-diagnostico` y `rutas-portables` (`orquestador`) y `contexto-github` (`professional`).
2. **`estado` con un `taskId` de otro proyecto lo informa.**
   - Eventos 3244 y 3246, 18:12:02Z: el chat de `orquestador` consultó `verificacion-datos-funciones` y
     `analisis-mercado-instagram` (de `marketing`). Recibió el estado `failed` con `proyecto: null`.
   - Evento 8032, 01:20:23Z: el chat de `professional` consultó `rutas-portables` (de `orquestador`). Recibió
     `review` y `codex`.
3. **El planificador recibe los ids de otros proyectos como dependencias posibles.**
   - `src/core/conductor/tools.ts:145-150`: `knownTaskIds()` suma `fleet.list()`, que trae toda la cola.
   - `src/core/orchestrator/plan.ts:302-303` los pone en el prompt: «Tareas ya existentes que puedes usar en
     dependsOn: …».
   - Con `crear_tareas` del chat de `orquestador` (eventos 3126 y 3146, 17:35 y 18:05), la cola tenía las tareas
     de `marketing`. Lo muestra el `estado` de las 18:07.
   - Con `crear_tareas` del evento 6782 (01:07:56Z) la cola tenía `contexto-github`, de `professional`.
4. **La mente y sus subagentes leen la bóveda de Obsidian de todos los proyectos con Read, Grep y Glob.**
   - `src/core/app/f5-chat.ts:116`: `denyPaths` protege la bóveda de claves (`vault.json`) y la base, pero no la
     carpeta de la memoria (`comp.memory.vaultPath`).
   - En modo bypass la mente lee todas las unidades.
   - Eventos 2811/2812, 2816/2820 y 2824/2830, 2026-11-04T15:36Z: el `investigador` del chat de `marketing` hizo
     `Glob **/*.md` y `Grep` en `C:\dev\orquestador-memoria`. Recibió `Proyectos/agent-hub/Contexto.md`, notas de
     `Sesiones/` de `orquestador` y `agent-hub`, y la decisión
     `2026-11-04-canva-mcp-para-editar-navegador-para-efectos.md`, de `agent-hub`.
5. **`leer_memoria` y `escribir_memoria` aceptan cualquier proyecto, y `proyecto` es obligatorio.**
   - `tools.ts:315` y `tools.ts:339`: la mente tiene que adivinar el id, y nada le impide leer la memoria de otro
     proyecto ni escribir en ella.
   - Evento 7847, 01:18:34Z: el `investigador` de `radio-example` pasó `proyecto: "radio_example-"`, sacado del
     nombre de la carpeta, y falló la validación.
   - No hubo escrituras cruzadas: las 10 decisiones de `Decisiones/` llevan el proyecto del chat que las escribió.
6. **`buscar_skills` lista las skills de la carpeta donde arrancó el núcleo, no las del proyecto del chat.**
   - `f5-chat.ts:110` usa `comp.skills`, y `SkillHub` busca en `<hub>/skills` y en
     `<process.cwd()>/.agents/skills` (`src/core/skills/hub.ts:209`).
   - El escritorio arranca el núcleo con `cwd = repoRoot`, es decir `C:\dev\orquestador`
     (`apps/desktop/src/core-supervisor.ts:209`). Así, si el repo tiene skills propias, los chats de todos los
     proyectos las ven.
   - Hoy `C:\dev\orquestador\.agents\skills` no existe, así que la fuga no ocurrió todavía.
   - Lo mismo pasa con la terminal (`src/core/app/conductor.ts:115`).
7. **La terminal (`conductor.ts`) tiene las mismas fugas.**
   - `estado` y `knownTaskIds` usan `FleetRuntime.list()`, que trae toda la cola.
   - No hay `denyPaths`.

### Lo revisado que ya está acotado
- **Memoria de los encargos:**
  - `src/core/orchestrator/fleet.ts:558-565` (`#memoryContext`) llama a `buildContext(task.projectId, …)`.
  - `src/core/memory/obsidian-memory.ts:519` descarta las sesiones con otro `proyecto`, y `Contexto.md` es por
    proyecto.
  - Los `BRIEF.md` reales de `C:\dev\.worktrees\orquestador-orq\*` solo traen sesiones de `orquestador`.
  - Se agregan pruebas de regresión.
- **Propuestas del chat** (`src/core/chat/proposals.ts:108-120`): `get` y `list` son del chat. `taken`
  (`service.ts:594`) solo evita ids repetidos, que son únicos en toda la base.
- **Sesión del SDK:** cada chat guarda su `sdk_session_id` desde su propio flujo (`service.ts:737`) y reanuda solo
  ese (`service.ts:681`). Se agrega una prueba.
- **Subagente `investigador`:**
  - Fuera de bypass, la guardia solo deja leer `cwd` y las raíces de lectura.
  - En las 875 lecturas registradas de los cinco chats no hay ninguna de la carpeta de otro proyecto registrado.
  - La única lectura cruzada es la de la bóveda (punto 4).
- **Interfaz:**
  - El tablero de un proyecto (`#/tablero/<id>`) filtra por ese proyecto (`BoardView.tsx:43-47`). El global muestra
    todos a propósito.
  - La lista de chats filtra por proyecto (`src/ui/features/chat/store.ts:202, 400`).
  - El panel «Agentes en vivo» (`AgentsPanel.tsx:112`) muestra las 50 últimas sesiones de todos los proyectos.
    Queda fuera de este encargo y va como propuesta.

## Diseño
Todo lo que la mente y sus subagentes ven queda acotado al proyecto del chat o de la tarea.

- **El proyecto de cada estado de la flota.**
  - `withTaskProjects` (`conductor.ts`) agrega `projectId` a cada estado (`ProjectTaskStatus`, de `tools.ts`). Lo
    usan los puertos del chat (`lazyFleetPort`) y de la terminal.
  - El proyecto sale de la cola o de la base.
- **`estado`:**
  - Sin `taskId`, lista las propuestas del chat y las tareas de la flota de este proyecto.
  - Con el `taskId` de otro proyecto, responde «no es de este proyecto».
  - Una tarea cuyo proyecto no se conoce no se muestra, salvo que sea una propuesta del chat.
- **`crear_tareas`:** el planificador recibe solo los ids del proyecto del plan (es un cambio mínimo, en
  `knownTaskIds`).
- **`leer_memoria`:** `proyecto` pasa a ser opcional y por omisión es el de la sesión. Leer otro proyecto solo
  cuando el usuario lo pide explícitamente. La respuesta lo marca como «memoria de OTRO proyecto».
- **`escribir_memoria`:** solo escribe en la memoria del proyecto de la sesión (`proyecto` es opcional). Otro
  proyecto da error.
- **`buscar_skills`:**
  - En el chat, solo las skills comunes del hub, nunca las de la carpeta del núcleo.
  - En la terminal, las del hub y las de `<proyecto>/.agents/skills`.
- **`denyPaths`:** se suma la bóveda de Obsidian, en el chat y en la terminal. La memoria se lee solo con
  `leer_memoria`, acotada al proyecto.

## Rutas
- `src/core/conductor/tools.ts`: `estado`, `leer_memoria`, `escribir_memoria` y la ayuda `knownTaskIds`. En
  `crear_tareas` solo cambia el argumento de `knownTaskIds`.
- `src/core/app/f5-chat.ts` y `src/core/app/conductor.ts`.
- Pruebas en `tests/core/**`.
- No se tocan `src/core/memory/**`, `fleet.ts` ni `src/ui/**`: ya estaban acotados o quedan como propuesta.

## Criterios de aceptación
1. `estado {}` en un chat de A no muestra tareas de B, aunque estén en la cola. `estado {taskId}` de una tarea de B
   responde «no es de este proyecto».
2. `crear_tareas` en A no pasa al planificador ids de tareas de B.
3. `leer_memoria {}` lee la memoria de A. Con `proyecto: B` la lee marcada como de otro proyecto.
4. `escribir_memoria` con `proyecto: B` falla y no escribe nada.
5. En bypass, Read, Grep y Glob sobre la bóveda de Obsidian quedan denegados, también para los subagentes.
6. `buscar_skills` no lista las skills de la carpeta del núcleo.
7. El contexto de memoria de un encargo de A no trae sesiones, resumen ni notas de B, aunque compartan id de tarea,
   archivos o palabras.
8. Cada chat reanuda solo su propia sesión del SDK.
9. `npm run -s check` en verde.

## Cambios
- **`src/core/conductor/tools.ts`:**
  - `ProjectTaskStatus` y `statusProject`.
  - `estado` acotado al proyecto, con «no es de este proyecto» para las tareas ajenas.
  - `knownTaskIds(projectId)`.
  - `leer_memoria` y `escribir_memoria` con `proyecto` opcional. La memoria de otro proyecto se lee marcada y no se
    escribe.
- **`src/core/app/conductor.ts`:**
  - `taskProjectOf`, `withTaskProjects`, `projectSkillsPort` y `mindDenyPaths`.
  - La terminal los usa: flota con proyecto, skills del hub y del proyecto, y `denyPaths` con la memoria.
- **`src/core/app/f5-chat.ts`:**
  - `lazyFleetPort` con el proyecto de cada tarea.
  - Skills solo del hub.
  - `denyPaths` con la memoria de Obsidian.

## Pruebas
- **Nuevas (26):**
  - `tests/core/conductor/aislamiento.test.ts` (12).
  - `tests/core/chat/aislamiento-f5.test.ts` (5, composición real y bypass).
  - `tests/core/chat/aislamiento.test.ts` (2: dos chats de proyectos distintos y reanudación del SDK).
  - `tests/core/app/conductor-aislamiento.test.ts` (3, terminal).
  - `tests/core/memory/aislamiento.test.ts` (3).
  - `tests/core/orchestrator/aislamiento-memoria.test.ts` (1, `BRIEF.md` real de la flota).
- **Contra el código de `main`:** fallan 9 de las 14 nuevas de chat, terminal, memoria y flota, y 10 de las 12 de
  `tools`. Las que pasan en `main` son las de regresión de lo que ya estaba acotado: memoria, encargo y reanudación.
- **Ajustadas:** `tests/core/conductor/fakes.ts` (`FakeFleet` con `projectId`) y `tests/core/conductor/tools.test.ts`.
- **`npm run -s check`:** en verde, con 144 archivos aprobados y 10 saltados, y 1752 pruebas aprobadas y 20 saltadas
  (las `live`).

## Pendiente (fuera de estas rutas)
- **`src/core/conductor/prompt.ts`:** decir `leer_memoria(tarea?, proyecto?)`, `escribir_memoria(nota)` y
  `estado(taskId?)`, «de este proyecto». Hoy dice `leer_memoria(proyecto, …)`. Funciona igual, pero invita a pasar
  el id.
- **`src/core/conductor/ports.ts`:** subir `projectId?: string` a `FleetTaskStatus`, en lugar de
  `ProjectTaskStatus` en `tools.ts`.
- **`crear_tareas`:** sigue aceptando `proyecto` distinto al de la sesión (la prueba «usa el proyecto indicado» lo
  exige). Así un chat de A puede proponer tareas de B. Propuesta: rechazarlo como `escribir_memoria`.
- **Ids únicos en toda la base:** el planificador ya no recibe ids de otros proyectos, así que puede proponer uno
  ocupado por otro proyecto. `propose` lo rechaza («ya existe en el tablero; usa otro id») y la mente reintenta.
  Propuesta: en `PlanRequest` y `plan.ts`, separar «ids reservados» (no repetir, sin mostrar) de «ids para
  `dependsOn`» (solo los del proyecto).
- **`src/core/conductor/guard.ts`:** `denyPaths` bloquea rutas dentro de lo negado, pero no un `Grep` o `Glob` cuya
  carpeta lo contiene (en bypass, `Grep path=C:\dev` recorre `C:\dev\orquestador-memoria`). Propuesta: negar en
  bypass la búsqueda cuya raíz contiene una ruta negada, o excluirla con un glob.
- **Bypass:** sigue leyendo las carpetas de los otros proyectos registrados, a propósito. En los datos no hubo
  lecturas así. Si se quiere, se pueden negar las `repoPath` de los demás proyectos salvo que estén en `extraRoots`.
- **Skills propias del proyecto en el chat:** necesitan un puerto por chat en `ChatService` (`service.ts`), con
  `<proyecto>/.agents/skills`. Hoy el chat solo ofrece las del hub.
- **`src/ui/features/agents-panel/AgentsPanel.tsx:112`:** muestra las 50 últimas sesiones de todos los proyectos
  dentro de un proyecto. Propuesta: filtrar por el proyecto de la ruta (tarea → proyecto; mente → chat).
