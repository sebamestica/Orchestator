# Al reconectar `/ws`, el Tablero y el panel de agentes se quedan con las tareas, agentes y cupos de antes del corte

- **Área:** Interfaz
- **Severidad:** media
- **Archivos:** `src/ui/app/App.tsx:53-57`, `src/ui/store/app.ts:51`, `src/ui/store/app.ts:54-67`, `src/ui/store/app.ts:81-101`, `src/ui/api/live.ts:98-101`, `src/ui/api/live.ts:112-119`, `src/core/server/ws.ts:48-49`, `src/ui/features/chat/use-chat-live.ts:54-58`, `src/ui/features/chat/target-line.ts:97-99`, `src/ui/features/agents-panel/AgentsPanel.tsx:23`, `src/ui/features/agents-panel/AgentsPanel.tsx:61-68`, `src/ui/features/agents-panel/AgentsPanel.tsx:30-39`, `src/ui/features/agents-panel/model.ts:91-95`, `src/ui/store/app.ts:98-99`, `src/core/server/hub.ts:71-73`, `src/ui/features/board/BoardView.tsx:18-39`, `src/ui/features/board/TaskCard.tsx:22`, `src/ui/features/board/TaskCard.tsx:129`
- **Estado:** abierta
- **Origen:** revisión de agy, verificada por Claude
- **Fusiona:** `ui-resto-03-reconexion-ws-no-recarga-estado.md` (revisión de la interfaz: tablero, panel, ajustes), que
  describía el mismo fallo y agregaba cómo se ve en el Tablero y en el panel. Ese archivo se borró; lo que aportaba está
  en «Cómo se ve en el Tablero y en el panel» y en las pruebas.

## Cómo ocurre
El estado global de la interfaz (`useApp`) se carga una sola vez por HTTP y después solo se actualiza con
los mensajes sueltos de `/ws`. Si el socket se cae y vuelve, nada pide de nuevo la foto completa, así que
lo que cambió mientras estaba cerrado no llega nunca.

1. Al arrancar, `useBootstrap` carga todo y recién después abre el socket (`src/ui/app/App.tsx:53-57`):
   ```ts
   await loadAll();
   setCore('ready');
   const live = startLive(core);
   const offStatus = live.onStatus(setLive);
   const offMsg = live.subscribe(applyLive);
   ```
2. El listener de estado es `setLive`, que solo guarda la etiqueta (`src/ui/store/app.ts:51`:
   `setLive: (live) => set({ live })`). No vuelve a llamar a `loadAll`, `refreshTasks` ni `refreshAgents`, y
   tampoco pide los cupos ni los ajustes.
3. `LiveConnection` se reconecta sola con espera creciente (`src/ui/api/live.ts:112-119`) y avisa `open` al
   volver (`src/ui/api/live.ts:98-101`). La barra lateral muestra «Reconectando…» y después «Conectado en vivo».
4. El núcleo, al aceptar una conexión, manda `hello` y se suscribe al hub desde ese momento
   (`src/core/server/ws.ts:48-49`). No manda la foto actual, así que los `task`, `agent`, `agent_deleted`,
   `quota` y `settings` publicados durante el corte se pierden para esa ventana.
5. `applyLive` solo mezcla mensajes de a uno (`src/ui/store/app.ts:81-101`). Una tarea que pasó de `running`
   a `review`/`integrated`/`failed` durante el corte ya no recibe otro mensaje y sigue «En curso» en el Tablero
   hasta que se recarga la ventana. Lo mismo pasa con un agente borrado o con un cupo que se agotó o se renovó.
6. El panel derecho toma la lista de tareas activas del mismo estado viejo
   (`src/ui/features/agents-panel/AgentsPanel.tsx:23`) y con eso decide qué sesiones consultar al reconectar
   (`AgentsPanel.tsx:61-68`). Si una tarea arrancó durante el corte, el panel no consulta sus sesiones hasta
   que llegue un evento nuevo de ella.

### Cómo se ve en el Tablero y en el panel (aporte de ui-resto-03)
Ejemplo: durante el corte, una tarea pasa de `running` a `failed`.
- El hub la difunde con `publishTask` (`src/core/server/hub.ts:71-73`), pero ese socket ya no está suscrito y el hub
  no guarda nada para quien llegue después. Al reconectar, `applyLive` recibe `hello` y cae en el `default` sin hacer
  nada (`src/ui/store/app.ts:98-99`).
- **Tablero:** `BoardView` lee `useApp.tasks` y no pide `/tasks` al montarse (`BoardView.tsx:18-39`). La tarjeta sigue
  en «En curso» (`board/types.ts:12`). El botón «Reintentar» solo aparece con `task.state === 'failed'`
  (`TaskCard.tsx:22` y `TaskCard.tsx:129`), así que no se ve.
- **Panel de agentes:** cuando cambia `connection`, el panel vacía sus vistas (`setViews({})`, `AgentsPanel.tsx:30-39`).
  Después consulta sesiones solo de las tareas que el estado viejo marca como `running`/`review` (`AgentsPanel.tsx:23`)
  y mezcla solo las sesiones activas. La sesión de la tarea fallida ya no está activa, así que el agente queda sin vista
  y `busy` da falso. `workerRow` toma la tarea vieja (`model.ts:91`:
  `const task = busy ? linked ?? assigned[0] : assigned[0] ?? linked;`), que sigue en `running`. `failed` da falso
  (`model.ts:94`) y la fila muestra «Libre · Disponible» en vez de «Detenido» con el motivo (`model.ts:95`).
- Todo sigue así hasta que alguna acción llame a `refreshTasks` (reintentar, crear una tarea a mano) o se recargue la
  ventana.

Las otras vistas sí se resincronizan: el chat pide `replay` y recarga al volver a `open`
(`src/ui/features/chat/use-chat-live.ts:54-58`), y la línea de destino recarga en el mismo caso
(`src/ui/features/chat/target-line.ts:97-99`). El único que no lo hace es el estado global.

Corrijo a agy en dos puntos:
- El socket va a `127.0.0.1`, así que desenchufar el cable no lo corta. Reiniciar el núcleo tampoco sirve como
  ejemplo, porque cada arranque genera un token nuevo (`src/core/main.ts:92`) y la ventana vieja ya no puede
  reconectar. Lo que sí lo provoca es cualquier cierre del socket con el mismo núcleo vivo (el sistema operativo o
  Chromium cerrando la conexión, por ejemplo al volver de una suspensión).
- Hay además una ventana de pérdida en **cada** arranque, sin corte de por medio. Entre que se arman las
  respuestas de `GET /tasks`, `/agents` y `/quotas` (`src/ui/store/app.ts:56-63`) y que el servidor suscribe el
  socket (`ws.ts:49`), cualquier mensaje publicado se pierde, y el socket recién se abre después de `loadAll`. Esto
  pasa justo cuando hay actividad, porque el núcleo sigue vivo al cerrar la ventana si hay trabajo en curso
  (`apps/desktop/src/lib/shutdown-policy.ts:25-26`) y Berland lo adopta al reabrirse
  (`apps/desktop/src/core-supervisor.ts:162-169`).

## Por qué pasa
El estado global depende de dos fuentes, la foto HTTP y el flujo `/ws`, y no las vuelve a cuadrar cuando el
flujo se corta o arranca. El contrato del núcleo no repite el estado al conectar (`ws.ts:17-20` solo ofrece
`replay` de eventos por sesión), así que el cliente tiene que pedir la foto de nuevo por su cuenta. `useApp` nunca
lo hace.

## Solución posible
Resincronizar el estado global cada vez que el socket pasa a `open`, incluida la primera vez para cerrar la
ventana del arranque:

- En `useBootstrap` (`App.tsx:56`), cambiar `live.onStatus(setLive)` por un listener que llame a `setLive(status)`
  y, si `status === 'open'`, a `void loadAll().catch(() => undefined)` (o a una acción nueva `resync()` del store
  que pida `/tasks`, `/agents`, `/quotas` y `/settings`).
- Para que una foto HTTP vieja no pise un mensaje vivo más nuevo que llegó mientras la petición estaba en vuelo,
  mezclar por registro en vez de reemplazar el mapa entero: conservar el registro actual cuando su `updatedAt`
  sea mayor que el de la foto (tareas y agentes tienen `updatedAt`, `src/core/server/schemas.ts`). Hoy
  `refreshTasks` y `refreshAgents` reemplazan todo (`app.ts:72-79`).
- Agrupar las resincronizaciones si hay varias reconexiones seguidas (una en vuelo a la vez).

### Otras opciones
La propuesta no es la única y puede haber una más optimizada:
- Que el núcleo mande una foto (`snapshot` con tareas, agentes, cupos y ajustes) justo después de `hello`
  (`ws.ts:48`). Así el cliente no necesita peticiones extra y se cierra la carrera entre la foto y la suscripción,
  si el servidor se suscribe al hub antes de armar la foto.
- Manejar `case 'hello'` en `applyLive` llamando a `loadAll()` con antirrebote. Funciona igual que escuchar `open`,
  pero deja la recarga dentro del store.
- Numerar los mensajes del hub y que el cliente pida «lo que publicaste desde N», como ya hace `replay` con los
  eventos de sesión. Es más preciso, pero obliga a guardar un historial de mensajes de estado.
- Abrir el socket antes de `loadAll` y encolar los mensajes hasta que llegue la foto. Eso cierra la ventana del
  arranque, pero no resuelve las reconexiones.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: `tests/ui/store/app-live.test.ts`. Usa un `LiveConnection` con un `make` falso
  que devuelve un socket controlable y simula `onopen` → `onclose` → `onopen`. Con `api.get` simulado, `/tasks`
  devuelve la tarea `t1` en `running` en la primera carga y en `integrated` en la segunda. Afirma que, tras la
  segunda apertura, `useApp.getState().tasks.t1.state === 'integrated'` sin ningún mensaje `task` de por medio, y
  que se pidieron otra vez `/agents`, `/quotas` y `/settings`. Repetir con `/tasks` devolviendo `failed` en la segunda
  carga. Agrega un segundo caso: un mensaje `task` con `updatedAt` más nuevo llega mientras la petición está en vuelo,
  y la foto vieja no lo pisa. Opcional, en `tests/ui/agents-panel/AgentsPanel.test.tsx`: con la tarea en `failed` en el
  store tras resincronizar, la fila del agente dice «Detenido».
- Comando (WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/store/app-live.test.ts"`; PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/store/app-live.test.ts`.
- Verificación manual en la app: abrir la interfaz en el navegador con «Abrir en el navegador» y lanzar una tarea.
  En DevTools › Network › WS, ubicar `/ws` y cortarlo, por ejemplo con «Offline» o bloqueando la URL y forzando el
  cierre. Mientras la barra dice «Reconectando…», dejar que la tarea termine (o cambiarla de estado desde la CLI
  del núcleo). Al volver a «Conectado en vivo», la tarjeta del Tablero y el panel de agentes tienen que mostrar el
  estado nuevo sin recargar la ventana. Si la tarea falló, la tarjeta pasa a «Fallida» con «Reintentar» y el panel
  muestra «Detenido».
