# Varias pruebas del chat esperan el fin del turno contando vueltas (1-3 s) y siguen sin avisar si el turno no terminó

- **Área:** Pruebas y rendimiento
- **Severidad:** baja
- **Archivos:** `tests/core/chat/f5-chat.test.ts:91`, `tests/core/chat/f5-chat.test.ts:110`, `tests/core/chat/f5-chat.test.ts:117`, `tests/core/chat/aislamiento-f5.test.ts:91-97`, `tests/core/chat/service.test.ts:262-264`, `tests/core/chat/target.test.ts:288-290`, `tests/core/chat/helpers.ts:205-213`, `tests/core/chat/helpers.ts:228`, `src/core/chat/service.ts:455-470`, `src/core/chat/service.ts:736`, `src/core/chat/service.ts:860`
- **Estado:** resuelta

## Cómo ocurre
Las pruebas del chat mandan un mensaje a la mente (con una `query` falsa, `chatQuery`/`echoTurn` de
`tests/core/chat/helpers.ts:88` y `:114`, sin demoras artificiales) y esperan a que el chat salga de `running`.
`ChatService.send` deja el chat en `running` (`src/core/chat/service.ts:468-470`) y el lector lo pasa a `idle` o `error`
al llegar el `result` (`#finishTurn`, `src/core/chat/service.ts:860`).

En cuatro sitios esa espera es un bucle con tope en número de vueltas y sin ninguna comprobación al salir:

- `tests/core/chat/f5-chat.test.ts:91` y `:117`:
  ```ts
  for (let i = 0; i < 200 && services[0]?.get(chat.id).state === 'running'; i++) await tick();
  ```
- `tests/core/chat/aislamiento-f5.test.ts:94` (dentro de `openChat`, que usan cuatro pruebas del archivo), mismo bucle.
- `tests/core/chat/service.test.ts:263`: `for (let i = 0; i < 200 && again.get(chat.id).state === 'running'; i++) await tick();`
- `tests/core/chat/target.test.ts:289`: 400 vueltas de `setTimeout(r, 5)`.

`tick` espera 5 ms (`tests/core/chat/helpers.ts:228`: `export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));`).
200 vueltas son alrededor de 1 s en teoría. En Windows cada `setTimeout` corto suele tardar lo que dura el tic del reloj del
sistema (unos 15,6 ms), así que en la práctica son unos 3 s. Ese plazo no tiene relación con el `testTimeout` de 60 s de
`vitest.config.ts:13-15`, cuyo comentario dice que, con la CPU cargada, pruebas de 1 s llegaron a tardar 20 s.

Pasos:
1. Se corre el gate (`npm run -s check`) con la CPU al límite (Defender, otra copia del gate de la flota u otro agente).
2. El turno falso tarda más que el plazo del bucle. El bucle se acaba con el chat todavía en `running` y no lanza nada.
3. La prueba sigue con sus `expect` como si el turno hubiera terminado:
   - En `f5-chat.test.ts`, la primera prueba falla más abajo, en
     `f5-chat.test.ts:110` (`expect(comp.spentUsd('orquestador')).toBeCloseTo(0.01, 9)`), con «expected 0 to be close
     to 0.01». El mensaje apunta al registro del gasto y no a la espera que venció.
   - En `aislamiento-f5.test.ts`, `openChat` no falla en su `throw new Error('sin sesión')` (`:96`), porque la sesión
     ya existe antes de que el chat pase a `running` (`#ensureSession` hace `live.session = session` en
     `src/core/chat/service.ts:736`, y `send` la espera en `:455` antes del `running` de `:468`). La prueba sigue
     con un turno en curso y usa las herramientas de la sesión a la vez que el lector.
   - En `service.test.ts:263` y `target.test.ts:289` también se sigue con el turno en curso (`resume`, eventos,
     `crear_tareas`).

En la flota, un gate rojo devuelve la tarea al autor (`src/core/orchestrator/fleet.ts:422-424`). Un falso rojo con un
mensaje engañoso puede llevar al agente a «arreglar» código que estaba bien.

Corrección al reporte original: `tests/integration/conductor.test.ts:63` (100 × 20 ms) no tiene este problema de aviso,
porque justo después comprueba `expect(comp.fleet.queue.get('tarea-a')?.state).toBe('failed')` (`:64`). Si vence, el
error («expected 'running' to be 'failed'») nombra la causa. Allí solo queda la cuestión del plazo corto. Lo mismo vale para
`service.test.ts:224-225`, `tests/core/plugins/mcp-probe.test.ts:64-65` y los bucles de `router-settings.test.ts:209`,
`fleet-hooks.test.ts:89` y `integration/retry.test.ts:91`, que comprueban el estado al salir.

## Por qué pasa
El tope del bucle se cuenta en vueltas y no en tiempo, y al agotarse el bucle no lanza ningún error. El propio banco de
pruebas ya tiene la espera correcta: `ChatBench.settle` (`tests/core/chat/helpers.ts:205-213`) mide el tiempo con
`Date.now()`, lanza `el chat ${chatId} sigue running` al vencer el plazo (5 s) y además deja correr una vuelta más del
lector. Estas pruebas no la usan porque su `ChatService` sale de la composición real (`onReady`) y no de `bench()`, y
`settle` está atado al servicio del banco.

## Solución posible
1. En `tests/core/chat/helpers.ts`, sacar la lógica de `settle` a una función exportada que reciba el servicio:
   ```ts
   export async function settleChat(service: Pick<ChatService, 'get'>, chatId: string, timeoutMs = 15_000): Promise<void> {
     const t0 = Date.now();
     while (service.get(chatId).state === 'running') {
       if (Date.now() - t0 > timeoutMs) throw new Error(`el chat ${chatId} sigue running tras ${timeoutMs} ms`);
       await tick();
     }
     await tick();
   }
   ```
   `ChatBench.settle` puede quedar como `settle: (chatId, ms) => settleChat(service, chatId, ms)`.
2. Reemplazar los cuatro bucles por `await settleChat(...)`:
   - `f5-chat.test.ts:91` y `:117`: `await settleChat(services[0]!, chat.id);`
   - `aislamiento-f5.test.ts:94`: igual, dentro de `openChat`.
   - `service.test.ts:263`: `await settleChat(again, chat.id);`
   - `target.test.ts:289`: `await settleChat(service, chat.id);`
3. Usar un plazo de 15 s, muy por debajo del `testTimeout` de 60 s, para que el error del helper llegue antes que el
   «Test timed out» genérico.

### Otras opciones
- Dejar los bucles y agregar después `expect(services[0]?.get(chat.id).state, 'el turno no terminó').not.toBe('running')`,
  subiendo las vueltas. Es el cambio mínimo, pero el plazo seguiría dependiendo de la granularidad del reloj.
- El repo ya tiene varias esperas locales por tiempo casi iguales: `waitFor` en `tests/core/chat/background.test.ts:81`,
  `until` en `tests/core/plugins/chrome-gate.test.ts:16`, en `tests/core/workspace/hardening.cases.ts:31` y en
  `tests/integration/rest-reconfig.test.ts:45`. Un `until(cond, { ms, what })` común en un helper compartido de `tests/`
  podría reemplazar todas esas copias y estos bucles, y el mensaje diría qué espera venció. Es una solución más amplia y
  más ordenada, pero toca más archivos.
- Mejor aún, a futuro: esperar el evento en vez de sondear, suscribiéndose al `EventHub` hasta el `chat_message` de la
  mente o el cambio de estado. Así no hay plazo fijo, solo el `testTimeout`.

La propuesta de arriba no es la única. Es la más corta porque reutiliza la lógica que `settle` ya tiene probada.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: `tests/core/chat/settle-chat.test.ts`.
  - Escenario 1: un servicio falso `{ get: () => ({ state: 'running' }) }` y `settleChat(falso, 'c1', 50)`. Afirma que
    rechaza con un error que contiene `c1` y `running`.
  - Escenario 2: un servicio falso que pasa a `idle` después de unas vueltas. Afirma que `settleChat` resuelve sin error.
  - Escenario 3 (guardia contra la vuelta atrás): leer con `readFile` los `.test.ts` de `tests/core/chat/` y afirmar que
    ninguno contiene un bucle con la forma `/for \(let i = 0; i < \d+ && [^;]*state === 'running'/`.
- Comandos (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/chat/settle-chat.test.ts tests/core/chat/f5-chat.test.ts tests/core/chat/aislamiento-f5.test.ts tests/core/chat/service.test.ts tests/core/chat/target.test.ts"`
  (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/core/chat`).
- Comprobación a mano del mensaje: bajar temporalmente el plazo de `settleChat` a 1 ms en `f5-chat.test.ts:91` y ver que
  el fallo dice «el chat … sigue running» en esa línea, y no «expected 0 to be close to 0.01» en la línea 110.
- Verificación manual en la app: no aplica (solo cambia código de pruebas).
