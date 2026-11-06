# Sin error boundary: si falla una vista perezosa (por ejemplo tras recompilar dist/ui) la ventana queda en blanco y sin controles

- **Área:** Interfaz: tablero, panel, ajustes
- **Severidad:** media
- **Archivos:** `src/ui/app/App.tsx:16`, `src/ui/app/App.tsx:115`, `src/ui/main.tsx:8`, `src/ui/vite.config.ts:17`, `package.json:15`, `src/core/server/static.ts:95`, `src/core/server/static.ts:119`, `src/core/app/f5-servidor.ts:43`, `apps/desktop/src/main.ts:76`, `apps/desktop/src/main.ts:130`, `apps/desktop/src/main.ts:212`, `src/ui/app/TitleBar.tsx:27`
- **Estado:** resuelta

## Cómo ocurre

La interfaz se compila a `dist/ui` y la sirve el propio núcleo. Por defecto es la carpeta `dist/ui` del repositorio (`src/core/app/f5-servidor.ts:43`). El núcleo lee cada archivo del disco en cada petición (`src/core/server/static.ts:95`, `new Response(await readFile(file), …)`), y si un recurso de `/assets/` no existe responde 404 (`static.ts:119`, `'No existe el recurso'`).

Cuatro vistas se cargan por demanda, cada una en su propio trozo con hash (en `dist/ui/assets` hoy están `BoardView-*.js`, `SettingsView-*.js`, `PluginsView-*.js` y `ChatView-*.js`):

```tsx
// src/ui/app/App.tsx:16-19
const ChatView = lazy(() => import('../features/chat/ChatView.tsx'));
const BoardView = lazy(() => import('../features/board/BoardView.tsx'));
const SettingsView = lazy(() => import('../features/settings/SettingsView.tsx'));
const PluginsView = lazy(() => import('../features/plugins/PluginsView.tsx'));
```

y solo se envuelven en `<Suspense>`, sin nada que capture errores (`App.tsx:115-117`):

```tsx
<Suspense fallback={null}>
  <View route={route} />
</Suspense>
```

La raíz tampoco tiene red de seguridad: `src/ui/main.tsx:8-12` hace `createRoot(root).render(<StrictMode><App /></StrictMode>)` sin `onUncaughtError` ni error boundary. Un grep de `ErrorBoundary`, `componentDidCatch`, `getDerivedStateFromError` y `vite:preloadError` en `src/ui` y `apps/desktop/src` no da resultados.

Pasos:

1. Abre Berland (Electron) y quédate en un chat, sin abrir todavía Tablero, Ajustes ni Plugins.
2. Con algún cambio en la interfaz (por ejemplo, tras integrar un commit de la flota), corre en `C:\dev\orquestador` el gate `npm run -s check`, que incluye `build:ui` (`package.json:15`), o directamente `npm run build:ui`. Vite vacía `dist/ui` (`emptyOutDir: true`, `src/ui/vite.config.ts:17`) y escribe trozos con hash nuevo. Los trozos viejos desaparecen del disco.
3. Pulsa «Tablero». La página en memoria todavía referencia `BoardView-<hash viejo>.js`, el núcleo responde 404, el `import()` se rechaza y `lazy` lanza el error al renderizar.
4. Como ninguna capa lo captura, React 19 desmonta toda la raíz. Se va también `TitleBar`, y con ella la barra lateral, el arrastre de la ventana y los botones Minimizar, Maximizar y Cerrar (`src/ui/app/TitleBar.tsx:27-37`). La ventana es sin marco (`apps/desktop/src/main.ts:76`, `frame: false`), así que queda un rectángulo vacío sin controles.
5. No hay forma de recargar: el menú de la aplicación está anulado (`main.ts:130`, `Menu.setApplicationMenu(null)`), así que Ctrl+R no hace nada, y en `src/ui` no hay ningún atajo de recarga (el único atajo es Ctrl+B, `App.tsx:75`). El proceso principal solo reacciona si el renderizador muere (`main.ts:212`, `render-process-gone`) o si la carga inicial da HTTP >= 400 (`main.ts:216`), y un error de JavaScript no dispara ninguno de los dos. Queda cerrar con Alt+F4 o desde la barra de tareas. El cierre pasa por `CoreSupervisor.onAppClose` (`apps/desktop/src/core-supervisor.ts:258`), que apaga el núcleo si la app lo arrancó y no hay tareas en curso.

Hay dos condiciones: el contenido de esos trozos tiene que cambiar (si el código es el mismo, Rollup repite el hash y el archivo vuelve a existir), y la recompilación tiene que ser en la carpeta que sirve el núcleo (el gate de los worktrees escribe en su propio `dist/ui`). Además, sin trozos de por medio, cualquier excepción de render en cualquier vista (Chat, Tablero, Ajustes, Plugins, Portada o el panel de agentes) produce el mismo desmontaje total.

Recargar la página arregla el caso de los trozos, porque `index.html` se sirve con `no-store` (`static.ts:112`) y trae los hashes nuevos. Lo que falta es una forma de recargar.

## Por qué pasa

- `App.tsx:115-117` envuelve las vistas `lazy` solo en `<Suspense>`, que maneja la espera pero no el rechazo. No existe ningún error boundary en el árbol, y `main.tsx:8` crea la raíz sin `onUncaughtError`, así que un error de carga o de render desmonta toda la aplicación.
- `vite.config.ts:17` (`emptyOutDir: true`) borra los trozos viejos al recompilar, y el núcleo sirve directamente desde esa carpeta (`f5-servidor.ts:43`, `static.ts:95`).
- La ventana sin marco depende de React para sus controles (`main.ts:76` y `TitleBar.tsx:27-37`), y sin menú (`main.ts:130`) no queda recarga nativa.

## Solución posible

1. Crear `src/ui/app/ViewBoundary.tsx`: un componente de clase con `getDerivedStateFromError` y `componentDidCatch` que muestre un `EmptyState` con «No se pudo cargar esta vista», el mensaje del error y un botón «Recargar» (`window.location.reload()`).
2. En `src/ui/app/App.tsx`, envolver el `<Suspense>` dentro de `<main>` con `<ViewBoundary key={routeHash(route)}>`. Así `TitleBar`, `Sidebar` y `AgentsPanel` siguen montados, y navegar a otra ruta reinicia el boundary. Poner otro boundary aparte alrededor de `<AgentsPanel />` (`App.tsx:132`), para que un fallo del panel no arrastre la vista.
3. En `src/ui/main.tsx`, escuchar `window.addEventListener('vite:preloadError', …)` y recargar una sola vez (con una marca en `sessionStorage` dentro de try/catch para no entrar en bucle). Ese evento lo emite el ayudante de precarga de Vite cuando falla un trozo dinámico. Si la recarga automática no basta, el boundary sigue mostrando el aviso con «Recargar».

### Otras opciones

- **Recarga desde Electron:** en `apps/desktop/src/main.ts`, registrar `win.webContents.on('before-input-event', …)` para Ctrl+R/F5 (o un menú oculto con el rol `reload`). Sirve también para errores que no son de render, pero no evita la ventana en blanco: la complementa.
- **Conservar los trozos viejos:** `emptyOutDir: false` en `vite.config.ts`, o copiar los `assets` anteriores al compilar. Evita el 404 sin tocar React, pero acumula archivos en `dist/ui/assets` y no cubre las excepciones de render.
- **Quitar `lazy`:** importar las vistas de forma estática. Elimina el fallo de los trozos a cambio de una carga inicial más pesada, y tampoco cubre las excepciones de render.
- **`onUncaughtError` en `createRoot`:** sirve para mostrar un aviso global o recargar, pero la raíz se desmonta igual. Es un respaldo, no el arreglo.

La propuesta (boundary por ruta más recarga ante `vite:preloadError`) no es la única. Es la que cubre los dos casos, el trozo que falta y cualquier excepción de render, sin cambiar la compilación. Combinarla con el atajo de recarga en Electron sería lo más robusto.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:** `tests/ui/app/view-boundary.test.tsx` (con `// @vitest-environment happy-dom`, igual que `tests/ui/routes.test.tsx`).
  - Escenario 1: renderizar `<div><span>barra</span><ViewBoundary key="a"><Suspense fallback={null}><Rota /></Suspense></ViewBoundary></div>`, donde `Rota = lazy(() => Promise.reject(new Error('Failed to fetch dynamically imported module')))`. Afirmar con `findByText` que aparece «No se pudo cargar esta vista» y el botón «Recargar», y que «barra» sigue en el documento.
  - Escenario 2: un componente que lanza en render dentro del boundary. Afirmar que se ve el mismo aviso y que el resto no se desmonta.
  - Escenario 3: volver a renderizar con otra `key` y una vista sana. Afirmar que el aviso desaparece y se ve la vista.
  - Escenario 4: con `window.location.reload` simulado (`vi.fn()`), pulsar «Recargar» y afirmar que se llamó una vez.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/app/view-boundary.test.tsx"` (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/ui/app/view-boundary.test.tsx`).
- **Verificación manual,** cuando la CPU lo permita: con Berland abierto en un chat, cambiar algo en `src/ui/features/board`, correr `npm run build:ui` y pulsar «Tablero». Antes del arreglo la ventana queda vacía y sin botones de ventana. Después siguen la barra de título y la lateral, y aparece el aviso con «Recargar» (o la página se recarga sola una vez y abre el tablero).
