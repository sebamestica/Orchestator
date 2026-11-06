# Un segundo `iniciar` con el puerto ocupado marca como fallidas las tareas del núcleo vivo, cancela sus sesiones y pasa sus chats a `idle` antes de fallar con EADDRINUSE

- **Área:** Servidor, API y contratos
- **Severidad:** alta
- **Archivos:** `src/core/server/server.ts:28`, `src/core/server/server.ts:38`, `src/core/server/app.ts:754`, `src/core/server/app.ts:776`, `src/core/app/f5-chat.ts:94`, `src/core/chat/service.ts:256`, `src/core/chat/db.ts:230`, `src/core/app/fleet-service.ts:238`, `src/core/app/fleet-service.ts:257`, `src/core/app/fleet-service.ts:336`, `src/core/app/compose.ts:121`, `src/core/app/cli-commands.ts:118`, `src/core/config/config.ts:32`, `src/core/store/store.ts:285`, `apps/desktop/src/lib/core-client.ts:66`, `apps/desktop/src/lib/shutdown-policy.ts:28`, `apps/desktop/src/core-supervisor.ts:272`
- **Estado:** abierta

## Cómo ocurre

Contexto. El núcleo de Berland guarda todo en una SQLite dentro de la carpeta de datos, que por defecto es
`%LOCALAPPDATA%\orquestador` para cualquier proceso que no defina `ORQ_DATA_DIR` (`src/core/config/config.ts:32-36`).
La base se abre en modo WAL, sin candado exclusivo (`src/core/store/store.ts:285-287`), así que dos procesos pueden
escribir en ella a la vez. La cola de la flota y los turnos de la mente viven solo en la memoria del proceso. Desde el
issue 3, al arrancar, el núcleo trata como «huérfano» todo lo que la base da por en curso y que su propia cola (vacía)
no conoce.

La app de escritorio se cuida: antes de lanzar un núcleo prueba `/health` y, si hay uno vivo o que no responde, no lanza
otro (`apps/desktop/src/core-supervisor.ts:151-159`). La orden `iniciar` del CLI no tiene esa guardia, y
`docs/api/README.md:105` la recomienda para abrir la interfaz web.

Pasos:

1. Berland está abierto. Su núcleo escucha en 127.0.0.1:47811 y tiene una tarea `running` (o la mente está en un turno).
2. En otra terminal se ejecuta `node src/core/app/cli.ts iniciar` sin `ORQ_DATA_DIR` propio. Puede hacerlo el usuario
   para abrir la interfaz web, o un agente de la flota que pruebe el núcleo: nada en el código le da otra carpeta de datos.
3. `compose()` abre la misma SQLite (`src/core/app/compose.ts:121`) y arma los ganchos reales de la flota
   (`compose.ts:198`, `tasks: opts.tasks ?? fleet.hooks()`) y los módulos de rutas (`compose.ts:238`).
4. `iniciar` llama a `startCore(comp.deps)` (`src/core/app/cli-commands.ts:118`), que llama a `startServer`
   (`src/core/main.ts:93`). `startServer` crea la app **antes** de escuchar:

   ```ts
   // src/core/server/server.ts:28 y :38
   const core = createApp({ ...opts, allowedHosts: () => loopbackHosts(port) });
   ...
   server.listen(opts.port, LOOPBACK_HOST, () => {
   ```

5. Dentro de `createApp` se registran los módulos de rutas (`src/core/server/app.ts:754-756`). El del chat construye
   `ChatService` (`src/core/app/f5-chat.ts:94`), y su constructor pasa a `idle` todos los chats `running` de la base:

   ```ts
   // src/core/chat/service.ts:256
   this.#repo.resetRunning(this.#iso());
   // src/core/chat/db.ts:231
   UPDATE chat_chats SET state = 'idle', updated_at = ? WHERE state = 'running'
   ```

6. Al final de `createApp` corre la recuperación (`src/core/server/app.ts:776`, `deps.tasks?.recover?.()` →
   `fleet-service.ts:336-337` → `recoverOrphans`). Como la cola de **este** proceso está vacía, toda tarea `ready`,
   `running`, `review` o `handed_off` de la base pasa a `failed`:

   ```ts
   // src/core/app/fleet-service.ts:241-243
   if (!ORPHAN_STATES.has(t.state) || this.queue.get(t.task.id)) continue;
   const saved = store.setTaskState(t.task.id, 'failed', undefined, { detail: INTERRUPTED_DETAIL });
   ```

   Y como esta flota no tiene nada en curso, cancela todas las sesiones abiertas de los agentes (salvo las de la mente):
   `store.cancelOpenSessions({ exceptAgents: [CONDUCTOR_AGENT_ID] })` (`fleet-service.ts:257-260`, `store.ts:520-526`).
7. Recién entonces `listen` falla con EADDRINUSE (`server.ts:35-42`), `startCore` cierra lo suyo y el CLI sale con error.
8. El núcleo vivo sigue trabajando, pero su base dice lo contrario. `GET /tasks` lee la base, no la cola
   (`src/core/server/app.ts:499-506`), así que el tablero muestra fallidas las tareas en curso («interrumpida al
   reiniciar el núcleo») y el panel muestra detenidos a los agentes. El segundo proceso publicó esos cambios en su propio
   hub, no en el del núcleo vivo, así que la interfaz no recibe ningún aviso y el error aparece al recargar. La fila queda
   mal hasta que el núcleo vivo la vuelva a escribir en la siguiente transición, que puede tardar decenas de minutos
   (`setTaskState` no valida transiciones, `store.ts:457-476`).
9. Si en ese intervalo se cierra la ventana de Berland, `runningTasks` cuenta tareas activas y chats `running` desde
   esa base (`apps/desktop/src/lib/core-client.ts:66-67`) y obtiene 0. `decideOnClose` decide apagar
   (`apps/desktop/src/lib/shutdown-policy.ts:28`) y `onAppClose` mata el árbol del núcleo con `taskkill /T /F`
   (`apps/desktop/src/core-supervisor.ts:272-277`, `:58-59`). Los agentes mueren a media tarea.

`node src/core/main.ts` no lo provoca, porque arranca sin ganchos de tareas ni módulos de rutas. La prueba que ya
existe para el puerto ocupado (`tests/core/server/main.test.ts:76-82`) usa otra `dbPath` y no pasa ganchos ni módulos,
así que no cubre estos efectos.

## Por qué pasa

Los efectos destructivos del arranque (recuperar tareas huérfanas, cerrar sesiones abiertas, reiniciar chats) se
ejecutan al **crear** la app, antes de reservar el puerto. «Huérfana» se decide con la cola vacía del proceso nuevo, sin
comprobar que ese proceso vaya a ser el núcleo. Además no hay candado de instancia única sobre la carpeta de datos: el
de Electron (`requestSingleInstanceLock`, `apps/desktop/src/main.ts:274`) solo protege la ventana, no al núcleo frente a
un `iniciar` lanzado a mano.

## Solución posible

Que ningún efecto sobre la base ocurra antes de saber que este proceso es el núcleo:

1. `src/core/server/app.ts`: sacar la llamada a `deps.tasks?.recover?.()` (líneas 774-779) de `createApp` y exponer en
   `CoreApp` una función `recover()` que la ejecute, con el mismo `try/catch` y el mismo registro.
2. `src/core/chat/service.ts`: quitar `this.#repo.resetRunning(...)` del constructor (línea 256) y moverlo a un método
   público `recover()`. Para no tocar el tipo `RouteModule`, el contexto del módulo (`RouteModuleContext`) puede recibir
   un `onStarted(fn)` que `createApp` acumula. `f5-chat.ts` registra ahí `() => service.recover()`.
3. `src/core/server/server.ts`: después de que `listen` resuelva (línea 42), llamar a `core.recover()`, que corre los
   `onStarted` y luego `tasks.recover`. Si `listen` falla, nada de eso corre.

Con eso, un segundo `iniciar` en el mismo puerto sale con EADDRINUSE sin tocar la base.

### Otras opciones

Esta propuesta no es la única, ni necesariamente la más completa:

- **Candado de instancia sobre la carpeta de datos** (más completo): al empezar `startCore` (o `compose`), crear
  `<dataDir>/core.lock` con `open(..., 'wx')` y el pid. Si ya existe y ese pid vive, abortar **antes** de abrir SQLite;
  si el pid no vive, se toma el candado. Se libera en `stop()`. Esto cubre además un segundo núcleo con **otro**
  `ORQ_PORT` y la misma base, que con la propuesta de arriba sí llegaría a escuchar y haría la recuperación igual. Lo
  ideal es combinar las dos cosas: el candado decide quién es el núcleo y el orden garantiza que no haya efectos antes.
- **Probar `/health` antes de componer** en `iniciar` (como ya hace `core-supervisor.ts:151`): es barato, pero solo cubre
  el mismo puerto y deja una carrera entre la prueba y `listen`.
- **Dar a los workers de la flota un `ORQ_DATA_DIR` propio** (temporal por tarea): evita que un agente que prueba Berland
  pise la base real, pero no protege del caso del usuario en una terminal.
- **Escuchar primero y crear la app después** (un `fetch` que delegue en la app una vez creada): también sirve, pero
  obliga a manejar peticiones que lleguen antes de que la app exista. Mover los efectos a después de `listen` es más
  simple.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta: `tests/core/server/segundo-nucleo.test.ts`.
  - Arma: una carpeta temporal con un `SqliteStore` propio. En la base, un proyecto y una tarea guardada como `running`
    (`store.putProject`, `store.putTask(brief, 'running')`), una sesión abierta de un agente que no sea la mente
    (`store.startSession`) y un chat con `state = 'running'` (con `ChatDb` sobre `store.database`). Un `net.Server` ocupa
    un puerto libre P en 127.0.0.1.
  - Ejecuta: `compose({ store, vault: new MemoryVault(), env: { ORQ_DATA_DIR: dir }, config: { port: P }, detectors: [] })`
    y `startCore(comp.deps)`.
  - Afirma: la promesa se rechaza con `/EADDRINUSE/`. Además `store.getTask(id).state` sigue en `'running'` (sin
    `detail` «interrumpida…»), `store.getSession(sid).state` sigue abierta y el chat sigue `running`.
  - Caso de control: con el puerto libre, el mismo arranque sí deja la tarea `failed` con «interrumpida al reiniciar el
    núcleo», la sesión `cancelled` y el chat `idle`. Así se ve que la recuperación se movió y no se perdió.
  - Si se agrega el candado de instancia: un segundo `startCore` con la misma carpeta de datos y **otro** puerto libre
    también debe rechazarse sin tocar la base.
- Comando (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/server/segundo-nucleo.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/server/segundo-nucleo.test.ts`).
- Verificación manual: con Berland abierto y una tarea en curso, anotar el estado en el tablero. En otra terminal,
  ejecutar `node src/core/app/cli.ts iniciar` (debe fallar con el puerto ocupado). Recargar la interfaz: la tarea debe
  seguir en curso, el agente activo en el panel y, al cerrar la ventana, Berland debe decir que hay trabajo en curso y
  no apagar el núcleo.
