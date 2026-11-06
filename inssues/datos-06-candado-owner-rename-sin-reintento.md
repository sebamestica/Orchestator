# Al tomar un candado, el archivo `owner` se renombra sin reintentos: un EPERM pasajero del antivirus hace fallar la toma en vez de reintentar

- **Área:** Datos y almacenamiento
- **Severidad:** baja
- **Archivos:** `src/core/locks/manager.ts:417-426`, `src/core/locks/manager.ts:340-352`, `src/core/locks/manager.ts:368-373`, `src/core/plugins/chrome-gate.ts:216-223`, `src/core/plugins/service.ts:389-399`, `src/core/memory/safe-fs.ts:76-80`
- **Estado:** abierta

## Cómo ocurre

Los candados de Berland son carpetas dentro de `C:\dev\agent-hub\locks` (`defaultLocksRoot`, `manager.ts:139-144`). Para tomar uno, `tryAcquire` hace un `mkdir` atómico y luego publica el archivo `owner` en dos pasos: primero escribe un temporal y después lo renombra a `owner`, para que nadie lea un JSON a medias (`manager.ts:417-421`):

```ts
const temp = join(path, `.${OWNER_FILE}-${this.pid}-${randomBytes(4).toString('hex')}.tmp`);
await this.fs.writeFile(temp, content, { flag: 'wx' });
await this.fs.rename(temp, join(path, OWNER_FILE));
} catch (error) {
  await this.fs.rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  throw error;
}
```

En Windows, el antivirus suele abrir un momento el archivo que se acaba de escribir, y si en ese instante se hace `rename` sobre él, falla con EPERM, EACCES o EBUSY. El propio repo lo deja escrito en `safe-fs.ts:76-80` («el antivirus (u Obsidian) abre un instante el archivo recién escrito y `rename` sobre él falla con EPERM») y ya tiene `renameRetrying` para eso (`manager.ts:340-352`, «antivirus, un lector con `owner` abierto»). Pero ese helper solo se usa al liberar (`manager.ts:316`). El `rename` del paso de toma no tiene reintentos.

Pasos:
1. Un agente usa una herramienta del Chrome personal. `ChromeGate.#acquire` llama a `locks.acquire(lock, …, { timeoutMs: 0 })` (`chrome-gate.ts:216`).
2. El `mkdir` funciona y se escribe `.owner-<pid>-<hex>.tmp`. Defender todavía tiene abierto el temporal y `rename(temp, owner)` (`manager.ts:421`) falla con EPERM.
3. El `catch` borra la carpeta y vuelve a lanzar el error del sistema tal cual (`manager.ts:422-425`). No es un `LockError`, así que el bucle de `acquireFirst` no lo reintenta: `await this.tryAcquire(...)` (`manager.ts:371`) propaga la excepción, aunque `timeoutMs` sea mayor que 0.
4. `chrome-gate.ts:220-223` trata cualquier error que no sea `busy` como fallo definitivo y le responde al agente: «No se pudo tomar el candado del Chrome personal (EPERM: …). No abras otro navegador: dilo en tu informe.» La llamada se pierde sin que nadie estuviera usando el navegador. La siguiente llamada vuelve a intentarlo, porque `#acquiring` se limpia en el `finally` (`chrome-gate.ts:199-201`), pero el mensaje anima al agente a rendirse y avisar.
5. Mismo origen, otro síntoma: en «Probar conexión» (`service.ts:389-399`), un EPERM no es `LockError`, así que `busyBy` queda en `'otro proceso'`. Entonces `verifyBrowser` queda en `false` y se informa que el navegador está ocupado cuando no lo estaba.

Las pruebas actuales cubren los errores pasajeros del `mkdir` al tomar (`tests/core/locks/transient.test.ts`) y del `rename` al liberar (`tests/core/locks/release-atomic.test.ts:86-93`). Ninguna cubre el `rename` de `owner` al tomar. Ninguno de los issues 1 a 12 de `docs/plan/issues/` toca `tryAcquire`.

## Por qué pasa

`tryAcquire` llama a `this.fs.rename` directamente (`manager.ts:421`) en lugar de `this.renameRetrying`. El conjunto `TRANSIENT` y el reintento con espera creciente existen (`manager.ts:18-19`, `340-352`), pero no se aplican al paso que publica `owner`. Encima, el `catch` relanza el error crudo, así que quien llama no lo distingue de un fallo real de disco.

## Solución posible

En `src/core/locks/manager.ts`, dentro de `tryAcquire`, cambiar

```ts
await this.fs.rename(temp, join(path, OWNER_FILE));
```

por

```ts
await this.renameRetrying(temp, join(path, OWNER_FILE));
```

Así se reintenta hasta 5 veces con esperas de 20, 40, 60, 80 y 100 ms (unos 300 ms en total). Si el error sigue tras los reintentos, se mantiene el comportamiento actual (borrar la carpeta y lanzar el error del sistema), igual que hace el `mkdir` cuando el error no desaparece (`transient.test.ts:49-53`). Alargar esa ventana es seguro: mientras falta `owner`, quien lea el candado ve `format: 'missing'` (`manager.ts:288`), lo que no cuenta como abandonado para `isAbandonedChromeHolder` (`chrome.ts:227-234`) y en `tryAcquire` de otro proceso da `EEXIST`, o sea «ocupado».

### Otras opciones

- Si se agotan los reintentos con un código pasajero, borrar la carpeta y devolver `undefined` en vez de lanzar. Así `acquireFirst` lo trataría como `busy`/`timeout` y la puerta de Chrome seguiría esperando dentro de su `waitMs`. Tiene una contra: un EPERM persistente de verdad (permisos rotos en `agent-hub\locks`) quedaría escondido como «ocupado por otro dueño».
- Escribir `owner` directamente con `flag: 'wx'`, como hace `src/core/fs/dir-lock.ts:82`, sin temporal ni `rename`. `decodeOwnerFile` ya da `invalid` si lee un JSON a medias y no lanza, así que no haría falta reintentar. A cambio, un lector concurrente podría ver un `owner` inválido durante un instante.
- En `chrome-gate.ts`, tratar como reintentables los errores con código `EPERM`/`EACCES`/`EBUSY` dentro del bucle de `#acquire`. Solo arregla la puerta, no las demás formas de tomar el candado. Lo más limpio es arreglarlo en `LockManager`, y esta propuesta no es la única válida.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta: añadir a `tests/core/locks/transient.test.ts` un caso que cree un `LockManager({ root: tmp.root, fs: { rename } })`. Ese `rename` debe lanzar `fsError('EPERM', 'rename')` las dos primeras veces que el destino sea `join(tmp.root, 'gpu', 'owner')` y después delegar en el `rename` real. Afirmar que `manager.acquire('gpu', c7)` devuelve un handle, que `owner` existe y se decodifica con `agent: 'c7'`, y que `handle.release()` deja la carpeta libre. Hoy `acquire` rechaza con `code: 'EPERM'` y la carpeta queda borrada. Un segundo caso, con fallos sin fin, debe afirmar que se rechaza con `code: 'EPERM', syscall: 'rename'` tras 6 intentos y que la carpeta `gpu` no queda en disco.
- Comando para correrla (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/locks/transient.test.ts"` (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/core/locks/transient.test.ts`).
- Verificación manual en la app: no es práctica, porque depende de que coincida con el escaneo de Defender. Basta con la prueba con `fs` inyectado.
