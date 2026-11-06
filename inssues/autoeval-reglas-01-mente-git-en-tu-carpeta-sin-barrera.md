# En bypass y chat la mente puede fusionar en `main`, hacer commits, cambiar de rama y descartar tus cambios sin confirmar en tu carpeta: la política de shell frena push, rebase, `reset --hard`, `clean -f` y borrar ramas, pero deja pasar `merge`, `commit`, `checkout`, `restore` y `stash`

- **Área:** Mente y chat
- **Severidad:** alta
- **Archivos:** `src/core/conductor/session.ts:59`, `src/core/conductor/session.ts:65-67`, `src/core/conductor/session.ts:313`, `src/core/chat/service.ts:313`, `src/core/conductor/guard.ts:16-18`, `src/core/conductor/guard.ts:84`, `src/core/conductor/guard.ts:212-221`, `src/core/conductor/prompt.ts:27`, `src/core/conductor/prompt.ts:54`, `src/core/conductor/prompt.ts:149`, `src/core/conductor/prompt.ts:151-152`, `src/core/conductor/prompt.ts:160-161`, `src/core/adapters/claude-sdk/shell-policy.ts:474-488`, `src/core/adapters/claude-sdk/shell-policy.ts:490-497`, `src/core/adapters/claude-sdk/shell-policy.ts:540-580`, `src/core/adapters/claude-sdk/shell-policy.ts:789-791`, `src/core/workspace/integrate.ts:27`, `src/core/adapters/claude-sdk/permissions.ts:83`, `tests/core/conductor/guard.test.ts:193-207`, `tests/core/adapters/claude-sdk/security.test.ts:94-107`, `tests/core/conductor/prompt.test.ts:75-79`
- **Estado:** abierta
- **Origen:** autoevaluación de la mente (2026-11-05)
- **Relacionadas:** `flota-01-modo-local-reglas-fuera-del-prompt.md` (el mismo hueco para la flota en modo local; su opción (c) usa el mismo mecanismo), `autoeval-reglas-02-worktree-alcanza-stash-y-ramas-del-repo.md`, `mente-05-cd-fuera-bloquea-shell-sesion.md`

## Cómo ocurre

**Contexto.** En `bypass` (con proyecto) y en `chat`, la mente suma Bash y PowerShell (`session.ts:59`, `modeActs` en
`session.ts:65-67`). La raíz del shell es la carpeta del chat (`session.ts:313`: `shellRoot: o.cwd`), y en un chat de
proyecto esa carpeta es `project.repoPath` (`chat/service.ts:313`: `cwd = requireDir(body.cwd ?? project.repoPath, 'cwd')`).
Es decir, la mente trabaja sobre **tu copia real**, en tu rama y con tus cambios sin confirmar. No es un worktree
desechable. Cada comando pasa por la política de los workers con esa raíz (`guard.ts:220`:
`shellCommandProblem(command, kind, shellRoot, dir)`).

El prompt le prohíbe varias cosas que el código no impide:

- `prompt.ts:27`: «Push, merge a main, borrar ramas, reescribir historia, desplegar o pagar: solo con aprobación explícita del usuario».
- `prompt.ts:54`: «En ningún modo haces push, pasas a main, despliegas, pagas, borras ramas ni reescribes la historia».
- `prompt.ts:151` (bypass) y `:160` (chat): «no cambies de rama ni hagas commits salvo que el usuario lo pida».
- `prompt.ts:152` y `:161`: «Push, despliegue, pagos, borrar ramas y reescribir la historia siguen prohibidos, también por comandos».

Además, la misma línea `prompt.ts:152` empieza con «El paso a main lo hace la flota si el gate pasa». Ningún código
lo hace: `baseBranch` solo aparece en `integrate.ts:27`, que crea la rama de integración, y en la configuración. La
mente lee en su prompt que pasar a `main` es un paso normal del ciclo, y no hay nadie que lo ejecute.

La política de git (`shell-policy.ts`) bloquea `push`, `send-pack`, `http-push`, `rebase`, `config`, `remote`,
`filter-branch`, `filter-repo`, `replace`, `update-ref`, `symbolic-ref`, `clone` y `submodule` (`GIT_BLOCKED`,
`:474-488`). Permite como subcomandos conocidos `merge`,
`commit`, `checkout`, `switch`, `restore`, `stash`, `reset`, `pull`, `cherry-pick`, `revert` y `am` (`GIT_ALLOWED`,
`:490-497`). El `switch (sub)` de `:540-580` solo agrega condiciones para `reset --hard`, `clean -f`,
`branch -d/-m/-f`, `tag -d/-f`, refspecs de `fetch`/`pull`, `pull --rebase`, `worktree`, `reflog`, `bisect run`,
`apply --unsafe-paths`, `grep -O` y `notes`. No hay ningún caso para `merge`, `commit`, `checkout`, `switch`, `restore`
ni `stash`.

**Pasos** (chat de un proyecto en `bypass`; tu carpeta está en `main` y tienes cambios sin confirmar en `src/a.ts`):

1. La mente edita `src/a.ts`, una prueba falla y decide deshacer «su» cambio con `git checkout -- src/a.ts` (o
   `git restore src/a.ts`, o `git checkout -f`). La guardia lo deja pasar. También se pierden tus cambios previos en ese
   archivo, sin copia. Sobre ese archivo es el mismo efecto que `git reset --hard`, que sí está bloqueado
   (`shell-policy.ts:541-543`, «git reset --hard descarta trabajo»).
2. Para ver si la prueba ya fallaba antes: `git stash; npm test; git stash pop`. `git stash` se lleva tus cambios junto
   con los suyos. Si después algo falla a mitad, quedan en el stash. Si no había nada que guardar, el `pop` aplica una
   entrada vieja de tu stash (ver `autoeval-reglas-02`).
3. Le pides «déjalo integrado» y la mente ejecuta `git merge orq/integracion` (o `git pull`, o `git cherry-pick …`) en
   `main`. Berland nunca fusiona en `main` por su cuenta: `integrate.ts:27` solo crea la rama de integración desde
   `baseBranch`. Ese paso es justo el que el prompt reserva al usuario, y nada lo impide.
4. `git commit --amend`, `git reset --soft HEAD~2`, `git reset HEAD~2` (el `--mixed` por defecto) o
   `git checkout -B main <otra>` reescriben o mueven tu rama. La política solo trata como «reescribir la historia» a
   `rebase`, `filter-branch`, `filter-repo` y `replace`, y solo niega mover ramas con `branch -f/-m` y `update-ref`.

Comprobado llamando a `shellCommandProblem(cmd, kind, raiz, raiz)` en el commit `63748b8`, con Bash y con PowerShell:
`git merge orq/integracion`, `git pull`, `git cherry-pick abc123`, `git revert HEAD`, `git am x.patch`,
`git checkout -- src/a.ts`, `git checkout .`, `git checkout -f`, `git checkout otra`, `git checkout -B main otra`,
`git switch -c nueva`, `git switch --discard-changes otra`, `git restore src/a.ts`, `git stash`, `git stash pop`,
`git stash drop`, `git stash clear`, `git stash; npm test; git stash pop`, `git commit --amend -m x`,
`git reset --soft HEAD~1`, `git reset --keep HEAD~1`, `git reset --merge HEAD~1` y `git reset HEAD~2` devuelven
`undefined` (permitido). Solo `git reset --hard` devuelve «git reset --hard descarta trabajo».

El prompt de bypass empuja además a buscar otra vía cuando algo se niega: «Si una herramienta no cubre lo que
necesitas, busca el mismo efecto por otro camino» (`prompt.ts:149`). El rechazo de la guardia termina con «Busca otra
vía dentro del proyecto» (`guard.ts:84`). Si `git reset --hard` se niega, el camino equivalente (`git checkout -- .`)
está abierto.

**Evidencia en las pruebas.** `tests/core/conductor/guard.test.ts:193-207` comprueba que el shell de la mente niega
`git push`, `git reset --hard HEAD~1`, `git rebase main` y `git branch -D vieja`. No hay ningún caso de `merge`,
`checkout --`, `restore`, `stash pop`, `commit --amend` ni `checkout -B`.

## Por qué pasa

La mente usa la misma política que los workers (`guard.ts:16-18` y `:220`, igual que el hook de los workers en
`permissions.ts:83`), y esa política se diseñó para un worktree
desechable, donde descartar cambios, cambiar de rama o fusionar solo afecta a la tarea y la integración vuelve a
comprobar todo. En la carpeta del usuario no hay worktree ni integración que lo revise: cada `checkout`, `restore`,
`stash` o `merge` actúa sobre su trabajo real. La regla «no pases a main, no cambies de rama, no reescribas» existe solo
en el prompt.

## Solución posible

1. **`src/core/adapters/claude-sdk/shell-policy.ts`:** agregar `userCopy?: boolean` a `ShellContext` y un parámetro de
   opciones a `shellCommandProblem` (`:789`). Con `userCopy`, `evalGit` niega además:
   - `merge` (salvo `--abort`), `pull`, `cherry-pick`, `revert` y `am`: «traer cambios a tu rama lo haces tú o lo apruebas tú»;
   - `commit --amend` y `reset` con `--soft`, `--mixed`, `--keep` o `--merge`, o cuyo primer argumento no sea `HEAD`
     ni una ruta que exista (`HEAD~1`, `abc123`, `origin/main` mueven la rama). Sigue permitido `git reset` sin
     argumentos y `git reset [HEAD] [--] <rutas>` para sacar del índice, como hoy `security.test.ts:102` permite
     `git reset HEAD a.txt` a los workers;
   - `checkout` y `switch` que cambian de rama o de HEAD (`checkout <rama>`, `-b`, `-B`, `--detach`, `switch …`) o que
     descartan (`checkout -- <rutas>`, `checkout .`, `-f`, `switch --discard-changes`/`-f`);
   - `restore` sin `--staged` (el `restore` del árbol de trabajo descarta);
   - `stash` salvo `list` y `show`.
   El mensaje debe decir qué hace la orden y que se lo pida al usuario («ejecútalo tú o dime que lo haga»). La
   política de los workers (`permissions.ts:83`) no pasa la opción y queda como está.
2. **`src/core/conductor/guard.ts`:** opción `shellUserCopy: true` que se pasa a `shellCommandProblem` en `:220`.
   **`src/core/conductor/session.ts:313`:** activarla siempre que haya `shellRoot`, porque la mente nunca trabaja en un
   worktree.
3. `git commit` sin `--amend` puede quedar permitido, porque el prompt lo admite cuando el usuario lo pide y no destruye
   nada. Es una decisión abierta (ver abajo).
4. **`src/core/conductor/prompt.ts:152`:** cambiar «El paso a main lo hace la flota si el gate pasa» por lo que pasa de
   verdad: la flota integra en la rama de integración y pasar a `main` lo hace el usuario (como dice `:141` en auto).

### Otras opciones

- **Interruptor por chat:** «permitir git que cambia tu rama» en la interfaz, apagado por defecto. Cuando está apagado,
  rige la lista de arriba. Cuando el usuario lo enciende, pasa lo que pasa hoy. Cuesta un ajuste más, pero respeta el
  «salvo que el usuario lo pida» del prompt sin un mecanismo de pregunta que la mente no tiene (`permissionMode: 'dontAsk'`).
- **Negar también `commit`** en la carpeta del usuario: es más estricto y más simple de explicar, pero obliga al usuario a
  confirmar todo a mano.
- **Red de seguridad en vez de bloqueo:** antes de cada comando git que escriba, guardar `git stash create` (no toca
  refs) y la lista de refs para poder deshacer. Protege más casos (scripts), pero es más código y más git por comando.
- Reutilizar el mismo `userCopy` para la flota en modo local cierra la opción (c) de `flota-01`.

La propuesta no es la única ni tiene por qué ser la mejor. Si se elige otra, basta con que pasen las pruebas de abajo.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:**
  - `tests/core/conductor/guard.test.ts`, bloque «guardia de bypass: escritura y shell (disco real)», nuevo
    `it('en la carpeta del usuario no fusiona, no cambia de rama ni descarta cambios')`. Con la guardia del bloque (que
    tiene `shellRoot`), afirmar `allowed(...) === false` y un motivo que nombre la orden para `git merge orq/integracion`,
    `git pull`, `git cherry-pick abc123`, `git checkout -- src/a.ts`, `git checkout .`, `git checkout -f`,
    `git checkout otra`, `git switch -c nueva`, `git checkout -B main`, `git restore src/a.ts`, `git stash`,
    `git stash pop`, `git stash drop`, `git stash clear`, `git stash; npm test; git stash pop`,
    `git commit --amend -m x`, `git reset --soft HEAD~1`, `git reset --keep HEAD~1` y `git reset HEAD~1`
    (Bash y PowerShell).
  - En el mismo `it`, seguir en `true`: `git status`, `git diff --stat`, `git log -3`, `git add -A`, `git commit -m x`,
    `git restore --staged src/a.ts`, `git reset`, `git reset HEAD src/a.ts`, `git stash list` y `git merge --abort`.
  - `tests/core/adapters/claude-sdk/security.test.ts` como control: agregar `git checkout -- a.txt` a la lista
    `allowed` (`:94-107`, que ya tiene `git commit -m …` y `git reset HEAD a.txt`). Sin `userCopy`, la política de los
    workers sigue permitiéndolos en su worktree (salvo lo que cambie `autoeval-reglas-02`).
  - `tests/core/conductor/prompt.test.ts` (junto al caso de `:75-79`, que arma los prompts de cada modo con
    `buildConductorSystemPrompt`): el de bypass no contiene «El paso a main lo hace la flota».
- **Comando (desde WSL):**
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/conductor/guard.test.ts tests/core/conductor/prompt.test.ts tests/core/adapters/claude-sdk/security.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`:
  `npx vitest run tests/core/conductor/guard.test.ts tests/core/conductor/prompt.test.ts tests/core/adapters/claude-sdk/security.test.ts`).
- **Verificación manual en la app:** en un proyecto de prueba con git, deja un cambio sin confirmar en un archivo y
  abre un chat en `bypass`. Pídele a la mente, de forma explícita para que no se frene por el prompt, «ejecuta
  `git checkout -- <archivo>`» y luego «te autorizo: ejecuta `git merge orq/integracion` en main». En el chat, las dos
  llamadas a Bash deben volver con «Bash bloqueado por la guardia: …» y el motivo de cada orden. Al final,
  `git status`, `git log -1` y `git stash list` deben quedar como antes.
