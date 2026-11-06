# Codex falla al instante en proyectos locales sin git: gasta dos intentos y Claude arranca con más esfuerzo

- **Área:** Evidencia de uso real (adaptador de Codex en modo local)
- **Severidad:** media
- **Archivos:** `src/core/adapters/codex-cli/index.ts:191-192`, `src/core/adapters/codex-cli/index.ts:195-201`, `src/core/adapters/codex-cli/index.ts:211-213`, `src/core/adapters/codex-cli/translate.ts:16-20`, `src/core/orchestrator/supervisor.ts:21`, `src/core/orchestrator/supervisor.ts:244-254`, `src/core/orchestrator/router.ts:176`, `src/core/orchestrator/router.ts:208`, `src/core/brief/reasoning.ts:21`, `src/core/brief/reasoning.ts:28-38`, `src/core/app/local-workspaces.ts:22`, `src/core/app/local-workspaces.ts:99-113`, `src/core/app/local-workspaces.ts:155`, `src/core/app/f5-servidor.ts:217-218`, `src/core/orchestrator/fleet.ts:367`, `src/core/orchestrator/fleet.ts:542-555`, `tests/core/adapters/codex-cli/adapter.test.ts:20`, `tests/core/adapters/codex-cli/adapter.test.ts:53`
- **Estado:** abierta
- **Fusiona:** `adaptadores-01-codex-local-sin-git-rechaza.md` (revisión de los adaptadores), que describía la misma
  causa leyendo el código. Ese archivo se borró. Este agrega la prueba de que ya pasó en uso real, con sesiones, horas y
  el costo que tuvo; lo que aportaba el otro está en «Lo que confirma el código» y en las pruebas.

## Cómo ocurre
Desde el issue 1 (modo local), un proyecto registrado en una carpeta sin git queda sin `workspace`. La flota trabaja
entonces directo en esa carpeta (`src/core/app/local-workspaces.ts:22`: «registrado sin `workspace` (sin git o sin
gate)»). `create` devuelve la propia carpeta como ruta de trabajo (`local-workspaces.ts:107`):

```ts
const workspace: Workspace = { taskId: task.id, path: project.repoPath, branch: LOCAL_BRANCH };
```

El adaptador de Codex lanza siempre `codex exec` con los mismos argumentos, sin `--skip-git-repo-check`
(`src/core/adapters/codex-cli/index.ts:191-192`):

```ts
args: [...this.executable.args, 'exec', '--json', ...codexEffortArgs(task, runHints(ctx).retries), ...plugins.args, '-s', 'workspace-write', '-C', ctx.worktreePath,
  '-o', join(ctx.worktreePath, '.orq', 'ultimo-mensaje.md'), ...(this.config.model ? ['-m', this.config.model] : []), '-'],
```

Si la carpeta no es git y no está marcada como confiable en `~/.codex/config.toml`, Codex corta antes de empezar el
turno. El propio repo conoce esa opción: `fixtures/codex/capture.mjs:20` y `tests/live/chrome-personal.live.test.ts:104`
la agregan para correr Codex en carpetas sin git. El adaptador de producción no la agrega.

Lo que confirma el código (aporte de adaptadores-01):
- El alta desde carpeta solo arma `workspace` con git, al menos un commit y gate; si falta algo, el proyecto queda en
  modo local (`src/core/app/f5-servidor.ts:217-218`). El resto del código ya contempla carpetas sin git, por ejemplo
  `local-workspaces.ts:155`: `if (!(await exists(join(project.repoPath, '.git')))) return;`.
- El binario instalado (codex-cli 0.165.0, `…/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`)
  contiene el texto «Not inside a trusted directory and --skip-git-repo-check was not specified.» y la ayuda «Allow
  running Codex outside a Git repository».
- Nada excluye a Codex de los proyectos locales: la flota solo cambia el brief (`fleet.ts:367`), y el router prefiere
  Codex o agy con cupo para tareas `low`/`medium` (`router.ts:176`) y como revisor de Claude (`router.ts:208`).
- Excepción: si la ruta exacta figura con `trust_level = "trusted"` en `~/.codex/config.toml`, Codex podría dejarla
  pasar (no se comprobó sin ejecutar). Berland no escribe esa confianza, y una carpeta nueva no la tiene.
- La prueba unitaria usa un `mkdtemp` sin git (`adapter.test.ts:20`) con un runner falso, así que nunca ve el rechazo
  real.

Evidencia real, leída de una copia de `%LOCALAPPDATA%\orquestador\orquestador.db` y de `logs\nucleo-escritorio.log`:

- Proyecto `professional`, en `C:\dev\professional`, con `workspace_json` nulo. La carpeta no tiene `.git`, y tampoco
  `C:\dev` ni `C:\`. En `~/.codex/config.toml` no figura esa carpeta entre las confiables. Sí figuran otras, como
  `c:\dev\vetworld`, `c:\dev\orquestador`, `c:\dev\pitchs` y `c:\users\sebastian`.
- Tarea `contexto-github`: `difficulty: medium`, `suggestedAgent: codex`. El log dice
  «contexto-github: modo local en C:\dev\professional (sin worktree ni commits)».
- Sesión Codex `5ea882c9`, de 01:05:07.804Z a 01:05:08.170Z: `raw` `codex-stderr` «Not inside a trusted directory and
  --skip-git-repo-check was not specified.», después `error` `crash` «Codex terminó con código 1» y `done {ok:false}`.
- Sesión Codex `4d15613d`, de 01:05:08.189Z a 01:05:08.544Z: los mismos cuatro eventos.
- Sesión Claude `5748490f`, desde 01:05:08.563Z: toma la tarea en `C:\dev\professional`, corre unos 4 min 20 s y gasta
  0,74 USD según su evento `usage`.

Pasos:
1. Registrar un proyecto en una carpeta sin git que Codex no tenga como confiable.
2. Delegar una tarea que el router dé a Codex, por sugerencia (`router.ts:147` y siguientes) o por cupo
   (`router.ts:176`). Nada en el router mira si el proyecto es local.
3. Codex sale con código 1 en menos de 0,4 s. La línea de stderr no coincide con `classifyCodexError`, que solo
   reconoce cupo y autenticación (`translate.ts:16-20`), así que sale como `raw` (`index.ts:211-213`). El error queda
   como «Codex terminó con código 1» (`index.ts:195-201`), sin el motivo.
4. El Supervisor lo cuenta como un fallo cualquiera: `failures++` y `retries++`, y vuelve al mismo agente
   (`supervisor.ts:244-254`). Codex vuelve a fallar. Con `FAILURES_BEFORE_REASSIGN = 2` (`supervisor.ts:21`), recién
   entonces pasa la tarea a Claude.
5. Claude recibe `retries = 2`. `effortFor` sube el esfuerzo dos niveles, con tope `xhigh`
   (`reasoning.ts:21`, `reasoning.ts:28-38`). En el caso real, una tarea `medium` corrió en `xhigh`.
6. Lo mismo pasa en la revisión: si el autor es Claude, `chooseReviewer` prefiere Codex o agy (`router.ts:208-211`). Con
   `REVIEW_MAX_ATTEMPTS`, el primer intento de revisión se gasta en dos fallos de Codex (`fleet.ts:542-555`).

Consecuencias: la tarea no se pierde, porque Claude la hace. Pero cada tarea local sin git que cae en Codex gasta dos
lanzamientos inútiles, deja un traspaso con motivo «failure» y hace que Claude trabaje con más esfuerzo y más gasto. El
router no aprende nada, porque un `crash` no llama a `markExhausted`, así que la tarea siguiente vuelve a caer en Codex.
En el panel solo se ve «código 1».

## Por qué pasa
El modo local permitió trabajar fuera de git, pero el adaptador de Codex sigue suponiendo que `ctx.worktreePath`
siempre es un worktree git. La prueba unitaria fija esa suposición: espera exactamente los argumentos, sin la opción
(`tests/core/adapters/codex-cli/adapter.test.ts:53`), y usa un runner falso que nunca ve el rechazo. Además, como el
mensaje no se clasifica, el Supervisor lo trata como un fallo transitorio que se puede reintentar, cuando en realidad se
repetirá igual.

## Solución posible
1. En `src/core/adapters/codex-cli/index.ts:191`, agregar `'--skip-git-repo-check'` a los argumentos de `exec`, por
   ejemplo justo después de `'--json'`. Pasarla siempre no cambia nada en los worktrees, que ya son git. En modo
   local, Berland ya fija la carpeta con `-C` y el sandbox con `-s workspace-write`. Hay que actualizar la expectativa
   de `adapter.test.ts:53`.
2. Como defensa, para no quemar intentos si vuelve a aparecer un rechazo de configuración: reconocer «Not inside a
   trusted directory» o «skip-git-repo-check» en el stderr y emitirlo como `error` con el texto de la línea. Así el
   motivo llega al detalle de la tarea. Para que el Supervisor no reintente con el mismo agente hace falta un código no
   reintentable, y hoy no existe en `errorCodeSchema` (`src/shared/events.ts:15`). Habría que agregarlo al contrato, o
   que el Supervisor reasigne de inmediato ante ese caso.

### Otras opciones
- Pasar la opción solo cuando la carpeta no sea git. Es más acotado, pero el adaptador no sabe si está en modo local
  (`RunContext` no lo dice). Habría que revisar el disco en cada ejecución o llevar el dato al contrato.
- Escribir la confianza en `~/.codex/config.toml` o pasar `-c projects."<ruta>".trust_level="trusted"`. Es frágil,
  porque `-c` separa la clave por puntos y las rutas de Windows llevan `:` y `\`. Además modifica la configuración
  global del usuario.
- Excluir a Codex de los proyectos locales sin git en el router. Es lo más simple, pero se pierde un agente con cupo.
- Inicializar git en la carpeta. Cambia la carpeta del usuario, justo lo que el modo local quiere evitar.

La propuesta 1 es la más barata, pero no es la única. Podría haber una más fina si se decide llevar el modo del
workspace al `RunContext`.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta, en `tests/core/adapters/codex-cli/adapter.test.ts`: con `context()`, que crea una
  carpeta temporal sin git, y un `runner` falso que devuelve `exec-ok.jsonl` y `exit 0`, afirmar que
  `run.mock.calls[0][0].args` contiene `'--skip-git-repo-check'` antes de `'-'`, y ajustar la expectativa exacta de
  la línea 53. Si se hace la parte 2: un runner falso que emite por stderr «Not inside a trusted directory and
  --skip-git-repo-check was not specified.» y sale con código 1. Afirmar que hay un evento `error` cuyo `message`
  contiene esa línea, y no solo un `raw`. Opcional, en `tests/core/orchestrator/`: un Supervisor con un adaptador
  Codex falso que falla sin la opción, para afirmar que la tarea se hace en un solo intento y que `handoffs` queda
  vacío.
- Comando (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/adapters/codex-cli/adapter.test.ts"`.
  Desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/adapters/codex-cli/adapter.test.ts`.
- Verificación manual: en el proyecto `professional` (o en una carpeta nueva sin git), delegar una tarea trivial
  sugerida a Codex. En el panel no debe aparecer «Not inside a trusted directory…» ni «Codex terminó con código 1».
  La sesión de Codex debe terminar con `done {ok:true}` en el primer intento y no debe haber traspaso a Claude.
