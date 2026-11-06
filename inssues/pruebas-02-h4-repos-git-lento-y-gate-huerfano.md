# Las dos H4 de repos.test.ts lanzan entre 55 y 61 git seguidos y, si se cortan antes de abrir la barrera, dejan el gate vivo y `_integracion` sin borrar

- **Área:** Pruebas y rendimiento
- **Severidad:** media
- **Archivos:** `tests/core/workspace/hardening.cases.ts:11`, `tests/core/workspace/hardening.cases.ts:24-29`, `tests/core/workspace/hardening.cases.ts:82-111`, `tests/core/workspace/hardening.cases.ts:114-141`, `tests/core/workspace/helpers.ts:52-58`, `tests/core/workspace/repos.test.ts:3-7`, `src/core/workspace/integrate.ts:36-55`, `src/core/workspace/integrate.ts:119`, `src/core/workspace/push-block.ts:75-101`, `src/core/workspace/manager.ts:86-138`, `src/core/workspace/manager.ts:192-227`
- **Estado:** abierta

## Cómo ocurre

Las pruebas con repos git reales están todas en `tests/core/workspace/repos.test.ts`, que importa cinco `.cases.ts` para que corran en un solo worker y en serie (`repos.test.ts:1-7`). Ese archivo forma parte de `npm run -s check` (`package.json:15`, `"test": "vitest run"`), que es el gate con el que la flota integra. Las dos pruebas H4 (`hardening.cases.ts:82-111` y `114-141`) comprueban una sola cosa: que la integración de B espera a que termine la de A cuando los dos gestores apuntan al mismo repositorio. Para comprobarlo usan una barrera: el gate de A es un `node -e` que crea `gate-empezo` y espera hasta que aparezca `abrir`, con un tope propio de 90 s (`hardening.cases.ts:24-29`):

```ts
const code = `...fs.writeFileSync(started,'');...if(fs.existsSync(open))process.exit(0);if(Date.now()-t0>90000)process.exit(9);setTimeout(w,50)...`;
```

**1. Muchos procesos en serie.** Conté, en el código, los `git` que lanza la primera H4:

| Paso | git | Dónde |
|---|---|---|
| `viejo.create` (repo nuevo: crea la rama de integración y activa `extensions.worktreeConfig`) | 10 | `manager.ts:121-132`, `push-block.ts:76-101` |
| `nuevo.create` | 6 | igual, con la extensión ya activa |
| dos `commitFile` (síncronos) | 4 | `helpers.ts:83-87` |
| `integrate` A (primera vez: `worktree prune`, `worktree add`, `blockPush`, HEAD, MERGE_HEAD, `status` ×2, rama, `merge`, MERGE_HEAD, `commit`, `rev-parse`) | 15 + 1 node | `integrate.ts:36-55`, `80-96`, `133-139` |
| `integrate` B (el worktree ya existe) | 9 + 1 node | lo mismo sin la parte de `existsSync` |
| comprobaciones `show`/`log` | 3 | `hardening.cases.ts:105-107` |
| `remove` A y B (`worktree list` ×2, `status`, `worktree remove` cada uno) | 8 | `manager.ts:192-220` |

Son unos 55 `git.exe` y 2 `node.exe`, uno tras otro. La segunda H4 suma unos 61: un `worktree add` más (`hardening.cases.ts:118`), un `create` de 7 y una segunda integración que también arma su propio `_integracion`, de 15. Los `remove` del final (`hardening.cases.ts:109-110` y `139-140`) no van seguidos de ningún `expect`, y `afterEach` borra la carpeta base de todos modos. Sin la máquina cargada no cuesta nada (el propio código estima unos 65 ms por git.exe, `push-block.ts:99`). Pero el repo ya registra frenadas de 20× con la flota trabajando (`vitest.config.ts:13`: «pruebas de 1 s llegaron a tardar 20 s»), y con Defender revisando cada proceso cada git puede pasar de 1-2 s. Ahí estas pruebas se acercan al tope o lo superan.

**2. El tope real del archivo es 120 s, y es uno solo.** Cada `.cases.ts` llama a `vi.setConfig({ testTimeout: ... })` al nivel del módulo: 90 s en `manager.cases.ts:10`, `integrate.cases.ts:9`, `push-block.cases.ts:9` y `review-agy.cases.ts:9`, y 120 s en `hardening.cases.ts:11`. En Vitest 4.1.12 la fábrica de cada `describe` corre en `collect()`, después de importar el archivo entero (`node_modules/@vitest/runner/dist/chunk-artifact.js:1884-1889`). Cada prueba lee el tope al crearse (`chunk-artifact.js:1734`: `const timeout = options.timeout ?? runner.config.testTimeout`). Como `vi.setConfig` hace `Object.assign` sobre la configuración compartida, gana el último import: todo `repos.test.ts` corre con 120 s. Los 90 s de los otros cuatro archivos no se aplican nunca. Para H4 da igual, pero el tope que se ve en cada archivo no es el que rige.

**3. Si la prueba se corta antes de abrir la barrera, nada la abre.** `abrir` se escribe en un único punto, `hardening.cases.ts:101` (y `134`). Si antes de llegar ahí la prueba vence, falla `until` (`hardening.cases.ts:31-37`, 60 s) o falla `expect(bDone).toBe(false)` (`100`/`133`), el gate de A sigue vivo hasta 90 s. Su cwd es el worktree de integración (`integrate.ts:119`: `runCommands(project.gate, cwd, ...)` con `cwd = <worktreesRoot>/_integracion`). Además, la promesa `a` sigue corriendo cuando la prueba ya terminó: cuando el gate sale con 9, hace el rollback con `git` sobre una carpeta que `afterEach` ya vació. `afterEach` llama a `t.cleanup()`, y `cleanup` se traga el error (`helpers.ts:52-57`):

```ts
try {
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  /* temporal: si Windows retiene algo, se queda */
}
```

Windows no deja borrar una carpeta que es el directorio actual de un proceso, y los 5 reintentos duran unos 3 s, mucho menos que los 90 s de la barrera.

**Evidencia en disco.** En `%TEMP%` quedan `orq-wt-uh1lLn\wt-uno\_integracion` (2026-11-05 01:25:24) y `orq-wt-UvKkaI\wt-uno\_integracion` (2026-11-03 16:40:20). Las dos carpetas `_integracion` están vacías. La base, `wt-uno` y `_integracion` tienen la misma hora con milisegundos de diferencia: el borrado vació la carpeta pero no pudo quitarla. `wt-uno` solo lo usa la segunda H4 (`hardening.cases.ts:120`). La de hoy coincide con el check previo al commit `de896ce` (01:27:57). No encontré el registro de esa corrida, así que no está probado que esa vez venciera el tope. Lo que sí está probado es que un proceso retuvo `_integracion` más de 3 s después de la prueba, y lo único de la prueba que vive tanto es el gate de la barrera.

**4. Falso verde en la segunda H4.** En la primera H4 una regresión se detecta igual por las aserciones del final: sin la cola, B abortaría el merge de A en el mismo `_integracion`. En la segunda, cada gestor tiene su propio worktree de integración y su propia rama (`hardening.cases.ts:120-123`), y lo único que comprueba la cola es `expect(bDone).toBe(false)` tras 1,5 s (`hardening.cases.ts:132-133`). Sin la cola `integrate:<común>`, B haría unos 15 git y un node antes de terminar. Con carga eso pasa de 1,5 s, y la prueba da verde aunque la serialización no exista.

## Por qué pasa

- La prueba hace mucho más trabajo de proceso del que necesita para comprobar «B espera a A». Repite dos veces la preparación completa (`create`, `_integracion` nuevo con `blockPush`) y termina con `remove` que nadie comprueba.
- La barrera solo se abre por el camino feliz. Ni `afterEach` ni `cleanup` saben que hay un gate esperando, y nadie espera a las promesas `a`/`b` antes de borrar la base.
- `cleanup` se traga cualquier error de borrado sin avisar, así que el resto en `%TEMP%` pasa desapercibido.
- El tope que se lee en cada `.cases.ts` no es el que rige: `vi.setConfig` al nivel del módulo, con todos los `.cases.ts` importados en un mismo archivo, deja el valor del último import.
- La aserción por tiempo (1,5 s) depende de la velocidad de la máquina.

## Solución posible

En `tests/core/workspace/hardening.cases.ts`:

1. Quitar `await viejo.remove(wsA); await nuevo.remove(wsB);` (líneas 109-110) y `await uno.remove(wsA); await dos.remove(wsB);` (139-140). Son 8 git por prueba que no se comprueban, y `remove` ya está cubierto en `manager.cases.ts`.
2. Registrar cada barrera y cada integración pendiente en una lista del módulo. En `afterEach`, antes de `t?.cleanup()`: escribir el `abrir` de cada barrera y luego `await Promise.allSettled(pendientes)` con un tope corto. Así el gate termina, la promesa `a` hace su rollback mientras la carpeta aún existe y después se borra la base. `afterEach` pasa a ser `async`.
3. Dar a las dos H4 un tope propio con el tercer argumento de `it(..., 240_000)`, que no depende del orden de los imports, y bajar el tope de la barrera (90 s, línea 27) y de `until` (60 s, línea 31) para que siempre venzan antes que la prueba.
4. En la segunda H4, comprobar el orden y no el tiempo: el gate de B, en vez de `process.exit(0)`, escribe una marca `b-gate`. La prueba afirma que `b-gate` no existe mientras `gate-empezo` existe y `abrir` no, y que la marca de B se crea después de `abrir` (por ejemplo, comparando el `mtimeMs` de los dos archivos o escribiendo un contador en un mismo archivo).

En `tests/core/workspace/helpers.ts`, que `cleanup` no se trague el fallo en silencio: al menos un `console.warn` con la ruta que no pudo borrar, o devolver un booleano que `afterEach` pueda afirmar en las pruebas que no usan procesos largos.

En los `.cases.ts`, sustituir `vi.setConfig` al nivel del módulo por `describe(..., { timeout })` o por el tercer argumento de `it`. O, si se quiere un tope único, fijarlo una sola vez en `repos.test.ts`, que es lo que de verdad pasa hoy.

### Otras opciones

- **Gate dentro del proceso.** Probar la cola con un `exclusive`/gate falso, sin `node.exe` ni barrera en disco: un `runCommands` inyectable en `integrateWorkspace` o una prueba unitaria de `serial()` con la clave `integrate:<común>`. Esto quita la barrera y el riesgo de huérfano. Dejaría una sola prueba de humo con git real.
- **Una sola H4.** Un único repo con dos gestores, uno con la misma carpeta y otro con una copia enlazada (mismo `git-common-dir`). Cubre los dos casos con una sola preparación y ahorra unos 30 git.
- **Proyecto de Vitest aparte** para `repos.test.ts` (`maxWorkers: 1`, su propio `testTimeout`), fuera del check rápido del gate o en un paso del check que no compita por la CPU con el resto de la suite.
- **Que la barrera muera con su padre.** El gate comprueba con `process.ppid`/`process.kill(ppid, 0)` si el proceso de pruebas sigue vivo y sale si no. No libera la carpeta durante la misma corrida, pero evita los node.exe colgados durante 90 s.

Ninguna de estas es la única salida. La más barata es la 1 + 2 + 4 de la propuesta. La que más ahorra (sin procesos para la cola) cambia la forma de la prueba y conviene decidirla con quien mantenga `src/core/workspace`.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:** en `tests/core/workspace/hardening.cases.ts`, una variante de la segunda H4 que fuerce el corte. Por ejemplo, con un `it(..., 5_000)` y un `until` que espere una condición que nunca se cumple. Luego, en un `it` siguiente del mismo `describe`, afirmar que la carpeta base de la prueba anterior ya no existe (`existsSync(base) === false`) y que no queda la marca de la barrera abierta sin cerrar. Para la aserción por orden, una prueba que reemplace temporalmente la clave de la cola (o use dos procesos de prueba distintos, uno sin la cola) y compruebe que la nueva aserción falla sin cola y pasa con ella.
- **Medición:** contar los git de cada H4 antes y después (por ejemplo, envolviendo `gitPath` en las opciones del gestor con un script que registre cada llamada, o con `GIT_TRACE2_EVENT` hacia un archivo) y medir la duración con `--reporter=verbose`.
- **Comando** (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/workspace/repos.test.ts -t H4 --reporter=verbose"` (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/workspace/repos.test.ts -t H4 --reporter=verbose`). Correrlo cuando la CPU no esté al límite.
- **Verificación manual:** después de una corrida que falle o venza a propósito, comprobar que en `%TEMP%` no aparece ningún `orq-wt-*\wt-uno\_integracion` nuevo ni ningún `orq-wt-*\worktrees\_integracion`, y que en el Administrador de tareas no queda ningún `node.exe` con `gate-empezo` en la línea de comandos. Los dos restos actuales (`orq-wt-uh1lLn` y `orq-wt-UvKkaI`) se pueden borrar a mano cuando no haya pruebas corriendo.
