# Vetworld en el orquestador

Receta para que las tareas de Vetworld (`C:\dev\Vetworld`) pasen por el núcleo del orquestador y no por el despacho a mano: worktree por tarea, enlaces a la copia principal, gate antes de integrar, informe y traspaso a Claude cuando Codex o agy agotan su cupo.

Estado (2026-11-03): la receta está probada solo con un fixture con la forma de Vetworld (`tests/integration/project-workspaces.test.ts`). Vetworld **todavía no está registrado** en el núcleo.

> **El token de la API equivale a ejecutar código como el usuario.** Con `POST /projects`, quien tenga el token declara los comandos de `postCreate` y del gate (`node -e …`, `cmd.exe /c …`, PowerShell…), y el núcleo los ejecuta con la cuenta de Windows del usuario. Zod valida la forma, no la intención. El servidor escucha solo en `127.0.0.1`, exige el token y revisa Host y Origin; aun así, trata el token como una contraseña del equipo: no lo pegues en encargos, notas ni registros.

## 1. Registro (`POST /projects`)

Cuerpo exacto. Es el archivo [`vetworld.json`](vetworld.json), listo para `-InFile`:

```json
{
  "id": "vetworld",
  "name": "Vetworld",
  "repoPath": "C:\\dev\\Vetworld",
  "workspace": {
    "worktreesRoot": "C:\\dev\\.worktrees\\vetworld-orq",
    "baseBranch": "main",
    "integrationBranch": "orq/integracion",
    "links": [".tools", "workbench", "assets-source", "node_modules"],
    "postCreate": [
      {
        "command": "node",
        "args": [
          "-e",
          "const fs=require('node:fs'),path=require('node:path');const dst=path.join('.claude','skills');fs.mkdirSync(dst,{recursive:true});let n=0;for(const base of [path.join('.agents','skills'),path.join('.agents','skills','vendor')]){if(!fs.existsSync(base))continue;for(const d of fs.readdirSync(base,{withFileTypes:true})){const src=path.join(base,d.name);if(d.isDirectory()&&fs.existsSync(path.join(src,'SKILL.md'))){fs.cpSync(src,path.join(dst,d.name),{recursive:true});n++}}}console.log(n+' skills copiadas a .claude/skills')"
        ],
        "timeoutMs": 120000
      }
    ],
    "gate": [
      {
        "command": "npm",
        "args": ["run", "-s", "gate"],
        "timeoutMs": 1800000
      }
    ]
  }
}
```

| Campo | Para qué |
|---|---|
| `workspace.worktreesRoot` | Carpeta de los worktrees del núcleo. Es **distinta** de `C:\dev\.worktrees\vetworld\`, donde están los worktrees que A0 crea a mano (ramas `orq/<nombre>`). Así el núcleo nunca los ve: ni la guardia de git (`worktree remove` solo actúa dentro de esta raíz), ni la limpieza de restos, ni el borrado de enlaces. Tiene que ser absoluta y propia (ver las reglas más abajo). |
| `baseBranch` / `integrationBranch` | Las tareas salen de `orq/integracion`, que se crea desde `main` la primera vez. El núcleo integra solo ahí. Pasar `orq/integracion` a `main` lo decide A0 o el usuario, y se hace a mano. |
| `links` | Carpetas de la copia principal que se enlazan en cada worktree con una junction. Las cuatro son carpetas reales de `C:\dev\Vetworld` (comprobado el 2026-11-03) y están en su `.gitignore`, así que no aparecen como trabajo del agente. **Son compartidas**: lo que un agente escriba en `workbench/` o `assets-source/` queda escrito en la copia principal. Un archivo en `links` se **copia**, no se comparte. |
| `postCreate` | Copia las skills de `.agents/skills/*` y `.agents/skills/vendor/*` (las carpetas con `SKILL.md`) a `.claude/skills/`, como hace `scripts/qa/sync-claude-skills.sh`. Sin esto, los workers Claude no descubren las skills, porque `.claude/skills/` no se versiona. |
| `gate` | `npm run -s gate` en el worktree de integración, con el Node del núcleo y el `node_modules` de Windows (por la junction). Tope: 30 min. |

### Qué programa se lanza

El núcleo lanza `postCreate` y el gate **sin shell**, y nunca toma un ejecutable del worktree. En Windows, tanto `spawn` como `cmd.exe` buscan primero en la carpeta actual: un `npm.cmd` o un `node.exe` versionados en la rama ganarían al real. Se comprobó con señuelos el 2026-11-03. Por eso:

- **`node` es el Node del núcleo**, y **`npm`/`npx` son ese mismo Node con su `npm-cli.js`/`npx-cli.js`**. No se pasa por `npm.cmd`, y da igual escribir `npm` o `npm.cmd`.
- **Cualquier otro nombre se busca en el PATH del núcleo**: solo en entradas absolutas, nunca en el cwd ni en la raíz de worktrees. También se acepta una ruta absoluta fuera de los worktrees. Las rutas relativas, como `scripts\gate.cmd`, se rechazan.
- **Los `.cmd`/`.bat` van por `%SystemRoot%\System32\cmd.exe`**, y solo si ni la ruta ni los argumentos llevan espacios o metacaracteres de cmd.
- **En el proceso hijo se fija `NoDefaultCurrentDirectoryInExePath=1`**, para que cmd.exe y los scripts de npm (`tsx …`) tampoco busquen en el cwd.
- **`env` de un comando no puede tocar** `PATH`, `PATHEXT`, `ComSpec`, `SystemRoot`, `NODE_OPTIONS`, `NODE_PATH` ni `npm_config_*`. Esas variables solo salen del entorno del núcleo. La lista no es exhaustiva: ver «Limitaciones conocidas».
- **git del núcleo**: se resuelve a una ruta absoluta del PATH, descartando un candidato cuya ruta real caiga en un worktree. Sin un git confiable, falla cerrado y nunca lanza `git` a secas.
- **El contenido del gate es de la rama ya fusionada**: el script `gate` de `package.json` y `scripts/qa/gate.ts`. Lo protegen `ownedPaths` (la flota no confirma archivos fuera de ellos) y la revisión cruzada, no el lanzador.

**`node -e …` en lugar de `bash scripts/qa/sync-claude-skills.sh`.** En este PC, `bash` es `C:\Windows\System32\bash.exe`, el lanzador de WSL: funcionaría, pero haría depender cada worktree de WSL. Esa variante no está probada (no ejecutado). La copia con Node sí está probada en el fixture. Si cambia `sync-claude-skills.sh`, hay que cambiar también esta línea. Una alternativa más limpia sería que Vetworld tuviera un `scripts/qa/sync-claude-skills.mjs`, y entonces `postCreate` quedaría en `{"command":"node","args":["scripts/qa/sync-claude-skills.mjs"]}`.

### Enviarlo

Primero arranca el núcleo en PowerShell, desde `C:\dev\orquestador`:

```powershell
node src/core/app/cli.ts iniciar
```

Toma el `token` de la primera línea JSON que imprime y guárdalo en `$token`. Después, en otra consola:

```powershell
$h = @{ Authorization = "Bearer $token" }
$api = 'http://127.0.0.1:47811'
Invoke-RestMethod -Method Post -Uri "$api/projects" -Headers $h -ContentType 'application/json' -InFile docs\proyectos\vetworld.json
Invoke-RestMethod -Uri "$api/projects/vetworld" -Headers $h | ConvertTo-Json -Depth 8
```

El servidor valida el cuerpo con Zod y responde `400` con el motivo si:

- falta el gate o está vacío;
- un comando es una ruta relativa, o su `env` toca una variable de carga;
- algún enlace es absoluto o lleva `..`;
- `worktreesRoot` no es absoluta, es la raíz de un volumen (`C:\`), cae en una carpeta del sistema (`%SystemRoot%`, `Program Files`, `ProgramData`) o es `C:\Users` o el perfil;
- `worktreesRoot` cae dentro de `C:\dev\Vetworld` o la contiene. Se mira la ruta escrita y la **real**, así que pasar por una junction no cuela;
- las rutas se solapan con las de otro proyecto que también tenga `workspace` (misma copia, o raíces que cuelgan una de otra);
- `integrationBranch` es igual a `baseBranch`;
- algún campo es desconocido (por ejemplo `worktreeRoot`; el nombre correcto es `worktreesRoot`), o es `hooksDir`, que por REST no se elige: el `pre-push` que rechaza todo queda siempre en `<worktreesRoot>\_hooks`;
- algún texto tiene forma de clave.

Un proyecto registrado sin `workspace` se guarda igual que antes. Pero la flota no crea ni integra sus tareas: falla en el acto con «sin gate configurado», antes de gastar cupo.

Para cambiar la configuración, borra el proyecto (`DELETE /projects/vetworld`, que no toca el repo ni los worktrees) y vuelve a registrarlo.

- `DELETE` responde **409** mientras haya tareas activas. Cuenta tanto el estado guardado (`ready`, `running`, `review` o `handed_off`) como lo que la flota tiene de verdad en curso, con la limpieza del worktree incluida. Cancélalas o espera a que terminen.
- `POST /tasks/:id/cancel` responde **409** si la tarea ya se está integrando (pasó el punto de compromiso). En ese caso la tarea no se marca `cancelled`: la flota solo la cancela si la integración falla.
- La tarea siguiente usa la configuración nueva. Un worktree creado antes se integra y se limpia **con la configuración con que se creó**: su raíz, su rama de integración y su gate.
- Dos integraciones del mismo repositorio git (la misma carpeta común, `git-common-dir`, aunque las copias sean worktrees distintos) nunca se intercalan, aunque las lleven gestores con configuraciones distintas.
- Una raíz nueva no puede solaparse con la raíz anterior del proyecto mientras esta tenga worktrees, ni con la de otro proyecto vigente. Cuentan los worktrees de tarea y también el `_integracion`, que la flota no quita al limpiar las tareas, y se comparan también las rutas reales. Volver exactamente a la raíz anterior sí vale.
- Si cambias `worktreesRoot` y mantienes `integrationBranch`, quita antes el worktree de integración viejo (primero `cmd /c rmdir` de cada junction de `<raíz vieja>\_integracion`, porque `git worktree remove` las sigue; después, `git -C C:\dev\Vetworld worktree remove <raíz vieja>\_integracion`). Si no lo quitas, git no deja sacar la misma rama en la raíz nueva y la integración falla con un error claro.

### Qué toca el núcleo en `C:\dev\Vetworld` (con la primera tarea, no al registrar)

- Crea la rama `orq/integracion` desde `main`, y una rama `orq/<tarea>` por tarea. **Nunca** las borra, no cambia la rama de la copia principal y no hace push.
- Activa `extensions.worktreeConfig = true` en `.git/config`. Cada worktree del núcleo recibe además un `pushurl` inválido y `core.hooksPath` hacia `<worktreesRoot>\_hooks`, donde un `pre-push` rechaza todo. Los worktrees de A0 no cambian: no tienen `config.worktree`.
- Si `_hooks` ya existe, solo la usa cuando es una carpeta real (ni junction ni enlace) que contiene únicamente su propio `pre-push`, sin enlaces duros y con el mismo contenido. Si no, falla sin escribir. Si el archivo aparece entre la comprobación y la escritura, repite las mismas comprobaciones (ver el riesgo residual de carreras).
- Cada enlace se comprueba con la ruta real:
  - el origen, incluidas sus carpetas intermedias, tiene que quedar dentro de `C:\dev\Vetworld`;
  - **todo el árbol** de una carpeta compartida se recorre, y **cualquier** enlace o junction descendiente la hace rechazar, apunte fuera (`recursos\externo` → `D:\privado`) o dentro del repo (`recursos\interno` → `repo\datos`). Una interna llevaría a partes del repo que no se revisan, como un `datos\externo` hacia fuera. El error indica la ruta del enlace. Vetworld no tiene ninguno: comprobado el 2026-11-03, cuando recorrer las cuatro carpetas costó unos 1,5 s (1,3 s en `node_modules`). El recorrido se hace al crear cada worktree, también el de integración, dentro de la cola de escrituras del repo;
  - los ancestros existentes del destino dentro del worktree se comprueban **antes** de crear carpetas: un ancestro que sea junction hacia fuera no recibe ninguna.

  Cualquier fallo hace fallar la creación de la tarea.
- Los enlaces ya están en `.gitignore`, así que no escribe en `.git/info/exclude`.
- Al quitar un worktree, primero quita sus junctions y después ejecuta `git worktree remove` (sin `--force`). En Windows, `git worktree remove` sigue la junction de un `node_modules` ignorado y vacía la copia principal. Esto se reprodujo con git 2.52.0.windows.1 el 2026-11-03. El núcleo lo evita, y lo prueban `tests/core/workspace/manager.cases.ts` y el fixture de Vetworld.
- Si alguna carpeta del worktree no se puede listar (permisos, E/S), el núcleo **no lo borra**: un recorrido incompleto podría dejar una junction sin quitar.

### Convivencia con los worktrees manuales de A0

El núcleo y A0 comparten el prefijo de ramas `orq/`. No uses como id de tarea un nombre cuya rama `orq/<id>` ya exista. Para verlas: `git -C C:\dev\Vetworld branch --list "orq/*"`. El 2026-11-03 eran `agy-osteometria`, `agy-rasgos`, `agy-rasgos-axial`, `agy-rasgos-pelvico`, `claude-visor-segmented`, `codex-critico-cli` y `codex-critico-geom`.

- Mientras su worktree esté en uso, git se niega a crear otro, y la tarea falla con un error claro.
- Cuando A0 lo quite, el núcleo **reutilizaría esa rama** con el trabajo de A0.

Usa un prefijo propio para las tareas del núcleo, por ejemplo `vw-…`. `orq/integracion` queda reservada para el núcleo.

### Limitaciones conocidas (no resueltas)

- **Reinicio del núcleo.** El vínculo de cada worktree con su configuración vive en memoria. Tras reiniciar, un worktree de una configuración retirada solo se reconoce si cae en la raíz vigente; si no, hay que quitarlo a mano (primero sus junctions con `cmd /c rmdir`, después `git worktree remove`).
- **Archivos copiados por `links`.** Se copian al crear cada worktree, y el de integración (`_integracion`) solo al crearse la primera vez. Si el original cambia, esas copias quedan desactualizadas. Para Vetworld no importa: enlaza solo carpetas.
- **Variables bloqueadas en `env`.** La lista no es exhaustiva. Por ejemplo, `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*` cambiarían la configuración de un `git` que lance el gate. Como quien declara comandos ya puede ejecutar código (ver el aviso del token), la lista cubre solo cómo se resuelve y se carga el programa lanzado.
- **Raíz dedicada.** No hay una lista de raíces permitidas. Una carpeta de otro repositorio que no esté registrado con `workspace` se acepta como raíz si no choca con las reglas de arriba.
- **Carreras entre comprobación y uso (riesgo residual medio).** Las comprobaciones de rutas, enlaces y `_hooks` se hacen justo antes de usarlos, no de forma atómica. Un proceso ajeno al núcleo (un editor, un gestor de paquetes, otro programa del usuario) podría cambiar algo en ese intervalo:
  - sustituir un ancestro por una junction entre la comprobación y el `mkdir`;
  - cambiar `_hooks` entre el `lstat` y la escritura;
  - meter un enlace en una carpeta compartida durante el recorrido o después de crear el enlace.

  Las colas del núcleo coordinan solo sus propios gestores. Para un uso local de un solo usuario se acepta como riesgo residual; no hay garantía de contención permanente del sistema de archivos.
- **Raíces retiradas.** Una raíz retirada se protege mientras queden worktrees de tarea ligados a ella o su `_integracion` en disco, pero solo durante la vida del proceso (ver «Reinicio del núcleo»).

## 2. Agentes

| Agente | Cómo se registra | Quién |
|---|---|---|
| `codex`, `agy` | `POST /agents/detect`: detecta los CLI con sesión iniciada en Windows y los registra | cualquiera |
| `claude` | `node src/core/app/cli.ts agregar-claude` | **solo el usuario** (sección 6) |

La flota carga los agentes la primera vez que se aprueba una tarea. Si registras uno después, reinicia el núcleo (`iniciar`) antes de aprobar más tareas.

## 3. Crear y aprobar una tarea

```powershell
$tarea = @{
  id = 'vw-ejemplo'; projectId = 'vetworld'
  title = 'Validar el inventario de osteometría'
  objective = 'Agregar la validación X a scripts/osteology/… y sus pruebas.'
  ownedPaths = @('scripts/osteology/**', 'tests/unit/osteology/**')
  dependsOn = @(); acceptance = @('npm run -s gate en verde')
  difficulty = 'medium'
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$api/tasks" -Headers $h -ContentType 'application/json' -Body $tarea
Invoke-RestMethod -Method Post -Uri "$api/tasks/vw-ejemplo/approve" -Headers $h -ContentType 'application/json' -Body '{"agentId":"codex"}'
```

- `agentId` admite `codex`, `agy` o `claude`. Equivale a `suggestedAgent`: el router lo respeta mientras ese agente tenga cupo (por encima del 20 %) y no esté ocupado. Si no, pasa a otro. Una tarea con `difficulty: "high"` va siempre a Claude.
- `ownedPaths`: la flota confirma el trabajo del agente solo si todo cae en estas rutas. Si algo queda fuera, la tarea falla al integrar.
- Ciclo: autor → revisión por **otro** agente → integración con gate. Ante un rechazo o un gate fallido, la tarea vuelve al autor con las observaciones, hasta 3 rondas. Con dos fallos seguidos pasa a Claude.
- Traspaso por cupo: si Codex o agy agotan el cupo, la tarea sigue con Claude **en el mismo worktree**, con el resumen y `.orq/HANDOFF.md`. Sin un Claude registrado, el traspaso no es posible y la tarea falla, pero el worktree se conserva.

## 4. Seguir la tarea y leer el informe

| Qué | Dónde |
|---|---|
| Estado (`pending → ready → running → review → integrated / failed / cancelled`) y agente actual | `GET /tasks/vw-ejemplo` |
| **Informe del autor**: una nota por agente que escribió código (con traspaso, una por tramo). Incluye el resumen final (hasta 2000 caracteres), los archivos cambiados, los tokens y el costo | `C:\dev\orquestador-memoria\Orquestador\Sesiones\<AAAA-MM-DD>-vw-ejemplo*.md`. Las escribe la flota al terminar la tarea |
| Veredicto del revisor | Sus observaciones van al `BRIEF.md` de la ronda siguiente; el texto completo está en los eventos de su sesión |
| Eventos completos de una sesión (último `text`, `done.summary`, `usage`) | `GET /sessions?agentId=codex&limit=5` (las más recientes primero) y `GET /sessions/<id>/events` |
| Uso y costo | `GET /usage?groupBy=agent` |
| En vivo | `/ws` |
| Encargo vigente, con las observaciones del revisor y el resumen del gate si falló | `C:\dev\.worktrees\vetworld-orq\vw-ejemplo\.orq\BRIEF.md` |
| Último mensaje de Codex | `…\vw-ejemplo\.orq\ultimo-mensaje.md` |
| Traspaso | `…\vw-ejemplo\.orq\HANDOFF.md`. Lo escribe el agente al quedarse sin cupo o sin tiempo. El núcleo lo copia, junto con el resumen de lo hecho, al `BRIEF.md` del agente que continúa |
| Resultado integrado | `git log orq/integracion` en `C:\dev\Vetworld` (commit `merge: integra orq/vw-ejemplo …`) |
| Sesiones resumidas | notas de la memoria (`C:\dev\orquestador-memoria`) |

Si la tarea se integra, el núcleo quita su worktree y su carpeta `.orq`: lee `BRIEF.md` y `HANDOFF.md` mientras la tarea corre. Si falla o se cancela, el worktree se conserva para revisarlo a mano.

Límites actuales de la REST:

- `GET /sessions?taskId=` no encuentra las sesiones de la flota, porque se guardan sin tarea. Búscalas por agente o en las notas de la memoria.
- No expone el detalle del fallo ni el resumen del gate de la última integración. Están en el `BRIEF.md` de la ronda siguiente y en el registro de `iniciar`.

## 5. Gate y recursos

El gate de Vetworld (`lint`, `typecheck`, `test` y validaciones) corre en `<worktreesRoot>\_integracion`, una integración a la vez. Usa CPU, pero no la GPU ni el navegador. Las tareas que necesiten Blender, Slicer, GPU o E2E deben tomar sus candados dentro del propio encargo (skill `local-compute-scheduling` del hub: `gpu`, `heavy-cpu-1`/`heavy-cpu-2`, `e2e`, `blender-mcp` y `slicer-mcp`). El núcleo no los toma por ellas.

## 6. Qué falta para usar workers Claude del núcleo

Lo hace **el usuario**, una vez, en PowerShell, con su clave (nunca en un archivo ni en el historial de un agente):

```powershell
$env:ANTHROPIC_API_KEY = '<tu clave>'          # o pásala por stdin con --stdin
node src/core/app/cli.ts agregar-claude --url <tu ANTHROPIC_BASE_URL> --presupuesto 5
Remove-Item Env:ANTHROPIC_API_KEY
node src/core/app/cli.ts probar-claude          # «OK» con la clave de la bóveda, sin variables de entorno
```

La clave queda solo en la bóveda DPAPI (`%LOCALAPPDATA%\orquestador\vault.json`). Después, reinicia `iniciar`.

Sin Claude se pueden usar `codex` y `agy`, pero:

- no hay traspaso por cupo;
- las tareas de dificultad alta fallan;
- la revisión necesita al menos dos agentes distintos.
