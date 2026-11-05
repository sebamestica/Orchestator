# Issue 13 — Ajustes › Almacenamiento: cuánto ocupa Berland en disco y vaciarlo

Estado: hecho · Commit: uno solo, a nombre del usuario y sin trailers
`src/core/chat/conversations.ts` (carpetas internas de las conversaciones sin proyecto; otro agente lo cablea en
paralelo: aquí solo se usa para medir y vaciar)

## Problema
- El usuario no sabe cuánto espacio en disco usa Berland ni tiene cómo liberarlo. «Memoria» aquí es espacio en disco,
  no la memoria de Obsidian (que ya tiene su sección «Memoria»). Ajustes tiene General, Mente, Agentes, Proyectos,
  Memoria, Skills y Uso (`SettingsView.tsx:17-25`, `routes.ts:2`): ninguna habla de almacenamiento.
- **Lo que pesa** (los proyectos y sus worktrees no cuentan: son carpetas del usuario):
  - **Adjuntos subidos:** cada imagen pegada o archivo soltado se copia en `<dataDir>/attachments/<id>-<nombre>`
    (`attachments.ts:147-160`, carpeta en `f5-chat.ts:90`), hasta 20 MB cada uno, con su fila en `chat_attachments`
    (`db.ts:38-47`). Los registrados por ruta (`source: 'path'`) son archivos del usuario y no se copian.
  - **Chats:** `chat_chats`, `chat_messages`, `chat_proposals` (`db.ts:11-59`) y `chat_targets` (`target.ts:14`).
    Cada chat escribe además sus eventos en `events` y su sesión (y las de sus subagentes, hijas por
    `parent_session_id`) en `sessions` (`schema.ts:37-59`), y su gasto en `usage` (`schema.ts:61-74`).
  - **Carpetas de conversaciones:** `conversationsRoot(dataDir)` = `<padre de dataDir>/berland-conversaciones/<chatId>`
    (`conversations.ts:8-10`), donde la mente trabaja en los chats sin proyecto.
  - **La base SQLite** (`orquestador.db` con `-wal` y `-shm`, modo WAL en `store.ts:287`): nunca se compacta, así que
    lo borrado deja páginas libres y el archivo no baja.
- **Hay restos que nadie limpia:** `DELETE /chats/:id` (`service.ts:345-366`, `db.ts:234-240`) borra mensajes,
  propuestas, destino y las copias de adjuntos que solo usaba ese chat, pero deja sus eventos y sesiones en la base y
  su carpeta de conversación en el disco. Un adjunto subido que nunca se envió queda para siempre.

## Qué se quiere
Un apartado **«Almacenamiento»** en Ajustes que diga cuánto ocupan las imágenes y archivos subidos, los chats, las
carpetas de conversaciones y la base, con un botón «Vaciar» por categoría, para controlar el espacio que usa Berland.

## Diseño
- **Núcleo (módulo nuevo):** `src/core/storage-stats/**` + `src/core/app/f5-almacenamiento.ts` + una línea en
  `route-modules.ts`. Contratos nuevos en `src/shared/api.ts` (solo esquemas nuevos, sección «Almacenamiento»).
- **Rutas** (etiqueta «Almacenamiento»):
  - `GET /storage`: bytes y cantidad por categoría y el total;
  - `POST /storage/attachments/clean` `{ scope: 'orphans' | 'all' }`;
  - `POST /storage/chats/clean` `{ scope: 'leftovers' | 'older' | 'all', olderThanDays?, compact? }`;
  - `POST /storage/conversations/clean` `{ scope: 'orphans' }`;
  - `POST /storage/compact` (checkpoint del WAL + `VACUUM`).

  Cada acción responde `{ result, storage }`: lo borrado, los bytes liberados (medidos antes y después), lo omitido
  con su motivo y el resumen nuevo.
- **Medición:**
  - adjuntos y carpetas, recorriendo el disco con `lstat` (nunca sigue enlaces ni junctions);
  - tablas, con `dbstat` (páginas reales por tabla e índice). Para la parte de los chats dentro de tablas compartidas
    (`events`, `sessions`) se reparte en proporción a los bytes de sus filas. Sin `dbstat`, se estima por la suma de
    los largos;
  - la base: tamaño de `orquestador.db`, `-wal` y `-shm`, páginas libres (`freelist_count × page_size`) y «otros
    datos» (tareas de la flota, uso, ajustes), que se informan pero no se vacían desde aquí.
- **Vaciado:**
  - **Adjuntos «sin usar»:** copias subidas que ningún mensaje usa (de chats borrados o nunca enviadas) y archivos
    sueltos de la carpeta sin registro. **«Todo»:** todas las copias subidas.
    - Nunca los registrados por ruta.
    - Nunca los de un chat que está respondiendo o con subagentes vivos.
    - Nunca los subidos hace menos de 1 h sin enviar (pueden estar en el compositor).
  - **Chats «todos» o «de más de N días»** (por `updatedAt`): cada uno se borra con la propia ruta
    `DELETE /chats/:id`, llamada dentro del proceso con el token de la petición. Así se cierra la sesión viva, se
    difunde `chat_deleted` y se borran mensajes, propuestas, destino y adjuntos propios igual que siempre. Después se
    borran sus eventos y sesiones (y los de sus subagentes) y su carpeta de conversación.
    - Se omiten los `running` y los que tienen subagentes vivos (`backgroundTasks`, leído de `GET /chats`).
    - Se conservan las filas de `usage` y los eventos `usage` a los que apuntan: el historial de «Uso y gasto» no
      cambia.
    - Al final se compacta la base (por defecto), para que el espacio se libere de verdad.
  - **Restos de chats ya borrados:** mensajes, propuestas, destinos, eventos y sesiones `chat-…` sin chat.
  - **Carpetas de conversaciones sin chat:** hijas directas de `conversationsRoot` con nombre de id, cuyo chat ya no
    existe y que no se tocaron en la última hora.
  - **Compactar:** `PRAGMA wal_checkpoint(TRUNCATE)` → `VACUUM` → checkpoint. Sin transacción abierta. Si falla
    (base ocupada), se informa como aviso y no rompe la acción.
- **Seguridad del borrado:**
  - solo se borra dentro de `<dataDir>/attachments` y de `conversationsRoot`, comprobado con la ruta nominal y con
    `realpath`;
  - nada que sea, contenga o esté dentro de un proyecto (`repoPath`), de su raíz de worktrees, de la bóveda
    (`vault.json`), de la base (`-wal`, `-shm`) o de la memoria de Obsidian;
  - nada que contenga la carpeta de datos;
  - los enlaces y junctions se quitan como enlace, sin entrar en ellos;
  - la configuración (`settings_kv`) y las demás tablas no se tocan.
- **Interfaz:** `src/ui/features/settings/StorageSection.tsx`, en Ajustes › Almacenamiento (`#/ajustes/almacenamiento`):
  - el total arriba;
  - una tarjeta por categoría, con su tamaño legible (B, KB, MB, GB en español) y su detalle;
  - un botón «Vaciar» por acción, con un diálogo que dice exactamente qué se borra, qué se conserva y que no se puede
    deshacer;
  - tema claro y oscuro con los tokens de las otras secciones.

## Rutas propias
`src/core/storage-stats/**`, `src/core/app/f5-almacenamiento.ts`, una línea en `src/core/app/route-modules.ts`,
`src/shared/api.ts` (solo los esquemas nuevos), `src/ui/features/settings/StorageSection.tsx`, la entrada en
`src/ui/features/settings/SettingsView.tsx`, la sección en `src/ui/app/routes.ts`, `tests/core/storage-stats/**`,
`tests/ui/settings/storage*.test.tsx`, `docs/api/**` (regenerada; el módulo se suma a `source.ts` y sus ejemplos a
`routes.ts` y `examples.ts`) y el número de rutas en `tests/docs/api.test.ts`. No se tocan `src/core/chat/**`,
`src/core/app/f5-chat.ts`, `src/core/conductor/**` ni `src/ui/features/chat/**`.

## Criterios de aceptación
1. `GET /storage` cuadra con el disco: bytes y cantidad de los adjuntos subidos (imágenes y otros), de las carpetas
   de conversaciones y de la base (`.db` + `-wal` + `-shm`). Los chats salen con mensajes, eventos y sesiones, y el
   total es la suma de adjuntos, carpetas y base.
2. Vaciar adjuntos, chats o carpetas libera espacio: el archivo o la carpeta desaparece y `freedBytes` > 0. Tras
   borrar chats y compactar, la base mide menos.
3. Ninguna acción toca un proyecto, su raíz de worktrees, la bóveda, la base ni la memoria. Tampoco sigue un enlace
   o junction fuera de las carpetas de Berland.
4. Los chats `running` o con subagentes vivos no se borran (salen en `skipped`), ni sus adjuntos.
5. Se conserva el historial de uso: las filas de `usage` siguen y «Uso y gasto» da lo mismo.
6. La interfaz pide confirmación con lo que se borra y que no se puede deshacer. Solo al confirmar llama a la ruta y
   muestra lo liberado. Se ve en tema claro y oscuro.
7. `npm run -s check` en verde.

## Decisiones (c34, 2026-11-05)
- **Nombre:** «Almacenamiento» (`#/ajustes/almacenamiento`), para no confundirlo con «Memoria» (Obsidian).
- **Reutilizar `DELETE /chats/:id` sin tocar el módulo del chat:** el `ChatService` vive dentro de `f5-chat.ts`
  (otra tarea). Por eso el módulo llama a `GET /chats` y `DELETE /chats/:id` dentro del proceso
  (`ctx.app.request`), con el mismo token y Host de la petición, y el token no sale del proceso.
  - Propuesto: exponer el servicio con `ChatWiring.onReady` en la línea del chat de `route-modules.ts` y pasar un
    `StorageChatsPort` directo.
  - Sin el módulo del chat (p. ej. la app de la documentación), borrar chats da 501. Lo demás funciona con la base.
- **Uso:** las filas de `usage` y sus eventos se conservan siempre: pesan poco y son la factura.
- **Gracia de 1 h** para adjuntos sin enviar, archivos sueltos y carpetas sin chat: pueden ser de un chat que se está
  creando.
- **Bytes de los chats:** estimación proporcional sobre `dbstat` («aprox.» en la interfaz). Los bytes liberados se
  miden en disco antes y después.
- **Compactar tras borrar chats:** por defecto sí (`compact: true`). `VACUUM` bloquea el núcleo unos segundos con
  una base grande, y solo corre a pedido del usuario.
