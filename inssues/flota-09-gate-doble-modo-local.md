# Modo local: el gate completo corre dos veces por tarea aprobada, antes de revisar y al «integrar», sobre la misma carpeta

- **Área:** Núcleo de la flota
- **Severidad:** baja
- **Archivos:** `src/core/orchestrator/fleet.ts:533`, `src/core/orchestrator/fleet.ts:434`, `src/core/orchestrator/fleet.ts:563-564`, `src/core/orchestrator/fleet.ts:577-588`, `src/core/app/commit-step.ts:224-231`, `src/core/app/workspaces.ts:115-119`, `src/core/app/workspaces.ts:138-140`, `src/core/app/local-workspaces.ts:117-121`, `src/core/app/local-workspaces.ts:124-126`, `src/core/app/local-workspaces.ts:128-139`, `src/core/app/f5-servidor.ts:217-218`, `src/core/adapters/claude-sdk/translate.ts:122`, `tests/integration/local-mode.test.ts:150-166`, `docs/plan/issues/06-razonamiento-modelos.md:201-203`
- **Estado:** resuelta

## Cómo ocurre
Un proyecto entra en modo local cuando se registra sin `workspace`: carpeta sin git, git sin commits o sin gate
(`f5-servidor.ts:217-218`: los worktrees exigen `inspection.isGitRepo && report.hasCommits && inspection.gate`). En
modo local el gate se deduce de la carpeta cada vez que se pide (`local-workspaces.ts:131`, `deduceGate`: el primer
script de `package.json` de la lista, o `python -m pytest -q`). Con una carpeta sin git que tiene `package.json` con
`check`/`test`, el modo es local **y** hay gate.

Pasos de una tarea que el revisor aprueba a la primera:

1. El autor termina. En `#review`, tras el resumen del diff, la flota corre el gate previo (issue 6):
   `fleet.ts:533` `const gate = await this.#runGate(run, signal);` → `#verify` (`fleet.ts:580`) →
   `CommittingWorkspaces.verify` (`commit-step.ts:224-226`, delega) → `ProjectWorktrees.verify`
   (`workspaces.ts:139-140`: `if (local) return this.#local.verify(local, workspace, signal);`) →
   `LocalWorkspaces.verify` (`local-workspaces.ts:124-126`) → `#runGate`, que corre el gate completo en la carpeta
   (`local-workspaces.ts:137`).
2. El gate pasa, su resumen va al encargo del revisor y el revisor aprueba. Se le pide no tocar archivos
   (`fleet.ts:805`) y la flota avisa si informa cambios fuera de `.orq/` (`fleet.ts:563-564`), pero no lo impide.
3. Con el veredicto «aprobado», la flota integra (`fleet.ts:434`) → `CommittingWorkspaces.integrate`, que en modo
   local no prepara nada (`commit-step.ts:230`) → `ProjectWorktrees.integrate` (`workspaces.ts:116-119`) →
   `LocalWorkspaces.integrate`:

   ```ts
   // local-workspaces.ts:117-121
   async integrate(project: LocalProject, workspace: Workspace, signal?: AbortSignal): Promise<IntegrationResult> {
     const check = await this.#runGate(project, workspace, signal);
     if (!check) return { ok: true, conflicts: [], gateSummary: LOCAL_NO_GATE_SUMMARY };
     return { ok: check.ok, conflicts: [], gateSummary: check.summary };
   }
   ```

   Es el mismo `#runGate` del paso 1, con el mismo gate, en la misma carpeta. En modo local no hay merge ni commit
   entre los dos pasos: si nadie tocó la carpeta durante la revisión, la segunda corrida tiene que dar lo mismo que la
   primera.

Resultado: cada tarea local aprobada paga dos corridas completas del gate. Con un gate como `npm run -s check` son
minutos de CPU por tarea (el issue 6 mide ~4 min por corrida en este repo, `06-razonamiento-modelos.md:201-203`), en
un equipo que ya va al límite. Ninguna prueba cuenta las corridas: `tests/integration/local-mode.test.ts:150-166`
llama a `integrate` y `verify` por separado, y `tests/core/orchestrator/fleet-local.test.ts` no mira el gate.

La segunda corrida no es inútil en **todos** los casos. Sirve de respaldo si durante la revisión cambió la carpeta:

- el revisor puede escribir aunque se le pida que no. El aviso de `fleet.ts:563-564` solo ve los `file_change`
  informados, y en Claude solo los emiten `Write`, `Edit`, `MultiEdit` y `NotebookEdit` (`translate.ts:122`). Un
  `sed -i` o un `prettier --write` por Bash no aparece;
- la carpeta es la del usuario, que puede editarla mientras corre la revisión.

En el caso normal (el revisor no escribe y el usuario no toca la carpeta), la repetición sobra.

El pendiente 2 del issue 6 (`06-razonamiento-modelos.md:201-203`) solo trata el gate repetido con worktrees
(`workspace/integrate.ts`), donde el merge sí puede cambiar el árbol. El modo local no figura en ningún pendiente.

## Por qué pasa
`LocalWorkspaces.integrate` (`local-workspaces.ts:117-121`) no guarda ni recibe el resultado de `verify`. Siempre
vuelve a correr `#runGate`. La flota sí tiene ese resultado (`GateCheck` en `fleet.ts:533`), pero el contrato
`WorkspaceManager.integrate(projectId, workspace)` (`src/shared/contracts.ts:37`) no tiene por dónde pasárselo.

## Solución posible
Que `LocalWorkspaces` guarde el último `verify` bueno de cada workspace con una huella de la carpeta, y que
`integrate` lo use si la huella no cambió. Cualquier diferencia de huella hace correr el gate, así que la caché solo
puede ahorrar corridas: nunca se salta una que hace falta.

- `src/core/app/local-workspaces.ts`:
  - `#verified = new Map<string, { summary: string; print: string }>()`, con la clave `liveKey(workspace)`.
  - En `verify`, después de un `#runGate` con `ok: true`, calcular `print = await folderPrint(project.repoPath)` y
    guardarlo. Si falla o no hay gate, borrar la entrada. `verify` siempre corre el gate y nunca lee la caché (la
    prueba de `local-mode.test.ts:163-165` depende de eso).
  - En `integrate`, si hay entrada y `await folderPrint(project.repoPath) === entry.print`, devolver
    `{ ok: true, conflicts: [], gateSummary: `${entry.summary} (ya verificado antes de revisar)` }` y borrar la
    entrada. Si no, correr `#runGate` como ahora.
  - Borrar la entrada en `remove` y en `create` (una tarea nueva en la misma carpeta, `local-workspaces.ts:110-111`).
  - `folderPrint(dir)`: recorrer la carpeta sin seguir enlaces, saltando `.orq/`, `.git/` y `node_modules/`, y hacer
    un hash de la lista ordenada `ruta\0tamaño\0mtimeMs`. Debe incluir los archivos de la configuración del gate
    (`package.json`, `pyproject.toml`, `pytest.ini`, `setup.cfg`), porque `#runGate` vuelve a deducir el gate
    (`local-workspaces.ts:131`). Para cubrir el `npm install` de un revisor, se puede sumar el `mtime` de
    `node_modules/` y de `node_modules/.package-lock.json`. Un `stat` por archivo cuesta mucho menos que un gate.
    Si el recorrido falla o pasa de un tope (p. ej. 50 000 entradas), devolver `undefined` y correr el gate.
- `src/core/app/workspaces.ts:119` no cambia: ya delega en `#local.integrate`.

### Otras opciones
- **Que la flota le pase a `integrate` el `GateCheck` que ya tiene** (parámetro opcional `{ gate?: GateCheck }` en
  `integrate`, que hoy es `integrate(projectId, workspace)` en `contracts.ts:37`). Toca el contrato compartido,
  `CommittingWorkspaces` y `ProjectWorktrees`, y aun así `LocalWorkspaces` necesita la huella para saber que la
  carpeta no cambió. Sola no basta.
- **Saltar el segundo gate si el revisor no informó `file_change` fuera de `.orq/`** (lo que se proponía al
  reportarlo). Es más barato, pero no es seguro: los cambios por Bash no generan `file_change` (`translate.ts:122`) y
  no ve lo que edite el usuario. Solo serviría combinado con la huella.
- **Huella con git** cuando la carpeta lo tiene (modo local por repo sin commits): `git status --porcelain=v1 -z
  --untracked-files=all` más el hash de `git diff`. Es más exacta que `mtime`, pero no sirve en carpetas sin git, que
  son el caso principal del modo local.
- **Unificar con el pendiente 2 del issue 6:** un `GateCache` común por workspace (árbol o `HEAD` fusionado → resumen)
  que usen `LocalWorkspaces` y `workspace/integrate.ts`. Sería la solución más completa: elimina la corrida
  redundante en los dos modos con la misma regla. La propuesta de arriba no es la única.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta, `tests/core/app/local-workspaces-gate.test.ts` (nueva). Usa `LocalWorkspaces`
  directamente, sobre una carpeta temporal sin git. El `gateFor` devuelve un gate `node <ruta>/contar.mjs`, con el
  script **fuera** de la carpeta (por `untrustedRoots`). El script suma una línea a un contador también externo y sale
  con 0 o 1 según `estado.txt`. Escenarios:
  1. `create` → `verify` (ok) → `integrate`: el contador vale **1**, `integrate` da `ok: true` y su `gateSummary`
     empieza por `local: gate ok`. Hoy vale 2.
  2. `create` → `verify` (ok) → se reescribe un archivo que **no** está en las rutas del autor, como haría un revisor
     por Bash → `integrate`: el contador vale **2** (la huella cambió y el gate corre).
  3. `create` → `verify` (ok) → se cambia `package.json` → `integrate`: corre el gate (el contador vale 2).
  4. `create` → `integrate` sin `verify` antes: corre el gate (el contador vale 1). Es el caso de
     `local-mode.test.ts:150-160`.
  5. `verify` → `verify`: el contador vale 2 (`verify` nunca usa la caché), y un `verify` fallido seguido de
     `integrate` corre el gate.
  6. `verify` (ok) → `remove` → `create` → `integrate`: corre el gate (la caché no pasa de una tarea a otra).
- Prueba de flota opcional, en `tests/integration/local-mode.test.ts`: una tarea local completa con supervisor falso
  cuyo revisor aprueba, con `ProjectWorktrees` + `CommittingWorkspaces` reales y el contador del gate. Afirma 1
  corrida y la tarea en `integrated`.
- Comando (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/app/local-workspaces-gate.test.ts tests/integration/local-mode.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`:
  `npx vitest run tests/core/app/local-workspaces-gate.test.ts tests/integration/local-mode.test.ts`).
- Verificación manual en la app: registrar una carpeta sin git con un `package.json` cuyo `check` tarde unos segundos
  y escriba una línea en un archivo de registro fuera de la carpeta. Lanzar una tarea pequeña que el revisor apruebe y
  comprobar que el registro tiene una sola línea por tarea. El detalle de la integración debe decir «ya verificado
  antes de revisar».
