# Las decisiones que la mente guarda con `escribir_memoria`, incluido el «Plan: …» obligatorio, nunca vuelven en `leer_memoria` ni en los encargos de la flota

- **Área:** Datos y almacenamiento
- **Severidad:** alta
- **Archivos:** `src/core/memory/obsidian-memory.ts:9`, `src/core/memory/obsidian-memory.ts:100`, `src/core/memory/obsidian-memory.ts:394-424`, `src/core/memory/obsidian-memory.ts:541-551`, `src/core/memory/obsidian-memory.ts:558-588`, `src/core/conductor/tools.ts:343-372`, `src/core/conductor/tools.ts:374-406`, `src/core/conductor/prompt.ts:36-37`, `src/core/conductor/prompt.ts:51`, `src/core/conductor/prompt.ts:63`, `src/core/orchestrator/fleet.ts:698`, `src/core/server/app.ts:741`, `src/core/app/conductor.ts:123-128`, `tests/core/conductor/real-ports.test.ts:39-58`
- **Estado:** abierta
- **Origen:** autoevaluación de la mente (2026-11-05), afirmaciones 1 («no tiene memoria propia») y 3 («contexto limitado»)
- **Relacionadas:** `datos-03` (mismo `buildContext`, visto por su costo), `datos-05` (registro de sesión a medias), `autoeval-trabajo-04` (lo que la mente hace ella misma tampoco llega a la memoria)

## Cómo ocurre

**Contexto.** La mente no recuerda nada entre sesiones salvo lo que lee con `leer_memoria`. Su prompt le pide guardar
lo importante como decisión y releerlo antes de planificar:

```ts
// src/core/conductor/prompt.ts:36-37
- leer_memoria(proyecto, tarea?): extracto breve de la memoria del proyecto. Léela antes de planificar para no repetir contexto ni decisiones.
- escribir_memoria(proyecto, nota): guarda una decisión o el resumen vivo del proyecto, …
// prompt.ts:51
Pásalo íntegro en plan, sin resumirlo, y guárdalo con escribir_memoria (tipo decision, título «Plan: …»).
```

`escribir_memoria` con `tipo: 'decision'` llama a `recordDecision` (`tools.ts:400-402`), que crea una nota en
`Orquestador/Decisiones/<fecha>-<tema>.md` con `proyecto: <id>` en el frontmatter (`obsidian-memory.ts:394-424`). No
toca `Contexto.md` ni deja ningún enlace en otra nota.

`leer_memoria` llama a `buildContext` (`tools.ts:366`), y `buildContext` solo lee dos cosas
(`obsidian-memory.ts:558-588`): el resumen de `Proyectos/<id>/Contexto.md` (`projectSummary`, `:541-551`) y las
notas de `Sesiones/`. No mira `Decisiones/`. Tampoco mira `Proyectos/<id>/Planes/`. La flota usa la misma función
para el contexto de cada encargo (`fleet.ts:698`), igual que la ruta de contexto del servidor (`app.ts:741`).

**Pasos.**

1. En un chat del proyecto P, el usuario decide algo («no publiques hasta que yo lo lea») y la mente lo guarda con
   `escribir_memoria { nota: { tipo: 'decision', titulo: 'Retener T5…', texto: '…' } }`. La herramienta responde
   `{ ok: true, tipo: 'decision', proyecto: 'P', nota: 'Orquestador/Decisiones/…' }`.
2. Otro chat de P, el mismo chat después de compactar el contexto o un encargo nuevo de la flota llaman a
   `leer_memoria {}` o a `buildContext('P', …)`.
3. La respuesta trae el resumen y las sesiones, pero no la decisión. Si P no tiene resumen ni sesiones, la mente
   recibe «Sin memoria guardada para P.» (`tools.ts:367`) y lo informa con toda seguridad.
4. La mente tampoco puede ir a buscar la nota por su cuenta: la guardia le niega `Read`, `Grep` y `Glob` sobre toda la
   bóveda de memoria (`mindDenyPaths`, `src/core/app/conductor.ts:123-128`: «se lee solo con `leer_memoria`»). Aunque
   recordara la ruta que le devolvió `escribir_memoria`, no podría abrirla.

**Evidencia en la bóveda real** (`C:\dev\orquestador-memoria\Orquestador`, solo lectura):

- `Decisiones/` tiene 18 notas al revisar este borrador (17 cuando se escribió; la mente sigue grabando), 6 de ellas
  planes («Plan: …», «Plan v3: …»). Ninguna llega al contexto. `Proyectos/orquestador/Planes/` (5 notas) y
  `Proyectos/professional/Planes/` (1) tampoco.
- El proyecto `professional` tiene en `Contexto.md` solo el marcador `%% Resumen vivo… %%`, que `stripComments`
  quita, y 2 sesiones. Sus 4 decisiones no le llegan a la mente, entre ellas
  `2026-11-05-retener-t5-y-t11-publican-hasta-aprobacion-explicita.md` («aplicar-github (T5) y aplicar-linkedin (T11)
  publican en GitHub y LinkedIn: no se delegan hasta que el usuario lea la propuesta final») y
  `2026-11-05-usuario-github-sebamestica-todo-local-sin-git-…`. Un chat nuevo de `professional`, o el mismo chat
  después de compactar, no ve esa regla de retención. T5 y T11 ya quedaron aprobadas (el modo bypass las aprobó solas,
  lo dice la misma nota), así que en bypass nada más que esa decisión frena que se deleguen y publiquen. Por eso la
  severidad es alta: una restricción que el usuario dio y que la herramienta confirmó como guardada deja de cumplirse
  sin aviso.
- La prueba con piezas reales graba una decisión y lee la memoria, pero no comprueba que la decisión vuelva
  (`tests/core/conductor/real-ports.test.ts:46-52`: graba «Orquestador sin Bash» en la línea 46 y después solo afirma
  el texto del resumen).

## Por qué pasa

Las decisiones y los planes se escriben en carpetas que el lector de contexto no recorre. `recordDecision` y
`buildContext` nacieron juntos (commit `9dfd314`, 2026-11-01), con las decisiones pensadas como registro para leer en
Obsidian y el contexto armado solo con el resumen y las sesiones. Después `escribir_memoria` (`4650e39`) le dio
`recordDecision` a la mente, y `9b7d84a` (2026-11-04) volvió obligatorio guardar cada plan como decisión «Plan: …».
Ninguno de los tres cambios sumó la lectura. La descripción de `leer_memoria` (`tools.ts:344`: «resumen vivo y
sesiones pertinentes») es exacta, pero el prompt (`prompt.ts:36`) le hace creer a la mente que ahí también están las
decisiones («para no repetir contexto ni decisiones»).

La única forma de que una decisión vuelva hoy es que la mente la copie también en el resumen vivo (`tipo: 'resumen'`,
que reemplaza el anterior). El marcador que `writeProjectSummary` deja en `Contexto.md` lo sugiere («estado, decisiones
y rutas clave», `obsidian-memory.ts:100`), pero ni el prompt ni la herramienta lo piden, y en `professional` la mente
no lo hizo. Como la guardia le niega leer la bóveda directamente (`conductor.ts:123-128`), no tiene otra vía. En la
práctica la memoria de decisiones es de solo escritura.

## Solución posible

1. **`src/core/memory/obsidian-memory.ts`:**
   - Agregar `private async readDecisions(projectId)`, con la misma guardia que `readSessions` (`assertRealInside`,
     solo archivos normales, ENOENT → `[]`). Lista `Decisiones/` y se queda con `tipo: decision` y `proyecto === id`.
   - En `buildContext`, después del resumen y antes de las sesiones, agregar un bloque
     `### Decisiones del proyecto` con las más recientes primero, una línea por decisión: fecha, título y las primeras
     ~300 letras del cuerpo, más la ruta de la nota. Usar el mismo `BudgetWriter`, sin pasar del presupuesto.
     Conviene darles prioridad sobre las sesiones, porque son reglas vigentes y las sesiones son historia.
   - Los planes («Plan: …») pueden ocupar mucho. En el contexto basta el título y la ruta de la nota. Ojo: la mente no
     puede abrir esa ruta con `Read` (la guardia niega la bóveda, `conductor.ts:123-128`). Si hace falta el texto
     entero, se puede sumar a `leer_memoria` un parámetro opcional `nota` que devuelva una decisión del mismo
     proyecto, con la guardia de rutas y el tachado de siempre.
2. **`src/core/conductor/prompt.ts:36`:** decir qué trae `leer_memoria` (resumen, decisiones y sesiones) para que la
   mente no suponga más ni menos.

### Otras opciones

- **Enlazar cada decisión desde `Contexto.md`.** `recordDecision` agrega una línea en una sección
  `## Decisiones` de `Contexto.md`, y `projectSummary` deja de quitarla. Es más barato de leer (un archivo), pero si el
  usuario edita `Contexto.md` en Obsidian puede borrar enlaces, y queda texto duplicado.
- **Índice en el SQLite del núcleo** (proyecto → nota, título, fecha). Lee rápido, pero suma una segunda fuente de
  verdad que no ve las ediciones hechas a mano en Obsidian.
- **Herramienta aparte `leer_decisiones`.** Separa el presupuesto, pero obliga a la mente a acordarse de llamarla, que
  es justo el fallo que se quiere evitar.
- **Solo prompt: que cada decisión se copie también al resumen vivo.** Cambiar `prompt.ts:37` y la descripción de
  `escribir_memoria` (`tools.ts:376-377`) para que, tras grabar una decisión vigente, la mente reescriba el resumen con
  ella. No toca código de memoria, pero depende de que la mente lo haga siempre (en `professional` no lo hizo), el
  resumen tiene tope de 8000 caracteres y cada reescritura puede perder lo anterior. No sirve para los planes largos.

La propuesta no es la única. Puede haber una mejor, por ejemplo unificar sesiones, decisiones y planes en un solo
recorrido indexado si se resuelve antes `datos-03`. Basta con que las pruebas de abajo pasen.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:**
  - `tests/core/memory/obsidian-memory.test.ts`, nuevo caso «buildContext trae las decisiones del proyecto»: bóveda
    temporal (`mkdtemp`). `recordDecision` de `alfa` con título «Retener T5 hasta aprobación» y de `beta` con
    «Decisión ajena». Afirmar que `buildContext('alfa', briefGeneral, 4000)` contiene «Retener T5 hasta aprobación» y
    la ruta `Orquestador/Decisiones/…`, y que no contiene «Decisión ajena». Con un presupuesto chico (300) el texto no
    pasa del tope.
  - `tests/core/conductor/real-ports.test.ts:46-52`: después de grabar la decisión «Orquestador sin Bash», agregar
    `expect(context).toContain('Orquestador sin Bash')`. Hoy esa línea falla.
  - `tests/core/conductor/real-ports.test.ts`, caso nuevo con `ObsidianMemory` real: un proyecto sin resumen ni
    sesiones graba una decisión con `escribir_memoria`, y `leer_memoria {}` ya no devuelve «Sin memoria guardada»
    sino un texto que contiene el título de la decisión.
  - Los casos de `tests/core/memory/aislamiento.test.ts` deben seguir pasando: ninguna decisión de otro proyecto entra.
- **Comando** (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/memory tests/core/conductor/real-ports.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/memory tests/core/conductor/real-ports.test.ts`).
- **Verificación manual:** abrir un chat nuevo del proyecto `professional` y pedirle a la mente que lea su memoria. La
  respuesta de `leer_memoria`, visible en los pasos del turno, debe nombrar la decisión «Retener T5 y T11 (publican)
  hasta aprobación explícita».
