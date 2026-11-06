# El botón «agentes en vivo» de la barra de título no dice la verdad: fuera del chat y del tablero, y con la ventana por debajo de 1024 px, se enciende y se apaga sin que aparezca el panel

- **Área:** Interfaz
- **Severidad:** baja
- **Archivos:** `src/ui/app/TitleBar.tsx:24`, `src/ui/app/App.tsx:105`, `src/ui/app/App.tsx:132`, `src/ui/features/agents-panel/AgentsPanel.tsx:80`, `src/ui/store/app.ts:44`, `apps/desktop/src/lib/window-state.ts:24`
- **Estado:** abierta
- **Origen:** revisión de agy, verificada por Claude

## Cómo ocurre
El botón `PanelRight` de la barra de título siempre está habilitado y se marca activo según `panelOpen`, sin mirar la ruta ni el ancho de la ventana:

```tsx
// src/ui/app/TitleBar.tsx:24
<IconButton label="Mostrar u ocultar los agentes en vivo" size="sm" active={panelOpen} onClick={() => togglePanel()}>
```

`panelOpen` empieza en `true` (`src/ui/store/app.ts:44`), así que el botón sale resaltado desde que se abre Berland. Pero el panel solo se monta en tres rutas y con el núcleo listo:

```tsx
// src/ui/app/App.tsx:105
const showPanel = panelOpen && (route.name === 'project' || route.name === 'standalone' || route.name === 'board');
// src/ui/app/App.tsx:132
{showPanel && core === 'ready' ? <AgentsPanel /> : null}
```

Además, aun montado, el `<aside>` está oculto por CSS bajo el punto `lg` de Tailwind 4 (64rem = 1024 px; `src/ui/styles` no lo cambia):

```tsx
// src/ui/features/agents-panel/AgentsPanel.tsx:80
<aside aria-label="Agentes en vivo" className="chrome-surface hidden w-[var(--panel-width)] shrink-0 flex-col overflow-hidden lg:flex">
```

La ventana de Electron admite hasta 960 px de ancho (`MIN_SIZE = { width: 960, height: 600 }`, `apps/desktop/src/lib/window-state.ts:24`). Entre 960 y 1023 px el panel no se ve nunca, y en el modo navegador («Abrir en el navegador») pasa con cualquier ancho menor.

Pasos:
1. Abrir Berland en la Portada (`#/`), en Ajustes (`#/ajustes/general`), en el perfil/uso o en Plugins (`#/plugins`). El botón de la derecha aparece resaltado (activo) y no hay panel.
2. Pulsarlo varias veces: el resaltado cambia y la pantalla no. El estado sí cambia (es global y en memoria) y se nota más tarde, al entrar a un chat o al tablero.
3. Pasa lo mismo mientras el núcleo arranca o está caído (`core !== 'ready'`, `App.tsx:132`).
4. Abrir un chat de proyecto, Conversaciones o el Tablero y dejar la ventana entre 960 y 1023 px, por ejemplo acoplada a media pantalla en un monitor 1920×1080 al 100 %. El botón dice que el panel está abierto y no se ve. Pulsarlo no lo muestra: el panel sigue inaccesible, y no hay ningún aviso de que falta ancho.

## Por qué pasa
- La condición de cuándo se ve el panel vive solo en `App.tsx:105` y `:132`. `TitleBar` no recibe la ruta ni el estado del núcleo (`App.tsx:109`, `<TitleBar />` sin props), así que no puede deshabilitarse ni explicar que el panel no se ve en esa vista.
- El ocultamiento por ancho se hace con CSS (`hidden lg:flex`). React no sabe que el panel está oculto: `panelOpen` y `active` siguen en `true` y el clic del usuario no puede ganarle a la media query. La decisión tiene sentido (barra lateral de 15rem + panel de 22rem dejan poco para el chat a 960 px), pero solo la conoce el CSS, no el botón.

## Solución posible
1. Sacar la condición a un ayudante compartido, por ejemplo `panelRoute(route)` en `src/ui/app/routes.ts`, y usarlo en `App.tsx` y en `TitleBar`. `TitleBar` lee la ruta con `useRoute()` o la recibe de `App` como prop.
2. En `TitleBar`, cuando `!panelRoute(route) || core !== 'ready'`: `disabled`, `active={false}` y un `title` como «Los agentes en vivo se ven en los chats y en el tablero». Otra opción es no mostrar el botón en esas vistas.
3. Para el ancho, cambiar `hidden lg:flex` por un hook `useMediaQuery('(min-width: 64rem)')`:
   - con ancho suficiente, el panel queda en línea como hoy;
   - sin ancho y con `panelOpen`, se dibuja superpuesto a la derecha de `<main>` (`absolute`/`fixed`, con sombra, que se cierra con Escape o con el mismo botón) y el chat no se encoge;
   - por defecto, bajo `lg`, conviene que no se abra solo: que lo abra el usuario.

### Otras opciones
No es la única salida, y puede haber una más optimizada:
- Plegar la barra lateral sola bajo `lg` (Ctrl+B ya existe) y mostrar el panel en línea con un ancho menor (por ejemplo 18rem).
- Mantener el panel oculto bajo `lg`, pero deshabilitar el botón con el aviso «Agranda la ventana para ver los agentes». Es más simple, aunque no da forma de ver la actividad a media pantalla.
- Subir `MIN_SIZE.width` a 1024 en Electron. Resuelve la app de escritorio, pero no el modo navegador e impide acoplar a media pantalla en 1920 px.
- Mostrar una versión compacta (solo los puntos de estado de la mente y de cada agente) en la barra de título cuando no cabe el panel.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: `tests/ui/app/title-bar-panel.test.tsx` (happy-dom, como `tests/ui/routes.test.tsx`).
  - Con `useApp.setState({ core: 'ready', panelOpen: true })` y el hash en `#/ajustes/general`, `#/` y `#/plugins`, el botón «Mostrar u ocultar los agentes en vivo» está deshabilitado (o no existe) y no tiene el estado activo.
  - Con el hash en `#/conversaciones` o `#/tablero`, el botón está habilitado; al pulsarlo desaparece el `complementary` «Agentes en vivo» y al pulsarlo otra vez vuelve.
  - Con `window.matchMedia` simulado para que `(min-width: 64rem)` devuelva `matches: false`, al pulsar el botón en `#/conversaciones` el `complementary` «Agentes en vivo» queda en el DOM y es visible (sin la clase `hidden`, con el marcador de superpuesto que se elija). Con `matches: true` va en línea.
  - `core: 'starting'`: el botón está deshabilitado.
- Comando (WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/app/title-bar-panel.test.tsx"`; PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/app/title-bar-panel.test.tsx`.
- Verificación manual en la app:
  - En Portada, Ajustes y Plugins, el botón aparece apagado o deshabilitado, con su aviso.
  - En un chat, achicar la ventana a unos 980 px (o acoplarla a media pantalla en un 1920×1080 al 100 %) y pulsar el botón: el panel se ve superpuesto, o la solución elegida lo deja accesible, y se cierra con el mismo botón.
  - Por encima de 1024 px todo se comporta como hoy.
