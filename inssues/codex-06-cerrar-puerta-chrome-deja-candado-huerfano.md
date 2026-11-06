# Si la puerta de Chrome se cierra mientras toma el candado, el candado puede quedar tomado sin dueño y bloquear el Chrome para todos

- **Área:** Seguridad y corrección (revisión de Codex)
- **Severidad:** baja
- **Archivos:** `src/core/plugins/chrome-gate.ts:169-175`, `src/core/plugins/chrome-gate.ts:184`, `src/core/plugins/chrome-gate.ts:199`, `src/core/plugins/chrome-gate.ts:216`, `src/core/plugins/chrome-gate.ts:252`, `src/core/plugins/chrome-gate.ts:304-310`, `src/core/plugins/chrome-gate.ts:314-323`, `src/core/locks/manager.ts:403`, `src/core/locks/manager.ts:407`, `src/core/locks/manager.ts:420-421`, `src/core/locks/manager.ts:289`, `src/core/plugins/chrome.ts:227-234`, `src/core/plugins/service.ts:200-202`
- **Estado:** abierta

## Cómo ocurre

Contexto. Todos los agentes usan `chrome-personal` a través de la puerta `src/core/plugins/chrome-gate.ts`. En la
primera `tools/call`, `#call` espera a `#ensure()`, que deja la toma en curso en `#acquiring` (`chrome-gate.ts:199`).
Cada intento de `#acquire` llama a `LockManager.acquire` con `timeoutMs: 0` y guarda el resultado directo en `#held`:

```ts
// chrome-gate.ts:216
this.#held = await this.#locks.acquire(this.#opts.lock, { … }, { timeoutMs: 0 });
```

Ese intento son varias operaciones de disco encadenadas. Primero un `mkdir` de la carpeta del candado, que es la toma
atómica (`manager.ts:403`). Después se escribe un temporal y se renombra a `owner` (`manager.ts:420-421`). Ninguna
recibe la señal de cierre.

`close()` no espera esa toma. Solo suelta lo que ya esté en `#held`:

```ts
// chrome-gate.ts:169-175
async close(): Promise<void> {
  if (this.#closed) return;
  this.#closed = true;
  this.#stop.abort();
  if (this.#idle) clearTimeout(this.#idle);
  await this.#release('cierre');   // #held todavía es undefined → no hace nada
}
```

Pasos:

1. Un agente hace su primera `tools/call` con el candado libre, o ya estaba esperando y el candado se libera justo en
   ese momento. La puerta empieza `acquire` (línea 216).
2. Mientras esas operaciones de disco siguen en curso, algo cierra la puerta: el temporizador de 3 s tras cerrarse
   stdin, la salida del servidor o una señal (`chrome-gate.ts:314-323`).
3. `close()` encuentra `#held` vacío y termina enseguida.

Qué pasa después depende de dónde corra la puerta:

- **En el proceso real (`main`)**, `finish` hace `await gate.close()`, luego `killTree(child)` y `process.exit`
  (`chrome-gate.ts:304-310`). Entre `close()` y la salida solo corren microtareas, así que la continuación JS de
  `acquire` nunca llega a correr. La operación de disco que ya estaba en el thread pool sí termina, porque `killTree`
  bloquea con `spawnSync`. Si era el `mkdir` (`manager.ts:403`) o la escritura del temporal (`manager.ts:420`), la
  carpeta `C:\dev\agent-hub\locks\chrome-personal` queda creada **sin archivo `owner`**:
  - las demás puertas reciben `EEXIST`, es decir, ocupado (`manager.ts:407`);
  - el dueño se lee como `{ format: 'missing' }` (`manager.ts:289`);
  - `isAbandonedChromeHolder` exige `holder.format === 'json'` (`chrome.ts:229`), así que la recuperación automática
    no lo libera nunca.

  Resultado: cada agente espera 5 min y recibe «lo está usando dueño desconocido (sin archivo owner)». Ajustes muestra
  «En uso ahora por dueño desconocido» (`service.ts:202`). Esto dura hasta que alguien borra la carpeta a mano. Si en
  cambio la operación en curso era el último `rename` de `owner`, queda un `owner` JSON con el pid de una puerta
  muerta, y la siguiente puerta sí lo recupera (`chrome-gate.ts:227-234`).
- **En la clase usada en proceso (pruebas)**, `acquire` termina después del cierre y asigna `#held`. `#call` ve
  `#closed` y llama a `#armIdle()` (`chrome-gate.ts:184-185`). Pero `#armIdle` retorna sin hacer nada porque la puerta
  está cerrada (`chrome-gate.ts:252`), y nadie suelta ese handle. Este caso no ocurre en producción, porque solo
  `main` usa `ChromeGate` y sale justo después de `close()`.

La ventana es corta: dura lo que tardan dos o tres operaciones de disco, más con Defender. Por eso la severidad es
baja. Cuando ocurre, el Chrome queda bloqueado para todos los agentes sin que nada lo recupere. La prueba existente
`close() suelta el candado` (`tests/core/plugins/chrome-gate.test.ts:196`) espera a que la llamada llegue al servidor
antes de cerrar, así que no cubre una toma en curso.

## Por qué pasa

- `close()` no coordina con la toma en curso (`#acquiring`): suelta solo lo que ya está en `#held`.
- `#acquire` asigna el handle a `#held` sin volver a mirar `#closed` después del `await` (línea 216).
- Si la toma queda a medias (carpeta sin `owner`), la recuperación no la considera abandonada, porque solo acepta
  dueños JSON con pid (`chrome.ts:229`, `manager.ts:213`).

## Solución posible

En `src/core/plugins/chrome-gate.ts`:

1. `close()` espera la toma en curso antes de soltar:
   ```ts
   this.#closed = true;
   this.#stop.abort();
   if (this.#idle) clearTimeout(this.#idle);
   await this.#acquiring?.catch(() => undefined);
   await this.#release('cierre');
   ```
   La toma es un solo intento (`timeoutMs: 0`) y la espera entre intentos ya se corta con `#stop`
   (`chrome-gate.ts:243-245`), así que el cierre solo espera unos milisegundos. `finish` (`chrome-gate.ts:307`) ya hace
   `await gate.close()` antes de `process.exit`, así que el proceso no sale con la toma a medias.
2. En `#acquire`, guardar el handle en una variable local y volver a mirar `#closed`:
   ```ts
   const handle = await this.#locks.acquire(…);
   if (this.#closed) {
     await handle.release().catch(() => undefined);
     return { ok: false, text: 'La sesión terminó mientras esperaba el Chrome personal.' };
   }
   this.#held = handle;
   ```
   Con el punto 1, el candado se suelta una sola vez: o lo suelta `#acquire` al ver el cierre, o lo suelta `#release`
   en `close()`.

### Otras opciones

Esta propuesta no es la única, y alguna de estas puede ser más robusta:

- Pasar `signal: this.#stop.signal` a `locks.acquire` sirve como complemento, pero no basta por sí solo.
  `acquireFirst` solo mira la señal entre intentos (`manager.ts:373`, `388`), no en medio de `mkdir` y `owner`.
- Hacer que la recuperación también acepte una carpeta `chrome-personal` **sin `owner`** con más de N segundos
  (`LockInfo.since` usa el `mtime` de la carpeta). Cubriría además un `taskkill /F` de la puerta en plena toma, que
  ningún arreglo dentro de `close()` puede evitar. Choca con la regla del gestor de no liberar candados ilegibles
  (`manager.ts:209`), y la skill `local-compute-scheduling` también crea la carpeta antes de escribir `owner`. Haría
  falta un umbral generoso (por ejemplo 60 s) y limitarlo al candado `chrome-personal`.
- Publicar el candado con `owner` ya escrito: crear una carpeta temporal con `owner` dentro y renombrarla a
  `chrome-personal`. Así desaparece del todo la ventana sin `owner`. Pero cambia el protocolo compartido con la skill
  (`mkdir` atómico), y en POSIX/WSL `rename` puede reemplazar una carpeta vacía (`manager.ts:329`), así que exige
  revisar las dos plataformas.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta, en `tests/core/plugins/chrome-gate.test.ts` (importar `vi` de `vitest`):
  1. **Doble del gestor.** Crear `ChromeGate` directamente con
     `locks: { acquire: vi.fn(() => pendiente.promise), releaseAbandoned: vi.fn() }`. Luego:
     - llamar a `onClientLine` con una `tools/call` (`id: 1`);
     - esperar con `until` a que `acquire` se haya llamado;
     - hacer `const cerrando = g.close()` y comprobar que `cerrando` todavía no resolvió;
     - resolver `pendiente` con un handle cuyo `release` sea `vi.fn(async () => {})`;
     - hacer `await cerrando`.

     Afirmar: `release` se llamó exactamente 1 vez, `g.holding === false` y la línea no se reenvió al servidor
     (`toServer` vacío).
  2. **Gestor real en carpeta temporal.** Usar
     `new LockManager({ root, fs: { mkdir: (p, o) => p.endsWith(CHROME_LOCK) ? frenado.then(() => mkdir(p, o)) : mkdir(p, o) } })`.
     Iniciar la llamada, esperar a que el `mkdir` del candado esté frenado, llamar a `g.close()`, soltar `frenado` y
     esperar el cierre. Afirmar que `exists(join(root, CHROME_LOCK))` es `false`: no queda ni la carpeta ni un `owner`.
- Comando (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/plugins/chrome-gate.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/plugins/chrome-gate.test.ts`).
- Verificación manual, con un MCP simulado y sin Chrome real (el lanzador falso de `tests/core/plugins/helpers.ts`):
  1. Tomar `chrome-personal` a mano en una carpeta de candados temporal.
  2. Lanzar `node chrome-gate.ts --locks-root <temporal> --retry-ms 50 -- <lanzador falso>` y enviar una
     `tools/call`.
  3. Soltar el candado y, en el mismo instante, cerrar stdin o enviar `SIGTERM`, repitiéndolo varias veces.
  4. Tras cada salida de la puerta, no debe quedar `<temporal>\chrome-personal` y, si queda, debe tener `owner`.
