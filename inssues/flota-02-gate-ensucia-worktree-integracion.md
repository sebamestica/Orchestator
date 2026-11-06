# Si el gate modifica archivos versionados, `_integracion` queda sucio y las integraciones siguientes del proyecto fallan como «Error del orquestador»

- **Área:** Núcleo de la flota
- **Severidad:** media
- **Archivos:** `src/core/workspace/integrate.ts:51-53`, `src/core/workspace/integrate.ts:99-103`, `src/core/workspace/integrate.ts:117-128`, `src/core/workspace/integrate.ts:131-140`, `src/core/workspace/leftovers.ts:13-14`, `src/core/workspace/guard-rules.ts:3`, `src/core/workspace/guard-rules.ts:58-78`, `src/core/orchestrator/fleet.ts:432-438`, `src/core/orchestrator/fleet.ts:344-347`, `src/core/app/commit-step.ts:229-231`, `tests/core/workspace/review-agy.cases.ts:117-129`
- **Estado:** resuelta

## Cómo ocurre
Cada proyecto con worktrees integra las tareas aprobadas en un worktree propio, `<worktreesRoot>/_integracion`, que
está en la rama `orq/integracion`. `integrateWorkspace` hace `merge --no-ff --no-commit`, corre el gate del proyecto
en esa carpeta y, si pasa, hace el commit (`src/core/workspace/integrate.ts:110-141`). Antes de cada merge,
`ensureIntegrationWorktree` exige que la carpeta no tenga cambios en archivos versionados
(`src/core/workspace/integrate.ts:51-53`):

```ts
if (await mergeInProgress(git, path)) await git(path, ['merge', '--abort']);
const status = (await git(path, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim();
if (status !== '') throw new Error(`el worktree de integración tiene cambios sin confirmar:\n${status}`);
```

Hace falta un gate que reescriba un archivo versionado y que esa reescritura no haya quedado ya en la rama de la
tarea. Ejemplos: un archivo generado con fecha o hash (`build-info.ts`, un badge de cobertura), un `dist/` versionado
para Pages que se reconstruye sobre el árbol fusionado cuando `orq/integracion` avanzó desde que nació la tarea, o un
`--fix`/`--write` que, sobre la combinación fusionada, cambia algo.

**Caso A: el gate pasa.**
1. Después del merge el resultado queda en el índice, y el gate reescribe `a.txt` en la copia de trabajo.
2. `git commit --no-edit -m …` (`integrate.ts:133`) confirma solo el índice. La reescritura queda como ` M a.txt`
   sin preparar y nadie la mira (`integrate.ts:139-140` devuelve `ok: true`).
3. En la integración siguiente del proyecto, `integrate.ts:52-53` lanza «el worktree de integración tiene cambios
   sin confirmar: M a.txt».

**Caso B: el gate falla.** `rollback` (`integrate.ts:99-103`) hace `merge --abort` y `removeUntracked`.
`removeUntracked` solo borra entradas `??` (`src/core/workspace/leftovers.ts:13-14`:
`out.split('\0').filter((e) => e.startsWith('?? '))`). `merge --abort` equivale a `git reset --merge`:
- Si el archivo modificado por el gate **no** lo tocó el merge (índice = HEAD), se conserva la modificación sin
  preparar. La integración siguiente lanza en `integrate.ts:53`, igual que en el caso A.
- Si el archivo **sí** lo tocó el merge (índice ≠ HEAD y copia de trabajo ≠ índice), `reset --merge` se niega
  («not uptodate») y `merge --abort` falla. Con `check` activo, `git()` lanza `GitError`
  (`src/core/workspace/git.ts:103-106`). Ese error sale de `rollback` dentro del `try` (`integrate.ts:122`), el
  `catch` vuelve a llamar a `rollback` (`integrate.ts:126`), que falla igual, y la excepción sube. `MERGE_HEAD` se
  queda. De ahí en adelante, cada integración vuelve a fallar en el `merge --abort` de `integrate.ts:51`.

**Qué ve la flota.** Las dos son excepciones y no `IntegrationResult`. En `fleet.ts:432-438`, `integrate` está en un
`try { … } finally { … }` sin `catch`. La excepción llega al `catch` de `#runTask` (`fleet.ts:344-347`):

```ts
} catch (err) {
  this.#fail(run, `Error del orquestador: ${err instanceof Error ? err.message : String(err)}`);
```

La tarea queda `failed` y no vuelve al autor. Para entonces ya se pagaron el autor, el gate previo y la revisión.
Pasa lo mismo con cada tarea siguiente del mismo proyecto, porque `_integracion` no se limpia nunca. Berland no puede
arreglarlo solo: la guardia es una lista blanca sin `reset`, `checkout`, `restore` ni `stash`
(`src/core/workspace/guard-rules.ts:3` y `58-78`), así que hay que limpiar `_integracion` a mano.

**Qué limita el alcance (verificado).** El gate previo a la revisión (issue 6) corre en el worktree de la tarea
(`fleet.ts:532-535`, `src/core/app/workspaces.ts:138-147`). Al integrar, `CommittingWorkspaces.integrate` vuelve a
llamar a `prepare` (`src/core/app/commit-step.ts:229-231`), y ese paso confirma en la rama de la tarea lo que el gate
reescribió allí, si cae dentro de `ownedPaths` (si cae fuera, lanza `OwnedPathsError` antes de llegar a
`_integracion`). Por eso un formateador idempotente casi nunca dispara el fallo. Sí lo disparan los gates no
idempotentes, los que dependen del árbol fusionado y los gates fallidos que tocaron un archivo del merge. Las pruebas
actuales solo cubren restos **no versionados** (`tests/core/workspace/review-agy.cases.ts:117-129`, H11). Ningún
gate de `tests/core/workspace/integrate.cases.ts` escribe archivos versionados.

## Por qué pasa
Después del gate, sea que pase o que falle, nadie revisa ni deshace lo que el gate cambió en archivos versionados de
`_integracion`. `rollback` limpia solo los no versionados, y en el camino del éxito no se limpia nada. En cambio, la
comprobación de entrada (`integrate.ts:52-53`) exige que no haya cambios versionados, y cuando los encuentra lanza
una excepción en vez de devolver un resultado. Además, la guardia no deja ninguna orden con la que el núcleo pueda
restaurar esos archivos.

## Solución posible
1. En `src/core/workspace/integrate.ts`, justo después de `runCommands` (pase o falle el gate), correr
   `git diff --name-only -z` en `cwd`. La guardia ya lo permite: `diff` acepta `--name-only` y `-z`
   (`guard-rules.ts:61`). Sin argumentos, compara la copia de trabajo con el índice, y el índice tiene justo el
   resultado del merge, así que la lista son exactamente los archivos que tocó el gate. Si la lista no está vacía,
   tratarlo como gate fallido con `gateSummary` «el gate modificó archivos versionados: …». Así la tarea vuelve al
   autor con un motivo claro y no se confirma un árbol distinto del que se verificó.
2. Restaurar esos archivos antes de `merge --abort` en `rollback`. Para eso, agregar a `guard-rules.ts` una regla
   estrecha (`checkout -- <rutas>` o `reset --hard HEAD`) y validarla en `assertSafeGitArgs`
   (`src/core/workspace/guard.ts:80-123`), que ya conoce `cwd` y `managedRoots`: aceptarla solo si `cwd` es
   `<raíz gestionada>/_integracion`, nunca en la copia del usuario ni en un worktree de tarea.
3. En `ensureIntegrationWorktree`, si al entrar sigue sucio o el `merge --abort` falla (restos de versiones
   anteriores), devolver un `IntegrationResult` `{ ok: false, gateSummary }` con el motivo en vez de lanzar, o
   recuperar la carpeta como se explica abajo.

### Otras opciones
- **Recrear `_integracion` cuando esté sucio.** Hoy no hace falta `worktree remove --force` para esto: el gestor ya
  descarta worktrees con `removeAllLinks`, borrado recursivo y `worktree prune` (`discardFresh`,
  `src/core/workspace/manager.ts:157-160`). Después basta un `worktree add` (`integrate.ts:38-45`). En `_integracion`
  no hay nada que perder, porque lo confirmado está en la rama `orq/integracion`. Esta opción no necesita reglas
  nuevas en la guardia y además repara el estado que dejaron versiones anteriores. Quizá sea la más simple y robusta,
  combinada con la detección del paso 1.
- Devolver solo `{ ok: false, gateSummary }` en vez de lanzar. Es un arreglo mínimo: la tarea no se pierde como
  «Error del orquestador», pero `_integracion` sigue sucio para las siguientes.
- Correr el gate de integración en una copia temporal. Es más aislado, pero cuesta mucho más disco y tiempo, y
  `node_modules` va enlazado.
- Confirmar lo que reescribió el gate dentro del commit de merge (`add -A` ya está permitido fuera de la copia del
  usuario). No conviene: entrarían en `orq/integracion` cambios que nadie revisó.

La propuesta no es la única opción. Detectar con `git diff` y recuperar recreando la carpeta puede salir más corto
que abrir la guardia.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: un caso nuevo en `tests/core/workspace/integrate.cases.ts` (lo importa
  `tests/core/workspace/repos.test.ts`), con un repo de `makeRepo()`, que ya versiona `a.txt`:
  1. Gate `nodeCmd("require('fs').appendFileSync('a.txt','x')")`. Se crean dos tareas independientes (`commitFile` de
     `b.txt` en una y de `c.txt` en la otra) y se integran una tras otra. Se afirma que ninguna de las dos llamadas a
     `mgr.integrate` lanza, que la primera devuelve `ok: false` con «modificó archivos versionados» (o, si se elige
     otra política, que la segunda igual se integra), y que después de cada llamada `assertCleanIntegration(t, integ)`
     pasa: no hay `MERGE_HEAD` y `status --porcelain --untracked-files=no` está vacío.
  2. Gate que falla después de modificar un archivo que trae el merge: la tarea hace `commitFile(..., 'b.txt', …)` y
     el gate es `nodeCmd("require('fs').appendFileSync('b.txt','x'); process.exit(1)")`. Se afirma que `integrate`
     devuelve `ok: false` sin lanzar, que no queda `MERGE_HEAD` y que una segunda tarea con un gate correcto se
     integra con `ok: true`.
- Comando para correrla (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/workspace/repos.test.ts"`
  (o, desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/workspace/repos.test.ts`).
- Verificación manual en la app: en un proyecto de prueba con worktrees, poner como gate un script que escriba la
  fecha en un archivo versionado y lanzar dos tareas seguidas. La segunda tiene que integrarse, o volver al autor con
  el motivo, y no quedar `failed` con «Error del orquestador: el worktree de integración tiene cambios sin confirmar».
  Además, `git -C <worktreesRoot>/_integracion status --porcelain` debe quedar vacío.
