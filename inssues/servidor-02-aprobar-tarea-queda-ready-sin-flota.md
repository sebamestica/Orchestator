# Aprobar una tarea guarda `ready` antes de que la flota la acepte: si la flota la rechaza, queda `ready` fuera de la cola y el servidor responde 500

- **Área:** Servidor, API y contratos
- **Severidad:** media
- **Archivos:** `src/core/server/app.ts:245-252`, `src/core/server/app.ts:147`, `src/core/server/app.ts:492`, `src/core/app/fleet-service.ts:320-324`, `src/core/app/fleet-port.ts:116-127`, `src/core/app/fleet-port.ts:195-198`, `src/core/orchestrator/queue.ts:92`, `src/core/app/f5-servidor.ts:275`, `src/core/chat/service.ts:902-927`, `src/ui/features/board/TaskDetailModal.tsx:44-60`
- **Estado:** resuelta

## Cómo ocurre

Contexto: en el tablero, una tarea `pending` espera aprobación. Al aprobarla, el servidor la pasa a `ready` en SQLite
y llama al gancho `tasks.onApproved`. En producción ese gancho es `FleetService.hooks()` (`src/core/app/compose.ts:198`),
que la entrega a la cola de la flota con `FleetRuntime.delegate`. La cola solo acepta una tarea si cada dependencia
ya está en la cola o integrada en la base.

`approve()` en `src/core/server/app.ts:245-252` escribe el estado antes de llamar a la flota, y no deshace nada si
la flota la rechaza:

```ts
const approve = async (task: TaskRecord, agentId?: string): Promise<TaskRecord> => {
  if (task.state !== 'pending') throw new ApiError(409, 'conflict', ...);
  if (agentId) registry.require(agentId);
  const saved = store.setTaskState(task.task.id, 'ready', agentId);                        // 248
  await callService('orquestación', async () => deps.tasks?.onApproved?.(saved));         // 249
  hub.publishTask(saved);                                                                  // 250
  return saved;
};
```

Pasos concretos:

1. Hay dos tareas `pending` en el tablero, A y B, con B `dependsOn: ['A']`. Pueden venir de `POST /plans`, de
   `POST /tasks` o de una entrega del chat que la flota rechazó. En ese último caso `#deliver` las devuelve a `pending`
   (`src/core/chat/service.ts:921`).
2. El usuario abre B en el tablero y pulsa Aprobar. `TaskDetailModal` hace `POST /tasks/B/approve`
   (`src/ui/features/board/TaskDetailModal.tsx:49`). La interfaz no avisa de que A sigue sin aprobar.
3. `approve()` guarda B como `ready` (`app.ts:248`) y llama a `onApproved` → `delegate`. `#withLiveDeps` solo quita las
   dependencias integradas en la base (`fleet-port.ts:195-198`). A está `pending` y no está en la cola, así que
   `queue.add` lanza `La tarea B depende de A, que no está en la cola.` (`queue.ts:92`). `delegate` atrapa el error y
   devuelve `{ accepted: false }` (`fleet-port.ts:119-123`).
4. `onApproved` lo convierte en un `Error` sin `code`: `if (!result.accepted) throw new Error(result.reason);`
   (`fleet-service.ts:323`). `callService` lo traduce a `500 internal` (`app.ts:147`). No se ejecuta
   `hub.publishTask` (`app.ts:250`) ni hay compensación.
5. Resultado:
   - En SQLite, B queda `ready` pero no está en la cola: nunca va a correr.
   - La interfaz muestra un error 500. Como la ruta falló, no hay difusión ni `refreshTasks`, así que el modal sigue
     mostrando `pending` con el botón Aprobar activo. Si se pulsa otra vez, responde `409 La tarea B está en estado ready`.
   - Al refrescar, B aparece `ready` en el tablero sin avanzar.
   - B bloquea `DELETE /projects/:id`, porque `ready` está en `ACTIVE_STATES` (`app.ts:129` y `app.ts:436`).
   - Tras reiniciar el núcleo, `recoverOrphans` la marca `failed` «interrumpida» (`fleet-service.ts:71` y
     `fleet-service.ts:238-250`).
   - Solo se recupera cancelándola (`onCancel` devuelve `true` para una tarea que la cola no conoce,
     `fleet-service.ts:329`). Después hay que volver a crearla, porque una tarea cancelada no se aprueba de nuevo.

El mismo hueco aparece con cualquier rechazo de `delegate` (`La flota se está deteniendo`, una dependencia
inexistente puesta a mano por `POST /tasks`, un ciclo con tareas de la cola) y con un fallo al armar la flota
(`await this.port()` en `fleet-service.ts:322`). Afecta a tres rutas:

- `POST /tasks/:id/approve` (`app.ts:554`).
- `POST /tasks/manual` con `approve` (por defecto `true`), que reutiliza la misma función (`f5-servidor.ts:275`). Aquí
  `dependsOn` siempre es `[]`, así que solo la alcanzan los rechazos que no dependen de dependencias.
- `POST /plans/:id/approve` (`app.ts:492`): `for (const t of tasks) if (t.state === 'pending') await approve(t);`.
  Las tareas salen en el orden en que el planificador las listó (`store.ts:400` inserta en ese orden y `store.ts:449`
  ordena por `created_at, rowid`). `validatePlan` (`src/core/orchestrator/plan.ts:87-160`) no las reordena. Si el
  planificador pone B antes que A, el bucle falla en B con 500, B queda `ready` huérfana y A ni siquiera se aprueba.
  Si se repite la llamada, se aprueba A, pero B (ya `ready`) se salta y sigue fuera de la cola.

La entrega desde el chat sí compensa: si la flota no acepta, vuelve a `pending` (`src/core/chat/service.ts:918-925`).
La ruta REST no lo hace.

Efecto secundario cuando la flota sí acepta: `approve()` difunde y devuelve `saved`, que se leyó antes del gancho
(`app.ts:248-251`). Dentro de `delegate`, la cola ya emitió sus cambios y `#copyChange` los guardó y difundió
(`fleet-service.ts:144-160`). Si B espera dependencias, queda `pending`. Si había cupo, también pasa a `running`, porque
`#kick` llama a `fleet.run`, que toma la tarea con `queue.next` antes de su primer `await` (`fleet-port.ts:124` y
`fleet.ts:269`). Aun así, el último mensaje por `/ws` dice `ready`, y la interfaz guarda el último mensaje sin mirar
`updatedAt` (`src/ui/store/app.ts:89-90`). En el tablero el daño es menor, porque después del éxito se llama a
`refreshTasks()` (`BoardView.tsx:207-209`), que lee el estado real. Pero la respuesta HTTP y cualquier otro cliente del
hub ven un estado viejo. La ruta de reintento ya relee la tarea después del gancho (`app.ts:601`); la de aprobar no.

## Por qué pasa

- El estado `ready` se escribe antes de que la orquestación confirme, y no se revierte si el gancho falla
  (`app.ts:248-249`).
- El rechazo de la flota (`accepted: false`) se convierte en un `Error` genérico sin `code` (`fleet-service.ts:323`).
  Por eso `callService` responde 500 en vez de 409, aunque es un conflicto de estado previsible.
- `approve()` difunde y devuelve una foto tomada antes de los cambios que la cola hace dentro del gancho (`app.ts:250-251`).
- `POST /plans/:id/approve` aprueba una por una en el orden guardado, sin tener en cuenta las dependencias (`app.ts:492`).

## Solución posible

1. `src/core/app/fleet-service.ts:323`: cuando la flota no acepte, lanzar un error con `code: 'conflict'`, por ejemplo
   `throw Object.assign(new Error(result.reason), { code: 'conflict' })`. Así `callService` responde 409 con el motivo.
2. `src/core/server/app.ts:245-252` (`approve`): guardar el agente previo (`task.agentId`). Si el gancho lanza un error,
   devolver la tarea a `pending` y propagar el error:
   ```ts
   const saved = store.setTaskState(id, 'ready', agentId);
   try {
     await callService('orquestación', async () => deps.tasks?.onApproved?.(saved));
   } catch (err) {
     const back = store.setTaskState(id, 'pending', agentId ? (task.agentId ?? null) : undefined);
     hub.publishTask(back);
     throw err;
   }
   const fresh = requireTask(id);   // lo que dejó la cola (#copyChange): ready, pending o running
   hub.publishTask(fresh);
   return fresh;
   ```
   La reversión es segura: cuando `queue.addAll` lanza un error, todavía no tocó la cola, porque valida antes de insertar
   (`queue.ts:84-97`).
3. `src/core/server/app.ts:492` (`POST /plans/:id/approve`): aprobar en orden topológico con `topologicalOrder` de
   `src/core/orchestrator/graph.ts:67`, que es estable y respeta el orden de entrada. Si una aprobación falla, cortar con
   el error (las ya aprobadas siguen bien, y la fallida vuelve a `pending` gracias al punto 2).

### Otras opciones

- **Validar antes de escribir:** antes del `setTaskState`, comprobar que cada dependencia esté en la cola o integrada.
  Haría falta exponer algo como `canDelegate` en `TaskHooks`. Esto evita el estado intermedio, pero duplica la regla
  de `#withLiveDeps` y `queue.addAll`, y no cubre los fallos que aparecen después (flota deteniéndose, error al armarla).
  Igual haría falta la compensación.
- **Que `approve()` no escriba el estado:** dejar que la única escritura de `ready` sea `#copyChange` y que `approve()`
  solo fije el agente. Así el almacén nunca diría `ready` sin cola. A cambio, sin gancho de flota (tests, arranques sin
  flota) la tarea no cambiaría de estado. Además, entre el `await` y la escritura de la cola, dos aprobaciones
  simultáneas pasarían ambas la guardia `pending`; la segunda fallaría en la cola con `ya está en la cola`, que es
  inocuo pero ruidoso.
- **Plan en lote:** para `/plans/:id/approve`, entregar todas las tareas pendientes juntas con `queue.addAll` (acepta
  dependencias dentro del mismo lote, `queue.ts:84-97`) mediante un gancho `onApprovedMany`. Es más atómico que el orden
  topológico, pero amplía el contrato de `TaskHooks` y de `FleetRuntime`.
- **Interfaz:** además, `TaskDetailModal` podría desactivar Aprobar mientras haya dependencias `pending` y mostrar cuáles
  faltan. Eso mejora la experiencia, pero no reemplaza la corrección en el servidor (la API se puede llamar directamente).

La propuesta no es la única. La versión más simple es la compensación más el código `conflict`, que alinea la ruta REST
con lo que ya hace el chat en `#deliver`.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta: `tests/core/server/approve-rechazo.test.ts`. Usa `createApp` con un `SqliteStore` en
  memoria, como `tests/core/server/helpers.ts`, o agrega a `TestAppOptions` una opción `tasks` para inyectar ganchos.
  Escenarios:
  1. `onApproved` lanza `Object.assign(new Error('La tarea b depende de a, que no está en la cola.'), { code: 'conflict' })`.
     Se espera que `POST /tasks/b/approve` responda 409 con ese motivo, que `GET /tasks/b` siga en `pending` sin
     `agentId` nuevo y que el último mensaje del hub para `b` diga `pending`.
  2. `onApproved` llama a `store.setTaskState(id, 'pending')` (simula `#copyChange` cuando hay dependencias sin terminar).
     Se espera que la respuesta y el último mensaje del hub digan `pending`, no `ready`.
  3. Con el planificador falso, un plan `[b (dependsOn a), a]` y un `onApproved` que rechace si la dependencia no se
     aprobó antes. Se espera que `POST /plans/:id/approve` deje las dos `ready` y que el gancho reciba primero `a` y
     luego `b`.
  4. De punta a punta con `FleetService` real: aprobar `b` mientras `a` está `pending` debe responder 409 y dejar `b` en
     `pending` en la base y fuera de `fleet.queue`.
- Comando (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/server/approve-rechazo.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/server/approve-rechazo.test.ts`). Correr
  también `tests/core/server/routes.test.ts`, que ya cubre la aprobación normal del plan y de la tarea suelta.
- Verificación manual en la app: crear dos tareas donde B depende de A, abrir B en el tablero y pulsar Aprobar sin
  aprobar A. Debe aparecer un aviso 409 con el motivo, y B debe seguir en Pendientes y poder aprobarse después de A.
  Con el proyecto sin otras tareas activas, `DELETE /projects/:id` no debe responder 409 por B.
