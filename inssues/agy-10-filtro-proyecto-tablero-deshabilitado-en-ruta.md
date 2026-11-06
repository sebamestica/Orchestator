# El Tablero general queda filtrado por un proyecto si se llega desde el tablero de ese proyecto

- **Área:** Interfaz
- **Severidad:** baja
- **Archivos:** `src/ui/features/board/BoardView.tsx:24`, `src/ui/features/board/BoardView.tsx:42-47`, `src/ui/features/board/BoardView.tsx:76-79`, `src/ui/features/board/BoardView.tsx:124-126`, `src/ui/app/App.tsx:29-30`, `src/ui/app/Sidebar.tsx:37`, `src/ui/app/Sidebar.tsx:57`, `src/ui/app/routes.ts:30-33`, `tests/ui/board/board.test.tsx:191`, `tests/ui/board/board.test.tsx:206`
- **Estado:** abierta
- **Origen:** revisión de agy, verificada por Claude
- **Fusiona:** `ui-resto-06-tablero-global-hereda-filtro-proyecto.md` (revisión de la interfaz: tablero, panel, ajustes),
  que describía el mismo fallo. Ese archivo se borró; sus aportes (el caso A → B → Tablero, cuándo no ocurre y el hueco
  de las pruebas) están abajo.

## Cómo ocurre
El tablero de un proyecto (`#/tablero/<id>`) y el Tablero general (`#/tablero`) son el mismo componente `BoardView`.
Si se pasa del primero al segundo, el general no muestra todas las tareas. Sigue filtrado por el proyecto anterior.

Pasos:
1. Desde un chat de proyecto (o desde la portada), pulsar el icono de tablero junto al proyecto «Alfa» en la barra
   lateral (`Sidebar.tsx:57`, `href={routeHash({ name: 'board', projectId: p.id })}`). Se abre `#/tablero/proj-alpha`
   y `BoardView` se monta con `projectId="proj-alpha"`.
2. Pulsar «Tablero» arriba en la barra lateral (`Sidebar.tsx:37`, `href={routeHash({ name: 'board' })}`). La URL
   pasa a `#/tablero` y «Tablero» queda marcado como activo.
3. El Tablero general sigue mostrando solo las tareas de Alfa, y el selector, ya habilitado, dice «Proyecto Alfa» y no
   «Todos los proyectos». Si Alfa no tiene tareas, el estado vacío dice «No se encontraron tareas para el proyecto
   seleccionado» (`BoardView.tsx:124-126`), aunque haya tareas de otros proyectos.

Lo mismo ocurre con A, luego B y luego «Tablero»: se ve A. Mientras hay un proyecto fijo, la prop manda
(`BoardView.tsx:42`) y B se ve bien. Al quitar la prop vuelve el valor que se guardó en el primer montaje.

El fallo solo aparece si se pasa directo de un tablero a otro. Si se pasa antes por un chat o por los ajustes, React
desmonta `BoardView` y el Tablero general arranca en «Todos los proyectos». Tampoco ocurre si el tablero se montó
primero como Tablero general. `parseRoute` convierte las dos rutas en `{ name: 'board', projectId }` y
`{ name: 'board' }` (`routes.ts:30-33`), y la vista las pinta con el mismo componente lazy en la misma posición dentro
de `<Suspense>`.

Evidencia:
- `BoardView.tsx:24`: el filtro libre se inicializa con la prop solo al montar:
  `const [selectedProjectId, setSelectedProjectId] = useState<string>(() => fixedProjectId ?? 'all');`
- `BoardView.tsx:42`: `const effectiveProjectId = fixedProjectId ?? selectedProjectId;`. Si la prop desaparece, manda
  el estado, que quedó en `'proj-alpha'`.
- `App.tsx:29-30`: `case 'board': return <BoardView {...(route.projectId ? { projectId: route.projectId } : {})} />;`
  no lleva `key`, así que React reutiliza la misma instancia entre `#/tablero/proj-alpha` y `#/tablero`. El chat sí
  la lleva (`App.tsx:26`, `key={`p:${route.projectId}`}`).
- `docs/plan/issues/09-aislamiento-contexto.md:74-75` fija el comportamiento esperado: el tablero de un proyecto
  filtra por ese proyecto, y «el global muestra todos a propósito».

Correcciones a lo que reportó agy:
- Que el selector esté deshabilitado en `#/tablero/<id>` (`BoardView.tsx:77`, `isDisabled={Boolean(fixedProjectId)}`)
  es intencional, no un fallo. Ese tablero está acotado a su proyecto (issue 09), y para ver todos está «Tablero» en
  la barra lateral (`Sidebar.tsx:37`). Habilitarlo y navegar desde ahí sería un cambio de diseño, no una corrección.
- Tampoco es cierto que «ignore los cambios por URL» en general. Entre dos proyectos (`#/tablero/a` → `#/tablero/b`)
  la vista se actualiza bien, porque en `BoardView.tsx:42` la prop tiene prioridad sobre el estado. El dato viejo solo
  aparece al pasar del tablero de un proyecto al general.

## Por qué pasa
`selectedProjectId` hace dos cosas a la vez: guarda el filtro que el usuario elige en el Tablero general y también
copia la prop `fixedProjectId` al montar (`BoardView.tsx:24`). Como `BoardView` no se vuelve a montar al cambiar de
ruta (`App.tsx:30` sin `key`), esa copia sobrevive. Cuando la prop deja de existir, `effectiveProjectId`
(`BoardView.tsx:42`) cae en el valor copiado en lugar de `'all'`.

No hay nada que reinicie el estado cuando cambia la prop. `tests/ui/board/board.test.tsx` prueba el proyecto fijo
(línea 191) y el selector (línea 206) por separado, nunca el paso de uno a otro con `rerender`.

## Solución posible
No sembrar el filtro libre con la prop. En `BoardView.tsx:24`:

```tsx
const [selectedProjectId, setSelectedProjectId] = useState<string>('all');
```

Con la ruta de proyecto, `effectiveProjectId` ya usa `fixedProjectId` (`BoardView.tsx:42`), y el selector deshabilitado
sigue mostrando ese proyecto (`selectedKey={effectiveProjectId}`, `BoardView.tsx:76`). El estado solo se usa en el
Tablero general, que arranca en «Todos los proyectos». Si el usuario eligió otro filtro en el general, entra al
tablero de un proyecto y vuelve, se conserva lo que había elegido. Es un cambio de una línea y no remonta nada.

### Otras opciones
Esta propuesta no es la única, y puede haber una más optimizada.
- **Dar `key` al tablero en `App.tsx:30`** (por ejemplo `key={`b:${route.projectId ?? ''}`}`), igual que el chat. Cada
  cambio de ruta monta un tablero nuevo. Es simple, pero se pierde el filtro elegido en el general y se cierra el
  detalle de tarea abierto (`selectedTaskId`, `BoardView.tsx:26`) al cambiar de proyecto.
- **Reajustar el estado cuando cambia la prop**, guardando la prop anterior en un estado y comparándola durante el
  render (el patrón de React para «ajustar estado al cambiar una prop»). Un `useEffect` también sirve, pero pinta un
  cuadro con el filtro viejo.
- **Llevar el filtro del general a la URL** (por ejemplo `#/tablero?proyecto=<id>`). Así se puede compartir y sobrevive
  a una recarga, pero hay que tocar `parseRoute` (`routes.ts:21` parte por `/` sin quitar la consulta) y `routeHash`.
- **Lo que propuso agy** (habilitar el selector en `#/tablero/<id>` y navegar con `navigate({ name: 'board', projectId })`)
  solo tendría sentido si se decide que el tablero de un proyecto deje de estar acotado. Contradice lo acordado en el
  issue 09 y no hace falta para corregir este fallo.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: en `tests/ui/board/board.test.tsx`, nuevo escenario «el tablero general muestra todos
  al llegar desde el de un proyecto». Hacer `const { rerender } = render(<BoardView projectId="proj-alpha" />)`,
  comprobar que no está «Tarea pendiente Beta», y luego `rerender(<BoardView />)`. Debe afirmar que se ven
  «Tarea pendiente Alfa» y «Tarea pendiente Beta», y que el disparador «Elegir proyecto para filtrar» muestra
  «Todos los proyectos». Otro caso con A, luego B y luego todos: `rerender(<BoardView projectId="proj-beta" />)` y
  después `rerender(<BoardView />)`, que deben dar el mismo resultado. Un tercer caso: en `<BoardView />`, elegir
  «Proyecto Beta», hacer `rerender(<BoardView projectId="proj-alpha" />)` y luego `rerender(<BoardView />)`. Se debe
  ver solo Beta otra vez, porque se conserva la elección del general.
- Comando (WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/board/board.test.tsx"`; PowerShell en
  C:\dev\orquestador: `npx vitest run tests/ui/board/board.test.tsx`.
- Verificación manual en la app: abrir el chat de un proyecto con tareas y pulsar su icono de tablero en la barra
  lateral. Se ve solo ese proyecto y el selector está deshabilitado. Después pulsar «Tablero» arriba en la barra
  lateral. Deben verse las tareas de todos los proyectos y el selector debe decir «Todos los proyectos». Pasar de un
  proyecto a otro por sus iconos de tablero sigue mostrando cada vez el proyecto correcto.
