# La tabla de fotos de cupo crece sin límite y `latestQuotas` recorre todo su índice en cada lectura

- **Área:** Datos y almacenamiento
- **Severidad:** baja
- **Archivos:** `src/core/store/store.ts:671`, `src/core/store/store.ts:681`, `src/core/store/store.ts:684`, `src/core/store/store.ts:691`, `src/core/store/schema.ts:77`, `src/core/store/schema.ts:87`, `src/core/main.ts:89`, `src/core/main.ts:109`, `src/core/config/config.ts:10`, `src/core/registry/quotas.ts:75`, `src/core/server/hub.ts:65`, `src/core/app/f5-chat.ts:111`, `src/core/conductor/session.ts:350`, `src/core/conductor/tools.ts:338`, `src/core/server/app.ts:363`, `src/core/usage-stats/summary.ts:405`
- **Estado:** resuelta

## Cómo ocurre
Mientras el núcleo está encendido, `main.ts` crea un `QuotaRefresher` cuyo `publish` es `hub.publishQuota`
(`src/core/main.ts:89-90`) y lo dispara con un `setInterval` cada `config.quotaRefreshMs` (`src/core/main.ts:109-116`).
El valor por defecto es 5 minutos (`src/core/config/config.ts:10`, `DEFAULT_QUOTA_REFRESH_MS = 5 * 60_000`). En
producción `compose.ts` siempre pasa `quotaProviderFactory`, así que el temporizador existe.

En cada vuelta, `QuotaRefresher.run` lee los agentes habilitados que tienen lector de cupo. Según
`src/core/app/quotas.ts`, eso incluye agy, Codex, OpenRouter y Claude cuando tiene presupuesto manual. Por cada foto,
`readOne` llama a `publish` (`src/core/registry/quotas.ts:75`). Un fallo del proveedor no corta el flujo: los
proveedores devuelven una foto `stale: true` con `error`, en lugar de lanzar una excepción (`src/core/quota/codex.ts:100`,
`src/core/quota/openrouter.ts:163`, `src/core/quota/manual-budget.ts:58`, `src/core/quota/agy.ts:142`). `hub.publishQuota`
(`src/core/server/hub.ts:65-66`) acaba en `recordQuota`, que siempre inserta una fila:

```ts
// src/core/store/store.ts:671-678
recordQuota(snapshot: QuotaSnapshot): QuotaRecord {
  ...
  this.stmt(
    'INSERT INTO quota_snapshots (agent_id, method, taken_at, stale, error, snapshot_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(...);
```

En el código del núcleo no hay ningún `DELETE FROM quota_snapshots`: los únicos `DELETE` del almacén afectan a
`agents` y `projects` (`store.ts:326`, `store.ts:369`). Tampoco hay una migración que purgue la tabla
(`schema.ts:77-87` y las v2 y v3 no la tocan). `deleteAgent` deja las fotos del agente borrado. `quotaHistory`
(`store.ts:691`) no tiene llamadores en `src/` (solo `tests/core/store/store.test.ts`). La única lectura real es la
última foto de cada agente.

Cada fila guarda el JSON completo de la foto. Con 4 buckets, como en agy, son del orden de 1 KB, además de las columnas
duplicadas. Con 3 agentes con lector y el núcleo encendido todo el día, son unas 860 filas diarias, más de 300.000 al año
y, a ese tamaño, unos cientos de MB. Las cifras crecen con cada agente con lector y con cada `POST /quotas/refresh`
(`src/core/server/app.ts:366-381`).

Para la lectura, `latestQuotas` usa una subconsulta de «último por grupo»:

```ts
// src/core/store/store.ts:683-685
`SELECT q.snapshot_json, q.recorded_at FROM quota_snapshots q
 JOIN (SELECT agent_id, MAX(id) AS id FROM quota_snapshots GROUP BY agent_id) m ON q.id = m.id
 ORDER BY q.agent_id`
```

Comprobé con `EXPLAIN QUERY PLAN` en una base en memoria con el mismo esquema (SQLite 3.46) que el plan es
`SCAN quota_snapshots USING COVERING INDEX quota_agent`. SQLite solo aplica la optimización de `MAX` por índice cuando
no hay `GROUP BY`, así que recorre todas las entradas del índice `quota_agent(agent_id, id)` (`schema.ts:87`). Esta
consulta se ejecuta, de forma síncrona en el hilo del núcleo (`DatabaseSync`), en estos casos:
- al montar el prompt de sistema de cada sesión de la mente: `f5-chat.ts:111`, con `quotas.all()`, que llega a `session.ts:350`;
- en cada llamada a la herramienta `cupos` de esa mente: `tools.ts:338` llama a `ports.quotas.all()`;
- en `GET /quotas` (`app.ts:363`), que la interfaz pide en `loadAll` (`src/ui/store/app.ts:60`);
- en el resumen de uso (`summary.ts:405`).

## Por qué pasa
`quota_snapshots` funciona como historial, pero no tiene ninguna política de retención, y casi todo lo que la lee solo
necesita la última fila de cada agente. Además, la consulta de «último por agente» se escribió con `GROUP BY ... MAX(id)`.
SQLite no la resuelve con un salto por cada agente (loose index scan), sino recorriendo todo el índice, así que su coste
crece con el historial.

## Solución posible
1. **Retención al insertar** (`src/core/store/store.ts`, `recordQuota`): dentro de `this.tx(...)`, después del `INSERT`,
   conservar solo las últimas K fotos del agente (por ejemplo `K = 288`, un día a 5 minutos):
   ```sql
   DELETE FROM quota_snapshots
    WHERE agent_id = ?
      AND id < (SELECT id FROM quota_snapshots WHERE agent_id = ? ORDER BY id DESC LIMIT 1 OFFSET 287)
   ```
   Si hay menos de K filas, la subconsulta devuelve `NULL` y no se borra nada. Con esto la tabla queda acotada a
   K × agentes, y el `SCAN` de `latestQuotas` también, aunque no se reescriba la consulta.
2. **Migración v4** (`src/core/store/schema.ts`, nueva entrada de `MIGRATIONS`) que purgue lo acumulado con la misma regla:
   ```sql
   DELETE FROM quota_snapshots WHERE id IN (
     SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY id DESC) AS rn FROM quota_snapshots)
     WHERE rn > 288);
   ```
   Hay que tener en cuenta que, sin `VACUUM`, el archivo no encoge; las páginas liberadas se reutilizan.
3. Opcional: si se quiere que `latestQuotas` haga `SEARCH` por agente, se puede reescribir con una subconsulta correlada,
   `q.id = (SELECT id FROM quota_snapshots WHERE agent_id = a.agent_id ORDER BY id DESC LIMIT 1)`, que según mi
   comprobación usa `SEARCH ... USING COVERING INDEX quota_agent (agent_id=?)`. Ojo con la fuente de `a`:
   - `SELECT DISTINCT agent_id FROM quota_snapshots` vuelve a hacer `SCAN`.
   - Sacarla de `agents` cambia el comportamiento, porque los agentes borrados con uso dejarían de mostrar su último cupo
     en el resumen (`summary.ts:426`). Hoy lo muestran porque `deleteAgent` no borra sus fotos.

### Otras opciones
La propuesta no es la única ni necesariamente la mejor:
- **Tabla `quota_latest`** con `agent_id` como clave primaria y un `INSERT ... ON CONFLICT(agent_id) DO UPDATE` en
  `recordQuota`. Así `latestQuotas` lee solo N filas, sin subconsultas. El historial puede seguir en `quota_snapshots`
  con retención, o eliminarse si nadie lo va a usar (`quotaHistory` no tiene llamadores).
- **No insertar fotos repetidas**: si la foto nueva es igual a la anterior salvo en `takenAt`, actualizar `taken_at` y
  `recorded_at` de la última fila en lugar de crear otra. Esto reduce mucho las filas de los agentes inactivos y las de
  las fotos `stale`, que se repiten.
- **Purga periódica o al arrancar** (por ejemplo junto a `recoverOrphans` en `fleet-service.ts:337`), por antigüedad
  (`recorded_at` de más de N días). La inserción queda más barata, pero entre arranques la tabla crece.
- Borrar las fotos de un agente en `deleteAgent`, si se decide que el resumen no debe mostrar el cupo de los agentes borrados.

## Cómo probar que quedó resuelta
- **Prueba automatizada propuesta:** en `tests/core/store/store.test.ts` (o en un archivo nuevo, `tests/core/store/quota-retention.test.ts`):
  1. Con un almacén en memoria, llamar 1.000 veces a `recordQuota` para `agy` y 10 para `codex`. Afirmar con
     `store.database` que `SELECT COUNT(*) FROM quota_snapshots WHERE agent_id = 'agy'` es como mucho K, que `codex`
     conserva sus 10 filas y que `latestQuotas()` devuelve exactamente la última foto de cada uno, en orden por `agent_id`.
  2. Abrir una base en archivo temporal con `user_version = 3` y 1.000 filas de un agente, abrir el `SqliteStore` para
     que corra la v4 y afirmar que quedan como mucho K filas y que `latestQuotas()` no cambió.
  3. Si se reescribe la consulta: afirmar que `EXPLAIN QUERY PLAN` de la nueva consulta contiene `SEARCH` sobre
     `quota_agent` y no contiene `SCAN quota_snapshots`. Afirmar también que la prueba existente
     «guarda fotos y devuelve la última por agente y el historial» (`store.test.ts:370`) sigue pasando.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/store/store.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/store/store.test.ts`).
- **Verificación manual:** con Berland abierto un buen rato, consultar `SELECT agent_id, COUNT(*) FROM quota_snapshots GROUP BY agent_id`
  sobre una copia de la base (no sobre la que está usando el núcleo). Las cuentas deben quedarse en K o menos, y el
  panel de cupos y el resumen de uso del perfil deben seguir mostrando la última lectura de cada agente.
