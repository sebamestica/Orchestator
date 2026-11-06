# agy corre sin ninguna barrera técnica de Berland: escribe fuera del worktree, ejecuta cualquier git y se salta el bloqueo de push con `git -C <tu copia del repo> push` o `-c remote.<r>.pushurl= -c remote.<r>.pushurl=… push --no-verify`

- **Área:** Adaptadores de agentes
- **Severidad:** media
- **Archivos:** `src/core/adapters/agy-cli/index.ts:39-53`, `src/core/adapters/agy-cli/index.ts:60-68`, `src/core/adapters/agy-cli/index.ts:205-225`, `src/core/process/run-jsonl.ts:32`, `src/core/process/child-env.ts:21-31`, `src/core/workspace/push-block.ts:7`, `src/core/workspace/push-block.ts:88-116`, `tests/core/workspace/push-block.cases.ts:43-58`, `src/core/app/commit-step.ts:101-106`, `src/core/adapters/claude-sdk/permissions.ts:73-125`, `src/core/adapters/claude-sdk/shell-policy.ts:20-23`, `docs/DECISIONES.md:38-41`, `docs/DECISIONES.md:43-53`, `docs/plan/issues/11-chrome-personal.md:57-60`, `docs/plan/issues/11-chrome-personal.md:148`, `%LOCALAPPDATA%\agy\bin\agy.exe` (fuera del repo)
- **Estado:** abierta
- **Origen:** autoevaluación de la mente (2026-11-05)
- **Relacionadas:** `autoeval-reglas-02-worktree-alcanza-stash-y-ramas-del-repo.md`, `autoeval-reglas-03-modo-local-sin-bloqueo-de-push.md`, `flota-01-modo-local-reglas-fuera-del-prompt.md`

## Cómo ocurre

**Contexto.** Los workers Claude pasan cada herramienta por un hook `PreToolUse` con la política de Berland
(`permissions.ts:73-125`): escritura solo dentro del worktree, git por subcomando, sin push ni `reset --hard`. Codex
tiene su sandbox `workspace-write` (ver `autoeval-reglas-07`). agy se lanza así (`agy-cli/index.ts:207-225`):

```ts
'-p', `Lee el archivo ${briefRelPath} y cúmplelo.`,
'--output-format', 'stream-json',
'--dangerously-skip-permissions',
...agyBrowserOffArgs(),
// cwd: ctx.worktreePath, env: ctx.env
```

`--dangerously-skip-permissions` aprueba todas las herramientas. El ejecutable lo dice así: «Print mode:
--dangerously-skip-permissions set, auto-approving all tool permissions». Lo único que Berland agrega son cuatro reglas
`deny` para navegadores MCP (`AGY_BROWSER_DENY`, `:49-53`). El entorno es el del usuario menos las claves de IA
(`run-jsonl.ts:32` → `childEnv`), así que agy tiene las credenciales de git y SSH del usuario.

Qué puede hacer agy por error, por una instrucción del repo o por una inyección en una página o un archivo:

1. **Escribir o borrar fuera del worktree:** `rm -rf C:\dev\otro-proyecto\src`, editar `C:\Users\<u>\.gitconfig` o
   escribir en otro repo. Nada lo revisa. La comprobación de rutas propias (`commit-step.ts:101-106`) solo ve lo que
   cambió dentro del worktree de la tarea.
2. **Cualquier git sobre las refs compartidas:** `git stash clear`, `git checkout --ignore-other-worktrees -B main`, etc.
   (ver `autoeval-reglas-02`).
3. **Push:** en el worktree, un `git push` normal falla por `blockPush` (`push-block.ts:88-116`): el `config.worktree`
   le pone a cada remoto `pushurl = orquestador-bloqueado://sin-push` (`:7`), un `pushInsteadOf ""` que reescribe
   cualquier URL y un `pre-push` que rechaza. La prueba `push-block.cases.ts:43-58` cubre `push`, `--no-verify` y URL
   explícita, pero no las vías siguientes. Comprobado el 2026-11-05 con Git for Windows 2.52.0 (y git 2.53 en WSL),
   en un repo descartable con ese mismo bloque en `config.worktree`:
   - `git -c remote.origin.pushurl=<url real> push --no-verify origin HEAD:x` **falla**. `pushurl` es una lista: la
     inválida del worktree queda primera, git muere con `fatal: remote helper … aborted session` y no prueba la
     segunda. La forma que da `DECISIONES.md:45` no sirve tal cual, pero las variantes de abajo sí.
   - `git -c remote.origin.pushurl= -c remote.origin.pushurl=<url real> push --no-verify origin HEAD:x` **publica**:
     el valor vacío vacía la lista (git 2.46 o más nuevo) y `--no-verify` salta el `pre-push`.
   - `git -c url.<url real>.pushInsteadOf=<url real> push --no-verify <url real> HEAD:x` **publica**: gana el
     `pushInsteadOf` más largo.
   - `git -C <tu copia del repo> push origin <rama-de-la-tarea>:x` **publica** sin ningún truco: `blockPush` solo
     escribe en el `config.worktree` del worktree de la tarea, y la copia principal no tiene bloqueo. agy la encuentra
     con `git worktree list`.
   - agy además puede editar o borrar ese `config.worktree`, que vive en `<repo>\.git\worktrees\<nombre>\`, fuera del
     worktree.

   En modo local no hay ni esa capa (ver `autoeval-reglas-03`).

Esto ya figura en `docs/DECISIONES.md:43-53` como «riesgo residual de push directo (pendiente del usuario,
2026-11-02)», con tres opciones (un `git` falso en el `PATH`, una cuenta de Windows sin credenciales o aceptarlo), y en
`:38-41` para las escrituras fuera del worktree. Tres días después sigue sin decisión, y el código no tiene ninguna
medida intermedia. La lista de opciones tampoco considera lo que agy ya ofrece (ver abajo).

**Lo que agy admite y Berland no usa.** En las cadenas del `agy.exe` instalado aparecen reglas de permiso
`command(<binario y subcomando>)` (ejemplo propio: `command(gh pr list)`), `read_file(...)`, `write_file(...)` y
`mcp(...)`, el aviso «Matches user-configured deny rule.» y hooks previos a herramientas («tool call denied by pre-tool
hook»). Berland ya comprobó que `--settings` acepta `permissions.deny` y que `/permissions` lo lista
(`11-chrome-personal.md:57-60` y `:148`). Lo que no se comprobó es que una regla `deny` se respete con
`--dangerously-skip-permissions`. El ejecutable también avisa que, sin esa opción, en modo sin interfaz las herramientas
que piden permiso «were auto-denied. Settings allow-rules do not apply». Por eso Berland no puede simplemente quitarla.

agy también tiene un **sandbox de terminal** (`agy --help`: `--sandbox`, «Run in a sandbox with terminal restrictions
enabled»; ajustes `enableTerminalSandbox`, `sandboxAllowNetwork`, `disableSandboxBypass`, `readOnlySandbox`) y
`--mode accept-edits|auto|plan`. Según el changelog del ejecutable, el sandbox deja `.git` en solo lectura y oculta
credenciales, y `auto` necesita el sandbox. Pero en Windows solo funciona desde Windows 11 24H2 («Windows before
Windows 11 24H2» no lo admite, y agy vuelve al modo normal). Este PC tiene Windows 10 22H2 (`ver`: 10.0.19045), así que
hoy no está disponible.

## Por qué pasa

agy no tiene un mecanismo como el `PreToolUse` del SDK de Claude que Berland ya usa. En modo `-p`, sin su sandbox de
terminal (no disponible en este Windows 10), solo quedan dos opciones: aprobar todo o negar todo lo que pida permiso.
Se eligió aprobar todo para que pueda trabajar, y la decisión sobre la barrera quedó pendiente. Mientras tanto, la
única defensa (el bloqueo de push del worktree) solo cubre el `git push` hecho desde el worktree, y cae con una orden
desde tu copia del repo o con un `-c` bien armado.

## Solución posible

Dos pasos baratos que no requieren decidir entre las opciones de fondo de `DECISIONES.md`:

1. **Reglas `deny` de comandos en `agyBrowserOffArgs`** (renombrar a `agySessionArgs`, en `agy-cli/index.ts:51-53`):
   sumar a `AGY_BROWSER_DENY` reglas como `command(git push)`, `command(git -c)`, `command(git -C)`,
   `command(git --git-dir)`, `command(git --work-tree)`, `command(git config)`, `command(git remote)`,
   `command(git stash)`, `command(git checkout -B)`, `command(git switch -C)`, `command(git reset --hard)`,
   `command(git clean)`, `command(gh)`, `command(npm publish)`. Las reglas `command(...)` comparan por prefijo, así que
   `cmd /c git push` o `powershell -c "git push"` no caen en ellas: cortan errores, no un agente decidido. Antes hay que
   comprobar en vivo, en una carpeta descartable, que agy las respeta con `--dangerously-skip-permissions`. Si no las
   respeta, este paso no sirve y hay que dejarlo escrito.
2. **Un `git` de Berland primero en el `PATH` de agy** (opción 1 de `DECISIONES.md:51`). Sería un `git.cmd` en la carpeta
   de datos del núcleo que niega `push`, `-c`, `--config-env`, `-C`, `--git-dir`, `--work-tree`, `--no-verify`,
   `config`, `remote`, `stash` (salvo `list`/`show`) y `checkout -B`/`switch -C`, y que para el resto llama al
   `git.exe` real. Se pasa en `ctx.env.PATH` solo para agy.
   Corta los usos normales y los errores. Llamar a `git.exe` por su ruta completa lo salta, como reconoce el riesgo
   residual de `shell-policy.ts:20-23`.

Y como red para lo que pase igual, la comparación de refs antes y después de la tarea de `autoeval-reglas-02` (punto 3)
y la de archivos de `autoeval-reglas-06` cubren a agy sin depender de él.

### Otras opciones

- **Sandbox de terminal de agy** (`--sandbox`, con `sandboxAllowNetwork: false` y `disableSandboxBypass: true` por
  `--settings`): sería la barrera del propio agy, como el sandbox de Codex. Hoy no sirve en este PC (Windows 10 22H2;
  agy lo pide desde Windows 11 24H2). Si el equipo se actualiza, el adaptador podría activarlo cuando esté disponible.
  Hay que verificar que `--dangerously-skip-permissions` no apruebe solo las salidas del sandbox y que el `.git` de un
  worktree (un archivo que apunta a `<repo>\.git\worktrees\…`) quede protegido.
- **`agy acp`** (ya previsto para F5.2 en `agy-cli/index.ts:68`): si en ACP agy pide permiso por cada herramienta con
  `session/request_permission`, Berland podría responder con la misma política que usa para Claude (`decideToolUse`).
  Sería una barrera real y sin `--dangerously-skip-permissions`. Hay que verificar que agy en ACP pide esos permisos.
- **Hook previo a herramientas de agy:** el ejecutable los soporta, pero según `agy-cli/index.ts:63-66` sus plugins
  viven en `.agents/plugins/` dentro del repo o en la configuración global del usuario, las dos fuera de lo que Berland
  quiere tocar.
- **Cuenta de Windows limitada** para los agentes CLI (`DECISIONES.md:52`): es la barrera más fuerte para escrituras y
  credenciales, pero es costosa de montar y mantener.
- **No asignar agy a proyectos en modo local** ni a tareas de rutas sensibles hasta decidir. Es solo una regla del
  router.
- **Aceptarlo** (`DECISIONES.md:53`): en ese caso conviene dejarlo escrito en `DECISIONES.md` como decidido y mostrarlo
  en la tarjeta del agente («sin barreras de Berland»), para que el usuario lo sepa al delegar.

La propuesta no es la única ni tiene por qué ser la mejor. Si se elige otra, basta con que pasen las pruebas de abajo.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:**
  - `tests/core/adapters/agy-cli/adapter.test.ts`, bloque `AgyCliAdapter.run`: con el `runner` falso que guarda los
    argumentos, afirmar que el JSON que sigue a `--settings` tiene en `permissions.deny` las reglas de navegador y las
    reglas `command(git push)`, `command(git -c)`, `command(git stash)` y `command(git checkout -B)`. Si se implementa el
    `git` propio, afirmar que `env.PATH` del runner empieza con su carpeta.
  - Si se implementa el `git` propio: `tests/core/adapters/agy-cli/git-shim.test.ts` con un repo real, un worktree con
    `blockPush` y un remoto `--bare`. Ejecutar el shim desde el worktree con `push origin HEAD:refs/heads/a`,
    `-c remote.origin.pushurl= -c remote.origin.pushurl=<bare> push --no-verify origin HEAD:refs/heads/b`,
    `-c url.<bare>.pushInsteadOf=<bare> push --no-verify <bare> HEAD:refs/heads/c`,
    `-C <copia principal> push origin <rama>:refs/heads/d`, `stash clear` y
    `checkout --ignore-other-worktrees -B main`. Afirmar código distinto de 0, `for-each-ref` del remoto vacío y refs
    del repo intactas. Como control, afirmar que el `git` real sí publica `b`, `c` y `d` sin el shim (así la prueba no
    pasa por una vía que ya fallaba). `status` y `commit -m x` deben funcionar con el shim.
  - `tests/core/workspace/push-block.cases.ts` (lo corre `repos.test.ts`): agregar las tres vías que publican como caso documentado (hoy
    `expect(code).toBe(0)` y la rama en el remoto, con un comentario a esta issue). Si una barrera las cierra, la prueba
    pasa a exigir lo contrario.
- **Comando (desde WSL):**
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/adapters/agy-cli tests/core/workspace/repos.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/adapters/agy-cli tests/core/workspace/repos.test.ts`).
- **Verificación manual en la app:** en un proyecto de prueba con worktrees y un `origin` `--bare` en `C:\temp`, lanza
  una tarea con agy cuyo encargo pida «ejecuta `git -c remote.origin.pushurl= -c remote.origin.pushurl=C:/temp/remoto.git
  push --no-verify origin HEAD:refs/heads/robada`, luego `git -C <carpeta del proyecto> push origin HEAD:refs/heads/robada2`,
  y escribe `C:\temp\fuera.txt`». Los dos push deben fallar, `git --git-dir=C:\temp\remoto.git branch` no debe listar
  `robada` ni `robada2` y, si se adoptó una barrera de escritura, `C:\temp\fuera.txt` no debe existir. Si no se adoptó,
  la decisión debe quedar escrita en `DECISIONES.md`.
