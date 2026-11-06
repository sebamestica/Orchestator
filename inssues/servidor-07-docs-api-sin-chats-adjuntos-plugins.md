# La documentación del API (OpenAPI y Postman) omite las 21 rutas de chats, adjuntos y plugins, y sus pruebas no pueden detectarlo

- **Área:** Servidor, API y contratos
- **Severidad:** baja
- **Archivos:** `docs/api/source.ts:39`, `docs/api/routes.ts:72`, `docs/api/routes.ts:160`, `docs/api/README.md:11`, `docs/api/README.md:14`, `docs/api/README.md:23`, `tests/docs/api.test.ts:382`, `tests/docs/api.test.ts:342`, `tests/docs/postman-run.test.ts:101`, `src/core/app/route-modules.ts:22`, `src/core/app/route-modules.ts:24`, `src/core/chat/routes.ts:88`, `src/core/plugins/routes.ts:65`, `src/core/plugins/routes.ts:103`, `src/core/server/app.ts:214`
- **Estado:** resuelta

## Cómo ocurre
`docs/api/` genera `openapi.json` y la colección de Postman a partir de la tabla de rutas de una app armada en memoria
(`createInMemoryApp`). El núcleo real arma sus rutas con `routeModulesFor(comp)`, que registra cinco módulos:

```ts
// src/core/app/route-modules.ts:18-29
f5Servidor,
(comp) => chatRouteModule(comp, { settings: ... }),   // c15-chat: chats, adjuntos, propuestas
pluginsRouteModule,                                    // c16-plugins: Chrome y Canva
usageRouteModule,
storageRouteModule,
```

La app de la documentación registra solo tres:

```ts
// docs/api/source.ts:39
const routeModules = [createF5ServerRoutes({ pickFolder: async () => null }), createUsageRoutes(), storage];
```

Quedan fuera de `openapi.json` y de la colección:

- 14 rutas de `/chats` (`src/core/chat/routes.ts:88-260`): `GET/POST /chats`, `GET/PATCH/DELETE /chats/:id`,
  `GET /chats/:id/target`, `POST /chats/:id/close`, `GET/POST /chats/:id/messages`, `POST /chats/:id/interrupt`,
  `GET /chats/:id/proposals`, `POST .../proposals/approve-all`, `POST .../proposals/:taskId/approve` y `.../reject`.
- 3 rutas de adjuntos (`src/core/chat/routes.ts:264-323`): `POST /attachments`, `POST /attachments/by-path` y
  `GET /attachments/:id`.
- 4 rutas de plugins (`src/core/plugins/routes.ts:65-120`): `GET /plugins`, `POST /plugins/:id/connect`,
  `POST /plugins/:id/disconnect` y `GET /plugins/canva/callback`, la única ruta del servidor que no pide token
  (`ctx.allowWithoutToken?.('get', CANVA_CALLBACK_PATH)`, línea 103).

Lo comprobé en el `openapi.json` actual: sus 41 `paths` no incluyen `/chats`, `/attachments` ni `/plugins`. La palabra
«plugin» solo aparece en la descripción de `/ws` y en el esquema de ese mensaje, que anuncia `chat`, `chat_message`,
`proposals` y `plugin` como mensajes del servidor (línea 7039). La documentación describe esos eventos, pero no las rutas
que los producen.

Mientras tanto, la documentación dice lo contrario:

- `docs/api/README.md:11`: `routes.ts` «tiene una entrada por cada ruta del servidor, y la generación falla si alguna
  sobra o falta».
- `docs/api/README.md:14`: «Si el servidor cambia, las pruebas de `tests/docs/` fallan hasta que se regenere».
- `docs/api/routes.ts:5`: «Si el servidor agrega o quita una ruta, la generación falla hasta actualizar `docExtras`».

Ninguna prueba lo detecta:

- `docRoutes()` (`docs/api/routes.ts:160-169`) compara `docExtras` con `serverRoutes()`, que sale de la misma app
  incompleta de `source.ts`.
- `tests/docs/api.test.ts:381-384` compara `openapi.json` con `serverRoutes()` y fija `expect(server.length).toBe(49)`.
  El servidor real tiene 70 rutas (49 + 17 + 4).
- `tests/docs/postman-run.test.ts:40` ejecuta la colección contra `createInMemoryApp`, la misma app.
- Ninguna prueba compara la documentación con `routeModulesFor(comp)`. Las pruebas que importan
  `ROUTE_MODULE_FACTORIES` (`tests/core/chat/f5-chat.test.ts:82`, `tests/core/usage-stats/summary.test.ts:281`) solo
  miran si la fábrica está en la lista.

El hueco ya se había visto y nadie lo cerró. El informe del issue 10 (`docs/plan/issues/10-modo-chat.md:113`) anota
«Las rutas `/chats` no están en la documentación generada». El del issue 11 (`docs/plan/issues/11-chrome-personal.md:125`)
dice que se regeneraron los JSON porque «cambia la descripción de `POST /plugins/:id/connect`», pero esa ruta no figura
en ningún JSON, así que regenerarlos no cambió nada.

Para verlo: importar `docs/api/orquestador.postman_collection.json` en Postman. No hay ninguna petición para crear un
chat, enviar un mensaje, subir un adjunto ni conectar Chrome o Canva, y la colección no avisa que faltan.

## Por qué pasa
`ChatService`, `AttachmentStore` y `PluginService` necesitan la composición (`Composition`: flota, planificador,
memoria, skills, bóveda y ajustes). `source.ts` arma la app sin composición y solo incluye los módulos que se pueden
construir sin ella (`docs/api/source.ts:7-9`). La prueba de cobertura compara contra esa misma lista recortada y no
contra lo que registra `routeModulesFor`, así que el hueco no se nota.

Hay además un detalle que el generador no sabe representar. La tabla `RouteSpec` no dice qué rutas son públicas.
`publicRoutes` es un `Set` local de `createApp` (`src/core/server/app.ts:214`) y no sale en `CoreApp.routes`
(`app.ts:781`). Por eso `tests/docs/api.test.ts:342-346` y `tests/docs/postman-run.test.ts:101-107` pueden afirmar que
todas las rutas exigen token y responden 401 sin él. Esas afirmaciones dejan de valer en cuanto se documenta
`GET /plugins/canva/callback`.

## Solución posible
1. **`docs/api/source.ts`:** armar la app con la composición en memoria, como ya hacen las pruebas
   (`tests/core/chat/f5-chat.test.ts:30-42`). Se llama a `compose({ store: new SqliteStore({ path: ':memory:' }),
   vault: new MemoryVault(), env: { ORQ_DATA_DIR: <tmp> }, detectors: [], memoryDir, skillsHubDir, routeModules: false })`
   y se pasa a `createApp`:
   - `createF5ServerRoutes({ pickFolder: async () => null })` (sin `uiDir`), `createUsageRoutes()` y `storage`, como
     hoy;
   - `chatRouteModule(comp, { settings: () => DEFAULT_SETTINGS })` y `pluginsRouteModule(comp)`.

   Así ningún adaptador ni diálogo real llega a ejecutarse. `close()` también debe cerrar la composición.
2. **`docs/api/routes.ts`:**
   - agregar 21 entradas en `docExtras` con respuestas de ejemplo (en `examples.ts`, validadas contra los esquemas de
     `src/shared`);
   - agregar las etiquetas `Chats`, `Adjuntos` y `Plugins` a `tags`;
   - agregar las variables `chatId`, `attachmentId` y `pluginId` a `collectionVariables`.

   `POST /attachments` lleva el cuerpo crudo (binario en Postman) y `GET /attachments/:id` responde bytes.
3. **Ruta pública:** exponer las rutas públicas en `CoreApp` (por ejemplo `publicRoutes: readonly string[]` junto a
   `routes`, en `src/core/server/app.ts`) o una marca `public?: true` en `RouteSpec`. Con eso, `docs/api/build.ts`
   escribe `security: []` en `GET /plugins/canva/callback`, y Postman le pone `auth: noauth`.
4. **Pruebas:**
   - `tests/docs/api.test.ts:382`: subir el número de rutas a 70;
   - `tests/docs/api.test.ts:342-346` y `tests/docs/postman-run.test.ts:101-107`: excluir las rutas públicas de la
     comprobación de token.

   Después, regenerar con `node docs/api/generate.ts`.

### Otras opciones
- **Mínima:** dejar los JSON como están y corregir `docs/api/README.md:11`, `docs/api/README.md:14` y
  `docs/api/routes.ts:5` para que digan que chats, adjuntos y plugins no se documentan. Es honesta pero deja a Postman
  sin la mitad del uso real del núcleo.
- **Más fiel:** que `source.ts` use directamente `routeModulesFor(comp)` sobre la composición en memoria, en vez de
  elegir los módulos a mano. Así un módulo nuevo en `ROUTE_MODULE_FACTORIES` entra solo a la documentación y a
  `docRoutes()`, y la prueba falla hasta que se documente. Hay que comprobar que `f5Servidor` y `storageRouteModule`
  no hagan nada pesado al armarse (`f5Servidor` solo sirve la interfaz estática si encuentra `uiDir`).
- **Solo cobertura:** una prueba que compare `routeModulesFor(compose(...))` con `docExtras` y deje una lista explícita
  de rutas excluidas con su motivo. Avisaría de rutas nuevas sin obligar a documentar todo ya.

La propuesta no es la única. La versión con `routeModulesFor` evita que el problema se repita con el próximo módulo de
rutas.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: `tests/docs/api-cobertura.test.ts`.
  - **Escenario:** arma `compose({ store en memoria, vault: new MemoryVault(), env: { ORQ_DATA_DIR: <tmp> },
    detectors: [], routeModules: false })` y `createApp({ ..., routeModules: routeModulesFor(comp) })`, y lee
    `core.routes`.
  - **Primera afirmación:** el conjunto `MÉTODO ruta` de esa tabla es igual al de `operations()` de `openapi.json` y al
    de las peticiones de la colección de Postman. Hoy falla: faltan 21 rutas, entre ellas `GET /chats`,
    `POST /attachments` y `GET /plugins/canva/callback`.
  - **Segunda afirmación:** `GET /plugins/canva/callback` figura en `openapi.json` con `security: []` y el resto de
    las operaciones hereda `bearerAuth`.
- Comando para correrla (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/docs/api-cobertura.test.ts tests/docs/api.test.ts tests/docs/postman-run.test.ts"`
  (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/docs/api-cobertura.test.ts tests/docs/api.test.ts tests/docs/postman-run.test.ts`).
- Verificación manual: `scripts/win.sh "node docs/api/generate.ts --check"` debe terminar sin diferencias.
  Después, importar la colección en Postman y comprobar dos cosas:
  - que aparecen las carpetas **Chats**, **Adjuntos** y **Plugins**;
  - que `GET /plugins` con el token del núcleo responde 200 con Chrome y Canva.
