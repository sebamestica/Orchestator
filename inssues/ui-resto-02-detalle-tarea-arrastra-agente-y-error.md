# El detalle de una tarea arrastra el agente elegido y el aviso de error de la tarea anterior, y puede aprobar otra tarea con ese agente

- **Área:** Interfaz: tablero, panel, ajustes
- **Severidad:** media
- **Archivos:** `src/ui/features/board/BoardView.tsx:202`, `src/ui/features/board/TaskDetailModal.tsx:31`, `src/ui/features/board/TaskDetailModal.tsx:32`, `src/ui/features/board/TaskDetailModal.tsx:35`, `src/ui/features/board/TaskDetailModal.tsx:48`, `src/ui/features/board/TaskDetailModal.tsx:234`, `src/core/server/app.ts:248`, `src/core/app/fleet-service.ts:321`
- **Estado:** resuelta

## Cómo ocurre

En el Tablero (`BoardView`), al pulsar una tarjeta se guarda su id en `selectedTaskId` y se abre `TaskDetailModal`. Si la tarea está Pendiente, el detalle muestra el selector «Asignar a un agente al aprobar (opcional)» y el botón «Aprobar». El agente que se elige ahí no es solo una sugerencia: el núcleo lo guarda en la tarea (`store.setTaskState(task.task.id, 'ready', agentId)`, `src/core/server/app.ts:248`) y la flota lo usa como `suggestedAgent` de esa tarea (`src/core/app/fleet-service.ts:321`), en lugar del que sugirió la mente.

`BoardView` deja el modal siempre montado en el mismo sitio del árbol, aunque no haya ninguna tarea seleccionada:

```tsx
// src/ui/features/board/BoardView.tsx:202-205
<TaskDetailModal
  task={selectedTask}
  isOpen={Boolean(selectedTask)}
  onClose={() => setSelectedTaskId(null)}
```

El modal guarda su estado en esa instancia, y con el detalle cerrado devuelve `null` sin reiniciarlo:

```tsx
// src/ui/features/board/TaskDetailModal.tsx:31-35
const [selectedAgent, setSelectedAgent] = useState<string>('');
const [errorNotice, setErrorNotice] = useState<string | null>(null);
const [submitting, setSubmitting] = useState(false);

if (!task || !isOpen) return null;
```

Pasos:

1. En el Tablero, abre una tarea Pendiente A y elige un agente en «Asignar a un agente al aprobar» (por ejemplo `codex-1`).
2. Cierra el detalle con «Cerrar» (`TaskDetailModal.tsx:268`, que solo llama a `onClose`), con la X o fuera del modal. También pasa si apruebas A: `handleApprove` llama a `onClose()` (línea 51), pero nunca vacía `selectedAgent`.
3. Abre otra tarea Pendiente B. El selector (`value={selectedAgent}`, línea 234) sigue mostrando `codex-1`, aunque para B no elegiste nada.
4. Pulsa «Aprobar» en B. La línea 48 arma el cuerpo con ese agente:
   ```ts
   const body = selectedAgent.trim() ? { agentId: selectedAgent.trim() } : {};
   ```
   B se aprueba con `{"agentId":"codex-1"}` y ese agente queda fijado en B, en vez de `{}`, que habría dejado el agente sugerido.

Con el aviso de error pasa lo mismo. Si aprobar o cancelar A falla (por ejemplo un 409), aparece «Aviso: Error 409 (conflict) al aprobar la tarea…» (líneas 54 y 72). Al cerrar y abrir B, ese aviso sigue arriba (líneas 141-149), porque `errorNotice` solo se borra al empezar otra acción (líneas 47, 66 y 84).

Hay una variante con una petición en curso. «Cerrar» no se desactiva mientras `submitting` está activo (líneas 265-272). Si cierras A mientras su aprobación todavía viaja y abres B, cuando A responde se ejecutan sobre la misma instancia, que ahora muestra B, `setErrorNotice(...)` (el error de A aparece en el detalle de B) o `onClose()` (el detalle de B se cierra solo). Además, mientras no llega la respuesta, los botones de B siguen desactivados por el `submitting` de A.

Las pruebas actuales (`tests/ui/board/board.test.tsx:235` y `:296`) abren una sola tarea por prueba, así que no cubren este caso. Ninguno de los issues de hoy en `docs/plan/issues/` toca este estado: el 03 (`03-reactivar-agentes.md`) agregó el reintento al detalle, pero no reinicia el estado al cambiar de tarea.

## Por qué pasa

`TaskDetailModal` está siempre montado en la misma posición, sin `key`. Por eso React reutiliza la instancia en cada apertura y conserva `selectedAgent`, `errorNotice` y `submitting` entre tareas. El `return null` de `TaskDetailModal.tsx:35` solo oculta el contenido: la instancia no se desmonta. Ni `onClose` (`BoardView.tsx:205`) ni el cambio de `task.task.id` limpian ese estado. Y las funciones `handleApprove`, `handleCancel` y `handleRetry` no comprueban, al terminar, si el detalle sigue mostrando la misma tarea.

## Solución posible

En `src/ui/features/board/BoardView.tsx`, montar el modal solo cuando hay una tarea seleccionada, con una `key` que dependa de esa tarea. Así cada apertura empieza con el estado limpio:

```tsx
{selectedTask && (
  <TaskDetailModal
    key={selectedTask.task.id}
    task={selectedTask}
    isOpen
    onClose={() => setSelectedTaskId(null)}
    agents={agents}
    onTaskUpdated={() => { void refreshTasks(); }}
  />
)}
```

Con esto, al cerrar se desmonta la instancia y, al abrir otra tarea, `selectedAgent` vuelve a `''`, `errorNotice` a `null` y `submitting` a `false`. Una respuesta tardía de A ya no puede pintar un error ni cerrar el detalle de B, porque llega a una instancia desmontada. En React 19, un `setState` sobre un componente desmontado no hace nada. El `onClose()` de esa instancia vieja sí podría ejecutarse, así que conviene que `handleApprove`, `handleCancel` y `handleRetry` comprueben una referencia `mounted` (o un `AbortController` que se cancele al desmontar) antes de llamar a `onClose()` y `onTaskUpdated()`.

### Otras opciones

- Dentro de `TaskDetailModal.tsx`, un `useEffect` que vuelva a poner `selectedAgent=''`, `errorNotice=null` y `submitting=false` cuando cambia `task?.task.id` o `isOpen`. El cambio queda dentro del modal, pero hay un render con el estado viejo antes de que se ejecute el efecto, y no resuelve la respuesta tardía de A.
- Subir `selectedAgent` y `errorNotice` a `BoardView` y limpiarlos en `onClose` y al elegir otra tarjeta. Funciona, pero reparte el estado del detalle entre dos componentes.
- Usar la `key` sin desmontar el modal al cerrarlo, para conservar la animación de salida de HeroUI. Habría que comprobar si `ModalBackdrop` anima la salida cuando el contenido se desmonta.

La `key` es lo más corto y cubre los tres estados a la vez, pero no es la única opción. Si importa la animación de cierre, una variante con `useEffect` y una referencia de «tarea activa» puede encajar mejor.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta: en `tests/ui/board/board.test.tsx`, que ya tiene dos tareas pendientes en el mock (`t-pending-1` y `t-pending-beta`) y el agente `codex-1`, agregar:
  1. «el agente elegido en una tarea no pasa a la siguiente»: `render(<BoardView />)`, clic en `/Tarea t-pending-1/i`, `fireEvent.change(getByLabelText('Asignar agente'), { target: { value: 'codex-1' } })`, clic en el botón «Cerrar detalle», clic en `/Tarea t-pending-beta/i`. Afirmar que `getByLabelText('Asignar agente')` tiene `value === ''`. Después, clic en «Aprobar tarea» y afirmar que `mockFetch` se llamó con `'http://127.0.0.1:47811/tasks/t-pending-beta/approve'` y `body: JSON.stringify({})`.
  2. «el aviso de error no pasa a otra tarea»: `mockFetch.mockResolvedValueOnce({ ok: false, status: 409, text: async () => JSON.stringify({ error: { code: 'conflict', message: 'x' } }) })`. Abrir `t-pending-1`, aprobar y esperar a `getByRole('alert')`. Cerrar con «Cerrar detalle», abrir `t-pending-beta` y afirmar que `queryByRole('alert')` es `null`.
  3. (Opcional) Respuesta tardía: un `fetch` cuya promesa se resuelve a mano. Abrir A, aprobar, cerrar y abrir B. Resolver con un error y afirmar que el detalle de B no muestra alerta. Resolver con éxito y afirmar que el detalle de B sigue abierto.
- Comando para correrla (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/board/board.test.tsx"` (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/board/board.test.tsx`).
- Verificación manual en la app: en el Tablero, abre una tarea Pendiente, elige un agente y cierra. Abre otra Pendiente: el selector debe decir «Predeterminado / Sugerido (…)» y no debe haber aviso rojo. Al aprobarla, la tarea debe tomar el agente sugerido, no el que elegiste para la anterior.
