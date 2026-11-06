# Tras reiniciar el núcleo, `estado()` sin `taskId` deja fuera el estado de las tareas: la mente informa la flota a medias, sin las fallidas ni las integradas

- **Área:** Mente y chat
- **Severidad:** media
- **Archivos:** `src/core/app/f5-chat.ts:42-52`, `src/core/app/fleet-service.ts:126`, `src/core/app/fleet-service.ts:211-214`, `src/core/app/fleet-service.ts:232-250`, `src/core/app/fleet-port.ts:34-35`, `src/core/app/fleet-port.ts:45-58`, `src/core/app/fleet-port.ts:181-183`, `src/core/app/conductor.ts:83-106`, `src/core/app/conductor.ts:174`, `src/core/conductor/tools.ts:156-165`, `src/core/conductor/tools.ts:168-171`, `src/core/conductor/tools.ts:297-330`, `src/core/conductor/tools.ts:499-524`, `src/core/conductor/prompt.ts:34`, `src/core/conductor/prompt.ts:62`, `tests/core/chat/retry-port.test.ts:5-18`
- **Estado:** resuelta
- **Origen:** autoevaluación de la mente (2026-11-05), afirmación 4 («si una herramienta devuelve algo mal, lo repite sin poder comprobarlo»)
- **Relacionadas:** `uso-real-04` (el núcleo muere sin dejar rastro), `uso-real-05` (chat cortado por reinicio), `flota-08` (el apagado cancela tareas en curso), `servidor-01` (un segundo núcleo corre `recoverOrphans` y marca tareas fallidas)

## Cómo ocurre

**Contexto.** El prompt le pide a la mente no suponer el estado de la flota: «estado(taskId?): estado de una tarea o
resumen de la flota. Consúltalo antes de informar avances; no supongas» (`prompt.ts:34`), y «Vigila con estado. Cuando
una tarea termine o falle, informa al usuario con datos reales» (`prompt.ts:62`). Sin `taskId`, `estado` arma un
resumen del proyecto con dos fuentes (`tools.ts:156-165` y `:327-329`): las propuestas de **este** chat y
`ports.fleet.list()`.

En el chat, `list()` solo mira la cola en memoria, mientras que `status()` también mira la base:

```ts
// src/core/app/f5-chat.ts:50-52
// Desde la base además de la cola: trae el motivo de un fallo y sirve tras reiniciar el núcleo.
status: (taskId) => comp.fleet.status(taskId),
list: () => comp.fleet.queue.list().map(toStatus),
```

La cola se crea vacía en cada arranque (`fleet-service.ts:126`) y no se rellena desde la base. Al arrancar,
`recoverOrphans` pasa a `failed` en la base las tareas que estaban en curso («interrumpida al reiniciar el núcleo»),
pero no las mete en la cola (`fleet-service.ts:232-250`). Las propuestas del chat sí sobreviven al reinicio, porque
están en SQLite (`chat_proposals`, `src/core/chat/proposals.ts`).

**Pasos.**

1. En un chat del proyecto P la mente propone y delega `api` y `ui`. `api` se integra y `ui` está `running`.
2. El usuario cierra Berland (o el núcleo se cae) y lo vuelve a abrir. `ui` queda `failed` en la base, y la cola está
   vacía.
3. En el mismo chat: «¿cómo va la flota?». La mente llama a `estado {}`. `projectTasks` toma las propuestas del chat
   (`api` y `ui`, ambas `aprobacion: 'delegated'`) y una lista vacía de la cola. `fleetSummary` devuelve
   `porEstado: {}` y las dos tareas con `estado: null`, `agente: null` (`tools.ts:499-524`).
4. La mente responde con lo que le dio la herramienta: «las dos tareas están delegadas, sin estado todavía». No dice
   que `ui` falló y se puede reintentar, ni que `api` ya está integrada.
5. Las tareas de P creadas desde el Tablero o desde otro chat solo entran al resumen por la cola, porque no son
   propuestas de este chat. Después del reinicio desaparecen del todo: la mente informa un proyecto con menos tareas
   de las que tiene.

Por tarea sí funciona: `estado { taskId: 'ui' }` lee la base (`fleet-service.ts:211-214`, `fleet-port.ts:45-58`) y
devuelve `failed` con el motivo. Pero la mente no tiene por qué saber que el resumen le está mintiendo.

El mismo hueco tiene dos efectos más:

- `crear_tareas` le pasa al planificador los ids que puede usar en `dependsOn` con `knownTaskIds`, que también sale de
  `projectTasks` (`tools.ts:168-171` y `:212`). Después del reinicio, las tareas del Tablero o de otro chat ya no están
  en esa lista, aunque sigan en la base.
- En la terminal (`createConductor`, `src/core/app/conductor.ts:174`), la mente usa `FleetRuntime.list()`, que también
  lee solo la cola (`fleet-port.ts:181-183`).

La prueba de `lazyFleetPort` simula la cola con `list: () => []` y solo comprueba `status` y `retry`
(`tests/core/chat/retry-port.test.ts:5-18`). No hay prueba de `estado` sin `taskId` después de un reinicio.

## Por qué pasa

El resumen de `estado` confía en que la cola en memoria tiene todas las tareas vivas o recientes del núcleo. Eso es
cierto mientras el núcleo no se reinicia, y no lo es después. `status()` se arregló para leer la base (el comentario de
`f5-chat.ts:50` lo dice), pero `list()` no, y el resumen usa `list()`. La fuente de verdad, las tareas guardadas
(`store.listTasks({ projectId })`), no entra en el resumen.

## Solución posible

1. **`src/core/app/f5-chat.ts` (`lazyFleetPort`):** que `list()` una la cola con la base. Por cada tarea de
   `comp.store.listTasks()` que la cola no tenga, agregar su estado guardado con `fleetTaskStatus(undefined, saved)`.
   O mejor, devolver para todas `{ taskId, state, updatedAt, agentId, detail }` desde la base, en todos los estados, y
   dejar que la cola gane cuando tenga la tarea (su estado es más fresco). `withTaskProjects` ya agrega el `projectId`,
   así que el filtro por proyecto de `projectTasks` sigue igual. Ojo con tres cosas: `comp.store` es opcional en la
   firma de `lazyFleetPort` (sin almacén, `list()` sigue como hoy); `fleetTaskStatus` descarta las tareas guardadas que
   no están en `SETTLED` (`fleet-port.ts:34-35` y `:50`), así que las `pending` del Tablero no entrarían por ese camino;
   y `list()` no recibe proyecto, así que `store.listTasks()` lee las tareas de todos. Si eso pesa, se puede agregar un
   `list(projectId?)` al `FleetPort` y usar `store.listTasks({ projectId })`. Lo mismo vale para `FleetRuntime.list()`
   (`fleet-port.ts:181-183`), que usa la mente de la terminal.
2. **`src/core/conductor/tools.ts` (`fleetSummary`):** agregar `detalle` a cada fila cuando la tarea está `failed`, y un
   `siguientePaso` general si hay fallidas («reintenta con delegar <id>»), como ya hace `estado` por tarea
   (`tools.ts:324`).
3. Con eso, las tareas de P creadas desde el Tablero o desde otro chat también aparecen en el resumen después de un
   reinicio, porque están en la base con su `projectId`.

### Otras opciones

- **Rellenar la cola al arrancar** con las tareas terminadas o fallidas de la base. Arregla también al resto de las
  vistas que leen la cola, pero mezcla en la cola de trabajo tareas que nunca van a correr y puede confundir a
  `next()` y al tope de concurrencia.
- **Que `estado` sin `taskId` llame a `status(taskId)` por cada propuesta del chat.** Es un cambio de pocas líneas en
  `projectTasks`, pero sigue sin ver las tareas del Tablero y hace una consulta por tarea.
- **Avisar en la respuesta** (`aviso: 'la cola se reinició; pide estado por tarea'`) cuando hay propuestas delegadas
  sin estado. Es barato, pero solo traslada el problema a la mente.

La propuesta no es la única y puede haber una mejor. Basta con que las pruebas de abajo pasen.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:**
  - `tests/core/chat/retry-port.test.ts` (o `tests/core/chat/f5-chat.test.ts`), caso nuevo «list incluye las tareas de
    la base que la cola no tiene»: `comp` falso con `fleet.queue.list: () => []` y
    `store.listTasks: () => [{ task: { id: 'api', projectId: 'p' }, state: 'integrated', … }, { task: { id: 'ui', projectId: 'p' }, state: 'failed', detail: 'interrumpida al reiniciar el núcleo', … }]`.
    Afirmar que `await lazyFleetPort(comp).list()` trae `api` en `integrated` y `ui` en `failed` con su `detail`, las dos
    con `projectId: 'p'`.
  - `tests/core/conductor/tools.test.ts`: con `FakeFleet` y `fleet.advance('ui', 'failed', 'interrumpida al reiniciar el núcleo')`,
    `estado {}` incluye `porEstado: { failed: 1 }`, el detalle de `ui` y un `siguientePaso` con `delegar`.
  - `tests/core/chat/f5-chat.test.ts`, caso nuevo «tras reiniciar, estado {} trae las tareas de la base». Sobre un
    `compose()` real (el `setup()` del archivo): `comp.store.putProject({ id: 'demo', … })`, guardar `api` y `ui` con
    `store.putTask(brief, 'running')`, pasar `api` a `integrated` y cerrar la composición. Abrir otra con `compose()`
    sobre el mismo `ORQ_DATA_DIR` (el reinicio) y llamar a `comp2.fleet.recoverOrphans()`. Armar las herramientas con
    `createConductorTools({ ...fakePorts(), fleet: lazyFleetPort(comp2) }, { defaultProjectId: 'demo' })` y afirmar que
    `estado {}` trae `porEstado: { failed: 1, integrated: 1 }` y que `ui` lleva «interrumpida al reiniciar el núcleo».
    Hoy esa prueba ve `total: 0`. No vale hacerla con el `bench` de `tests/core/chat/helpers.ts`, porque usa una flota
    falsa (`fakePorts().fleet`) y no pasa por `lazyFleetPort`.
- **Comando** (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/chat tests/core/conductor/tools.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/chat tests/core/conductor/tools.test.ts`).
- **Verificación manual:** delegar desde un chat una tarea larga, cerrar Berland mientras corre y volver a abrirlo. En el
  mismo chat preguntar «¿cómo va la flota?». En los pasos del turno, el resultado de `estado` debe mostrar la tarea en
  `failed` con «interrumpida al reiniciar el núcleo», y la mente debe ofrecer reintentarla.
