# Issue 14 — Pantalla de carga animada (la constelación de Berland)

Estado: hecho · Commit: uno solo, a nombre del usuario y sin trailers

## Lo que pidió el usuario
- «Trabajemos en la pantalla de carga, para que no salga esa ruedita girando y al lado diga "Arrancando el núcleo".
  Podríamos hacerle una animación.»
- «Carga las skills de marketing, especialmente las de Hyperframes: con esas habilidades podrás generar una animación
  para la pantalla de carga.»
- «Pon a un crítico a ver la animación, para saber que se ve increíble.»

## Antes
- **Escritorio** (`apps/desktop/src/lib/status-page.ts`): un `.spin` de 16 px (un borde girando) junto al título
  «Arrancando el núcleo…».
- **Interfaz** (`src/ui/app/App.tsx:118`): con `core === 'starting'` no se mostraba nada, la pantalla quedaba en
  blanco (agy, hallazgo 7).

## Diseño
Se usaron las skills de HyperFrames de `C:\dev\marketing\.agents\skills`: `hyperframes-animation`, el blueprint
`constellation-hub` y las reglas `svg-path-draw`, `spring-pop-entrance`, `avatar-cloud-network` y `sine-wave-loop`.

La pantalla de estado es una URL `data:` con CSP estricta (`default-src 'none'`), así que la animación va en CSS
keyframes, uno de los adaptadores de la skill, sin GSAP ni scripts.

Coreografía:
- **0–1 s:** la «B» del ícono se dibuja sola en el núcleo, que entra con rebote.
- **0,35–1,25 s:** se traza la órbita.
- **0,55–1,45 s:** los 6 agentes aparecen con rebote escalonado (6 × 0,07 s) y se dibujan sus líneas al núcleo.
- **Desde 1,3 s, en bucle:** los agentes giran (28 s por vuelta) y cada uno manda un pulso al núcleo (cada 0,4 s, en
  sucesión). El núcleo y el halo respiran. Debajo, «Arrancando el núcleo» con tres puntos que laten.
- **Reglas de la skill:** solo transform y opacidad, escalonado ≤ 0,5 s y posiciones deterministas.
- **Con `prefers-reduced-motion`:** todo queda quieto en su estado final.

Piezas:
- `src/shared/boot-animation.ts`: SVG fijo y CSS, compartidos.
- **Escritorio:** las páginas «esperando» (`busy`) la usan. Las de error siguen con su texto.
- **Interfaz:** `BootScreen` mientras conecta con el núcleo, con los colores del tema (claro u oscuro) y sin repetir la
  entrada (`boot--settled`), porque toma el relevo de la pantalla del escritorio.

## Verificación visual
Se capturaron cuadros reales con el Electron de Berland, pausando las animaciones en cada instante (Web Animations
API), en oscuro, claro y movimiento reducido. Los juzgó un crítico independiente en dos rondas.

**Ronda 1: 5/10.**
- Los agentes salían como discos macizos: la opacidad del `pop` pisaba la del halo.
- La «B» se dibujaba en tres trazos a la vez y se leía «R».
- El pulso no llegaba al núcleo y había cinco relojes sin relación.
- La órbita y los agentes no estaban sincronizados.
- El halo se veía sucio en tema claro.

Se corrigió:
- la «B» va en un solo trazo continuo;
- los nodos usan r 4 con `fill-opacity`;
- la órbita nace a las 12 y gira con los agentes, que aparecen al pasar la punta;
- un solo pulso de 1,2 s: un agente se hincha, su paquete entra bajo el borde y el núcleo da un golpe y suelta una onda;
- el halo depende del tema (`--boot-glow`);
- ✕ y – en SVG, y la fuente Segoe UI Variable Text.

**Ronda 2: 8/10.** Para el 9+ pidió:
- otra curva para el paquete (`.4,0,.8,.4`), con el golpe a 1,76 s;
- una onda más amplia y más corta;
- los puntos sobre la línea base (`overflow:hidden`);
- `--boot-halo` a .06 en claro;
- un keyframe propio para la órbita, sin la mota de la costura;
- un fundido al tomar el relevo en la interfaz.

Todo aplicado.

**Pendiente:** capturar el relevo dentro de la app real (la pantalla de la interfaz dentro de `chrome-surface`).

En las primeras capturas aparecieron dos fallos, ya corregidos:
- un `transform-origin` general sacaba la «B» del núcleo y lanzaba los pulsos fuera de la órbita;
- el margen de `main` dejaba una barra de desplazamiento.

## Pruebas
- `tests/desktop/config-window.test.ts`:
  - la página de espera trae la animación y no la ruedita;
  - el «…» se cambia por puntos animados y el estado se anuncia con el texto entero;
  - hay 6 agentes y las páginas de error no llevan animación.
- `tests/ui/boot-screen.test.tsx`: la interfaz muestra la pantalla de espera mientras conecta.
