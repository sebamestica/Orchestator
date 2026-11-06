# Dos procesos que abren la base a la vez pueden aplicar la misma migración, y el segundo no arranca

- **Área:** Datos y almacenamiento
- **Severidad:** baja
- **Archivos:** `src/core/store/store.ts:704`, `src/core/store/store.ts:705`, `src/core/store/store.ts:709`, `src/core/store/store.ts:763`, `src/core/store/store.ts:286`, `src/core/store/store.ts:297`, `src/core/store/schema.ts:5`, `src/core/store/schema.ts:91`, `src/core/store/schema.ts:95`, `src/core/config/config.ts:46`
- **Estado:** abierta

## Cómo ocurre

Contexto: todos los procesos del núcleo abren el mismo archivo SQLite. La ruta por defecto es
`%LOCALAPPDATA%\orquestador\orquestador.db` (`src/core/config/config.ts:35-36` y `:46`) y no depende del checkout.
Lo abren dos caminos, cada uno con su propio `SqliteStore`: `startCore` (`src/core/main.ts:79`) y `compose`
(`src/core/app/compose.ts:121`), que usa cada orden del CLI (`src/core/app/cli.ts:25`, `:43`). El núcleo que lanza
Electron es `cli.ts iniciar` (`apps/desktop/src/core-supervisor.ts:188`, `:208`), y una orden como `cli.ts agentes`
en una terminal es otro proceso aparte. `app.requestSingleInstanceLock()` (`apps/desktop/src/main.ts:274`) solo
impide abrir dos ventanas de Electron. No pone ningún candado sobre la base.

El constructor migra en cuanto abre la base (`store.ts:285-288`), y `migrate()` decide qué aplicar **antes** de
tomar el candado de escritura:

```ts
// src/core/store/store.ts:704-714
private migrate(): void {
  const version = this.schemaVersion();          // PRAGMA user_version, fuera de toda transacción
  for (let v = version; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v];
    if (!sql) continue;
    this.tx(() => {                              // BEGIN IMMEDIATE (store.ts:764)
      this.db.exec(sql);                         // no vuelve a leer user_version
      this.db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}
```

Y las migraciones no se pueden repetir:

```sql
-- schema.ts:5   (v1)
CREATE TABLE agents (            -- sin IF NOT EXISTS
-- schema.ts:91  (v2)
ALTER TABLE projects ADD COLUMN workspace_json TEXT;
-- schema.ts:95  (v3)
ALTER TABLE tasks ADD COLUMN detail TEXT;
```

Pasos:

1. La base es nueva (primera instalación) o el código trae una migración nueva (por ejemplo una v4) y la base sigue en
   la versión anterior.
2. Dos procesos abren el `SqliteStore` casi a la vez. Por ejemplo, Electron lanza el núcleo (`iniciar`) y al mismo
   tiempo se corre una orden del CLI.
3. A y B leen `PRAGMA user_version` = N (`store.ts:705` → `:298`). En WAL (`store.ts:287`) una lectura no espera a un
   escritor y ve la última versión confirmada. Por eso B lee N aunque A ya esté dentro de su `BEGIN IMMEDIATE`.
4. A entra en `BEGIN IMMEDIATE`, aplica la N+1, sube `user_version` y hace `COMMIT`.
5. B esperaba el candado (`busy_timeout = 5000`, `store.ts:286`). Cuando lo obtiene, ejecuta el mismo SQL y falla con
   «table agents already exists» (v1) o «duplicate column name» (v2/v3). `tx` hace `ROLLBACK` y vuelve a lanzar el
   error (`store.ts:769-771`).
6. El constructor de B lanza. Si B es el núcleo, termina antes de imprimir la línea `ready`, y la ventana muestra «El
   núcleo terminó (código …) antes de anunciar que estaba listo» (`apps/desktop/src/lib/ready-line.ts:174`). Si B es el
   CLI, la orden sale con código 1. Al volver a abrirlo funciona, porque la versión ya está al día. El fallo es
   transitorio y no se pierden datos, de ahí la severidad baja.

Ninguna prueba cubre este caso. `tests/core/store/store.test.ts:69-85`, `project-workspace.test.ts:128-133` y
`task-detail.test.ts:104-117` solo migran desde un único proceso. Ninguno de los issues 1 a 12 de hoy (`docs/plan/issues`)
toca `store.ts` ni `schema.ts`.

Hay además un problema aparte. `migrate()` no hace nada si `user_version > MIGRATIONS.length`: el bucle no se ejecuta y
no avisa. Como la base por defecto la comparten todos los checkouts (`config.ts:46`), un worktree con una migración nueva
puede subir la versión de la base compartida. Después, el núcleo de `main`, que es más viejo, trabaja sobre un esquema
que no conoce y no dice nada. Los demás módulos que usan `store.database` (`src/core/chat/db.ts:12`,
`src/core/plugins/state.ts:36`, `src/core/settings/store.ts:63`, `src/core/usage-stats/rates.ts:31`) ya usan
`CREATE TABLE IF NOT EXISTS` y no tienen este problema.

## Por qué pasa

`migrate()` lee la versión fuera del candado de escritura y luego actúa con ella. Lee en `store.ts:705` y escribe dentro
de `tx` en `store.ts:709`. Dentro de la transacción no vuelve a comprobar si otro proceso ya aplicó esa migración, y el
SQL de `MIGRATIONS` falla si se ejecuta dos veces (`CREATE TABLE` sin `IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN`).
Tampoco hay ninguna comprobación de que la versión de la base no sea más nueva que el código.

## Solución posible

En `src/core/store/store.ts`, cambiar `migrate()` para que lea la versión **dentro** del candado de escritura:

```ts
private migrate(): void {
  if (this.schemaVersion() >= MIGRATIONS.length) return this.assertNotNewer(); // camino rápido sin candado
  this.tx(() => {
    const version = this.schemaVersion();           // releída con el candado tomado (BEGIN IMMEDIATE)
    if (version > MIGRATIONS.length) throw newerSchema(version);
    for (let v = version; v < MIGRATIONS.length; v++) {
      const sql = MIGRATIONS[v];
      if (sql) this.db.exec(sql);
      this.db.exec(`PRAGMA user_version = ${v + 1}`);
    }
  });
}
```

- Con `BEGIN IMMEDIATE`, el segundo proceso espera a que el primero confirme. Al releer ve la versión nueva y no hace
  nada.
- `assertNotNewer`/`newerSchema` lanzan un `StoreError` claro si `user_version > MIGRATIONS.length`, por ejemplo
  «La base (esquema v4) es de una versión más nueva de Berland que este código (v3); actualiza o usa ORQ_DATA_DIR».
- Hacer todo en una sola transacción también evita que la base quede con algunas migraciones aplicadas y otras no.

### Otras opciones

- Mantener una transacción por migración, pero releer `PRAGMA user_version` dentro de cada `tx` y saltar la migración si
  ya es `≥ v + 1`. Es el cambio mínimo sobre el código actual.
- Hacer cada migración idempotente: `CREATE TABLE/INDEX IF NOT EXISTS`, y para `ADD COLUMN` consultar antes
  `pragma_table_info('tabla')`. Así se protege también ante una base reparada a mano. El inconveniente es que obliga a
  escribir así cada migración futura y es fácil olvidarlo, así que conviene combinarlo con la relectura bajo candado,
  no reemplazarla.
- Que solo el núcleo migre y que el CLI se niegue a abrir una base desactualizada. Esto cambia el contrato del CLI y es
  más invasivo.

La propuesta no es la única. La relectura dentro de `BEGIN IMMEDIATE` es la más pequeña y cubre el problema de raíz.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta: `tests/core/store/migrate-concurrente.test.ts`.
  - **Carrera:** un script hijo (`node`) abre `new SqliteStore({ path })`, imprime `schemaVersion()` y cierra. La prueba
    lanza dos hijos con `child_process.spawn` sobre el mismo archivo nuevo de un directorio temporal. Los hijos esperan
    una barrera (por ejemplo, que aparezca un archivo `go` que la prueba crea cuando los dos avisan que están listos) y
    luego abren la base. Se repite 30-50 veces con un archivo nuevo cada vez. Se afirma que los dos hijos salen con
    código 0 y que ambos imprimen `MIGRATIONS.length`. Para que sea determinista sin depender del azar, se puede abrir
    en la prueba un `DatabaseSync` que haga `BEGIN IMMEDIATE` y aplique a mano `MIGRATIONS[0]`, mientras otro
    `SqliteStore` ya leyó la versión. Para eso hace falta inyectar un gancho, o probar directamente la función de
    migración extraída sobre dos conexiones.
  - **Más nueva:** se crea la base con `SqliteStore` y se cierra. Luego se abre con `DatabaseSync`, se ejecuta
    `PRAGMA user_version = 99` y se cierra. Al reabrir con `new SqliteStore({ path })` debe lanzar `StoreError` con el
    mensaje de «versión más nueva».
  - Las pruebas actuales (`store.test.ts:69-85`, `project-workspace.test.ts:128-133`, `task-detail.test.ts:104-117`)
    deben seguir pasando: migran desde v0, v1 y v2.
- Comando (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/store/migrate-concurrente.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/store/migrate-concurrente.test.ts`).
- Verificación manual: con `ORQ_DATA_DIR` apuntando a una carpeta vacía, abrir Berland y ejecutar al mismo tiempo
  `node src/core/app/cli.ts agentes` con la misma `ORQ_DATA_DIR`. Ninguno de los dos debe fallar con «already exists».
