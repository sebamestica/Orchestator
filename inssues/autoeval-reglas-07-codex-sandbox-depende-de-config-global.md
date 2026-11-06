# La única barrera de Codex es su sandbox, y en Windows lo configura tu `~/.codex/config.toml`: Berland no lo fija ni comprueba que esté activo, y en modo `unelevated` la red no queda cortada

- **Área:** Adaptadores de agentes
- **Severidad:** media
- **Archivos:** `src/core/adapters/codex-cli/index.ts:96-116`, `src/core/adapters/codex-cli/index.ts:137-156`, `src/core/adapters/codex-cli/index.ts:190-194`, `src/core/app/commit-step.ts:99`, `docs/DECISIONES.md:45-49`, `tests/core/adapters/codex-cli/adapter.test.ts:53`, `tests/core/adapters/codex-cli/adapter.test.ts:170-180`, `C:\Users\<u>\.codex\config.toml:32-33` y `C:\Users\<u>\.codex\rules\default.rules` (fuera del repo)
- **Estado:** abierta
- **Origen:** autoevaluación de la mente (2026-11-05); revisado y comprobado sin gastar cupo el mismo día
- **Relacionadas:** `autoeval-reglas-02-worktree-alcanza-stash-y-ramas-del-repo.md`, `autoeval-reglas-03-modo-local-sin-bloqueo-de-push.md`, `autoeval-reglas-04-agy-sin-ninguna-barrera-tecnica.md`, `uso-real-03-codex-falla-en-proyectos-locales-sin-git.md`

## Cómo ocurre

**Contexto.** Codex no pasa por la política de shell de Berland: no tiene hook ni lista de órdenes. Lo único que le
impide escribir fuera del worktree, tocar las refs del repo o hacer push es su propio sandbox. Berland lo pide con un
solo argumento (`codex-cli/index.ts:191`):

```ts
args: [..., 'exec', '--json', ..., '-s', 'workspace-write', '-C', ctx.worktreePath, '-o', …, '-'],
```

`docs/DECISIONES.md:47` cuenta como capa contra el push «Codex: su sandbox `workspace-write` sin red por defecto», y
`commit-step.ts:99` da por hecho que «Codex no puede hacer commits en su sandbox», porque la carpeta git de un worktree
está en el `.git` de la copia principal, fuera de su raíz de escritura. Las dos cosas dependen de que el sandbox esté
activo en Windows y de cómo esté configurado.

En Windows el modo del sandbox sale de una clave de la configuración **global** del usuario. En este equipo es
`C:\Users\<u>\.codex\config.toml:32-33`:

```toml
[windows]
sandbox = "unelevated"
```

Codex 0.165.0 admite `elevated`, `unelevated` y `mxc` (con otro valor, `-c windows.sandbox="xyz"` falla con «unknown
variant `xyz`, expected one of `elevated`, `unelevated`, `mxc`»). Berland no pasa esa clave ni las de
`sandbox_workspace_write` (red y raíces extra de escritura), y su `probe` solo mira `--version` y `login status`
(`codex-cli/index.ts:137-156`). El archivo es del usuario y lo comparten la CLI y la app de escritorio de Codex (el
`notify` de su primera línea apunta al runtime de la app). Cualquiera de las dos, o el propio usuario, puede cambiarlo
sin que Berland lo note.

**Lo que se comprobó** (2026-11-05, codex-cli 0.165.0, sin modelo ni cupo y sin tocar `~/.codex`: los casos «sin la
clave» y «con la red abierta» se probaron con un `CODEX_HOME` temporal). `codex debug prompt-input` muestra la política
efectiva que Codex le describe al modelo, y `codex sandbox --permission-profile :workspace -C <carpeta> -- <orden>`
ejecuta una orden dentro del sandbox:

1. **Sin `[windows] sandbox`**, `codex debug prompt-input -c sandbox_mode="workspace-write"` informa «`sandbox_mode` is
   `read-only`». Codex rebaja `workspace-write` a solo lectura. Falla cerrado: no se escapa, pero Codex ya no puede editar
   el worktree y las tareas fallan o terminan sin cambios. Berland no avisa del motivo. Con
   `-c windows.sandbox="unelevated"` vuelve a `workspace-write`. No se comprobó con `codex exec` y un modelo, pero la
   configuración se carga igual.
2. **Si `config.toml` agrega** `[sandbox_workspace_write] network_access = true` y `writable_roots = ["C:\\dev"]`, la
   política pasa a «Network access is enabled» y `C:\dev` queda como raíz de escritura. Desde ahí se escribe en el `.git`
   de cualquier repo bajo `C:\dev`, también en las refs que comparten los worktrees. El `-s` de Berland no lo impide.
   Con `-c sandbox_workspace_write.network_access=false -c sandbox_workspace_write.writable_roots=[]` vuelve a «restricted»
   y a una sola raíz: los `-c` mandan sobre el archivo.
3. **Con la configuración de hoy (`unelevated`)**, la escritura sí está aislada. Escribir en una carpeta fuera de la raíz
   (y fuera de `%TEMP%`) da «Acceso denegado». La red no está cortada: el sandbox solo pone
   `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`GIT_HTTP(S)_PROXY=http://127.0.0.1:9` y deja `ssh.cmd`/`scp.cmd` falsos en
   `C:\Users\<u>\.sbx-denybin\`. Dentro del sandbox, `curl.exe https://example.com` falla, pero
   `curl.exe --noproxy "*" http://example.com` da 200, y tras borrar las variables de proxy,
   `git -c http.sslBackend=openssl ls-remote https://github.com/git/git.git HEAD` responde. Con schannel, el TLS falla por
   falta de credenciales del token restringido. No se probó un `push` ni si el administrador de credenciales de git
   responde dentro del sandbox. Aun así, la «capa sin red» de `DECISIONES.md:47` es solo de buena fe: un agente que borre
   las variables o use `--noproxy` sale a internet.
4. **Reglas globales.** El prompt de Codex dice: «Commands are run outside the sandbox if they are approved by the user,
   or match an existing rule that allows it to run unrestricted». Esas reglas viven en
   `C:\Users\<u>\.codex\rules\default.rules`, otro archivo global. Hoy tiene 7 reglas `allow` muy concretas de otros
   proyectos (`Get-Location`, órdenes de PowerShell de `C:\dev\FasterRighter`). La app las agrega cada vez que el
   usuario pulsa «permitir siempre», y Berland no pasa `--ignore-rules`, que `codex exec` sí admite.

Berland ya hace lo contrario con los navegadores de Codex: los apaga «solo por argumentos (`~/.codex/config.toml` no se
toca)» y lo comprobó con `codex debug prompt-input` (`codex-cli/index.ts:96-116`). Con el sandbox, que es la barrera más
importante, no hace lo mismo.

## Por qué pasa

Se pidió `-s workspace-write` y se dio por hecho que lo demás venía con los valores por defecto: que el modo de Windows
existe, que no hay red, que no hay raíces extra ni reglas que saquen órdenes del sandbox. En Windows nada de eso lo
decide el `-s`. Lo deciden `config.toml` y `rules/` del usuario, que Berland no controla, y el modo `unelevated` no
corta la red de verdad. `DECISIONES.md:47` anotó la capa sin haberlo comprobado.

## Solución posible

1. **`src/core/adapters/codex-cli/index.ts`, en los argumentos de `exec` (`:191`):** fijar por argumentos lo que la
   barrera necesita, igual que `codexBrowserOffArgs`, en una función `codexSandboxArgs()` que vaya antes de `-`:
   - `-c windows.sandbox="unelevated"`, o el valor que el usuario elija en un campo opcional de la configuración del
     agente en Berland (`elevated` exige preparar la máquina con permisos de administrador; no forzarlo sin preguntar);
   - `-c sandbox_workspace_write.network_access=false`;
   - `-c sandbox_workspace_write.writable_roots=[]`;
   - `--ignore-rules`, para que ninguna regla `allow` global o del proyecto saque órdenes del sandbox.

   Las tres claves `-c` se comprobaron arriba con `codex debug prompt-input`: Codex las acepta y mandan sobre
   `config.toml`. `--ignore-rules` figura en `codex exec --help` de 0.165.0.
2. **`probe` (`:137-156`):** añadir una tercera orden sin modelo, `codex debug prompt-input` con los mismos `-c` y una
   carpeta temporal como `cwd`. Leer de la salida la línea «Filesystem sandboxing…» y exigir «`sandbox_mode` is
   `workspace-write`» y «Network access is restricted». Si no aparece, agregar un aviso en `warnings` que nombre la clave
   (`[windows] sandbox` o `sandbox_workspace_write`). La orden tarda unos segundos: darle más que los 10 s actuales.
3. **`docs/DECISIONES.md:47`:** corregir la capa. En modo `unelevated`, Codex escribe solo en su worktree, pero la red
   solo está cortada por variables de proxy. No contarla como barrera contra el push, o contarla solo con `elevated`
   después de comprobar que ese modo sí corta la red.

### Otras opciones

- **`codex exec --ignore-user-config`** («Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`»). Deja
  fuera de golpe la red, las raíces extra y los MCP y plugins globales, sin copiar `auth.json`. A cambio hay que pasar
  por `-c` todo lo que hoy se hereda: `windows.sandbox`, el proveedor y el modelo, y la confianza de proyectos que
  necesita `uso-real-03`. Puede simplificar `codexBrowserOffArgs`.
- **Leer `~/.codex/config.toml`** desde Berland y negarse a lanzar Codex si falta `[windows] sandbox` o si la red está
  abierta. Es más explícito, pero obliga a parsear TOML ajeno y a seguir sus cambios. Además no cubre `rules/`.
- **`CODEX_HOME` propio de Berland** con una configuración mínima. Aísla también `AGENTS.md` y las reglas globales, pero
  hay que copiar la sesión de `auth.json` del usuario, y eso es delicado.
- **Aceptar la dependencia y documentarla** en `DECISIONES.md` junto a la capa de `:47`, para que no se dé por
  garantizada.

La propuesta no es la única ni tiene por qué ser la mejor. Si se elige otra, basta con que pasen las pruebas de abajo.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:**
  - `tests/core/adapters/codex-cli/adapter.test.ts`, bloque `Codex CLI`: con el `runner` falso que guarda los argumentos,
    afirmar que el `exec` lleva `-s workspace-write`, `-c windows.sandbox="unelevated"`,
    `-c sandbox_workspace_write.network_access=false`, `-c sandbox_workspace_write.writable_roots=[]` e `--ignore-rules`,
    y que todo va antes de `-` (stdin). La expectativa exacta de `:53` (`toEqual` con la lista entera) hay que
    actualizarla con `...codexSandboxArgs()`.
  - Mismo archivo, junto a `probe lee versión y sesión sin inferencia` (`:170`): con un runner falso que responde a
    `debug prompt-input` con un JSON cuyo texto dice «`sandbox_mode` is `read-only`», afirmar que `warnings` contiene
    el aviso del sandbox. Con «`workspace-write`… Network access is restricted», afirmar que no hay aviso. Con «Network
    access is enabled», afirmar el aviso de red.
- **Comando (desde WSL):**
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/adapters/codex-cli"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/adapters/codex-cli`).
- **Verificación manual:**
  1. Sin gastar cupo, desde PowerShell en una carpeta vacía: copia `~/.codex/config.toml` a una carpeta temporal,
     quítale `[windows] sandbox` y agrégale `[sandbox_workspace_write]` con `network_access = true`. Con
     `$env:CODEX_HOME` apuntando a esa copia, ejecuta `codex debug prompt-input -c sandbox_mode="workspace-write"` más
     los `-c` que arma `codexSandboxArgs()`. La línea «Filesystem sandboxing…» debe decir `workspace-write` y «Network
     access is restricted». Sin esos `-c` dice `read-only`.
  2. En la app, pantalla de agentes: con `[windows] sandbox` comentado en una copia de `config.toml` (y `CODEX_HOME`
     apuntando a esa copia al abrir Berland), Codex debe mostrar el aviso del sandbox en vez de aparecer como listo.
  3. En un proyecto de prueba con worktrees, lanza una tarea con Codex cuyo encargo pida «escribe
     `C:\dev\fuera-codex.txt` y ejecuta `git checkout -B prueba-fuera`». El archivo no debe aparecer y la rama
     `prueba-fuera` no debe existir en la copia principal (`git branch --list prueba-fuera`). No usar una ruta de
     `%TEMP%`: el sandbox la deja escribible por defecto.
