# F5 — Interfaz (escritorio y web)

Plan de implementación de la interfaz. Fecha: 2026-11-04. Autor: A0. **Todo agente de F5 lee este archivo antes de empezar y lo relee si pierde el hilo.**

## 1. Qué pidió el usuario

**Nombre de la app: Berland.** Todo texto visible para el usuario dice «Berland» (ventana, barra lateral, acceso directo, saludos). El repo, las rutas, la carpeta de datos y los nombres internos siguen siendo `orquestador`.

1. Dejar de usar la terminal: trabajar de forma continua desde la app del orquestador.
2. Interfaz basada en el orquestador IDE externo (Orchestrator.inc: barra lateral con proyectos, portada «Retoma donde quedaste» con tarjetas, ajustes abajo a la izquierda), con **los colores y los tipos de contenedor de `C:\dev\studyapp`**.
3. Ajustes: elegir **quién es la mente** (orquestador) y **quiénes son los subagentes** (flota).
4. Darle **proyectos** (apuntar a carpetas) y, en casos puntuales, **tareas a mano**.
5. **Shift+Tab** cambia el modo de la mente: **auto → plan → bypass**.
6. Poder **salir de la carpeta** apuntada: cerrar el proyecto y volver a la portada, y agregar carpetas extra que la mente puede leer (en bypass, cualquier carpeta).
7. Sección **Plugins**: **Chrome** (tu cuenta de Chrome, para que los agentes naveguen con tus sesiones) y **Canva** (tu cuenta). Más plugins después.
8. Lo básico de un IDE: **pegar una imagen** en el input y **arrastrar un archivo del escritorio** sobre la ventana, con una capa «Suelta para adjuntar» que lo agrega al input.
9. Escritorio primero (Windows) y también web. Cuidar los recursos del PC (i7-7700HQ de 4 núcleos, GTX 1050).
10. **Plan de implementación obligatorio en cada tarea** del orquestador, aunque no se le muestre al usuario, para que los agentes no pierdan el hilo y puedan releer qué les tocaba.

## 2. Decisiones

| Tema | Decisión | Por qué |
|---|---|---|
| Una sola interfaz | React 19 + Vite 8 en `src/ui`, compilada a `dist/ui` y **servida por el núcleo** en `http://127.0.0.1:47811/`. | La misma interfaz sirve en el escritorio y en el navegador, y el núcleo sigue siendo el único proceso con estado. |
| Escritorio | Electron 44 en `apps/desktop`: lanza el núcleo (Node 24 de Windows) como proceso hijo, lee su línea `ready`, abre una ventana sin marco y expone `window.orq` (`DesktopBridge` de `src/shared/api.ts`). | Da selector de carpetas nativo, la ruta real de un archivo soltado y un acceso directo en el escritorio. Si se cierra la interfaz, el núcleo sigue vivo: la flota no se corta. |
| Web | El núcleo imprime `http://127.0.0.1:47811/#t=<token>`. La interfaz toma el token del fragmento, lo borra de la barra y lo guarda solo en `sessionStorage`. El WebSocket lleva el token en el subprotocolo `orq.bearer.<token>` junto a `orq`. | El navegador no puede mandar `Authorization` en el handshake del WebSocket. El token nunca va a `localStorage`. |
| Estilo | HeroUI v3 + Tailwind 4 con el tema de studyapp, portado a `src/ui/styles/index.css`. | Lo pidió el usuario. Los componentes de referencia están en `C:\dev\studyapp\packages\web\src\shared\components` (Composer, ContextMenu, Popover, SelectableCard, ToggleField…) y en `packages/ui/src/components`. |
| Recursos | Vistas cargadas por demanda (`React.lazy`), sin Monaco, Mermaid ni gráficos pesados. Eventos en vivo agrupados por cuadro (`requestAnimationFrame`) y listas largas recortadas a los últimos 500 elementos. Ajuste «Menos efectos» que quita el desenfoque. Electron con `backgroundThrottling` y sin DevTools en producción. | El cuello es la CPU (4 núcleos) y la flota ya la usa. |
| Modos | `plan`: la mente propone y el usuario aprueba (como hoy). `auto`: la mente aprueba y delega sola sus tareas, que se integran en `orq/integracion` tras el gate; pasar a `main` lo aprueba el usuario. `bypass`: como `auto`, más lectura fuera de la carpeta y paso a `main` sin preguntar si el gate pasa. **Push, despliegue, pagos y borrar ramas siguen bloqueados en los tres modos.** | Mismo espíritu que los modos de Claude Code, sin abrir lo irreversible. |
| Mente | Claude (`claude-sdk`) es mente completa. Codex y agy aparecen como candidatos `experimental` hasta que exista el puente MCP por HTTP (fase F5.2). | Las herramientas de la mente son MCP en proceso del SDK de Claude. |
| Plan obligatorio | La flota escribe `.orq/PLAN.md` (plan general) y `.orq/BRIEF.md` en cada worktree. El agente escribe `.orq/PLAN-TAREA.md` antes de tocar código, marca sus pasos al avanzar y lo relee si pierde el hilo. La revisión y el traspaso lo leen. El plan general también queda en Obsidian. | Lo pidió el usuario. |

## 3. Contratos (ya en `main`)

- `src/shared/api.ts`: `Settings`, `MindMode` y `nextMindMode`, `Chat`, `ChatMessage`, `Attachment`, `Proposal`, `ManualTaskBody`, `PLAN_FILES`, `FsListResponse`, `FolderInspection`, `Plugin`, `ConnectPluginBody`, `DesktopBridge`. **No los cambies**: si necesitas otro campo, pídelo en tu informe.
- `src/core/server/app.ts`: `RouteModule` / `RouteModuleContext`. Cada módulo de rutas vive en su carpeta y se cablea con **una línea** en `src/core/app/route-modules.ts`.
- `src/core/server/hub.ts`: `hub.publish(F5HubMessage)` para `settings`, `chat`, `chat_message`, `chat_deleted`, `proposals` y `plugin`.
- `SqliteStore.database`: los módulos de F5 crean sus tablas con `CREATE TABLE IF NOT EXISTS <módulo>_…`, sin tocar `schema.ts`.
- Interfaz: `src/ui/api/client.ts` (`api.get/post/patch/del/upload`), `src/ui/api/live.ts` (`getLive()`, `subscribe`, `replay`), `src/ui/api/types.ts` (tipos de respuesta), `src/ui/store/app.ts` (proyectos, agentes, ajustes, cupos y tareas), `src/ui/app/routes.ts` (`navigate`, `routeHash`).

### Rutas REST nuevas

| Ruta | Tarea |
|---|---|
| `GET /settings` → `{settings}` · `PATCH /settings` (`settingsPatchSchema`) → `{settings}` y difusión `settings` | c14 |
| `GET /mind/candidates` → `{candidates: MindCandidate[]}` | c14 |
| `GET /fs/list?path=` → `FsListResponse` (sin `path`: unidades y carpetas habituales) · `POST /fs/pick-folder` → `{path: string \| null}` (diálogo de Windows por PowerShell, para la web) | c14 |
| `POST /projects/inspect` `{path}` → `FolderInspection` · `POST /projects/from-folder` (`projectFromFolderBody`) → `{project}` | c14 |
| `POST /tasks/manual` (`manualTaskBody`) → `{task}` | c14 |
| `GET /` y `/assets/*`: la interfaz de `dist/ui`, **sin token** (solo estáticos). `iniciar --abrir` abre el enlace con el token. | c14 |
| `GET/POST /chats`, `GET/PATCH/DELETE /chats/:id`, `GET /chats/:id/messages`, `POST /chats/:id/messages` (`sendMessageBody`), `POST /chats/:id/interrupt` | c15 |
| `GET /chats/:id/proposals`, `POST /chats/:id/proposals/:taskId/approve`, `…/reject`, `POST /chats/:id/proposals/approve-all` | c15 |
| `POST /attachments?name=` (cuerpo crudo, ≤ 20 MB) · `POST /attachments/by-path` (`attachmentByPathBody`) → `{attachment}` · `GET /attachments/:id` (bytes, para miniaturas) | c15 |
| `GET /plugins`, `POST /plugins/:id/connect` (`connectPluginBody`), `POST /plugins/:id/disconnect`, `GET /plugins/canva/callback` (OAuth) | c16 |

La salida de la mente llega por `/ws` como `event` con `sessionId = chat.sessionId` (texto, `tool_call`, `usage`…). La interfaz pide la historia con `replay`.

## 4. Diseño

- **Armazón** (hecho): barra de título propia (arrastra la ventana; botones de Electron) → barra lateral de 15rem (marca, Agente suelto, Tablero, Plugins, Proyectos con «+», estado y Ajustes) → `chrome-surface` redondeada de 1rem → panel derecho «Agentes en vivo» de 22rem.
- **Colores**: lienzo `#090909`, superficies de vidrio (`--surface`, `--dashboard-surface`), acento monocromo (`bg-foreground text-canvas` en el botón principal), texto atenuado `text-muted`, fondos suaves `bg-foreground/[0.045]` que suben a `[0.08]` al pasar el ratón, bordes `border-foreground/[0.06]`.
- **Contenedores**: `Panel` y `ActionCard` (`src/ui/components/Card.tsx`), `PageBody` y `PageHeader`, `NavItem` (h-9, `nav-indicator`), `IconButton` (size-8), `EmptyState`, `Kbd`. Los controles (Switch, Select, Tabs, Modal, Tooltip, Popover, Chip, Spinner) son de `@heroui/react`.
- **Composer**: como el de studyapp (`rounded-[1.625rem] bg-foreground/[0.06]`, botón «+», textarea que crece, botón redondo `bg-foreground text-canvas`). A la izquierda abajo va la ficha del modo (Plan, Auto o Bypass, con su color) y la mente activa.
- Textos en español, frases cortas. Accesible: `aria-label` en cada botón de icono, foco visible y teclado completo.

## 5. Reglas para cada agente de F5

1. **Antes de tocar código**, escribe `.orq/PLAN-TAREA.md` en tu worktree: pasos numerados con casillas `- [ ]`, archivos que vas a crear o tocar, pruebas que vas a escribir y riesgos. Marca `- [x]` al terminar cada paso. **Si pierdes el hilo, relee este plan, tu `.orq/PLAN-TAREA.md` y tu `.orq/BRIEF.md`.**
2. Modifica solo tus rutas propias (§6). Fuera de ellas, propón en tu informe.
3. No ejecutes `npm install`: las dependencias ya están (ver `package.json`).
4. TypeScript estricto, sin `any`. La interfaz importa de `src/core` **solo tipos** (`import type`); la regla de ESLint lo exige.
5. Pruebas en `tests/ui/<feature>/*.test.tsx` (con `// @vitest-environment happy-dom` en la primera línea y `@testing-library/react`) o en `tests/core/<módulo>/`. Mientras trabajas, corre solo tus pruebas; antes de entregar, `npm run -s check` completo (typecheck + lint + test + build:ui). Desde WSL: `scripts/win.sh npm run -s check < /dev/null`.
6. Nada de claves en código, pruebas ni registros; pasa por `redactSecrets` lo que guardes.
7. Informe final según `AGENTS.md`.

## 6. Tareas

| Id | Quién | Rutas propias | Depende de | Hecho cuando |
|---|---|---|---|---|
| **c14-servidor-ui** | Claude (flota A0) | `src/core/settings/**`, `src/core/fs/folders.ts`, `src/core/server/static.ts`, `src/core/server/security.ts`, `src/core/server/ws.ts`, `src/core/app/f5-servidor.ts`, línea c14 de `route-modules.ts`, `src/core/app/cli-commands.ts` (`iniciar --abrir`), `src/core/orchestrator/router.ts` (respeta `workers` y `quotaFloor`), `src/core/app/fleet-service.ts` (concurrencia desde ajustes), `tests/core/f5-servidor/**` | — | Las rutas c14 de §3 con Zod y pruebas; la interfaz se sirve sin token y la API sigue exigiéndolo; `/ws` acepta el subprotocolo; la flota reparte solo a `workers` |
| **c15-chat** | Claude (flota A0) | `src/core/chat/**`, `src/core/conductor/**`, `src/core/app/conductor.ts`, `src/core/app/f5-chat.ts`, línea c15 de `route-modules.ts`, `tests/core/chat/**`, `tests/core/conductor/**` | — | Chat con la mente por REST y `/ws` con historia en SQLite; modos plan, auto y bypass aplicados de verdad (pruebas con `query` falso); imágenes adjuntas como bloques de imagen; archivos por ruta; `extraRoots`; propuestas aprobables; el prompt exige plan de implementación en cada `crear_tareas` |
| **c16-plugins** | Claude (flota A0) | `src/core/plugins/**`, `src/core/app/f5-plugins.ts`, línea c16 de `route-modules.ts`, `src/core/adapters/claude-sdk/adapter.ts` (`mcpServers`), `src/core/adapters/codex-cli/index.ts` y `src/core/adapters/agy-cli/index.ts` (servidores MCP por argumentos o configuración), `tests/core/plugins/**` | — | Chrome: estado real (`personal` con `--autoConnect` o perfil `agente`), pasos para activar la depuración remota y entrega del MCP `chrome-devtools-mcp` de `C:\dev\agent-hub\tools\browser` a los agentes elegidos, con candado `chrome-personal`. Canva: OAuth 2.1 con PKCE y registro dinámico contra `https://mcp.canva.com/mcp` (tokens en la bóveda DPAPI, refresco) y entrega como MCP HTTP. `PluginService.mcpServersFor(agentId)` para que c15 lo use en la mente |
| **c17-plan-obligatorio** | Claude (flota A0) | `src/core/brief/render-brief.ts`, `src/core/orchestrator/fleet.ts`, `src/core/orchestrator/plan.ts`, `src/core/memory/**` (notas `Planes/`), `tests/core/brief/**`, `tests/core/orchestrator/plan-obligatorio*.test.ts` | — | Cada tarea lleva `.orq/PLAN.md` y la instrucción de escribir y mantener `.orq/PLAN-TAREA.md`; la flota avisa si falta al terminar y se lo pasa al revisor y al traspaso; el plan general queda en `Orquestador/Proyectos/<p>/Planes/` |
| **c18-escritorio** | Claude (flota A0) | `apps/desktop/**`, `scripts/desktop*.{ps1,cmd,sh}`, `tests/desktop/**`, scripts `desktop` y `desktop:dev` de `package.json` | c14 (servir la interfaz) | `npm run desktop` abre la app, que arranca o reutiliza el núcleo; preload con `DesktopBridge` y aislamiento de contexto; acceso directo «Orquestador» en el escritorio; una sola instancia; al cerrar la ventana el núcleo sigue si hay tareas en curso |
| **c19-chat-ui** | Claude (flota A0) | `src/ui/features/chat/**`, `tests/ui/chat/**` | contratos; usa el Composer de ui-composer por sus props | Vista de chat: lista de conversaciones del proyecto, mensajes en Markdown, texto en vivo desde `/ws`, herramientas plegadas, tarjeta de propuestas (aprobar, rechazar, aprobar todo), ficha del modo con Shift+Tab, botón «Cerrar carpeta» (vuelve a la portada) y carpetas extra |
| **ui-composer** | **Codex** (por el orquestador) | `src/ui/features/composer/**`, `tests/ui/composer/**` | contratos | Composer según `ComposerProps`: Enter envía y Shift+Enter hace salto de línea; pegar una imagen la adjunta; arrastrar archivos sobre la ventana muestra la capa `.drop-overlay` «Suelta para adjuntar» y al soltar los adjunta (en Electron con `desktop.pathForFile`); bandeja con miniaturas y quitar; Shift+Tab llama `onModeChange(nextMindMode(mode))`; Esc detiene; pruebas de cada caso |
| **ui-agentes-vivo** | **Codex** (por el orquestador) | `src/ui/features/agents-panel/**`, `tests/ui/agents-panel/**` | contratos | Panel derecho: sesiones activas (`GET /sessions` + `event` de `/ws`), una tarjeta por agente con nombre, modelo, estado, transmisión (texto, comandos y archivos), tokens, costo y barra de cupo con hora de reinicio; árbol de subagentes por `parentSessionId`; agrupado por cuadro y recortado a 500 eventos |
| **ui-tablero** | **agy** (por el orquestador) | `src/ui/features/board/**`, `tests/ui/board/**` | contratos | Tablero por estado (pendiente, lista, en curso, revisión, integrada, fallida, cancelada) con filtro por proyecto; detalle de la tarea; aprobar y cancelar; diálogo «Tarea a mano» que llama a `POST /tasks/manual` |
| **ui-ajustes** | **agy** (por el orquestador) | `src/ui/features/settings/**`, `tests/ui/settings/**` | contratos | Secciones General (tema, menos efectos, concurrencia, umbral de cupo), **Mente y subagentes** (mente, modelo y esfuerzo de `GET /mind/candidates`; interruptores de subagentes; modo inicial), Agentes (lista, detectar CLIs, agregar por clave, probar, habilitar, presupuesto), Proyectos (lista, quitar), Memoria (vista previa del contexto) y Skills (lista, importar, aprobar o rechazar) |
| **ui-plugins-proyectos** | **Codex** (por el orquestador) | `src/ui/features/plugins/**`, `src/ui/features/projects/**`, `tests/ui/plugins/**`, `tests/ui/projects/**` | contratos | Plugins: tarjetas Chrome y Canva con estado en vivo, conectar y desconectar, perfil de Chrome, pasos y apertura de `authUrl`. `AddProjectDialog`: elegir carpeta (`desktop.pickFolder()` o `POST /fs/pick-folder`, con explorador `GET /fs/list` de respaldo), inspeccionar, editar nombre y gate, y registrar con `POST /projects/from-folder` |

Integración (A0): las ramas Claude van a `main` con `merge --no-ff` tras `npm run -s check`. Las tareas de Codex y agy las integra el núcleo en `orq/integracion` con el gate, y A0 pasa `orq/integracion` a `main`. Después, A0 cablea los módulos, arranca la app y prueba el recorrido completo.

## 7. Aceptación de F5

Desde el acceso directo del escritorio: se abre la app, el núcleo arranca, se agrega la carpeta de un proyecto, se conversa con la mente, Shift+Tab cambia el modo, se pega una imagen y se suelta un archivo en el input, la mente propone tareas y, al aprobarlas, los paneles muestran a los agentes en vivo con tokens y cupo, y las tareas llegan al tablero hasta «integrada». Los plugins Chrome y Canva quedan conectados o con sus pasos claros. Lo mismo funciona en el navegador con el enlace del núcleo.

## 8. Después (F5.2)

Codex y agy como mente (puente MCP por HTTP en el núcleo), clonar repos, más plugins, acceso desde el móvil e instalador NSIS (F7).
