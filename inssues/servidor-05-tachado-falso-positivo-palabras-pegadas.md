# El tachado genérico de claves corta palabras pegadas a «authorization», «bearer» o «apikey»: hay carpetas que no se pueden abrir ni registrar, y rutas que se guardan rotas

- **Área:** Servidor, API y contratos
- **Severidad:** media
- **Archivos:** `src/shared/redact.ts:13`, `src/core/server/routing.ts:102`, `src/core/store/store.ts:236`, `src/core/store/store.ts:335`, `src/core/store/store.ts:338`, `src/core/store/store.ts:417`, `src/core/server/ws.ts:46`, `src/core/server/ws.ts:53`, `src/core/app/f5-servidor.ts:229`, `src/ui/features/projects/AddProjectDialog.tsx:29`, `src/ui/features/projects/AddProjectDialog.tsx:33`, `src/ui/features/projects/AddProjectDialog.tsx:64`
- **Estado:** abierta

## Cómo ocurre

`redactSecrets` (`src/shared/redact.ts`) se aplica a casi todo lo que sale del núcleo o se guarda en él:

- `routing.ts:102` pasa cada respuesta JSON por `redactDeep`: `return c.json(redactDeep(result), …)`.
- `store.ts:236`, dentro de `sanitize`, tacha todas las cadenas antes de guardar proyectos (`store.ts:338`), tareas (`store.ts:417`), planes y eventos.
- `ws.ts:46` y `ws.ts:53` tachan cada mensaje que se manda por `/ws`.

El último patrón es el genérico, que tacha lo que va después de una palabra clave:

```ts
/(?<=(?:api[_-]?key|authorization|x-api-key|bearer)["']?\s*[:=]?\s*["']?(?:Bearer\s+)?)[A-Za-z0-9._~+/=-]{16,}/gi
```

Comillas, espacios, `:` y `=` son todos opcionales. Por eso, si la palabra clave va seguida directamente de 16 o más caracteres de `[A-Za-z0-9._~+/=-]`, esos caracteres se tratan como una clave. Probado con Node sobre el mismo patrón:

| Entrada | Salida actual |
|---|---|
| `C:\dev\authorization-service-backend` | `C:\dev\authorization[REDACTADO]` |
| `C:\dev\authorization-service-backend\app` | `C:\dev\authorization[REDACTADO]\app` |
| `ApiKeyManagementService` | `ApiKey[REDACTADO]` |
| `bearer-token-validation-lib` | `bearer[REDACTADO]` |
| `src/auth/authorization/token-validator.ts` | `src/auth/authorization[REDACTADO]` (la `/` está dentro de la clase de caracteres) |

Pasos y efectos que se ven:

1. **Agregar proyecto → explorador.** `GET /fs/list` devuelve `name` y `path` tachados para la carpeta `authorization-service-backend`. La interfaz entra con `browse(entry.path)` (`AddProjectDialog.tsx:64`). Pide entonces `/fs/list?path=C:\dev\authorization[REDACTADO]`, y `requireDir` responde 404. `run()` (`AddProjectDialog.tsx:29`) muestra un 404 como «Esta función todavía no está disponible en este núcleo», un mensaje que despista.
2. **Agregar proyecto → diálogo de Electron.** El diálogo da la ruta real a `POST /projects/inspect`, pero la respuesta sale tachada. `suggestedId` llega como `authorization[REDACTADO]`, y `folderInspectionSchema.parse` (`AddProjectDialog.tsx:33`, con `suggestedId: idSchema`) lanza un error de Zod. Cuando lo que dispara el tachado es una carpeta padre (por ejemplo `…\authorization-service-backend\app`, con id `app`), la inspección pasa, pero `inspection.path` llega tachado. «Agregar» manda esa ruta a `/projects/from-folder`, que devuelve 404.
3. **`POST /projects/from-folder` por la API con el id sugerido.** Si la carpeta tiene git, commits y gate, `folderWorktreesRoot` pone el id en `worktreesRoot` (`C:\dev\.worktrees\authorization-service-backend-orq`). La comprobación de `store.ts:335` rechaza el alta con 400: «la configuración de worktrees (workspace) no puede llevar claves». En modo local, `sanitize` (`store.ts:236-238`) rechaza el alta con 400: «un campo con forma de clave no se puede guardar (id, repoPath)». `cleanId` (`store.ts:339`) no llega a ejecutarse.
4. **Corrupción silenciosa.** Pasa cuando el id no dispara el tachado y la ruta sí: `POST /projects` (`app.ts:414`), o `from-folder` con la ruta `…\authorization-service-backend\app` o con un `id` propio. `store.ts:335` solo compara `workspace`. Luego `sanitize` guarda `repoPath` ya tachado y la segunda validación lo acepta (`repoPath: z.string().min(1)`). El proyecto queda apuntando a una carpeta que no existe.
5. **Tareas.** `putTask` → `sanitize` (`store.ts:417`) guarda `ownedPaths: ['src/auth/authorization/token-validator.ts']` como `src/auth/authorization[REDACTADO]`. En el commit, `outsideOwnedPaths` (`commit-step.ts:105`) ya no reconoce el archivo real como propio y la tarea falla con `OwnedPathsError`. Con `objective` y con los mensajes por `/ws` pasa lo mismo: nombres de clases o archivos llegan rotos al agente y a la interfaz.

Las pruebas de `tests/shared/contracts.test.ts:41-53` solo cubren los límites de palabra de los prefijos (`sk-`, `gh…`). Ningún caso negativo cubre el patrón genérico. Ningún commit de hoy toca `src/shared/redact.ts`: su último cambio es `c8749a9`.

## Por qué pasa

En `src/shared/redact.ts:13` no hace falta ningún separador entre la palabra clave y el valor (`["']?\s*[:=]?\s*["']?`). Además, la clase del valor incluye `-`, `.` y `/`, así que el patrón no distingue `authorization: <token>` de una palabra compuesta o de una ruta que empieza con esa palabra. El tachado se aplica sin distinguir campos (rutas, ids, nombres, texto libre). `sanitize` solo rechaza los casos en que el tachado deja el dato inválido; si el campo sigue siendo válido, guarda la versión rota sin avisar.

## Solución posible

Cambiar el patrón de `src/shared/redact.ts:13` para exigir al menos un separador, ya sea `:`/`=` (con comillas y espacios opcionales) o uno o más espacios:

```ts
/(?<=(?:api[_-]?key|authorization|x-api-key|bearer)(?:["']?\s*[:=]\s*["']?|["']?\s+)(?:Bearer\s+)?)[A-Za-z0-9._~+/=-]{16,}/gi
```

Probado con Node. Sigue tachando `Authorization: Bearer …`, `Authorization:Bearer …`, `api_key = "…"`, `{"apiKey":"…"}`, `{"openaiApiKey":"…"}`, `anthropicApiKey: …`, `x-api-key: …`, `Bearer …`, `--api-key …`, `authorization=…` y `OPENAI_API_KEY=…`. Deja intactos los cinco casos de la tabla.

**No** conviene añadir `(?<![A-Za-z0-9])` delante de la palabra clave, como sugería el reporte original. Probado: con ese límite, las claves en camelCase como `{"openaiApiKey":"…"}` o `anthropicApiKey: …` dejan de tacharse, porque «ApiKey» va pegado a una letra. Sin ese límite, el separador obligatorio basta para los falsos positivos de arriba.

### Otras opciones

- **Separador más estricto:** pedir `[:=]` para `api[_-]?key`, `authorization` y `x-api-key`, y aceptar el espacio solo después de `bearer` (el esquema HTTP). Así también deja de tacharse prosa como «authorization implementation-details», que con la propuesta sigue tachada. A cambio, se pierde `--api-key <valor>` en texto libre. Los argumentos de la CLI ya tienen su propia guardia en `cli-io.ts:25`.
- **No tachar los campos de ruta e id** (`repoPath`, `path`/`name` de `/fs/list` y `/projects/inspect`, `ownedPaths`), o tacharlos solo con los secretos explícitos (`extraSecrets`). Es más invasivo: hay que marcar esos campos en `redactDeep` y en `sanitize`, y el texto libre seguiría con el mismo problema.
- **Rechazar en vez de guardar roto:** en `sanitize`, cuando el tachado cambia un campo de ruta, devolver 400 con un mensaje claro en lugar de guardar la versión tachada. No arregla el falso positivo, pero evita la corrupción silenciosa del paso 4.

La propuesta del patrón es la de menor cambio, pero no es la única. Una solución más fina combinaría el separador obligatorio con un tratamiento distinto para los campos de ruta.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta:
  - En `tests/shared/contracts.test.ts`, junto a «límites de palabra (hallazgo de c2)», añadir dos casos:
    - Negativos: `C:\dev\authorization-service-backend`, `C:\dev\authorization-service-backend\app`, `ApiKeyManagementService`, `bearer-token-validation-lib` y `src/auth/authorization/token-validator.ts` deben quedar intactos.
    - Positivos: `Authorization: Bearer <24 caracteres>`, `api_key = "<…>"`, `{"apiKey":"<…>"}`, `{"openaiApiKey":"<…>"}`, `x-api-key: <…>`, `Bearer <…>` y `OPENAI_API_KEY=<…>` deben seguir sin contener el valor.
  - En `tests/core/f5-servidor/folders.test.ts`, crear una carpeta temporal `authorization-service-backend` (con una subcarpeta `app`) y comprobar tres cosas:
    - `GET /fs/list` sobre la carpeta padre devuelve `name` y `path` sin `[REDACTADO]`.
    - `GET /fs/list?path=<esa ruta>` responde 200.
    - `POST /projects/from-folder` sobre ambas responde 201 y el proyecto guardado tiene el `repoPath` real.
  - En las pruebas del store, un `putTask` con `ownedPaths: ['src/auth/authorization/token-validator.ts']` debe leerse igual con `getTask`.
- Comando para correrla (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/shared/contracts.test.ts tests/core/f5-servidor/folders.test.ts"` (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/shared/contracts.test.ts tests/core/f5-servidor/folders.test.ts`).
- Verificación manual en la app: crear `C:\dev\authorization-service-backend`. En «Agregar proyecto», entrar en ella desde el explorador y comprobar que se lista y se puede registrar con el id sugerido. Comprobar también que el proyecto aparece con su ruta real.
