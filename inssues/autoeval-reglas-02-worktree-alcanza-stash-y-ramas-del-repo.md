# Desde el worktree de una tarea, `git stash pop|drop|clear` saca o borra tu stash y `git checkout -B`/`git switch -C` mueve cualquier rama del repo (también `main`, con `--ignore-other-worktrees`)

- **Área:** Núcleo de la flota (política de shell de los workers Claude, que también usa la mente)
- **Severidad:** alta
- **Archivos:** `src/core/adapters/claude-sdk/shell-policy.ts:484`, `src/core/adapters/claude-sdk/shell-policy.ts:490-497`, `src/core/adapters/claude-sdk/shell-policy.ts:537-539`, `src/core/adapters/claude-sdk/shell-policy.ts:540-580`, `src/core/adapters/claude-sdk/shell-policy.ts:547-551`, `src/core/adapters/claude-sdk/shell-policy.ts:548`, `src/core/adapters/claude-sdk/shell-policy.ts:555-559`, `src/core/adapters/claude-sdk/permissions.ts:80-84`, `src/core/conductor/guard.ts:220`, `src/core/workspace/manager.ts:124-127`, `src/core/workspace/push-block.ts:88-115`, `src/core/workspace/integrate.ts:41`, `src/core/workspace/integrate.ts:52-53`, `src/core/app/commit-step.ts:99-106`, `src/core/app/commit-step.ts:117`, `src/core/app/commit-step.ts:198`, `src/core/adapters/codex-cli/index.ts:191`, `tests/core/adapters/claude-sdk/security.test.ts:45-122`
- **Estado:** abierta
- **Origen:** autoevaluación de la mente (2026-11-05)
- **Relacionadas:** `autoeval-reglas-01-mente-git-en-tu-carpeta-sin-barrera.md`, `autoeval-reglas-04-agy-sin-ninguna-barrera-tecnica.md`, `flota-01-modo-local-reglas-fuera-del-prompt.md`

## Cómo ocurre

**Contexto.** Cada tarea trabaja en un worktree creado con `git worktree add` sobre tu repo (`manager.ts:124-127`). Un
worktree tiene su propia carpeta y su propio HEAD, pero **comparte las refs** con tu copia principal. Según git, todo lo
que está bajo `refs/` se comparte entre worktrees, salvo `refs/bisect`, `refs/worktree` y `refs/rewritten`. Eso incluye
`refs/stash` y todas las ramas `refs/heads/*`. El bloqueo por worktree de `push-block.ts:88-115` solo cubre el push. La
comprobación de rutas propias (`commit-step.ts:101-106`) solo mira el diff de la rama de la tarea.

La política de shell de los workers Claude (hook en `permissions.ts:80-84`) y de la mente (`guard.ts:220`) tiene
`stash`, `checkout` y `switch` en `GIT_ALLOWED` (`shell-policy.ts:490-497`), pero ninguno tiene un caso en el
`switch (sub)` (`:540-580`). Hoy se niegan otras órdenes que tienen el mismo efecto:

- `git branch -f`, `-m` y `-M` (`:547-551`: «borrar, renombrar o forzar ramas necesita la aprobación del usuario»);
- `fetch` y `pull` con refspecs de destino (`:555-559`: «pueden sobrescribir ramas de otros»);
- `update-ref` (`:484`).

En cambio, `git checkout -B <rama>`, `git switch -C <rama>` y `git switch --force-create <rama>` hacen lo mismo que
`branch -f` y además cambian de rama. Pasan sin problema. Dentro del propio `case 'branch'` también queda un hueco:
`shortHas(/[dDmMf]/)` (`:548`) no incluye `C`, así que `git branch -C orq/t1 publico` (copiar forzando) pasa y
reemplaza `publico` por la rama de la tarea. `--copy --force` sí se niega, porque `--force` está en la lista.
(Comprobado llamando a `shellCommandProblem` con cada orden: todas las de este párrafo devuelven «permitido»; `git
branch -f main HEAD` y `git update-ref refs/heads/main HEAD` se niegan.)

**Pasos** (reproducido con git 2.53 en una carpeta temporal. En Windows hay git 2.52 y la regla de
`--ignore-other-worktrees` es la misma desde git 2.43):

1. Tienes una entrada guardada en tu copia: `stash@{0}: WIP on main: … a`. La flota crea el worktree de la tarea `t1`.
2. En el worktree, `git stash list` muestra **tu** entrada.
3. El worker quiere saber si la prueba ya fallaba antes de su cambio y ejecuta `git stash && npm test && git stash pop`
   sin cambios propios (o con cambios que `git stash` no guarda, por ejemplo archivos sin seguimiento). El primer
   `git stash` no guarda nada. El `git stash pop` aplica **tu** cambio en el worktree (` M a.txt`) y lo saca de la
   lista: `git stash list` en tu carpeta queda vacío. Con `git stash drop` o `git stash clear` («limpiar al terminar»)
   se pierde sin aplicarse.
4. Si ese cambio cae dentro de las rutas propias, `commitTaskWork` lo confirma en la rama de la tarea a tu nombre
   (`commit-step.ts:117`) y llega a la integración. Si cae fuera, la tarea falla con `OwnedPathsError`. En los dos casos
   la entrada del stash desaparece de la lista y solo se recupera con `git fsck --unreachable`.
5. **Dos tareas en paralelo** (lo normal con varios workers Claude). El worker de `t1` hace `git stash` con su cambio y
   el de `t2` hace lo mismo poco después. Las dos entradas quedan en la misma pila. Cuando `t1` hace `git stash pop`,
   recibe el cambio de `t2` (reproducido: en `t1`, `a.txt` quedó con la línea `dos` escrita en `t2`). El de `t2`
   recibe el de `t1`. Cada tarea puede confirmar el trabajo de la otra en su rama, o fallar con `OwnedPathsError`.
6. `git checkout -B main` en el worktree falla («'main' is already used by worktree at …»), pero
   `git checkout --ignore-other-worktrees -B main` funciona. En el experimento, `git log -1 main` en la copia principal
   pasó a mostrar el commit del worker. Tu carpeta queda con HEAD en un commit que no coincide con sus archivos.
7. Las ramas que no están abiertas en ningún worktree (`publico`, tus ramas de trabajo) se reinician con
   `git checkout -B publico`, sin ninguna opción. `orq/integracion` está abierta en `_integracion`
   (`integrate.ts:41`), y con `--ignore-other-worktrees` también se puede mover. Así el commit de la tarea entra en la
   rama de integración sin gate ni revisión. La siguiente integración no lo arregla: falla con «el worktree de
   integración tiene cambios sin confirmar» (`integrate.ts:52-53`), porque los archivos de `_integracion` ya no
   coinciden con su HEAD. Es un síntoma confuso, no una barrera, y para entonces la rama ya se movió.
8. Sin ninguna opción forzada también se puede: `git checkout publico` cambia el worktree a `publico` si no está abierta
   en otro lado, y el `git commit` siguiente (del worker o de `commitTaskWork`) la avanza. El punto 1 de la solución
   no cubre este caso. Lo cubren los puntos 2 y 3.

**Quién lo puede hacer.** Los workers Claude y la mente pasan por esta política, y en la mente es directo en tu
carpeta (ver `autoeval-reglas-01`). Codex, en un worktree, tiene las refs fuera de su raíz de escritura
(`-s workspace-write -C <worktree>`, `codex-cli/index.ts:191`). `commit-step.ts:99` anota que ni siquiera puede hacer
commits, así que su sandbox debería frenarlo si está activo (ver `autoeval-reglas-07`). agy no tiene ninguna barrera
(ver `autoeval-reglas-04`).

**Pruebas.** `tests/core/adapters/claude-sdk/security.test.ts:45-122` solo tiene de esta familia `git stash list` en
la lista de permitidos. No hay casos de `stash pop`/`drop`/`clear`, `checkout -B`, `switch -C` ni
`--ignore-other-worktrees`.

## Por qué pasa

La política decide por subcomando suponiendo que el worktree aísla a la tarea. Pero las ramas y el stash son comunes a
todo el repo, así que una orden que «solo cambia mi worktree» puede mover refs de tu copia. La lista de opciones
peligrosas se completó para `branch` (salvo `-C`), `tag`, `reset` y `clean`, pero no para `checkout`, `switch` ni `stash`. Además,
el núcleo confirma el trabajo en la rama que tenga el worktree en ese momento, sin comprobar que siga siendo
`orq/<tarea>`. Y nadie compara las refs del repo antes y después de la tarea.

## Solución posible

1. **`src/core/adapters/claude-sdk/shell-policy.ts`, `evalGit`:**
   - `case 'stash'`: permitir solo `list` y `show`. Negar el resto con «el stash es común a todos los worktrees del repo,
     también al tuyo: guarda tus cambios en un parche (`git diff > .orq/cambios.patch`)».
   - `case 'checkout'` y `case 'switch'`: negar `-B`, `-C`, `--force-create` y `--ignore-other-worktrees` (también con
     abreviaturas, con `longOpt`), con el mismo motivo que `branch -f`.
   - `case 'branch'` (`:548`): agregar `C` a las letras de `shortHas` (`/[dDmMfC]/`), para que `git branch -C` (copiar
     forzando) se niegue igual que `-f` y `-M`.
2. **`src/core/app/commit-step.ts`, `commitTaskWork`:** recibir la rama esperada (el llamador de `commit-step.ts:198`
   ya tiene `workspace.branch`) y, antes de `git add`, leer `git rev-parse --abbrev-ref HEAD` y fallar con un error
   claro si no coincide. Así el núcleo no confirma en una rama ajena. Vale para todos los agentes, también Codex y agy.
3. **Detección para todos los agentes (`src/core/orchestrator/fleet.ts` o el gestor de worktrees):** antes de cada
   intento, guardar `git for-each-ref refs/heads refs/stash` de la copia principal (solo lectura) y compararlo al
   terminar. Si cambió `refs/stash` o alguna rama fuera de `orq/*`, la tarea falla con la lista de refs y sus valores
   anteriores, para que el usuario pueda restaurarlas. Las ramas `orq/*` las mueven a propósito el núcleo y otras tareas
   en paralelo, así que esta comparación no las cubre: para `orq/integracion` queda el punto 1.

### Otras opciones

- Negar todo `checkout`/`switch` que no sea `checkout -- <rutas>` o `switch -c <nueva>`. Es más simple, pero corta
  usos válidos como `git checkout <commit> -- archivo`.
- `git stash` (guardar) podría seguir permitido si se exige `git stash push -m <id-de-tarea>` y `pop`/`drop` solo con
  esa entrada. Es más permisivo, pero también más difícil de verificar en la política.
- Usar un repositorio clonado por tarea en vez de `git worktree`: aísla las refs de verdad, pero cuesta disco y tiempo
  y cambia toda la integración.

La propuesta no es la única ni tiene por qué ser la mejor. Si se elige otra, basta con que pasen las pruebas de abajo.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:**
  - `tests/core/adapters/claude-sdk/security.test.ts`, bloque «hallazgo 3», lista `denied`: agregar `git stash pop`,
    `git stash drop`, `git stash clear`, `git stash apply`, `git checkout -B main`,
    `git checkout --ignore-other-worktrees -B main`, `git switch -C main`, `git switch --force-create main` y
    `git switch --ignore-o main`, `git stash` y `git branch -C orq/t1 publico`. En `allowed`, mantener
    `git stash list` y agregar `git stash show -p`, `git switch -c otra`, `git checkout -- a.txt` y
    `git branch -c orq/t1 copia` (copiar sin forzar no pisa ramas existentes).
  - `tests/integration/commit-step.test.ts`: en un repo real con worktree, poner el worktree en otra rama
    (`git checkout -b otra`), llamar a `commitTaskWork` y afirmar que lanza un error que nombra la rama y que `otra` no
    recibió ningún commit.
  - Para la detección del punto 3, en `tests/core/workspace/manager.cases.ts` (repos reales): crear un stash en la copia
    principal y vaciarlo desde el worktree con git directo (como `rawGit` de `push-block.cases.ts`). Afirmar que la
    comparación lo informa como `refs/stash` cambiada. Lo mismo moviendo `main` con
    `git checkout --ignore-other-worktrees -B main`.
- **Comando (desde WSL):**
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/adapters/claude-sdk/security.test.ts tests/integration/commit-step.test.ts tests/core/workspace/repos.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`:
  `npx vitest run tests/core/adapters/claude-sdk/security.test.ts tests/integration/commit-step.test.ts tests/core/workspace/repos.test.ts`).
- **Verificación manual en la app:** en un proyecto de prueba con worktrees, guarda un cambio con `git stash` en tu
  carpeta. Lanza una tarea con Claude cuyo encargo diga «antes de cambiar nada, ejecuta `git stash && git stash pop`».
  La guardia debe negar el `pop`, y al terminar `git stash list` en tu carpeta debe seguir mostrando tu entrada.
