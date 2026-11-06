# La prueba de la colección de Postman lee C:\dev y C:\dev\Vetworld reales: su resultado depende del equipo

- **Área:** Pruebas y rendimiento
- **Severidad:** baja
- **Archivos:** `tests/docs/postman-run.test.ts:40`, `tests/docs/postman-run.test.ts:50`, `tests/docs/postman-run.test.ts:84`, `tests/docs/postman-run.test.ts:94`, `docs/api/source.ts:4`, `docs/api/source.ts:39`, `src/core/app/f5-servidor.ts:92`, `src/core/app/f5-servidor.ts:159`, `src/core/app/f5-servidor.ts:193`, `src/core/app/f5-servidor.ts:210`, `src/core/fs/folders.ts:49`, `src/core/fs/folders.ts:379`, `docs/api/orquestador.postman_collection.json:798`, `docs/api/orquestador.postman_collection.json:993`, `docs/api/orquestador.postman_collection.json:1069`, `docs/api/orquestador.postman_collection.json:3334`
- **Estado:** resuelta

## Cómo ocurre

`tests/docs/postman-run.test.ts` toma cada petición de la colección de Postman (que se genera a partir de los `example`
de las rutas) y la manda, tal como está escrita, a la app que arma `createInMemoryApp`:

```ts
// tests/docs/postman-run.test.ts:40 y :50
const app = createInMemoryApp({ validateResponses: true });
const fill = (text: string): string => text.replace(/\{\{([^}]+)\}\}/g, (_, name: string) => vars[name] ?? `{{${name}}}`);
```

`fill` solo cambia las variables `{{...}}`. Las rutas de ejemplo son texto literal y no se tocan:
`POST /projects/inspect` con `{"path": "C:\\dev\\Vetworld"}` (colección:993), `POST /projects/from-folder` con
`{"path": "C:\\dev\\Vetworld", "name": "Vetworld"}` (colección:1069) y `GET /fs/list?path=C:\dev` (colección:3334). Vienen
de los `example` y del `queryExample` de `src/core/app/f5-servidor.ts`.

La app «en memoria» solo tiene en memoria la base y la bóveda. El módulo de carpetas se arma sin `fsEnv`:

```ts
// docs/api/source.ts:39
const routeModules = [createF5ServerRoutes({ pickFolder: async () => null }), createUsageRoutes(), storage];
// src/core/app/f5-servidor.ts:92
const fsEnv = opts.fsEnv ?? {};
```

Así que `listFolder` (f5-servidor.ts:159) e `inspectFolder` (f5-servidor.ts:193 y :210) usan el disco real con
`process.platform` (`requireDir`, `readdir`, `stat` de `.git`, lectura de `package.json` y de `node_modules`; folders.ts:148
y :379). Además, `fsEnv` no virtualiza el disco: solo cambia la plataforma, el perfil y el entorno.

Pasos, en el orden en que corre la prueba (primero todo lo que no es DELETE, en el orden de la colección):

1. `POST /projects` registra `vetworld` con `repoPath: C:\dev\Vetworld` (colección:798). El store no mira el disco y
   responde 201.
2. `POST /projects/inspect` lee la carpeta real `C:\dev\Vetworld` del usuario. En este PC existe y responde 200. En un
   Windows sin esa carpeta responde 404.
3. `POST /projects/from-folder` vuelve a leerla. En este PC `inspectFolder` encuentra el proyecto del paso 1 en la misma
   ruta (`registeredAs`) y responde 409 (f5-servidor.ts:212). En otro Windows responde 404.
4. `GET /fs/list?path=C:\dev` lista la carpeta real de proyectos del usuario y mira `.git` en cada entrada, hasta 2000.
   Responde 200 o 404 según el equipo.
5. La prueba solo comprueba que el estado esté documentado (`errors: [400, 404, 409, 415]`; test:84). La lista de 2xx
   obligatorios (test:94) no incluye estas tres rutas, así que pasa con 200/409 o con 404/404.

Consecuencias concretas:

- La prueba lee carpetas personales que están fuera del repositorio. Eso contradice el contrato que declara
  `docs/api/source.ts:4-5`: «solo para leer la tabla de rutas: no escucha en ningún puerto ni toca datos del usuario».
  Si alguna de estas peticiones falla, el mensaje incluye los primeros 200 caracteres de la respuesta (test:84), es decir,
  nombres de carpetas reales.
- El esquema de éxito de `inspect` y de `fs/list` (test:87-88) solo se comprueba en un equipo que tenga esas carpetas. En
  los demás se valida el esquema de error. El camino 201 de `from-folder` no se ejecuta en ningún equipo: en el mejor caso
  la respuesta es 409.
- Fuera de Windows, `normalizeFolderPath` rechaza `C:\…` por no ser una ruta absoluta (folders.ts:49). La respuesta es 400,
  que está en `BROKEN` (test:58), y la prueba falla. El resto de las pruebas de carpetas sí tiene en cuenta la plataforma
  (`isWin` en `tests/core/f5-servidor/folders.test.ts:27`). El entorno oficial es el Node de Windows (AGENTS.md:7 y :17),
  así que este punto es secundario.

Corrección al informe original: el camino 201 de `from-folder` sí tiene cobertura, con carpetas temporales, en
`tests/core/f5-servidor/folders.test.ts:180-188` y `:232-235`. El problema es que la prueba de la documentación no es
hermética y que lo que verifica depende de la máquina. No falta cobertura funcional. Tampoco lo arregla ninguno de los
issues de hoy (docs/plan/issues 01 a 11).

## Por qué pasa

Los ejemplos de la documentación usan rutas reales del equipo del autor (`C:\dev\Vetworld`, `C:\dev`). La prueba
reproduce esos ejemplos al pie de la letra contra un servidor que lee el disco de verdad: `createInMemoryApp` no le da al
módulo de carpetas ninguna raíz controlada. Además, la ruta de `from-folder` es la misma que la de `POST /projects`, que
corre antes, así que aunque la carpeta exista nunca se llega al 201.

## Solución posible

Todo el cambio va en `tests/docs/postman-run.test.ts`. La colección no se toca: se genera a partir de las rutas y
cambiarla a mano rompería `tests/docs/api.test.ts:121-125` («el generador produce exactamente lo que hay en disco»).

1. Antes del bucle, crear una carpeta temporal (`mkdtemp(join(tmpdir(), 'orq-postman-'))`) y dentro de ella `Vetworld/`
   con `package.json` `{"scripts":{"check":"vitest run"}}` y un repo git con un commit. Se pueden reutilizar `tempDir`,
   `writeFiles`, `gitInitWithCommit` y `cleanupDirs` de `tests/core/f5-servidor/helpers.ts`. Borrarla en `afterAll`.
2. Sustituir la ruta solo en las peticiones que tocan el disco, con un mapa por `"<MÉTODO> <plantilla>"`:
   - `POST /projects/inspect` y `POST /projects/from-folder`: en `req.body.raw`, cambiar `C:\\dev\\Vetworld` por la ruta
     temporal escapada para JSON (`JSON.stringify(dir).slice(1, -1)`).
   - `GET /fs/list`: cambiar el valor de la consulta `C:\dev` por la carpeta temporal padre.
   - `POST /projects` mantiene `C:\dev\Vetworld`, porque el store no mira el disco. Así `from-folder` apunta a otra ruta,
     no hay `registeredAs` y el id sugerido pasa a ser `vetworld-2`, que está libre.
3. Añadir a la lista de la línea 94 `POST /projects/inspect → 200`, `POST /projects/from-folder → 201` y
   `GET /fs/list → 200`.

### Otras opciones

- Marcar en los `example` de `f5-servidor.ts` las rutas con una variable de Postman (por ejemplo `{{carpetaProyecto}}`,
  con `C:\dev\Vetworld` como valor en `collection.variable`) y rellenarla en la prueba con `vars`. Es más limpio para la
  prueba y sirve a quien use la colección en otro equipo, pero cambia los `example` del código y obliga a
  regenerar `docs/api` (la comprobación es `tests/docs/api.test.ts:268`, «cada {{variable}} de Postman está declarada»).
- Darle a `createInMemoryApp` una opción `fsEnv` o `fsRoot`. `fsEnv` por sí solo no basta: solo cambia la plataforma, el
  perfil y el entorno, no las lecturas del disco (folders.ts:145-148 y :376-379). `{ platform: 'win32' }` evitaría el 400
  fuera de Windows, pero seguiría leyendo `C:\dev\Vetworld` o respondiendo 404.
- Hay soluciones más baratas si solo se quiere hermeticidad, por ejemplo sacar estas tres peticiones del bucle y probarlas
  aparte con carpetas temporales. La propuesta de arriba no es la única. Tiene la ventaja de seguir ejecutando la
  colección completa y, además, exigir el éxito.

## Cómo probar que quedó resuelta

- Prueba automatizada: la misma `tests/docs/postman-run.test.ts`, con la carpeta temporal descrita. Debe afirmar que
  `POST /projects/inspect → 200`, `POST /projects/from-folder → 201` y `GET /fs/list → 200` están en `results`, y que
  ninguna respuesta contiene `C:\dev\Vetworld` salvo las de `/projects` y `/projects/:id`, que reflejan el `repoPath`
  registrado. Para comprobar que el aislamiento sirve: renombrar `C:\dev\Vetworld` en un equipo de prueba, o correr en un
  Windows sin esa carpeta, y ver que el resultado no cambia. Y si `from-folder` deja de responder 201, la prueba debe
  fallar.
- Comando (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/docs/postman-run.test.ts"` (o desde
  PowerShell en C:\dev\orquestador: `npx vitest run tests/docs/postman-run.test.ts`).
- Verificación manual: no aplica. Es una prueba; el servidor y la colección no cambian.
