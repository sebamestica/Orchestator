# «Menos efectos» deja el desenfoque del tablero y no detiene ninguna animación

- **Área:** Interfaz: tablero, panel, ajustes
- **Severidad:** baja
- **Archivos:** `src/ui/features/settings/GeneralSection.tsx:42`, `src/ui/app/App.tsx:93`, `src/ui/styles/index.css:82`, `src/ui/styles/index.css:118`, `src/ui/styles/index.css:175`, `src/ui/styles/index.css:267`, `src/ui/features/board/BoardView.tsx:65`, `src/ui/features/board/BoardView.tsx:153`, `src/ui/features/agents-panel/activity.css:9`, `src/ui/features/agents-panel/ActivityRowView.tsx:8`, `src/ui/features/agents-panel/ActivityRowView.tsx:21`, `src/ui/features/home/HomeView.tsx:22`, `src/ui/features/chat/components/EmptyChat.tsx:27`, `src/ui/features/chat/components/LiveReply.tsx:144`
- **Estado:** abierta

## Cómo ocurre

En Ajustes › General hay un interruptor que promete dos cosas (`GeneralSection.tsx:42-43`):

```tsx
label="Menos efectos"
description="Quita el desenfoque de vidrio y las animaciones largas. Ahorra GPU."
```

Al activarlo, `useAppearance` marca la raíz del documento (`src/ui/app/App.tsx:93`):

```ts
root.dataset.effects = appearance.reducedEffects ? 'reduced' : 'full';
```

Ese atributo solo se usa en una regla de CSS, que anula una variable (`src/ui/styles/index.css:82-85`):

```css
[data-effects="reduced"] {
    --glass-backdrop: none;
}
```

La variable la leen `.glass-surface` y las clases de HeroUI (`.modal__dialog`, `.popover`, `.tooltip`, etc.) en `index.css:118-136`, y también `.drop-overlay` (`index.css:261-262`). Con eso el vidrio de HeroUI sí se apaga. Lo que queda fuera:

1. **El desenfoque del tablero.** La cabecera y cada una de las 7 columnas (`BOARD_COLUMNS` en `src/ui/features/board/types.ts:10-16`) usan la utilidad de Tailwind `backdrop-blur-md`, que pone `blur(12px)` por su cuenta y no lee `--glass-backdrop`:

   ```tsx
   // BoardView.tsx:65
   <header className="... bg-[var(--surface)] px-6 py-4 backdrop-blur-md">
   // BoardView.tsx:153
   className="flex flex-col ... bg-[var(--dashboard-surface)] backdrop-blur-md p-3 ..."
   ```

   Pasos: activar «Menos efectos», abrir el tablero y mirar en DevTools › Elements › Computed el `header` o cualquier `section[aria-label^="Columna"]`. `backdrop-filter` sigue en `blur(12px)`. Son 8 capas de desenfoque que el ajuste no apaga.

   El reporte original incluía también los diálogos (`TaskDetailModal.tsx:98`, `ManualTaskDialog.tsx:124`). Eso no se cumple. `ModalDialog` recibe la clase `modal__dialog` (slot `dialog` en `node_modules/@heroui/styles/dist/components/modal/modal.styles.js`). La regla `.modal__dialog { backdrop-filter: var(--glass-backdrop) }` de `index.css:131-135` está fuera de toda `@layer`, y en Tailwind 4 `backdrop-blur-md` va en `@layer utilities`. Las reglas sin capa ganan a las que tienen capa, así que en los diálogos manda la variable y el ajuste sí funciona. Ahí `backdrop-blur-md` no hace nada.

2. **Las animaciones.** No hay ninguna regla `[data-effects="reduced"]` para animaciones ni transiciones. Solo se detienen con la preferencia del sistema `prefers-reduced-motion`, sea por `@media` o con la variante `motion-reduce:`:
   - Barra infinita del panel de agentes: `.agent-activity { animation: agent-activity 1.8s linear infinite; }` (`activity.css:9`), usada en `ActivityRowView.tsx:21`. Solo se apaga con `@media (prefers-reduced-motion)` (`activity.css:11-13`).
   - Anillo que gira y punto que late: `animate-spin motion-reduce:animate-none` y `animate-pulse motion-reduce:animate-none` (`ActivityRowView.tsx:8` y `:10`). El mismo patrón aparece en `chat/components/BackgroundLine.tsx:19` y `composer/AttachmentTray.tsx:19`.
   - «Pensando…» con `animate-pulse` sin ninguna guardia (`chat/components/LiveReply.tsx:144`), igual que `chat/components/AttachmentThumb.tsx:52`.
   - Entrada de página `.animate-enter` (`index.css:175-177`), la más larga (560 ms, `--duration-page`), que además anima `filter: blur(6px)` (`index.css:162-173`). Se usa en `HomeView.tsx:22` y `EmptyChat.tsx:27`, y solo se apaga en `@media (prefers-reduced-motion)` (`index.css:267-271`).

   Pasos: con «Menos efectos» activo y la preferencia de Windows de animaciones encendida (lo normal), abrir un proyecto con un agente activo. En el panel derecho la barra verde inferior sigue corriendo y el punto sigue latiendo. En DevTools, `.agent-activity` tiene `animation-name: agent-activity`.

En un PC con la GPU y la CPU justas, que es justo para lo que existe el ajuste, este no cumple ninguna de las dos promesas en el tablero ni en el panel.

## Por qué pasa

El ajuste se implementó como una sola variable CSS (`--glass-backdrop`). Funciona con lo que lee esa variable, pero:

- El tablero usa `backdrop-blur-md` puesto a mano en vez de `glass-surface`, así que no pasa por la variable.
- Ninguna animación depende de `data-effects`. Todas las guardias que existen usan `prefers-reduced-motion` (`index.css:267`, `activity.css:11`, variantes `motion-reduce:`), que es la preferencia de Windows y no el ajuste de Berland.

## Solución posible

1. `src/ui/features/board/BoardView.tsx:65` y `:153`: quitar `backdrop-blur-md`. El tablero entero está sobre `bg-[var(--canvas)]` opaco (`BoardView.tsx:63`) y nada se desplaza por debajo de la cabecera ni de las columnas. Por eso el desenfoque no se ve y solo gasta GPU. Si se quiere mantener el aspecto de vidrio, cambiarlo por `glass-surface`, que sí respeta la variable. Para dejar el código limpio, quitarlo también de `TaskDetailModal.tsx:98` y `ManualTaskDialog.tsx:124`, donde ya lo anula `.modal__dialog`.
2. `src/ui/styles/index.css`: después de la regla de `index.css:82-85`, agregar una regla sin capa con la misma intención que el bloque `prefers-reduced-motion`:

   ```css
   [data-effects="reduced"] .animate-enter,
   [data-effects="reduced"] .drop-overlay,
   [data-effects="reduced"] .agent-activity,
   [data-effects="reduced"] .agent-change,
   [data-effects="reduced"] .animate-spin,
   [data-effects="reduced"] .animate-pulse {
       animation: none;
   }
   ```

   Como la regla no tiene capa, gana a las utilidades `animate-*` de Tailwind sin usar `!important`. `activity.css` también está fuera de capa, pero la nueva regla tiene más especificidad (atributo más clase), así que también gana a `.agent-activity`.

### Otras opciones

- Una variante de Tailwind `@custom-variant reduced (&:where([data-effects="reduced"], [data-effects="reduced"] *));` en `index.css`, y escribir `reduced:animate-none reduced:backdrop-blur-none` junto a cada `motion-reduce:`. Es más explícito por componente, pero hay que acordarse de ponerlo en cada pieza nueva. La regla global de arriba cubre también lo que se agregue después con las mismas clases.
- Juntar las dos fuentes, el ajuste y la preferencia del sistema: con `matchMedia('(prefers-reduced-motion: reduce)')`, `useAppearance` pone `data-effects="reduced"` también cuando Windows pide menos movimiento. Así queda una sola guardia en CSS y se pueden quitar los `motion-reduce:` repartidos.
- Si no se quiere tocar ninguna animación, ajustar el texto del interruptor a lo que hace de verdad («Quita el desenfoque de vidrio»). Es lo más barato, aunque deja sin resolver el gasto de las animaciones infinitas.

La propuesta no es la única. La opción de juntar ajuste y sistema es probablemente la más ordenada a largo plazo, porque elimina guardias duplicadas.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta: `tests/ui/settings/reduced-effects.test.ts`. jsdom no resuelve la cascada de Tailwind, así que conviene una prueba estática con `node:fs`:
  1. Lee `src/ui/styles/index.css` y comprueba que hay una regla `[data-effects="reduced"]` que pone `animation: none` a `.animate-enter`, `.agent-activity`, `.animate-spin` y `.animate-pulse`.
  2. Recorre los `.tsx` de `src/ui` y afirma que ninguno usa `backdrop-blur-` (todo el desenfoque pasa por `--glass-backdrop`).
  3. Opcional, con `@testing-library/react`: renderiza `ActivityRowView` con `row.active: true`, pone `document.documentElement.dataset.effects = 'reduced'` y comprueba que la barra lleva la clase `agent-activity`, para que la prueba falle si cambia el nombre de la clase y la regla deja de aplicar.
- Comando (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/settings/reduced-effects.test.ts"` (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/settings/reduced-effects.test.ts`).
- Verificación manual en la app: activar Ajustes › General › «Menos efectos» con las animaciones de Windows encendidas. En el tablero, DevTools › Computed del `header` y de cada `section[aria-label^="Columna"]` debe dar `backdrop-filter: none`. En el panel derecho, con un agente activo, la barra verde inferior y el punto deben quedar quietos (`animation-name: none` en `.agent-activity`). Al desactivar el ajuste, todo debe volver a moverse.
