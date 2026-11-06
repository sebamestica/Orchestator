# Cada lectura del cupo de Codex congela el núcleo mientras corre `taskkill` síncrono

- **Área:** Adaptadores de agentes (app-server de Codex y cupo de Codex)
- **Severidad:** baja
- **Archivos:** `src/core/adapters/codex-cli/app-server.ts:24-36`, `src/core/adapters/codex-cli/app-server.ts:41`, `src/core/quota/codex.ts:90`, `src/core/main.ts:109-118`, `src/core/orchestrator/router.ts:345-358`, `src/core/quota/monitor.ts:46`, `src/core/quota/monitor.ts:68`, `src/core/process/run-jsonl.ts:39-48`, `tests/core/adapters/codex-cli/app-server.test.ts:6-10`
- **Estado:** resuelta

## Cómo ocurre

El núcleo de Berland corre en un solo proceso Node de Windows. Ese proceso atiende el servidor Hono de `127.0.0.1:47811`, el `/ws`, los eventos de todos los agentes de la flota y los temporizadores. `startCore` monta el servidor y, en el mismo proceso, un `setInterval` que relee todos los cupos cada `config.quotaRefreshMs`, que por defecto vale 5 min (`src/core/main.ts:109-118`, `DEFAULT_QUOTA_REFRESH_MS = 5 * 60_000` en `src/core/config/config.ts:10`).

Para un agente `codex-cli`, el lector de cupo es `CodexQuotaProvider` (`src/core/app/quotas.ts:35-36`). Lo primero que hace es lanzar `codex app-server` (`src/core/quota/codex.ts:90`):

```ts
const response = serverSchema.parse(await (this.options.readAppServer ?? readCodexAppServer)());
```

Este camino se recorre:

1. cada 5 min desde el `setInterval` de `startCore`, mediante `QuotaRefresher.refresh()` (`src/core/registry/quotas.ts:65`);
2. al pedir una lectura desde el servidor (`src/core/server/app.ts:381`, `quotas.refresh(body.agentId)`);
3. desde el router, cada vez que vence su caché de 5 min (`src/core/orchestrator/router.ts:345-358`, `DEFAULT_QUOTA_CACHE_MS`);
4. desde el `QuotaMonitor` de la mente: al arrancar, cada 5 min y al terminar una tarea (`src/core/app/conductor.ts:149-150`, `src/core/quota/monitor.ts:46`, `src/core/quota/monitor.ts:85`).

Toda salida de `readCodexAppServer` pasa por `finish()`, sea éxito (respuesta `id: 1`), error RPC, JSON inválido, timeout o cierre. En Windows, `finish()` mata el árbol con una llamada **síncrona** (`src/core/adapters/codex-cli/app-server.ts:30-34`):

```ts
if (process.platform === 'win32' && child.pid) {
  // El lanzador npm tiene un hijo nativo; terminar todo el árbol.
  spawnSync(systemExe('taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000, stdio: 'ignore' });
}
child.kill();
```

`spawnSync` no le devuelve el control al bucle de eventos hasta que `taskkill.exe` termine o se cumplan los 3000 ms del `timeout`. Mientras tanto el núcleo entero queda detenido. No responde HTTP, el `/ws` no emite nada, no se procesa la salida JSONL de ningún agente en curso y no corre ningún temporizador. El tiempo depende de cuánto tarde Windows en crear el proceso `taskkill`, tomar la foto de procesos para `/T` y terminar el árbol. En un PC con Defender analizando cada proceso nuevo, que es la situación actual, puede ser apreciable, con un tope de 3 s por lectura.

En el camino `close` (`src/core/adapters/codex-cli/app-server.ts:41`), `finish()` lanza igual el `taskkill` síncrono. El hijo directo ya salió, así que `taskkill /T` no tiene árbol que recorrer y el bloqueo no sirve de nada. A diferencia de los otros `killTree` del repo (`src/core/plugins/mcp-probe.ts:78`, `src/core/plugins/chrome-gate.ts:274`), aquí no se mira `child.exitCode`/`child.signalCode` antes de lanzar `taskkill`.

Ninguna prueba cubre la rama de Windows. La prueba existente simula `spawnSync` con `vi.fn()`, y el hijo falso no tiene `pid` (`tests/core/adapters/codex-cli/app-server.test.ts:6-10`), así que la rama `win32 && child.pid` nunca se ejecuta en los tests. Ninguno de los issues 1 a 13 de `docs/plan/issues` toca este archivo. Su último cambio es el commit `2bb24de` (variables de entorno de los hijos).

## Por qué pasa

Para matar el árbol del app-server se usa una llamada que bloquea, dentro del mismo proceso que atiende a toda la flota. `runJsonl` resuelve lo mismo con `spawn` asíncrono (`src/core/process/run-jsonl.ts:39-48`), y además sale enseguida si el hijo ya terminó (`if (child.exitCode !== null) return;`). `readCodexAppServer` no reutiliza esa lógica.

## Solución posible

En `src/core/adapters/codex-cli/app-server.ts`, cambiar el cierre del hijo dentro de `finish()`:

1. Resolver o rechazar la promesa primero. El resultado ya está leído y no depende de que el hijo muera.
2. Si `child.exitCode !== null || child.signalCode !== null`, no lanzar `taskkill` (camino `close`).
3. En Windows con `child.pid`, lanzar `taskkill` con `spawn` asíncrono y **esperar a que termine antes de llamar a `child.kill()`**:

   ```ts
   const killer = spawn(systemExe('taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
   const fallback = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
   killer.once('error', fallback);
   killer.once('exit', fallback);
   killer.unref();
   ```

   El orden importa. Si `child.kill()` corre justo después del `spawn` asíncrono, el `node codex.js` padre muere antes de que `taskkill /T` recorra el árbol. Entonces `taskkill` no encuentra el PID y el `codex.exe` nativo, que el lanzador crea con `spawn(binaryPath, …, { stdio: "inherit" })`, queda huérfano. Hoy ese orden lo garantiza el bloqueo de `spawnSync`.
4. El manejador de `'error'` es obligatorio. Un `ChildProcess` sin oyente de `'error'` lanza la excepción y puede tumbar el núcleo. `runJsonl` (`src/core/process/run-jsonl.ts:44`) descarta el valor de `spawn` sin oyente, así que conviene no copiarlo tal cual.

Lo ideal es sacar una función compartida `killTreeAsync(child)` a `src/core/process/`, para que la usen `app-server.ts`, `run-jsonl.ts` y `mcp-probe.ts`.

### Otras opciones

- **App-server persistente:** mantener vivo un único `codex app-server` y mandarle `account/rateLimits/read` en cada consulta, en vez de lanzarlo y matarlo cada vez. Así se evitan el arranque de Node y de `codex.exe` cada 5 min (otro costo con Defender) y el `taskkill`. A cambio, hay que vigilar caídas y cerrarlo al apagar el núcleo.
- **Leer menos veces:** compartir una sola lectura entre `QuotaRefresher`, router y `QuotaMonitor`. Hoy cada uno tiene su propia caché o intervalo y pueden lanzar app-servers por separado en la misma ventana de 5 min. Otra opción es tomar los rollouts locales (`readLatestCodexRollout`) cuando la última lectura del app-server sea reciente.
- **Mismo patrón en plugins:** `src/core/plugins/mcp-probe.ts:80` también usa `spawnSync(taskkill)`, con 5 s de tope, en el «Probar conexión» que corre dentro del núcleo (`src/core/plugins/service.ts:402`). La función compartida lo arreglaría a la vez, aunque no es parte de esta área.

La propuesta no es la única. Si se elige el app-server persistente, el `taskkill` por lectura desaparece, y también el costo de crear procesos, que puede pesar más que el propio `taskkill`.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:** ampliar `tests/core/adapters/codex-cli/app-server.test.ts`.
  - Simular `process.platform = 'win32'` con `vi.stubGlobal`/`Object.defineProperty` y darle al hijo falso `pid: 1234`, `exitCode: null` y `signalCode: null`.
  - Escenario de éxito: responder `id: 0` e `id: 1`. Afirmar que la promesa se resuelve, que `spawnSync` **no** se llamó y que `spawn` se llamó una segunda vez con `taskkill.exe` y `['/pid', '1234', '/T', '/F']`. Afirmar también que `child.kill` no se llama antes de que el `taskkill` falso emita `'exit'`.
  - Escenario `close`: poner `exitCode = 1` y emitir `'close'`. Afirmar que la promesa se rechaza con «sin respuesta» y que no se lanzó ningún `taskkill` (ni `spawn` ni `spawnSync`).
  - Escenario de fallo de `taskkill`: el `taskkill` falso emite `'error'`. Afirmar que no hay excepción sin capturar y que se llama a `child.kill()` como respaldo.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/adapters/codex-cli/app-server.test.ts"` (o, desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/adapters/codex-cli/app-server.test.ts`).
- **Verificación manual en Windows:** en un script del núcleo, crear `const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();` (de `node:perf_hooks`), llamar a `await new CodexQuotaProvider('codex').read()` y mirar `h.max / 1e6`. Hoy el máximo sube al tiempo de `taskkill`. Tras el cambio debe quedar en pocos ms. Después, en el Administrador de tareas, comprobar que no queda ningún `codex.exe app-server` huérfano después de varias lecturas.
