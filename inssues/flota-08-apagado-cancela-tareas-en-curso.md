# Detener el núcleo con Ctrl+C en `iniciar` deja las tareas en curso y sus dependientes `cancelled`, sin poder reintentarlas

- **Área:** Núcleo de la flota
- **Severidad:** baja
- **Archivos:** `src/core/orchestrator/fleet.ts:248`, `src/core/orchestrator/fleet.ts:406`, `src/core/orchestrator/fleet.ts:418`, `src/core/orchestrator/fleet.ts:768`, `src/core/orchestrator/queue.ts:160`, `src/core/orchestrator/queue.ts:236`, `src/core/app/fleet-port.ts:186`, `src/core/app/fleet-service.ts:71`, `src/core/app/fleet-service.ts:242`, `src/core/app/fleet-port.ts:143`, `src/core/app/compose.ts:234`, `src/core/app/cli.ts:51`, `src/core/app/cli-commands.ts:130`
- **Estado:** resuelta

## Cómo ocurre

Contexto: el núcleo se puede lanzar a mano con `node src/core/app/cli.ts iniciar`. Las tareas aprobadas entran a la cola
de la flota (`TaskQueue`), y `FleetService` copia cada cambio de estado de la cola a la tabla `tasks` de SQLite
(`#copyChange`). Si una tarea termina `failed`, el botón «Reintentar» del tablero (`src/ui/features/board/TaskCard.tsx:22`
y `:129`) y `POST /tasks/:id/retry` la vuelven a poner en marcha. Si termina `cancelled`, queda así para siempre:
`cancelled: []` en la tabla de transiciones (`src/core/orchestrator/queue.ts:16`), no se reintenta (solo `failed`) y no
se vuelve a aprobar (solo `pending`, `src/core/server/app.ts:246`).

El núcleo trata distinto dos formas de pararlo que deberían dar lo mismo:

- **Cierre brusco** (`taskkill /F`, que es lo que usa la app de escritorio, `apps/desktop/src/core-supervisor.ts:59`): en
  la base las tareas siguen `running`/`review`/`ready`. Al arrancar otra vez, `recoverOrphans` las pasa a `failed` con
  «interrumpida al reiniciar el núcleo» y se pueden reintentar (`src/core/app/fleet-service.ts:71-73`, `:242-244`).
- **Apagado ordenado** (Ctrl+C en la consola de `iniciar`): las tareas quedan `cancelled`, y en cascada también todas sus
  dependientes que estaban `pending`.

Pasos:

1. `node src/core/app/cli.ts iniciar`. Aprobar la tarea A y la tarea B, que depende de A. A pasa a `running` y B queda
   `pending` en la cola.
2. Ctrl+C. `waitForStop` se resuelve (`src/core/app/cli.ts:68`), corre `core.stop()` (`cli-commands.ts:132`; no cierra
   el almacén porque es de la composición) y luego el `finally` de `runCli` llama a `comp.shutdown()` (`cli.ts:51`):
   ```ts
   async shutdown() {
     await fleet.stop();   // compose.ts:234
     close();
   },
   ```
   `FleetService.stop()` → `FleetRuntime.stop()` aborta la señal que se le pasó a `Fleet.run` (`fleet-port.ts:186-189`,
   `:204`).
3. `Fleet.run` aborta el controlador de cada tarea en curso (`fleet.ts:248-250`):
   ```ts
   const onAbort = () => {
     for (const controller of this.#controllers.values()) controller.abort();
   };
   ```
4. El ciclo de A ve la señal abortada y sale por `#cancelled`, sea en la ejecución (`fleet.ts:406`), en la revisión
   (`fleet.ts:418`) o antes de integrar (`fleet.ts:430`):
   ```ts
   if (exec.outcome === 'cancelled' || signal.aborted) return this.#cancelled(run, exec.error);
   ...
   #cancelled(run: TaskRun, detail = 'cancelada'): 'failed' {
     run.report.detail = detail;
     if (this.#queue.state(run.task.id) !== 'cancelled') this.#queue.cancel(run.task.id, detail);   // fleet.ts:770
     return 'failed';
   }
   ```
5. `queue.cancel` lleva A a `cancelled` y `transition` cancela en cascada a sus dependientes no activas
   (`queue.ts:160`, `:236-242`): B pasa a `cancelled` con «dependencia A cancelada». El almacén sigue abierto (`close()`
   corre después de `fleet.stop()`), así que `#copyChange` guarda los dos `cancelled` en SQLite.
6. Al volver a arrancar, `recoverOrphans` no las toca: solo rescata `ready`, `running`, `review` y `handed_off`
   (`fleet-service.ts:71`, `:242`). «Reintentar» ni aparece (solo para `failed`) y la API responde 409
   (`fleet-port.ts:143`, `fleet-service.ts:226`, `server/app.ts:597`). Hay que volver a planificar A y todo su árbol.
   El worktree de A sí se conserva (`#cleanup` no borra cuando el resultado es `'failed'` y `keepFailed` vale `true`,
   `fleet.ts:233`, `:753-754`), pero ninguna tarea lo retoma.

La app de escritorio no pasa por aquí: solo apaga el núcleo que lanzó cuando no hay trabajo en curso
(`apps/desktop/src/lib/shutdown-policy.ts:25`), y en Windows lo mata con `taskkill /F`. Por eso la severidad es baja. Le
pasa a quien usa el núcleo por CLI (`iniciar` en una terminal, la flota de A0, Postman).

## Por qué pasa

`Fleet.#cancelled` (`fleet.ts:768-772`) trata igual una cancelación pedida por el usuario (`Fleet.cancel`, que ya
canceló en la cola antes de abortar, `fleet.ts:312-313`) y la parada de la flota (señal de `run`, `fleet.ts:248-250`). En
el segundo caso nadie pidió cancelar la tarea, pero `#cancelled` la lleva al estado terminal `cancelled`, y la cola
propaga ese estado a las dependientes. `FleetRuntime.stop()` lo documenta como «Cancela las tareas en curso»
(`fleet-port.ts:185`), pero el resultado es más duro que el de un cierre brusco, que deja las mismas tareas reintentables.

## Solución posible

En `src/core/orchestrator/fleet.ts`:

1. Agregar `readonly #userCancelled = new Set<string>()` y, en `cancel()`, anotar el id al principio, antes del corte por
   `#committing` (así también cuenta la cancelación diferida de `#cancelAfterCommit`). Borrarlo en el `finally` de
   `#runTask`, junto con `#controllers`/`#committing`.
2. En `run()`, que `onAbort` además ponga un indicador `#stopping = true` (o pasar la señal de `run` a
   `#runTask`/`#cycle`).
3. En `#cancelled`: si la cola no tiene ya la tarea `cancelled`, la flota se está deteniendo y el id no está en
   `#userCancelled`, cerrar con `this.#fail(run, 'interrumpida al detener el núcleo')` en lugar de `queue.cancel`. Sale
   por `failed` (permitido desde `running`, `review` y `handed_off`), sin cascada: las dependientes siguen `pending` y la
   tarea se reintenta desde la base después del reinicio (`FleetRuntime.retry`, rama «reencolada desde la base»).

Conviene exportar el motivo como constante, igual que `INTERRUPTED_DETAIL` en `fleet-service.ts:73`, para que la
interfaz y las pruebas usen el mismo texto.

### Otras opciones

- **En `FleetRuntime.stop()`** (`fleet-port.ts:186`): antes de abortar, pasar a `failed` con el motivo las tareas
  activas de la cola (`running`/`review`/`handed_off`, menos las que estén integrando). Así `#cancelled` ya no las encuentra
  cancelables (`TERMINAL` no incluye `failed`, así que habría que ajustar la guarda de `#cancelled` para que no cancele
  una `failed`). Cambia menos código de `Fleet`, pero reparte la regla entre dos clases y depende del orden.
- **No abortar al detener**: dejar que `stop()` solo deje de tomar tareas nuevas y que el proceso salga con las
  tareas a medias. `recoverOrphans` las rescata al reiniciar, igual que tras un `taskkill`. Es lo más simple y deja un
  solo camino de recuperación, pero los agentes hijos podrían quedar vivos sin dueño si el proceso sale sin matarlos.
- **Distinguir por el motivo de la señal**: abortar con `AbortController.abort(reason)` (por ejemplo, `'shutdown'`)
  y leer `signal.reason` en `#cancelled`. Así no hace falta un set aparte, pero el controlador de cada tarea tendría que
  heredar el motivo de la señal de `run` (`controller.abort(opts.signal.reason)` en `onAbort`).

La propuesta no es la única. La versión con `#userCancelled` deja la decisión dentro de `Fleet`, que ya sabe quién
canceló, y no cambia la API de `FleetRuntime`. Puede que haya una solución más corta que la elegida.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta: en `tests/core/app/retry.test.ts`, que ya arma `FleetRuntime` con `Fleet`, `Router` y
  `Supervisor` reales y `ScriptedAdapter` (`tests/core/orchestrator/fakes.ts`):
  1. Autor con el guion `[{ untilAbort: true }, { error: 'cancelled' }, { done: false }]` (el paso `untilAbort` de
     `fakes.ts:132` espera la señal).
  2. `delegate(brief('a'))` y `delegate(brief('b', { dependsOn: ['a'] }))`, esperar con `until` a que `a` esté `running`.
  3. `await runtime.stop()`.
  4. Afirmar `queue.get('a')?.state === 'failed'`, con `runtime.status('a')?.detail` que diga «interrumpida al detener el
     núcleo», y `queue.get('b')?.state === 'pending'` (no `cancelled`).
  5. Caso de control en `tests/core/orchestrator/fleet.test.ts`: `fleet.cancel('a')` con la flota corriendo sigue dejando
     `a` y `b` `cancelled` (la cancelación del usuario no cambia), y una cancelación pedida durante `integrate()` que
     falla también termina `cancelled` aunque después se detenga la flota.
  6. Opcional, de punta a punta con `FleetService` y un `SqliteStore` en memoria: después de `stop()`, `store.getTask('a')`
     queda `failed` y `FleetService.retry('a')` se acepta (reencolada desde la base) en una composición nueva.
- Comando para correrla (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/app/retry.test.ts tests/core/orchestrator/fleet.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/app/retry.test.ts tests/core/orchestrator/fleet.test.ts`).
- Verificación manual: lanzar `node src/core/app/cli.ts iniciar`, aprobar una tarea con una dependiente, pulsar Ctrl+C
  mientras el agente trabaja y volver a lanzar `iniciar`. En el tablero la tarea debe verse `failed` con el botón
  «Reintentar» y la dependiente `pending`. Hoy las dos aparecen `cancelled`.
