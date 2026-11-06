# Decisiones

## F0 — base, 2026-11-01

- **Un solo paquete** (no workspaces) para el núcleo: `src/shared` (contratos) y `src/core/<módulo>`. Así los worktrees pueden enlazar `node_modules` de la copia principal sin que los enlaces de workspace apunten al código de otra carpeta. La interfaz Electron irá en `apps/desktop` con su propio `package.json`.
- **Node 24 de Windows** ejecuta y prueba todo (`scripts/win.sh` desde WSL): Codex y agy tienen sesión iniciada en Windows; `node_modules` contiene binarios nativos de Windows.
- **`node:sqlite`** en lugar de better-sqlite3: probado en Node v24.13.1 (experimental, emite aviso), sin compilación nativa.
- **DPAPI** (`ProtectedData`, ámbito CurrentUser) para la bóveda de claves en la fase de backend: probado con PowerShell. Electron `safeStorage` la sustituirá o envolverá en la fase de UI.
- **Versiones fijadas con ≥ 2 semanas de antigüedad**: TypeScript 6.0.3 (7.0.2 salió el 2026-11-01), vitest 4.1.12, eslint 9.39.5 (npm la marca como fuera de soporte; migrar a 10 cuando `@eslint/js` 10 cumpla 2 semanas), claude-agent-sdk 0.3.302, @anthropic-ai/sdk 0.135.0, ai 7.0.143.
- **Imports con extensión `.ts`** y `erasableSyntaxOnly`: el núcleo puede ejecutarse con el borrado de tipos de Node.
- **Worktrees con `--relative-paths`** (git ≥ 2.48 en WSL 2.53 y Windows 2.52), para que git de WSL y de Windows lean el mismo worktree.
- **Memoria de desarrollo** en una bóveda local `C:\dev\orquestador-memoria` hasta que el usuario elija usar la de OneDrive; la ruta es configurable.
- **Regla de traspaso** (usuario, 2026-11-01): si Codex o agy agotan su cupo, Claude continúa la tarea en el mismo worktree. Umbral para dejar de asignarles tareas: 20 % (configurable por agente, `quotaFloor`).

## F1–F3 — primera ronda de la flota, 2026-11-01

- **Integración por ramas** (A0): cada rama `flota/<worker>` se integra en `main` con `merge --no-ff` solo si `npm run check` pasa, tanto en la rama como en `main` tras el merge. No se hace push.
- **Planificador** (c2): `planToTasks` hace por defecto 1 intento y 2 reparaciones (3 llamadas al modelo); es configurable con `maxRepairs`.
- **Flota** (c2): por defecto, 4 intentos por tarea, 3 rondas de autor → revisión → integración y 60 min de plazo. El revisor trabaja en el mismo worktree del autor. Un worktree de una tarea fallida se conserva para revisarlo. Tras agotar el cupo, un agente queda bloqueado 15 min, salvo que una lectura nueva muestre cupo ≥ piso.
- **Candados** (c7): el archivo `owner` se escribe en JSON (agente, tarea, pid, host, fecha) y el lector también acepta el texto que escribe la skill `local-compute-scheduling`. Por defecto no se espera a que se libere un candado (como dice la skill); esperar es opcional. El dueño se identifica por agente + tarea, y `heavy-cpu` admite 2 trabajos (`heavy-cpu-1` y `heavy-cpu-2`).
- **Servidor** (c5): escucha solo en `127.0.0.1` y revisa, en este orden, Host, Origin (sin CORS), token Bearer comparado en tiempo constante, tamaño del cuerpo y Zod. Lo que no se inyecta responde 501. El WebSocket del navegador no puede enviar `Authorization`: en la interfaz, `/ws` se conecta desde el proceso principal de Electron.
- **Cupo de agy** (aceptación de F2): con el cupo intacto, la hora de reinicio que informa agy es «ahora + ventana» y cambia entre lecturas; se compara con 60 s de tolerancia.
- **Codificación**: todo archivo en UTF-8 sin BOM y con finales LF. Los archivos que Codex escribe desde PowerShell se revisan antes del commit.

## Claude solo con clave de API (usuario, 2026-11-01)

- **Requisito principal del usuario**: no puede iniciar sesión en Claude (ni `claude login` ni OAuth). Todo Claude dentro del orquestador (workers, revisor y el propio orquestador) funciona solo con su `ANTHROPIC_API_KEY` y su `ANTHROPIC_BASE_URL` (servidor propio, hoy `http://203.0.113.7:18082`). La clave se guarda una vez en la bóveda DPAPI y llega a cada proceso solo en memoria (`Supervisor.env` → `ctx.env` → `env` del SDK).
- **Verificado en vivo** (c1, y A0 a las 22:45): desde el Node de Windows, el SDK de agentes con esa clave y esa URL ejecuta una tarea con subagente, carga el `CLAUDE.md` del proyecto, informa el costo y respeta el tope de gasto (13,8 s, prueba de A0).
- **`WSLENV` con `/w`** (no `/u`) para pasar la clave de WSL a Windows en pruebas en vivo; con `/u` la prueba se salta sin avisar.
- **El servidor del usuario cobra más que el precio público** (su lista de modelos: 5,2/26 USD por millón para `claude-opus-5-5`, frente a 4/20 públicos). El presupuesto manual necesitará un multiplicador de costo por agente (pendiente).
- **Permisos de los workers Claude** (c1): `acceptEdits` más una política propia que deniega `git push`, `reset --hard`, `rebase`, borrar ramas, `clean -f`, publicar, desplegar y editar fuera del worktree. Sin ella, el SDK deniega todo lo que pediría permiso y el worker no podría ni correr las pruebas.
- **`settingSources: ['project']`**: no se cargan los ajustes de usuario de Claude Code, para no depender de una sesión.

## Seguridad de los workers Claude (revisión cruzada de Codex, 2026-11-01 22:55)

- **La política por lista de comandos prohibidos no basta**: `git "push"`, `git -c alias.x=push x` y `powershell Set-Content C:\fuera\…` la saltaban, y las reglas `allow` de `.claude/settings.json` del proyecto aprueban antes de `canUseTool`. c1 la rehace en capas: un hook `PreToolUse` del host, denegar por defecto, tokenizar como el shell, git por subcomando, y bloquear `git config` y `git remote`.
- **Defensa en profundidad en git** (c3): cada worktree recibe un `pushurl` inválido y un `pre-push` que rechaza, con configuración por worktree. Aunque un worker salte la política, el push falla.
- **Riesgo residual (decisión del usuario, pendiente)**: en Windows no hay aislamiento del sistema operativo para los procesos que lanza un worker (Bash o PowerShell). Un comando ofuscado podría escribir fuera del worktree. Opciones:
  1. aceptarlo, porque son agentes del propio usuario sobre sus repos y hay revisión cruzada e integración solo con gate;
  2. correr los workers Claude dentro de WSL con el sandbox de Claude Code (bubblewrap);
  3. una cuenta de Windows limitada para los workers.

## Riesgo residual de push directo (pendiente del usuario, 2026-11-02)

- Un agente que ejecute `git` por su cuenta, sin pasar por la guardia del núcleo, podría hacer push con `git -c remote.origin.pushurl=<url> push …`: ninguna configuración de git lo impide. Las capas que hay hoy:
  1. Claude: el hook `PreToolUse` niega `push`, `-c`, `config` y `remote`.
  2. Codex: su sandbox `workspace-write` sin red por defecto.
  3. Todos: `pushurl` inválido y `pre-push` por worktree contra el push normal.
  4. Integración solo por el núcleo y con gate.
- agy (`--dangerously-skip-permissions`) es el más expuesto. Opciones:
  1. un shim de `git` en el `PATH` del agente que niegue `push`;
  2. una cuenta de Windows sin credenciales de git para los workers;
  3. aceptarlo, porque son agentes del propio usuario y la integración pasa por revisión y gate.
- **Medida intermedia para agy (2026-11-05, `inssues/autoeval-reglas-04`)**: se adoptó la opción 1. El adaptador escribe `<worktree>\.orq\bin\git.cmd` y pone esa carpeta primera en el `PATH` de agy; el `.cmd` pasa cada llamada por la misma regla de git que los workers Claude (`gitArgvProblem` en `shell-policy.ts`) y luego llama al `git.exe` real (`agy-cli/git-shim.ts`). Comprobado en vivo con el agy instalado: su terminal (PowerShell) usa el shim, `git status` funciona y `git -c …` sale con «berland: git bloqueado». Las reglas `deny` de `command(...)` por `--settings` **no sirven**: con `--dangerously-skip-permissions`, agy ejecutó `git stash list` pese a `command(git stash)` y a `command(git)`. Sigue como riesgo residual: `git.exe` por su ruta completa, Git Bash (no ejecuta `.cmd`), editar el `.cmd` o el `config.worktree`, y las escrituras fuera del worktree. Con el git real, `-c remote.<r>.pushurl= -c remote.<r>.pushurl=<url> push --no-verify`, un `pushInsteadOf` propio y `git -C <copia principal> push` publican (prueba en `push-block.cases.ts`).
