# Cada fila del panel «Agentes en vivo» es una parada de Tab que no hace nada

- **Área:** Interfaz
- **Severidad:** baja
- **Archivos:** `src/ui/features/agents-panel/ActivityRowView.tsx:6`, `src/ui/features/agents-panel/AgentsPanel.tsx:80`, `src/ui/features/agents-panel/AgentsPanel.tsx:82-92`, `src/ui/app/App.tsx:105`, `src/ui/app/App.tsx:132`, `src/ui/features/composer/Composer.tsx:196`, `tests/ui/agents-panel/AgentsPanel.test.tsx:77-87`
- **Estado:** resuelta
- **Origen:** revisión de agy, verificada por Claude

## Cómo ocurre
El panel derecho pinta una fila fija para la mente y otra por cada agente habilitado (`AgentsPanel.tsx:83` y `:87-91`). Todas usan `ActivityRowView`, cuyo contenedor recibe el foco del teclado y dibuja un anillo de foco, pero no tiene ninguna acción:

```tsx
// src/ui/features/agents-panel/ActivityRowView.tsx:6
<article aria-label={name} tabIndex={0} className="... focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground">
```

No hay `onClick`, `onKeyDown` ni `role` interactivo. Dentro solo hay texto: el punto de estado, el nombre, el estado, la última acción y el aviso de cupo (`ActivityRowView.tsx:7-21`).

Pasos:
1. Con la ventana ancha (el panel lleva `hidden ... lg:flex`, `AgentsPanel.tsx:80`), abrir un proyecto, el agente suelto o el tablero. Son las rutas donde se muestra el panel (`App.tsx:105`).
2. Poner el foco en el input del chat y pulsar Tab.
3. Después de los botones del composer, el foco pasa por «Mente» y luego por cada agente habilitado. En cada fila aparece el anillo de foco, y Enter o Espacio no hacen nada.

Las paradas se notan más por dónde está el panel. Es lo último del DOM, después de `<main>` (`App.tsx:132`), y en el input Shift+Tab cambia el modo de la mente en vez de mover el foco hacia atrás (`Composer.tsx:196`). Para volver desde el input a la barra lateral o a la barra de título con el teclado hay que avanzar con Tab y cruzar todas las filas: 1 + el número de agentes habilitados.

Fue intencional: la prueba «oculta agentes deshabilitados y conserva las filas accesibles» exige `tabIndex` 0 y la clase de foco en cada fila (`tests/ui/agents-panel/AgentsPanel.test.tsx:83-85`). La idea de que hacer enfocable una fila la vuelve accesible es la que conviene revisar.

Lo que agy tenía mal: el problema no se limita a las filas de agentes, porque la fila «Mente» también se enfoca. Además, un lector de pantalla anuncia la fila como «artículo», no como botón, así que no promete una acción. Lo que molesta de verdad son las paradas de Tab vacías y el anillo de foco, que se parece al de los controles que sí responden. En el tablero, por ejemplo, la tarjeta tiene `role="button"`, `onClick` y `onKeyDown` con Enter y Espacio (`src/ui/features/board/TaskCard.tsx:53-64`).

## Por qué pasa
En el issue 4 (panel derecho) se aplicó al pie de la letra la regla de F5 «foco visible y teclado completo» (`docs/plan/F5-INTERFAZ.md:64`), y se volvió enfocable un contenido que es solo informativo. Para leer las filas no hace falta el foco. Los cambios ya se anuncian por la región `aria-live="polite"` de cada fila (`ActivityRowView.tsx:14`), y el lector de pantalla recorre el texto con su propio cursor.

## Solución posible
1. En `ActivityRowView.tsx:6`, quitar `tabIndex={0}` y las clases `focus-visible:*` del `<article>`. Se mantienen `aria-label` y la región `aria-live`.
2. La lista tiene scroll propio (`AgentsPanel.tsx:82`, `overflow-y-auto`). Para que se pueda desplazar con el teclado cuando haya muchos agentes, dar una sola parada a ese contenedor: `tabIndex={0}`, `aria-label` (por ejemplo «Lista de agentes») y su propio `focus-visible`. Así quedan una parada en vez de 1 + N. Chromium reciente ya enfoca solo un contenedor con scroll que no tiene hijos enfocables, pero la interfaz también se abre en el navegador, así que conviene no depender de eso.
3. Actualizar la prueba de `AgentsPanel.test.tsx:77-87` para que exija lo contrario: filas sin `tabindex`, con su región `aria-live`.

### Otras opciones
No es la única salida, y puede haber una mejor según lo que se quiera del panel:
- **Que la fila haga algo.** Por ejemplo, Enter en la fila de un agente abre su tarea en el tablero, y en «Mente» abre el chat que está pensando. Entonces lleva `role="button"` o un `<button>`, como en `TaskCard.tsx`. Hoy `ActivityRow` no trae el id de la tarea ni de la sesión (`model.ts:58-63`), así que habría que agregarlo en `workerRow` y `mindRow`.
- **Una sola parada con flechas.** Tab entra a la lista, las flechas mueven el foco entre filas y Tab sale. Así la información sigue al alcance del teclado sin sumar paradas.
- **Dejarlo como está.** Si el usuario prefiere poder pasar por cada agente con Tab, se mantiene, y se deja escrita la decisión en `docs/plan/issues/04-panel-derecho.md` para que no vuelva a reportarse.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: en `tests/ui/agents-panel/AgentsPanel.test.tsx`, cambiar el caso «oculta agentes deshabilitados y conserva las filas accesibles». Con dos agentes habilitados, se renderiza `<AgentsPanel />` y se comprueba:
  - que ninguna fila (`getAllByRole('article')`) tenga el atributo `tabindex`;
  - que cada fila conserve su `[aria-live="polite"]`;
  - que dentro de `getByRole('complementary', { name: 'Agentes en vivo' })` haya como mucho un elemento con `tabindex` distinto de `-1` (el contenedor con scroll, si se elige la opción 2).

  Si se elige que la fila haga algo, la prueba debe disparar `keyDown` con Enter sobre la fila y afirmar la navegación esperada.
- Comando (WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/agents-panel/AgentsPanel.test.tsx"`; PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/agents-panel/AgentsPanel.test.tsx`.
- Verificación manual en la app: con la ventana ancha y varios agentes habilitados, abrir un proyecto, poner el foco en el input y avanzar con Tab. Después del composer, el foco debe pasar como mucho por una parada del panel (o por filas que sí respondan a Enter) antes de volver a la barra de título. Con muchos agentes, comprobar que la lista se puede desplazar con las flechas.
