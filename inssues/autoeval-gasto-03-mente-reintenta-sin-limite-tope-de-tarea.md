# En auto y bypass, la mente puede reintentar sin límite una tarea que la flota frenó por el tope de gasto, y cada reintento arranca con el tope entero

- **Área:** Mente y chat · Flota (gasto)
- **Severidad:** media
- **Archivos:** `src/core/orchestrator/fleet.ts:42`, `src/core/orchestrator/fleet.ts:340`, `src/core/orchestrator/fleet.ts:599`, `src/core/orchestrator/fleet.ts:611`, `src/core/orchestrator/fleet.ts:614`, `src/core/conductor/tools.ts:223`, `src/core/conductor/tools.ts:259`, `src/core/conductor/tools.ts:275`, `src/core/conductor/tools.ts:324`, `src/core/conductor/session.ts:291`, `src/core/conductor/session.ts:316`, `src/core/conductor/prompt.ts:138`, `src/core/conductor/prompt.ts:149`, `src/core/chat/service.ts:259`, `src/core/app/f5-chat.ts:53`, `src/core/app/fleet-service.ts:154`, `src/core/app/fleet-service.ts:221`, `src/core/app/fleet-service.ts:333`, `src/core/app/fleet-port.ts:148`, `docs/plan/issues/06-razonamiento-modelos.md:131`
- **Estado:** abierta
- **Origen:** autoevaluación de la mente (2026-11-05)
- **Relacionadas:** `autoeval-gasto-01` (la mente sin tope propio), `autoeval-gasto-02` (presupuesto no común), `mente-03` (en auto y bypass `crear_tareas` aprueba sola), `flota-04` y `flota-06` (reintentos y `.orq` en la flota)

## Cómo ocurre

**Contexto.** Desde el issue 6, la flota corta cada tarea en 1, 3 u 8 USD según su dificultad
(`fleet.ts:42`, `DEFAULT_TASK_BUDGET_USD`). Es un freno real: la flota pasa al Supervisor lo que queda como `budgetUsd`
(`fleet.ts:597-599`) y el adaptador Claude lo usa como `maxBudgetUsd` y corta en curso. Al llegar al tope,
`#overBudget` (`fleet.ts:611`) deja la tarea `failed` con este motivo:

```ts
// src/core/orchestrator/fleet.ts:614
const detail = `tope de gasto de la tarea superado: ${run.spentUsd.toFixed(2)} de ${cap} USD (dificultad ${task.difficulty}); lo hecho queda en ${PLAN_FILES.handoff}: reintenta para continuar desde ahí`;
```

El usuario decidió que «un reintento del usuario empieza con el tope entero» (`06-razonamiento-modelos.md:131-132`). El
código no distingue quién reintenta:

- Cada ejecución arranca con `spentUsd: 0` (`fleet.ts:336-341`), así que el tope vuelve a estar entero.
- La herramienta `delegar` de la mente reintenta cualquier tarea `failed` ya delegada (`tools.ts:259-273`), sin mirar
  el motivo. `estado` le sugiere hacerlo: «Para reintentarla (sigue en su worktree) usa delegar con su taskId»
  (`tools.ts:324`).
- `ChatService` pasa el `retry` de la flota tal cual a la mente (`service.ts:259-264`), y `lazyFleetPort.retry` llama a
  `FleetService.retry` con el motivo «reintento pedido por la mente» (`f5-chat.ts:53-56`). `retry` solo exige
  `state === 'failed'` (`fleet-service.ts:221-229`), igual que para el botón del usuario (`onRetry`,
  `fleet-service.ts:333-335`). El contador `attempts` de la tarea sube en cada `ready → running`
  (`fleet-service.ts:154`), pero solo se usa para numerar el intento en el encargo de continuación
  (`fleet-port.ts:148`). Nada lo usa como límite.
- En auto, el prompt le dice a la mente que delegue ella misma (`prompt.ts:138-139`). En bypass, además, le pide no
  preguntar y persistir: «si algo falla, prueba otra vía (otra herramienta, otro agente de la flota o hacerlo tú)»
  (`prompt.ts:149`). `delegar` está disponible en auto y bypass: solo `plan` la bloquea (`session.ts:291` y `:316`) y
  `chat` la oculta (`session.ts:319`).

**Pasos.**

1. Chat en bypass. La mente crea una tarea `high`, que queda aprobada al instante, y la delega.
2. El worker Claude llega a 8 USD y la flota la deja `failed` con «…: reintenta para continuar desde ahí».
3. En el siguiente turno de la mente, la mente consulta `estado`, lee el motivo y el `siguientePaso`, y llama a `delegar` con la misma
   tarea sin preguntar. Ese turno puede ser un mensaje del usuario como «¿cómo vas?», un turno autónomo cuando termina
   un subagente en segundo plano o, en bypass, el mismo turno largo esperando con `Bash` y consultando `estado`. Se
   acepta: nueva ejecución, `spentUsd: 0`, otros 8 USD.
4. Se repite cada vez que la mente vuelve a ver la tarea fallida. Con tres tareas `high` son 24 USD por vuelta. Solo lo
   frena el presupuesto total del agente Claude (60.000 USD en la instalación del usuario; ver `autoeval-gasto-01`), o
   que el usuario lo vea e interrumpa. En el tablero solo se nota que la tarea vuelve a `running`.

**Pruebas.** `tests/core/app/retry-delegar.test.ts:28-44` fija que `delegar` reintenta una tarea fallida sin mirar el
motivo ni cuántas veces se reintentó. Ninguna prueba de reintento (`retry-delegar`, `retry-service`,
`tests/core/chat/retry-port.test.ts`) cubre una tarea frenada por el tope.

## Por qué pasa

La flota trata todo reintento como una decisión del usuario, y por eso empieza con el tope entero. Pero la mente usa el
mismo camino, y en auto y bypass decide sola. El motivo que deja la flota y el `siguientePaso` de `estado` le piden
explícitamente que reintente. El tope vale por ejecución, no por tarea en total.

## Solución posible

1. **Saber quién reintenta** (`src/core/app/fleet-service.ts:221`). `retry(taskId, reason, origin: 'user' | 'mind' =
   'user')`. `lazyFleetPort.retry` (`f5-chat.ts:53-60`) pasa `'mind'`. `onRetry` (`fleet-service.ts:333`), el camino de
   `POST /tasks/:id/retry` y del botón «Reintentar», sigue con `'user'`.
2. **Regla para la mente** (en el mismo `retry`, antes de llamar a la flota). Con `origin === 'mind'`, negar con
   `RetryError('conflict', …)` en dos casos:
   - la tarea se detuvo por el tope de gasto. Hoy solo se sabe por el `detail` de `fleet.ts:614`. Es mejor guardar un
     motivo estructurado, por ejemplo `failure: 'budget'` en la tarea, que comparar texto;
   - la mente ya reintentó la tarea `MAX_MIND_RETRIES` veces (por ejemplo 2). `attempts` cuenta todas las ejecuciones,
     la primera y las del usuario incluidas. Para contar solo los reintentos de la mente desde el último del usuario
     hace falta un contador propio, por ejemplo `mind_retries`, que se pone en 0 cuando reintenta el usuario.

   El motivo debe decir qué hacer: «la tarea se detuvo por el tope de gasto (8 USD): solo el usuario puede reintentarla
   desde el tablero». `delegar` ya devuelve ese texto a la mente (`tools.ts:275`).
3. **Textos** (`tools.ts:324` y `prompt.ts`). Si la tarea falló por tope, el `siguientePaso` de `estado` pasa a ser
   «pídele al usuario que la reintente desde el tablero; no la reintentes ni crees otra tarea que repita el mismo
   trabajo». En auto y bypass, `crear_tareas` aprueba sola (`tools.ts:223`), así que sin esa regla la mente puede
   esquivar la barrera con una tarea copia con otro id y el tope entero. Hay que decirlo también en las reglas de modo
   del prompt. El `detail` de `fleet.ts:614` puede quedarse como está, porque lo lee el usuario.

### Otras opciones

La propuesta no es la única, y puede haber una mejor:

- **Tope por tarea en total, no por ejecución.** Sumar el gasto de todas las sesiones de la tarea (`usage` unido con
  `sessions.task_id`) y comparar contra el tope en cada ejecución. Un reintento del usuario podría ampliar el tope de
  forma explícita, con un campo «tope extra» en el diálogo de reintento. Cambia la decisión del issue 6, así que hay que
  consultarla con el usuario.
- **Solo bajar la tentación.** Cambiar el `detail` y el `siguientePaso` para que no inviten a reintentar. Es barato,
  pero no es una barrera: en bypass, la mente igual puede reintentar «para persistir».
- **Límite de reintentos para todos** (también para el usuario). Es más simple, pero contradice «un reintento del
  usuario empieza con el tope entero».
- **Tope por proyecto o por chat para lo que la mente delega.** Cubre también las tareas copia, pero se cruza con
  `autoeval-gasto-01` y `autoeval-gasto-02`. Conviene decidirlo junto con ellas.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:**
  - `tests/core/app/retry-service.test.ts`, en `describe('FleetService.retry: errores')` (línea 106). Con una tarea
    `failed` y `detail` de tope de gasto (o `failure: 'budget'`), afirmar que `retry(id, 'x', 'mind')` lanza
    `RetryError` con `code: 'conflict'` y un mensaje que nombra al usuario, y que `retry(id, 'x', 'user')` la acepta.
    Con una tarea fallida por otro motivo que la mente ya reintentó `MAX_MIND_RETRIES` veces, afirmar que otro
    reintento de la mente se niega, que el del usuario se acepta y que después la mente vuelve a poder reintentar.
  - `tests/core/app/retry-delegar.test.ts`, nuevo caso en `describe('delegar sobre una tarea ya delegada')` (línea 28).
    Con `RetryingFleet` cuyo `retry` devuelve `{ accepted: false, reason: 'la tarea se detuvo por el tope de gasto…' }`,
    afirmar que `delegar` devuelve `isError` con ese motivo y que `fleet.retried` queda vacío. En
    `describe('estado devuelve el motivo')` (línea 88), afirmar que con ese `detail` el `siguientePaso` nombra al usuario
    y no invita a usar `delegar`.
  - `tests/core/chat/retry-port.test.ts`: `lazyFleetPort(comp).retry` llama a `comp.fleet.retry` con origen `'mind'`.
    Hay que ampliar `fakeFleet` para que guarde el tercer argumento.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/app/retry-service.test.ts tests/core/app/retry-delegar.test.ts tests/core/chat/retry-port.test.ts"`.
  Desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/app/retry-service.test.ts tests/core/app/retry-delegar.test.ts tests/core/chat/retry-port.test.ts`.
- **Verificación manual:** dejar una tarea `low` frenada por el tope (por ejemplo, con un encargo grande y el tope de 1
  USD). En un chat en bypass, pedirle a la mente que la termine. Debe responder que solo el usuario puede
  reintentarla, sin reintentarla ni crear otra tarea igual (mirar el tablero). El botón «Reintentar» del tablero debe
  seguir funcionando y arrancar con el tope entero.
