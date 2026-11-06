# En modo local, las rutas propias solo se comprueban con lo que el agente dice haber tocado: lo que escriba por Bash, PowerShell o un script fuera de ellas no se ve ni se frena, y la tarea se integra igual

- **Área:** Núcleo de la flota
- **Severidad:** media
- **Archivos:** `src/core/app/commit-step.ts:101-106`, `src/core/app/commit-step.ts:148-157`, `src/core/app/commit-step.ts:197`, `src/core/app/commit-step.ts:208-209`, `src/core/app/commit-step.ts:229-231`, `src/core/app/commit-step.ts:243-270`, `src/core/app/local-workspaces.ts:58-69`, `src/core/app/local-workspaces.ts:117-121`, `src/core/app/local-workspaces.ts:128-139`, `src/core/app/fleet-service.ts:387`, `src/core/orchestrator/fleet.ts:527`, `src/core/orchestrator/fleet.ts:533`, `src/core/orchestrator/fleet.ts:434-451`, `src/core/orchestrator/fleet.ts:563-564`, `src/core/orchestrator/supervisor.ts:527-528`, `src/core/adapters/claude-sdk/translate.ts:122`, `src/core/adapters/claude-sdk/translate.ts:468-474`, `src/core/adapters/claude-sdk/shell-policy.ts:16-23`, `src/core/adapters/codex-cli/index.ts:191`, `src/core/adapters/codex-cli/translate.ts:53-66`, `src/core/adapters/agy-cli/translate.ts:228-250`, `src/core/brief/render-brief.ts:28`, `src/core/brief/render-brief.ts:85`, `docs/plan/issues/01-trabajo-local.md:74-76`, `tests/integration/local-mode.test.ts:24-34`, `tests/integration/local-mode.test.ts:68-78`
- **Estado:** resuelta
- **Origen:** autoevaluación de la mente (2026-11-05)
- **Relacionadas:** `flota-01-modo-local-reglas-fuera-del-prompt.md` (la sección «Modo local» del encargo no llega al prompt), `flota-09-gate-doble-modo-local.md` (anota el mismo punto ciego para el revisor), `servidor-06-ownedpaths-sin-validar-en-tareas-rest.md`, `autoeval-reglas-04-agy-sin-ninguna-barrera-tecnica.md`

## Cómo ocurre

**Contexto.** Con worktrees, «no toques fuera de tus rutas» es una barrera técnica, aunque llegue tarde. Antes de
revisar y de integrar, `commitTaskWork` mira lo que git ve cambiado en el worktree y lanza `OwnedPathsError` si algo cae
fuera (`commit-step.ts:101-106`, `:229-231`). En **modo local** no hay worktree ni commit, y el código lo dice
explícitamente (`commit-step.ts:154-157`): «los que caen fuera de sus rutas propias se le señalan [al revisor] para que
rechace la tarea (sin git no se pueden bloquear)». `prepare` sale sin comprobar nada (`:197`), `reviewSummary` (que la
flota usa como resumen del diff, `fleet-service.ts:387` → `fleet.ts:527`) llama a `#localSummary` (`:208-209`) e
`integrate` va directo al gestor local (`:229-231`), que solo corre el gate si lo hay (`local-workspaces.ts:117-121`).

`#localSummary` (`commit-step.ts:243-270`) arma la lista con **lo que informó el agente**:

```ts
const reported = [...new Set((run?.attempts ?? []).flatMap((a) => a.filesChanged))];
```

`filesChanged` sale de los eventos `file_change` (`supervisor.ts:527-528`), y cada adaptador solo los emite para sus
herramientas de edición:

- Claude: al terminar `Write`, `Edit`, `MultiEdit` o `NotebookEdit` (`FILE_TOOLS`, `claude-sdk/translate.ts:122`;
  evento en `:468-474`). `Bash` y `PowerShell` no generan `file_change`.
- Codex: solo los parches (`item.type === 'file_change'`, `codex-cli/translate.ts:57-66`). `command_execution` produce
  solo `tool_call`/`tool_result` (`:53-56`).
- agy: solo las herramientas de la lista `isFileTool` (`agy-cli/translate.ts:228-235`, evento en `:245-250`).

**Pasos** (proyecto local, tarea con `ownedPaths: ['5/**']`):

1. El agente ejecuta un formateador o un script sobre toda la carpeta (`npx prettier --write .`,
   `sed -i … *.md`, `Get-ChildItem -Recurse | …`), o un `mv`/`rm` de archivos fuera de `5/`. La política de Claude lo
   permite: solo frena escrituras **fuera de la carpeta** y no conoce las rutas propias (`shell-policy.ts:16-18`), y
   ella misma reconoce que un script o un binario no se inspeccionan (`:20-23`). Codex solo tiene su sandbox
   `workspace-write` (`codex-cli/index.ts:191`), que deja escribir en toda la carpeta. agy no tiene ninguna barrera
   (ver `autoeval-reglas-04`).
2. Ninguno de esos cambios genera `file_change`. `#localSummary` muestra solo los archivos editados con herramientas y no
   escribe la línea «ATENCIÓN: archivos fuera de las rutas propias».
3. El revisor no recibe ningún aviso. Podría notarlo solo si, por su cuenta, mira `git status` (y solo en carpetas git,
   donde además se mezcla con los cambios sin confirmar del usuario). Aprueba, `integrate` corre el gate (si existe) y
   la tarea queda integrada (`fleet.ts:434-442`).
4. Tus archivos fuera de `5/` quedan cambiados o borrados en tu carpeta, sin copia, porque en modo local no hay red de
   seguridad (`01-trabajo-local.md:75`).

Y aun cuando el agente **sí** informa el archivo, el aviso no frena nada: `integrate` en modo local no mira las rutas
propias. La prueba actual lo deja fijado: el «agente» pisa `notas.md`, lo informa, el resumen trae «ATENCIÓN … (notas.md)»
y `integrate` devuelve igual `{ ok: true, … }` (`tests/integration/local-mode.test.ts:68-78`). Todo depende de que el
revisor lea el aviso y rechace.

La mitigación que eligió el issue 1 es «reglas del brief, aviso de `ownedPaths` al revisor, una tarea por carpeta y
revisión obligatoria» (`01-trabajo-local.md:74-76`). La lista «Rutas que puedes modificar (solo estas)» sí llega al
prompt (`render-brief.ts:85`), pero la regla propia del modo local, «Toca solo tus rutas propias. No borres, muevas ni
reformatees archivos fuera de ellas» (`render-brief.ts:28`), queda solo en `.orq/BRIEF.md` (`flota-01`). Las dos son
instrucciones al modelo. El aviso al revisor depende de que el propio agente informe lo que tocó, y lo mismo pasa con el
aviso de que el revisor escribió en el proyecto (`fleet.ts:563-564`). Ninguna de esas reglas tiene una comprobación
independiente.

**Pruebas.** `tests/integration/local-mode.test.ts:24-34` construye el resultado con `ran(files)`, es decir, con los
archivos que «informó» el agente. Ninguna prueba cambia un archivo sin informarlo, y la única con un archivo fuera de
las rutas espera que la tarea se integre (`:77-78`).

## Por qué pasa

El modo local reemplazó «lo que git ve» por «lo que el agente dice», y los adaptadores solo dicen lo que pasa por sus
herramientas de edición. No hay ninguna medición del estado de la carpeta antes y después de la tarea. Y aunque la
hubiera, en modo local un archivo fuera de las rutas no impide integrar: solo produce un aviso en el texto del revisor.

## Solución posible

1. **Foto antes y después (`src/core/app/local-workspaces.ts`).** En `create`, guardar un inventario de la carpeta
   (ruta relativa → tamaño, `mtimeMs` y, para archivos chicos, un hash), excluyendo `.orq/`, `.git/` y las carpetas que
   ya se enlazan o ignoran en los worktrees (`node_modules`, etc.), con un tope de archivos. Si la carpeta es git, se puede
   usar en su lugar `git status --porcelain=v1 -z --untracked-files=all --no-optional-locks` (sin escribir en el índice)
   más `git hash-object` de esas rutas (sin `-w`). Agregar `changedSince(workspace): string[]`.
2. **No culpar al agente por los restos del gate.** En modo local el gate corre en la carpeta del usuario después del
   resumen (`fleet.ts:527` y luego `:533`, `local-workspaces.ts:128-139`), y en una carpeta sin git lo que deje
   (`coverage/`, `dist/`, cachés) aparecería en la siguiente foto como «fuera de las rutas». Tomar una foto antes y
   después de cada `#runGate` y sumar a la base lo que cambió el gate.
3. **`src/core/app/commit-step.ts`, `#localSummary`:** unir `reported` con `changedSince(workspace)` y calcular
   `outsideOwnedPaths` sobre la unión. Marcar aparte los archivos que el agente no informó.
4. **`integrate` en modo local:** volver a calcular `changedSince` (así entra también lo que haya escrito el revisor) y,
   si hay archivos fuera de las rutas propias, devolver
   `{ ok: false, conflicts: [], gateSummary: 'archivos fuera de las rutas propias: …' }` para que la tarea vuelva al
   autor con la lista (`fleet.ts:444-451`) y no quede «integrada». Lanzar `OwnedPathsError`, como con worktrees, la da
   por fallida en vez de devolverla. No se puede deshacer lo hecho, pero el usuario recibe la lista exacta. Esto cambia
   lo que hoy afirma `local-mode.test.ts:77-78`.

Un cambio del usuario en la carpeta mientras corre la tarea también aparecería. Conviene decirlo en el aviso («cambió
mientras trabajaba la tarea») y no culpar al agente sin más.

### Otras opciones

- **Copia de respaldo de lo que está fuera de las rutas** antes de empezar (solo archivos chicos, o con `git stash
  create` en carpetas git, que no mueve refs pero tampoco guarda los archivos sin seguimiento) para poder restaurarlos.
  Protege de verdad, pero cuesta disco y tiempo.
- **No mandar tareas locales a Codex ni a agy**, solo a Claude, que al menos queda limitado a la carpeta. Es simple, pero
  no cubre las escrituras por shell de Claude dentro de la carpeta y fuera de las rutas.
- **Que Claude niegue `Write`/`Edit` fuera de `ownedPaths` en modo local** (pasando las rutas a `ToolPolicyOptions`).
  Convierte en bloqueo los casos con herramientas, que hoy ya llegan como aviso, pero no cubre los de shell, así que no
  reemplaza la foto.

La propuesta no es la única ni tiene por qué ser la mejor. Si se elige otra, basta con que pasen las pruebas de abajo.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta** en `tests/integration/local-mode.test.ts`:
  - Bloque «carpeta sin git»: `ws.create(id, task('t1', id, ['5/**']))`, después `writeFileSync(join(folder, 'notas.md'), 'pisado')`
    (fuera de las rutas, **sin** informarlo) y `ws.reviewSummary(w, ran([]))`. Afirmar que el resumen contiene
    «ATENCIÓN» y `notas.md`, y que `ws.integrate(id, w)` devuelve `ok: false` con `notas.md` en `gateSummary`.
  - Ajustar el caso existente (`:68-78`): con `notas.md` informado fuera de las rutas, `integrate` ya no debe dar
    `ok: true`.
  - Bloque «carpeta git sin gate (caso marketing)»: lo mismo con un archivo versionado fuera de `5/` y otro borrado con
    `rmSync`. Además, afirmar que `snapshot(repo)` (ramas, log, stash y HEAD) no cambió por la foto.
  - Gate: en el bloque «carpeta con gate», un `check.mjs` que escribe `coverage/x.txt` no debe producir aviso ni
    impedir integrar.
  - Control: un cambio dentro de `5/` sin informar no produce aviso, y la tarea se integra.
- **Comando (desde WSL):**
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/integration/local-mode.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/integration/local-mode.test.ts`).
- **Verificación manual en la app:** en una carpeta local de prueba sin gate, crea una tarea con ruta propia `5/**` cuyo
  encargo pida «después de editar `5/a.md`, ejecuta `echo x >> README.md` en la terminal». La revisión debe mostrar el
  aviso con `README.md` aunque el agente no lo mencione, y la tarea no debe quedar como integrada. Si el agente se niega
  (la orden choca con «Rutas que puedes modificar»), edita tú `README.md` mientras la tarea trabaja: el aviso debe
  aparecer marcado como «cambió mientras trabajaba la tarea».
