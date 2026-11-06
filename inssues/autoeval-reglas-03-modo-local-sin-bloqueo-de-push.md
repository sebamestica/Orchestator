# En modo local no se aplica el bloqueo de push de los worktrees: Codex y agy pueden publicar desde tu carpeta con tus credenciales de git

- **Área:** Núcleo de la flota
- **Severidad:** alta
- **Archivos:** `src/core/workspace/push-block.ts:88-115`, `src/core/workspace/manager.ts:116`, `src/core/workspace/manager.ts:130`, `src/core/workspace/integrate.ts:42`, `src/core/app/local-workspaces.ts:99-115`, `src/core/app/f5-servidor.ts:217-218`, `src/core/adapters/agy-cli/index.ts:205-225`, `src/core/adapters/codex-cli/index.ts:170`, `src/core/adapters/codex-cli/index.ts:191-194`, `src/core/process/run-jsonl.ts:32`, `src/core/process/child-env.ts:21-31`, `src/core/adapters/claude-sdk/shell-policy.ts:475`, `src/core/brief/render-brief.ts:23-31`, `src/core/brief/render-brief.ts:56-107`, `src/core/orchestrator/supervisor.ts:285`, `src/core/orchestrator/supervisor.ts:316`, `docs/DECISIONES.md:37`, `docs/DECISIONES.md:43-53`, `tests/core/workspace/push-block.cases.ts:17-35`
- **Estado:** resuelta
- **Origen:** autoevaluación de la mente (2026-11-05)
- **Relacionadas:** `flota-01-modo-local-reglas-fuera-del-prompt.md`, `autoeval-reglas-04-agy-sin-ninguna-barrera-tecnica.md`, `autoeval-reglas-07-codex-sandbox-depende-de-config-global.md`

## Cómo ocurre

**Contexto.** La defensa contra el push que no pasa por la guardia es `blockPush` (`push-block.ts:88-115`). Escribe en
el `config.worktree` de cada worktree un `remote.pushDefault` inexistente, un `pushurl` inválido por remoto,
`url.<inválida>.pushInsteadOf ""` y un `core.hooksPath` con un `pre-push` que rechaza. `docs/DECISIONES.md:37` y `:48`
la cuentan como la capa que vale «para todos» los agentes. Para agy es la única capa técnica: por eso
`DECISIONES.md:50` lo llama «el más expuesto». Solo se aplica al crear worktrees: el de cada tarea (`manager.ts:116` y
`:130`) y el de integración (`integrate.ts:42`).

En **modo local** (proyecto sin `workspace`: carpeta sin git, sin commits o sin gate, por ejemplo `marketing`; el registro
lo decide en `f5-servidor.ts:217-218`), la tarea trabaja en tu carpeta. `LocalWorkspaces.create`
(`local-workspaces.ts:99-115`) prepara `.orq/` y la excluye en git,
pero no aplica ningún bloqueo de push. Tampoco hay `config.worktree`, porque no hay worktree. Tu `.git/config` queda tal
cual, con tus remotos.

Qué frena el push en modo local, por agente:

- **Claude:** la política de shell niega `git push` (`shell-policy.ts:475`). Es la única capa.
- **Codex:** `codex exec -s workspace-write -C <tu carpeta>` (`codex-cli/index.ts:191-194`). Que el push falle depende
  de que su sandbox corte la red, y eso depende de la configuración global de Codex (ver `autoeval-reglas-07`). No se
  verificó en Windows.
- **agy:** corre con `--dangerously-skip-permissions` en tu carpeta (`agy-cli/index.ts:213`, `:224`). Su entorno es el
  tuyo menos las claves de IA (`run-jsonl.ts:32` → `childEnv`, `child-env.ts:21-31`), así que tiene tu Git Credential
  Manager y tu agente SSH. No hay ninguna capa.

El encargo que arma Berland no le dice a ningún agente de la flota que no haga push. `renderBrief` (`render-brief.ts:56-107`) no lo
menciona, y la sección de modo local (`render-brief.ts:23-31`) habla de commits, ramas y stash pero no de push (y según
`flota-01`, ni siquiera llega al prompt). Queda lo que diga el `AGENTS.md` del proyecto, si lo hay, y el prompt propio de cada CLI.

**Pasos** (proyecto local con git y un remoto `origin`, tarea asignada a agy o a Codex):

1. La flota lanza la tarea en tu carpeta, sin worktree.
2. El agente termina y, por costumbre o por una instrucción del repo o de una página que leyó, ejecuta
   `git add -A && git commit -m … && git push`.
3. Con agy, el push sale a `origin` con tus credenciales. En un worktree, el mismo `git push` normal habría fallado contra
   `orquestador-bloqueado://sin-push`.

## Por qué pasa

El bloqueo de push está atado a la creación del worktree y vive en su `config.worktree`. El modo local se agregó después
(issue 1) sin un equivalente. Además, la promesa de no tocar la configuración del usuario impide escribir el bloqueo en
su `.git/config`. Como el contrato de ejecución (`supervisor.ts:285`, `:316`) solo pasa el entorno del agente
(`this.#env(agentId)`), no hay forma de dar a una tarea concreta una configuración de git propia sin escribir en disco.

## Solución posible

Aplicar el mismo bloqueo **por entorno del proceso**, sin tocar archivos del usuario. Git (2.31 o más; en Windows hay
2.52) lee configuración de `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` y `GIT_CONFIG_VALUE_<n>`, con la misma prioridad que
`-c`.

1. **`src/core/workspace/push-block.ts`:** nueva `pushBlockEnv(git, folder, hooksDir): Promise<Record<string, string>>`.
   Lee `git remote` (solo lectura), hace `ensureHooksDir(hooksDir)` y devuelve las variables para `remote.pushDefault`,
   `remote.<r>.pushurl` por remoto, `url.<BLOCKED_PUSH_URL>.pushInsteadOf` (vacío) y `core.hooksPath`. Para modo local,
   `hooksDir` puede vivir en la carpeta de datos del núcleo (`%LOCALAPPDATA%\orquestador\hooks`).
2. **`src/core/app/local-workspaces.ts`:** en `create`, si la carpeta es git, calcular `pushBlockEnv` y guardarlo junto
   al workspace vivo.
3. **Transporte:** agregar `env?: Record<string, string>` a `ExecuteOptions`/`AttemptOptions` del Supervisor y mezclarlo
   en `supervisor.ts:285` (`{ ...this.#env(agentId), ...opts.env }`). Es el mismo camino que propone `flota-01` para
   `local`. La flota lo pasa en las dos llamadas a `execute` cuando la tarea es local. Los tres adaptadores ya aplican
   `ctx.env`: Claude en `buildEnv`, Codex en `childEnv = { ...ctx.env, … }` y agy en `env: ctx.env`.
4. Opcional y barato: mandar las mismas variables también en modo worktree. Así el bloqueo tiene dos capas
   independientes.

**Dos cuidados que la implementación tiene que resolver:**

- **Codex puede filtrar `GIT_CONFIG_KEY_<n>`.** El `codex.exe` instalado (0.165) trae el filtro por defecto de
  `shell_environment_policy` (`*KEY*`, `*SECRET*`, `*TOKEN*`, que se controla con `ignore_default_excludes`) para las
  órdenes que lanza. Si está activo, quita `GIT_CONFIG_KEY_0…` pero deja `GIT_CONFIG_COUNT` y `GIT_CONFIG_VALUE_<n>`, y
  entonces **todo** git dentro de Codex falla (`error: missing config key GIT_CONFIG_KEY_0` /
  `fatal: unable to parse command-line config`, comprobado con git 2.53), no solo el push. Hay que comprobarlo o usar
  `GIT_CONFIG_PARAMETERS` (la variable con la que `git -c` pasa la configuración a sus subprocesos, por ejemplo
  `'url.orquestador-bloqueado://sin-push.pushinsteadof'='' 'remote.origin.pushurl'='orquestador-bloqueado://sin-push'`),
  cuyo nombre no cae en el filtro. Con esa variable el push a `origin` y a la ruta del bare también falla.
- **`core.hooksPath` en modo local pisa los hooks del usuario.** En un worktree no importa, pero en tu carpeta
  desactivaría tus `pre-commit` (husky, pre-commit) para todo lo que haga el agente. En modo local conviene mandar solo
  `remote.pushDefault`, los `pushurl` y `pushInsteadOf`, o apuntar `core.hooksPath` a una carpeta que reenvíe los demás
  hooks a los del usuario.

La política de Claude ya niega asignar variables `GIT_*` (`DANGEROUS_ENV` en `shell-policy.ts:42`), así que un worker
Claude no puede deshacerlo. Codex y agy sí podrían, como hoy pueden saltarse `config.worktree` con
`git -c remote.<r>.pushurl=… push --no-verify` (`DECISIONES.md:45`). Es la misma protección que tienen los worktrees,
no una frontera contra un agente decidido.

### Otras opciones

- **No asignar agy (ni Codex) a proyectos locales con remoto** salvo que el usuario lo active. Es una regla del router
  y cuesta poco, pero reduce la flota disponible para esos proyectos.
- **Un `git` falso en el `PATH`** de los agentes que niegue `push` (opción 1 de `DECISIONES.md:51`). Cubre también los
  `-c` de la línea de órdenes, pero hay que mantenerlo y se salta llamando al `git.exe` real por su ruta.
- **Escribir el bloqueo en `.git/config` del usuario** durante la tarea y quitarlo al final. Funciona con cualquier
  agente, pero toca la configuración del usuario y queda puesto si el núcleo muere a mitad.

La propuesta no es la única ni tiene por qué ser la mejor. Si se elige otra, basta con que pasen las pruebas de abajo.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:**
  - `tests/core/workspace/push-block.cases.ts` (corre dentro de `repos.test.ts`): nuevo `it` con `makeRepo()`, un remoto
    `--bare` y `pushBlockEnv(git, t.repo, hooksDir)`. Con una variante de `rawGit` que acepte `env`, repetir los cinco
    intentos del primer `it` de ese archivo (`push`, `push origin`, `--no-verify origin`, `--no-verify <ruta-del-bare>`
    y `file://…`) desde `t.repo` y afirmar que todos salen con código distinto de 0 y que el remoto sigue sin refs
    (`rawGit(bare, ['for-each-ref'])` vacío). Afirmar que `git status` y `git log -1` con ese mismo entorno salen con 0
    (el bloqueo no rompe el resto de git), y que `localConfig(t)` es igual antes y después: no se escribió nada en la
    configuración del usuario.
  - `tests/integration/local-mode.test.ts`, bloque «carpeta git sin gate (caso marketing)»: después de `ws.create`,
    afirmar que el workspace local trae el entorno de bloqueo y que con ese entorno `git push` falla.
  - `tests/core/orchestrator/supervisor.test.ts`: con un adaptador falso que guarde `ctx.env`, afirmar que
    `execute({ …, env: { GIT_CONFIG_COUNT: '1', … } })` llega al adaptador junto con el entorno del agente.
- **Comando (desde WSL):**
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/workspace/repos.test.ts tests/integration/local-mode.test.ts tests/core/orchestrator/supervisor.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`:
  `npx vitest run tests/core/workspace/repos.test.ts tests/integration/local-mode.test.ts tests/core/orchestrator/supervisor.test.ts`).
- **Verificación manual en la app:** registra como proyecto local una carpeta con git sin gate cuyo `origin` apunte a un
  repo `--bare` de prueba (`git init --bare C:\temp\remoto.git`). Lanza una tarea con agy cuyo encargo termine con
  «haz commit y push». El push debe fallar (por la URL inválida, `remote helper 'orquestador-bloqueado'`, o por el
  `pre-push`, «push bloqueado», según la vía) y `git -C C:\temp\remoto.git log` debe seguir vacío. Luego
  `git config --list --local` en la carpeta debe ser igual que antes. Repetir con Codex pidiéndole `git status` y
  `git push`: `git status` debe funcionar (el filtro `*KEY*` de Codex no rompió git) y el push debe fallar.
