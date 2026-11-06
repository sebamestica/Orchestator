# La fila «Mente» del panel solo ve los chats de la vista de chat abierta: en el Tablero siempre dice «Libre»

- **Área:** Interfaz: tablero, panel, ajustes
- **Severidad:** media
- **Archivos:** `src/ui/features/agents-panel/AgentsPanel.tsx:15`, `src/ui/features/agents-panel/AgentsPanel.tsx:18`, `src/ui/features/agents-panel/AgentsPanel.tsx:34`, `src/ui/features/agents-panel/AgentsPanel.tsx:69`, `src/ui/features/agents-panel/AgentsPanel.tsx:83`, `src/ui/features/agents-panel/model.ts:65`, `src/ui/features/agents-panel/model.ts:79`, `src/ui/features/chat/ChatView.tsx:92`, `src/ui/features/chat/store.ts:255`, `src/ui/features/chat/store.ts:274`, `src/ui/features/chat/store.ts:481`, `src/ui/app/App.tsx:105`
- **Estado:** resuelta

## Cómo ocurre

El panel derecho («Agentes», `AgentsPanel`) se monta en `App.tsx` en las rutas de chat de proyecto, de Conversaciones y también en el Tablero:

```tsx
// src/ui/app/App.tsx:105
const showPanel = panelOpen && (route.name === 'project' || route.name === 'standalone' || route.name === 'board');
```

Su primera fila, «Mente», dice si la mente está pensando o trabajando en segundo plano. Según el diseño del issue 4 (`docs/plan/issues/04-panel-derecho.md:37`): «Muestra el chat que está pensando. Si hay varios, primero el del chat abierto». Pero el panel no tiene una lista de chats propia. Usa la del store de la vista de chat (`useChat`):

```tsx
// src/ui/features/agents-panel/AgentsPanel.tsx:15-18
const chats = useChat((s) => s.chats);
const opened = useChat((s) => s.chat);
const events = useChat((s) => s.events);
const chat = selectChat(chats, opened);
```

Esa lista tiene dos límites:

1. **Se vacía al salir del chat.** `ChatView` llama a `reset()` cuando se desmonta (`ChatView.tsx:92`: `useEffect(() => () => useChat.getState().reset(), []);`), y `reset()` vuelve al estado inicial: `chats: []`, `chat: null`, `projectId: null` (`store.ts:255-258` y `INITIAL` en `store.ts:175-191`).
2. **Solo trae los chats de la carpeta abierta.** `open` pide los chats del proyecto y además los filtra: `chats = r.chats.filter((c) => c.projectId === projectId)` (`store.ts:274-275`). Los mensajes `chat` de `/ws` que el panel reenvía al store (`AgentsPanel.tsx:34`) pasan por `applyLive`, que descarta los de otro proyecto: `if (chat.projectId !== s.projectId) return;` (`store.ts:481`).

El núcleo sí difunde todos los cambios de estado de cualquier chat (`hub.publish({ type: 'chat', ... })` en `src/core/chat/service.ts:591` y `:598`), y desde el issue 7 la mente sigue trabajando aunque nadie mire el chat. La interfaz los descarta.

Pasos:

1. En el chat del proyecto A, manda un pedido (en bypass, por ejemplo, donde la mente hace la tarea ella misma). La fila «Mente» dice «Pensando».
2. Pasa al Tablero. `ChatView` se desmonta y llama a `reset()`. `AgentsPanel` sigue montado, porque `showPanel` vale también para `board`.
3. `selectChat([], null)` devuelve `undefined` (`model.ts:65-70`). Con `chat` indefinido, `mindRow` cae en el último caso: `status: ... : 'Libre'` y `line: 'Lista para ayudarte'` (`model.ts:79-80`). La fila dice «Libre · Lista para ayudarte» mientras la mente sigue pensando.
4. Los mensajes `chat` siguientes del proyecto A (por ejemplo, cuando termina el turno o quedan tareas en segundo plano) también se pierden: tras `reset()`, `s.projectId` vale `null` y `store.ts:481` descarta todo chat con `projectId: 'A'`. Solo entran las Conversaciones sin proyecto (`projectId: null`). Así, en el Tablero, una Conversación activa sí aparece y un chat de proyecto nunca.
5. Como la fila no tiene `chat`, tampoco se piden la sesión de la mente ni sus hijas (`AgentsPanel.tsx:69-76` exige `chat`).

Dentro del chat de A pasa lo mismo en menor escala: la lista solo tiene chats de A. Un chat del proyecto B que está pensando, o una Conversación con `backgroundTasks > 0`, no aparece en la fila «Mente» aunque no haya nada activo en A.

La prueba actual no cubre esto: `tests/ui/agents-panel/AgentsPanel.test.tsx` usa siempre chats con `projectId: null` y el store recién reseteado (también con `projectId: null`), así que el filtro de `store.ts:481` nunca los descarta.

## Por qué pasa

El panel lee el estado de la vista de chat, que es de una sola vista: está filtrado por la carpeta abierta y se vacía al salir. No es una lista global de chats activos. El reenvío de `AgentsPanel.tsx:34` a `useChat.applyLive` no lo arregla, porque ese `applyLive` aplica el filtro por proyecto de la vista.

## Solución posible

Darle al panel su propia lista de chats, independiente de `useChat`:

- En `src/ui/features/agents-panel/AgentsPanel.tsx`, al montar y cada vez que `connection` vuelve a `'open'`, pedir `GET /chats` sin `projectId`. Según `src/core/chat/routes.ts:94-100`, sin el parámetro devuelve todos los chats (`service.list(undefined)`), con su estado en vivo (`service.ts:282-283`, `#withLive`).
- Guardar esa lista en estado local del panel (o en un selector propio en `model.ts`). Actualizarla con todos los mensajes `chat` (upsert por `id`, sin filtrar por proyecto) y `chat_deleted` (quitarlo) en la misma suscripción de `AgentsPanel.tsx:33-38`, en lugar de reenviarlos a `useChat.applyLive`. Ese reenvío sobra: dentro del chat ya lo hace `useChatLive` (`use-chat-live.ts:50-51`).
- Calcular `selectChat(lista, opened)` sobre esa lista, con `opened = useChat((s) => s.chat)` para que el chat abierto siga teniendo prioridad (la regla de `model.ts:65-70` no cambia).
- `events` de `useChat` solo sirve para el chat abierto. Para otro chat, la línea de acción ya sale de `views`, que el panel llena con todos los `event` de `/ws` (`AgentsPanel.tsx:35-36`) y con las consultas de `AgentsPanel.tsx:69-76`, que ahora sí se dispararán porque habrá `chat`.

### Otras opciones

- **Llevar los chats activos a `useApp`** (`src/ui/store/app.ts`, en su `applyLive`, con un caso `chat`/`chat_deleted` y la carga inicial en `loadAll`). Así cualquier vista (panel, barra lateral, portada) tendría el estado de los chats sin depender de `ChatView`. Es más limpio si otras vistas lo van a necesitar, pero toca el store global.
- **Una ruta del núcleo solo para chats activos** (`GET /chats?active=1`, con `state === 'running'` o `backgroundTasks > 0`). Así no se baja la lista completa cuando hay muchos chats. Es la opción más eficiente, pero cambia el contrato (`src/shared/api.ts`, `chatsQuery`) y la documentación del API.
- **No vaciar `chats` en `reset()`.** Es la más corta, pero no resuelve el filtro por proyecto (`store.ts:275` y `:481`) y mezcla la responsabilidad de la vista con la del panel.

La propuesta no es la única. La de `useApp` o la de la ruta filtrada pueden ser mejores si la lista de chats crece.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:** en `tests/ui/agents-panel/AgentsPanel.test.tsx`, cambiar `fetchMock` para que responda según la URL (`/chats` → `{ chats: [...] }`, `/sessions...` → `{ sessions }`) y añadir:
  1. «en el Tablero ve el chat de un proyecto que piensa»: `useChat.getState().reset()` (como al salir del chat), `/chats` devuelve `chat({ projectId: 'A', state: 'running' })`; tras `render(<AgentsPanel />)`, la fila «Mente» dice «Pensando». Luego `send({ type: 'chat', chat: chat({ projectId: 'A', state: 'idle' }) })` → «Libre».
  2. «al desmontar el chat no se pierde el estado»: con `useChat.setState({ projectId: 'A', activeId: 'chat01', chat: chat({ projectId: 'A' }), chats: [chat({ projectId: 'A' })] })` y `/chats` con el mismo chat en `running`, renderizar, llamar a `act(() => useChat.getState().reset())` y afirmar que la fila sigue en «Pensando».
  3. «ve una Conversación en segundo plano desde un chat de proyecto»: store abierto en el proyecto A con su chat en `idle` y `send({ type: 'chat', chat: chat({ id: 'conv01', projectId: null, state: 'idle', backgroundTasks: 1 }) })` → «Trabajando en segundo plano».
  4. Que la prioridad del chat abierto se mantiene: dos chats en `running` en la lista y uno de ellos abierto en `useChat` → la fila usa el abierto (ya está en «prioriza el chat abierto entre los que piensan», pero ahora con la lista del panel).
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/agents-panel/AgentsPanel.test.tsx"` (o en PowerShell, en `C:\dev\orquestador`: `npx vitest run tests/ui/agents-panel/AgentsPanel.test.tsx`).
- **Verificación manual:** en la app, manda un pedido largo en el chat de un proyecto y abre el Tablero con el panel visible. La fila «Mente» debe decir «Pensando» con su última acción, y pasar a «Libre» al terminar el turno. Repite desde un chat de otro proyecto y desde Conversaciones.
