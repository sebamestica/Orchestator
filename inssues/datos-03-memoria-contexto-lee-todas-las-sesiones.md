# buildContext abre y parsea en serie todas las notas de Sesiones/, de todos los proyectos, en cada encargo

- **Área:** Datos y almacenamiento
- **Severidad:** baja
- **Archivos:** `src/core/memory/obsidian-memory.ts:198`, `src/core/memory/obsidian-memory.ts:328`, `src/core/memory/obsidian-memory.ts:495`, `src/core/memory/obsidian-memory.ts:510`, `src/core/memory/obsidian-memory.ts:519`, `src/core/memory/obsidian-memory.ts:570`, `src/core/memory/obsidian-memory.ts:597`, `src/core/orchestrator/fleet.ts:368`, `src/core/orchestrator/fleet.ts:698`, `src/core/conductor/tools.ts:366`, `src/core/server/app.ts:741`
- **Estado:** abierta

## Cómo ocurre
La memoria de Berland vive en una bóveda de Obsidian (`ObsidianMemory`, creada sin caché ni envoltorio en
`src/core/app/compose.ts:156`). Todas las notas de sesión de todos los proyectos van a una sola carpeta plana,
`<bóveda>/Orquestador/Sesiones/`, con nombre `<fecha>-<tarea>[-n]`, sin el proyecto en el nombre:

```ts
// obsidian-memory.ts:198 y :328
private sessionsDir(): string { return `${this.rootFolder}/Sesiones`; }
const note = `${this.sessionsDir()}/${date}-${s.taskId}${n === 1 ? '' : `-${n}`}`;
```

La flota escribe una nota por turno de cada autor (`#recordSessions`, `fleet.ts:706`), así que la carpeta
crece con cada tarea de cualquier proyecto y nada la poda ni la archiva (no hay otra referencia a `Sesiones` en `src/`).

`buildContext` se llama en tres sitios:
- al empezar cada tarea de la flota: `#cycle` → `#memoryContext` (`fleet.ts:368` → `fleet.ts:698`);
- en la herramienta `leer_memoria` de la mente (`conductor/tools.ts:366`), que la mente puede llamar varias veces por conversación;
- en la ruta de contexto del servidor (`server/app.ts:741`).

Cada llamada hace `listSessions` → `readSessions` (`obsidian-memory.ts:570` → `:495`), que lista toda la carpeta y
luego abre y parsea las notas una a una con `await`. Solo después de abrir cada archivo descarta las de otros proyectos:

```ts
// obsidian-memory.ts:510-519
for (const name of names) {
  let text: string;
  try {
    text = await readFile(path.join(dir, name), 'utf8');
  } catch { continue; }
  try {
    const { data, body } = parseNote(text, { lenient: true, skipBadLines: true });
    if (data.tipo !== 'sesion' || data.proyecto !== id) continue;
```

Al final `buildContext` se queda con `maxSessions` = 8 (`obsidian-memory.ts:180` y `:570`). Leer una nota de otro
proyecto nunca cambia el resultado, pero se paga igual. `fullHistory` (`:597`) repite el mismo recorrido, y
`measureContext` (`:603-605`) lo hace dos veces seguidas.

Pasos para que pase: usar Berland con varios proyectos durante un tiempo. Cada encargo nuevo, cada `leer_memoria` y
cada consulta a la ruta de contexto hacen 1 `readdir` más N `readFile` + `parseNote` en serie, con N = todas las
sesiones de la bóveda. En Windows, Defender revisa cada apertura, y si la bóveda está en OneDrive (la configuración lo
permite, ver `DEFAULT_VAULT` en `:25` y `ORQ_MEMORY_DIR` en `compose.ts:26`) un archivo que esté «solo en la nube» se
descarga al abrirlo.

Lo que hay hoy: la bóveda por defecto (`C:\dev\orquestador-memoria`) tiene 13 notas de sesión, de cinco días
(del 2026-11-01 al 2026-11-05). Por eso la severidad es baja: hoy no se nota. Pero el costo crece en línea recta con la
suma de todos los proyectos, sin tope, y queda en el camino de arranque de cada tarea. A ese ritmo, y más con la flota
completa en paralelo, se llega a cientos o miles de notas en meses.

## Por qué pasa
No hay partición ni índice por proyecto. El proyecto de una sesión solo está en el frontmatter (`proyecto:`,
`obsidian-memory.ts:276`), así que para saber si una nota sirve hay que abrirla y parsearla. Además, el recorrido es
estrictamente secuencial (`for … await readFile`) y no guarda nada en memoria entre llamadas: cada `buildContext`
vuelve a leer todo desde el disco aunque nada haya cambiado.

El problema no es el issue 09 (`docs/plan/issues/09-aislamiento-contexto.md`, commit 3bdc166). Ese arregló *qué* se
muestra (`:519` descarta las de otro proyecto) y no tocó el costo. `obsidian-memory.ts` no cambia desde 79efa49.

## Solución posible
Partir la carpeta por proyecto, sin cambiar qué sesiones entran al ranking:

1. `src/core/memory/obsidian-memory.ts`:
   - `sessionsDir(projectId)` → `${rootFolder}/Sesiones/<proyecto>`. `freeSessionNote` (`:326-335`) crea ahí las
     notas nuevas, y `ensureStructure` crea la subcarpeta bajo el mismo `assertRealInside`.
   - `readSessions(projectId)` lista solo `Sesiones/<proyecto>/`. Para las notas antiguas de la carpeta plana, mientras
     existan, se agrega una migración única bajo `exclusive()`: mover cada `.md` plano a la subcarpeta de su `proyecto:`
     y reescribir los enlaces `[[Orquestador/Sesiones/<nota>|…]]` en `Proyectos/<id>/Contexto.md` y en
     `Agentes/<id>.md`. Si no se quiere migrar, se puede seguir leyendo la carpeta plana como respaldo de solo lectura.
   - Mantener la guardia de `readSessions` (archivos normales, ruta real dentro de la bóveda) también en la subcarpeta.
2. Las lecturas que queden, hacerlas en paralelo con un límite bajo (por ejemplo 8) en lugar de una por una, y que
   `measureContext` lea las sesiones una sola vez para `buildContext` y `fullHistory`.

Ojo: **no** basta con «leer solo las N más recientes». `rankSessions` (`src/core/memory/context.ts:121-154`) puntúa
todas las sesiones del proyecto por misma tarea, rutas y palabras, y la recencia es relativa a la más nueva. Si se
corta por fecha antes del ranking, el contexto cambia. Partir por proyecto no cambia el resultado; truncar sí.

### Otras opciones
La propuesta no es la única, y alguna de estas puede salir más barata:
- **Caché en memoria por (nombre, mtime, tamaño)** dentro de `ObsidianMemory`: guardar el `SessionCandidate` ya
  parseado y su `proyecto`. Con eso, cada `buildContext` solo hace `readdir` + `stat`, y `readFile` solo para notas
  nuevas o editadas en Obsidian. No cambia rutas ni enlaces ni pruebas, pero el `readdir` + `stat` sigue siendo O(total).
- **Usar la bitácora que ya existe como índice:** `recordSession` agrega a `Proyectos/<id>/Contexto.md`, sección
  «Bitácora», un enlace a cada nota de sesión del proyecto (`obsidian-memory.ts:313`), y `buildContext` ya lee ese
  archivo (`projectSummary`, `:541`). Se podrían leer solo las notas enlazadas ahí. La contra es que el usuario puede
  editar la bitácora en Obsidian y perder enlaces, así que haría falta un respaldo.
- **Índice propio** (JSON en la bóveda, o una tabla en el SQLite del núcleo) de proyecto → nota, tarea, título,
  archivos y fecha, actualizado en `recordSession` bajo el mismo candado. Es lo más rápido para leer, pero deja dos
  fuentes de verdad, y las ediciones hechas a mano en Obsidian quedarían fuera hasta reindexar.
- **Nombre con el proyecto** (`<fecha>-<proyecto>-<tarea>`) en la carpeta plana: filtra por nombre sin abrir, pero
  `readdir` sigue siendo de toda la bóveda y el nombre puede pasar de lo cómodo.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: `tests/core/memory/obsidian-memory-escala.test.ts`.
  - Arma una bóveda temporal (`mkdtemp`, como en `obsidian-memory.test.ts:102`) con 5 sesiones del proyecto `alfa`
    (grabadas con `recordSession`) y unas 3000 notas de sesión de `beta` (escritas directamente con `writeFile`, para
    que sea rápido). Si hay migración, que esas 3000 estén en la carpeta plana antigua.
  - Envuelve `readFile` con `vi.mock('node:fs/promises', async (orig) => ({ ...(await orig()), readFile: vi.fn(...) }))`
    y cuenta las lecturas dentro de `Sesiones/`.
  - Afirma que `buildContext('alfa', tarea, 4000)` abre como mucho las 5 notas de `alfa` (más `Contexto.md`), no
    las 3005, en la segunda llamada si se usa migración o caché.
  - Afirma que el texto devuelto es igual al de una bóveda que solo tiene las 5 sesiones de `alfa`, sin contar la ruta
    `(Orquestador/Sesiones/…)` de cada línea si la nota cambió de carpeta. Los casos de `tests/core/memory/aislamiento.test.ts`
    deben seguir pasando: misma tarea en dos proyectos, y ningún texto de `beta` en el contexto de `alfa`.
  - Si se migra: las notas de `beta` terminan en `Sesiones/beta/`, y los enlaces de `Proyectos/beta/Contexto.md` y de
    `Agentes/<id>.md` apuntan a la ruta nueva.
  - Hay que revisar las pruebas que fijan rutas `Sesiones/…`: `obsidian-memory.test.ts`, `obsidian-memory-revision.test.ts`,
    `context.test.ts`, `aislamiento.test.ts` y `safe-fs.test.ts`.
- Comando para correrla (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/memory/obsidian-memory-escala.test.ts tests/core/memory"`
  (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/core/memory`).
- Verificación manual en la app: con una bóveda que tenga muchas sesiones de otros proyectos, lanzar una tarea y pedir
  a la mente `leer_memoria`. El contexto debe ser el mismo de antes y la tarea debe arrancar sin la pausa de leer toda
  la bóveda. En Obsidian, los enlaces de la bitácora del proyecto deben seguir abriendo sus sesiones.
