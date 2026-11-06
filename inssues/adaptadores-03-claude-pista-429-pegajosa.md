# Claude: un 429 que se resolvió al reintentar convierte cualquier fallo posterior del mismo intento en «cupo agotado»

- **Área:** Adaptadores de agentes
- **Severidad:** media
- **Archivos:** `src/core/adapters/claude-sdk/translate.ts:521`, `src/core/adapters/claude-sdk/translate.ts:526`, `src/core/adapters/claude-sdk/translate.ts:383`, `src/core/adapters/claude-sdk/translate.ts:384`, `src/core/adapters/claude-sdk/translate.ts:411`, `src/core/adapters/claude-sdk/translate.ts:582`, `src/core/adapters/claude-sdk/translate.ts:583`, `src/core/adapters/claude-sdk/adapter.ts:448`, `src/core/adapters/claude-sdk/adapter.ts:449`, `src/core/adapters/claude-sdk/errors.ts:7`, `src/core/adapters/claude-sdk/errors.ts:29`, `src/core/adapters/claude-sdk/errors.ts:31`, `src/core/orchestrator/supervisor.ts:537`, `src/core/orchestrator/supervisor.ts:567`, `src/core/orchestrator/supervisor.ts:240`, `src/core/orchestrator/supervisor.ts:418`, `src/core/orchestrator/router.ts:198`
- **Estado:** abierta

## Cómo ocurre

El SDK de agentes de Claude reintenta solo los errores de la API (hasta 10 veces) y avisa de cada reintento con un
mensaje `system/api_retry`. El traductor guarda ese aviso como «pista» (`hint`), para usarla si el resultado final
falla sin decir por qué. El comentario de `errors.ts:7` deja clara la intención: un 429 es `quota_exhausted` solo
cuando **persiste tras los reintentos del SDK**.

Pero la pista nunca se borra. `src/core/adapters/claude-sdk/translate.ts:525-526`:

```ts
const code = classifyClaudeError({ httpStatus: r.data.error_status, assistantError: r.data.error }, 'unknown');
if (code !== 'unknown') this.hint = { code, message: `La API respondió ${status} (${r.data.error}).` };
```

Con un 429 queda `hint = { code: 'quota_exhausted', message: 'La API respondió HTTP 429 (rate_limit).' }`. Un
`rate_limit_event` con `status: 'rejected'` deja una pista igual (`translate.ts:383-384`). En todo el archivo no hay
otra asignación a `hint` que la borre: `#assistant` registra el uso de un mensaje bueno (`translate.ts:411`), pero no
toca la pista.

Pasos:

1. Varios Claude trabajan en paralelo con la misma clave y uno recibe un 429 pasajero. El SDK emite `api_retry` con
   `error_status: 429`, reintenta y la llamada siguiente responde bien. El agente sigue trabajando y emite mensajes
   `assistant` normales.
2. Más tarde, en el mismo intento, la ejecución falla por otra causa:
   - un `result` con `is_error: true` o un `subtype` distinto de `success` (`error_during_execution`, `error_max_turns`,
     «Prompt is too long»…), o
   - el proceso muere o termina sin `result`.
3. En el primer caso, `translate.ts:582-583` añade el texto de la pista a la evidencia y además la usa como código
   por defecto:

   ```ts
   const texts = [...(r.errors ?? []), r.result ?? '', this.hint?.message ?? ''].filter(Boolean);
   const code = classifyClaudeError({ subtype: r.subtype, httpStatus: r.api_error_status, texts }, this.hint?.code ?? 'unknown');
   ```

   En el segundo, `adapter.ts:448-449` hace lo mismo:

   ```ts
   const texts = [message, ...stderr, tr.hint?.message ?? ''];
   const code = classifyClaudeError({ texts }, tr.hint?.code ?? 'crash');
   ```

   `codeFromText` encuentra `429` y `rate_limit` en el texto de la pista (`errors.ts:29` `/rate[\s_-]*limit/` y
   `errors.ts:31` `/\b(?:402|429)\b/`), así que el evento `error` sale con `quota_exhausted`, aunque la API llevaba
   rato respondiendo bien. Solo se salva si el texto del error real coincide antes con `AUTH_PATTERNS`. Si `errors`
   y `result` vienen vacíos, el mensaje que ve el usuario es el de la pista (`texts[0]`, `translate.ts:587`):
   «La API respondió HTTP 429 (rate_limit).».
4. El Supervisor ve un `error` con `quota_exhausted` y marca el intento como agotado
   (`supervisor.ts:537` y `supervisor.ts:567`). Entonces toma la rama del cupo (`supervisor.ts:240-244`): traspasa a
   otro Claude con `#takeClaude(exclude, agentId, false)`, pone `failures = 0` y **no** sube `retries`, es decir, no
   hay reintento con el mismo agente ni con más esfuerzo.
5. Si ese era el único Claude habilitado, `#takeClaude` lo excluye (`supervisor.ts:421`), `pickClaude` termina en
   `#claudeOrder(exclude)` con `required = true` (`router.ts:204` y `router.ts:296-300`) y lanza `RoutingError`. Como
   `retryCurrent` es `false`, la excepción sube (`supervisor.ts:423-424`) y el `catch` de `execute` da la tarea por
   fallida (`supervisor.ts:272-273`) con «No hay instancias de Claude disponibles (excluidos: …)». Un fallo que se
   habría arreglado reintentando mata la tarea en el primer intento.
6. Si hay varios Claude, la tarea rebota de uno a otro como «traspaso por cupo», y el resumen del traspaso y la cola
   (`handed_off` con motivo `quota_exhausted`) dan una causa falsa.

Corrección al reporte original: `markExhausted` (`supervisor.ts:235`) **no** deja a un Claude en enfriamiento de
15 minutos. `#exhaustedAt` solo se consulta en `checkQuota` (`router.ts:252-272`), que se usa para Codex/agy;
`#claudeOrder` (`router.ts:291-303`) no lo mira. El daño está en los pasos 4 a 6, no en un bloqueo del agente.

Ninguna prueba cubre esta secuencia. `tests/core/adapters/claude-sdk/translate.test.ts:192-198` solo comprueba que un
429 pasajero deja la pista sin volverla fatal, y `translate.test.ts:185-190` comprueba que la pista se usa cuando el
resultado «no dice más». Ninguna prueba arma un 429 seguido de un mensaje bueno y un fallo de otra causa. Tampoco lo
cubre ningún arreglo de hoy en `docs/plan/issues`.

## Por qué pasa

`hint` guarda la última señal de error de toda la ejecución y no distingue una condición pasajera que ya se resolvió
de la causa del fallo final. Además, el texto de la pista entra en `texts` como evidencia para las regex. Por eso,
aunque el resultado traiga su propio error («Prompt is too long»), el `429` de la pista gana en `codeFromText`, y el
código por defecto también es el de la pista.

## Solución posible

En `src/core/adapters/claude-sdk/translate.ts`:

1. En `#assistant`, cuando llega un mensaje válido de la API (`!msg.is_api_error_message` y sin `msg.error`), borrar
   la pista si es de cupo pasajero: `if (this.hint?.code === 'quota_exhausted') this.hint = undefined;`. La API volvió
   a responder, así que el 429 o el `rejected` anterior ya no explica nada. No conviene borrar una pista `auth`: esa
   ya corta la ejecución como `fatal`.
2. En `#result` (línea 582) y en `adapter.ts:448`, no sumar `hint.message` a `texts`. Dejar la pista solo como código
   por defecto (`fallback`), para que el texto del error real mande. Si `texts` queda vacío, el mensaje puede seguir
   usando la pista para explicar el fallo.

Un 429 persistente se sigue clasificando bien. Cuando el SDK agota los reintentos, emite un mensaje sintético
`is_api_error_message` con `error: 'rate_limit'` (`translate.ts:412-414`), que vuelve a poner la pista y no la borra.
Además, el `result` trae `api_error_status: 429` o «429» en `errors` (caso «429 persistente» en
`translate.test.ts:173`).

### Otras opciones

- (a) Guardar por separado `lastRetryAt` y `lastGoodMessageAt` (o un contador de secuencia) y usar la pista de cupo
  solo si `lastRetryAt > lastGoodMessageAt`, es decir, si la ejecución terminó mientras seguía reintentando. Es más
  preciso si alguna vez hay hilos en paralelo: un subagente que responde bien mientras el hilo principal sigue
  recibiendo 429 no debería borrar la pista. Con la propuesta de arriba, en ese caso el resultado final igual trae el
  429 en `api_error_status` o en `errors`, así que no se pierde.
- (b) Dejar el traductor como está y, en el Supervisor, tratar un `quota_exhausted` de Claude sin 402, `billing_error`
  ni tope de gasto como un fallo normal con reintento. Es más grueso: también trataría como fallo normal los 429 que
  sí persisten, y mete en el Supervisor conocimiento propio de un adaptador.
- (c) Además del arreglo, cuando `#takeClaude(…, false)` no encuentra otro Claude, el Supervisor podría reintentar con
  el mismo en vez de fallar la tarea (el cupo de Claude no se mide). Es una decisión de política aparte, pero reduciría
  el daño de cualquier clasificación de cupo equivocada.

La propuesta no es la única. La opción (a) es la más exacta si se quiere distinguir por hilo.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta, en `tests/core/adapters/claude-sdk/translate.test.ts` (bloque «clasificación de
  errores del resultado»):
  1. Con `translator()`, traducir `{ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 429, error: 'rate_limit' }`.
  2. Traducir un `assistant` normal: `{ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'sigo' }] } }`.
  3. Traducir `result({ subtype: 'error_during_execution', errors: ['Prompt is too long'] })`.
  4. Afirmar que el `error` emitido **no** tiene código `quota_exhausted` (debe ser `unknown`) y que su mensaje empieza
     por «Prompt is too long».
  5. Prueba de control: sin el `assistant` bueno (solo el `api_retry` y luego `result` con `errors: []`), el código
     sigue siendo `quota_exhausted`, porque el SDK terminó mientras reintentaba.
  6. Lo mismo con `{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }` en lugar del `api_retry`.
- En `tests/core/adapters/claude-sdk/adapter.test.ts`, usar
  `fakeQuery([apiRetry429, assistantBueno], { throwAtEnd: new Error('boom') })` y afirmar que el evento `error` es
  `{ code: 'crash', message: 'boom' }`.
- Opcional, en las pruebas del Supervisor: con un único Claude cuyo adaptador falso emite `error` `unknown` tras el
  arreglo, afirmar que hay un segundo intento con el mismo agente y `retries` mayor, y no un `RoutingError`.
- Comando (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/adapters/claude-sdk/translate.test.ts tests/core/adapters/claude-sdk/adapter.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`:
  `npx vitest run tests/core/adapters/claude-sdk/translate.test.ts tests/core/adapters/claude-sdk/adapter.test.ts`).
- Verificación manual: no es práctica, porque hace falta un 429 real seguido de otro fallo. Basta con las pruebas
  unitarias.
