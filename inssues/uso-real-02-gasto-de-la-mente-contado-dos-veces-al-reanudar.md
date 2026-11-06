# El uso y el gasto de la mente se cuentan dos veces cada vez que su sesión se recrea con `resume`

- **Área:** Evidencia de uso real (uso, costo y presupuesto de la mente)
- **Severidad:** alta
- **Archivos:** `src/core/conductor/usage.ts:3`, `src/core/conductor/usage.ts:8`, `src/core/conductor/usage.ts:10`, `src/core/chat/service.ts:693`, `src/core/chat/service.ts:744`, `src/core/chat/service.ts:821`, `src/core/chat/service.ts:832`, `src/core/adapters/claude-sdk/translate.ts:556`, `src/core/adapters/claude-sdk/translate.ts:561`, `src/core/store/store.ts:665`, `src/core/app/f5-chat.ts:105`, `tests/core/chat/service.test.ts:231`, `tests/core/chat/helpers.ts:116`
- **Estado:** abierta

## Cómo ocurre
La mente de cada chat es una `ConductorSession` sobre el Claude Agent SDK con entrada en streaming. El SDK manda en
cada `result` los contadores **acumulados** de la sesión (`modelUsage` por modelo y `total_cost_usd`). Para no sumar
dos veces, `ChatService` pasa cada evento `usage` por `usageDeltas`, que guarda la diferencia con el último acumulado
visto (`src/core/conductor/usage.ts:8-26`).

La sesión se cierra y se vuelve a crear con `resume` (el `session_id` del SDK guardado en `chat_chats`) en varios
casos: 15 min ociosa (`service.ts:893`), la gracia tras interrumpir (`service.ts:509`), un cambio de forma (modo,
modelo, raíces, plugins; `service.ts:693`) o un reinicio del núcleo. Cada vez se crea un `usageDeltas` nuevo con el
mapa `prev` vacío:

```ts
// src/core/chat/service.ts:743-744
    // Un proceso del SDK nuevo cuenta el uso desde cero.
    live.delta = usageDeltas();
```

Pero el proceso reanudado **no** cuenta desde cero: Claude Code restaura los contadores acumulados de la sesión y los
manda en su primer `result`. El traductor los emite tal cual (`translate.ts:556-561`), `usageDeltas` los resta contra
cero y quedan guardados otra vez enteros en la tabla `usage` y sumados a `chat_chats.cost_usd` (`service.ts:832-835`).

Evidencia en la base real (copia de solo lectura de `orquestador.db`, solo sesiones `chat-*` del agente `orquestador`):

- **Chat `ec3e1f2b`.** Las filas 347, 348, 350 y 351 (2026-11-04, 15:39–15:52Z) suman exactamente 1.247.534 tokens de
  entrada, 24.183 de salida, 1.113.451 en caché y 1,3766 USD. El 2026-11-05 a las 00:33:55Z el usuario escribió con
  tres subagentes trabajando; la sesión se recreó (eventos 4511-4513: los subagentes quedan `cancelled` porque «didn't
  finish before the previous session…»). El primer `result` del proceso nuevo llegó a las 00:33:59.022Z, 4 ms después
  del `init` (evento 4514), sin ningún mensaje del asistente en medio y con resumen vacío (evento 4516). Guardó la fila
  374 con **los mismos 1.247.534 / 24.183 / 1.113.451 tokens y 1,3766 USD**. Es la foto de las 15:52 del día anterior,
  no la del proceso que acababa de morir (ese llegaba a ~9,7 M de entrada): Claude Code restaura la última foto que
  quedó guardada, que puede ser vieja. La fila 375 siguiente (237.310) ya es una diferencia correcta respecto de esa base.
- La misma base parece estar dentro de la fila 369 (00:14:30Z, primer `result` tras más de 8 h cerrada): 1.783.146 =
  1.247.534 + 535.612, un turno del tamaño habitual.
- **Chat `00831801`.** Las filas 428 (sonnet, 12.858.837 tokens, 6,1145 USD) y 429 (haiku, 0,0085 USD) de las
  01:15:27Z son **idénticas** a las 404 y 405 de las 01:11:42Z. En un mismo proceso eso es imposible: con el acumulado
  sin cambios, `usageDeltas` devuelve `undefined` (`usage.ts:26`) y no se guarda nada. Solo aparecen porque `prev`
  estaba vacío. La fila 427 de opus (785.700 tokens, 2,6351 USD) es la 403 (478.282, 2,0325 USD) más unos 307 mil
  tokens y 0,60 USD, del tamaño de los turnos siguientes (filas 448 y 476: 311 mil / 0,60 USD y 320 mil / 0,64 USD).
- Una búsqueda de filas iguales a la suma de las filas anteriores de su misma sesión y modelo encuentra exactamente
  las 374, 428 y 429. Hay 7,50 USD duplicados de forma exacta (1,3766 + 6,1145 + 0,0085) y unos 3,41 USD más muy
  probables (las bases dentro de las filas 369 y 427). Son ≈ 10,9 USD de los 52,96 USD que hoy registra la mente
  (≈ 20 %). `chat_chats.cost_usd` del chat `00831801` vale 18,1549 USD, igual a la suma inflada de sus filas.

La prueba que debía cubrir esto afirma justo lo contrario, porque la `query` falsa siempre arranca de cero:

```ts
// tests/core/chat/service.test.ts:231-232
    // El costo acumulado del proceso nuevo empieza de cero: se cuenta entero (0,01 + 0,01), no se pierde.
    expect(b.service.get(chat.id).costUsd).toBeCloseTo(0.02, 9);
```

(`echoTurn` en `tests/core/chat/helpers.ts:116-120` calcula el costo con `ctx.index`, que vuelve a 0 en cada proceso.)

Ninguno de los issues de hoy (`docs/plan/issues/01..13`) lo toca. El 05 cita `usageDeltas` solo para restar también
`cacheWriteTokens`, y eso ya está hecho (`usage.ts:34`).

## Por qué pasa
`usageDeltas` y su uso en `#ensureSession` parten de un supuesto falso: «un proceso del SDK nuevo (sesión reanudada)
vuelve a contar desde cero» (`usage.ts:6`, `service.ts:743`). Claude Code reanuda la sesión con sus contadores
acumulados (a veces de una foto anterior al último proceso), así que la primera diferencia de cada proceso nuevo
incluye todo lo ya guardado. Ese uso inflado llega a:

- la tabla `usage`, que leen `GET /usage`, el perfil (`usage-stats/summary.ts:324`) y `Store.spentUsd`
  (`store.ts:665`);
- `chat_chats.cost_usd` (`service.ts:832-835`);
- el presupuesto manual de Claude: `budgetLeftUsd = budget − spentUsd(agente) − spentUsd('orquestador')`
  (`f5-chat.ts:105`). Con lo duplicado, el chat puede rechazar mensajes con «Presupuesto … agotado»
  (`service.ts:696`) antes de tiempo, y el `maxBudgetUsd` que recibe la sesión nueva (`service.ts:733`) queda más bajo
  de lo que corresponde.

## Solución posible
Calcular una **base por proceso** y restarla, en vez de suponer que el proceso parte de cero:

1. En `ClaudeSdkTranslator` (`src/core/adapters/claude-sdk/translate.ts`), exponer el uso propio de este proceso por
   modelo a partir de `#perMessage` (los tokens del `usage` de cada mensaje de la API, ya deduplicados por
   `message.id` en `#trackUsage`, `translate.ts:291-314`): entrada, salida, caché leída y escrita.
2. En `usageDeltas` (`src/core/conductor/usage.ts`), aceptar una función opcional que entregue ese uso propio. En el
   **primer** evento `usage` de cada modelo dentro del proceso, fijar
   `base[modelo] = max(0, acumulado del SDK − uso propio)` para cada contador de tokens. Para el costo, repartir el
   `costUSD` del SDK según el peso de lo propio, con `estimateCostUsd` de `pricing.ts` aplicado a los dos desgloses
   (`costo_propio = costUSD × est(propio) / est(acumulado)`). Así no importa si los precios de `pricing.ts` difieren
   de los del SDK. Desde ahí, todas las diferencias se calculan contra `base` y después contra `prev`, como hoy.
3. En `ChatService.#ensureSession` (`src/core/chat/service.ts:744`), pasar esa función solo cuando la sesión se crea
   con `resume` (`sdkSessionId` presente). Una sesión nueva sigue partiendo de cero, y la flota (`claude-sdk/adapter.ts`,
   que no reanuda) no cambia.
4. Corregir el comentario de `usage.ts:3-7` y el de `service.ts:743`, y la prueba de `service.test.ts:231`.
5. Para lo ya guardado: un script de solo diagnóstico (o una migración explícita aprobada por el usuario) que busque
   filas `chat-*` iguales a la suma de las anteriores de su sesión y modelo (hoy 374, 428 y 429), las marque o las
   ponga en cero, y recalcule `chat_chats.cost_usd` como la suma de `usage.cost_usd` del chat.

Ojo con un límite: si en el primer turno del proceso reanudado un subagente en segundo plano gasta sin que sus mensajes
lleguen al stream, ese gasto quedaría dentro de la base y se perdería. Conviene comprobarlo con un registro real antes
de cerrar el arreglo.

### Otras opciones
La propuesta no es la única, y puede haber una más barata:

- **No usar el acumulado del SDK para el uso por turno.** Sumar solo el `usage` de cada mensaje del asistente
  (sin duplicar por `message.id`) y calcular el costo con `pricing.ts`, dejando `total_cost_usd` como control. Es
  inmune a la restauración, pero pierde el costo exacto que informa el SDK (precios de Bedrock, multiplicadores) y
  depende de que todos los mensajes, también los de subagentes, pasen por el stream.
- **Guardar en `chat_chats` el último acumulado visto por modelo** y usarlo como `prev` inicial del proceso nuevo. Es
  simple, pero frágil: la foto que restaura Claude Code puede ser anterior a ese último acumulado (el caso de las
  00:33, que restauró la de las 15:52 del día anterior), y entonces se perdería uso real.
- **Detectar el `result` sin llamadas a la API** (como la fila 374, 4 ms después del `init` y sin mensajes del
  asistente) y tomarlo como base sin registrarlo. Arregla el caso más visible, pero no el de la fila 369, donde la base
  vino mezclada con un turno real.
- **Evitar que Claude Code restaure los contadores**, por ejemplo con `forkSession` u otra opción del SDK. No se
  verificó qué clave usa la restauración en Claude Code 2.1.302; habría que probarlo antes, y cambiar la identidad de
  la sesión tiene costos propios (transcripciones nuevas en cada reanudación).
- **No reanudar las sesiones:** elimina el problema, pero se pierde el contexto de la conversación. No es aceptable.

## Cómo probar que quedó resuelta
- **Prueba automatizada propuesta:** en `tests/core/chat/service.test.ts`, bloque «persistencia y reanudación», con
  `bench({ idleMs: 50 })` (o con la gracia de interrupción) y un `TurnFn` propio que use `ctx.process`. Los tokens de
  `modelUsage` deben coincidir con la suma del `usage` de los mensajes del asistente, y el costo con `pricing.ts`, para
  que el reparto sea exacto:
  1. Proceso 1: `init`, un mensaje del asistente con `usage {input 100, output 10}` y un `result` con `modelUsage
     {opus: input 100, output 10, costUSD c1}`.
  2. Se espera el cierre por inactividad y se envía otro mensaje (proceso 2, `resume: 'sdk-1'`): un mensaje del
     asistente con `usage {input 50, output 5}` y un `result` con el acumulado restaurado `{opus: input 150, output 15,
     costUSD c1 + c2}`.
  3. Afirmar que la suma de `usage.cost_usd` del chat (`b.store.spentUsd('orquestador')`) y `b.service.get(id).costUsd`
     valen `c1 + c2` (hoy dan `2·c1 + c2`) y que los tokens de entrada guardados suman 150 (hoy 250).
  4. Caso «solo restaura»: el primer `result` del proceso 2 llega sin mensajes del asistente (como la fila 374).
     Afirmar que no se guarda ninguna fila `usage` con costo mayor que 0.
  5. Caso «foto vieja»: el proceso 1 hace dos turnos (acumulados 100 y 180), se corta con la gracia de interrupción y
     el proceso 2 restaura 100 y suma 50 propios (`result` con 150). Afirmar 230 tokens de entrada en total (hoy 330).
  6. Cambiar el comentario y la expectativa de `service.test.ts:231` para que el proceso falso refleje el
     comportamiento real (acumulado restaurado).
  Agregar también en `tests/core/conductor/usage-deltas.test.ts` un caso unitario de la base:
  `usageDeltas({ own })` con el primer acumulado `{input 150}` y uso propio `{input 50}` devuelve `{input 50}`.
- **Comando para correrla (desde WSL):**
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/chat/service.test.ts tests/core/conductor/usage-deltas.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/chat/service.test.ts tests/core/conductor/usage-deltas.test.ts`).
- **Verificación manual en la app:** abrir un chat, enviar un mensaje y anotar su costo. Cambiar el modo (o esperar
  15 min) y enviar otro mensaje corto. El costo del chat debe subir solo lo del segundo turno, y en la tabla `usage`
  no debe aparecer una fila igual a la suma de las anteriores de esa sesión y modelo. Con datos reales, en solo
  lectura: repetir la búsqueda de filas `chat-*` cuyo uso sea igual a la suma de las filas anteriores de su sesión y
  modelo; tras el arreglo no debe aparecer ninguna nueva.
