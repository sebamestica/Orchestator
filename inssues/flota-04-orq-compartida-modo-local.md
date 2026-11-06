# Modo local: las tareas de una misma carpeta comparten `.orq/`. Una tarea hereda el plan y el HANDOFF de otra fallida, y si termina bien borra el HANDOFF que la fallida necesita para el reintento

- **Área:** Núcleo de la flota
- **Severidad:** media
- **Archivos:** `src/core/app/local-workspaces.ts:102-112`, `src/core/app/local-workspaces.ts:142-151`, `src/core/orchestrator/fleet.ts:265-279`, `src/core/orchestrator/fleet.ts:376-385`, `src/core/orchestrator/fleet.ts:408`, `src/core/orchestrator/fleet.ts:536`, `src/core/orchestrator/fleet.ts:611-635`, `src/core/orchestrator/fleet.ts:669-677`, `src/core/orchestrator/fleet.ts:753-760`, `src/core/orchestrator/fleet.ts:801`, `src/core/orchestrator/fleet.ts:833`, `src/core/orchestrator/supervisor.ts:399-405`, `src/core/orchestrator/task-plan.ts:116-120`, `src/core/brief/render-brief.ts:46`, `src/core/app/fleet-port.ts:69-82`, `tests/integration/local-mode.test.ts:92-102`
- **Estado:** abierta

## Cómo ocurre
En modo local (issue 1), una tarea trabaja directamente en la carpeta del proyecto. La carpeta de trabajo de Berland,
`.orq/`, es **una por carpeta**: `LocalWorkspaces.create` siempre usa `join(project.repoPath, '.orq')`
(`local-workspaces.ts:102`). En cambio, los archivos de estado que deja el autor son **de cada tarea**:
`.orq/PLAN-TAREA.md` (lo pide el encargo, `render-brief.ts:46`) y `.orq/HANDOFF.md` (lo escribe el agente o la flota
al llegar al tope de gasto). La flota solo reescribe `.orq/PLAN.md` y `.orq/BRIEF.md` antes de cada intento
(`fleet.ts:383-384`). Los otros dos archivos se quedan como están.

La exclusión por carpeta solo impide que dos tareas estén **en curso** a la vez. Cuando una termina, aunque haya
fallado, su clave se libera (`fleet.ts:276-279`, `this.#exclusive.delete(id)`), y la siguiente tarea `ready` del mismo
proyecto arranca sola. Pasa, por ejemplo, con un plan de varias tareas de `crear_tareas`. La cola no tiene ninguna
guardia por proyecto (`queue.ts:139-147`).

Pasos, con un proyecto local en la carpeta X y dos tareas, A y B:

1. **A falla**, por ejemplo por el tope de gasto. `#overBudget` agrega su sección a `.orq/HANDOFF.md` y deja como
   motivo «lo hecho queda en .orq/HANDOFF.md: reintenta para continuar desde ahí» (`fleet.ts:614`, `fleet.ts:616-628`).
   Como la tarea falló, `#cleanup` no llama a `remove` y `.orq/` se conserva:
   ```ts
   if (!run.workspace || (outcome !== 'ok' && this.#keepFailed)) return;   // fleet.ts:754
   ```
2. **B arranca en X.** `create` reutiliza la `.orq/` de A sin separar nada, y además olvida a propósito la entrada viva
   de A (`local-workspaces.ts:108-111`):
   ```ts
   // ... lo que quede de esta carpeta es de una tarea fallida ... Se olvida para que no impida limpiar al terminar esta.
   for (const [key, p] of this.#live) if (LocalWorkspaces.key(p.repoPath) === folder) this.#live.delete(key);
   ```
3. **B trabaja sobre el estado de A.** `#readTaskPlan` lee `.orq/PLAN-TAREA.md` sin saber de qué tarea es
   (`fleet.ts:672`). Hay dos casos:
   - Si el autor de B no escribe su plan (`fleet.ts:407` admite que Codex a veces no escribe en `.orq/`), el plan de A
     cuenta como el de B. `taskPlanProblem` no avisa porque el archivo existe (`task-plan.ts:117`), y el detalle de la
     cola muestra el avance de A. El revisor de B recibe el plan de A como «Plan de la tarea»
     (`fleet.ts:536`, `fleet.ts:801`), con la orden de comprobar que los pasos `- [x]` estén hechos (`fleet.ts:833`).
     Puede rechazar B por pasos que nunca fueron suyos.
   - Si el autor de B sí escribe su plan, como pide el encargo, **pisa** el `PLAN-TAREA.md` de A. El plan de A se pierde
     igual.

   Si a B le toca un traspaso por cupo o por rechazo, `buildHandoff` lee `.orq/HANDOFF.md`, que es el de A, y lo mete en
   el resumen de B (`supervisor.ts:399-405`). Si B también llega al tope, su sección se agrega debajo de
   `# Traspaso de A` (`fleet.ts:620-627`).
4. **B termina bien.** `#cleanup` llama a `remove` (`fleet.ts:756`). Como la entrada de A se olvidó en el paso 2, ya no
   queda otra entrada viva de la carpeta, y la marca existe porque A creó `.orq/`. Así que `remove` borra toda la
   `.orq/`, con el HANDOFF y el plan de A (`local-workspaces.ts:148-150`):
   ```ts
   if ([...this.#live.values()].some((p) => LocalWorkspaces.key(p.repoPath) === folder)) return;
   if (await exists(join(project.repoPath, LOCAL_MARKER))) await rm(join(project.repoPath, SCRATCH), { recursive: true, force: true });
   ```
5. **Se reintenta A.** `withContinuation` le pide al agente releer `.orq/PLAN-TAREA.md` y `.orq/HANDOFF.md` «si existe»
   (`fleet-port.ts:77-78`). Ya no existen. A arranca sin el resumen de lo hecho y lo pendiente que prometía el motivo del
   paso 1. Solo le queda una línea de motivo y una carpeta que ahora también tiene los cambios de B.

La prueba `tests/integration/local-mode.test.ts:92-102` fija hoy este comportamiento. Crea la tarea `fallida`, le
escribe un `HANDOFF.md`, crea otra tarea con otro id (`reintento`), la quita y espera
`existsSync(join(folder, '.orq')) === false`. Ninguna prueba de `tests/core/orchestrator/fleet-local.test.ts` revisa
que el estado quede aislado entre tareas.

## Por qué pasa
En modo local, `.orq/` es una por carpeta, pero `PLAN-TAREA.md` y `HANDOFF.md` son de cada tarea, y nada los asocia a
la tarea que los escribió. `LocalWorkspaces` solo recuerda en memoria cuál es la tarea viva. Para que la tarea
siguiente pueda limpiar, olvida a la fallida (`local-workspaces.ts:111`). Luego la limpieza tras un éxito borra
`.orq/` entera (`local-workspaces.ts:150`), y con ella el estado de todas las tareas. Con worktrees esto no pasa, porque
cada tarea tiene su propia `.orq/`.

## Solución posible
Separar el estado por tarea dentro de `LocalWorkspaces`, que es el dueño de `.orq/` en modo local:

1. `src/core/app/local-workspaces.ts`, `create`: guardar en la marca `.orq/.berland-local` el id de la tarea dueña del
   estado actual. Si la marca nombra otra tarea y hay `PLAN-TAREA.md` o `HANDOFF.md`, moverlos a
   `.orq/tareas/<idAnterior>/`. Si existe `.orq/tareas/<task.id>/`, que es el reintento de una tarea apartada antes,
   devolver sus archivos a `.orq/` y borrar esa subcarpeta. Después, escribir la marca con `task.id`.
2. `remove`: borrar solo los archivos de la tarea que termina (`BRIEF.md`, `PLAN.md`, `PLAN-TAREA.md`, `HANDOFF.md`,
   `REVISION.md`). Borrar `.orq/` entera solo si no queda `.orq/tareas/` con estado de otras tareas.
3. Cambiar `tests/integration/local-mode.test.ts:92-102`. Ahora debe esperar que el `HANDOFF.md` de `fallida` siga en
   `.orq/tareas/fallida/` después de quitar la otra tarea, y que se restaure al volver a crear `fallida`.

Así el revisor de B ve «(el autor no escribió `.orq/PLAN-TAREA.md`)» si B no lo escribió, y el reintento de A encuentra
su plan y su HANDOFF en las rutas de siempre, sin tocar `PLAN_FILES`, los encargos ni los adaptadores.

### Otras opciones
- **Guardar el HANDOFF en la base.** Al fallar, la flota guarda `.orq/HANDOFF.md` (y quizá `PLAN-TAREA.md`) junto con la
  tarea en el almacén. `FleetRuntime.retry` lo agrega a la «Continuación» o lo vuelve a escribir en `.orq/` antes del
  reintento. El reintento ya no depende del disco, y también sirve si el usuario borra la carpeta o el worktree. A
  cambio, hay que tocar el almacén y `fleet-port.ts`.
- **Limpiar al empezar.** Hacer que `Fleet.#cycle` (o `create`) aparte o borre los `PLAN-TAREA.md` y `HANDOFF.md` que no
  sean de la tarea, antes del primer intento. Es más simple, pero si los borra, la tarea fallida pierde su estado igual.
- **Avisar o frenar.** No arrancar otra tarea del mismo proyecto local mientras haya una `failed` con estado conservado,
  o avisar a la mente. Evita el cruce, pero detiene planes de varias tareas independientes.
- **Un `.orq/` por tarea** (`.orq/<id>/`). Es lo más limpio, pero obliga a cambiar `PLAN_FILES`, el encargo, el
  Supervisor y las guardias de los adaptadores que tratan `.orq/` como ruta fija.

La propuesta no es la única. Puede convenir combinar la primera solución con la opción de la base, para que el
reintento no dependa de que `.orq/` sobreviva.

## Cómo probar que quedó resuelta
- **Prueba automatizada propuesta:** en `tests/integration/local-mode.test.ts`, que ya usa `LocalWorkspaces` sobre una
  carpeta temporal, o en una prueba nueva `tests/core/orchestrator/fleet-local-estado.test.ts`, con `Fleet`, adaptadores
  falsos y `LocalWorkspaces` real:
  1. La tarea A escribe `.orq/PLAN-TAREA.md` (con `- [x] paso de A`) y `.orq/HANDOFF.md`, y falla (por ejemplo, el
     adaptador falso informa un costo mayor que el tope).
  2. La tarea B, del mismo proyecto y sin dependencias, no escribe `PLAN-TAREA.md` y su revisor falso aprueba.
  3. Afirmar que el `objective` del encargo de revisión de B no contiene `paso de A` y sí contiene
     «el autor no escribió».
  4. Afirmar que, después del éxito de B, el `HANDOFF.md` de A sigue en disco, y que al reintentar A
     (`FleetRuntime.retry`) `.orq/HANDOFF.md` y `.orq/PLAN-TAREA.md` vuelven a tener el contenido de A antes de su
     primer intento.
  5. Afirmar que, cuando A termina bien después del reintento, `.orq/` desaparece.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/integration/local-mode.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/integration/local-mode.test.ts`).
- **Verificación manual en la app:** en un proyecto local, delegar dos tareas independientes con un tope bajo para la
  primera. Cuando falle, dejar que la segunda termine bien. Comprobar que `.orq/tareas/<idA>/HANDOFF.md` sigue ahí, que
  al reintentar A desde el panel su agente cita su HANDOFF, y que en la revisión de la segunda no aparece el plan de la
  primera.
