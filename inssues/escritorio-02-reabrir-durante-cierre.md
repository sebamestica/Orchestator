# Reabrir Berland mientras la anterior se cierra: la ventana vuelve y desaparece sola, o la nueva adopta un núcleo que se está matando

- **Área:** Escritorio y arranque (`apps/desktop`)
- **Severidad:** media
- **Archivos:** `apps/desktop/src/main.ts:169`, `apps/desktop/src/main.ts:179`, `apps/desktop/src/main.ts:182`, `apps/desktop/src/main.ts:184`, `apps/desktop/src/main.ts:193`, `apps/desktop/src/main.ts:197`, `apps/desktop/src/core-supervisor.ts:258`, `apps/desktop/src/core-supervisor.ts:272`, `apps/desktop/src/core-supervisor.ts:275`, `apps/desktop/src/core-supervisor.ts:59`, `apps/desktop/src/core-supervisor.ts:166`, `apps/desktop/src/core-supervisor.ts:231`, `apps/desktop/src/lib/core-client.ts:55`
- **Estado:** abierta

## Cómo ocurre

Berland usa el candado de instancia única de Electron. Si se abre una segunda vez, el proceso nuevo no consigue el
candado y sale (`main.ts:274-277`), y el proceso viejo recibe `'second-instance'`.

Al cerrar la ventana no se cierra nada de inmediato. La ventana se oculta y empieza el apagado
(`main.ts:197-203`):

```ts
// apps/desktop/src/main.ts:197-202
win.on('close', (e) => {
  saveState();
  if (quitting) return;
  e.preventDefault();
  win.hide();
  shutdown();
```

`shutdown()` corre `CoreSupervisor.onAppClose()` contra un plazo de 8 s y recién después suelta el candado
(`main.ts:179-194`):

```ts
// apps/desktop/src/main.ts:182-194
const d = await Promise.race([
  supervisor.onAppClose(),
  delay(CLOSE_TIMEOUT_MS).then(() => ({ stop: false, reason: 'el cierre tardó demasiado: el núcleo sigue vivo' })),
]);
…
quitting = true;
app.releaseSingleInstanceLock();
app.quit();
```

`onAppClose()` hace lo siguiente, en serie (`core-supervisor.ts:258-282`):

1. Si el núcleo seguía conectando, lo espera hasta 3 s (línea 260).
2. Llama a `runningTasks`, que pide `GET /tasks` y después `GET /chats`. Cada pedido tiene su propio plazo de 3 s,
   así que entre los dos pueden ser hasta 6 s (`core-client.ts:55-62`).
3. Si toca apagar, corre `killTree(pid)`, que en Windows es `taskkill /T /F` con un plazo de 10 s
   (`core-supervisor.ts:59`). Después borra la sesión (líneas 275-279).

Con la CPU cargada (Defender, la flota trabajando), estos pasos tardan segundos. El commit 8b79157 ya midió ese
escenario: el desmontaje de Electron llegó a tardar 48 s, y por eso el candado se suelta antes de `app.quit()`. Pero
el candado se sigue reteniendo durante todo `onAppClose`, y eso deja dos casos.

**Caso A: la ventana vuelve y desaparece.** El manejador de `'second-instance'` no tiene en cuenta que la app se está
apagando:

```ts
// apps/desktop/src/main.ts:169-174
app.on('second-instance', () => {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});
```

Pasos:

1. Con Berland abierta, cerrar la ventana. Se oculta y empieza `onAppClose`.
2. Antes de que termine (normalmente menos de 1 s; con la CPU cargada, entre unos segundos y 8 s), hacer doble clic
   en `Berland.lnk`.
3. El proceso nuevo no consigue el candado y sale. El viejo recibe `'second-instance'` y muestra otra vez la ventana
   oculta (`win` sigue vivo porque el `close` se canceló con `preventDefault`).
4. Termina `onAppClose`. `shutdown` pone `quitting = true` y llama a `app.quit()`. El `close` ya no se cancela
   (`main.ts:199`) y la ventana se cierra delante del usuario. No queda ningún proceso que abra una ventana nueva, así
   que hay que volver a hacer doble clic.

Mientras tanto, si la decisión fue apagar, el usuario está viendo una interfaz cuyo núcleo está a punto de morir o ya
murió. Lo que haga en ese rato (escribirle a la mente, lanzar una tarea) se corta. El chequeo de tareas
(`core-supervisor.ts:272`) ya se hizo antes, así que no lo ve.

**Caso B: la nueva adopta un núcleo que la vieja está matando.** El plazo de 8 s gana la carrera pero no cancela
`onAppClose`, que sigue en segundo plano:

1. `GET /tasks` y `GET /chats` responden lento pero bien (por ejemplo, 2 a 3 s cada uno), sin trabajo en curso.
   `decideOnClose` devuelve `stop: true` y empieza `killTree` (línea 277).
2. `taskkill` sigue corriendo cuando se cumplen los 8 s. El registro dice «el cierre tardó demasiado: el núcleo sigue
   vivo» (`main.ts:184`), cosa que puede ser falsa. Se suelta el candado (línea 193) y se llama a `app.quit()`.
3. Una Berland abierta en ese momento consigue el candado. `GET /health` ve el núcleo todavía vivo, y la sesión
   cifrada no se borró (eso pasa después de `killTree`, en la línea 278), así que lo adopta con
   `ownership: 'adopted'` (`core-supervisor.ts:162-169`).
4. `taskkill` termina y el núcleo muere. Como fue adoptado, nadie escucha su `exit`: el oyente solo se registra en
   `launch` (`core-supervisor.ts:231`), así que `onUnexpectedExit` no avisa y no aparece la página «El núcleo se
   detuvo» (`main.ts:227-229`). La interfaz se queda en «Reconectando…» (`src/ui/app/Sidebar.tsx:13`) para siempre.
   Para salir de ahí hay que cerrar esa ventana (al cerrar, `runningTasks` falla, el núcleo «sigue vivo» y no pasa
   nada más) y abrir otra vez.

El caso B necesita más coincidencias que el A (un núcleo que responde lento, un `taskkill` lento y una reapertura
justo en ese intervalo), pero las dos causas comparten el mismo origen. No hay prueba de `main.ts` (importa
`electron`). En `tests/desktop/core-supervisor.test.ts` no hay ningún caso con `onAppClose` lento ni con plazo.

## Por qué pasa

- `'second-instance'` (`main.ts:169`) no consulta `shuttingDown` ni `quitting`. Durante el apagado trata la
  reapertura como «traer al frente» una ventana que está por cerrarse, y la petición de abrir Berland se pierde.
- `Promise.race` (`main.ts:182-185`) solo deja de esperar a `onAppClose`. No lo cancela. Si `killTree` ya empezó, el
  candado se suelta y la sesión sigue en disco mientras el núcleo todavía se está matando. Además, el mensaje del
  registro afirma algo que el código no sabe.
- `onAppClose` (`core-supervisor.ts:258`) no recibe ningún plazo ni `AbortSignal`. No puede decidir «ya no mato
  porque se acabó el tiempo», ni avisar de que la muerte está en curso.

## Solución posible

1. **`apps/desktop/src/main.ts`, reapertura durante el cierre.** Guardar `let reopenRequested = false`. En
   `'second-instance'`, si `shuttingDown !== null`, poner `reopenRequested = true` y salir sin mostrar la ventana.
   En `shutdown`, justo después de `app.releaseSingleInstanceLock()`, si `reopenRequested`, lanzar una instancia
   nueva enseguida: `spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore', cwd: process.cwd() }).unref()`.
   Recién después llamar a `app.quit()`. La instancia nueva encuentra el candado libre y hace su `connect()`
   habitual: si el núcleo se apagó, lanza otro, y si siguió vivo, lo adopta.
   `app.relaunch()` es más simple, pero Electron relanza cuando el proceso actual *termina*. Según `main.ts:191`,
   eso puede tardar decenas de segundos con la CPU cargada, y entonces se perdería lo que buscó el commit 8b79157.
2. **`apps/desktop/src/core-supervisor.ts`, plazo dentro de `onAppClose`.** Cambiar la firma a
   `onAppClose(signal?: AbortSignal)`:
   - Pasar la señal a `runningTasks`: el `get` de `core-client.ts:55` usaría
     `AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])`. También hay que cortar con ella la espera de
     `this.connecting` (línea 260).
   - Justo antes de `this.stopping = true; await this.killTree(...)` (líneas 265 y 276), si `signal.aborted`,
     devolver `{ stop: false, reason: 'el cierre tardó demasiado: el núcleo sigue vivo' }` sin matar. Así el
     registro dice la verdad.
   - Si `killTree` ya empezó, esperarlo. Tiene su propio tope de 10 s (`core-supervisor.ts:59`) y después borra
     la sesión.
3. **`main.ts`, sin la carrera.** Reemplazar el `Promise.race` por un `AbortController` que aborte a los
   `CLOSE_TIMEOUT_MS` y `await supervisor.onAppClose(controller.signal)`. El candado se suelta cuando el núcleo ya
   tiene un estado definido: vivo con su sesión, o muerto y sin sesión.

### Otras opciones

- **Cancelar el cierre si todavía no se mató nada.** Si la reapertura llega antes de `killTree`, abortar el apagado,
  dejar el núcleo vivo y volver a mostrar la misma ventana (`quitting` sigue en `false` y `shuttingDown` vuelve a
  `null`). Es la experiencia más rápida, porque no se lanza ningún proceso nuevo, pero hay que poder cancelar
  `onAppClose` a mitad de camino. Si la reapertura llega con `killTree` ya en curso, se usa el relanzamiento del paso 1.
- **Página de estado en vez de ocultar.** Si llega `'second-instance'` durante el apagado, mostrar la ventana con
  `statusPageUrl({ title: 'Cerrando Berland…', busy: true })` y, al terminar, relanzar como en el paso 1. El
  usuario ve qué está pasando en lugar de no ver nada.
- **Solo el caso B.** Si se prefiere no tocar la reapertura, alcanza con el paso 2. Aunque el caso A es el más
  frecuente y no se resolvería.

Puede haber una solución más económica que combine la cancelación con el relanzamiento. Las propuestas de arriba no
son las únicas posibles.

## Cómo probar que quedó resuelta

- **Prueba automatizada (supervisor):** en `tests/desktop/core-supervisor.test.ts`, con el `fakeSpawn` y el
  `fakeFetch` que ya existen:
  1. Un `fetch` que tarda unos 300 ms en responder `/tasks` y `/chats` (sin tareas), un `killTree` que registra cuándo
     empieza y tarda unos 500 ms, y una señal abortada a los 100 ms. Afirmar que `onAppClose(signal)` devuelve
     `stop: false`, que `killed` queda vacío y que `config.sessionPath` sigue existiendo.
  2. El mismo `fetch`, con la señal abortada a los 700 ms, cuando `killTree` ya empezó. Afirmar que `onAppClose`
     resuelve después de que `killTree` terminó, que devuelve `stop: true` y que la sesión se borró.
- **Prueba automatizada (reapertura):** extraer la decisión de `'second-instance'` a una función pura, por ejemplo
  `apps/desktop/src/lib/second-instance.ts` con `onSecondInstance({ shuttingDown }): 'show' | 'reopen-after-close'`,
  y probarla en `tests/desktop/second-instance.test.ts`: en apagado devuelve `reopen-after-close`, y si no, `show`.
- **Comando (desde WSL):**
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/desktop/core-supervisor.test.ts tests/desktop/second-instance.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`:
  `npx vitest run tests/desktop/core-supervisor.test.ts tests/desktop/second-instance.test.ts`).
- **Verificación manual:** con Berland abierta y sin tareas en curso, cerrar la ventana y hacer doble clic en
  `Berland.lnk` enseguida (mejor con la CPU ocupada, para que el cierre tarde). Antes del arreglo, la ventana vuelve y
  se cierra sola. Después, se cierra y a los pocos segundos se abre una ventana nueva conectada a un núcleo vivo. En
  `escritorio.log` (carpeta de registros de Berland) debe aparecer `ventana cerrada: …` seguido de la línea de
  arranque `Berland … · núcleo …` del proceso nuevo, y nunca «el núcleo sigue vivo» en un cierre que sí lo mató.
