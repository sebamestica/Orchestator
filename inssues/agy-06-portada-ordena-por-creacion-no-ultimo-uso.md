# La portada ordena «Retoma donde quedaste» por la fecha de alta del proyecto y la muestra como si fuera el último uso

- **Área:** Interfaz
- **Severidad:** baja
- **Archivos:** `src/ui/features/home/HomeView.tsx:8-13`, `src/ui/features/home/HomeView.tsx:19`, `src/ui/features/home/HomeView.tsx:24`, `src/ui/features/home/HomeView.tsx:39`, `src/core/store/store.ts:65-72`, `src/core/store/store.ts:351-354`, `src/core/store/schema.ts:13-18`, `src/core/server/schemas.ts:129`
- **Estado:** abierta
- **Origen:** revisión de agy, verificada por Claude

## Cómo ocurre
La portada (`#/`) se titula «Retoma donde quedaste» (`HomeView.tsx:24`) y debajo de las tarjetas lista hasta seis proyectos, cada uno con una leyenda de tiempo a la derecha. Tanto el orden como la leyenda salen de `createdAt`, que es la fecha en que la carpeta se registró en Berland:

- `HomeView.tsx:19`: `const recent = [...projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6);`
- `HomeView.tsx:39`: `{lastUsed(p.createdAt)}`
- `HomeView.tsx:8-13`: la función se llama `lastUsed` y devuelve «Hoy», «Ayer» o «Hace N días» contados desde la fecha que recibe, así que la intención era mostrar el último uso.

El proyecto no guarda ninguna otra fecha. `ProjectRecord` solo tiene `createdAt` (`store.ts:65-72`), la tabla `projects` no tiene columna de uso (`schema.ts:13-18`) y `putProject` conserva la fecha original al actualizar (`store.ts:351`: `const createdAt = existing?.createdAt ?? this.iso();`, y el `ON CONFLICT` de `store.ts:354` no toca `created_at`). La interfaz usa ese mismo contrato (`schemas.ts:129`, a través de `src/ui/api/types.ts:9`).

Pasos:
1. Registrar el proyecto «A» hace una semana.
2. Registrar el proyecto «B» ayer y no volver a abrirlo.
3. Hoy, trabajar en «A»: chatear con la mente o hacer tareas.
4. Volver a `#/`.
5. «B» aparece antes que «A», y «A» dice «Hace 7 días» aunque se usó hace minutos.

Con más de seis proyectos es peor: por el `.slice(0, 6)`, un proyecto antiguo que se usa todos los días puede no salir en la lista. Se puede seguir abriendo desde la barra lateral, y por eso la severidad es baja: la portada engaña, pero no se pierde nada.

## Por qué pasa
Al hacer la portada se usó el único dato de fecha que trae el proyecto. Berland no registra cuándo se usó un proyecto por última vez, ni en el núcleo ni en la interfaz.

## Solución posible
Calcular la última actividad de cada proyecto en la interfaz, sin cambiar el núcleo:
- Tareas: ya están en el store global (`useApp((s) => s.tasks)`). Cada `TaskRecord` trae `task.projectId`, `updatedAt` y `lastEventAt`.
- Chats: `GET /chats` sin `projectId` devuelve todos, de más reciente a más antiguo (`src/core/chat/routes.ts:91-100`), cada uno con `projectId` y `updatedAt`.
- Para cada proyecto, tomar la fecha mayor entre `createdAt`, sus tareas y sus chats. Ordenar `recent` por esa fecha y pasársela a `lastUsed`.

### Otras opciones
La propuesta de arriba no es la única, y puede haber una más optimizada:
- **Columna en el núcleo:** agregar `last_used_at` a `projects` con una migración y actualizarla al crear o tocar un chat o una tarea del proyecto, o al abrir `#/p/:id`. Así la fecha queda en `ProjectRecord`, la portada no pide `/chats` y otras vistas pueden reutilizarla. Exige migración y cambiar el contrato `projectRecordSchema`.
- **Campo calculado en `GET /projects`:** que el núcleo devuelva `lastActivityAt`, sacado con un `MAX(updated_at)` de chats y tareas por proyecto. No hay que guardar nada nuevo, pero la consulta es algo más cara.
- **Solo la etiqueta:** si no se quiere cambiar el orden, escribir «Agregado hace N días» en vez de «Hace N días» y cambiar el título de la lista. Es lo más barato, pero no cumple lo que promete «Retoma donde quedaste».
- De paso, `lastUsed` cuenta tramos de 24 horas (`HomeView.tsx:9`), no días de calendario: algo usado anoche a las 23:00 dice «Hoy» a las 9:00. Se podría usar el `formatRelativeTime` que ya existe (`src/ui/features/board/types.ts:19`).

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: `tests/ui/home/HomeView.test.tsx` (happy-dom, con `fakeCore` y `resetStore` de `tests/ui/settings/helpers.ts`, que ya usa `tests/ui/settings/storage.test.tsx`). Escenario: proyecto «A» creado hace 7 días con un chat o una tarea actualizados hace 5 minutos, y proyecto «B» creado ayer sin actividad. Se afirma que en la lista «A» aparece antes que «B», que la fila de «A» dice «Hoy» y que la de «B» dice «Ayer». Un segundo caso, con 7 proyectos donde el más antiguo es el único con actividad reciente, afirma que ese proyecto sí sale en la lista.
- Comando (WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/home/HomeView.test.tsx"`; PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/home/HomeView.test.tsx`.
- Verificación manual en la app: abrir un proyecto antiguo, mandar un mensaje a la mente o crear una tarea y volver a `#/`. Ese proyecto debe quedar primero en «Retoma donde quedaste» y decir «Hoy».
