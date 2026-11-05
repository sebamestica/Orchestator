# Issue 5 — Perfil: uso de tokens y gasto de la API por modelo

Estado: hecho · Commit: uno solo, a nombre del usuario y sin trailers · Depende de: issue 3 (enlace
sesión–tarea, ya en `main`: `sessions.task_id`, también las del revisor), para agrupar por proyecto y rol

## Problema
- No hay una vista de perfil ni de uso. Ajustes tiene General, Mente, Agentes, Proyectos, Memoria y Skills
  (`SettingsView.tsx:16-23`).
- Hay datos: la tabla `usage` (`store/schema.ts:61-76`) la llenan los workers, las revisiones, la mente (agente
  `orquestador`) y el planificador. `GET /usage` agrupa por agente, día, sesión y modelo (`store.ts:570-605`), pero
  no por proyecto ni por rol.
- **Datos reales del 2026-11-04 (un solo día):**

  | Agente | Costo |
  |---|---|
  | claude, Opus 5.5 | 26,85 USD |
  | mente | 6,48 USD |
  | agy (329 filas) | sin costo, por suscripción |
  | codex (8 filas) | sin costo, por suscripción |

- **El costo es una estimación local.** Sale del `costUSD` del SDK, o de `pricing.ts` con precios públicos, que no
  conocen la tarifa del servidor del usuario. Según `DECISIONES.md:30`, ese servidor cobra Opus 5.5 a 5,2 / 26 USD
  por millón, frente a 4 / 20 de los precios públicos (≈1,3×).
- **La caché no se registra igual entre agentes:**
  - Claude mete en «entrada» la entrada nueva más la lectura y la escritura de caché, y la escritura no queda aparte;
  - Codex cuenta la caché dentro de la entrada;
  - agy guarda la entrada sin la caché.

  Sumar «entrada» mezcla tres significados distintos.
- **Hay gasto perdido:** una sesión que vence el plazo de 1 h no deja ninguna fila de uso (`supervisor.ts:263-292`).

## Qué se quiere
Un apartado en el perfil para ver cómo se van usando los tokens y cuánto se lleva gastado en la factura de la API,
por modelo.

## Diseño
- **Núcleo (módulo de F5):** `src/core/usage-stats/**` + `src/core/app/f5-uso.ts` + una línea en
  `route-modules.ts`. Ruta `GET /usage/summary?from&to&tz`, de solo lectura sobre `usage`, `sessions`, `tasks` y
  `chat_chats`, con:
  - totales del periodo: hoy, 7 días y el mes de facturación;
  - por modelo: entrada nueva, caché escrita, caché leída, salida y costo;
  - por día, para las barras;
  - por rol (mente, autor, revisor, planificador) y por proyecto, gracias al enlace del issue 4;
  - Codex y agy aparte como «suscripción»: tokens, cupo y sin costo.
- **Tarifa del usuario:** tabla propia del módulo con el multiplicador o los precios por modelo, incluida la caché.
  Se edita en el perfil. El costo se muestra «estimado (precios públicos)» y «con tu tarifa».
- **Corrección de datos, de aquí en adelante:**
  - caché escrita aparte en `usageSchema` (contrato A0, `shared/events.ts:18-25`);
  - la entrada de agy normalizada;
  - el modelo en los eventos de Codex y agy;
  - el uso parcial guardado cuando vence el plazo.
- **Interfaz:** sección «Uso y gasto» (`src/ui/features/settings/UsageSection.tsx`), con:
  - tarjetas de total;
  - barras diarias en SVG o CSS (sin librería de gráficos, como pide F5);
  - una tabla por modelo y otra por rol o proyecto;
  - selector de periodo.

## Rutas propias
`src/core/usage-stats/**`, `src/core/app/f5-uso.ts`, línea en `src/core/app/route-modules.ts`,
`src/core/adapters/agy-cli/translate.ts` y `src/core/adapters/codex-cli/translate.ts` (modelo y caché normalizados),
`src/core/adapters/claude-sdk/translate.ts` (solo la caché escrita), `src/shared/events.ts` (`cacheWriteTokens`
opcional), `src/shared/api.ts` (solo los esquemas nuevos de la ruta), `src/ui/features/settings/**`,
`src/ui/app/routes.ts`, `tests/core/usage-stats/**`, `tests/core/adapters/**`, `tests/ui/settings/**`,
`docs/api/**` (regenerada). No se toca `src/core/adapters/claude-sdk/adapter.ts` (issue 6).

## Criterios de aceptación
1. `GET /usage/summary` da los totales por modelo, día, rol y proyecto, y cuadra con la suma de `usage` del periodo.
2. Con un multiplicador de 1,3 en la tarifa, «con tu tarifa» = 1,3 × «estimado».
3. Codex y agy salen aparte, sin costo.
4. Las filas nuevas guardan la caché escrita, y agy guarda la entrada normalizada.
5. La sección se ve en tema claro y oscuro, y responde a cambios de periodo.
6. `npm run -s check` en verde.

## Decisiones (A0, 2026-11-04; el usuario no respondió a las dudas)
- **Moneda: USD.** Junto al costo se muestran siempre los tokens.
- **Tarifa:** un multiplicador por modelo, editable en la sección; por defecto 1,0. La sección lleva una nota: según
  `docs/DECISIONES.md`, el servidor del usuario cobra Opus 5.5 a 5,2 / 26 USD por millón, unas 1,3× los precios
  públicos. Se muestran el «estimado (precios públicos)» y el «con tu tarifa» (= estimado × multiplicador).
- **Ubicación:** sección «Uso y gasto» en Ajustes (`#/ajustes/uso`) y además un acceso «Perfil» (`#/perfil` lleva a
  la misma sección). La línea de la barra lateral queda propuesta: `Sidebar.tsx` no es de esta tarea.
- **Periodo:** hoy, 7 días (hoy y los 6 anteriores) y mes calendario (del día 1 a hoy).
- **Codex y agy** van aparte como «suscripción»: tokens y cupo, sin costo.
- **Lo ya registrado se recalcula:** el multiplicador se aplica al leer, así que vale para todo el historial.

## Detalle de la implementación
- **Convención normalizada del uso** (`usageSchema`): `inputTokens` es la entrada total procesada (entrada nueva +
  caché leída + caché escrita); `cachedInputTokens` y `cacheWriteTokens` son partes de ella. Un evento que trae
  `cacheWriteTokens` (aunque sea 0) sigue esta convención. Los anteriores se leen así:
  - agy: la entrada no incluía la caché (entrada nueva = `inputTokens`);
  - Claude y Codex: la caché leída va dentro de la entrada; la escrita no se conoce y queda en la entrada nueva.
- **La caché escrita se guarda en la carga del evento** (`events.payload_json`); el resumen la lee uniendo
  `usage.event_id`. Sin migración de `usage` (es del almacén, fuera de esta tarea).
- **Rol de cada sesión:** mente = agente `orquestador` o sesión de un chat; planificador = sesión `plan-…`; con
  `task_id`, autor si su agente es el de la tarea o el de la primera sesión de la tarea, y revisor si no (el revisor
  nunca es un autor); sin tarea = «otros».
- **Proyecto:** el de la tarea o el del chat; el planificador y lo suelto van a «sin proyecto».
- **Rutas:** `GET /usage/summary?period|from&to&tz`, `GET /usage/rates` y `PATCH /usage/rates`.
- **Fuera de esta tarea (propuesto en el informe):** el uso parcial al vencer el plazo (`supervisor.ts`,
  `claude-sdk/adapter.ts`), `usageDeltas` de la mente (restar también `cacheWriteTokens`), la caché escrita del
  planificador (`app/planner.ts`), el modelo de Codex desde `config.model` (`codex-cli/index.ts`) y el acceso
  «Perfil» en `Sidebar.tsx`.
