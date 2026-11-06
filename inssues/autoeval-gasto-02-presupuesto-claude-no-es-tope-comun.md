# El presupuesto del agente Claude no es un tope común: la flota y el panel de cupos no descuentan lo que gasta la mente, y cada chat abierto recibe el saldo entero

- **Área:** Mente y chat (gasto) · Cupos
- **Severidad:** media
- **Archivos:** `src/core/app/f5-chat.ts:103`, `src/core/app/conductor.ts:160`, `src/core/app/compose.ts:124`, `src/core/app/adapters.ts:67`, `src/core/adapters/claude-sdk/adapter.ts:321`, `src/core/adapters/claude-sdk/adapter.ts:406`, `src/core/app/quotas.ts:40`, `src/core/quota/manual-budget.ts:60`, `src/core/chat/service.ts:677`, `src/core/chat/service.ts:695`, `src/core/chat/service.ts:733`, `src/core/conductor/session.ts:350`, `src/core/quota/monitor.ts:98`, `src/core/store/store.ts:665`, `tests/integration/compose.test.ts:78`
- **Estado:** resuelta
- **Origen:** autoevaluación de la mente (2026-11-05)
- **Relacionadas:** `autoeval-gasto-01` (topes por turno y por día de la mente), `uso-real-02` (gasto de la mente contado dos veces al reanudar, que también achica el `maxBudgetUsd`), `agy-20` (presupuesto de los agentes por API), `datos-04` (fotos de cupo; no es el mismo problema, pero `ManualBudgetQuota` escribe ahí)

## Cómo ocurre

**Contexto.** La mente usa la clave del agente Claude (`resolveMind`, `service.ts:199`), pero su gasto se registra con
`agent_id = 'orquestador'`. Para saber cuánto queda del `budgetUsd` de ese agente, Berland hace tres cuentas distintas:

| Quién | Cuenta | Dónde |
|---|---|---|
| Mente del chat | `budget − spent(claude) − spent(orquestador)` | `f5-chat.ts:103-106` |
| Mente de la terminal | igual | `conductor.ts:160-161` |
| Worker Claude de la flota | `budget − spent(claude)` | `adapter.ts:321-334`, con `spentUsd: opts.spentUsd(config.id)` (`adapters.ts:67`) y `spentFn = (agentId) => () => store.spentUsd(agentId)` (`compose.ts:124-125`) |
| Cupo del panel, `cupos()` y el prompt de la mente | `budget − spent(claude)` | `quotas.ts:40` → `ManualBudgetQuota` (`manual-budget.ts:60`); el prompt los toma en `session.ts:350` |

Además, cada sesión de la mente fija su tope una sola vez. `#ensureSession` calcula `left` al crear la sesión
(`service.ts:695`) y lo pasa como `maxBudgetUsd` (`service.ts:733`). Mientras la sesión sigue viva, o tiene subagentes
trabajando, se reutiliza sin volver a mirar el presupuesto (`service.ts:677-691`). El SDK cuenta ese tope desde que
arrancó su propio proceso (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5803`: «maxBudgetUsd counts only the
spend since this query() call started»). Cada chat tiene su proceso, así que cada uno puede gastar el saldo entero.

Lo mismo pasa dentro de la flota: cada tarea Claude lee `budget − spent(claude)` una sola vez al empezar
(`adapter.ts:322-334`) y lo usa como tope (`adapter.ts:350`, `adapter.ts:406`). Dos tareas en paralelo reciben el mismo
saldo. Y como el bucket del panel no descuenta a la mente, las alertas de cupo bajo del `QuotaMonitor`
(`monitor.ts:98-111`) también llegan tarde.

**Pasos** (con un presupuesto realista, por ejemplo `budgetUsd = 20`).

1. Gastado hasta ahora: 10 USD de la flota (`claude`) y 5 USD de la mente (`orquestador`). Quedan 5 USD de verdad.
2. El usuario abre los chats A y B y escribe en los dos. Cada sesión nace con `maxBudgetUsd = 20 − 10 − 5 = 5`, y cada
   una puede gastar 5 USD.
3. Al mismo tiempo, la flota arranca una tarea Claude. El adaptador calcula `20 − 10 = 10` USD de saldo
   (`adapter.ts:334`). Su tope real es el de la tarea (1/3/8 USD), o 10 USD si no hay tope de tarea.
4. Total posible: 15 + 5 + 5 + 8 = 33 USD contra un presupuesto de 20. Mientras tanto, el panel muestra el cupo de Claude
   como `20 − 10 = 10` USD (50 %), sin los 5 USD de la mente. La mente lee lo mismo con `cupos()` y en su prompt.

**Evidencia en la instalación real** (copia de solo lectura de `%LOCALAPPDATA%\orquestador\orquestador.db` con su WAL,
2026-11-05 18:46Z): `usage` suma 35,38 USD de `claude` y 62,60 USD de `orquestador` (52,60 del 4 y 9,99 del 5; una
parte está inflada por `uso-real-02`). La última foto de cupo de `claude` (18:46:38Z) informa
`remainingUnits.amount = 59.964,62`, que es exactamente `60.000 − 35,38`. Con la mente descontada serían 59.902,02: el
panel y `cupos()` ignoran el 64 % de lo gastado con esa clave. Hoy no molesta porque `budgetUsd` vale 60.000 (ver
`autoeval-gasto-01`). Pero en cuanto el usuario baje el presupuesto a algo que de verdad lo proteja, el tope dejará de
cumplirse.

**Pruebas.** `tests/core/chat/f5-chat.test.ts:96-97` solo comprueba `maxBudgetUsd = 2` con nada gastado.
`tests/integration/compose.test.ts:78` afirma `spentUsd() = 0` en el adaptador armado por `compose`, también sin gasto.
`tests/core/adapters/claude-sdk/adapter.test.ts:174-177` prueba el adaptador con un `spentUsd` inyectado a mano, así que
no ve el cableado. No hay ninguna prueba con dos chats a la vez, con gasto previo de la mente visto desde la flota, ni
con el cupo del panel.

## Por qué pasa

El presupuesto es del agente (de su clave), pero el gasto de la mente se guarda con otro `agent_id`. Solo la mente
recuerda sumarlo. El adaptador de la flota y `ManualBudgetQuota` reciben la misma función `spentUsd(agentId)` de
`compose.ts`, que no sabe que la mente gasta con esa clave. Además, el saldo se reparte como una foto: cada proceso del SDK
recibe el saldo del momento en que nació. No hay nada en Berland que lleve la cuenta de lo que gastan en vivo varias
sesiones a la vez.

## Solución posible

1. **Una sola cuenta de lo gastado con la clave** (`src/core/app/compose.ts:124`). Reemplazar `spentFn` por una función
   `billedSpentUsd(agentId)` que sume `store.spentUsd(agentId)` más `store.spentUsd('orquestador')` cuando ese agente es
   la mente, y usarla en tres lugares: el adaptador de la flota (`adapters.ts:67`), `createQuotaProviderFactory`
   (`quotas.ts:40`) y `budgetLeftUsd` (`f5-chat.ts:103`, `conductor.ts:160`). Para saber qué agente es la mente,
   alcanza con `resolveMind(settings, agents)`, que hoy vive en `chat/service.ts:199`. Ojo: lanza `ChatError` si no hay
   mente configurada. En ese caso se cuenta solo el gasto del agente, y conviene moverla a un módulo común para que
   `compose.ts` no dependa de `chat/`. Si cambió de mente en el tiempo, puede calcularse por chat con
   `chat_chats.mind_agent_id`.
2. **Saldo en vivo compartido** (nuevo `src/core/quota/ledger.ts`, o dentro de `ChatService`). Un registro en memoria
   de lo que lleva gastado cada proceso vivo desde su último `usage` guardado: las sesiones de la mente y las ejecuciones
   Claude de la flota. Con él, `saldo = budget − registrado − en curso de los demás`.
   - En `ChatService.send`, comprobar el saldo en **cada** envío, no solo al crear la sesión (`service.ts:695`).
   - En `#read`, si el saldo llega a 0, interrumpir el turno y avisar.
   - En `adapter.ts:418`, el corte en curso (`tr.spentUsd > cap`) pasa a mirar también el saldo compartido.
3. **Mostrar la cuenta.** El bucket del panel (`manual-budget.ts:61-67`) puede detallar «flota X USD · mente Y USD». Así
   el usuario ve en qué se fue el presupuesto.

### Otras opciones

La propuesta no es la única, y puede haber una más simple:

- **Guardar el uso de la mente con el `agent_id` del agente Claude** y distinguirla por `session_id` (`chat-*`). Arregla
  el punto 1 sin tocar `compose.ts`, pero cambia las estadísticas de uso por agente (`usage-stats/summary.ts`) y el
  historial ya guardado.
- **Repartir el saldo entre las sesiones vivas** (cada chat nuevo recibe `saldo / sesiones vivas`). Es fácil, pero
  injusto con el chat que más trabaja y no cubre a la flota.
- **Aceptar que no es común y decirlo.** Renombrar el campo como «presupuesto de la flota» y dejar el de la mente para
  `autoeval-gasto-01`. Es honesto, pero el usuario termina con dos presupuestos sobre la misma clave.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:**
  - `tests/integration/compose.test.ts`, bloque `describe('compose: fábrica de adaptadores')`, junto a la línea 78. El
    fallo está en el cableado de `compose`, no en el adaptador ni en `ManualBudgetQuota` (los dos reciben la función
    hecha), así que la prueba va donde se arma. Con un agente `claude` con `budgetUsd = 20` y eventos `usage` en
    `comp.store` (10 USD de `claude` y 5 USD de `orquestador`, por `appendEvent`):
    - `await claudeOpts?.spentUsd?.()` vale 15 (hoy 10). Con eso el adaptador pasa `maxBudgetUsd = 5`, como ya
      comprueba `adapter.test.ts:174-177`.
    - `await comp.quotaProviderFactory({ config, quotaMethod: 'manual-budget', … }, {})?.read()` informa
      `remainingUnits.amount = 5` y `remainingFraction = 0,25` (hoy 10 y 0,5).
    - Con un `codex` u otro agente que no es la mente, `spentUsd` no suma lo de `orquestador`.
  - `tests/core/chat/service.test.ts`, en `describe('ChatService: mensajes, eventos y costo')`: dos chats con
    `budgetLeftUsd` sobre el registro compartido y saldo de 1 USD. El chat A gasta 0,8 USD en un turno lento (`TurnFn`
    que espera). Afirmar que el chat B, enviado mientras A trabaja, recibe un `maxBudgetUsd` de como mucho 0,2. Cuando A
    termina y quedan 0 USD, afirmar que el siguiente `send` de B falla con `code: 'conflict'` aunque su sesión siga viva.
- **Comando** (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/integration/compose.test.ts tests/core/adapters/claude-sdk/adapter.test.ts tests/core/chat/service.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/integration/compose.test.ts tests/core/adapters/claude-sdk/adapter.test.ts tests/core/chat/service.test.ts`).
- **Verificación manual:** en Ajustes › Agentes, fijar al Claude un presupuesto apenas mayor que lo gastado (por
  ejemplo, gastado + 1 USD). Tener un turno de la mente que gaste unos centavos y mirar el panel de cupos: el saldo de
  Claude debe bajar también por ese turno. Abrir dos chats y escribir en los dos hasta agotar el saldo. Ambos deben
  rechazar el siguiente mensaje con «Presupuesto … agotado», y una tarea Claude nueva de la flota debe fallar con
  «Presupuesto agotado».
