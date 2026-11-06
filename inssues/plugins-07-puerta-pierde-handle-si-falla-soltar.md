# Si soltar el candado de Chrome falla por un error pasajero de Windows, la puerta pierde el handle y deja el Chrome bloqueado hasta que termina la sesión, también para sí misma

- **Área:** Plugins y navegador
- **Severidad:** baja
- **Archivos:** `src/core/plugins/chrome-gate.ts:254`, `src/core/plugins/chrome-gate.ts:259`, `src/core/plugins/chrome-gate.ts:261`, `src/core/plugins/chrome-gate.ts:264`, `src/core/plugins/chrome-gate.ts:267`, `src/core/plugins/chrome-gate.ts:198`, `src/core/plugins/chrome-gate.ts:216`, `src/core/plugins/chrome-gate.ts:225`, `src/core/plugins/chrome-gate.ts:227`, `src/core/plugins/chrome-gate.ts:237`, `src/core/plugins/chrome.ts:227`, `src/core/plugins/chrome.ts:233`, `src/core/locks/manager.ts:316`, `src/core/locks/manager.ts:341`, `src/core/locks/manager.ts:348`, `src/core/locks/manager.ts:349`, `src/core/locks/manager.ts:426`
- **Estado:** resuelta

## Cómo ocurre

Contexto. Cada agente que usa `chrome-personal` pasa por la puerta `src/core/plugins/chrome-gate.ts`. La puerta toma
el candado `C:\dev\agent-hub\locks\chrome-personal` en la primera `tools/call` y guarda el `LockHandle` en `#held`.
Lo suelta cuando lleva `--idle-ms` sin llamadas (3 min, `chrome.ts:40`), al cerrarse o con una señal. El handle es
lo único que tiene el token de la adquisición. En el archivo `owner` solo queda su SHA-256 (`manager.ts:426`:
`release: () => this.release(lock, token)`).

Soltar el candado es un `rename` de la carpeta a `chrome-personal.releasing.<pid>.<hex>` seguido de un borrado
(`manager.ts:316`). En Windows no se puede renombrar una carpeta mientras otro proceso tiene abierto un archivo de
adentro: falla con `EPERM`, `EACCES` o `EBUSY`. El propio código lo reconoce (`manager.ts:340`: «antivirus, un lector
con `owner` abierto»). Pero los reintentos son cortos: 6 intentos con pausas de 20, 40, 60, 80 y 100 ms, unos 300 ms
en total.

```ts
// manager.ts:19, 348-349
const TRANSIENT_RETRIES = 5;
...
if (!code || !TRANSIENT.has(code) || attempt >= TRANSIENT_RETRIES) throw error;
await sleep(20 * (attempt + 1));
```

Hay varios procesos que leen `owner` mientras otro tiene el candado:
- Defender, que con la CPU al límite puede tardar más de 300 ms en soltar el archivo.
- Las demás puertas que esperan. Cada una, tras cada intento fallido (más o menos cada segundo), lee el dueño con
  `this.read(...)` (`manager.ts:380`).
- `chromeLive()` (`service.ts:194`), que la vista de plugins pide cada 15 s (`PluginsView.tsx:13`, `LIVE_REFRESH_MS`).

Pasos:

1. La puerta A (agente `claude-main`, tarea `t-1`) tiene el candado y queda ociosa. El temporizador llama a
   `#release('inactividad')` (`chrome-gate.ts:254`).
2. `#release` borra `#held` antes de intentar nada y llama a `held.release()`:

   ```ts
   // chrome-gate.ts:259-268
   async #release(why: string): Promise<void> {
     const held = this.#held;
     this.#held = undefined;            // 261: el handle se descarta antes de saber si se soltó
     if (!held) return;
     try {
       await held.release();            // 264
       ...
     } catch (err) {
       if (!(err instanceof LockError && err.code === 'not_held')) this.#deps.log?.(`no se pudo soltar ...`); // 267: solo se registra
     }
   }
   ```

3. Defender u otro lector tiene `owner` abierto durante los ~300 ms de reintentos. El `rename` falla con `EPERM`.
   `releaseWhen` lo relanza tal cual porque no es `ENOENT` (`manager.ts:317-320`). La carpeta `chrome-personal` queda
   en su sitio con el pid de A, que sigue vivo. Sin el handle, ya nadie tiene el token.
4. No vuelve a armarse ningún temporizador, porque `#armIdle` sale si `!this.#held` (`chrome-gate.ts:252`).
5. El agente de A manda otra `tools/call`. `#ensure` ve `#held` vacío (`chrome-gate.ts:198`) y entra en `#acquire`.
   `acquire` responde `busy` y el dueño es A misma (`chrome-gate.ts:216`, `225`). `isAbandonedChromeHolder` exige que
   el pid esté muerto (`chrome.ts:233`: `!(opts.alive ?? pidAlive)(holder.pid)`), así que no lo libera
   (`chrome-gate.ts:227`). A espera `--wait-ms` (5 min) y le contesta a su propio agente
   `busyText(...)` (`chrome-gate.ts:237`): «El Chrome personal lo está usando claude-main (tarea t-1)… No abras otro
   navegador». Lo mismo pasa con cada llamada siguiente.
6. Las puertas de los demás agentes ven el mismo dueño vivo y tampoco pueden liberarlo. Todos quedan sin Chrome hasta
   que el proceso de la puerta A termina. Recién entonces el pid está muerto y `isAbandonedChromeHolder` (o el
   `release` del grant, `service.ts:293`) limpia la carpeta.

Ninguna prueba cubre una liberación que falla. `tests/core/plugins/chrome-gate.test.ts` solo prueba soltar sin
errores, el dueño muerto y `close()`. Ningún issue de `docs/plan/issues` toca este caso: el 11 (`11-chrome-personal.md`)
solo agrega `releaseAbandoned` para pids muertos.

Si la liberación que falla es la de `close()` (`chrome-gate.ts:174`), el daño dura poco: el proceso sale enseguida y el
candado pasa a contar como abandonado. Lo que queda colgado es la liberación por inactividad, con la sesión todavía viva.

## Por qué pasa

En `#release` (`chrome-gate.ts:259-268`), la puerta descarta el `LockHandle` sin saber si se soltó y no reintenta. Si
`held.release()` falla por algo que no es `not_held`, el candado sigue siendo de la puerta, pero ella ya no tiene el
token para soltarlo. Además, `#acquire` (`chrome-gate.ts:206-246`) no se da cuenta de que el dueño es ella misma: lo
trata como ajeno y vivo. Las únicas salidas son `releaseAbandoned`, que pide un pid muerto, o el token.

## Solución posible

En `src/core/plugins/chrome-gate.ts`, `#release`:

- Si `held.release()` termina bien o lanza `LockError` `not_held`, dar el candado por soltado, como ahora.
- Con cualquier otro error, la puerta sigue siendo dueña:
  - en una liberación por `inactividad`, devolver el handle a `#held` si sigue vacío (`this.#held ??= held`) y programar
    otro intento con espera creciente (por ejemplo 0,5 s, 1 s, 2 s… hasta unos 30 s, con `unref()`). Si mientras tanto
    llega una `tools/call`, `#ensure` ve `#held` y deja pasar la llamada sin bloquearse, y el temporizador de ocio
    vuelve a armarse;
  - en `close()` (`cierre`), hacer unos pocos intentos más con pausa antes de salir, con un tope corto para que no
    retrase el cierre. Si igual falla, el candado queda como abandonado cuando muera el proceso.
- Que el registro diga que se va a reintentar, para que se vea en el stderr de la puerta.

No hace falta tocar `LockManager`.

### Otras opciones

- **Que `#acquire` reconozca su propio candado:** si `busy` trae un dueño con `pid === process.pid`, este host, el
  mismo agente y tarea y la nota de la puerta, es un candado propio sin token. Se puede liberar con
  `releaseAbandoned(lock, h => <esa misma condición>)` y volver a tomarlo. Arregla también cualquier otra forma de
  perder el handle, pero usa `releaseAbandoned` para algo que no es un abandono y dejaría en manos del pid la decisión
  de quitar un candado.
- **Más reintentos en `renameRetrying`** (`manager.ts:341`), por ejemplo hasta 2-3 s solo al liberar. Es el cambio más
  chico y ayuda a todos los usuarios de `LockManager`. Pero solo achica la ventana: si el bloqueo dura más, se repite
  lo mismo. Además, un `release()` lento retrasa el cierre de la puerta.
- Juntar la primera opción con un poco más de reintentos podría ser lo más sólido. La propuesta de arriba no es la
  única y se puede ajustar.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta** en `tests/core/plugins/chrome-gate.test.ts`:
  - Armar un `ChromeGate` con `deps.locks = new LockManager({ root, fs: { rename } })`, donde `rename` es un envoltorio
    de `node:fs/promises` que falla con un error `EPERM` (`Object.assign(new Error('EPERM'), { code: 'EPERM' })`) las
    primeras 6 veces que `to` contiene `.releasing.`. Los demás `rename` (el de `owner` al tomar) pasan siempre. Usar
    `idleMs: 50`, `waitMs: 300`, `retryMs: 20`.
  - Escenario 1: `call(1)`, `reply(1)` y esperar el log `no se pudo soltar`.
    - Hoy: la carpeta `chrome-personal` sigue ahí, `g.holding` es `false` y un `call(2)` termina con `isError: true`
      y el texto de `busyText` con `claude-main`, sin reenviarse al servidor.
    - Con el arreglo: `call(2)` llega al servidor (`forwarded()` incluye `id: 2`), o bien, sin nuevas llamadas, la
      carpeta desaparece sola tras el reintento (`until(() => !exists(...))`) y el log dice `soltado`.
  - Escenario 2: una segunda puerta (`agent: 'codex-main'`) que espera el candado entra cuando la primera lo suelta en
    el reintento.
- **Comando** (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/plugins/chrome-gate.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/plugins/chrome-gate.test.ts`).
- **Verificación manual:** difícil de forzar a mano. Un modo es abrir `C:\dev\agent-hub\locks\chrome-personal\owner`
  con un proceso que lo mantenga abierto (por ejemplo, un PowerShell con
  `[IO.File]::Open(...,'Open','Read','ReadWrite')`) justo cuando vence el tiempo de ocio. Al cerrarlo, la puerta debe
  soltar el candado en el siguiente reintento, y la vista de plugins debe pasar a «Libre ahora» sin cerrar la sesión
  del agente.
