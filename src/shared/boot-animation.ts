/**
 * Animación de arranque de Berland: la «B» del ícono es el núcleo; a su alrededor se traza una órbita y aparecen los
 * agentes, unidos al núcleo. Después giran despacio y, a un mismo pulso de 1,2 s, uno de ellos se hincha y suelta un
 * paquete que acelera hacia el núcleo; cuando entra, el núcleo da un golpe y suelta una onda.
 *
 * Coreografía tomada de las skills de HyperFrames del proyecto de marketing (`hyperframes-animation`: blueprint
 * `constellation-hub` + reglas `svg-path-draw`, `spring-pop-entrance`, `avatar-cloud-network` y `sine-wave-loop`) y
 * ajustada con la revisión de un crítico sobre cuadros reales. En CSS puro porque la pantalla de estado de Electron es
 * una URL `data:` con CSP estricta (sin scripts de terceros):
 * - solo transformaciones y opacidad (nunca width/height/top/left);
 * - un solo reloj: la entrada escalonada sigue a la órbita que se traza y el bucle late cada 1,2 s;
 * - posiciones calculadas una vez, deterministas (sin aleatorios);
 * - con `prefers-reduced-motion` todo queda quieto, salvo un latido de opacidad del núcleo.
 *
 * La usan la pantalla de estado del escritorio (`apps/desktop/src/lib/status-page.ts`) y la interfaz mientras conecta
 * con el núcleo (`src/ui/components/BootScreen.tsx`). Colores por variables: `--boot-ink` (trazo), `--boot-canvas`
 * (relleno del núcleo), `--boot-muted` (texto) y `--boot-glow` (intensidad del halo), con los del tema oscuro por defecto.
 */

const CENTER = 120;
const ORBIT = 84;
/** Radio donde terminan líneas y paquetes: por debajo del borde del núcleo, que los tapa gire como gire la órbita. */
const HUB_EDGE = 24;
export const BOOT_AGENTS = 6;
/** Un agente emite cada `PULSE` segundos; el ciclo de cada uno dura `PULSE × BOOT_AGENTS`. */
const PULSE = 1.2;
const CYCLE = PULSE * BOOT_AGENTS;
/** Instante (s) en que el primer paquete cruza el borde del núcleo: el golpe del núcleo va sincronizado con él. */
const FIRST_HIT = 1.76;

const round = (n: number) => Math.round(n * 100) / 100;

/** Desde las 12, en sentido horario: el mismo orden en que la órbita se traza. */
function agentAngle(i: number): number {
  return -90 + (360 / BOOT_AGENTS) * i;
}

/**
 * Trazo de la «B» del ícono (`apps/desktop/assets/icon.svg`, caja de 256 centrada en 128) en UN solo recorrido continuo:
 * sube por el asta, hace la panza de arriba, vuelve y hace la de abajo. Así se dibuja en orden, no en tres trazos a la vez.
 */
const B_PATH = 'M86 188V68H132A28 28 0 0 1 132 124H86H138A32 32 0 0 1 138 188H86';

function agents(): string {
  const out: string[] = [];
  for (let i = 0; i < BOOT_AGENTS; i++) {
    const a = agentAngle(i);
    const rad = (a * Math.PI) / 180;
    const x = round(CENTER + ORBIT * Math.cos(rad));
    const y = round(CENTER + ORBIT * Math.sin(rad));
    const lx = round(CENTER + HUB_EDGE * Math.cos(rad));
    const ly = round(CENTER + HUB_EDGE * Math.sin(rad));
    out.push(
      `<g class="boot-agent" style="--i:${i}">` +
        `<line class="boot-link" x1="${x}" y1="${y}" x2="${lx}" y2="${ly}" pathLength="1"/>` +
        // El paquete viaja del agente al núcleo: un grupo girado al ángulo del agente y un punto que se traslada en X.
        `<g transform="rotate(${round(a)} ${CENTER} ${CENTER})"><circle class="boot-packet" cx="${CENTER + ORBIT}" cy="${CENTER}" r="2.2"/></g>` +
        `<circle class="boot-halo" cx="${x}" cy="${y}" r="8.5"/>` +
        `<circle class="boot-node" cx="${x}" cy="${y}" r="4"/>` +
        `</g>`,
    );
  }
  return out.join('');
}

/** SVG de la animación (marcado fijo, sin texto del usuario). */
export const BOOT_SVG =
  `<svg class="boot-art" viewBox="0 0 240 240" width="240" height="240" aria-hidden="true" focusable="false">` +
  // `var()` no vale en atributos de presentación: el color y la opacidad de las paradas van por clase.
  `<defs><radialGradient id="boot-glow"><stop class="boot-stop" offset="0"/><stop class="boot-stop" offset="1"/></radialGradient></defs>` +
  `<circle class="boot-glow" cx="${CENTER}" cy="${CENTER}" r="100" fill="url(#boot-glow)"/>` +
  `<g class="boot-orbit">` +
  // La órbita nace a las 12 (como el primer agente) y gira con ellos.
  `<circle class="boot-ring" cx="${CENTER}" cy="${CENTER}" r="${ORBIT}" pathLength="1" transform="rotate(-90 ${CENTER} ${CENTER})"/>` +
  agents() +
  `</g>` +
  `<rect class="boot-ping" x="${CENTER - 32}" y="${CENTER - 32}" width="64" height="64" rx="15"/>` +
  `<g class="boot-hub"><rect x="${CENTER - 32}" y="${CENTER - 32}" width="64" height="64" rx="15"/>` +
  `<path class="boot-b" d="${B_PATH}" pathLength="1" transform="translate(${CENTER} ${CENTER}) scale(0.25) translate(-128 -128)"/></g>` +
  `</svg>`;

/** Etiqueta con puntos animados (el «…» final del texto se reemplaza por tres puntos que laten). */
export function bootLabelHtml(escapedLabel: string): string {
  const text = escapedLabel.replace(/(…|\.\.\.)\s*$/, '');
  return `<span class="boot-label">${text}<span class="boot-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></span>`;
}

const travel = ORBIT - HUB_EDGE;
/** Fracción del ciclo de un agente que dura el viaje del paquete (0,6 s de 7,2 s). */
const TRAVEL_END = round((0.6 / CYCLE) * 100);
const SETTLED_HIT = round(FIRST_HIT - PULSE);

/**
 * Estilos de la animación. El estado de reposo es el final: cada `@keyframes` de entrada parte del estado oculto y
 * `animation-fill-mode: both` lo sostiene durante el retardo; sin animaciones queda todo visible y quieto.
 * `.boot--settled` salta la entrada (la interfaz la usa al tomar el relevo de la pantalla del escritorio).
 */
export const BOOT_CSS = `
.boot{display:flex;flex-direction:column;align-items:center;gap:6px;color:var(--boot-ink,#ececec)}
.boot-art{display:block;width:min(280px,50vw);height:auto;overflow:visible}
.boot-node,.boot-halo,.boot-hub,.boot-glow,.boot-ping{transform-box:fill-box;transform-origin:center}
.boot-stop{stop-color:var(--boot-ink,#ececec);stop-opacity:0}
.boot-stop:first-child{stop-opacity:var(--boot-glow,.1)}
.boot-glow{animation:boot-fade-in 1.2s ease-out .4s both,boot-breathe 4.8s ease-in-out 1.6s infinite}
.boot-ring{fill:none;stroke:var(--boot-ink,#ececec);stroke-opacity:.14;stroke-width:1;stroke-dasharray:1;animation:boot-draw-ring .6s linear .45s both}
.boot-orbit{transform-box:view-box;transform-origin:${CENTER}px ${CENTER}px;animation:boot-spin 36s linear infinite}
.boot-link{stroke:var(--boot-ink,#ececec);stroke-opacity:.22;stroke-width:1;stroke-dasharray:1;animation:boot-draw .4s cubic-bezier(.2,.7,.2,1) calc(.6s + var(--i) * .1s) both}
.boot-node{fill:var(--boot-ink,#ececec);animation:boot-pop .5s cubic-bezier(.34,1.56,.64,1) calc(.45s + var(--i) * .1s) both,boot-emit ${CYCLE}s ease-out calc(${PULSE}s + var(--i) * ${PULSE}s) infinite}
.boot-halo{fill:var(--boot-ink,#ececec);fill-opacity:var(--boot-halo,.1);animation:boot-pop .5s cubic-bezier(.34,1.56,.64,1) calc(.5s + var(--i) * .1s) both}
.boot-packet{fill:var(--boot-ink,#ececec);opacity:0;animation:boot-travel ${CYCLE}s linear calc(${PULSE}s + var(--i) * ${PULSE}s) infinite both}
.boot-ping{fill:none;stroke:var(--boot-ink,#ececec);stroke-width:1;opacity:0;animation:boot-ping ${PULSE}s cubic-bezier(.15,.6,.3,1) ${FIRST_HIT}s infinite}
.boot-hub{animation:boot-hub-in .5s cubic-bezier(.2,.8,.2,1) both,boot-thump ${PULSE}s cubic-bezier(.2,.6,.3,1) ${FIRST_HIT}s infinite}
.boot-hub rect{fill:var(--boot-canvas,#090909);stroke:var(--boot-ink,#ececec);stroke-opacity:.16;stroke-width:1;animation:boot-hit ${PULSE}s cubic-bezier(.2,.6,.3,1) ${FIRST_HIT}s infinite}
.boot-b{fill:none;stroke:var(--boot-ink,#ececec);stroke-width:20;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;animation:boot-draw .9s cubic-bezier(.55,0,.25,1) .1s both}
.boot-label{font-size:13px;letter-spacing:.01em;color:var(--boot-muted,#8f8f94);animation:boot-fade .5s ease-out .8s both}
.boot-dots i{display:inline-block;width:3px;height:3px;margin-left:3px;vertical-align:baseline;border-radius:50%;background:currentColor;font-size:0;overflow:hidden;animation:boot-dot 1.2s ease-in-out infinite both}
.boot-dots i:nth-child(2){animation-delay:.15s}
.boot-dots i:nth-child(3){animation-delay:.3s}
/* Relevo en la interfaz: una conexión rápida no muestra nada; una lenta entra en un fundido y el golpe cae al terminarlo. */
.boot--settled{animation:boot-fade-in .25s ease-out .3s both}
.boot--settled .boot-glow{animation:boot-breathe 4.8s ease-in-out infinite}
.boot--settled .boot-ring,.boot--settled .boot-link,.boot--settled .boot-b,.boot--settled .boot-halo,.boot--settled .boot-label{animation-delay:-10s}
.boot--settled .boot-node{animation:boot-emit ${CYCLE}s ease-out calc(var(--i) * ${PULSE}s) infinite}
.boot--settled .boot-packet{animation-delay:calc(var(--i) * ${PULSE}s)}
.boot--settled .boot-hub{animation:boot-thump ${PULSE}s cubic-bezier(.2,.6,.3,1) ${SETTLED_HIT}s infinite}
.boot--settled .boot-hub rect,.boot--settled .boot-ping{animation-delay:${SETTLED_HIT}s}
@keyframes boot-draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes boot-draw-ring{from{stroke-dashoffset:1;opacity:0}2%{opacity:1}to{stroke-dashoffset:0}}
@keyframes boot-pop{from{opacity:0;transform:scale(.4)}to{opacity:1;transform:scale(1)}}
@keyframes boot-hub-in{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:scale(1)}}
@keyframes boot-fade-in{from{opacity:0}to{opacity:1}}
@keyframes boot-spin{to{transform:rotate(360deg)}}
@keyframes boot-breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.75;transform:scale(.97)}}
@keyframes boot-emit{0%{transform:scale(1)}3%{transform:scale(1.3)}9%,100%{transform:scale(1)}}
@keyframes boot-travel{0%{opacity:0;transform:translateX(0);animation-timing-function:cubic-bezier(.4,0,.8,.4)}1.5%{opacity:1}${TRAVEL_END}%{opacity:1;transform:translateX(-${travel}px)}${round(TRAVEL_END + 0.01)}%,100%{opacity:0;transform:translateX(-${travel}px)}}
@keyframes boot-hit{0%{stroke-opacity:.55}100%{stroke-opacity:.16}}
@keyframes boot-thump{0%{transform:scale(1.035)}100%{transform:scale(1)}}
@keyframes boot-ping{0%{opacity:.25;transform:scale(1.04)}60%,100%{opacity:0;transform:scale(1.75)}}
@keyframes boot-fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes boot-dot{0%,100%{opacity:.2}35%{opacity:1}}
@media (prefers-reduced-motion:reduce){.boot,.boot-art,.boot-art *,.boot-label,.boot-dots i{animation:none!important}.boot-packet,.boot-ping{display:none}.boot-hub rect{animation:boot-hit 2.4s ease-out infinite!important}}
`;

/** Bloque completo (SVG + etiqueta). `escapedLabel` ya viene escapado por quien llama. */
export function bootMarkup(escapedLabel: string, settled = false): string {
  return `<div class="boot${settled ? ' boot--settled' : ''}">${BOOT_SVG}${bootLabelHtml(escapedLabel)}</div>`;
}
