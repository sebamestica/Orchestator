# Lo que deja el gate previo a la revisión en el worktree de la tarea entra en el commit o tumba la integración ya aprobada

- **Área:** Núcleo de la flota
- **Severidad:** media
- **Archivos:** `src/core/orchestrator/fleet.ts:525-533`, `src/core/orchestrator/fleet.ts:434`, `src/core/orchestrator/fleet.ts:344-346`, `src/core/orchestrator/fleet.ts:563-564`, `src/core/app/workspaces.ts:138-147`, `src/core/app/commit-step.ts:101-113`, `src/core/app/commit-step.ts:208-215`, `src/core/app/commit-step.ts:229-232`, `src/core/app/fleet-service.ts:387`, `src/core/workspace/integrate.ts:81`, `src/core/workspace/integrate.ts:99-103`, `src/core/workspace/leftovers.ts:12-34`, `docs/plan/issues/06-razonamiento-modelos.md:142-144`
- **Estado:** abierta

## Cómo ocurre

Desde el issue 6, con worktrees la flota hace esto en cada ronda:

1. **Resumen del diff, que confirma el trabajo.** `#review` llama a `#diffSummary` (`fleet.ts:527`). En producción es
   `workspaces.reviewSummary` (`fleet-service.ts:387`), que llama a `prepare` → `commitTaskWork` (`commit-step.ts:211`,
   `198`): toma todo lo pendiente con `git status --porcelain=v1 -z --untracked-files=all` (`commit-step.ts:102`) y lo
   confirma en la rama de la tarea.
2. **Gate previo en el mismo worktree.** Justo después (`fleet.ts:532-533`):
   ```ts
   // Después del resumen del diff (que confirma el trabajo): así los restos del gate no se cuelan en el commit.
   const gate = await this.#runGate(run, signal);
   ```
   `#runGate` → `CommittingWorkspaces.verify` → `ProjectWorktrees.verify`, que corre el gate en `workspace.path`
   (`workspaces.ts:144`). Antes no toma una foto del estado y después no limpia nada:
   ```ts
   const results = await runCommands(project.gate, workspace.path, signal, { untrustedRoots: [project.worktreesRoot] });
   const ok = results.length === project.gate.length && results.every((r) => r.ok);
   return { ok, summary: summarizeCommands(results, project.gate.length) };
   ```
3. **El revisor aprueba** (`fleet.ts:428`).
4. **Integrar vuelve a confirmar.** `this.#workspaces.integrate(...)` (`fleet.ts:434`) → `CommittingWorkspaces.integrate`,
   que repite `prepare` (`commit-step.ts:229-232`):
   ```ts
   async integrate(projectId: string, workspace: Workspace): Promise<IntegrationResult> {
     if (!this.isLocal(workspace)) await this.prepare(workspace);
     return this.#inner.integrate(projectId, workspace);
   }
   ```
   `commitTaskWork` ve ahora lo que dejó el gate del paso 2:
   - **Si cae fuera de `ownedPaths`**, lanza `OwnedPathsError` (`commit-step.ts:105-106`). Esa excepción no se
     convierte en `IntegrationResult`: sube hasta el `catch` de `#runTask`, y la tarea queda `failed` con «Error del
     orquestador: La tarea … cambió archivos fuera de sus rutas propias» (`fleet.ts:344-346`). Para entonces ya se
     pagaron el autor, el gate y la revisión aprobada, y no hay ronda de corrección.
   - **Si cae dentro de `ownedPaths`**, se agrega con `git add -A` y se confirma (`commit-step.ts:111-117`). Después
     se fusiona en la rama de integración sin que el revisor lo haya visto.
5. **Las rondas siguientes también lo arrastran.** Si el gate falla (`review.gateFailed`, `fleet.ts:421-423`) o el
   revisor rechaza, el autor sigue en el mismo worktree. En la ronda siguiente, `reviewSummary` llama a `prepare`, que
   ve los restos de la ronda anterior. Si caen fuera de las rutas propias, el revisor recibe como «diff» (`commit-step.ts:213`):
   ```ts
   if (err instanceof OwnedPathsError) return `ATENCIÓN: ${err.message}. Rechaza la tarea y pide deshacer esos cambios.`;
   ```
   Lo pide por archivos que el autor no tocó, y el gate de esa ronda los vuelve a crear.

Casos donde pasa, siempre que lo generado **no** esté en `.gitignore` (lo ignorado no aparece en `git status`):
- Proyecto Python con el gate que deduce `deduceGate` (`python -m pytest -q`, `src/core/fs/folders.ts:276-278`) y un
  repo que no ignora `__pycache__/`: aparece `tests/__pycache__/test_x.cpython-312-pytest-….pyc`. Si la tarea es dueña
  de `tests/test_x.py`, eso queda fuera de sus rutas y `integrate` lanza el error. Si es dueña de `tests/**`, el `.pyc`
  se confirma.
- Un gate `npm run -s check` que ejecuta un formateador o `eslint --fix`, o que escribe artefactos (`coverage/`,
  `*.tsbuildinfo`, informes), deja archivos versionados modificados o archivos nuevos en el worktree.

Lo mismo vale para lo que toque el revisor. `fleet.ts:563-564` solo avisa («el revisor … modificó archivos del
proyecto») y luego el `prepare` de `integrate` lo confirma o lanza el error.

El diseño dice lo contrario: «Corre después del resumen del diff, que confirma el trabajo, para que los restos del gate
no entren en el commit» (`docs/plan/issues/06-razonamiento-modelos.md:142-144`). En el worktree de integración, en
cambio, sí se limpian los restos del gate (`integrate.ts:81`, `89`, `99-103` con `removeUntracked`, `leftovers.ts:12-34`).
Ninguna prueba cubre el caso: `tests/core/orchestrator/razonamiento.test.ts:233-286` usa `verify` falsos que no
escriben nada, y `tests/integration/project-workspaces.test.ts:139-142` solo mira el resultado de `pw.verify`.

## Por qué pasa

Correr el gate después del primer `prepare` solo protege ese commit. La flota vuelve a llamar a `prepare` en
`integrate` (`commit-step.ts:230`) y en el `reviewSummary` de cada ronda nueva, y ese `prepare` toma **todo** lo
pendiente del worktree. Como `ProjectWorktrees.verify` (`workspaces.ts:138-147`) no limpia lo que deja el gate ni
detecta lo que modificó, esos restos siguen pendientes en la siguiente llamada. Además, `OwnedPathsError` en
`integrate` se lanza como excepción y no vuelve como `IntegrationResult`, así que la tarea muere en lugar de volver al autor.

## Solución posible

1. **`src/core/app/workspaces.ts`, `ProjectWorktrees.verify`:** antes de `runCommands`, guardar la salida de
   `git status --porcelain -z --untracked-files=all` del worktree. Justo después de confirmar, debería estar limpia salvo
   `.orq/`. Al terminar, haya pasado o fallado el gate:
   - borrar los archivos no versionados que no estaban en la foto. Sirve `removeUntracked` de `leftovers.ts` con un
     parámetro opcional `keep` (la foto), que mantiene sus garantías: sin `git clean` y sin atravesar junctions. No
     tocar `.orq/`.
   - detectar con `git diff --name-only -z` los archivos versionados que el gate modificó. Restaurarlos con
     `git checkout -- <archivos>` (lo permite la guardia de `guard-rules.ts`) o devolver `ok: false` con un resumen
     del tipo «el gate modificó archivos versionados: …». Así vuelve al autor como fallo del gate y no se confirma en silencio.
2. **`src/core/app/commit-step.ts`, `CommittingWorkspaces.integrate`:** si `prepare` lanza `OwnedPathsError`,
   devolver `{ ok: false, conflicts: [], gateSummary: 'no ejecutado: ' + err.message }` en vez de lanzar. Así la flota
   abre una ronda de corrección con el motivo (`fleet.ts:447-450`) y la tarea no queda como «Error del orquestador». Lo
   ideal es que `integrate` no confirme nada nuevo después de la revisión: si `prepare` devuelve `files.length > 0`,
   devolver también `ok: false` con «cambios aparecidos después de la revisión: …». Así a la rama no entra nada sin revisar.
3. Ajustar el comentario de `fleet.ts:532` y la nota de `06-razonamiento-modelos.md:142-144` para que digan dónde se
   limpian los restos.

### Otras opciones

- **Gate en una copia aparte:** correr el gate previo en un worktree temporal (`git worktree add --detach` del commit
  que acaba de dejar `prepare`) o en el de integración, y descartarlo al terminar. Protege mejor, porque el gate no
  toca nunca el worktree del autor y cubre también los versionados modificados. A cambio, cuesta crear un worktree por
  ronda (enlaces, `postCreate`), lo que pesa en Windows y en repos grandes.
- **Foto del revisor:** aplicar la misma foto y limpieza alrededor de la revisión, porque el revisor también puede
  dejar cambios que hoy solo se avisan (`fleet.ts:563-564`).
- **Comparar contra el commit revisado:** guardar el `HEAD` que dejó `prepare` antes de revisar. En `integrate`, si
  hay algo pendiente o un `HEAD` distinto, no confirmar y devolver el motivo. Es más simple que limpiar y cierra la
  puerta a todo lo que aparezca después de la revisión, venga del gate, del revisor o de otro proceso. Combinarlo con
  la limpieza del punto 1 evita además que el gate lo provoque en cada ronda.

La propuesta no es la única. La copia aparte, o comparar contra el commit revisado, puede salir más sencilla y robusta
que mantener una foto del estado.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:** `tests/integration/gate-previo-restos.test.ts`.
  - Repo temporal como en `tests/integration/project-workspaces.test.ts`: `SqliteStore` en memoria con el proyecto,
    `ProjectWorktrees` envuelto en `CommittingWorkspaces`, identidad git del repo e `integrationBranch` del proyecto.
    Gate: `{ command: process.execPath, args: ['-e', "const fs=require('fs');fs.mkdirSync('tests/__pycache__',{recursive:true});fs.writeFileSync('tests/__pycache__/a.pyc','x')"] }`.
    Sin `.gitignore` para `tests/__pycache__`.
  - **Caso A, fuera de las rutas propias:** tarea con `ownedPaths: ['src/a.ts']`. Flota con el patrón de
    `tests/core/orchestrator/razonamiento.test.ts`: autor falso que escribe `src/a.ts`, revisor falso que aprueba,
    `diffSummary` = `workspaces.reviewSummary` y `verify` por defecto (el del gestor). Debe afirmar que la tarea queda
    `integrated`, que `git show --name-only orq/<tarea>` y la rama de integración no tienen `tests/__pycache__/a.pyc`,
    y que el worktree queda limpio (`git status --porcelain --untracked-files=all` vacío salvo `.orq`). Hoy termina
    `failed` con «Error del orquestador: … fuera de sus rutas propias».
  - **Caso B, dentro de las rutas propias:** `ownedPaths: ['src/a.ts', 'tests/**']`. Debe afirmar que
    `tests/__pycache__/a.pyc` no está en la rama de la tarea ni en `orq/integracion`. Hoy entra en el commit.
  - **Caso C, `integrate` no lanza:** con `CommittingWorkspaces` directo (como `tests/integration/commit-step.test.ts:101-112`),
    dejar un archivo fuera de las rutas propias después de `prepare` y comprobar que `integrate` resuelve con
    `{ ok: false }` y el motivo en `gateSummary`, sin rechazar la promesa. Ajustar la afirmación de `commit-step.test.ts:108`,
    que hoy espera `rejects.toBeInstanceOf(OwnedPathsError)`.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/integration/gate-previo-restos.test.ts tests/integration/commit-step.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/integration/gate-previo-restos.test.ts tests/integration/commit-step.test.ts`).
- **Verificación manual en la app:** registrar un proyecto Python con `pytest.ini` y sin `__pycache__/` en
  `.gitignore`. Lanzar una tarea dueña de un solo archivo de `tests/`. Tras la aprobación, la tarea debe quedar
  integrada y el commit `merge: integra orq/<tarea>` no debe tener `.pyc`. Hoy queda «Error del orquestador» al integrar.
