# El tablero ordena cada columna por fecha de creación y, pasadas 100 tareas, esconde las más nuevas

- **Área:** Interfaz: tablero, panel, ajustes
- **Severidad:** baja
- **Archivos:** `src/ui/features/board/BoardView.tsx:16`, `src/ui/features/board/BoardView.tsx:144-147`, `src/ui/features/board/BoardView.tsx:189-193`, `src/ui/store/app.ts:76-79`, `src/ui/store/app.ts:90`, `src/core/store/store.ts:443-451`, `src/ui/api/tasks.ts:17-22`
- **Estado:** abierta

## Cómo ocurre
El tablero (`BoardView`) arma siete columnas (`BOARD_COLUMNS` en `src/ui/features/board/types.ts:9-17`) a partir de
las tareas del store de zustand. Las tareas no se borran nunca: en el núcleo no hay ningún `DELETE FROM tasks`, así que
«Integrada», «Fallida» y «Cancelada» solo crecen con el uso.

1. El núcleo entrega `GET /tasks` en orden de creación ascendente (`src/core/store/store.ts:450`):
   ```ts
   const sql = `SELECT ${TASK_COLUMNS} FROM tasks ${...} ORDER BY created_at, rowid`;
   ```
2. La interfaz guarda ese orden en un objeto indexado por id (`src/ui/store/app.ts:76-79`,
   `Object.fromEntries(r.tasks.map(...))`). Cuando llega una tarea por `/ws` (`app.ts:90`,
   `{ ...s.tasks, [message.task.task.id]: message.task }`), una tarea que ya existía conserva su lugar y una nueva se
   agrega al final. Un cambio de estado no mueve la tarea. El orden sigue siendo el de creación.
3. `BoardView` copia `Object.values(rawTasks)` (`BoardView.tsx:25` y `34`), filtra por columna y corta sin ordenar
   (`BoardView.tsx:144-147`):
   ```ts
   const columnTasks = filteredTasks.filter((t) => taskMatchesColumn(t, col));
   const count = columnTasks.length;
   const visibleTasks = columnTasks.slice(0, MAX_TASKS_PER_COLUMN); // 100, línea 16
   const hiddenCount = count - visibleTasks.length;
   ```
4. Lo que se recorta aparece solo como texto (`BoardView.tsx:189-193`), en un `<div>` que no se puede pulsar:
   ```tsx
   <div className="text-center text-[11px] text-muted py-1.5">+{hiddenCount} tareas más</div>
   ```

Pasos para que pase: con más de 100 tareas en «Fallida» (o en «Integrada» o «Cancelada»), una tarea creada después
de esas 100 falla. Queda dentro de «+N tareas más»: no se ve en el tablero y su tarjeta, que tiene el botón de
reintentar (`TaskCard.tsx`, que usa `retryTask`), tampoco se puede abrir. Con menos de 100 todo se ve, pero lo último
queda al fondo de cada columna, debajo de lo más viejo.

Matiz: el orden es por **creación**, no por el momento del último cambio. Una tarea creada hace tiempo que falla hoy
sigue a la vista si entra entre las 100 primeras, aunque al fondo. Lo que se esconde son las tareas creadas más
recientemente en esa columna.

No hay guardia ni prueba que lo evite: `tests/ui/board/board.test.tsx` no prueba ni el orden ni el tope, y ningún
issue de `docs/plan/issues` (1 a 13) toca este recorte.

## Por qué pasa
Ninguna capa ordena por actividad. El núcleo ordena por `created_at` ascendente, el store conserva ese orden y
`BoardView` corta con `slice(0, 100)`, que se queda con las 100 más antiguas de cada columna. Ya existe
`lastActivity()` (`src/ui/api/tasks.ts:17-22`), que da la hora más reciente entre `updatedAt` y `lastEventAt`, pero
solo `TaskCard` lo usa para mostrar la hora. No se usa para ordenar.

## Solución posible
En `src/ui/features/board/BoardView.tsx`, ordenar `columnTasks` de forma descendente por `lastActivity` antes de
cortar:

```ts
import { lastActivity } from '../../api/tasks.ts';
// ...
const columnTasks = filteredTasks
  .filter((t) => taskMatchesColumn(t, col))
  .sort((a, b) => Date.parse(lastActivity(b)) - Date.parse(lastActivity(a)));
```

Para no ordenar en cada render, conviene agrupar y ordenar las columnas una sola vez dentro de un `useMemo` sobre
`filteredTasks`. Así arriba queda lo último que se movió y el recorte se lleva lo más viejo.

### Otras opciones
- Orden mixto: ascendente (FIFO) en las columnas activas («Pendiente», «Lista», «En curso», «Revisión»), donde
  importa qué va primero en la cola, y descendente en las terminales («Integrada», «Fallida», «Cancelada»), donde
  importa lo reciente. Puede leerse mejor que un orden único descendente.
- Convertir «+N tareas más» en un botón que muestre el resto (o que pagine de a 100). Así nada queda inaccesible,
  sea cual sea el orden.
- Pedir al núcleo `ORDER BY updated_at DESC` (o un `limit` por estado). Ayuda en la carga inicial, pero no alcanza
  solo: las actualizaciones de `/ws` no reordenan el objeto del store, así que la interfaz igual tiene que ordenar.
- Una solución más completa juntaría el orden por actividad con el botón «ver más», o con virtualizar la lista para
  quitar el tope de 100. La propuesta de arriba es la más chica, no la única.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: un caso nuevo en `tests/ui/board/board.test.tsx` (o un archivo nuevo
  `tests/ui/board/board-order.test.tsx`) que use el `makeTask` del archivo existente y `useApp.setState` para cargar
  101 tareas `integrated` con `createdAt`/`updatedAt` crecientes. Debe afirmar que, dentro de
  `within(screen.getByRole('region', { name: 'Columna Integrada' }))`, aparece el título de la tarea más nueva, no
  aparece el de la más vieja y se ve «+1 tareas más». Un segundo caso: dos tareas `failed`, donde la creada antes
  tiene `updatedAt` posterior. Debe afirmar que esa tarjeta queda primera en la columna «Fallida».
- Comando para correrla (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/board/board.test.tsx"`
  (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/board/board.test.tsx`).
- Verificación manual en la app: con un proyecto que tenga varias tareas integradas, mover una tarea vieja de estado
  (por ejemplo reintentar una fallida que vuelva a fallar) y comprobar que sube al principio de su columna. Con más de
  100 en una columna, la más reciente debe verse arriba.
