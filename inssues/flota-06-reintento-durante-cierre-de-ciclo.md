# Reintentar una tarea mientras su ciclo aún guarda las sesiones arranca un segundo ciclo con el mismo id y `Fleet.run` pierde la cuenta de lo que corre

- **Área:** Núcleo de la flota
- **Severidad:** media
- **Archivos:** `src/core/orchestrator/fleet.ts:762`, `src/core/orchestrator/fleet.ts:353`, `src/core/orchestrator/fleet.ts:358`, `src/core/orchestrator/fleet.ts:265`, `src/core/orchestrator/fleet.ts:273`, `src/core/orchestrator/fleet.ts:283`, `src/core/app/fleet-port.ts:143`, `src/core/app/fleet-port.ts:210`, `src/core/app/fleet-service.ts:226`, `src/core/orchestrator/queue.ts:140`, `src/core/orchestrator/queue.ts:158`, `src/core/orchestrator/queue.ts:193`
- **Estado:** abierta

## Cómo ocurre

**Contexto.** `Fleet.run` lleva en `running` (un `Map` por id de tarea) los ciclos que lanzó y sale del bucle cuando ese mapa queda vacío. `FleetRuntime.#kick` arranca `run()` al delegar o reintentar y, cuando `run()` termina, solo lo relanza si en ese momento hay alguna tarea `ready`. Nada más vuelve a despertar la flota.

**1. El estado `failed` se publica antes de que el ciclo cierre.** `#fail` mueve la tarea a `failed` dentro de `#cycle`:

```ts
// src/core/orchestrator/fleet.ts:762-764
#fail(run: TaskRun, detail: string): 'failed' {
  run.report.detail = redactSecrets(detail);
  this.#move(run.task.id, 'failed', { detail: run.report.detail });
```

Después, `#runTask` todavía guarda las sesiones y limpia. Recién al final borra el id de `#inFlight`:

```ts
// src/core/orchestrator/fleet.ts:353-358
await this.#recordSessions(run, finalOutcome);
await this.#cleanup(run, finalOutcome);
...
} finally {
  this.#inFlight.delete(task.id);
```

`recordSessions` hace E/S real. `ObsidianMemory.recordSession` (`src/core/memory/obsidian-memory.ts:264-266`) espera en la cola de la instancia y luego toma el candado de la bóveda (`exclusive`, `obsidian-memory.ts:234-241`), que reintenta hasta 30 s si otro escritor lo tiene (`src/core/fs/dir-lock.ts:123`). Después lee y escribe varias notas. Hay una llamada por cada autor de la tarea. Así, la ventana va de decenas de ms a varios segundos.

**2. El reintento solo mira el estado.** El botón «Reintentar» aparece en cuanto la tarjeta está `failed` (`src/ui/features/board/TaskCard.tsx:129` y `139-144`). `FleetService.retry` (`fleet-service.ts:225-226`) y `FleetRuntime.retry` (`fleet-port.ts:141-143`) solo exigen `state === 'failed'`, y lo mismo hace el `delegar` de la mente (`src/core/conductor/tools.ts:261-263`). Ninguno consulta `fleet.inFlight()`. Entonces `queue.retry` pasa la tarea de `failed` a `ready` (`queue.ts:193-195`).

**3. `run()` lanza un segundo ciclo con el mismo id.** El cambio a `ready` despierta el bucle. En modo worktree, `canStart` no protege, porque `exclusiveKey` devuelve `undefined` (`src/core/app/workspaces.ts:99-101`; `fleet.ts:265-268`). La tarea ya no cuenta como activa, así que `next()` la entrega. Se lanza un segundo `#runTask` y su job pisa al primero en el mapa:

```ts
// src/core/orchestrator/fleet.ts:273-280
const job = this.#runTask(task)
  ...
  .finally(() => {
    running.delete(id);
    this.#exclusive.delete(id);
  });
running.set(id, job);
```

El bucle queda esperando `Promise.race([job2, woken])` (`fleet.ts:287`).

**4. El primer ciclo borra la entrada del segundo.** Cuando el primer ciclo termina de guardar, su `finally` hace `#inFlight.delete(id)` (`fleet.ts:358`) y `running.delete(id)` (`fleet.ts:277`). Esto pasa aunque el segundo ciclo siga vivo. Ahora `running` no contiene al segundo ciclo, y el bucle no lo sabe.

**Corrección al informe original.** Si no hay más tareas, `run()` **no** sale enseguida. El bucle sigue bloqueado en la carrera que incluye a `job2`, y cuando la segunda pasada integra, el cambio a `ready` del dependiente lo despierta y lo arranca. El daño aparece cuando el bucle da otra vuelta mientras el segundo ciclo sigue suelto:

- **Variante A: dependientes varados (concurrencia ≥ 2).** Otra tarea X que corría a la vez termina antes que la segunda pasada de A. La carrera resuelve, `running` está vacío y el bucle sale por `if (running.size === 0) break;` (`fleet.ts:283`). En ese momento no hay nada `ready`, porque A está `running` y su dependiente B está `pending`, así que `#kick` no relanza (`fleet-port.ts:210`). Luego A integra y B pasa a `ready` (`queue.ts:157-158`), pero ya no queda ningún `run()` escuchando. B sigue `ready` sin arrancar hasta la próxima delegación o reintento, o hasta reiniciar el núcleo.
- **Variante B: núcleo colgado (concurrencia 1, permitida por `src/shared/api.ts:60`).** Mientras la segunda pasada de A corre suelta, se delega o aprueba otra tarea D. D pasa a `ready`, el bucle despierta y `next()` devuelve `undefined`, porque A ocupa el único cupo (`queue.ts:140`). `running` está vacío, así que `run()` sale sin haber hecho ningún `await`. El `finally` de `#kick` ve a D `ready` y llama otra vez a `#kick` (`fleet-port.ts:210`). El nuevo `run()` repite lo mismo, y así sin fin, solo con microtareas. El event loop no vuelve a atender E/S: se congelan el servidor HTTP y `/ws`, y la propia pasada de A nunca avanza. Hay que reiniciar el núcleo.

Otros efectos: el informe de la segunda pasada se pierde, porque se agrega a `reports` de un `run()` que ya devolvió. Además, `inFlight()` deja de contar la segunda pasada durante su cierre (registro y limpieza), y `activeTasks` (`fleet-service.ts:343-348`) se apoya en ese dato.

En modo local no pasa. La clave exclusiva del primer ciclo sigue en `#exclusive` hasta su `finally`, y `canStart` bloquea el reintento hasta que el primer ciclo termina.

## Por qué pasa

Hay dos defectos que se combinan:

1. El estado terminal reintentable (`failed`) se publica dentro de `#cycle` (`fleet.ts:762-764`), antes de que `#runTask` termine (`fleet.ts:353-358`). Ninguna guardia impide reintentar mientras el id sigue en `#inFlight` (`fleet-port.ts:143`, `fleet-service.ts:226`, `fleet.ts:265-268`).
2. `running`, `#exclusive` y `#inFlight` se indexan solo por id de tarea, y el `finally` de cada job borra la entrada sin comprobar que sea la suya (`fleet.ts:276-279`, `fleet.ts:358`). Un segundo ciclo con el mismo id queda fuera de la cuenta con la que `run()` decide si salir (`fleet.ts:283`).

## Solución posible

Evitar el doble ciclo y, además, blindar los mapas:

1. **No arrancar una tarea cuyo ciclo anterior sigue abierto.** En `src/core/orchestrator/fleet.ts`, dentro de `run()`, se agrega la condición a `canStart`:
   ```ts
   const canStart = (t: TaskBrief) => {
     if (this.#inFlight.has(t.id)) return false; // su ciclo anterior aún guarda sesiones o limpia
     const key = this.#keyOf(t);
     return key === undefined || ![...this.#exclusive.values()].includes(key);
   };
   ```
   La tarea reintentada queda `ready`. El primer job sigue en `running` y en la carrera, así que cuando termina el bucle despierta y la arranca. No se rechaza nada al usuario.
2. **Defensa en los `finally`.** En `fleet.ts:276-279`, borrar la entrada solo si es la del mismo job:
   ```ts
   .finally(() => {
     if (running.get(id) === job) running.delete(id);
     if (this.#exclusiveOwner.get(id) === job) { this.#exclusive.delete(id); this.#exclusiveOwner.delete(id); }
   });
   ```
   Para `#inFlight`, que es un `Set` de ids, conviene un contador por id o un token por ciclo, para que el `finally` de `#runTask` (`fleet.ts:358`) no borre el de otro ciclo.
3. Opcional, para la interfaz y la mente: en `FleetRuntime.retry` (`src/core/app/fleet-port.ts`, después de la línea 143), si `this.#fleet.inFlight().includes(taskId)`, responder con un detalle «la tarea está cerrando su ciclo; arrancará al terminar», o diferir el `queue.retry` hasta ese momento. Con el punto 1 no hace falta para la corrección, pero deja claro al usuario por qué la tarea sigue `ready` unos segundos.

### Otras opciones

- **Publicar `failed` al final de `#runTask`.** `#fail` solo anota el motivo y la transición se hace después de `#recordSessions` y `#cleanup`. Es lo más limpio conceptualmente, porque «fallida» significaría «ciclo cerrado». Pero cambia lo que la interfaz ve durante unos segundos y obliga a revisar todos los caminos que hoy llaman a `#fail` o a `#overBudget` dentro de `#cycle`.
- **Rechazar el reintento con `conflict`** mientras el id esté en `inFlight()`. Es simple, pero empeora la experiencia: el botón aparece y falla. A la mente le daría un error transitorio que tendría que reintentar.
- **Identificar cada ciclo con un token** (`Map<string, symbol>`) para `running`, `#exclusive` e `#inFlight`, en lugar de usar el id. Así se tolerarían dos ciclos con el mismo id, aunque igual competirían por el worktree conservado. Por eso conviene combinarlo con el punto 1.
- **Contra el bucle sin fin:** `#kick` solo debería relanzar si el `run()` que terminó arrancó algo o si `queue.next()` podría entregar una tarea. Por ejemplo, comprobar `queue.active < queue.concurrency` además de que haya alguna `ready`. Con eso, aunque reaparezca otra forma de descuadre, el núcleo no se congela.

La propuesta no es la única. La combinación más sólida es el punto 1 junto con la guardia de `#kick`. Corta la causa y también el peor síntoma.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:** `tests/core/orchestrator/fleet-reintento-cierre.test.ts`. Arma `Fleet` a mano con `TaskQueue`, `Router`, `Supervisor` y `FakeWorkspaces` de `tests/core/orchestrator/fakes.ts`, y una memoria falsa cuyo primer `recordSession` espera una promesa controlada (`let release; new Promise(r => release = r)`).
  1. *Sin doble ciclo:* concurrencia 2. Una tarea A con guion `[{ done: false }]` en la primera llamada y `okScript()` en la siguiente; B con `dependsOn: ['A']`; X con un `wait` largo. Arrancar `fleet.run()`. Cuando A llega a `failed` y el `recordSession` está retenido, llamar `queue.retry('A')`. Afirmar que A sigue `ready`, que `fleet.inFlight()` incluye `A` y que el adaptador no recibió una segunda llamada para A. Soltar `release()`. Afirmar que A se ejecuta una sola vez más, que B llega a `integrated` y que la promesa de `run()` resuelve solo después de que A y B están `integrated`. Hoy, si X termina antes que la segunda pasada de A, `run()` resuelve con A `running` y B queda `ready`.
  2. *Sin bucle sin fin:* concurrencia 1, misma retención de `recordSession`. Reintentar A dentro de la ventana, soltarla y agregar una tarea D a la cola mientras corre la segunda pasada. Afirmar que `run()` no resuelve mientras `queue.state('A') === 'running'` (con un indicador y `await delay(...)`), y que al final A y D quedan `integrated`. No usar `FleetRuntime` en la versión que falla, porque con el código actual la prueba se colgaría en un bucle de microtareas. Para cubrir la guardia de `#kick`, sí usar `FleetRuntime` después del arreglo, con un `timeout` de vitest corto.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/orchestrator/fleet-reintento-cierre.test.ts"`. Desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/orchestrator/fleet-reintento-cierre.test.ts`.
- **Verificación manual en la app:** proyecto con worktrees y concurrencia 2. Lanzar una tarea A que falle, con una dependiente B, y otra tarea larga X. Pulsar «Reintentar» en A apenas aparezca el botón, mejor si la bóveda está ocupada (otra tarea cerrando a la vez). Cuando X termine antes que A, comprobar que, al integrarse A, B pasa a `running` sola, sin tener que delegar nada más.
