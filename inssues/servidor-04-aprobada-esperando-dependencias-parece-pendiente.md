# Una tarea aprobada que espera a sus dependencias vuelve a `pending` en la base: el tablero la muestra «Pendiente» con el botón Aprobar, y aprobarla da 500 y deja la base distinta de la cola

- **Área:** Servidor, API y contratos
- **Severidad:** media
- **Archivos:** `src/core/app/fleet-service.ts:144-160`, `src/core/orchestrator/queue.ts:99-103`, `src/core/orchestrator/queue.ts:225-230`, `src/core/orchestrator/queue.ts:87`, `src/core/app/fleet-port.ts:116-127`, `src/core/app/fleet-service.ts:320-324`, `src/core/server/app.ts:245-252`, `src/core/server/app.ts:137-148`, `src/core/server/app.ts:490-494`, `src/core/chat/service.ts:902-927`, `src/core/app/fleet-service.ts:71`, `src/core/app/fleet-service.ts:238-242`, `src/shared/tasks.ts:22`, `src/ui/features/board/types.ts:10`, `src/ui/features/board/TaskDetailModal.tsx:38`, `src/ui/features/board/TaskDetailModal.tsx:285-296`
- **Estado:** resuelta

## Cómo ocurre

Contexto: en SQLite, `pending` quiere decir «propuesta, sin aprobar». Cuando el usuario (o la mente) aprueba una tarea,
la base la pasa a `ready` y la tarea entra en la cola de la flota (`TaskQueue`). La cola usa el mismo enum de estados
(`taskStateSchema`, `src/shared/tasks.ts:22`), pero ahí `pending` quiere decir otra cosa: «en la cola, esperando a que se
integren sus dependencias». `FleetService` copia cada cambio de la cola a la base tal cual, sin traducirlo.

Pasos (con A y B del mismo proyecto, B con `dependsOn: ['A']`):

1. Se aprueban A y B: desde el chat con «Aprobar todas» o en modo auto (`approveAndDeliver`, que entrega en orden de
   dependencias, o la herramienta `delegar` de la mente), desde `POST /plans/:id/approve`, o con el botón Aprobar del
   tablero, primero A y después B.
2. Para B, la mente pasa por `#deliver` (`src/core/chat/service.ts:909`), que guarda `ready` y lo difunde. Por HTTP,
   `approve()` hace lo mismo (`src/core/server/app.ts:248`). Después se llama a `FleetRuntime.delegate` →
   `queue.add(B)` (`src/core/app/fleet-port.ts:120`).
3. `addAll` mete B como `pending` y emite el cambio `null → pending` (`src/core/orchestrator/queue.ts:101-102`):
   ```ts
   this.#entries.set(t.id, { task: t, state: 'pending', updatedAt: ... });
   changes.push(this.#change(t.id, null, 'pending'));
   ```
   `#promoteIfReady` no la pasa a `ready` porque A no está `integrated` (`queue.ts:228`).
4. `#copyChange` escribe ese `pending` en SQLite y lo difunde. No mira `from` ni lo que ya tenía la base
   (`src/core/app/fleet-service.ts:151-156`):
   ```ts
   if (!store.getTask(change.taskId)) return;
   const saved = store.setTaskState(change.taskId, change.to, change.agentId, { detail: change.detail ?? null, ... });
   this.#publish(saved);
   ```
   `setTaskState` no tiene ninguna guardia contra ese retroceso (`src/core/store/store.ts:457-479`).
5. El tablero pone B en la columna «Pendiente» (`src/ui/features/board/types.ts:10`), y el detalle le muestra el
   selector de agente y el botón **Aprobar** (`TaskDetailModal.tsx:38`, `:226`, `:285-296`), como a una tarea que nadie
   aprobó. En el chat, en cambio, la propuesta figura `delegated`.
   - Por la ruta de la mente, el último mensaje por `/ws` es el `pending` de `#copyChange`.
   - Por la ruta HTTP, `approve()` difunde después el registro viejo con `ready` (`app.ts:250`), así que la interfaz
     muestra un momento «Lista» mientras la base dice `pending`. La respuesta de `POST /plans/:id/approve` (relee la base,
     `app.ts:493`) ya trae B como `pending`. Al recargar el tablero aparece «Pendiente».
6. Si el usuario pulsa Aprobar en B: `approve()` pasa la guardia porque la base dice `pending` (`app.ts:246`), guarda
   `ready` (`app.ts:248`) y llama a `onApproved` → `delegate` → `queue.add(B)`. Esa llamada lanza
   `La tarea B ya está en la cola.` (`queue.ts:87`). `delegate` lo devuelve como `accepted: false`
   (`fleet-port.ts:121-122`), `onApproved` lo convierte en un `Error` sin `code` (`fleet-service.ts:323`) y
   `callService` responde **500 `internal`** (`app.ts:147`). El `ready` ya guardado no se deshace: la base dice `ready`
   y la cola sigue en `pending`. Pasa lo mismo si se repite `POST /plans/:id/approve`, que reintenta toda tarea
   `pending` del plan (`app.ts:492`).
7. Tras reiniciar el núcleo sin haber tocado B, B queda `pending` en la base y fuera de la cola. `recoverOrphans` no la
   marca como interrumpida, porque `ORPHAN_STATES` no incluye `pending` (`fleet-service.ts:71`, `:242`). Parece una
   tarea sin aprobar. La mente tampoco puede volver a entregarla: para una propuesta `delegated`, `delegar` pide
   `status(B)`. Esa llamada devuelve `undefined`, porque la cola no la tiene y `pending` no está entre los estados
   `SETTLED` de `fleet-port.ts:35`. Luego `retry` la rechaza porque «solo se reintenta una tarea fallida»
   (`fleet-port.ts:143`), y `delegar` termina con «ya fue delegada» (`src/core/conductor/tools.ts:258-277`).

Ninguna prueba cubre este caso. `tests/core/app/retry-service.test.ts:42` incluso fija que una tarea ya `ready` en la
base se difunde como `['pending', 'ready', ...]` al entrar en la cola: el retroceso a `pending` está aceptado. Para una
tarea sin dependencias no se nota, porque vuelve a `ready` en el mismo lote. Ninguno de los issues 1 a 13 de
`docs/plan/issues` toca esto.

## Por qué pasa

- El contrato tiene un solo `pending` para dos cosas distintas: «sin aprobar» en la base y «aprobada, esperando
  dependencias» en la cola.
- `FleetService.#copyChange` (`fleet-service.ts:144-160`) copia a la base el estado de la cola sin traducirlo. Así, una
  tarea que la base ya tenía como `ready` (aprobada) vuelve a «sin aprobar».
- `approve()` (`app.ts:245-252`) solo mira el estado de la base. No pregunta si la flota ya tiene la tarea, y guarda
  `ready` antes de que la flota la acepte, sin deshacerlo si la flota la rechaza.

## Solución posible

1. **No degradar en la base una tarea ya aprobada** (`src/core/app/fleet-service.ts`, `#copyChange`). Para un cambio
   `from === null && to === 'pending'`, si la tarea guardada no está `pending` (la aprobaron: `ready`), conservar `ready`
   y guardar solo el motivo, por ejemplo `esperando a A` con las dependencias que faltan (`queue.get(id).task.dependsOn`
   filtradas por estado distinto de `integrated`). Lo cómodo es que `addAll` ya ponga ese `detail` en el cambio
   `null → pending` cuando no promueve (`queue.ts:101-102` y `:113`). Así el motivo también llega a
   `FleetRuntime.#details` y a `estado` de la mente.
   - Efecto extra: tras un reinicio, B queda `ready` fuera de la cola y `recoverOrphans` la pasa a `failed` «interrumpida
     al reiniciar el núcleo». Queda reintentable, y `FleetRuntime.retry` ya revisa que sus dependencias estén integradas
     o en la cola (`fleet-port.ts:154-158`). Con eso se cierra también el paso 7.
   - Hay que actualizar `tests/core/app/retry-service.test.ts:42`, que espera la difusión `pending` intermedia.
2. **`approve()` no debe aprobar dos veces** (`src/core/server/app.ts`). Agregar a `TaskHooks` (`app.ts:38-57`) un gancho
   `queued?(taskId): boolean`, que en `FleetService.hooks()` sea `this.queue.get(id) !== undefined`. El gancho que ya
   existe, `activeTasks`, no sirve: solo lista `LIVE_STATES` (`fleet-service.ts:68`, `:346`), sin `pending`. Si la cola
   ya la tiene, responder **409** «ya aprobada: espera a sus dependencias» antes de `setTaskState`.
3. Como defensa extra, en `approve()`, si `onApproved` lanza, devolver la tarea a `pending` (o a su estado anterior)
   antes de propagar el error, como ya hace `#deliver` (`chat/service.ts:919-925`).
4. En la interfaz, mostrar `detail` también para `ready` (hoy solo se ve en `failed`: `TaskCard.tsx:129-134`,
   `TaskDetailModal.tsx:125-140`), para que se lea «Esperando a A».

### Otras opciones

- **Estado propio en el contrato:** agregar `waiting` (o `blocked`) a `taskStateSchema` (`src/shared/tasks.ts:22`) y
  usarlo en la cola en lugar de `pending`, con una columna «Esperando dependencias» en `BOARD_COLUMNS`. Es lo más claro
  para el usuario y separa los dos significados de raíz, pero cambia el contrato, `TRANSITIONS` de la cola, los
  esquemas de respuesta, la API documentada, el store de la interfaz y varias pruebas. Si alguna tabla de SQLite
  restringe los valores del estado, también hace falta una migración.
- **Traducir solo al guardar:** dejar la cola como está y mapear `pending` (de la cola) → `ready` en `#copyChange`
  siempre que la tarea exista en la cola. Es el cambio más chico, pero borra la diferencia «Lista para correr» /
  «Esperando», y la columna «Lista» mezclaría las dos.
- **Ocultar en la interfaz:** que el tablero no muestre Aprobar si la tarea ya tiene sesión o intentos. Es frágil (una
  tarea esperando no tiene ninguno de los dos) y no arregla la base ni el 500.

La propuesta no es la única. La versión más limpia a largo plazo probablemente sea el estado `waiting` en el contrato.
La propuesta 1+2 es la de menos superficie, porque no toca el contrato.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:** agregar un `describe` en `tests/core/app/retry-service.test.ts` (ya tiene el
  armado `service()` con `FleetService`, SQLite en memoria y un publicador falso), o crear
  `tests/core/app/fleet-dependencias.test.ts`:
  1. `store.putTask(task('A'), 'ready')` y `store.putTask(task('B', { dependsOn: ['A'] }), 'ready')`.
  2. `fleet.queue.add(task('A'))`, `fleet.queue.next()` (A queda `running`) y `fleet.queue.add(task('B', { dependsOn: ['A'] }))`.
  3. Afirmar que `store.getTask('B')?.state` es `ready` (no `pending`), que su `detail` menciona `A`, y que ningún
     registro difundido de B tiene `state: 'pending'`.
  4. Llevar A a `review` → `integrated` y afirmar que B pasa a `ready` en la cola y en la base, y que `next()` la entrega.
  5. Con el servidor (`createApp` con `deps.tasks = fleet.hooks()` o con ganchos falsos donde `queued('B')` devuelve
     `true`): `POST /tasks/B/approve` debe responder **409** y `store.getTask('B')` no debe cambiar (mismo estado y
     `updatedAt`).
  6. Ajustar la expectativa de `retry-service.test.ts:42` al nuevo comportamiento.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/app/retry-service.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/app/retry-service.test.ts`). Después,
  `npm run -s check`.
- **Verificación manual en la app:** en un proyecto de prueba, pedir a la mente dos tareas con B dependiente de A y
  aprobarlas con «Aprobar todas». Mientras A corre, B no debe aparecer en «Pendiente» ni ofrecer el botón Aprobar, y al
  recargar el tablero debe seguir igual. Si se fuerza `POST /tasks/B/approve`, la respuesta debe ser 409, no 500. Al
  integrarse A, B debe empezar sola.
