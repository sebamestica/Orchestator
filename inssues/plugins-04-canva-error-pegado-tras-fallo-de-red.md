# Si renovar el token de Canva falla una vez por la red, Canva queda en «error» aunque la renovación siguiente funcione

- **Área:** Plugins y navegador
- **Severidad:** media
- **Archivos:** `src/core/plugins/canva.ts:160`, `src/core/plugins/canva.ts:163`, `src/core/plugins/canva.ts:165`, `src/core/plugins/canva.ts:230`, `src/core/plugins/canva.ts:240`, `src/core/plugins/canva.ts:242`, `src/core/plugins/canva.ts:284`, `src/core/plugins/oauth.ts:324`, `src/core/plugins/service.ts:157`, `src/core/plugins/service.ts:158`, `src/core/plugins/service.ts:261`, `src/core/plugins/service.ts:322`, `src/core/plugins/service.ts:345`, `src/ui/features/plugins/PluginsView.tsx:86`
- **Estado:** resuelta

## Cómo ocurre

Contexto. La sesión OAuth de Canva vive en la bóveda (`plugin-canva`). `CanvaConnector` la carga solo cuando alguien la
necesita: no hay ninguna carga al arrancar el núcleo y `hasSession()` no se usa en ningún sitio. Cada vez que arranca
una tarea o una sesión de la mente, `PluginService.#collect` decide si entrega Canva. Para eso mira el estado guardado en
SQLite (`plugins_state`), no la bóveda:

```ts
// service.ts:322
const wants = (id: PluginId, s: PluginState) => s.status === 'connected' && PLUGIN_AGENT_KINDS[id].includes(kind) && ...
```

Si el estado es `connected`, pide el token:

```ts
// canva.ts:160-166
async accessToken(): Promise<string | undefined> {
  let stored = await this.#load();
  if (!stored) return undefined;
  if (this.#needsRefresh(stored)) stored = await this.#refresh(stored);
  if (!stored) return undefined;
  if (stored.tokens.expiresAt !== undefined && stored.tokens.expiresAt <= this.#now()) return undefined;
  return stored.tokens.accessToken;
}
```

Pasos:

1. Canva está conectado. El token de acceso vence sin que el núcleo lo pueda renovar. Pasa si el núcleo estuvo apagado
   más tiempo que la vida del token (el temporizador recién se arma en la primera carga, `canva.ts:265`) o si el PC
   estuvo sin red más de ~30 min (el margen de `#needsRefresh`).
2. Arranca una tarea o una sesión de la mente mientras la red aún no responde. Ejemplo: Berland se abre al iniciar
   sesión, antes de que conecte el Wi-Fi. También vale un HTTP 5xx del endpoint de tokens de Canva.
3. `accessToken()` intenta renovar (`canva.ts:163`). `fetch` falla y `send` lo convierte en
   `OAuthError('network', …)` (`oauth.ts:324`); un 5xx sin cuerpo OAuth da `OAuthError('http', …)`. Ninguno es
   `invalid_grant` ni `invalid_client`, así que `#doRefresh` lo trata como pasajero:

   ```ts
   // canva.ts:240-243
   // Fallo pasajero (red): se sigue con el token actual mientras no venza y se reintenta más tarde.
   this.#opts.log?.(`canva: no se pudo refrescar el token: ...`);
   this.#schedule(stored, MIN_TIMER_MS * 4);   // 2 minutos
   return stored;
   ```

4. El token devuelto ya venció, así que `accessToken()` devuelve `undefined` (`canva.ts:165`). `#collect` no sabe si
   fue un fallo pasajero o si la sesión se perdió, y marca el plugin como roto:

   ```ts
   // service.ts:344-346
   const now = this.#state('canva');
   if (now.status === 'connected') this.#save({ ...now, status: 'error', detail: 'No hay una sesión de Canva vigente: vuelve a conectar.', steps: [...CANVA_STEPS] });
   notes.push('Canva no está disponible en esta sesión (la sesión de Canva venció).');
   ```

5. Dos minutos después el temporizador (`canva.ts:284-288`) renueva sin problema. `#save` guarda el token nuevo en la
   bóveda, programa la próxima renovación y emite `onSessionChange({kind:'refreshed'})` (`canva.ts:230`). El servicio
   no hace nada con ese evento, porque solo atiende `lost`:

   ```ts
   // service.ts:157-159
   onSessionChange: (e) => {
     if (e.kind === 'lost') this.#save({ ...this.#state('canva'), status: 'error', ... });
   },
   ```

6. El estado sigue en `error`. `wants` exige `connected` (`service.ts:322`), así que ninguna tarea ni sesión de la mente
   vuelve a recibir Canva. El único sitio que vuelve a poner `connected` es el callback de OAuth
   (`service.ts:261`). El constructor solo corrige `connecting` (`service.ts:162-165`), así que reiniciar el núcleo
   tampoco lo arregla. En la tarjeta, con `error` solo aparece «Conectar» (`PluginsView.tsx:72` y `:86`), que repite
   todo el OAuth. Mientras tanto el temporizador sigue rotando en segundo plano un token válido que nadie usa.

No hay ninguna prueba de esto: `tests/core/plugins/canva-oauth.test.ts` cubre la renovación correcta (línea 176) y el
rechazo `invalid_grant` (línea 201), pero no un fallo pasajero con el token ya vencido.

## Por qué pasa

`accessToken()` devuelve `undefined` en dos casos que no son lo mismo: «no hay sesión o se revocó» y «hay sesión,
pero esta vez no se pudo renovar». `#collect` trata los dos como sesión perdida y guarda `error`, que es un estado del
que no se sale solo: nada lo pasa de vuelta a `connected` cuando la renovación siguiente funciona. El evento
`refreshed` existe justo para eso (su comentario en `canva.ts:74` dice «para actualizar el estado visible»), pero el
servicio lo ignora.

## Solución posible

1. `src/core/plugins/canva.ts`: que `accessToken()` diga por qué no hay token. Por ejemplo, devolver
   `{ token } | { reason: 'none' } | { reason: 'transient', retryAt }`, o un método aparte `tokenStatus()`. Usar
   `none` cuando no hay sesión cargada o `#doRefresh` devolvió `undefined` (rechazo), y `transient` cuando el refresco
   falló por red o HTTP y quedó programado otro intento.
2. `src/core/plugins/service.ts` (`#collect`, líneas 337-351): guardar `error` solo con `none`. Con `transient`,
   dejar `connected`, poner en `detail` algo como «No se pudo renovar el token (sin conexión); se reintenta solo» y
   agregar la nota de que Canva no está disponible en esta sesión.
3. `src/core/plugins/service.ts:157-159`: atender `refreshed`. Si el estado actual es `error` o `connected` y la
   bóveda tiene sesión, guardar `connected` con el detalle de la nueva expiración, el mismo texto que usa
   `handleCanvaCallback` en `service.ts:260-261`. Esto también arregla los estados `error` que ya quedaron guardados
   por este fallo, en la siguiente renovación del temporizador.

### Otras opciones

- No guardar el estado de la sesión en SQLite: que `status('canva')`/`wants` lo calculen desde la bóveda
  (`hasSession()` y la expiración) y dejen el `error` guardado solo para fallos del flujo OAuth. Es más robusto
  porque deja una sola fuente de verdad, pero `status()` es síncrono y `#load()` no, así que hay que cachear la sesión
  en memoria y cargarla al arrancar.
- Dentro de `accessToken()`, reintentar el refresco 2 o 3 veces con una espera corta antes de rendirse. Ayuda cuando
  el corte dura segundos (el Wi-Fi recién conectando), pero no cuando dura minutos, y sin el punto 3 sigue
  dejando `error` pegado. Puede ir junto con la propuesta, no en su lugar.
- Cargar la sesión de Canva al arrancar el núcleo (para que el temporizador se arme enseguida) reduce el margen en
  que el token está vencido, pero no corrige el estado pegado.

La propuesta no es la única ni tiene por qué ser la mejor. La primera alternativa evita que SQLite y la bóveda puedan
quedar desalineados, aunque cuesta más cambiarla.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta: un caso nuevo en `tests/core/plugins/canva-oauth.test.ts`,
  «fallo de red al renovar con el token vencido: no queda en error y se recupera solo».
  - Armar `canvaHarness` y pasarle a `pluginHarness` un `canva.fetch` que delegue en `globalThis.fetch` y, mientras una
    bandera `offline` esté activa, lance `TypeError('fetch failed')` para las peticiones con
    `grant_type=refresh_token`. Conectar Canva con el flujo normal (`connectCanva` + `authorize`).
  - Usar `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })` para el temporizador de 2 min, y el
    `manualClock` existente para la hora.
  - Activar `offline`, `h.clock.advance(61 * 60_000)` (el token de 3600 s ya venció) y llamar a
    `h.service.grant({ agentId: 'claude-main', kind: 'claude-sdk', taskId: 't1' })`. Afirmar que `grant.servers.canva`
    no viene, que las notas dicen que Canva no está disponible y que `h.service.status('canva').status` sigue en
    `'connected'`, no en `'error'`. Hoy da `'error'`: ese es el fallo.
  - Desactivar `offline`, `await vi.advanceTimersByTimeAsync(2 * 60_000)` y esperar con `vi.waitFor` a que la bóveda
    tenga un `accessToken` nuevo. Afirmar que `status('canva').status === 'connected'`, que llegó un mensaje
    `{type:'plugin'}` con ese estado y que un nuevo `grant()` trae `canva` con `Authorization: Bearer <token nuevo>`.
  - Un segundo caso para el arreglo del punto 3: guardar a mano el estado `error` con
    «No hay una sesión de Canva vigente» (con una sesión válida en la bóveda), forzar una renovación correcta y
    afirmar que vuelve a `connected`.
  - Comprobar que la prueba de `invalid_grant` (línea 201) sigue pasando: el rechazo debe seguir dejando `error` y
    borrar la bóveda.
- Comando para correrla (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/plugins/canva-oauth.test.ts"`
  (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/core/plugins/canva-oauth.test.ts`).
- Verificación manual en la app: con Canva conectado, cerrar Berland, esperar a que venza el token (o adelantar
  `expiresAt` en una bóveda de prueba, nunca en la real), cortar la red, abrir Berland y lanzar una tarea. La tarjeta
  de Canva en Plugins no debe pasar a «error». Al volver la red, en menos de 2 min la tarjeta debe seguir en
  «Conectado» con la nueva fecha de vencimiento, y la siguiente tarea debe recibir Canva sin volver a pulsar
  «Conectar».
