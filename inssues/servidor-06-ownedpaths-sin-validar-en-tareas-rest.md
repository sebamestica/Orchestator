# POST /tasks y POST /tasks/manual aceptan rutas propias absolutas, con «..» o negadas: la tarea se trabaja entera y falla al revisar o integrar

- **Área:** Servidor, API y contratos
- **Severidad:** baja
- **Archivos:** `src/shared/api.ts:531`, `src/shared/tasks.ts:11`, `src/core/server/schemas.ts:48`, `src/core/server/app.ts:529-535`, `src/core/app/f5-servidor.ts:254-268`, `src/core/orchestrator/paths.ts:33-43`, `src/core/orchestrator/plan.ts:130-133`, `src/core/app/commit-step.ts:83-85`, `src/core/app/commit-step.ts:105-106`, `src/core/app/commit-step.ts:208-214`, `src/core/orchestrator/fleet.ts:430-458`
- **Estado:** resuelta

## Cómo ocurre

Las rutas propias (`ownedPaths`) son la lista de archivos que una tarea puede tocar. Antes de revisar y de integrar,
la flota compara lo que cambió en el worktree (rutas relativas al repo, sacadas de `git status`/`git diff`) con esas
rutas. Hay tres formas de crear una tarea:

- el planificador (la mente con `crear_tareas` o `POST /plans`), que pasa por `validatePlan`;
- `POST /tasks` (tarea suelta);
- `POST /tasks/manual` (diálogo «Nueva tarea manual» del tablero), que además la aprueba por defecto.

Solo la primera comprueba que cada ruta sea relativa, no salga del repo y no sea una negación:

```ts
// src/core/orchestrator/plan.ts:130-133
for (const p of t.ownedPaths) {
  const problem = ownedPathProblem(p);
  if (problem) issues.push({ code: 'invalid_path', ... });
}
```

Las dos rutas REST solo exigen cadenas no vacías:

```ts
// src/shared/api.ts:531 (manualTaskBody)
ownedPaths: z.array(z.string().min(1)).min(1).max(100),
// src/shared/tasks.ts:11 (taskBriefSchema)
ownedPaths: z.array(z.string().min(1)).min(1),
// src/core/server/schemas.ts:48
export const taskBody = taskBriefSchema;
```

El manejador de `POST /tasks` (`app.ts:529-535`) guarda el cuerpo tal cual con `store.putTask(body)`, y el de
`POST /tasks/manual` (`f5-servidor.ts:254-268`) arma el encargo con `taskBriefSchema.parse` y lo aprueba
(`body.approve`, que vale `true` por defecto). El diálogo `src/ui/features/board/ManualTaskDialog.tsx:80-88` solo
quita líneas vacías: no avisa nada.

Pasos:

1. En «Nueva tarea manual», el usuario pega una ruta copiada del Explorador, `C:\dev\Vetworld\src\citas\**`
   (o escribe `../otro/**`, o `!src/x` pensando en excluir algo).
2. `POST /tasks/manual` responde 201 y la tarea queda `ready`.
3. El agente trabaja en su worktree. El hook de Claude no le deja escribir fuera del worktree
   (`src/core/adapters/claude-sdk/permissions.ts`), así que edita `src/citas/...` dentro de él.
4. Antes de revisar, `reviewSummary` llama a `commitTaskWork`, que normaliza y compara:
   `normalizeOwnedPath('C:\dev\Vetworld\src\citas\**')` da `C:/dev/Vetworld/src/citas/**`, cuyo primer segmento
   literal (`c:`) nunca coincide con `src`. Lo mismo pasa con `..` y con `!src` (se tokenizan como literales,
   `paths.ts:138-165`). Todo archivo cambiado queda «fuera»:

   ```ts
   // src/core/app/commit-step.ts:105-106
   const outside = outsideOwnedPaths([...pending, ...committed], task.ownedPaths);
   if (outside.length) throw new OwnedPathsError(task.id, outside);
   ```
5. `reviewSummary` convierte el error en `ATENCIÓN: … Rechaza la tarea y pide deshacer esos cambios.`
   (`commit-step.ts:213`). El revisor rechaza y la flota pide otra ronda al autor (`fleet.ts:454-459`), que no
   tiene arreglo posible: cualquier cambio relativo queda fuera. Tras `DEFAULT_MAX_ROUNDS = 3` (`fleet.ts:31`) la
   tarea falla «sin rondas restantes». Si el revisor aprobara igual, `integrate` vuelve a llamar a `prepare` y
   lanza `OwnedPathsError` (`commit-step.ts:229-230`).

Resultado: hasta tres rondas de autor, gate y revisor pagadas para una tarea que nunca pudo integrarse. Con una sola
ruta de las tres formas basta para que pase. En modo local no hay commit, pero `#localSummary` da el mismo aviso al
revisor (`commit-step.ts:254-263`) y el ciclo de rechazos se repite.

Nota: una ruta con `/` inicial (`/src/**`) no rompe la comprobación del commit, porque `normalizeOwnedPath` descarta
los segmentos vacíos. Aun así `ownedPathProblem` la rechaza, y conviene que las rutas REST apliquen la misma regla.

## Por qué pasa

La regla existe (`ownedPathProblem`, `paths.ts:33-43`), pero solo la aplica `validatePlan`. `taskBriefSchema` y
`manualTaskBody` no la llevan, y los manejadores de `POST /tasks` y `POST /tasks/manual` no la llaman antes de
`putTask`. El texto del planificador (`plan.ts:289`) le exige al modelo «Sin rutas absolutas, sin «..» y sin
negaciones», pero a quien usa la API o el diálogo nadie se lo exige.

## Solución posible

Validar las rutas en las dos entradas REST con la función que ya existe y responder
`400 invalid_request` antes de crear nada:

1. `src/core/server/schemas.ts`: importar `ownedPathProblem` de `../orchestrator/paths.ts` (es un módulo hoja, sin
   imports, así que no crea ciclos) y definir
   `taskBody = taskBriefSchema.superRefine((t, ctx) => t.ownedPaths.forEach((p, i) => { const m = ownedPathProblem(p); if (m) ctx.addIssue({ code: 'custom', path: ['ownedPaths', i], message: m }); }))`.
   `check` (`routing.ts:53-56`) ya convierte ese fallo en `400 invalid_request` con el mensaje.
2. `src/core/app/f5-servidor.ts`, manejador de `/tasks/manual`: antes de `ctx.newId`, recorrer `body.ownedPaths`
   con `ownedPathProblem` y lanzar `new ApiError(400, 'invalid_request', \`Ruta propia inválida: ${problema}\`)`
   (`src/shared` no puede importar de `core`, por eso el chequeo va en el núcleo).
3. Opcional, en `ManualTaskDialog.tsx`, una pista bajo el campo («relativas a la raíz del repo, sin `C:\`, `..`
   ni `!`»), para que el 400 no sorprenda.

### Otras opciones

- **Mover `ownedPathProblem` a `src/shared` y refinar `taskBriefSchema`.** Una sola regla para REST, planificador y
  mente. El riesgo es que `taskBriefSchema` también se usa para **leer** filas guardadas
  (`src/core/chat/proposals.ts:28`, `src/core/conductor/proposals.ts:26`) y encargos internos (`fleet.ts:837`,
  `conductor/tools.ts:553`, con `ownedPaths: ['.']`): una tarea vieja con una ruta mala dejaría de cargarse. Habría
  que separar un esquema de entrada de uno de lectura.
- **Normalizar en vez de rechazar.** Una ruta absoluta que cae dentro de `repoPath` del proyecto se podría pasar a
  relativa (`C:\dev\Vetworld\src\citas\**` → `src/citas/**`). Es más amable con quien pega rutas del Explorador,
  pero hay que resolver mayúsculas, junctions y la carpeta del worktree. `..` y `!` se seguirían rechazando.
- **Validar también al aprobar** (`approveTask`), para atajar tareas ya guardadas con rutas inválidas. Cubre datos
  viejos, pero el error llega más tarde.

La propuesta es la más pequeña y reutiliza la regla que ya existe, pero no es la única. Con una función compartida
(`validateOwnedPaths(paths): string[]`) que llamen `validatePlan`, `POST /tasks` y `POST /tasks/manual` se
evitaría repetir el bucle tres veces.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:**
  - `tests/core/f5-servidor/manual-task.test.ts`: en el caso «cuerpo inválido → 400», añadir
    `ownedPaths: ['C:\\dev\\x\\**']`, `['../y/**']`, `['!src']`, `['/src/**']` y `['@(a|b)/**']`. Afirmar 400
    con `error.code === 'invalid_request'`, que el mensaje nombre la ruta y que `t.store.listTasks()` siga vacío y
    `t.approved` también. Con `['src/**']` debe seguir dando 201.
  - `tests/core/server/validation.test.ts`: agregar a `cases` las mismas variantes para `POST /tasks`
    (`{ ...task, ownedPaths: ['C:\\x\\**'] }`, etc.) y comprobar `expectError(res, 400, 'invalid_request')`.
  - Opcional, en `tests/integration/commit-step.test.ts`: dejar fijado que
    `outsideOwnedPaths(['src/a.ts'], ['C:/dev/x/src/**'])` devuelve `['src/a.ts']`, que es lo que hoy hace fallar
    la tarea.
- **Comando (desde WSL):**
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/f5-servidor/manual-task.test.ts tests/core/server/validation.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/f5-servidor/manual-task.test.ts tests/core/server/validation.test.ts`).
- **Verificación manual en la app:** en el tablero, «Nueva tarea manual» con la ruta `C:\dev\<proyecto>\src\**`.
  Debe aparecer el aviso «Error 400 (invalid_request) …: debe ser relativa a la raíz del repo» y no debe crearse
  ninguna tarea. Con `src/**` debe crearse y aprobarse como antes.
