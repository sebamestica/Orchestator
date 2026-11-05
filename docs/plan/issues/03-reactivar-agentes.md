# Issue 3 — Saber por qué se detuvo un agente y reactivarlo

Estado: hecho (salvo el plazo en Ajustes, ver al final) · Commit: uno solo, a nombre del usuario y sin trailers · Depende de: issue 1 (los reintentos de
`marketing` necesitan el modo local)

## Problema
- **No se sabe por qué falló.** La base guarda solo el estado (`store.setTaskState`, `src/core/store/store.ts:423`).
  El motivo (`detail` del cambio de estado de la cola) se pierde. La mente respondió «falló», sin causa.
- **No hay cómo reactivar.** La cola tiene `retry()` (`src/core/orchestrator/queue.ts:182`, failed → ready), pero no
  lo usa nadie: no hay ruta HTTP, herramienta de la mente ni botón. `delegar` responde «ya fue delegada; consulta su
  avance con estado» aunque la tarea esté `failed` (`src/core/conductor/tools.ts:186`).
- **Al reiniciar el núcleo** la cola (en memoria) queda vacía. Las tareas `running`/`review` de la base quedan
  huérfanas para siempre.
- **El progreso no se ve.** `updated_at` solo cambia con el estado. Una tarea con 3 sesiones seguidas por timeout
  (`nucleo-almacenamiento-local`, 18:06 → 23:39) parecía quieta, y el plazo de 60 min
  (`DEFAULT_TIMEOUT_MS`, `src/core/orchestrator/supervisor.ts:8`) corta a agentes que sí avanzan.

## Diseño
- **Motivo persistente:** columnas `detail` y `attempts` en `tasks`, con migración `ALTER TABLE` si no existen.
  `fleet-service` guarda `change.detail` (tachado con `redactSecrets`) en cada cambio. `GET /tasks` y `/tasks/:id`
  devuelven `detail`, `agentId` y la hora del último evento.
- **Reintento único:** `FleetPort.retry(taskId)` en `src/core/app/fleet-port.ts`:
  - Si la tarea está en la cola y `failed`, `queue.retry`.
  - Si no está en la cola (después de un reinicio) y en la base figura `failed`, se vuelve a encolar con su brief
    guardado.
  - Si quedó un worktree conservado (`keepFailedWorkspaces`) o la carpeta local, sigue ahí: el brief lleva la
    sección «Continuación» con el último motivo y `.orq/PLAN-TAREA.md`.
- **Ruta:** `POST /tasks/:id/retry` → `{ task }`. Responde 409 si no está `failed`, y 404 si no existe.
- **Mente:** `delegar` sobre una tarea `failed` llama a `retry` en vez de fallar. `estado` devuelve el `detail`.
- **Arranque del núcleo:** las tareas `running`/`review`/`handed_off` de la base que no están en la cola pasan a
  `failed` con «interrumpida al reiniciar el núcleo», así quedan reintentables.
- **Plazo:** el timeout de 60 min pasa a ser de inactividad. Se corta solo si el agente lleva N min sin emitir
  eventos, con un tope absoluto configurable en Ajustes (por defecto 3 h). Un agente que avanza ya no se corta a la
  hora.
- **Interfaz:** botón «Reintentar» en `TaskCard` y `TaskDetailModal` cuando la tarea está `failed`, con el motivo
  visible arriba del botón.

## Rutas propias
- Núcleo: `src/core/store/store.ts` (columnas y migración), `src/core/app/fleet-service.ts`,
  `src/core/app/fleet-port.ts`, `src/core/server/app.ts` (ruta retry), `src/core/orchestrator/supervisor.ts`
  (inactividad), `src/core/conductor/tools.ts` (delegar y estado), `tests/core/app/retry*.test.ts`,
  `tests/core/orchestrator/supervisor-idle*.test.ts`, `tests/core/store/task-detail*.test.ts`.
- Contrato (A0): `detail` y `lastEventAt` en la respuesta de tarea; ruta retry; ajuste `taskIdleTimeoutMin` /
  `taskMaxMinutes`.
- Interfaz: `src/ui/features/board/TaskCard.tsx`, `src/ui/features/board/TaskDetailModal.tsx`,
  `tests/ui/board/retry*.test.tsx`.
- `tools.ts` también lo toca el issue 2: este issue va después y parte del commit del issue 2.

## Criterios de aceptación
1. Una tarea que falla deja su motivo en la base, y `GET /tasks/:id` lo devuelve.
2. `POST /tasks/:id/retry`:
   - con la tarea `failed` en la cola, queda `ready` y corre;
   - después de un reinicio simulado (cola nueva, misma base), se reencola desde la base;
   - con la tarea `integrated` o `running`, responde 409.
3. Al arrancar, una tarea `running` huérfana queda `failed` con «interrumpida al reiniciar el núcleo».
4. `delegar` sobre una `failed` la reintenta.
5. Un agente que emite eventos cada minuto no se corta a los 60 min. Uno callado N min, sí.
6. La interfaz muestra el motivo y el botón solo en tareas `failed`.
7. `npm run -s check` en verde.

## Después de integrar
Reintentar las tareas de `marketing` (las originales o las `-b`, que son duplicados). Lo decide el usuario.

## Resultado
- **Motivo guardado.** El motivo de cada fallo queda en la base (`detail`, `attempts`, `lastEventAt`) y sale en
  `GET /tasks`. Además, las sesiones quedan enlazadas a su tarea, también las del revisor.
- **Reintento por la API.** `POST /tasks/:id/retry`:
  - si la tarea está en la cola, la reintenta ahí;
  - si no está (después de un reinicio), la reencola desde la base;
  - reusa el worktree conservado o la carpeta local.
- **Reintento por la mente.** `delegar` reintenta las tareas fallidas, también desde el chat de Berland
  (`lazyFleetPort.retry`).
- **Al arrancar.** Las tareas `ready`/`running`/`review`/`handed_off` que no están en la cola pasan a `failed` con
  «interrumpida al reiniciar el núcleo».
- **Plazo.** Se corta por inactividad (60 min sin eventos) con un tope absoluto de 3 h. Un agente que avanza ya no se
  corta a la hora.
- **Interfaz.** El motivo y el botón «Reintentar» aparecen en la tarjeta y en el detalle de las tareas fallidas.
- **Pendiente.** Llevar a Ajustes el plazo de inactividad y el tope absoluto (hoy están en `FleetTuning`).
