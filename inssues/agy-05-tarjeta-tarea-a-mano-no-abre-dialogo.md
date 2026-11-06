# La tarjeta «Darle una tarea a mano» de la portada lleva al Tablero pero no abre el diálogo de la tarea

- **Área:** Interfaz
- **Severidad:** baja
- **Archivos:** `src/ui/features/home/HomeView.tsx:28`, `src/ui/app/routes.ts:12`, `src/ui/app/routes.ts:30-33`, `src/ui/app/routes.ts:60-61`, `src/ui/app/App.tsx:29-30`, `src/ui/features/board/BoardView.tsx:27`, `src/ui/features/board/BoardView.tsx:105-113`, `src/ui/features/board/BoardView.tsx:213-222`, `src/ui/features/board/ManualTaskDialog.tsx:61`
- **Estado:** abierta
- **Origen:** revisión de agy, verificada por Claude

## Cómo ocurre
La portada (`#/`, «Retoma donde quedaste») ofrece cuatro tarjetas de acción. Tres hacen lo que dicen: «Abrir una carpeta local» abre su diálogo ahí mismo y «Conversaciones» abre el chat sin proyecto. «Darle una tarea a mano» solo cambia de vista:

`src/ui/features/home/HomeView.tsx:28`
```tsx
<ActionCard icon={<ListPlus className="size-[18px]" />} label="Darle una tarea a mano" onClick={() => navigate({ name: 'board' })} />
```

Pasos:
1. Abrir Berland en la portada (`#/`).
2. Hacer clic en «Darle una tarea a mano».
3. Se abre el Tablero (`#/tablero`) con el diálogo «Nueva tarea a mano» cerrado. Hay que volver a pulsar «+ Tarea a mano» arriba a la derecha (o el del estado vacío) para crear la tarea.

No se pierde nada ni se rompe ningún flujo: es un clic de más y una acción que no cumple lo que anuncia. Por eso la severidad es baja y no media, como proponía agy.

## Por qué pasa
- El Tablero guarda en un estado local si el diálogo está abierto, y siempre arranca en `false`: `src/ui/features/board/BoardView.tsx:27` `const [manualDialogOpen, setManualDialogOpen] = useState(false);`. Solo lo abren los botones del propio Tablero (`BoardView.tsx:105-113`, `onPress={() => setManualDialogOpen(true)}`, y el del estado vacío en `BoardView.tsx:128-138`). El diálogo se monta en `BoardView.tsx:213-222` con `isOpen={manualDialogOpen}`, y `ManualTaskDialog.tsx:61` no pinta nada mientras `isOpen` sea falso.
- La ruta del Tablero no tiene forma de pedir «abre el diálogo». `src/ui/app/routes.ts:12` define `{ name: 'board'; projectId?: string }`, `routes.ts:30-33` solo lee el `projectId` y `routes.ts:60-61` solo lo serializa. `App.tsx:30` pasa a `BoardView` únicamente `projectId`.
- La portada no tiene otro canal: no pone ninguna señal en el store ni abre el diálogo ella misma.

Lo que agy tenía mal: el arreglo `#/tablero?nueva=1` no funciona con el analizador actual. `parseRoute` (`routes.ts:21`) parte el fragmento por `/` sin quitar la consulta, así que `#/tablero?nueva=1` da `a = 'tablero?nueva=1'`, no entra en `case 'tablero'` y cae en la portada (`routes.ts:47-48`). Hay que tocar también `parseRoute`.

## Solución posible
Llevar la intención en la ruta y que el Tablero la atienda:

1. `routes.ts`: ampliar la ruta a `{ name: 'board'; projectId?: string; nueva?: true }`. En `routeHash` añadir `?nueva` cuando venga. En `parseRoute` separar la consulta (`hash.split('?')`) antes de partir por `/`, y devolver `nueva: true` si aparece. Hay que mantener el sufijo `&t=…` del token (commit 558b04a) y el ida y vuelta de `tests/ui/routes.test.tsx`.
2. `App.tsx:30`: pasar `openManual={route.nueva === true}` a `BoardView`.
3. `BoardView.tsx`: abrir el diálogo cuando `openManual` es verdadero. Con un `useEffect` sobre la prop y no solo con el valor inicial de `useState`: `App.tsx:30` no le da `key` al Tablero, así que pasar de `#/tablero` a `#/tablero?nueva` no lo vuelve a montar. Al cerrar o crear, quitar la marca con `navigate({ name: 'board', projectId }, { replace: true })`, para que recargar o volver atrás no reabra el diálogo.
4. `HomeView.tsx:28`: `navigate({ name: 'board', nueva: true })`.

### Otras opciones
Esta propuesta no es la única, y puede haber una más optimizada:
- **Abrir el diálogo en la portada**, igual que `AddProjectDialog` (`HomeView.tsx:46`). `ManualTaskDialog` ya recibe todo por props (`projects`, `agents`, `onCreated`), y al crear se puede navegar al Tablero. No toca las rutas. Hay que importarlo con `lazy` para no meter el código del Tablero en la carga inicial de la portada (`App.tsx:15-17` lo separa a propósito).
- **Una marca de un solo uso en el store de zustand** (`openManualTask`): la portada la pone antes de navegar y el Tablero la consume al montarse. Es sencillo, pero la intención no queda en la URL y hay que acordarse de limpiarla.
- **Mínima:** renombrar la tarjeta a algo como «Ir al tablero». Así el texto deja de prometer el diálogo, aunque se pierde el atajo.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta:
  - `tests/ui/routes.test.tsx`: añadir `{ name: 'board', nueva: true }` y `{ name: 'board', projectId: 'orquestador', nueva: true }` a los casos de ida y vuelta, y comprobar que `parseRoute('#/tablero?nueva')` devuelve `{ name: 'board', nueva: true }` y no `{ name: 'home' }`.
  - `tests/ui/board/board.test.tsx`: nuevo escenario «abre el diálogo de tarea a mano si llega con openManual». Se renderiza `<BoardView openManual />` y se afirma que `screen.getByText('Nueva tarea a mano')` está presente sin pulsar ningún botón. Tras cerrarlo, no debe reabrirse.
  - Opcional, `tests/ui/home/home.test.tsx` (nuevo): al pulsar «Darle una tarea a mano», `window.location.hash` queda en `#/tablero?nueva`.
- Comando (WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/routes.test.tsx tests/ui/board/board.test.tsx"`; PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/routes.test.tsx tests/ui/board/board.test.tsx`.
- Verificación manual en la app: desde `#/`, pulsar «Darle una tarea a mano». Debe abrirse el Tablero con «Nueva tarea a mano» ya visible. Al cerrarlo, la barra queda en `#/tablero`, y recargar o ir atrás y adelante no lo reabre. Los botones «+ Tarea a mano» del Tablero siguen funcionando como antes.
