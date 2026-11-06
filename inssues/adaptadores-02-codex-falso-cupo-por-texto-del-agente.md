# Codex marca «cupo agotado» cuando el propio agente escribe insufficient_quota o usage_limit_reached en su mensaje

- **Área:** Adaptadores de agentes
- **Severidad:** media
- **Archivos:** `src/core/adapters/codex-cli/translate.ts:49`, `src/core/adapters/codex-cli/translate.ts:16`, `src/core/adapters/codex-cli/index.ts:206`, `src/core/adapters/codex-cli/index.ts:211`, `src/core/adapters/codex-cli/index.ts:237`, `src/core/orchestrator/supervisor.ts:537`, `src/core/orchestrator/supervisor.ts:566`, `src/core/orchestrator/supervisor.ts:235`, `src/core/orchestrator/supervisor.ts:240`, `src/core/orchestrator/router.ts:138`, `src/core/adapters/agy-cli/index.ts:34`, `tests/core/adapters/codex-cli/adapter.test.ts:99`
- **Estado:** abierta

## Cómo ocurre

`codex exec --json` entrega cada mensaje del modelo como un `item.completed` de tipo `agent_message`, y en un turno
normal hay varios: uno de avance y el resumen final (fixture real `fixtures/codex/exec-command-edit.jsonl:3` y `:8`).
El cupo agotado real llega por otros eventos estructurados: `error` y `turn.failed`
(`fixtures/codex/errors-synthetic.jsonl:1-2`), que ya se traducen en `translate.ts:80-85`.

Aun así, el traductor revisa el texto libre del modelo con una regex y, si coincide, cambia el mensaje por un error
de cupo (`src/core/adapters/codex-cli/translate.ts:47-52`):

```ts
case 'agent_message':
case 'reasoning':
  if (item.type === 'agent_message' && item.text && /you(?:'ve| have) hit your usage limit|usage_limit_reached|insufficient_quota/i.test(item.text)) {
    return [{ type: 'error', payload: { code: 'quota_exhausted', message: item.text } }];
  }
```

Pasos:

1. Codex trabaja en un proyecto que maneja errores de OpenAI, o en el propio Berland, que tiene estas cadenas en su
   código y sus pruebas (`src/core/adapters/api/errors.ts:18`, `:173`, `tests/core/adapters/api/errors.test.ts:123`,
   `tests/core/adapters/codex-cli/adapter.test.ts:108`). Por ejemplo, la tarea «maneja el error insufficient_quota
   del cliente OpenAI».
2. Codex termina bien. Su resumen final dice algo como «Agregué el manejo de `insufficient_quota` en client.ts».
3. `translate.ts:49` encuentra la cadena y devuelve un solo `error` con código `quota_exhausted`. El texto ya no
   llega como mensaje del asistente.
4. El adaptador pone `failed = true` ante cualquier `error` (`src/core/adapters/codex-cli/index.ts:205-206`). Nada
   lo revierte: el `turn.completed` siguiente solo pone `completed = true` (`:207`), y la salida con código 0 no
   toca `failed` (`:197`). Por eso el cierre es `done { ok: false }` (`:237`).
5. `AttemptState.observe` pone `quota = true` (`src/core/orchestrator/supervisor.ts:537`), que no se puede deshacer.
   Luego `finish` deja `ok = false` y `outcome = 'quota_exhausted'` (`supervisor.ts:566-567`), aunque haya llegado
   `usage`.
6. `execute` llama `this.#router.markExhausted(agentId)` (`supervisor.ts:235`): Codex queda bloqueado 15 minutos
   (`DEFAULT_EXHAUSTED_COOLDOWN_MS`, `router.ts:7`), salvo que una lectura de cupo tomada después lo libere
   (`router.ts:252-271`). Además, la tarea pasa a Claude con motivo `quota_exhausted` (`supervisor.ts:240-244`).
   Claude vuelve a pagar por un trabajo que ya estaba hecho. Si era el último intento, la tarea termina como
   fallida.

La prueba actual confirma este comportamiento en lugar de evitarlo
(`tests/core/adapters/codex-cli/adapter.test.ts:99-102`): un `agent_message` con «You've hit your usage limit» debe
producir `error quota_exhausted`. No hay ninguna prueba con un `agent_message` normal que mencione esas cadenas.
Ninguno de los issues de `docs/plan/issues` (01 a 13) toca esto. La línea viene del commit que creó el adaptador
(`bf0f951`).

Hay un caso parecido en el mismo adaptador, menos probable. Toda línea que no es JSON (de stderr o de stdout) pasa
por `classifyCodexError` (`index.ts:210-212`), y su regex no tiene límites de palabra:
`quota`, `rate[_ -]?limit` y `401` (`translate.ts:17-18`). Codex escribe avisos de diagnóstico en stderr, por ejemplo
`WARNING: proceeding, even though we could not create PATH aliases … codex-arg0DeKUKn`
(`fixtures/codex/exec-init-failed.txt:1-2`). Basta que una línea así contenga una de esas cadenas, por ejemplo
`401` en un nombre al azar, para que el intento falle (`auth` o `quota_exhausted`) aunque el turno se confirme. agy
tiene el mismo patrón: `fatalLineCode` (`src/core/adapters/agy-cli/index.ts:34-37`) aplica `classifyAgyError`,
también sin límites de palabra (`src/core/adapters/agy-cli/translate.ts:75`, `:81`), a cada línea de stderr y a
cada línea de texto que no es JSON (`agy-cli/index.ts:258-273`).

## Por qué pasa

Para detectar el cupo, el adaptador busca con regex en el texto libre que escribe el modelo y en el stderr de
diagnóstico. Debería usar solo las señales estructuradas del CLI: los eventos `error` y `turn.failed`, y el código
de salida. Además, cualquier evento `error` decide el resultado sin vuelta atrás, tanto en el adaptador (`failed`)
como en el Supervisor (`quota`), aunque después lleguen `turn.completed` y la salida con código 0.

## Solución posible

1. En `src/core/adapters/codex-cli/translate.ts`, quitar las líneas 49-51 y emitir siempre el `agent_message` como
   `text` con rol `assistant`. El cupo real ya llega por `error` y `turn.failed` (líneas 80-85).
2. En `src/core/adapters/codex-cli/index.ts:210-213`, clasificar solo las líneas que traen el prefijo de error de
   Codex (`Error:` o `ERROR`) y que no empiezan con `WARNING:`. En `classifyCodexError`, poner límites de palabra
   (`\b401\b`, `\bquota\b`, `\brate[_ -]?limit\b`). Las demás líneas siguen saliendo como `raw`.
3. Cambiar la prueba de `tests/core/adapters/codex-cli/adapter.test.ts:99-106`. La parte de stderr se queda, con un
   mensaje con prefijo de error. La de `agent_message` debe pedir lo contrario: un evento `text`.

### Otras opciones

- (a) Conservar la heurística del texto, pero solo cuando el mensaje sea exactamente el error de Codex: que empiece
  con «You've hit your usage limit» y que el proceso termine sin `turn.completed` o con código distinto de 0. Es
  decir, guardar la coincidencia como pista en el adaptador y emitir el `error` al cerrar, solo si el turno no se
  confirmó. Sirve si alguna versión de Codex llegara a mandar el aviso de cupo como `agent_message`. Hoy ninguna
  captura real lo muestra.
- (b) Defensa en el Supervisor: si el mismo intento recibió `usage` y la salida terminó con código 0, tratar el
  `quota_exhausted` como un fallo normal y no llamar `markExhausted`. Así no se bloquea al agente por error, pero el
  intento sigue marcado como fallido. Conviene como complemento, no como arreglo único.
- (c) Aplicar el mismo criterio a agy: en `fatalLineCode`, prefijo de error y límites de palabra, o reducir
  `classifyAgyError` a patrones exactos como `RESOURCE_EXHAUSTED`.

La propuesta no es la única. Si se quiere ir más a fondo, se puede ordenar la detección para todos los CLI. Las
señales estructuradas decidirían el resultado, y las heurísticas sobre texto solo servirían de pista cuando el turno
no se confirma.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta en `tests/core/adapters/codex-cli/adapter.test.ts`:
  - Unitaria: `translateCodexEvent({ type: 'item.completed', item: { id: '1', type: 'agent_message', text: 'Manejo
    `insufficient_quota` y usage_limit_reached en client.ts' } }, '')` devuelve
    `[{ type: 'text', payload: { text: …, role: 'assistant' } }]`, sin ningún `error`.
  - Del adaptador: un runner falso entrega `thread.started`, ese `agent_message`, `turn.completed` con `usage` y
    `exit` con código 0. Afirma que no hay ningún evento `error` y que el último evento es `done { ok: true }`.
  - stderr: un runner falso entrega una línea de stderr
    `WARNING: proceeding, even though we could not create PATH aliases … codex-arg0a4012b`, un `turn.completed` y
    `exit` 0. Afirma que el último evento es `done { ok: true }`. Se mantiene el caso actual con un stderr de error
    real («Error: You've hit your usage limit»), que debe seguir dando `quota_exhausted`.
  - En `tests/core/orchestrator/supervisor.test.ts`: con un adaptador falso de Codex que emite el `agent_message` de
    arriba, `usage` y `done { ok: true }`, `execute` devuelve `outcome: 'ok'`, no hay handoff a Claude y el router no
    marca a Codex como agotado.
  - agy, en `tests/core/adapters/agy-cli/`: una línea de stderr de diagnóstico con `401` dentro de un nombre no
    produce `error auth`.
- Comando para correrla (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/adapters/codex-cli/adapter.test.ts tests/core/orchestrator/supervisor.test.ts"`
  (o desde PowerShell en C:\dev\orquestador:
  `npx vitest run tests/core/adapters/codex-cli/adapter.test.ts tests/core/orchestrator/supervisor.test.ts`).
- Verificación manual en la app: pedir a Codex una tarea pequeña cuyo resumen final mencione `insufficient_quota`,
  por ejemplo «agrega un comentario que explique el error insufficient_quota en src/core/adapters/api/errors.ts».
  Al terminar, la tarea debe quedar en éxito, sin traspaso a Claude ni aviso de «agotó el cupo hace poco» para
  Codex.
