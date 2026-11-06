# El núcleo murió con 3 tareas y 4 sesiones en curso y ningún registro dice cuándo ni cómo terminó

- **Área:** Evidencia de uso real (núcleo y app de escritorio: registro y supervisión del proceso)
- **Severidad:** media
- **Archivos:** `src/core/app/cli.ts:24`, `src/core/app/cli.ts:59`, `src/core/app/cli.ts:66-70`, `src/core/app/cli.ts:76-83`, `src/core/app/cli-commands.ts:129-133`, `src/core/server/app.ts:191`, `src/core/app/fleet-service.ts:238-263`, `apps/desktop/src/core-supervisor.ts:58-59`, `apps/desktop/src/core-supervisor.ts:152-159`, `apps/desktop/src/core-supervisor.ts:162-176`, `apps/desktop/src/core-supervisor.ts:201`, `apps/desktop/src/core-supervisor.ts:231`, `apps/desktop/src/core-supervisor.ts:246-252`, `apps/desktop/src/core-supervisor.ts:275-278`
- **Estado:** resuelta

## Cómo ocurre

Contexto: la app de escritorio lanza el núcleo con `node.exe src/core/app/cli.ts iniciar`, oculto y desacoplado, con
stderr directo al archivo `logs/nucleo-escritorio.log` (dentro de `%LOCALAPPDATA%\orquestador`). Ese archivo es el único
registro del núcleo. La ventana escribe el suyo en `logs/escritorio.log`. Si al cerrar la ventana hay trabajo en curso,
el núcleo sigue vivo y la sesión cifrada (`session.json`, con pid y token) queda guardada para que otra ventana lo adopte.

Lo que pasó (lo comprobé en los registros y en la base, solo leyendo):

1. `escritorio.log`: a las `2026-11-05T00:37:58Z` la ventana A lanza el núcleo pid 5336. A las `01:38:13Z` A se cierra
   con «1 tarea en curso: el núcleo sigue vivo». A las `01:38:17Z` la ventana B lo adopta («núcleo vivo de una apertura
   anterior (pid 5336, 4 tareas en curso): se reutiliza»). A las `01:38:53Z` B se cierra con «4 trabajos en curso…: el
   núcleo sigue vivo». Desde ese momento ningún proceso vigila al núcleo.
2. En la tabla `events` el último evento antes del reinicio es de `2026-11-05T01:40:34.380Z`. Entre `01:40:35` y
   `02:20:20` no hay ningún evento.
3. `nucleo-escritorio.log`, líneas 760-784: la sesión del pid 5336 termina con `GET /tasks 200 5ms` y `GET /chats 200 1ms`,
   y la línea siguiente ya es `--- 2026-11-05T02:20:21.224Z Berland lanza el núcleo en el puerto 47811 ---`. No hay
   traza, código de salida, señal ni mensaje de apagado. Las líneas de acceso no llevan hora, así que tampoco se puede
   saber cuándo fue la última petición.
4. La línea siguiente de `escritorio.log` a las `02:20:21Z` es «núcleo lanzado (pid 26080)». No dice que el núcleo
   anterior ya no estaba.
5. El núcleo nuevo escribe «flota: 3 tarea(s) interrumpida al reiniciar el núcleo…: rutas-portables, ayuda-ia,
   chrome-diagnostico» y «flota: 4 sesión(es) de agentes abiertas al reiniciar quedan canceladas». No dice cuándo dejó
   de funcionar el anterior.

Lo único que se puede deducir es por descarte. No fue una excepción de JavaScript sin atrapar: Node escribe la pila en
stderr, que aquí es un archivo y se escribe de forma síncrona, y no hay ninguna pila. Tampoco fue un apagado ordenado
(SIGINT): ese camino deja las tareas `cancelled` (ver `inssues/flota-08-apagado-cancela-tareas-en-curso.md`), y estas
quedaron en curso. Quedan una terminación brusca desde fuera (`taskkill /F`, TerminateProcess, cierre de sesión de
Windows) o una caída nativa. Los registros no permiten distinguir entre ellas ni fijar la hora.

Evidencia en el código:

```ts
// src/core/app/cli.ts:24 — el registro de `iniciar` es stderr sin hora
const opts: ComposeOptions = { env: io.env, ...(verbose ? { log: (line: string) => io.err(line) } : {}) };

// src/core/server/app.ts:191 — línea de acceso sin hora
log?.(redactSecrets(`${c.req.method} ${routeForLog(c)} ${c.res.status} ${Math.round(performance.now() - t0)}ms`));

// src/core/app/cli.ts:76-83 — el proceso sale sin escribir nada
if (import.meta.main) {
  process.stdout.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err; });
  const code = await runCli(process.argv.slice(2), nodeIo());
  process.exit(code);
}
```

- `src/core/app/cli-commands.ts:129-133`: `iniciar` espera `waitForStop()` y llama a `core.stop()` sin registrar la señal
  ni lo que había en curso. `waitForStop` (`cli.ts:66-70`) solo escucha SIGINT y SIGTERM.
- En `src` y `apps` no hay ningún `process.on('exit' | 'uncaughtException' | 'unhandledRejection')` (lo busqué con grep).
- `apps/desktop/src/core-supervisor.ts:231` y `:246-252`: «el núcleo terminó solo (código …)» se registra únicamente
  para el hijo que lanzó esa misma ventana (`child.once('exit')`) y solo mientras la ventana está abierta. `adopt()`
  (`:162-176`) se conecta con el pid de la sesión y no lo vigila.
- `apps/desktop/src/core-supervisor.ts:152-159`: cuando `probeCore` devuelve `'down'`, `doConnect` pasa directo a
  `launch()` y no lee `session.json`. Esa sesión solo se borra cuando Berland apaga el núcleo (`:275-278`) o cuando el
  token ya no vale (`:175`). Si al abrir hay una sesión guardada y el puerto está muerto, el núcleo anterior terminó sin
  que Berland lo apagara, y la app lo pasa por alto.

## Por qué pasa

El núcleo no registra su propia salida ni pone hora en sus líneas. La app de escritorio solo vigila al hijo que ella
lanzó, y solo mientras la ventana sigue abierta. Cuando el núcleo queda vivo sin ventana (justo el caso de «trabajo en
curso»), nadie anota su muerte. Al abrir otra vez, nadie compara lo que había (sesión guardada, tareas en curso en la
base) con lo que encuentra (puerto muerto).

Hay además un límite de Windows. La app apaga el núcleo con `taskkill /PID … /T /F` (`core-supervisor.ts:58-59`), que
es TerminateProcess, igual que `child.kill()` o un `taskkill /F` lanzado por un agente. Ante eso no corre ningún
manejador del proceso, ni `'exit'` ni SIGTERM. Por eso un manejador de salida dentro del núcleo solo no basta: la
terminación brusca hay que detectarla desde fuera o en el arranque siguiente.

## Solución posible

1. **Hora en cada línea del núcleo** (`src/core/app/cli.ts:24`): el `log` de `iniciar` antepone la hora ISO,
   `(line) => io.err(`${new Date().toISOString()} ${line}`)`. Así quedan con hora las líneas de acceso (`app.ts:191`), las de
   la flota y las de cupo, y la última línea antes de la muerte da su hora aproximada. Es el cambio más barato y el que
   más ayuda.
2. **Detección en el arranque siguiente, en la app** (`apps/desktop/src/core-supervisor.ts:152-159` y `launch()`): si
   `probe === 'down'` y `readSession()` devuelve una sesión para ese puerto, registrar en `escritorio.log` «el núcleo
   anterior (pid X, lanzado <startedAt>) terminó sin que Berland lo apagara». Escribir esa misma línea en
   `nucleo-escritorio.log` justo después de la cabecera `--- … Berland lanza el núcleo ---` (`:201`). `writeSession`
   después pisa la sesión vieja.
3. **Salida propia del núcleo cuando sí se puede registrar** (`src/core/app/cli.ts:76-83`, solo para `iniciar`):
   - `process.on('exit', (c) => { try { writeSync(2, `${iso} núcleo sale (código ${c}, pid ${process.pid})\n`); } catch {} })`.
     Cubre `process.exit(code)` y el error que `runCli` atrapa (`cli.ts:45-49`).
   - `process.on('uncaughtExceptionMonitor', (err, origin) => writeSync(2, `${iso} núcleo cae (${origin}): ${redactSecrets(err.message)}\n`))`.
     Este evento no cambia el comportamiento por defecto: Node sigue imprimiendo la pila y saliendo, pero ahora la
     caída queda con hora.
   - En `waitForStop` (`cli.ts:66-70`), resolver con el nombre de la señal y escuchar también `SIGHUP` (en Windows es
     el cierre de la consola). `iniciar` (`cli-commands.ts:129-133`) registra «núcleo se detiene por <señal>, N tareas
     en curso».
4. **Contexto en la recuperación** (`src/core/app/fleet-service.ts:252-262`): cuando `recoverOrphans` marca tareas o
   cierra sesiones, agregar a la línea «última actividad del núcleo anterior: <max(events.ts)>» (el `store` ya tiene la
   tabla `events`).

### Otras opciones

La propuesta es una de varias, y se puede hacer en partes. Los puntos 1 y 2 solos ya resolverían el caso real.

- **Latido en `dataDir`:** el núcleo reescribe cada 30-60 s un `core-heartbeat.json` (pid, hora, tareas en curso) y lo
  marca `clean: true` al salir de forma ordenada. Al arrancar, si el archivo existe sin `clean`, registra «el núcleo
  anterior (pid X) terminó sin cerrar; último latido <hora>». No depende de la app ni de `session.json`, así que sirve
  también para un `iniciar` lanzado a mano. El costo es una escritura periódica en disco.
- **Vigilar el pid adoptado:** que `adopt()` compruebe cada pocos segundos con `process.kill(pid, 0)` y registre la hora
  de la muerte. Solo sirve mientras la ventana está abierta, que no fue el caso real.
- **Diagnóstico manual con el Visor de eventos de Windows** (Application Error 1000/1026 para una caída nativa de
  `node.exe`). No requiere código, pero no deja nada en los registros de Berland.
- Un proceso guardián aparte que sobreviva a la ventana daría el código de salida exacto, pero es mucho más pesado que
  un latido.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta 1, en `tests/desktop/core-supervisor.test.ts`: un caso nuevo «con una sesión guardada y
  sin núcleo vivo, registra que el anterior terminó sin apagarse». Arma el cifrador falso con una sesión `{ port, pid:
  5336, startedAt }`, un `fetch` que rechaza `/health` (sondeo `'down'`) y el `spawn` falso que emite la línea ready.
  Afirma que `log` recibió una línea con «pid 5336» y «terminó sin que Berland lo apagara», y que `nucleo-escritorio.log`
  la contiene después de la cabecera. Un segundo caso, sin sesión guardada, afirma que esa línea no aparece.
- Prueba automatizada propuesta 2, en `tests/core/app/cli-registro.test.ts`: con un `CliIo` falso y una composición falsa
  (`MakeComposition`), afirma que las líneas de `log` de `iniciar` empiezan con `/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /`.
  Para el manejador de salida, extraerlo a una función `installExitLog(proc, write, now)` y probarla con un
  `EventEmitter` falso: al emitir `'exit'` con 0 escribe «núcleo sale (código 0…)», y al emitir
  `'uncaughtExceptionMonitor'` escribe «núcleo cae» sin el secreto que traiga el mensaje.
- Comando para correrlas (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/desktop/core-supervisor.test.ts tests/core/app/cli-registro.test.ts"`
  (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/desktop/core-supervisor.test.ts tests/core/app/cli-registro.test.ts`).
- Verificación manual: abrir Berland, lanzar una tarea larga y cerrar la ventana (el núcleo sigue vivo). Matar el núcleo
  con `taskkill /PID <pid> /F` y volver a abrir Berland. `escritorio.log` y `nucleo-escritorio.log` deben decir «el
  núcleo anterior (pid …) terminó sin que Berland lo apagara». Las líneas previas del núcleo deben tener hora, y la
  línea de recuperación debe decir cuál fue la última actividad.
