# Issue 6 — Razonamiento de los modelos: mejor calidad con menos tokens

Estado: hecho · Commit: uno solo, a nombre del usuario y sin trailers ·
Depende de: issue 5 (para medir antes y después)

## Decisiones (2026-11-04)
El usuario no respondió las dudas abiertas; A0 decidió:

| Duda | Decisión |
|---|---|
| ¿Revisiones con Sonnet 5.5 en low y medium? | Sí: `claude-sonnet-5-5`, esfuerzo `medium`. Las de tareas high, con el modelo del agente (Opus 5.5). |
| Planificador | Sonnet 5.5 en esfuerzo `low`. |
| Topes por tarea | 1 / 3 / 8 USD para low / medium / high, configurables en `FleetTuning.taskBudgetUsd` (`null` los quita). Al superarlo, la tarea se detiene con `.orq/HANDOFF.md` y el motivo queda en `detail`. |
| Esfuerzo de los autores | Según la dificultad (low → low, medium → medium, high → high); cada reintento sube un nivel. |
| Codex | `-c model_reasoning_effort="<nivel>"` según la dificultad, con techo `high`. |
| Mente | Esfuerzo por defecto `medium` en `DEFAULT_SETTINGS` (antes `high`). |
| ¿Qué ahorrar primero? | Dólares de la clave de Claude (Codex y agy gastan cupo, no USD). |

La pregunta sobre Pollium (si lo copiado era solo lo visual) queda abierta.

## Qué se copió de learn.pollium.io y qué no
El código de learn.pollium.io es `C:\dev\studyapp`. De ahí Berland tomó **solo lo visual**:
- el paso «Pensamiento» y el «Pensando…» del chat (`LiveReply.tsx:121-146`);
- el selector de esfuerzo de la mente (`MindSection.tsx:12,132`).

Lo que en Pollium ahorra tokens **no se copió**:

| Mecanismo | Dónde está en Pollium |
|---|---|
| Cada modelo declara cómo razona (`none` / `effort` / `thinking`), con su esfuerzo por defecto y una reserva de tokens | `contracts/src/modules/ai/domain.ts:3-20` |
| Modelo según el propósito (28 propósitos, como resumen, título o saludo) | `ModelResolver.ts:90-109` |
| Cadena de respaldo con 2 intentos por modelo | `AICompletionService.ts:107-131` |
| Nunca se reenvía el pensamiento anterior | `reasoning-echo.ts` |
| Presupuesto de prompt que se recalibra con el uso real y recorta resultados viejos | `PromptBudget.ts` |
| **Compactación**: cuando la historia no cabe, resume la mitad más antigua en ≤600 palabras con un modelo barato y solo recarga lo posterior | `ChatCompactionService.ts` |

## Cómo razonaba Berland (antes de este issue)
Nada dependía de la dificultad ni del rol:
- **Autor o revisor Claude:** Opus 5.5 sin `effort` (quedaba el valor de fábrica). `difficulty` solo servía para
  enrutar.
- **Mente:** Opus 5.5 con `effort: 'high'` siempre. Reenvía toda la historia, y el prompt le pide sondear `estado`:
  lo llamó 14 veces en 2 chats.
- **Planificador:** otro Opus en `medium` que reescribe en JSON el plan que la mente ya escribió.
- **Codex y agy:** sin opciones de esfuerzo.

En Opus 5.5 el pensamiento no se apaga, y `budget_tokens` da error 400: **el esfuerzo es la única palanca**.

## Dónde se fueron los tokens el 2026-11-04 (33,92 USD de Claude)

| Rol | USD | % del día |
|---|---|---|
| Autores | 23,11 | 68 % |
| Mente | 6,48 | 19 % |
| Revisores | 3,90 | 11,5 % |
| Planificador | 0,43 | 1,3 % |

- **Una sola sesión anómala:** registró 3,64 M de entrada con 0 de caché y costó 14,55 USD, el 43 % del día. Fue un
  autor de `nucleo-almacenamiento-local`, cancelado a los 85 min. **Era un error de cuenta** (paso 0).
- **La mente:** entre 22 k y 2,6 M tokens por turno, con 0,46 USD de media. Tras más de 5 min de pausa, la caché
  expira y el turno cuesta entre 0,4 y 1,7 USD.
- **El check se corre 3 veces por tarea:** autor, revisor y gate. En la base real, 15 sesiones de revisor corrieron 19
  veces el check completo (`npm run -s check`/`npm test`): 56,8 de sus 96,2 min (59 %).

## Paso 0: la sesión de 14,55 USD — causa y arreglo
Sesión `c229a2cc-…` (agente `claude`, tarea `nucleo-almacenamiento-local`), leída de la base en solo lectura:

- 18:06–18:18: trabajó 12 min (42 llamadas a herramientas, 18 archivos). 18:18:30–19:30:58: **72 min sin un solo
  evento** (una llamada a la API que no respondió). 19:30:58: dos reintentos del SDK; 19:31:02: cancelada. No llegó
  el `result`, así que el costo salió de `partialUsageEvents()`.
- Registró `inputTokens 3 636 812`, `cachedInputTokens 0`, **`outputTokens 32`** y `costUsd 14,547888` =
  3 636 812 × 4 USD/M + 32 × 20 USD/M: todo cobrado como entrada sin caché.
- **Causa:** el `usage` que trae cada mensaje del asistente es el de `message_start`. Tras el servidor intermedio
  (`ANTHROPIC_BASE_URL`, ids `toolu_bdrk_…`) llega **sin repartir la caché**: `cache_*` en 0, todo en `input_tokens` y
  `output_tokens: 1`. Los 32 tokens de salida son uno por llamada. Las fixtures grabadas lo muestran igual
  (`hook-deny.jsonl`: 3 mensajes con 31 510–32 225 de entrada y 0 de caché; su `result` dice 85 786 leídos de caché).
  **La caché sí funciona tras ese servidor:** las sesiones que terminaron leyeron de caché el 90–95 % de la entrada
  (p. ej. `c9ff1869`: 5,34 M de 5,62 M, 3,49 USD).
- **Arreglo** (`translate.ts`, solo la estimación): un mensaje sin la caché repartida se reparte como lo hace Claude
  Code. Dentro de cada hilo (sesión principal o subagente), el prompt de la llamada anterior se lee de caché si
  pasaron ≤ 5 min, y el resto se escribe. La primera llamada escribe todo. La entrada se corrige ×1,4: en las dos
  fixtures, la entrada real fue 1,41 y 1,43 veces lo que adelanta `message_start`. La salida se deduce de lo visible
  (texto, pensamiento y argumentos ÷ 3,5). Si la caché viene repartida (API directa), se usa tal cual.

| Sesión cortada antes del `result` | Real | Antes | Ahora |
|---|---|---|---|
| `hook-deny.jsonl` | 0,2728 USD | 0,3817 (1,40×) | 0,2505 (0,92×) |
| `subagent-run.jsonl` | 0,4018 USD | 0,3481 (0,87×) | 0,3985 (0,99×) |
| `nucleo-almacenamiento-local` (3,64 M) | — | 14,55 | ≈ 2,5–3 (estimado: ~32 llamadas de 30 k a 200 k tokens) |

El tope por tarea depende de esto: con la cuenta vieja, una tarea low (1 USD) se habría cortado a unos 0,2 USD
reales. El tope fino lo pone el propio SDK (`maxBudgetUsd`, con su cuenta exacta); la estimación es la red de
seguridad y lo que se registra al cancelar.

Queda una segunda causa sin arreglar: **los 72 min colgados** (ver «Propuestas»).

## Cambios hechos

| # | Cambio | Dónde |
|---|---|---|
| 0 | Estimación del costo de una sesión cortada (caché por hilo, TTL 5 min, entrada ×1,4, salida del contenido) | `adapters/claude-sdk/translate.ts` |
| 2 | Esfuerzo y modelo por rol y dificultad; reintento = un nivel más | `brief/reasoning.ts` (nuevo), `adapters/claude-sdk/adapter.ts`, `adapters/codex-cli/index.ts` |
| 2 | `excludeDynamicSections: true` en el preset (el SDK 0.3.302 lo admite) | `adapters/claude-sdk/adapter.ts` |
| 2 | Planificador: Sonnet 5.5, esfuerzo low (`model`/`effort` configurables) | `app/planner.ts` |
| 2 | Mente: esfuerzo por defecto `medium` | `shared/api.ts` (`DEFAULT_SETTINGS`, una línea) |
| 3 | Tope de USD por tarea; HANDOFF y `detail` al superarlo | `orchestrator/supervisor.ts`, `orchestrator/fleet.ts`, `app/fleet-service.ts` (`FleetTuning`) |
| 4 | Gate antes de revisar, sin LLM; si falla, vuelve al autor sin revisión; su resumen va en el encargo | `orchestrator/fleet.ts` (`FleetOptions.verify`, `buildReviewTask`) |
| 6 | Lecturas recortadas: sin AGENTS.md para Claude y Codex, sin `.orq/PLAN.md` en la revisión, plan mínimo sin repetir el encargo, informe breve del revisor | `brief/render-brief.ts`, `brief/render-plan.ts` |
| — | Commits sin atribución: `settings.attribution` vacío y una regla en `append` | `adapters/claude-sdk/adapter.ts` |

### Cómo llega cada cosa al agente
- **Rol:** `isReviewTask(task)`, sin tocar los contratos.
- **Reintentos y tope:** el Supervisor agrega a `RunContext` dos campos opcionales (`RunHints`: `retries` y
  `budgetUsd`, en `brief/reasoning.ts`). Un adaptador que no los conoce los ignora. **Propuesta para A0:** llevarlos al
  contrato `RunContext` de `src/shared/tasks.ts`.
- **Cuentan como reintento:** un intento fallido o con tiempo agotado (dentro de `Supervisor.execute`), cada ronda de
  corrección tras un rechazo o un gate fallido (`retryBase = ronda − 1`) y el segundo revisor. Un traspaso por cupo no
  cuenta.

| Rol | Esfuerzo | Modelo |
|---|---|---|
| Autor Claude | low / medium / high según la dificultad; +1 por reintento, hasta `xhigh` | el del agente (Opus 5.5) |
| Revisor Claude | medium; +1 por reintento | Sonnet 5.5 en tareas low y medium (`reviewModel`, `null` lo desactiva); el del agente en high |
| Codex (autor o revisor) | igual que Claude, con techo `high` | el del agente |
| Planificador | low | Sonnet 5.5 |
| Mente | medium por defecto | — |
| agy | sin cambios (sin opción de esfuerzo) | — |

Un `effort` fijo en `extraOptions` del adaptador sigue mandando sobre la tabla.

### Tope por tarea
- Se cuenta lo que informan los agentes (`usage.costUsd`) de autores y revisores, **por ciclo**. Un reintento del
  usuario empieza con el tope entero.
- El Supervisor pasa lo que queda a cada intento. Claude lo usa como `maxBudgetUsd` (el menor entre ese y el del
  agente) y corta en curso con su estimación. Al llegar al tope (`spent ≥ 0,99 × tope`), `execute` devuelve
  `budget`. No reintenta, no traspasa y no marca al agente sin cupo.
- La flota escribe al final de `.orq/HANDOFF.md` (sin borrar lo que dejó el agente) una sección «Detenida por el tope
  de gasto» con el resumen del último intento. Avisa y deja la tarea `failed` con este `detail`: «tope de gasto de la
  tarea superado: X de N USD (dificultad d); lo hecho queda en .orq/HANDOFF.md: reintenta para continuar desde ahí».
  El worktree se conserva y el reintento (issue 3) lee ese HANDOFF.

### Gate antes de revisar
- `FleetOptions.verify(workspace, task, signal)` → `{ ok, summary }` o `undefined` (sin gate). Por defecto usa
  `workspaces.verify` si el gestor lo tiene. Corre después del resumen del diff, que confirma el trabajo, para que los
  restos del gate no entren en el commit.
- Si pasa, el encargo de revisión lleva «### Verificación del proyecto (gate)» con el resumen y la orden de no repetir
  el check completo (solo pruebas puntuales). Si falla, la tarea vuelve al autor con el resumen como observación y no
  se gasta una revisión. Si no hay gate o `verify` falla, el revisor comprueba como antes.
- **En producción:** `CommittingWorkspaces.verify` (`app/commit-step.ts`) delega en `ProjectWorktrees.verify`
  (`app/workspaces.ts`): para un worktree corre el gate del proyecto con `untrustedRoots: [worktreesRoot]`; en modo
  local, `LocalWorkspaces.verify` corre el gate en la carpeta sin hacer commit.

## Medidas
### Encargo y lecturas obligatorias (caracteres; tokens ≈ caracteres ÷ 3,5)
Script de medida: versión de `d746f2f` frente a la del worktree, con `renderBrief`, `renderPlanFile` y
`buildReviewTask`. Diff de ejemplo de 230 caracteres, plan de tarea de 190 y resumen de gate de 60. El AGENTS.md de
este repo tiene 2512 caracteres.

**Fixtures `fixtures/repo-ejemplo/tareas.json` (3 tareas, objetivos cortos):**

| Pieza (media por tarea) | Antes | Ahora | Baja |
|---|---|---|---|
| Encargo del autor | 1645 | 1631 | −14 (1 %) |
| `.orq/PLAN.md` mínimo | 902 | 397 | −505 (56 %) |
| Encargo de revisión (ahora con el resumen del gate) | 2662 | 2633 | −29 (1 %) |
| **Autor: encargo + lecturas pedidas** | 5060 (≈1446 tokens) | 2029 (≈580) | **−60 %** |
| **Revisor: encargo + lecturas pedidas** | 6076 (≈1736 tokens) | 2633 (≈752) | **−57 %** |

**Tareas reales de la base (16, leídas en solo lectura, sin imprimir contenido):**

| Pieza (media por tarea) | Antes | Ahora | Baja |
|---|---|---|---|
| Encargo del autor | 4548 | 4534 | −14 (0 %) |
| `.orq/PLAN.md` mínimo | 3653 | 406 | −3247 (89 %) |
| Encargo de revisión | 5585 | 5572 | −13 (0 %) |
| **Autor: encargo + lecturas pedidas** | 10 712 (≈3061 tokens) | 4939 (≈1411) | **−54 %** |
| **Revisor: encargo + lecturas pedidas** | 11 749 (≈3357 tokens) | 5572 (≈1592) | **−53 %** |

«Lecturas pedidas» son las de «Lee primero»: `.orq/PLAN.md` y AGENTS.md (Claude ya lo tiene en el prompt de sistema;
Codex lo carga solo). Con un plan general, el autor sigue leyéndolo; el revisor ya no. Lo que entra al principio de
la sesión se vuelve a leer de caché en cada llamada (~1,7 k tokens menos × ~50 llamadas por sesión); el ahorro en USD
es pequeño, el de tiempo y contexto no: son lecturas que el agente ya no hace.

### Revisores en la base real
15 sesiones de revisor, 14 corrieron el check: 19 corridas completas que sumaron 56,8 de sus 96,2 min (59 %). Con el
gate previo, el revisor no corre ninguna. El gate corre una vez fuera del LLM y, si falla, no hay revisión.

### Ahorro estimado sobre un día como el analizado

| Cambio | Ahorro | Base |
|---|---|---|
| 0 (cuenta corregida) | −12 USD **registrados** (14,55 → ~2,7) | no es gasto real: era un error de cuenta |
| 3 (tope por tarea) | corta las sesiones desbocadas (a 1/3/8 USD) | antes no había tope por tarea |
| 2 (esfuerzo y modelo por rol) | 15–30 % de la salida de autores low/medium; revisiones low/medium en Sonnet: mitad de precio en entrada nueva y salida (2/10 frente a 4/20 USD/M), igual en lo leído de caché (0,2) | 3,90 USD de revisores → ~2–2,5 |
| 4 (revisión sin repetir el check) | 40–60 % de las revisiones (59 % del tiempo del revisor era el check) | medido arriba |
| 6 (lecturas y caché compartida) | ~1,7–1,8 k tokens menos al inicio de cada sesión (−53–60 % de encargo + lecturas); 5–10 % de la entrada de los workers por la caché compartida | medido arriba |
| Planificador | −50 % del precio y menos pensamiento | 0,43 USD |
| Mente (`medium`) | menos pensamiento por turno; la compactación sigue pendiente | 6,48 USD |

## Pendiente (fuera de las rutas de este encargo)
1. **Gate en producción:** `verify` en `CommittingWorkspaces` / `ProjectWorktrees` / `LocalWorkspaces` (arriba).
2. **Gate de integración repetido:** si la rama de integración no se movió desde que pasó el gate previo, el árbol
   fusionado es el mismo y el gate de `integrate` se podría saltar (`workspace/integrate.ts`). Es una corrida
   completa menos por tarea (~4 min en este repo).
3. **`RunHints` al contrato:** `retries?` y `budgetUsd?` en `RunContext` (`src/shared/tasks.ts`).
4. **Sesión colgada 72 min:** el plazo por inactividad del Supervisor es de 60 min y solo lo reinician los eventos.
   `tool_progress` no emite nada (`translate.ts`), así que no se puede bajar sin cortar comandos largos. Propuesta:
   un latido `status` cada ~2 min desde `tool_progress` (en `translate.ts`, fuera del cálculo de costo) y un plazo
   por inactividad de ~15 min en `FleetTuning.timeoutMs`.
5. **Uso exacto en curso:** con `includePartialMessages`, el `message_delta` de cada llamada trae el uso final. Hace
   falta grabar una fixture en vivo tras el servidor intermedio antes de usarlo en lugar de la estimación.
6. **`sessions.task_id` vacío:** las 172 sesiones de la base tienen `task_id` NULL. El sink crea la sesión antes de
   que `FleetService.#activity` la enlace. Sin eso no se mide el uso por tarea (issue 5).
7. **El prompt del adaptador no lleva el contexto de memoria ni la sección de modo local:** `renderBrief(task,
   handoff)` sin opciones; solo los tiene `.orq/BRIEF.md`.
8. **AGENTS.md de este repo** pide a cada agente leer el PLAN.md raíz (18 157 caracteres) y la skill de la flota: es
   lectura obligatoria en cada worker.

## Mente (propuestas; `src/core/conductor/**` y `src/core/chat/**` son de otros agentes)
- **Compactación como Pollium:** al reanudar tras más de 5 min, o con más de ~80 k tokens, sesión nueva con un resumen
  de ≤600 palabras (Haiku 5.5 o Sonnet 5.5 en low) y los últimos 2–4 turnos. Se prueba con un reloj falso.
- **Quitar el sondeo de `estado`** del prompt: el servicio ya avisa de los cambios de las tareas.
- **Subagente `investigador`** con modelo barato (Haiku 5.5 o Sonnet 5.5) y esfuerzo `low`.
- **Sin el plan duplicado** en `escribir_memoria`, y que el planificador no vuelva a escribir en JSON el plan que la mente
  ya escribió: la mente podría crear las tareas directamente (`crear_tareas`).

## Criterios de aceptación
1. ✅ Cada rol y dificultad llama con el esfuerzo y el modelo de la tabla, comprobado con pruebas de las opciones que
   recibe el SDK y los argumentos de Codex (`tests/core/adapters/claude-sdk/reasoning.test.ts`,
   `tests/core/adapters/codex-cli/adapter.test.ts`, `tests/core/app/planner.test.ts`, `tests/core/brief/reasoning.test.ts`).
2. ✅ Una tarea que supera su tope se detiene con HANDOFF y avisa (`tests/core/orchestrator/razonamiento.test.ts`).
3. ✅ en la flota / ⏳ en producción: el revisor recibe el resumen del gate y no repite el check (falta `verify` en el
   gestor de workspaces).
4. ⏳ La mente, tras una pausa larga, arranca con resumen y los últimos turnos (propuesta: rutas de otros agentes).
5. ⏳ Una semana después, el uso medido (issue 5) muestra la baja por rol.
6. ✅ `npm run -s check` en verde: 142 archivos de prueba aprobados y 10 saltados (152); 1771 pruebas aprobadas y 20
   saltadas (1791); 3 min 29 s (antes de este issue: 138 + 10 archivos, 1726 + 20 pruebas).

## Requisito transversal
El adaptador de Claude no deja que los agentes añadan `Co-Authored-By` ni «Generated with» en sus commits:
`settings: { attribution: { commit: '', pr: '', sessionUrl: false } }` (opción del SDK) y una regla en `append`.
