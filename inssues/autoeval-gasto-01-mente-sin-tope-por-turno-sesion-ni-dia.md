# La mente no tiene tope de gasto por turno, por sesión ni por día: un turno con subagentes, o una cadena de turnos autónomos, puede gastar hasta el presupuesto total del agente Claude (hoy 60.000 USD)

- **Área:** Mente y chat (gasto)
- **Severidad:** media
- **Archivos:** `src/core/app/f5-chat.ts:103`, `src/core/chat/service.ts:86`, `src/core/chat/service.ts:494`, `src/core/chat/service.ts:695`, `src/core/chat/service.ts:708`, `src/core/chat/service.ts:733`, `src/core/chat/service.ts:794`, `src/core/chat/service.ts:832`, `src/core/chat/service.ts:865`, `src/core/chat/service.ts:892`, `src/core/conductor/session.ts:76`, `src/core/conductor/session.ts:189`, `src/core/conductor/session.ts:247`, `src/core/conductor/session.ts:373`, `src/core/conductor/prompt.ts:17`, `src/core/conductor/prompt.ts:149`, `src/core/conductor/ports.ts:133`, `src/core/adapters/claude-sdk/translate.ts:228`, `src/core/adapters/claude-sdk/translate.ts:406`, `src/core/adapters/claude-sdk/translate.ts:555`, `src/core/app/conductor.ts:36`, `src/core/app/cli-conversar.ts:31`, `src/core/store/store.ts:665`, `src/core/settings/store.ts:134`, `src/shared/api.ts:45`, `src/shared/api.ts:79`, `src/shared/agents.ts:32`, `src/ui/features/settings/AgentsSection.tsx:180`, `src/ui/features/settings/MindSection.tsx`
- **Estado:** resuelta
- **Origen:** autoevaluación de la mente (2026-11-05)
- **Relacionadas:** `uso-real-02` (el gasto de la mente se cuenta dos veces al reanudar), `autoeval-gasto-02` (el presupuesto no es común a la mente, la flota y los chats), `autoeval-gasto-03` (reintentos de la mente sin límite), `mente-06` y `uso-real-06` (subagentes de la mente), `agy-20` (presupuesto de los agentes por API)

## Cómo ocurre

**Contexto.** La mente de cada chat, con o sin proyecto, es una `ConductorSession` del SDK que dura hasta 15 min sin
uso. Su único freno de gasto es el presupuesto total (`budgetUsd`) del agente Claude que la mueve:

```ts
// src/core/app/f5-chat.ts:103-106
budgetLeftUsd: (agentId) => {
  const budget = comp.registry.get(agentId)?.config.budgetUsd;
  return budget === undefined ? undefined : budget - comp.spentUsd(agentId) - comp.spentUsd(CONDUCTOR_AGENT_ID);
},
```

`#ensureSession` lo consulta solo al crear la sesión (`service.ts:695-696`) y lo pasa tal cual como `maxBudgetUsd`
(`service.ts:733`). Si el agente no tiene `budgetUsd`, `left` vale `undefined` y la sesión no lleva ningún tope
(`session.ts:373`). No hay otra cosa:

- `ChatService` nunca pasa `maxTurns` (`service.ts:708-735`). La opción existe (`session.ts:189-191`) y
  `createConductor` la acepta (`src/core/app/conductor.ts:36`), pero su único llamador de producción, la terminal
  (`src/core/app/cli-conversar.ts:34-42`), no la pasa: solo las pruebas. La terminal al menos tiene `--presupuesto`
  por conversación (`cli-conversar.ts:31`); el chat no tiene nada parecido.
- El subagente propio `investigador` no tiene `maxTurns` (`session.ts:76-87`). Los integrados del SDK que la mente
  también usa (`general-purpose`, `Plan`) tampoco: Berland no los define.
- Los ajustes no tienen ningún campo de gasto: `settingsSchema` trae mente, workers, modo, umbral de cupo,
  concurrencia y apariencia (`src/shared/api.ts:45-66`).
- `budgetUsd` no tiene máximo (`src/shared/agents.ts:32`: `z.number().positive().optional()`), y el campo de la
  interfaz dice «sin tope» cuando está vacío (`AgentsSection.tsx:180-197`).
- El uso de la mente llega solo en el `result` de cada turno (`translate.ts:555-561`; `usageEvents` solo se llama ahí)
  y solo suma al costo visible del chat (`service.ts:832-835`). Nada lo compara con un límite. Y como no hay eventos
  `usage` durante el turno, el costo de la cabecera del chat y el de «Uso y gasto» **no se mueven hasta que el turno
  termina**: el usuario no tiene cómo ver que un turno se está disparando para pulsar «Interrumpir».
- El prompt le dice a la mente que Claude va «sin tope de cupo, pero cada token cuesta» (`prompt.ts:17`), y en bypass
  le pide «Persiste: si algo falla, prueba otra vía» (`prompt.ts:149`). De ahí sale el «no tengo cupo» de su
  autoevaluación.

**Turnos autónomos (issue 7).** Cuando termina un subagente en segundo plano, el SDK abre un turno de la mente sin
mensaje del usuario y Berland lo acepta como uno más (`service.ts:794`, `#beginAutonomousTurn` en `:865-872`). Mientras
haya subagentes vivos, la sesión no se cierra por inactividad (`service.ts:892`, dentro de `#scheduleIdle`). Nada
cuenta cuántos turnos autónomos seguidos hubo ni cuánto costaron. El único corte, aparte del `maxBudgetUsd`, es que el
usuario pulse «Interrumpir» (`service.ts:494-512`).

**Pasos.**

1. Abre un chat en cualquier modo (también en plan: el `investigador` y los subagentes integrados están en todos) y
   pide algo amplio: «obtén contexto de todo el proyecto y busca oportunidades de mejora».
2. La mente lanza varios subagentes, en primer plano o en segundo plano. Si son de segundo plano, cierra su turno y
   cada subagente que termina despierta un turno autónomo, en el que la mente puede lanzar más subagentes, delegar o
   reintentar (ver `autoeval-gasto-03`).
3. Nadie mide el gasto del turno ni el de la cadena. La cabecera del chat sigue en el costo anterior hasta el `result`,
   y nada frena el turno hasta llegar a `budgetUsd − gastado`.

**Evidencia en la instalación real** (copia de solo lectura de `%LOCALAPPDATA%\orquestador\orquestador.db` con su WAL,
2026-11-05 15:46):

- El agente `claude` tiene `"budgetUsd":60000`. Con 97,97 USD registrados entre `claude` (35,38) y `orquestador`
  (62,60), cada sesión nueva de la mente recibe `maxBudgetUsd ≈ 59.902 USD`. En la práctica no hay tope.
- El 2026-11-04 la mente registró 52,60 USD (una parte está inflada por `uso-real-02`) y la flota Claude 35,38 USD. El
  2026-11-05 la mente lleva 9,99 USD.
- El chat `faf636ea` tuvo un turno de 47 minutos que costó 10,29 USD. El mensaje del usuario entró en modo **plan**
  (00:48:39Z; la respuesta quedó guardada ya en bypass porque el usuario cambió el modo a mitad del turno). A las
  00:54:43Z la mente lanzó 4 subagentes (tres `Plan` y un `investigador`), y el turno cerró a las 01:36:01Z con
  las filas de `usage` 486 (opus, 1,225 USD) y 487 (sonnet, 21.357.349 tokens de entrada, 9,062 USD). Son los únicos
  eventos `usage` de ese chat y de sus 4 subagentes: durante los 47 minutos la cabecera marcó 0 USD. Ningún mecanismo
  lo habría cortado antes de los 59.902 USD.

## Por qué pasa

El gasto de la mente se pensó con una sola perilla: el presupuesto total del agente Claude, que sirve para toda su vida y
la comparte con la flota. No hay un tope por turno, por sesión ni por día, ni un límite de turnos o de subagentes. Con
una sola perilla el usuario elige entre un tope bajo, que tarde o temprano bloquea todo, y un número enorme que no protege
de nada. En su instalación eligió lo segundo (60.000 USD). La flota sí tiene un tope por tarea (1/3/8 USD,
`DEFAULT_TASK_BUDGET_USD` en `src/core/orchestrator/fleet.ts:42`, issue 6), pero la mente no pasa por ahí. Y como el uso
solo se informa al cerrar el turno, el usuario tampoco puede hacer de freno a mano.

## Solución posible

1. **Ajustes de gasto de la mente** (`src/shared/api.ts`, `settingsSchema` en `:45` y `settingsPatchSchema` en `:79`,
   más `DEFAULT_SETTINGS` y `applySettingsPatch`). Agregar
   `mindLimits = { turnUsd: number | null, dayUsd: number | null, maxAutonomousTurns: number | null }`. Los valores por
   defecto los decide el usuario. Como punto de partida: 5 USD por turno, 50 USD al día y 5 turnos autónomos seguidos.
   `null` quita el tope. **Ojo con la forma:** `SettingsStore` guarda cada clave de primer nivel como una fila y valida
   la fila guardada contra el esquema nuevo (`src/core/settings/store.ts:134-136`). Si los topes van como campo
   obligatorio dentro de `mind` (`mind.limits`), la fila `mind` ya guardada deja de validar y se descarta entera: el
   usuario perdería su mente, modelo y esfuerzo. Por eso conviene una clave nueva de primer nivel (`KEYS` sale de
   `settingsSchema.shape`, `store.ts:10`, así que se registra sola) o un campo `.optional()` con valor por defecto.
2. **Tope diario, antes de crear la sesión y en cada envío** (`src/core/chat/service.ts`). Calcularlo en `ChatService`,
   que ya lee los ajustes: `dayLeft = dayUsd − (spentUsd(mente, hoy) + spentUsd('orquestador', hoy))`, con
   `store.spentUsd(agentId, fromDay)` (`store.ts:665`), que ya filtra por día. Para eso, sumar `'spentUsd'` a
   `ChatStorePort` (`service.ts:86`). `budgetLeftUsd` de `f5-chat.ts:103` sigue dando el saldo de toda la vida, y el
   tope efectivo es el menor de los dos. Comprobarlo también en `send` cuando la sesión sigue viva, no solo al crearla
   (`service.ts:695`): hoy una sesión viva nunca vuelve a mirar el presupuesto.
3. **Tope por turno, en vivo** (`src/core/chat/service.ts`, `#read` y `#emit`). Al abrir un turno (de usuario o
   autónomo), anotar el gasto en curso del traductor. Después de cada mensaje, si `gasto actual − gasto al abrir >
   turnUsd`, llamar a `session.interrupt()`, marcar el turno como cortado por tope y publicar un mensaje claro: «El turno
   llegó a X USD (tope por turno: Y USD). Escribe "sigue" para continuar». Para medir en vivo:
   - exponer en `SdkMessageTranslator` (`src/core/conductor/ports.ts:133`) un `spentUsd` opcional, que
     `ClaudeSdkTranslator` ya calcula (`translate.ts:228-237`) y que se actualiza con cada mensaje del asistente,
     también los de los subagentes, y con `usage_report` (`translate.ts:406-411`);
   - y un getter `spentUsd` en `ConductorSession`, que guarda el traductor en `#translator` (`session.ts:247`):
     `ChatService` hoy no tiene acceso a él.

   Ojo con `uso-real-02`: tras un `resume`, el primer `usage_report` o `result` trae el acumulado restaurado. La base
   del turno debe tomarse del primer valor que informe el proceso, o medirse con `estimatedCostUsd`, que solo cuenta
   mensajes vistos en el stream. De paso, difundir ese gasto en curso con `#publishLive` (`service.ts:596`) para que la
   cabecera no quede congelada hasta el `result`.
4. **Cadena de turnos autónomos** (`#beginAutonomousTurn`, `service.ts:865`). Contar los turnos autónomos seguidos desde
   el último mensaje del usuario y su gasto. Al pasar `maxAutonomousTurns` o `turnUsd`, cerrar la sesión con
   `#dropSession`, que también corta los subagentes vivos (`service.ts:762-776`), y avisar en el chat.
5. **Respaldo en el SDK** (`service.ts:733`). Pasar `maxBudgetUsd = min(left, dayLeft)` y un `maxTurns` alto (por
   ejemplo 200) como red de seguridad. Agregar `maxTurns` al `investigador` (`session.ts:76-87`, por ejemplo 40;
   `AgentDefinition.maxTurns` existe en el SDK).
6. **Prompt** (`prompt.ts:17`). Quitar «sin tope de cupo» y decir en el contexto dinámico los topes vigentes, para que la
   mente planifique con ellos. No es una barrera: solo evita que la mente crea que gasta sin límite.
7. **Interfaz** (`src/ui/features/settings/MindSection.tsx`, la sección «Mente y subagentes» de
   `SettingsView.tsx:20`). Tres campos (US$ por turno, US$ por día y turnos autónomos seguidos) con «sin tope» como
   opción explícita.

### Otras opciones

La propuesta no es la única, y puede haber una mejor:

- **Solo `maxBudgetUsd` por sesión** (un `sessionUsd` en ajustes, como el `--presupuesto` de la terminal). Es lo más
  barato, porque el SDK ya corta solo. Pero el SDK cuenta desde que arrancó el proceso (`sdk.d.ts:5803`: «maxBudgetUsd
  counts only the spend since this query() call started»), y el proceso se recrea cada 15 min sin uso o al cambiar de
  modo. Por eso no sirve como tope diario, y además corta en mitad de una tarea sin aviso propio.
- **Pedir confirmación en vez de cortar.** Al llegar al tope del turno, pausar y mostrar en el chat «¿sigo? lleva X USD».
  Es más amable, pero exige un estado nuevo («esperando permiso de gasto») en el chat y en la interfaz.
- **Tope por cantidad de subagentes** en la guardia (`guard.ts:175`, rama de `Agent`/`Task`): negar más de N subagentes
  vivos a la vez. Corta el caso del «enjambre», pero no el de un solo subagente largo.
- **Topes por modo.** Bypass, que es autónomo, podría tener un tope más bajo que plan o chat. El caso de `faf636ea`
  muestra que plan también gasta fuerte, así que no basta con poner tope solo a bypass.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta** en `tests/core/chat/service.test.ts`, nuevo `describe('ChatService: topes de gasto de
  la mente')`, con `bench` (`tests/core/chat/helpers.ts:153`) y un `optionsOf` como el de
  `tests/core/chat/chat-mode.test.ts:10`:
  1. **Tope diario:** con `dayUsd = 1` en los ajustes del bench y 0,9 USD de `orquestador` registrados hoy en `b.store`
     (un evento `usage`, como hace `seed` en `tests/core/store/store.test.ts`), enviar un mensaje y afirmar que
     `optionsOf(b).maxBudgetUsd` vale 0,1 (±1e-9). Registrar 0,1 más y afirmar que el siguiente `send` falla con
     `code: 'conflict'` y un mensaje que nombra el tope diario, **también con la sesión viva**.
  2. **Tope por turno:** con `turnUsd = 0,05` y un `TurnFn` que emite varios mensajes del asistente cuyo costo estimado
     supera 0,05 antes del `result`, afirmar que la `query` falsa registró `interrupted === 1`, que el chat queda `idle`
     y que el último mensaje del asistente nombra el tope por turno. `sdkText` fija `usage` en 10/5 tokens
     (`helpers.ts:33-36`), así que hay que darle un parámetro de `usage` (por ejemplo `input_tokens: 100_000`).
  3. **Sesión reanudada:** el mismo caso 2 con `resume` y un primer `result` con un acumulado restaurado de 10 USD.
     Afirmar que **no** se interrumpe por ese acumulado.
- En `tests/core/chat/background.test.ts`, con `injectableQuery`: con `maxAutonomousTurns = 2`, inyectar tres turnos
  autónomos seguidos (`taskDone` + `sdkInit` + `sdkText` + `sdkResult`). Afirmar que tras el segundo la sesión se cierra
  (`q.closed === 1`), que `backgroundTasks` queda en `undefined` y que hay un aviso en el historial. Un mensaje del
  usuario reinicia el contador.
- En `tests/core/conductor/session.test.ts`: `CONDUCTOR_SUBAGENTS.investigador.maxTurns` está definido.
- En `tests/core/f5-servidor/settings.test.ts`: una base con la fila `mind` guardada antes del cambio (sin topes) se
  lee con su `agentId`, `model` y `effort` intactos y los topes por defecto.
- **Comando** (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/chat/service.test.ts tests/core/chat/background.test.ts tests/core/conductor/session.test.ts tests/core/f5-servidor/settings.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/chat/service.test.ts tests/core/chat/background.test.ts tests/core/conductor/session.test.ts tests/core/f5-servidor/settings.test.ts`).
- **Verificación manual:** en Ajustes › Mente y subagentes, fijar 0,50 USD por turno. En un chat (en plan o en bypass),
  pedir «lanza tres investigadores que lean todo el repo y resume». El costo de la cabecera debe moverse durante el
  turno, el turno debe cortarse cerca de 0,50 USD con el aviso del tope, y el costo final no debe pasar mucho de ese
  valor. Al escribir «sigue», la mente continúa.
