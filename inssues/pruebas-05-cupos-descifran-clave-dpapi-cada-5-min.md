# La lectura de cupos (cada 5 min) descifra con PowerShell la clave de cada agente aunque su lector no la use

- **Área:** Pruebas y rendimiento
- **Severidad:** baja
- **Archivos:** `src/core/registry/quotas.ts:61`, `src/core/registry/quotas.ts:62`, `src/core/registry/registry.ts:26`, `src/core/registry/registry.ts:266`, `src/core/app/quotas.ts:31`, `src/core/app/quotas.ts:37`, `src/core/app/quotas.ts:39`, `src/core/app/quotas.ts:41`, `src/core/main.ts:68`, `src/core/main.ts:109`, `src/core/config/config.ts:10`, `src/core/vault/vault.ts:90`, `src/core/vault/dpapi.ts:76`, `src/core/app/fleet-service.ts:361`, `src/core/app/conductor.ts:133`
- **Estado:** resuelta

## Cómo ocurre

Contexto. En Windows la bóveda es `FileVault` con el cifrado DPAPI hecho por PowerShell
(`src/core/main.ts:66-68`, que `compose` usa en `src/core/app/compose.ts:123`). Cada `vault.get` toma el candado,
lee `vault.json` y después llama a `cipher.unprotect` (`src/core/vault/vault.ts:90-95`). Ese `unprotect` lanza un
`powershell.exe -NoProfile -EncodedCommand …` nuevo (`src/core/vault/dpapi.ts:68` y `:76`). El propio comentario de la
bóveda lo cifra en «PowerShell, ~0,5 s» (`vault.ts:62`). Ni `FileVault` ni `AgentRegistry` guardan en memoria lo
que ya descifraron (`registry.ts:266-271` va a la bóveda en cada llamada).

Pasos:

1. `iniciar` arranca el núcleo con `comp.deps` (`src/core/app/cli-commands.ts:118`), que trae `quotaProviderFactory`
   (`compose.ts:142`, `:192`). Así se crea el `QuotaRefresher` (`main.ts:89-90`) y un `setInterval` cada
   `config.quotaRefreshMs` (`main.ts:109-117`), que por defecto es de 5 min (`config.ts:10`, `config.ts:105`).
2. `QuotaRefresher.refresh` lee en paralelo todos los agentes habilitados (`registry/quotas.ts:38`, `:45`). Lo
   primero que hace `readOne` con cada uno es descifrar su clave, y recién después le pide el lector a la fábrica:

   ```ts
   // src/core/registry/quotas.ts:61-63
   secrets = await this.opts.registry.secretsFor(agent.config);
   const provider = await this.opts.factory(agent, secrets);
   if (!provider) return undefined;
   ```

3. Todo agente con `secretRef` dispara un `powershell.exe`: los Claude con clave (`claude-sdk` solo se da de alta con
   clave, `registry.ts:165-166`) y los de API (OpenAI, Google, OpenRouter, compatibles).
4. La fábrica elige el método y solo `openrouter-key` usa la clave (`src/core/app/quotas.ts:37-38`). El resto la
   descarta:

   ```ts
   // src/core/app/quotas.ts:39-43
   case 'manual-budget':
     return config.budgetUsd === undefined ? undefined : new ManualBudgetQuota({ agentId, budgetUsd: config.budgetUsd, spentUsd: opts.spentUsd(agentId) });
   case 'response-headers':
   case 'none':
     return undefined;
   ```

   El probe de Claude siempre guarda `manual-budget` (`src/core/adapters/claude-sdk/adapter.ts:243`). El de los agentes
   de API que no son OpenRouter guarda `manual-budget` o `response-headers` (`src/core/adapters/api/adapter.ts:76-79`).
   `ManualBudgetQuota` solo usa `budgetUsd` y el gasto en SQLite, y con `response-headers` o `none` ni siquiera hay
   lector.

Resultado: con el núcleo encendido se lanza, cada 5 minutos, un PowerShell por cada agente habilitado con clave, todos
a la vez, y salvo en OpenRouter ninguno sirve para nada. Además, la clave en claro pasa por la memoria del núcleo sin
necesidad. Y la lectura del presupuesto manual queda atada a la bóveda: si está ocupada por otro proceso
(`vault.ts:125`) o PowerShell no responde en 20 s (`dpapi.ts:69`, `:90-93`), `readOne` corta en `secretsFor`
(`quotas.ts:76-78`), y el cupo de ese Claude no se publica en esa vuelta, aunque no necesitaba la clave para nada.

El mismo patrón aparece en otros dos sitios, que se ejecutan una sola vez y no periódicamente:

- Al armar la flota (`src/core/app/fleet-service.ts:359-363`, una vez por `runtime()`, `fleet-service.ts:300-305`).
  Ahí `loadAdapters` ya descifró cada clave dos veces (`compose.ts:171-172` → `registry.ts:262` y `env.ts:96`). El
  bucle de cupos la descifra una tercera vez.
- En el comando de CLI `conversar` (`src/core/app/conductor.ts:130-137`, al que llama solo `cli-conversar.ts:34`). Ahí
  se hace en serie y uno por agente, antes de abrir la sesión. Las sesiones de la mente en la interfaz no pasan por este
  camino.

## Por qué pasa

La firma `QuotaProviderFactory = (agent, secrets: AgentSecrets) => …` (`src/core/registry/registry.ts:26-29`) exige
que el llamador entregue la clave ya descifrada antes de saber qué método de cupo va a usar el agente. Los tres
llamadores (`registry/quotas.ts:61`, `fleet-service.ts:361`, `conductor.ts:133`) llaman a `secretsFor` de forma
incondicional. Como no existe ninguna caché del valor descifrado, cada llamada se traduce en un proceso de PowerShell.

## Solución posible

Que la fábrica pida la clave solo cuando la necesita:

1. En `src/core/registry/registry.ts:26-29`, cambiar el segundo parámetro de `QuotaProviderFactory` por un getter
   perezoso: `getSecrets: () => Promise<AgentSecrets>`.
2. En `src/core/registry/quotas.ts:56-82` (`readOne`), crear ese getter memorizado sobre
   `this.opts.registry.secretsFor(agent.config)`. Debe guardar la clave si llegó a cargarse, porque `redactDeep` y
   `redactSecrets` siguen necesitándola para tachar (`quotas.ts:74`, `:78`). La llamada a `secretsFor` de la línea 61
   se elimina.
3. En `src/core/app/quotas.ts:37-38`, pasar a `OpenRouterQuota` `getApiKey: async () => (await getSecrets()).apiKey`.
   `OpenRouterQuotaOptions.getApiKey` ya acepta una promesa (`src/core/quota/openrouter.ts:48`, `:165`). Los demás
   métodos no lo llaman.
4. En `fleet-service.ts:361` y `conductor.ts:133`, pasar `() => registry.secretsFor(agent.config)` en lugar del valor.
5. Ajustar `fakeQuotaFactory` (`tests/core/server/helpers.ts:50-63`) para que llame al getter. Así la prueba que ya
   verifica el tachado (`tests/core/registry/registry.test.ts:234-250`) sigue cubriendo ese caso.

### Otras opciones

- Mínima y sin cambiar firmas: en los tres llamadores, calcular antes
  `agent.quotaMethod ?? defaultQuotaMethod(agent.config)` y llamar a `secretsFor` solo si el resultado es
  `openrouter-key`. El problema es que `registry/quotas.ts` tendría que importar `defaultQuotaMethod` desde `app/`,
  o recibirlo como opción, y la regla de qué método necesita la clave quedaría repartida en dos sitios. Con el getter
  perezoso esa regla vive solo dentro de la fábrica.
- Caché en memoria de las claves descifradas, por ejemplo reusando `AgentEnvironment` (`src/core/app/env.ts:74-140`,
  que ya guarda las claves de Claude y de API para `envFor`, invalida al cambiar el tipo, la `secretRef` o la URL, y
  tiene `forget`). Así también desaparecerían la segunda y la tercera descifrada al armar la flota. Pero mantiene más
  claves en claro en memoria por más tiempo, y obliga a invalidar la caché al rotar una clave
  (`registry.update`/`delete`). Puede sumarse a la propuesta, pero no la reemplaza: el sondeo de cupos no debería
  tocar la bóveda cuando el método no usa la clave.
- Si de todas formas se quiere descifrar, un único proceso de PowerShell que descifre varias entradas en una sola
  llamada bajaría el costo de N procesos a 1. Requiere cambiar el protocolo de `dpapi.ts` y no hace falta para este
  caso.

La propuesta no es la única forma de resolverlo. Es la más localizada: toca una firma y tres llamadores, y en el caso
normal deja la bóveda fuera de la lectura de cupos.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta: un archivo nuevo, `tests/core/app/quotas.test.ts`, que use la fábrica real
  `createQuotaProviderFactory` con un `spentUsd` falso y un `fetch` falso para OpenRouter, más un `AgentRegistry` sobre
  `SqliteStore(':memory:')` y `MemoryVault`, con `vi.spyOn(vault, 'get')`. El escenario arma estos agentes
  habilitados, todos con `secretRef` y su clave en la bóveda, salvo el de Codex:
  - un `claude-sdk` con `budgetUsd` y `quotaMethod: 'manual-budget'`;
  - un `api` de OpenAI con `quotaMethod: 'response-headers'`;
  - un `api` de OpenRouter con `quotaMethod: 'openrouter-key'`;
  - un `codex-cli` sin clave.

  Se llama a `vault.get.mockClear()` y luego a `new QuotaRefresher({ registry, factory, publish }).refresh()`. La prueba
  afirma que `vault.get` se llamó exactamente una vez, con la `secretRef` del agente de OpenRouter, y que el `fetch`
  falso recibió `Authorization: Bearer <clave>`. También afirma que la foto del agente `manual-budget` se publicó
  aunque su `secretRef` falte en la bóveda (borrarla antes con `vault.delete`). Hoy esa foto termina en
  `errors` con «Falta la clave del agente …» (`registry.ts:269`). Se mantiene
  `tests/core/registry/registry.test.ts:234-250`, que verifica que el mensaje de error no contiene la clave.
- Comando (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/app/quotas.test.ts tests/core/registry/registry.test.ts"`
  (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/core/app/quotas.test.ts tests/core/registry/registry.test.ts`).
- Verificación manual: en una instancia de prueba (otra carpeta de datos con `ORQ_DATA_DIR` y otro puerto, sin tocar
  el Berland que ya corre), con `ORQ_QUOTA_REFRESH_MS=10000` y un Claude con clave y presupuesto, contar durante un
  minuto las líneas `vault get <ref>` del registro del núcleo (`vault.ts:94`) o los `powershell.exe` hijos en Process
  Monitor. Antes del arreglo sale una por agente con clave cada 10 s. Después, solo las de OpenRouter, y la tarjeta
  de cupo del Claude sigue mostrando su presupuesto.
