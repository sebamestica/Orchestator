# El resumen de uso filtra por `day` sin un índice que empiece por esa columna y recorre toda la tabla `usage` en cada consulta

- **Área:** Datos y almacenamiento
- **Severidad:** baja
- **Archivos:** `src/core/usage-stats/summary.ts:318`, `src/core/usage-stats/summary.ts:327`, `src/core/usage-stats/summary.ts:208`, `src/core/usage-stats/summary.ts:210`, `src/core/store/schema.ts:75`, `src/core/store/store.ts:705`, `src/core/store/store.ts:627`
- **Estado:** resuelta

## Cómo ocurre
Cada evento `usage` que emiten los adaptadores (un `turn.completed` de Codex, cada resultado del SDK de Claude, cada paso de agy) se guarda como una fila en la tabla `usage` (`src/core/store/store.ts:568-584`). Ninguna parte del código borra filas de esa tabla, así que crece con todo el historial.

La sección «Uso» de Ajustes pide `GET /usage/summary?period=…` (`src/ui/features/settings/UsageSection.tsx:51`), que llega a `UsageStats.summary()`. Ese método llama a `#load` con el rango pedido (`summary.ts:208`), y `#load` ejecuta:

```sql
-- src/core/usage-stats/summary.ts:322-328
FROM usage u
LEFT JOIN events e ON e.id = u.event_id
LEFT JOIN sessions s ON s.id = u.session_id
WHERE u.day >= ? AND u.day <= ?
ORDER BY u.ts, u.id
```

Los índices de `usage` son `usage_agent_day(agent_id, day)` y `usage_session(session_id)` (`schema.ts:75-76`). Ninguno empieza por `day`. Las migraciones v2 y v3 no agregan otro índice (`schema.ts:89-97`), y el código nunca ejecuta `ANALYZE` ni `PRAGMA optimize` (no aparecen en `src/`). Sin `sqlite_stat1`, SQLite no usa skip-scan sobre `usage_agent_day`. Lo comprobé con `EXPLAIN QUERY PLAN` sobre una copia en memoria del esquema v1 (SQLite 3.46):

```
SCAN u
SEARCH e USING INTEGER PRIMARY KEY (rowid=?) LEFT-JOIN
SEARCH s USING INDEX sqlite_autoindex_sessions_1 (id=?) LEFT-JOIN
USE TEMP B-TREE FOR ORDER BY
```

Así que cada consulta del resumen lee todas las filas de `usage`, aunque el rango sea de un día. Las búsquedas en `events` y `sessions` y el `json_extract` del payload solo corren para las filas que pasan el `WHERE`, porque el filtro sobre `u` se evalúa en el bucle exterior. Lo que crece con el historial es el recorrido de `usage`, no el `json_extract`.

Además, `summary.ts:210` hace una segunda pasada completa cuando el rango pedido no cubre la semana y el mes:

```ts
const periodEntries = periodsFrom >= range.from && today <= range.to ? entries : this.#load(periodsFrom, today, fmt);
```

Eso pasa siempre con `period=today`, con `period=week` desde el día 8 del mes, con `period=month` (el valor por defecto) en los días 1 a 6 del mes, y con cualquier rango `from/to` que no llegue a hoy. En esos casos se recorre la tabla dos veces.

`GET /usage` (`src/core/server/app.ts:662`, que llama a `store.usageTotals`, `store.ts:627-641`) tiene el mismo problema cuando filtra por `from`/`to` sin `agentId`: `day >= ?` sin igualdad en `agent_id` tampoco usa el índice. `spentUsd` (`store.ts:665-667`) sí lo usa, porque filtra por `agent_id = ?`.

Pasos:
1. Usar Berland unos meses, hasta que `usage` tenga decenas de miles de filas.
2. Abrir Ajustes → Uso (o llamar a `GET /usage/summary?period=today`).
3. El tiempo de la consulta crece con el total de filas de `usage`, no con las del rango.

Hoy la tabla es pequeña y la sección solo se carga cuando se abre, así que el efecto actual es mínimo. El problema crece con el tiempo.

## Por qué pasa
`usage` no tiene ningún índice que empiece por `day` (ni por `ts`). El único que incluye `day` lo tiene en segunda posición, detrás de `agent_id` (`schema.ts:75`). Ni `#load` ni `usageTotals` fijan `agent_id`, y sin estadísticas de `ANALYZE` el planificador no puede saltar la primera columna, así que elige `SCAN u`.

## Solución posible
Agregar una migración v4 al final de `MIGRATIONS` en `src/core/store/schema.ts`:

```ts
// v4: índice por día para el resumen de uso y GET /usage con rango y sin agente.
`
CREATE INDEX usage_day ON usage(day);
`,
```

`migrate()` (`store.ts:705-714`) la aplica una sola vez dentro de una transacción. Con el índice, el plan de `#load` pasa a ser `SEARCH u USING INDEX usage_day (day>? AND day<?)`, y el `ORDER BY` solo ordena las filas del rango (con margen de ±2 días). Las pruebas del almacén comparan `schemaVersion()` con `MIGRATIONS.length` (`tests/core/store/store.test.ts:71`, `tests/core/store/project-workspace.test.ts:133`, `tests/core/store/task-detail.test.ts:117`), así que agregar la v4 no las rompe.

### Otras opciones
La propuesta no es la única, y puede haber una más optimizada:
- **Índice `usage(day, ts, id)`** en vez de `usage(day)`. El rango sigue resolviéndose por `day`, pero el `ORDER BY u.ts, u.id` todavía necesita un B-tree temporal, porque el rango cubre varios días. Ganaría poco frente a `usage(day)`.
- **Índice por `ts`** (`usage(ts)`) con un `WHERE` sobre `ts` en lugar de `day`. Así el `ORDER BY` vendría resuelto por el índice, sin B-tree temporal. Habría que traducir los días límite a instantes en la zona del almacén, y hoy `#load` ya trabaja con `day` y un margen.
- **Una sola pasada en `summary()`**. Cargar desde `minDay(range.from, periodsFrom)` hasta `maxDay(range.to, today)` una vez y repartir en memoria, en vez de llamar dos veces a `#load` (`summary.ts:208-210`). Esto reduce el costo con o sin índice.
- **Guardar `cache_write_tokens` como columna** de `usage` al insertar (`store.ts:568-584`). Se evitaría el `LEFT JOIN events` y el `json_extract` por fila del rango. Es un cambio mayor (migración con relleno desde `events`) y no ataca el recorrido completo, que es el problema principal.
- **`PRAGMA optimize` al cerrar el almacén** (`store.ts:291-294`). Ayuda al planificador en general, pero por sí solo no garantiza que use skip-scan. No sustituye el índice.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: en `tests/core/usage-stats/summary.test.ts` (o en un archivo nuevo `tests/core/usage-stats/summary-index.test.ts`), crear la app con `makeUsageApp()` de `tests/core/usage-stats/helpers.ts`. Ejecutar sobre `store.database` un `EXPLAIN QUERY PLAN` con el mismo SQL de `#load` (o extraer ese SQL a una constante exportada para no duplicarlo) y afirmar que alguna fila del plan contiene `SEARCH u USING INDEX usage_day` y ninguna contiene `SCAN u`. Opcionalmente, un caso equivalente para `usageTotals({ from, to })` sin `agentId`. En `tests/core/store/store.test.ts`, afirmar que un almacén creado con el esquema v3 (`MIGRATIONS[0..2]`) y luego abierto con `SqliteStore` queda con `schemaVersion() === MIGRATIONS.length` y con el índice `usage_day` en `sqlite_master`.
- Comando para correrla (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/usage-stats/summary.test.ts tests/core/store/store.test.ts"` (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/core/usage-stats/summary.test.ts tests/core/store/store.test.ts`).
- Verificación manual: abrir Ajustes → Uso y comprobar que los totales de hoy, semana y mes no cambian respecto de antes de la migración. Opcionalmente, sobre una copia del archivo SQLite del núcleo (nunca sobre el que usa el Berland en marcha), ejecutar `EXPLAIN QUERY PLAN` de la consulta de `#load` antes y después de abrirla con la versión nueva.
