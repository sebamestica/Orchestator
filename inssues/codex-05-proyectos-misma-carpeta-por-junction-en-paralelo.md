# Modo local: dos proyectos que llegan a la misma carpeta por una junction corren tareas a la vez y se borran `.orq/` entre sí

- **Área:** Seguridad y corrección (revisión de Codex): núcleo de la flota, modo local
- **Severidad:** media
- **Archivos:** `src/core/app/local-workspaces.ts:85-88`, `src/core/app/local-workspaces.ts:142-151`, `src/core/app/local-workspaces.ts:174-176`, `src/core/app/workspaces.ts:99-102`, `src/core/orchestrator/fleet.ts:265-279`, `src/core/fs/folders.ts:45-53`, `src/core/fs/folders.ts:382-388`, `src/core/app/f5-servidor.ts:211-216`, `src/core/store/store.ts:340-349`, `src/core/workspace/config.ts:121-136`
- **Estado:** resuelta

## Cómo ocurre
En modo local (issue 1), un proyecto registrado sin `workspace` trabaja directamente en la carpeta del usuario, sin
worktree, sin ramas y casi siempre sin git que respalde los cambios. El diseño pide **una tarea a la vez por carpeta
local** (`docs/plan/issues/01-trabajo-local.md:34-37`). Si dos agentes corren a la vez, se pisan `.orq/BRIEF.md`,
`.orq/PLAN.md` y los archivos del usuario. La flota lo evita con una clave de exclusión por carpeta:

```ts
// src/core/app/workspaces.ts:99-101
exclusiveKey(projectId: string): string | undefined {
  const local = this.localProject(projectId);
  return local ? `local:${LocalWorkspaces.key(local.repoPath)}` : undefined;
```

```ts
// src/core/app/local-workspaces.ts:85-87
static key(repoPath: string, platform: NodeJS.Platform = process.platform): string {
  const r = resolve(repoPath).replace(/[\\/]+$/, '');
  return platform === 'win32' ? r.toLowerCase() : r;
```

`Fleet.run` solo deja empezar una tarea si ninguna en curso tiene la misma clave como texto (`fleet.ts:265-267`,
`![...this.#exclusive.values()].includes(key)`), y la cola corre hasta 3 tareas a la vez por defecto
(`fleet-service.ts:126`). La clave es **léxica**: `resolve`, quitar la barra final y pasar a minúsculas. No sigue
junctions ni enlaces simbólicos, así que `C:\datos\proyecto` y una junction `C:\alias\proyecto` que apunta a la misma
carpeta dan claves distintas.

Nada impide registrar esa misma carpeta dos veces con rutas diferentes:

- `POST /projects/from-folder` rechaza una carpeta ya registrada con `registeredAs` (`f5-servidor.ts:212`), pero esa
  comparación también es léxica: `isInside(p.repoPath, dir) && isInside(dir, p.repoPath)` (`folders.ts:384`), y
  `normalizeFolderPath` solo hace `resolve` y pone la unidad en mayúscula (`folders.ts:45-53`). La ruta de la junction
  se guarda tal cual como `repoPath` (`f5-servidor.ts:216`).
- `Store.putProject` (`POST /projects`) solo comprueba solapes si el proyecto tiene `workspace`, y solo contra
  proyectos con `workspace` (`store.ts:340-347`). Entre proyectos locales no compara nada, ni siquiera la ruta exacta.

En cambio, para proyectos con worktrees el núcleo sí resuelve junctions: `projectsOverlapProblem` compara también
`physicalPath(x)` (`config.ts:223-226`), y `physicalPath` usa `realpathSync.native` «junctions incluidas»
(`config.ts:121-129`). Los proyectos locales se quedaron fuera de esa protección.

Pasos:

1. Registrar `C:\datos\proyecto` (sin git o sin gate, así queda en modo local) como proyecto `a`.
2. Crear la junction `mklink /J C:\alias\proyecto C:\datos\proyecto` y registrar `C:\alias\proyecto` como proyecto
   `b`. `inspectFolder` no ve que ya existe y el alta sale bien.
3. Delegar una tarea en `a` y otra en `b` (por ejemplo, con `crear_tareas` de la mente o con dos `POST /tasks/manual`).
   `exclusiveKey('a')` es `local:c:\datos\proyecto` y `exclusiveKey('b')` es `local:c:\alias\proyecto`. Como no
   coinciden, las dos tareas arrancan a la vez (`fleet.ts:269-272`).
4. Los dos agentes editan los mismos archivos del usuario. `create` reescribe `.orq/` para cada tarea, y la segunda
   pisa el `BRIEF.md` y el `PLAN.md` de la primera.
5. La tarea de `a` termina bien y la flota llama a `remove`. La guardia que debería proteger a otra tarea viva de la
   misma carpeta compara con la misma clave léxica, así que no ve la tarea de `b`. `remove` borra `.orq/` entera
   mientras `b` la sigue usando:
   ```ts
   // src/core/app/local-workspaces.ts:148-150
   const folder = LocalWorkspaces.key(project.repoPath);
   if ([...this.#live.values()].some((p) => LocalWorkspaces.key(p.repoPath) === folder)) return;
   if (await exists(join(project.repoPath, LOCAL_MARKER))) await rm(join(project.repoPath, SCRATCH), { recursive: true, force: true });
   ```
   El mismo comentario de la línea 147 dice que esto «no debería pasar: la flota las serializa».

No hay pruebas con junctions para el modo local. `tests/integration/local-mode.test.ts:62` y
`tests/integration/project-workspaces.test.ts:161` solo comprueban que la clave empieza por `local:`, y
`tests/core/orchestrator/fleet-local.test.ts` usa una `exclusiveKey` falsa.

La severidad queda en media y no en alta. El daño es real y cae en una carpeta que puede no tener git (trabajo
pisado o perdido, `.orq/` borrada a media tarea), pero solo pasa si la misma carpeta se registra dos veces con rutas
distintas. Eso no es lo habitual, aunque en Windows hay junctions comunes en el perfil del usuario (por ejemplo
`Mis documentos` → `Documents`).

## Por qué pasa
La identidad de la carpeta local es su ruta escrita, no la carpeta física. `LocalWorkspaces.key`
(`local-workspaces.ts:85-88`) se usa para tres cosas: la clave de exclusión de la flota (`workspaces.ts:101`), la
entrada viva de cada workspace (`liveKey`, `local-workspaces.ts:174-176`) y la guardia de `remove`
(`local-workspaces.ts:148-149`). Ninguna resuelve junctions. Además, el alta de proyectos no detecta duplicados
físicos entre proyectos locales (`folders.ts:382-388`, `store.ts:340`), así que llegan a convivir dos proyectos con la
misma carpeta y claves distintas.

## Solución posible
1. **`src/core/app/local-workspaces.ts`, `LocalWorkspaces.key`:** canonizar con la ruta física antes de normalizar.
   Por ejemplo: `const r = physicalPath(resolve(repoPath)).replace(/[\\/]+$/, '')`, usando el `physicalPath` que ya
   exporta `src/core/workspace/index.ts` (lo importa `workspaces.ts:5`). `physicalPath` tolera rutas que no existen,
   porque sube al ancestro existente, y no lanza. Así la clave de exclusión, `liveKey` y la guardia de `remove` pasan a
   ser físicas sin tocar `fleet.ts`.
2. **`src/core/fs/folders.ts:382-388`, `registeredAs`:** comparar también `physicalPath(p.repoPath)` con
   `physicalPath(dir)`, como hace `projectsOverlapProblem`, para que `POST /projects/from-folder` devuelva 409 con la
   junction.
3. **`src/core/store/store.ts:340-349`, `putProject`:** para un proyecto sin `workspace`, rechazar otro proyecto local
   con la misma carpeta física (`isInside` en los dos sentidos sobre `physicalPath`), para cubrir también
   `POST /projects`.

### Otras opciones
- **Guardar la ruta canónica al registrar.** `inspectFolder` guardaría `realpathSync.native(dir)` como `repoPath`. La
  clave sería estable y barata, porque `exclusiveKey` se evalúa por cada tarea lista en cada vuelta del bucle
  (`fleet.ts:265-269`) y hoy no toca disco. Pero cambia la ruta que ve el usuario y no arregla los proyectos ya
  guardados. Si la junction se rehace después, la ruta guardada queda vieja.
- **Cachear la clave física** por `repoPath` dentro de `ProjectWorktrees`, para no llamar a `realpath` en cada
  evaluación del predicado. Hay que invalidarla al cambiar el proyecto.
- **Excluir también carpetas anidadas** (un proyecto local en `C:\datos` y otro en `C:\datos\sub` también escriben en
  los mismos archivos). En vez de comparar claves iguales, el predicado de `fleet.ts` compararía con `isInside` en los
  dos sentidos. Va más allá de este issue, pero sale casi gratis si la clave ya es física.
- **Un candado de carpeta en disco** (por ejemplo, un archivo de bloqueo dentro de `.orq/`), que serializaría incluso
  entre dos núcleos o con alias que `realpath` no resuelve (unidades de red mapeadas dos veces). Es más robusto, pero
  añade limpieza de candados huérfanos.

La propuesta no es la única. Lo mínimo es la clave física del punto 1. Las comprobaciones de alta (puntos 2 y 3)
evitan el estado confuso de tener dos proyectos con la misma carpeta.

## Cómo probar que quedó resuelta
- **Prueba automatizada propuesta:** en `tests/integration/local-mode.test.ts`, que ya monta `ProjectWorktrees` con
  proyectos del almacén sobre carpetas temporales:
  1. Crear `real = tempDir()` y una junction `alias` que apunte a `real` con
     `symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')`, como en
     `tests/core/memory/safe-fs.test.ts:51`.
  2. Dos registros locales, `a` con `repoPath: real` y `b` con `repoPath: alias`, servidos por `storeProject`.
  3. Afirmar `pw.exclusiveKey('a') === pw.exclusiveKey('b')`.
  4. Crear el workspace de una tarea de `a` y otro de una tarea de `b`, quitar el de `a` con `pw.remove(...)` y afirmar
     que `existsSync(join(real, '.orq'))` sigue siendo `true` mientras el de `b` está vivo. Luego quitar el de `b` y
     afirmar que `.orq/` desaparece.
  - En `tests/core/orchestrator/fleet-local.test.ts`, otro caso con `exclusiveKey` real de `ProjectWorktrees` para los
    dos proyectos y adaptadores falsos que registren su intervalo de actividad. Afirmar que los intervalos de las dos
    tareas no se cruzan aunque la concurrencia sea 3.
  - En las pruebas de `inspectFolder` y de `Store.putProject`, afirmar que registrar la junction de una carpeta ya
    registrada da `registeredAs` / 409 y `StoreError('invalid', …)`.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/integration/local-mode.test.ts tests/core/orchestrator/fleet-local.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/integration/local-mode.test.ts tests/core/orchestrator/fleet-local.test.ts`).
- **Verificación manual en la app:** crear `mklink /J C:\alias\prueba C:\datos\prueba` sobre una carpeta sin git, y
  registrar `C:\datos\prueba` desde la interfaz. Al intentar registrar `C:\alias\prueba`, la app debe avisar de que la
  carpeta ya es un proyecto. Si se fuerza con `POST /projects`, debe rechazarlo. Con dos tareas en el mismo proyecto
  local, el panel debe mostrar solo una en curso a la vez.
