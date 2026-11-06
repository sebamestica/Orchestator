# El detalle de una tarea en el Tablero muestra el estado en inglés crudo («pending», «handed_off»…)

- **Área:** Interfaz
- **Severidad:** baja
- **Archivos:** `src/ui/features/board/TaskDetailModal.tsx:103-105`, `src/ui/features/board/types.ts:9-17`, `src/ui/features/board/types.ts:35`, `src/ui/features/board/TaskCard.tsx:69-73`, `src/shared/tasks.ts:22`
- **Estado:** resuelta
- **Origen:** revisión de agy, verificada por Claude

## Cómo ocurre
Toda la interfaz del Tablero está en español: las columnas se llaman «Pendiente», «Lista», «En curso», «Revisión»… y la dificultad del mismo modal se traduce con `difficultyLabel`. El chip de estado de la cabecera del modal es la excepción, porque pinta el valor tal como llega del núcleo.

Pasos:
1. Abrir el Tablero (`#/tablero`).
2. Hacer clic en cualquier tarjeta para abrir su detalle (`BoardView.tsx:202` monta `TaskDetailModal`).
3. En la cabecera, a la izquierda del chip de dificultad (que sí dice «Baja», «Media» o «Alta»), el chip de estado dice `pending`, `ready`, `running`, `review`, `integrated`, `failed`, `handed_off` o `cancelled`.

Evidencia:
- `src/ui/features/board/TaskDetailModal.tsx:103-105`:
  ```tsx
  <Chip size="sm" variant="soft">
    {task.state}
  </Chip>
  ```
- Justo debajo, `TaskDetailModal.tsx:106-108` sí traduce la dificultad: `{difficultyLabel(brief.difficulty)}`.
- Los valores posibles salen de `src/shared/tasks.ts:22`: `z.enum(['pending', 'ready', 'running', 'review', 'integrated', 'failed', 'handed_off', 'cancelled'])`.

Corrección sobre el reporte original: agy decía que `BOARD_COLUMNS` ya trae la etiqueta «Traspasada». No es así. En `types.ts:12`, `handed_off` está dentro de la columna «En curso» (`states: ['running', 'handed_off']`), y «Traspasada» solo aparece escrita a mano en el chip de la tarjeta (`TaskCard.tsx:69-73`). Tampoco hay en `src/ui` ningún diccionario de estados que se pueda reutilizar tal cual.

## Por qué pasa
`TaskDetailModal` renderiza `task.state` directamente y no existe un traductor de estados equivalente a `difficultyLabel` (`types.ts:35`). Los textos en español de los estados están repartidos entre los títulos de columna de `BOARD_COLUMNS` y el chip «Traspasada» de `TaskCard`, y el modal no usa ninguno de los dos.

## Solución posible
Añadir en `src/ui/features/board/types.ts`, junto a `difficultyLabel`, un mapa con tipo exhaustivo sobre `TaskState`, para que TypeScript avise si mañana aparece un estado nuevo sin traducir:

```ts
import type { TaskState } from '../../../shared/tasks.ts'; // o el tipo equivalente que exponga api/types.ts
export const TASK_STATE_LABEL: Record<TaskState, string> = {
  pending: 'Pendiente', ready: 'Lista', running: 'En curso', review: 'Revisión',
  integrated: 'Integrada', failed: 'Fallida', handed_off: 'Traspasada', cancelled: 'Cancelada',
};
export function taskStateLabel(state: string): string {
  return TASK_STATE_LABEL[state as TaskState] ?? state;
}
```

Después, en `TaskDetailModal.tsx:104`, usar `{taskStateLabel(task.state)}`. Si se quiere que todo salga de una sola fuente, `TaskCard.tsx:71` puede usar la misma función para «Traspasada».

### Otras opciones
Esta propuesta no es la única y puede haber una mejor.
- Sacar la etiqueta de los títulos de `BOARD_COLUMNS` buscando la columna que contiene el estado. Es corto, pero `handed_off` saldría como «En curso» y se perdería la distinción que la tarjeta sí muestra. Habría que tratar ese caso aparte.
- Poner las etiquetas en `src/shared` (junto a `taskStateSchema`) para que el CLI, el panel derecho u otras vistas usen los mismos textos. Tiene sentido si más pantallas acaban mostrando estados.
- Además del texto, dar al chip un `color` por estado (por ejemplo `danger` para `failed` y `warning` para `handed_off`), igual que `TaskCard` colorea la dificultad con `diffColor`.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: en `tests/ui/board/board.test.tsx`, un caso nuevo, «el modal de detalle muestra el estado en español». Abre la tarjeta de `t-pending-1` (como hace el caso de la línea 235) y afirma que `within(dialog).getByText('Pendiente')` existe y que `within(dialog).queryByText('pending')` es `null`. Si el fixture trae una tarea `handed_off`, se repite el caso con ella y se espera «Traspasada». También conviene un test unitario de `taskStateLabel` que recorra `taskStateSchema.options` y compruebe que ningún estado devuelve el mismo valor en inglés.
- Comando (WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/board/board.test.tsx"`; PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/board/board.test.tsx`.
- Verificación manual en la app: abrir el Tablero y el detalle de tareas en varios estados (pendiente, en curso, traspasada, fallida, integrada). El chip de estado tiene que salir en español y coincidir con la columna, salvo la traspasada, que debe decir «Traspasada».
