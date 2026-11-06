# crear_tareas acepta otro proyecto: en auto y bypass la tarea se aprueba sola y la flota trabaja en el repo ajeno

- **Área:** Mente y chat
- **Severidad:** media
- **Archivos:** `src/core/conductor/tools.ts:189`, `src/core/conductor/tools.ts:210`, `src/core/conductor/tools.ts:219`, `src/core/conductor/tools.ts:223`, `src/core/conductor/tools.ts:253`, `src/core/conductor/tools.ts:288`, `src/core/conductor/tools.ts:311`, `src/core/conductor/tools.ts:396`, `src/core/conductor/prompt.ts:32`, `src/core/orchestrator/plan.ts:104`, `src/core/chat/proposals.ts:74`, `src/core/chat/service.ts:260`, `src/core/chat/service.ts:716`, `src/core/chat/service.ts:752`, `src/core/chat/service.ts:902`, `src/core/orchestrator/fleet.ts:364`, `src/core/workspace/manager.ts:87`, `tests/core/conductor/tools.test.ts:81`
- **Estado:** abierta

## Cómo ocurre
Cada chat de Berland tiene un proyecto. La sesión de la mente recibe ese proyecto como `defaultProjectId`
(`src/core/conductor/session.ts:277`). El issue 9 (commit `3bdc166`) acotó a ese proyecto `estado`, `leer_memoria`,
`escribir_memoria` y los ids que ve el planificador. El proyecto de destino de `crear_tareas` quedó fuera, y el
propio plan lo anota como pendiente (`docs/plan/issues/09-aislamiento-contexto.md:158-159`: «sigue aceptando
`proyecto` distinto al de la sesión … Así un chat de A puede proponer tareas de B»).

Pasos:

1. Un chat del proyecto `orquestador` en modo auto o bypass. Hay otro proyecto registrado, por ejemplo `marketing`.
2. La mente llama `crear_tareas { plan, proyecto: 'marketing' }`. Tanto la herramienta como el prompt la invitan a
   pasar el parámetro:
   - `tools.ts:189`: `proyecto: idSchema.optional().describe('Id del proyecto; por omisión, el de la sesión.')`
   - `prompt.ts:32`: `crear_tareas(plan, proyecto?)`
3. El proyecto pedido se usa sin compararlo con el de la sesión:
   - `tools.ts:210`: `const projectId = proyecto ?? defaultProjectId;`
   - `tools.ts:212`: el planificador recibe `projectId: 'marketing'`.
4. El chequeo de «otro proyecto» compara contra el proyecto pedido, no contra el del chat, así que nunca salta:
   - `tools.ts:219-220`: `tasks.filter((t) => t.projectId !== projectId)`
   - Además, el planificador real reescribe el `projectId` de cada tarea con el pedido (`plan.ts:104`:
     `{ ...item, projectId: opts.projectId }`).
5. Las tareas se proponen en el chat de A y se aprueban solas:
   - `ChatProposals.propose` (`proposals.ts:74-106`) guarda `task.projectId` sin mirar el proyecto del chat.
   - `tools.ts:223`: `if ((current === 'auto' || current === 'bypass') && opts.autoApprove) proposed = await opts.autoApprove(...)`
   - `service.ts:716`: `autoApprove: (ids) => live.proposals.approve(ids)`
6. `delegar` (`tools.ts:253-291`) solo mira la aprobación y las dependencias, y entrega la tarea en `tools.ts:288`
   (`ports.fleet.delegate(entry.task)`). La respuesta de `crear_tareas` le dice a la mente que lo haga
   (`nextStep`, `tools.ts:465`: «delégalas con delegar»). En bypass, el prompt además le pide no preguntar.
7. `ChatService.#deliver` (`service.ts:902-927`) pone la tarea en el tablero (`store.putTask(task, 'ready')`) y la
   encola. Este puerto lo comparten todos los chats (`service.ts:260-265`) y no recibe el chat, así que no puede
   comparar proyectos.
8. La flota abre el worktree, o la carpeta en modo local, del proyecto de la tarea:
   - `fleet.ts:364`: `this.#workspaces.create(task.projectId, task)`
   - `manager.ts:87`: `this.project(projectId)`

   Los agentes trabajan y se integra en el repo de `marketing`, sin que el usuario lo haya aprobado.
9. Después la mente no puede seguir lo que lanzó. `estado {taskId}` responde «no es de este proyecto»
   (`tools.ts:311-312`), y `estado {}` no la lista, porque `projectTasks(scope)` filtra por el proyecto de la sesión.

El resto de la sesión sí aplica la regla:

- `escribir_memoria` rechaza otro proyecto (`tools.ts:396-398`).
- `#recordDestination` rechaza otro proyecto (`service.ts:752-754`), pero el error lo atrapa `noteDestination`
  (`tools.ts:149-153`) y llega cuando las tareas ya se propusieron y aprobaron.

La prueba existente fija el comportamiento actual. En `tests/core/conductor/tools.test.ts:81-89` («usa el proyecto
indicado…»), con `defaultProjectId: 'demo'` y `proyecto: 'otro'`, espera `isError` falso y
`planner.requests[0].projectId === 'otro'`.

En modo plan el daño es menor: el usuario aprueba en la interfaz (`service.ts:525-536` → `approveAndDeliver`). Pero
ve en el chat de A una propuesta de B, y tampoco hay ninguna guardia de proyecto en ese camino.

## Por qué pasa
`crear_tareas` toma `proyecto` como destino válido aunque la sesión tenga proyecto, y la única validación compara
las tareas con ese mismo valor. Ninguna capa siguiente vuelve a mirar el proyecto del chat:

- `ChatProposals.propose`
- `approve` / `autoApprove`
- `delegar`
- `#deliver`
- la flota

Al acotar el contexto, el issue 9 dejó esto como pendiente a propósito, y la prueba de `tools.test.ts:81` lo exige.

## Solución posible
1. **`src/core/conductor/tools.ts`, en `crear_tareas`:** aplicar la misma regla que en `escribir_memoria`. Antes de
   llamar al planificador, fallar si `defaultProjectId !== undefined && proyecto !== undefined &&
   proyecto !== defaultProjectId`. El mensaje sería, por ejemplo: «solo puedes crear tareas de este proyecto
   (A), no de B. Omite proyecto; para otro proyecto, el usuario debe abrir un chat de ese proyecto».
   - Cambiar la descripción de `proyecto` (`tools.ts:189`) a «Omítelo: siempre es el proyecto de esta sesión
     (otro proyecto da error)».
   - Cambiar `prompt.ts:32` para que no invite a pasarlo.
2. **Defensa en `delegar` (`tools.ts:253-291`):** antes de `fleet.delegate`, rechazar si
   `defaultProjectId !== undefined && entry.task.projectId !== defaultProjectId`. Cubre las propuestas ajenas que ya
   estén guardadas en la base de algún chat.
3. **Defensa en el chat:** pasar el proyecto del chat a `ChatProposals` (`service.ts:625-629`, opción nueva
   `projectId`) y rechazar en `propose` (`proposals.ts:74`) toda tarea con otro `projectId`. Así tampoco el
   camino de la interfaz (`approve`/`approveAll`) puede entregar una tarea ajena.
4. **`tests/core/conductor/tools.test.ts:81-89`:** dejar la prueba del tachado de secretos sin `proyecto: 'otro'`
   (o con `proyecto: 'demo'`) y llevar el caso de otro proyecto a la prueba nueva de rechazo.

### Otras opciones
- **Quitar el parámetro `proyecto`** de `crear_tareas` cuando la sesión tiene proyecto. Se dejaría solo para la
  terminal sin proyecto de sesión. Es más simple para el modelo, porque no ve una opción que luego da error, pero
  cambia el esquema por sesión.
- **Permitir el cruce, pero nunca aprobarlo solo:** si `proyecto !== defaultProjectId`, saltar `autoApprove` y dejar
  las tareas `proposed`, aunque el modo sea auto o bypass, para que el usuario decida. Habría que acotar también
  `estado` para que muestre esas propuestas. Mantiene una capacidad que hoy nadie parece usar a propósito.
- **Guardia en `ChatService.#deliver`:** comparar `task.projectId` con `chat.projectId`. Pide que el puerto de
  flota de cada chat lleve su `chatId` (hoy `this.#fleet` es único, `service.ts:260-265`). Hacerlo en
  `ChatProposals` (punto 3) da el mismo resultado sin tocar ese puerto.

La propuesta no es la única. La más corta es el punto 1 solo, una línea con la misma forma que `escribir_memoria`.
Los puntos 2 y 3 son defensa en profundidad y se pueden dejar para después.

## Cómo probar que quedó resuelta
- **Prueba automatizada propuesta:** en `tests/core/conductor/aislamiento.test.ts`, un `describe` nuevo
  «crear_tareas: solo el proyecto de la sesión».
  - Arma `createConductorTools(ports, { defaultProjectId: 'orquestador', mode: () => 'auto', autoApprove })` con
    un `autoApprove` espía y un `FakePlanner` que registra las llamadas.
  - `call('crear_tareas', { plan: 'x', proyecto: 'marketing' })` devuelve `isError: true` con «solo puedes crear
    tareas de este proyecto».
  - `planner.requests` queda vacío, `autoApprove` no se llamó y `ports.proposals.list()` está vacío.
  - Repetir con `mode: () => 'bypass'`.
  - Afirmar que `proyecto: 'orquestador'`, o sin `proyecto`, sigue funcionando.
  - Si se aplica el punto 2: una propuesta ajena metida a mano (`ports.proposals.propose([brief('ajena',
    { projectId: 'marketing' })])`, luego `approve`) hace que `delegar { taskId: 'ajena' }` falle y que
    `ports.fleet.delegate` no se llame.
  - Si se aplica el punto 3: en `tests/core/chat/aislamiento.test.ts`, una `ChatProposals` de un chat de A rechaza
    `propose` de una tarea de B.
  - Ajustar `tests/core/conductor/tools.test.ts:81-89` como se dice arriba.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/conductor/aislamiento.test.ts tests/core/conductor/tools.test.ts"`.
  Desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/conductor/aislamiento.test.ts tests/core/conductor/tools.test.ts`.
  Al final, `npm run -s check`.
- **Verificación manual en la app:** en un chat de un proyecto en modo auto, pedir «crea una tarea en el proyecto
  <otro> para …». La mente debe recibir el error y decir que hay que abrir un chat de ese proyecto. No debe aparecer
  ninguna tarea nueva del otro proyecto en el tablero global ni ningún worktree nuevo en su carpeta.
