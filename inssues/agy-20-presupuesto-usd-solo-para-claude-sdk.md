# Los agentes por API (OpenAI, Gemini, compatible) piden «define budgetUsd» pero Ajustes › Agentes no deja fijarlo, y aunque se fijara no se descontaría

- **Área:** Interfaz
- **Severidad:** baja
- **Archivos:** `src/ui/features/settings/AgentsSection.tsx:180`, `src/ui/features/settings/AgentsSection.tsx:84`, `src/ui/features/settings/AgentsSection.tsx:140`, `src/ui/features/settings/AddAgentDialog.tsx:68`, `src/core/adapters/api/adapter.ts:76`, `src/core/adapters/api/adapter.ts:125`, `src/core/app/quotas.ts:13`, `src/core/app/defaults.ts:24`, `src/core/registry/registry.ts:81`, `PLAN.md:117`
- **Estado:** resuelta
- **Origen:** revisión de agy, verificada por Claude

## Cómo ocurre
1. En Ajustes › Agentes, «Agregar por clave» con proveedor OpenAI, Google o compatible con OpenAI. El núcleo lo da de alta
   con `kind: 'api'` (`src/core/registry/registry.ts:208`: `kind: v.provider === 'anthropic' ? (v.kind ?? 'claude-sdk') : 'api'`).
2. Al agregarlo, o al pulsar «Probar» en su fila, la interfaz muestra los avisos de la prueba (`AgentsSection.tsx:84` y
   `AgentsSection.tsx:140`). Si el proveedor no mandó cabeceras de límite, el adaptador de API declara cupo por presupuesto
   manual (`src/core/adapters/api/adapter.ts:76-79`: `return this.#sawLimitHeaders ? 'response-headers' : 'manual-budget';`)
   y añade el aviso `'El proveedor no envió cabeceras de límite: el cupo será un presupuesto manual; define budgetUsd.'`
   (`adapter.ts:125-126`). La fila queda con el chip «Con avisos».
3. En la fila no hay dónde definirlo: el campo US$ solo se pinta para Claude por SDK
   (`AgentsSection.tsx:180`: `{config.kind === 'claude-sdk' ? (` … `) : null}` en la línea 199). El diálogo de alta tampoco
   lo pide: `AddAgentDialog.tsx:68-73` manda solo `provider`, `apiKey`, `displayName` y `baseUrl`.
4. El núcleo sí lo aceptaría: `agentPatchSchema` admite `budgetUsd` para cualquier tipo de agente (`registry.ts:81`) y
   `defaultQuotaMethod` usa presupuesto manual para cualquier agente que lo tenga (`src/core/app/quotas.ts:13`). El plan
   lo promete para «Otras APIs»: «Cabeceras de límite si el proveedor las envía … o presupuesto manual» (`PLAN.md:117`).

Corrección a lo que reportó agy: no basta con mostrar el campo. Aunque el presupuesto llegara al núcleo (por la API o el
CLI), para OpenAI, Google y compatibles nunca se descontaría. El costo de la API se estima solo para Anthropic
(`src/core/app/defaults.ts:24`: `estimateCostUsd: (usage, provider) => (provider === 'anthropic' ? anthropicCostUsd(usage) : undefined)`),
y sin estimación `usage.costUsd` queda vacío (`adapter.ts:258-259`). El gasto que descuenta `ManualBudgetQuota` sale de la
suma de `costUsd` en SQLite (`src/core/store/store.ts:665-666`), así que para esos proveedores siempre vale 0 y el cupo
se quedaría al 100 %. OpenRouter no entra en el problema: tiene su propio cupo por `/key` (`adapter.ts:77`, `quotas.ts:12`).
La propuesta de agy de habilitarlo para «todo lo que no sea CLI» tampoco calza: con Anthropic, `kind: 'api'` solo existe
si se pide expresamente, y la interfaz nunca lo pide.

## Por qué pasa
La fila de Ajustes se hizo pensando solo en «tu clave de Claude» (el comentario de `src/shared/agents.ts:31` dice «p. ej.
tu clave de Claude»). El adaptador de API (c6) añadió después el modo `manual-budget` y su aviso, pero la interfaz no se
amplió, y la tabla de precios solo cubre modelos de Anthropic (`src/core/adapters/claude-sdk/pricing.ts`). El resultado:
el núcleo le pide al usuario algo que la interfaz no deja hacer, y que además no funcionaría.

## Solución posible
Hacerlo en dos partes, en este orden, para no mostrar un tope que no topa:
1. **Costo para los proveedores de API.** Ampliar `defaultApiAdapter` (`defaults.ts:24`) con una estimación por
   proveedor y modelo (una tabla de precios como la de `claude-sdk/pricing.ts`, con respaldo por proveedor). Así
   `usage.costUsd` se llena y `store.spentUsd` descuenta.
2. **Campo US$ para los agentes que usan presupuesto manual.** En `AgentsSection.tsx:180`, cambiar la condición a algo
   como `config.kind === 'claude-sdk' || (config.kind === 'api' && config.provider !== 'openrouter')`, o mejor, decidirlo
   por el método de cupo (`agent.quotaMethod === 'manual-budget'` o `'none'`) si `AgentRecord` lo trae. Con eso el aviso
   «define budgetUsd» tiene dónde resolverse. Opcional: un campo «Presupuesto (US$)» en `AddAgentDialog`, que el núcleo
   ya acepta (`registry.ts:61`).

### Otras opciones
Esta propuesta no es la única, y puede haber una más optimizada:
- Si no se quiere mantener una tabla de precios de terceros, cambiar el aviso de `adapter.ts:126` para no pedir
  `budgetUsd` a proveedores sin estimación de costo, y explicar en la fila que el gasto de ese proveedor no se controla
  desde Berland. Es más honesto que mostrar un campo que no descuenta.
- Usar un precio por millón de tokens que el usuario escriba al lado del presupuesto (entrada y salida). Así no hay que
  mantener una tabla, pero hay que añadir campos al esquema del agente (`src/shared/agents.ts`).
- Un tope por tokens en vez de USD para los proveedores sin precio conocido.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta:
  - `tests/ui/settings/agents.test.tsx`: agregar al store un agente `kind: 'api'`, `provider: 'openai'` y comprobar que
    aparece el campo «Presupuesto en USD de …», que al cambiarlo y salir del campo se envía `PATCH /agents/:id` con
    `{ budgetUsd: n }`, y que sigue sin aparecer para Codex, agy y OpenRouter (hoy la prueba de la línea 97 solo mira Codex).
  - `tests/core/adapters/api/run.test.ts` (o una prueba nueva de `defaultApiAdapter`): una respuesta de OpenAI con `usage`
    deja `usage.costUsd > 0`, y con `budgetUsd` fijado `ManualBudgetQuota` informa una fracción restante menor que 1.
- Comando (WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/settings/agents.test.tsx tests/core/adapters/api/run.test.ts"`;
  PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/settings/agents.test.tsx tests/core/adapters/api/run.test.ts`.
- Verificación manual en la app: agregar un agente OpenAI por clave, ver el campo US$ en su fila, fijar 1 USD, mandarle
  una tarea y comprobar en Ajustes › Uso que su gasto sube y que el cupo del agente baja del 100 %. «Probar» ya no debe
  quedarse en «Con avisos» por «define budgetUsd» cuando el presupuesto está puesto.
