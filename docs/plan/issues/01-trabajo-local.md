# Issue 1 — Trabajar en local, sobre la carpeta tal como está

Estado: plan · Commit: uno solo, a nombre del usuario y sin trailers · Depende de: nada

## Problema
Berland solo prepara un proyecto para la flota cuando la carpeta tiene **git y gate** (una verificación del tipo
`npm run check` o pytest). Si falta cualquiera de los dos, el proyecto se registra sin `workspace`, y entonces:

1. `POST /projects/from-folder` deja `workspace` vacío (`src/core/app/f5-servidor.ts:217`).
2. `ProjectWorktrees.#entry` lanza «proyecto sin configuración de worktrees», y `create()` lanza `gateMissing`
   (`src/core/app/workspaces.ts`).
3. La tarea pasa a `failed` a los milisegundos de delegarla, sin agente y sin motivo visible.

Caso real: `marketing` (`C:\dev\marketing`) es git pero no tiene `package.json`, así que no tiene gate. Sus 4 tareas
fallaron así el 2026-11-04.

## Qué se quiere
Si no hay worktrees posibles, el agente trabaja **directamente en la carpeta**: sin `git init`, sin ramas, sin merge
y sin commits del núcleo. Los cambios quedan guardados en el disco tal cual.

## Diseño
- **Modo local = proyecto sin `workspace`.** No cambia el contrato del proyecto. Los proyectos con git y gate siguen
  con worktrees, igual que hoy.
- **`src/core/workspace/local.ts` (nuevo), `LocalWorkspaces`:**
  - `create(projectId, task)` devuelve `{ taskId, path: repoPath, branch: '(local)' }`. Si la carpeta es git, agrega
    `.orq/` a `.git/info/exclude`, nunca al `.gitignore` del usuario.
  - `integrate()` corre el gate si `deduceGate(repoPath)` encuentra uno. Si falla, devuelve `ok: false` con el
    resumen y la tarea vuelve al autor. Si no hay gate, devuelve `ok: true` con
    `gateSummary: 'local: sin verificación'`. Nunca hace commit.
  - `remove()` borra solo `.orq/`, y solo si lo creó el núcleo para esa tarea. No toca nada más.
- **`ProjectWorktrees` (`src/core/app/workspaces.ts`):** si el proyecto existe y no tiene `workspace`, delega en
  `LocalWorkspaces` en vez de lanzar. Expone `isLocal(workspace)` y `exclusiveKey(projectId)`, que devuelve el
  `repoPath` de un proyecto local o `undefined`.
- **Una tarea a la vez por carpeta local.** Dos agentes se pisarían `.orq/BRIEF.md`, `.orq/PLAN.md` y los archivos.
  `TaskQueue.next(canStart?)` (`src/core/orchestrator/queue.ts`) salta las tareas listas que no se pueden empezar.
  `Fleet` pasa un predicado con las `exclusiveKey` activas (`src/core/orchestrator/fleet.ts`). Proyectos distintos
  siguen en paralelo.
- **`CommittingWorkspaces` (`src/core/app/commit-step.ts`):** en un workspace local no corre `git status`, `add`,
  `commit` ni `ls-files`.
  - `reviewSummary` usa los archivos de los eventos `file_change`, más `git status --porcelain` en modo solo lectura
    si la carpeta es git.
  - Los archivos fuera de `ownedPaths` se le avisan al revisor, que rechaza la tarea. Sin git no se pueden bloquear.
- **Brief (`src/core/brief/render-brief.ts`):** sección «Modo local» que dice que se trabaja directo en la carpeta
  del usuario, sin commits, ramas, `git init`, `stash` ni `reset`, y que solo se tocan las rutas propias.
- **Avisos (`src/core/fs/folders.ts:369-373`):** «Sin git» y «sin gate» dejan de decir «la flota no podrá ejecutar
  tareas». Ahora dicen «se trabajará en local, directamente en la carpeta».

### Requisito transversal: autoría (va en este mismo commit)
- `FLEET_IDENTITY` (`commit-step.ts:12`, hoy «Orquestador (flota)») pasa a la identidad git del usuario, leída con
  `git config --get user.name` y `user.email` del repo.
- Si no hay identidad, error claro. Nunca se inventa una.
- Los mensajes de commit del núcleo no llevan `Co-Authored-By` ni «Generated with».

## Rutas propias
`src/core/workspace/local.ts`, `src/core/workspace/index.ts`, `src/core/app/workspaces.ts`,
`src/core/app/commit-step.ts`, `src/core/orchestrator/queue.ts`, `src/core/orchestrator/fleet.ts`,
`src/core/brief/render-brief.ts`, `src/core/fs/folders.ts`, `tests/core/workspace/local*.test.ts`,
`tests/core/app/workspaces*.test.ts`, `tests/core/app/commit-step*.test.ts`, `tests/core/orchestrator/queue*.test.ts`,
`tests/core/orchestrator/fleet-local*.test.ts`, `tests/core/fs/**`.

## Criterios de aceptación (Vitest)
1. Carpeta sin git: la tarea corre en `repoPath`, pasa la revisión y queda `integrated` con el detalle «local», sin
   `.git` creado.
2. Carpeta git sin gate (caso `marketing`): `git branch`, `git log` y `git stash list` quedan idénticos antes y
   después, y los cambios quedan sin confirmar.
3. Carpeta local con gate: el gate se corre; si falla, la tarea vuelve al autor con la salida.
4. Dos tareas del mismo proyecto local nunca están activas a la vez. Dos de proyectos distintos, sí.
5. `.orq/` se borra si la tarea termina bien y se conserva si falla. El `.gitignore` del usuario no cambia.
6. Proyectos con git y gate: todas las pruebas existentes de worktrees siguen en verde.
7. Los commits de la flota llevan como autor y committer la identidad del usuario y no traen `Co-Authored-By`. Sin
   identidad, error y ningún commit.
8. `npm run -s check` en verde, con cifras reales.

## Riesgos
- Que un agente borre o pise archivos del usuario. Sin worktree no hay red de seguridad. Mitigación: reglas del brief,
  aviso de `ownedPaths` al revisor, una tarea por carpeta y revisión obligatoria.
- `git stash`, `reset` o `checkout` de un agente sobre la copia del usuario. Mitigación: la guardia ya protege los
  `repoPath`; hay que verificar que también cubra a los proyectos locales, y si no, proponerlo.

## Qué pasa con `nucleo-almacenamiento-local`
Esa tarea (commit `784def2`, rama `orq/nucleo-almacenamiento-local`) hace `git init` a pedido, que ya no se quiere.
Su parte de `git init` no se integra. Solo se reusa `readProjectStorage`/`sanitizeRemoteUrl` en el issue 2.
