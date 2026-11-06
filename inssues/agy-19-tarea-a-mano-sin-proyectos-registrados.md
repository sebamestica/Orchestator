# «Nueva tarea a mano» se deja rellenar sin ningún proyecto registrado y solo avisa al pulsar «Crear tarea»

- **Área:** Interfaz
- **Severidad:** baja
- **Archivos:** `src/ui/features/board/ManualTaskDialog.tsx:46-59`, `src/ui/features/board/ManualTaskDialog.tsx:67-70`, `src/ui/features/board/ManualTaskDialog.tsx:151-165`, `src/ui/features/board/ManualTaskDialog.tsx:280-284`, `src/ui/features/board/BoardView.tsx:105-113`, `src/ui/features/board/BoardView.tsx:128-138`, `src/ui/features/board/BoardView.tsx:213-222`, `src/ui/features/home/HomeView.tsx:28`, `src/shared/api.ts:527-528`
- **Estado:** resuelta
- **Origen:** revisión de agy, verificada por Claude

## Cómo ocurre
Desde el issue 12 («Conversaciones», commit 5681da2) se puede usar Berland sin abrir ninguna carpeta, así que es normal llegar al Tablero con la lista de proyectos vacía. El store arranca así (`src/ui/store/app.ts:45`, `projects: []`) y `refreshProjects` (`app.ts:68-71`) no agrega ninguno por defecto.

Pasos:
1. Abrir Berland sin proyectos registrados.
2. En la portada, pulsar «Darle una tarea a mano» (`src/ui/features/home/HomeView.tsx:28`, solo navega a `#/tablero`; eso ya lo describe agy-05). En el Tablero, pulsar «+ Tarea a mano» (`BoardView.tsx:105-113`, o el del estado vacío en `BoardView.tsx:128-138`). Ninguno de los dos botones mira `projects`.
3. Se abre «Nueva tarea a mano» con todos los campos activos. El desplegable «Proyecto *» solo tiene la opción vacía:

   `src/ui/features/board/ManualTaskDialog.tsx:159-164`
   ```tsx
   <option value="">Selecciona un proyecto</option>
   {projects.map((p) => (
   ```
4. El usuario escribe título, objetivo, rutas propias y criterios, y pulsa «Crear tarea». El botón solo se desactiva mientras se envía (`ManualTaskDialog.tsx:284`, `isDisabled={submitting}`).
5. Recién entonces aparece el aviso:

   `src/ui/features/board/ManualTaskDialog.tsx:67-70`
   ```tsx
   if (!projectId.trim()) {
     setErrorNotice('Debes seleccionar un proyecto.');
     return;
   }
   ```
   El texto pide elegir un proyecto, pero no hay ninguno que elegir, y el diálogo no ofrece forma de registrarlo. El usuario tiene que cancelar (perdiendo lo escrito), volver a la portada y abrir una carpeta.

No se pierde nada guardado ni se rompe ningún flujo: es una pérdida de tiempo y un aviso que no orienta. Por eso la severidad es baja.

## Por qué pasa
- `ManualTaskDialog` no trata el caso `projects.length === 0`. Al abrirse elige `defaultProjectId` o el primero de la lista (`ManualTaskDialog.tsx:48`, `defaultProjectId || (projects.length > 0 ? projects[0]?.id : '') || ''`). Sin proyectos queda `''` y nada más lo nota hasta el envío.
- La única comprobación es la validación al enviar (`ManualTaskDialog.tsx:67-70`), y su texto da por hecho que la lista tiene opciones.
- El contrato exige proyecto (`src/shared/api.ts:527-528`, `manualTaskBody = z.strictObject({ projectId: idSchema, ...`), así que una tarea a mano sin proyecto no es posible por diseño. La interfaz debería avisarlo antes de que el usuario escriba, no después.
- `BoardView` monta el diálogo y le pasa `projects` (`BoardView.tsx:213-222`) sin mirar si la lista está vacía.

Lo que agy tenía bien y mal: el diagnóstico y las líneas 48-49 y 67-70 son correctas. El `<select>` va de la 151 a la 165, no de la 158 a la 166. Y el aviso sale aunque los demás campos estén vacíos, porque el proyecto es lo primero que se valida. No hace falta rellenarlos para verlo.

## Solución posible
Mostrar el caso dentro del propio diálogo, sin cambiar rutas:

1. En `ManualTaskDialog.tsx`, con `const sinProyectos = projects.length === 0;`, pintar arriba del formulario (junto al `errorNotice` de `ManualTaskDialog.tsx:136-144`) un aviso informativo, no de error: «Para crear una tarea hace falta un proyecto. Abre primero una carpeta local.» Agregar un botón «Abrir una carpeta» que cierre el diálogo y lleve a la portada (`navigate({ name: 'home' })`), o que abra `AddProjectDialog`.
2. Con `sinProyectos`, desactivar «Crear tarea» (`ManualTaskDialog.tsx:284`: `isDisabled={submitting || sinProyectos}`) y el `<select>` de proyecto, para que no se pueda llegar al aviso de error.
3. Cambiar el texto de `ManualTaskDialog.tsx:68` por uno que sirva en los dos casos, o dejarlo como está, porque con el paso 2 ya no se ve cuando no hay proyectos.

Cuidado si se abre `AddProjectDialog` desde el diálogo para no perder lo escrito:
- `AddProjectDialog` navega a la página del proyecto al terminar (`src/ui/features/projects/AddProjectDialog.tsx:53`, `navigate({ name: 'project', projectId: result.project.id }); onClose();`), lo que saca al usuario del Tablero.
- `refreshProjects` (`AddProjectDialog.tsx:52`) cambia la referencia de `projects` en el store, y el `useEffect` de `ManualTaskDialog.tsx:46-59` depende de `projects` y vacía el formulario mientras está abierto (`setTitle('')`, `setObjective('')`, ...).

Por eso lo más sencillo es avisar antes de que el usuario escriba y no intentar registrar el proyecto desde el diálogo.

### Otras opciones
Esta propuesta no es la única, y puede haber una más optimizada:
- **Guiar antes de abrir el diálogo.** En `BoardView.tsx`, si `projects.length === 0`, los botones «+ Tarea a mano» abren directamente `AddProjectDialog` o muestran el aviso en el `EmptyState` del Tablero («Primero abre una carpeta»). La tarjeta de la portada (`HomeView.tsx:28`) podría hacer lo mismo, y ya tiene `AddProjectDialog` montado (`HomeView.tsx:46`). Así el usuario no ve un formulario que no puede usar.
- **Registrar el proyecto sin perder el formulario.** Dar a `AddProjectDialog` una opción para no navegar al terminar (por ejemplo `onAdded(projectId)` en vez del `navigate` de la línea 53), y que el `useEffect` de `ManualTaskDialog.tsx:46-59` se reinicie solo al abrir (depender de `isOpen`, no de `projects`). Al volver, el diálogo selecciona el proyecto nuevo y conserva lo escrito. Es la mejor experiencia, pero toca dos componentes y cambia cuándo se reinicia el formulario.
- **Mínima:** cambiar el texto de `ManualTaskDialog.tsx:68` a «Aún no hay proyectos: abre una carpeta local antes de crear una tarea a mano.» cuando `projects.length === 0`. Orienta mejor, pero el usuario sigue escribiendo en vano.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: en `tests/ui/board/board.test.tsx`, nuevo escenario «sin proyectos, el diálogo de tarea a mano avisa y no deja crear». Se hace `useApp.setState({ projects: [] })` antes de `render(<BoardView />)`, se pulsa el botón «Abrir diálogo de tarea a mano» y se afirma que:
  - aparece el aviso de que hace falta un proyecto, con el botón para abrir una carpeta;
  - el botón «Crear tarea manual» está desactivado;
  - pulsar «Crear tarea manual» no llama a `mockFetch` y no muestra «Debes seleccionar un proyecto.».

  Agregar un control inverso: con `mockProjects` (el `beforeEach` actual) el aviso no aparece y el escenario de envío de la línea 351 sigue pasando.
- Comando (WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/board/board.test.tsx"`; PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/board/board.test.tsx`.
- Verificación manual en la app: con Berland sin proyectos (o con un perfil de datos vacío), ir a `#/tablero` y pulsar «+ Tarea a mano». Debe verse de inmediato el aviso y el botón para abrir una carpeta, con «Crear tarea» desactivado. Abrir una carpeta, volver al Tablero y pulsar «+ Tarea a mano»: el proyecto queda preseleccionado (`ManualTaskDialog.tsx:48`), el aviso ya no aparece y la tarea se crea normalmente.
