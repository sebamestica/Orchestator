# En modo local las reglas «sin commits, sin stash/checkout/reset» no llegan al prompt del agente: solo quedan en `.orq/BRIEF.md`

- **Área:** Núcleo de la flota
- **Severidad:** alta
- **Archivos:** `src/core/orchestrator/fleet.ts:367`, `src/core/orchestrator/fleet.ts:384`, `src/core/orchestrator/fleet.ts:398-401`, `src/core/orchestrator/fleet.ts:545-556`, `src/core/orchestrator/supervisor.ts:316-319`, `src/core/brief/reasoning.ts:45-50`, `src/core/adapters/claude-sdk/adapter.ts:413`, `src/core/adapters/codex-cli/index.ts:174`, `src/core/adapters/agy-cli/index.ts:205`, `src/core/adapters/agy-cli/index.ts:210-213`, `src/core/brief/render-brief.ts:23-31`, `src/core/brief/render-brief.ts:48`, `src/core/brief/render-brief.ts:50`, `src/core/brief/render-brief.ts:70`, `src/core/brief/render-brief.ts:74-77`, `src/core/adapters/claude-sdk/shell-policy.ts:490-497`, `src/core/adapters/claude-sdk/shell-policy.ts:539-545`, `tests/core/orchestrator/fleet-local.test.ts:88-94`, `docs/plan/issues/01-trabajo-local.md:72-76`, `docs/plan/issues/06-razonamiento-modelos.md:213-214`
- **Estado:** abierta

## Cómo ocurre
El issue 1 agregó el **modo local**: un proyecto registrado sin `workspace` (sin git, sin commits o sin gate, p. ej.
`marketing`, que tiene git pero no gate) hace que la flota trabaje directamente en la carpeta del usuario, sin
worktree ni red de seguridad. Para eso existe la sección «Modo local» del encargo (`src/core/brief/render-brief.ts:23-31`):

```ts
'## Modo local (sin worktree)',
`Trabajas directamente en la carpeta del usuario (\`${path}\`), no en una copia: ...`,
'- No hagas commits ni ramas, y no uses `git init`, `git stash`, `git reset`, `git checkout`, `git switch`, `git restore` ni `git clean`: ...',
```

El propio issue 1 la presenta como la mitigación de este riesgo (`docs/plan/issues/01-trabajo-local.md:72-76`: «Mitigación:
reglas del brief…», «`git stash`, `reset` o `checkout` de un agente sobre la copia del usuario»).

Pasos (proyecto local con cambios sin confirmar del usuario):

1. La flota calcula `local` (`fleet.ts:367`) y lo usa **solo** para escribir el archivo `.orq/BRIEF.md` antes de cada
   intento (`fleet.ts:384`):
   ```ts
   await this.#writeFile(join(workspace.path, BRIEF_FILE), renderBrief(info.task, info.handoff, { memoryContext, rulesFiles: this.#rulesFiles, ...(local ? { local } : {}) }));
   ```
2. Las dos llamadas a `supervisor.execute` (autor en `fleet.ts:398-401`, revisión en `fleet.ts:545-556`) no pasan nada de
   modo local. El Supervisor arma el contexto con `worktreePath`, `env`, `signal`, `timeoutMs`, `handoff`, `retries` y
   `budgetUsd` (`supervisor.ts:316-319`); `RunHints` solo tiene `retries` y `budgetUsd` (`reasoning.ts:45-50`).
3. Cada adaptador arma **su propio** prompt con `renderBrief` sin `local`:
   - Claude: `q = queryFn({ prompt: renderBrief(task, ctx.handoff, { rulesInSystemPrompt: repoRules !== undefined }), options });` (`claude-sdk/adapter.ts:413`).
   - Codex: `const brief = renderBrief(task, ctx.handoff, { rulesInSystemPrompt: true });` (`codex-cli/index.ts:174`), que va por stdin.
   - agy: escribe otro archivo, `.orq/BRIEF-<id>.md`, con `renderBrief(task, ctx.handoff)` (`agy-cli/index.ts:205`) y le
     dice `Lee el archivo ${briefRelPath} y cúmplelo.` con `--dangerously-skip-permissions` (`agy-cli/index.ts:210-213`).
     Es decir, agy ni siquiera tiene motivo para abrir el `.orq/BRIEF.md` con la sección.
4. Como `opts.local` no viene, la línea `if (opts.local) lines.push(...localModeSection(...))` (`render-brief.ts:70`) no
   se ejecuta. En su lugar el agente lee lo contrario de lo que conviene en la carpeta del usuario:
   - «`.orq/` no entra en el commit» (`render-brief.ts:50`), que da a entender que hay un commit.
   - Si viene de un traspaso (Codex o agy sin cupo → Claude): «Trabajas en el mismo worktree.» y «revisa `git status`,
     `git diff` y `git log` de esta rama» (`render-brief.ts:74-77`).
   - A `.orq/BRIEF.md` solo se le pide volver «si pierdes el hilo, se corta la sesión o vienes de un traspaso»
     (`render-brief.ts:48`), así que el primer intento normal nunca lo lee.
5. La política de shell de Claude no lo compensa: `stash`, `checkout`, `restore`, `switch` y `commit` están en
   `GIT_ALLOWED` (`shell-policy.ts:490-497`) y solo se cortan `reset --hard` y `clean -f` (`shell-policy.ts:539-545`).
6. Un agente que cree estar en un worktree desechable hace, por ejemplo, `git stash` para ver si una prueba ya fallaba
   antes de su cambio, `git checkout -- archivo` para deshacer algo, o `git commit`. Eso actúa sobre el trabajo sin
   confirmar o la rama real del usuario, que en modo local no tiene copia de respaldo. (El sandbox `workspace-write` de
   Codex podría impedir parte de las escrituras en `.git/`, pero no se verificó; Claude y agy no tienen esa barrera.)

La prueba que se agregó con el issue 1 solo mira el archivo escrito, no el prompt
(`tests/core/orchestrator/fleet-local.test.ts:92-93`):

```ts
const brief = s.writes.find((w) => w.path.endsWith('BRIEF.md'))?.content ?? '';
expect(brief).toContain('## Modo local (sin worktree)');
```

El issue 6 ya lo deja anotado como pendiente sin resolver (`docs/plan/issues/06-razonamiento-modelos.md:213-214`: «El
prompt del adaptador no lleva el contexto de memoria ni la sección de modo local: `renderBrief(task, handoff)` sin
opciones; solo los tiene `.orq/BRIEF.md`»). Ningún commit de hoy lo cambió: las tres llamadas siguen sin `local`.

## Por qué pasa
El dato «esta tarea es local» vive solo en `Fleet#cycle` y termina en un archivo. El contrato de ejecución
(`ExecuteOptions` → `AttemptOptions` → `HintedRunContext`) no lo transporta, y los adaptadores no usan el
`.orq/BRIEF.md` de la flota como prompt: vuelven a llamar a `renderBrief` con sus propias opciones, que no incluyen
`local`. Hay dos encargos distintos para la misma tarea y el que recibe el modelo es el incompleto.

## Solución posible
Llevar el modo local hasta el adaptador por el mismo camino que ya usan `retries` y `budgetUsd`:

1. `src/core/brief/reasoning.ts`: agregar `local?: { path: string }` a `RunHints` y validarlo en `runHints(ctx)` (string
   no vacío).
2. `src/core/orchestrator/supervisor.ts`: agregar `local?: { path: string }` a `ExecuteOptions` y `AttemptOptions`,
   pasarlo de uno a otro y copiarlo al contexto junto a `retries`/`budgetUsd` (`supervisor.ts:316-319`):
   `if (opts.local) ctx.local = opts.local;`.
3. `src/core/orchestrator/fleet.ts`: pasar `...(local ? { local } : {})` en las dos llamadas a `supervisor.execute`
   (`fleet.ts:398-401` y `fleet.ts:545-556`).
4. Los tres adaptadores: `renderBrief(task, ctx.handoff, { ..., ...(hints.local ? { local: hints.local } : {}) })` en
   `claude-sdk/adapter.ts:413`, `codex-cli/index.ts:174` y `agy-cli/index.ts:205`.

De paso conviene incluir `memoryContext` por la misma vía, porque el pendiente 7 del issue 6 tiene la misma causa.

### Otras opciones
- **(a)** Que la flota anteponga la sección local al `objective` de la tarea que pasa a `execute` (`current` y la tarea
  de revisión). No cambia contratos, pero la sección quedaría después del plan y del bloque de traspaso, que seguiría
  diciendo «mismo worktree» y «`git log` de esta rama».
- **(b)** Que los adaptadores usen como prompt el `.orq/BRIEF.md` que ya escribió la flota (o un prompt corto «lee
  `.orq/BRIEF.md` y cúmplelo», como hace agy con su propio archivo). Deja un solo encargo por tarea y arregla también
  el contexto de memoria, pero depende de que el agente lea el archivo y obliga a cuidar `rulesInSystemPrompt`.
- **(c)** Como defensa adicional, que la política de shell de Claude niegue `git stash|checkout|restore|switch|commit|reset`
  cuando el cwd es una carpeta local (con `local` en `ToolPolicyOptions`). Es la única opción que no depende de que el
  modelo obedezca, aunque no cubre a agy (`--dangerously-skip-permissions`) ni a Codex.

La propuesta no es la única. Podría salir más simple con (b), si se decide que el archivo de la flota sea el encargo
único, y lo más seguro es combinar cualquiera de las tres con (c).

## Cómo probar que quedó resuelta
- **Prueba automatizada propuesta:**
  - `tests/core/orchestrator/fleet-local.test.ts`: una `Fleet` con `isLocal: () => true` y un adaptador falso que guarde
    el `ctx` que recibe y llame al `renderBrief` real con `runHints(ctx).local`. Afirmar que el texto contiene
    «## Modo local (sin worktree)» y «No hagas commits ni ramas». Con un traspaso forzado (primer adaptador que emite
    `quota_exhausted`), afirmar que el prompt del segundo dice «Trabajas en la misma carpeta.» y no contiene
    «Trabajas en el mismo worktree» ni «`git log` de esta rama». Repetir para la tarea de revisión.
  - `tests/core/adapters/claude-sdk/adapter.test.ts`: inyectar `query` falso, correr con `ctx.local = { path: 'C:\\x' }` y
    afirmar que `prompt` contiene la sección; sin `ctx.local`, que no la contiene.
  - `tests/core/adapters/codex-cli/adapter.test.ts`: con un `runner` falso, afirmar que el `stdin` lleva la sección.
  - `tests/core/adapters/agy-cli/adapter.test.ts`: afirmar que el `BRIEF-<id>.md` escrito lleva la sección.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/orchestrator/fleet-local.test.ts tests/core/adapters"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/orchestrator/fleet-local.test.ts tests/core/adapters`).
- **Verificación manual:** en un proyecto local con git y cambios sin confirmar, lanzar una tarea con Claude y mirar
  en el registro de la sesión el primer mensaje del usuario: debe traer la sección «Modo local». Con agy, abrir
  `.orq/BRIEF-<id>.md` mientras corre y comprobar lo mismo. Al terminar, `git stash list`, `git log -1` y `git status`
  deben quedar como antes, salvo los archivos de las rutas propias.
