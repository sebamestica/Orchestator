# El botón «…» de un proyecto en la barra lateral promete «Opciones de <proyecto>» y solo lleva a la lista general de Ajustes › Proyectos

- **Área:** Interfaz
- **Severidad:** baja
- **Archivos:** `src/ui/app/Sidebar.tsx:60-62`, `src/ui/app/Sidebar.tsx:26`, `src/ui/app/Sidebar.tsx:74`, `src/ui/app/routes.ts:15`, `src/ui/app/routes.ts:39-41`, `src/ui/features/settings/ProjectsSection.tsx:47-68`
- **Estado:** abierta
- **Origen:** revisión de agy, verificada por Claude

## Cómo ocurre
Cada proyecto de la barra lateral muestra dos acciones al pasar el puntero o al recibir foco (`.group:hover .reveal`, `.group:focus-within .reveal` en `src/ui/styles/index.css:195-196`): el tablero y un botón de tres puntos. El segundo es un enlace fijo, igual para todos los proyectos:

```tsx
// src/ui/app/Sidebar.tsx:60-61
<a href={routeHash({ name: 'settings', section: 'proyectos' })} aria-label={`Opciones de ${p.name}`} title="Opciones" …>
  <MoreHorizontal className="size-3.5" aria-hidden="true" />
```

Pasos:
1. Tener al menos dos proyectos registrados y abrir el chat de uno (por ejemplo «Vetworld»).
2. Pasar el puntero sobre «Vetworld» en la barra lateral y pulsar «…» (el lector de pantalla anuncia «Opciones de Vetworld»).
3. La app navega a `#/ajustes/proyectos`. No se abre ningún menú.

Lo que se ve después:
- La ruta de ajustes no lleva el proyecto. `Route` solo tiene `{ name: 'settings'; section: SettingsSection }` (`src/ui/app/routes.ts:15`) y `parseRoute` ignora cualquier segmento después de la sección (`routes.ts:39-41`).
- `ProjectsSection` lista todos los proyectos con el mismo aspecto (`ProjectsSection.tsx:47-48`) y no resalta ni lleva al que se eligió. Cada fila muestra nombre, ruta y gate, y su única acción es «Quitar» (`ProjectsSection.tsx:58-68`).
- La barra lateral deja de marcar el proyecto, porque `projectId` solo se toma de las rutas `project` y `board` (`Sidebar.tsx:26`), y pasa a marcar «Ajustes» (`Sidebar.tsx:74`, `active={route.name === 'settings' && route.section !== 'uso'}`).

Correcciones a lo que reportó agy:
- Las citas y el comportamiento son correctos, pero la severidad es **baja**, no media. No se pierden datos ni falla ninguna función: la fila del proyecto sí aparece en la página de destino, con su ruta y su gate. El problema es que el control promete algo que no hace.
- agy daba por hecho que el usuario espera «renombrar, cambiar ruta, ver memoria, abrir en explorador». El núcleo no tiene esas operaciones. Para un proyecto solo hay `GET`, `POST` y `DELETE /projects/:id` (`src/core/server/app.ts:386-430`), y la descripción del `POST` dice «Para cambiarlo: DELETE y POST de nuevo» (`app.ts:396`). Hoy, las opciones reales de un proyecto son abrir su chat, abrir su tablero, ver su ruta y su gate, y quitarlo.

## Por qué pasa
Al armar la barra lateral (commit `4dfb729`) se usó un enlace a la sección general como marcador para el menú del proyecto, y el menú nunca se hizo. Hay una pista de que se pensaba en un menú desplegable: la regla `.reveal:has([aria-expanded="true"])` (`src/ui/styles/index.css:197`) mantiene visibles las acciones mientras un disparador con `aria-expanded` está abierto, y ninguna acción de la barra lateral lo usa hoy. Ni la ruta de ajustes ni `ProjectsSection` saben de qué proyecto se viene, así que el destino no puede dar contexto.

## Solución posible
Cambiar el enlace de `Sidebar.tsx:60-62` por un `Popover` de HeroUI (ya se usa así en `src/ui/features/chat/components/ChatHeader.tsx:125-176`) con el botón «…» como disparador (`aria-expanded` lo pone HeroUI, y la regla de `index.css:197` ya deja la fila visible). Opciones del menú, solo con lo que existe:
- «Ver en Ajustes»: navega a Ajustes › Proyectos con el proyecto destacado (ver la variante B más abajo).
- «Quitar…»: abre el mismo `ConfirmDialog` que usa `ProjectsSection.tsx:73-84` y llama a `DELETE /projects/:id`. Para no duplicar código, conviene sacar la confirmación y el borrado a un componente o hook compartido.

El título y el `aria-label` («Opciones de <proyecto>») pasan a ser ciertos, y la barra lateral sigue marcando el proyecto mientras el menú está abierto.

### Otras opciones
No son las únicas salidas, y puede haber una más ajustada a cómo evolucione la gestión de proyectos:
- **A. Mínima, sin menú:** dejar el enlace, pero llamarlo por lo que hace («Ajustes de proyectos»), con un icono de engranaje en vez de `MoreHorizontal`. Sin cambios de comportamiento ni de rutas.
- **B. Enlace con contexto:** agregar un `projectId` opcional a la ruta de ajustes (`#/ajustes/proyectos/<id>`, en `routes.ts:15`, `:39-41` y `:64-65`) y hacer que `ProjectsSection` marque esa fila (`aria-current`, fondo suave) y se desplace hasta ella. Puede ir sola o junto con el menú.
- **C. Más adelante:** si el núcleo llega a tener `PATCH /projects/:id` (cambiar el nombre o el gate), el menú es el sitio natural para esas acciones. Hoy no hay que prometerlas.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: `tests/ui/sidebar/Sidebar.test.tsx` (nuevo), con el núcleo falso de `tests/ui/settings/helpers.ts` (`fakeCore`) y dos proyectos en `useApp`.
  - Escenario «menú»: renderizar `<Sidebar route={{ name: 'project', projectId: 'vetworld' }} />`, pulsar el botón «Opciones de Vetworld» y comprobar que se abre un menú o diálogo con «Quitar…», que `window.location.hash` no cambia y que la fila de Vetworld conserva `aria-current="page"`.
  - Escenario «quitar»: dentro del menú, «Quitar…» y luego confirmar. Comprobar que `fakeCore` recibió `DELETE /projects/vetworld` y no una llamada para el otro proyecto.
  - Si se elige la variante B: `parseRoute('#/ajustes/proyectos/vetworld')` devuelve la sección `proyectos` con `projectId: 'vetworld'` (en `tests/ui/routes.test.tsx`), y `ProjectsSection` marca solo esa fila.
  - Si se elige la variante A: el enlace tiene un `aria-label` que no dice «Opciones de <proyecto>» y apunta a `#/ajustes/proyectos`.
- Comando (WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/sidebar/Sidebar.test.tsx"`. En PowerShell, desde C:\dev\orquestador: `npx vitest run tests/ui/sidebar/Sidebar.test.tsx`.
- Verificación manual en la app: con dos proyectos, abrir el chat de uno, pasar el puntero y pulsar «…». Debe abrirse un menú solo de ese proyecto, la fila debe seguir visible y marcada mientras el menú está abierto, y Esc debe cerrarlo. «Quitar…» debe pedir confirmación con el nombre correcto. Con el teclado, Tab hasta la fila, Tab hasta «…» y Enter debe abrir el mismo menú.
