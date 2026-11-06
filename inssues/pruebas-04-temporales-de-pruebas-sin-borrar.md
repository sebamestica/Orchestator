# Las pruebas dejan carpetas en %TEMP%: la plantilla de repos nunca se borra, `makeRepo().cleanup` falla callado y f5-chat deja a la flota escribiendo memoria

- **Área:** Pruebas y rendimiento
- **Severidad:** baja
- **Archivos:** `tests/core/workspace/helpers.ts:42`, `tests/core/workspace/helpers.ts:52-58`, `tests/core/workspace/repos.test.ts:3-7`, `node_modules/vitest/dist/chunks/cli-api.B0Pz1_R7.js:3045`, `node_modules/vitest/dist/chunks/cli-api.B0Pz1_R7.js:3179`, `node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js:180`, `tests/integration/helpers.ts:108-116`, `tests/core/chat/f5-chat.test.ts:21-25`, `tests/core/chat/f5-chat.test.ts:113-125`, `src/core/app/compose.ts:205-210`, `src/core/app/compose.ts:233-236`, `src/core/app/fleet-port.ts:116-124`, `src/core/orchestrator/fleet.ts:364-369`, `src/core/orchestrator/fleet.ts:651-654`, `src/core/memory/obsidian-memory.ts:234-238`
- **Estado:** resuelta

## Cómo ocurre

La suite (`npm run -s test` = `vitest run`, que el gate `npm run -s check` corre en cada tarea de la flota) crea sus
temporales con `mkdtemp(os.tmpdir(), …)`: hay 123 llamadas en 54 archivos de `tests/`. Ninguna pieza global se
encarga de ellos. Cada archivo los borra por su cuenta, y tres de esas limpiezas fallan.

Conteo hecho hoy (2026-11-05) en `C:\Users\SEBASTIAN\AppData\Local\Temp`, solo leyendo: 179 carpetas
`orq-wt-plantilla-*` (22 del 01-11, 16 del 02-11, 16 del 03-11, 117 del 04-11 y 8 de hoy), 41 `orq-wt-*` (36 vacías),
24 `orq-c12-*`, 9 `orq-desktop-*`, 8 `orq-skills-revision-*` y 7 `orq-boveda-*`. Entre las plantillas suman unos 2.200
archivos. La cuenta de plantillas subió de 177 a 179 mientras se hacía esta verificación.

### 1. La plantilla de repos git nunca se borra

`repoTemplate()` crea la plantilla una vez por proceso. Su única limpieza es un manejador de `exit`:

```ts
// tests/core/workspace/helpers.ts:28 y :42
const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'orq-wt-plantilla-')));
...
process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
```

Vitest 4.1.12 usa el pool `forks` por defecto (`coverage.DM_a_rWm.js:180`: `resolved.pool ??= "forks"`;
`vitest.config.ts` no lo cambia). Para cerrar un worker, primero le manda `stop` (`cli-api.B0Pz1_R7.js:3045`). El worker
responde `stopped` (`init.k9zZ9sLh.js:350`). Después el padre lo mata:

```js
// node_modules/vitest/dist/chunks/cli-api.B0Pz1_R7.js:3178-3179
const sigkillTimeout = setTimeout(() => fork.kill("SIGKILL"), SIGKILL_TIMEOUT);
fork.kill();
```

En Windows, `kill()` es `TerminateProcess`, y en POSIX un SIGTERM sin manejador también termina el proceso. En ninguno
de los dos casos Node emite `'exit'` en el hijo, así que el `rmSync` de la línea 42 no corre. Solo
`tests/core/workspace/repos.test.ts` (líneas 3-7) importa los `*.cases.ts` que llaman a `makeRepo()`, y por eso queda
una plantilla por cada corrida de la suite o de ese archivo. Las 117 del 04-11 corresponden a los gates de la flota de
ese día.

### 2. `makeRepo().cleanup` falla en silencio

```ts
// tests/core/workspace/helpers.ts:52-58
const cleanup = () => {
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* temporal: si Windows retiene algo, se queda */
  }
};
```

En Windows, si un `git.exe` hijo, un proceso del gate o Defender todavía tiene abierto un archivo de la carpeta, el
borrado puede vaciar el contenido y fallar en la carpeta base. El error se descarta y nadie se entera. Así se explican
las 36 `orq-wt-*` vacías. Las otras 5 conservan `worktrees/` o `wt-uno/`; esta última viene de
`hardening.cases.ts:120`.

### 3. f5-chat deja a la flota real trabajando después del `afterEach`

`orq-c12-` es el prefijo por defecto de `tempDir()` (`tests/integration/helpers.ts:108`). Las 24 carpetas que quedan
tienen solo restos de memoria: `memoria/`, `memoria/.orquestador-candado/owner` y, según el caso,
`memoria/Orquestador/Proyectos` o las cuatro carpetas de `ensureStructure()`. No hay `orq-c27-*` (el prefijo de
`aislamiento-f5` y `conductor-aislamiento`), así que el origen es un archivo que usa el prefijo por defecto y
manda una tarea a la flota real. El candidato es `tests/core/chat/f5-chat.test.ts`:

- `setup()` registra el proyecto `demo` con `repoPath: dir`, una carpeta temporal sin git (línea 46). Eso lo pone en
  modo local (`src/core/app/workspaces.ts:105-106`).
- La prueba «aprobar en el chat lleva la tarea al tablero y a la cola real de la flota» (líneas 113-125) aprueba
  `tarea-a`. `FleetPort.delegate` la encola y llama a `#kick()` (`src/core/app/fleet-port.ts:116-124`). La prueba
  termina enseguida.
- La flota sigue sola: `workspaces.create` funciona porque el proyecto es local
  (`src/core/orchestrator/fleet.ts:364`), y luego `#generalPlan` llama a `recordPlan` (`fleet.ts:369` y `:651-654`),
  que toma el candado de la bóveda y crea carpetas:

```ts
// src/core/memory/obsidian-memory.ts:236-237
await mkdir(this.vaultPath, { recursive: true });
return withVaultLock(path.join(this.vaultPath, '.orquestador-candado'), fn, this.lockOptions);
```

- El `afterEach` cierra con `c.close()` (`f5-chat.test.ts:23`), que solo olvida el entorno y cierra SQLite
  (`compose.ts:205-210`). Para detener la flota hay que llamar a `shutdown()` (`compose.ts:233-236`), que hace
  `fleet.stop()` y espera la corrida (`fleet-port.ts:186-189`). Después, `cleanupDirs()` borra `dir`.
- El `mkdir(..., { recursive: true })` de la memoria vuelve a crear `orq-c12-xxxx/memoria`, ya sea después del borrado
  o al mismo tiempo. Al terminar el archivo, Vitest mata el worker (punto 1) con la escritura a medias.
  `withDirLock` libera el candado en un `finally` (`src/core/fs/dir-lock.ts:136-140`), pero ese `finally` no llega a
  ejecutarse, y por eso queda `owner`.

**Corrección al reporte original:** `conductor.test.ts`, `core.test.ts` y `compose.test.ts` también cierran con
`close()`, pero no causan este resto. En `conductor.test.ts` el proyecto `demo` no está registrado, así que la tarea
falla en `workspaces.create` antes de tocar la memoria (`fleet.ts:364`, comentario en `conductor.test.ts:58`).
`core.test.ts` y `compose.test.ts` no mandan tareas a la flota. Las pruebas de integración que sí corren tareas
(`fleet-hooks`, `retry`, `rest-reconfig`) ya usan `await c.shutdown()`.

## Por qué pasa

- La plantilla depende del evento `exit`, que nunca llega porque Vitest termina sus workers con `kill()`.
- `makeRepo().cleanup` reintenta poco (5 × 200 ms) y descarta el error.
- `f5-chat.test.ts` manda una tarea a la flota real y la cierra con `close()`, que no la detiene. Su trabajo en
  segundo plano (el plan en la memoria) escribe en la carpeta temporal que se está borrando.
- No existe una carpeta por corrida ni un barrido que limpie lo que quede.

## Solución posible

1. **Plantilla:** en `tests/core/workspace/helpers.ts`, exportar `disposeRepoTemplate()`, que borre `template` con
   `rmSync(template, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })` y lo deje en `undefined`.
   Quitar el `process.once('exit')`. En `tests/core/workspace/repos.test.ts`, agregar `afterAll(disposeRepoTemplate)`.
   Como ese archivo importa todos los `*.cases.ts`, un `afterAll` en su nivel superior corre después de todos ellos.
2. **`makeRepo().cleanup`:** subir los reintentos (`maxRetries: 20, retryDelay: 250`). Si aun así falla, guardar la
   ruta en una lista del módulo para que `disposeRepoTemplate()` vuelva a intentarlo al final, en lugar de olvidarla.
3. **f5-chat:** en `tests/core/chat/f5-chat.test.ts:23`, cambiar `for (const c of comps.splice(0)) c.close();` por
   `for (const c of comps.splice(0)) await c.shutdown();`, como ya hacen `fleet-hooks`, `retry` y `rest-reconfig`.
   Conviene revisar con el mismo criterio cualquier otra prueba que apruebe o delegue tareas sobre un proyecto
   registrado y cierre con `close()`.

### Otras opciones

- **Carpeta por corrida:** en `vitest.config.ts`, calcular `%TEMP%\orq-vitest-<pid>-<fecha>` al cargar la
  configuración, que ocurre en el proceso principal antes de crear el pool, y pasarlo con `test.env: { TEMP, TMP }`.
  En Windows, `os.tmpdir()` lee `TEMP`/`TMP` en cada llamada, así que las 123 llamadas a `mkdtemp` quedarían dentro
  sin tocar cada prueba. Un `globalSetup` con teardown la borraría con reintentos y además eliminaría las
  `orq-vitest-*` de más de 24 h. Esto cubre también los casos futuros, aunque hay que confirmar que ninguna prueba
  necesita su temporal fuera del checkout ni en otro volumen (los `realpathSync.native` siguen funcionando).
- **Script de barrido** (`scripts/limpiar-temporales`) que borre `orq-*` viejos en `%TEMP%`, ejecutado por el gate.
  Es más simple, pero solo limpia después y no corrige que la flota siga corriendo tras la prueba.
- **Prueba que detecte fugas:** que `cleanup` y `cleanupDirs` registren lo que no pudieron borrar y que un
  `afterAll` falle si queda algo. Pone el problema a la vista, pero no lo resuelve solo.

Estas propuestas no son la única salida. La carpeta por corrida es la más completa, y los tres arreglos puntuales
son lo mínimo para dejar de acumular restos.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta 1:** `tests/core/workspace/helpers-limpieza.test.ts`. Llama a `makeRepo()`,
  obtiene la ruta de la plantilla (exportar un `repoTemplatePath()` solo para pruebas), llama a `t.cleanup()` y a
  `disposeRepoTemplate()`, y comprueba que `existsSync(base)` y `existsSync(plantilla)` dan `false`.
- **Prueba automatizada propuesta 2:** en `tests/core/chat/f5-chat.test.ts`, al final del caso «aprobar en el chat…»,
  hacer `await comp.shutdown()` y `await cleanupDirs()`, esperar unos `tick()` y comprobar que
  `existsSync(dir)` da `false`. Es decir, que la flota no vuelve a crear `memoria/` después del borrado.
- **Comando para correrlas (desde WSL):**
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/workspace/helpers-limpieza.test.ts tests/core/chat/f5-chat.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/workspace/helpers-limpieza.test.ts tests/core/chat/f5-chat.test.ts`).
- **Verificación manual:** en PowerShell, contar antes y después de una corrida:
  `(Get-ChildItem $env:TEMP -Directory -Filter 'orq-wt-plantilla-*').Count` y lo mismo con `orq-c12-*` y `orq-wt-*`.
  Correr `npx vitest run tests/core/workspace/repos.test.ts tests/core/chat/f5-chat.test.ts`. Hoy cada cuenta sube
  (la de plantillas, en 1 por corrida). Con el arreglo, ninguna debería cambiar.
