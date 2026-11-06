# La mente no tacha por valor los secretos de sus plugins MCP (token de Canva)

- **Área:** Seguridad y corrección (revisión de Codex)
- **Severidad:** media
- **Archivos:** `src/core/app/f5-chat.ts:77`, `src/core/app/f5-chat.ts:79`, `src/core/app/f5-chat.ts:101`, `src/core/chat/service.ts:699`, `src/core/chat/service.ts:723`, `src/core/chat/service.ts:853`, `src/core/conductor/session.ts:266`, `src/core/conductor/session.ts:272`, `src/core/conductor/session.ts:377`, `src/core/conductor/session.ts:382`, `src/core/conductor/session.ts:453`, `src/core/conductor/session.ts:470`, `src/core/conductor/session.ts:535`, `src/core/adapters/claude-sdk/adapter.ts:307`, `src/core/plugins/mcp.ts:82`
- **Estado:** abierta

## Cómo ocurre
Cuando Canva está conectado para la mente, `PluginService` arma el servidor MCP con el token en un encabezado
(`src/core/plugins/service.ts:342`: `headers: { Authorization: \`Bearer ${token}\` }`). Para la mente,
`mindPlugins.refresh` lo pasa por `claudeMcpOptions` y devuelve solo el entorno, con el valor en
`ORQ_MCP_CANVA_AUTHORIZATION`:

```ts
// src/core/app/f5-chat.ts:77-79
const opts = claudeMcpOptions(await comp.plugins.mcpServersFor(agentId, 'claude-sdk'));
cache.set(agentId, opts);
return opts.env;
```

Ese entorno se mezcla con el de la clave (`f5-chat.ts:101`), `ChatService` lo carga (`chat/service.ts:699`) y lo
entrega tal cual a `ConductorSession` (`chat/service.ts:723`, `env`). La sesión arma el entorno del SDK
(`session.ts:266`) y calcula la lista de valores que tacha solo con las dos variables de Anthropic:

```ts
// src/core/conductor/session.ts:272 y 535-536
this.#secrets = credentialsOf(env);
...
export function credentialsOf(env) {
  return [env.ANTHROPIC_API_KEY, env.ANTHROPIC_AUTH_TOKEN].filter(...);
}
```

Esa lista es la única que usan el traductor de eventos (`session.ts:382`), el segundo tachado de eventos
(`session.ts:470`, `redactDeep(e, secrets)`), el stderr que va al log del núcleo (`session.ts:377`) y la respuesta final
que se guarda en el historial del chat (`session.ts:453`, usado en `chat/service.ts:853`). El almacén vuelve a tachar
(`store/store.ts:236`, `redactDeep(parsed.data)`), pero solo con los patrones genéricos y sin lista de valores.

Los patrones genéricos (`src/shared/redact.ts:6-13`) reconocen claves con prefijo (`sk-ant-`, `ghp_`…), JWT (`eyJ…`)
y valores precedidos por `authorization`, `bearer`, `api_key` o `x-api-key`. Un token opaco que aparezca solo, sin
prefijo ni palabra clave delante, pasa sin tachar.

Pasos para que ocurra:
1. Conectar Canva y asignarlo a la mente, con un token de acceso opaco (no JWT).
2. Que el token aparezca solo en un texto que la mente recibe o emite: el resultado o el error de una herramienta MCP,
   una línea de stderr del proceso del SDK o, en los modos `bypass`/`chat` (con Bash), la salida de un comando que lea
   la variable y le quite el `Bearer ` (por ejemplo, ante una inyección de instrucciones).
3. El texto pasa por el traductor y por `redactDeep` sin el token en la lista. Queda en la tabla `events` de SQLite, se
   difunde por `/ws` y, si la mente lo repite en su respuesta, también queda en el historial del chat. Si sale por
   stderr, queda en el log del núcleo.

Los workers sí cubren este caso. `ClaudeSdkAdapter` suma los secretos MCP a su lista (`adapter.ts:307`:
`const secrets = [...secretsOf(env), ...mcpSecrets(grant.servers)];`), y `mcpSecrets` (`plugins/mcp.ts:82-93`)
incluye el encabezado entero y el token sin `Bearer`. El adaptador de Codex hace lo mismo (`codex-cli/index.ts:171`).
El contrato escrito en `plugins/mcp.ts:6-7` dice que los adaptadores «los tachan de sus eventos (`mcpSecrets`)». La
mente recibe los mismos servidores y no lo hace. Ninguno de los issues de hoy (`docs/plan/issues/01` a `13`) toca esto.

Límite de lo verificado: la omisión está confirmada leyendo el código. No comprobé el formato real del token de Canva.
Si es un JWT, el patrón `eyJ…` lo tacharía igual, y la forma `Bearer <token>` o `AUTHORIZATION=Bearer <token>` también
la tachan los patrones. Por eso la severidad es media: el modelo no tiene el token en su contexto y la fuga necesita que
algo lo imprima solo. Aun así, es una defensa que existe en los workers y falta en la mente.

## Por qué pasa
`credentialsOf` (`session.ts:535-536`) solo conoce `ANTHROPIC_API_KEY` y `ANTHROPIC_AUTH_TOKEN`. Los secretos MCP llegan
a la sesión mezclados en `env` como `ORQ_MCP_*`, sin marcarse como secretos. `mindPlugins.refresh` descarta el mapa
neutro de servidores (con el que se podría calcular `mcpSecrets`) y solo devuelve el entorno. `ConductorSession`
tampoco recibe una lista de secretos aparte.

## Solución posible
Calcular en `ConductorSession` la lista con todo lo que se inyecta como secreto en el entorno:

- `src/core/conductor/session.ts`: que `credentialsOf` sume, además de las dos claves de Anthropic, cada valor de una
  variable `ORQ_MCP_*` y, si tiene la forma `Bearer <token>`, también el token suelto (con `bearerToken` de
  `src/core/plugins/mcp.ts:76`, o con una copia local para no importar `plugins` desde `conductor`). Se mantiene el
  filtro de longitud mínima de 8. Así cubre la mente sin tocar `ChatService` ni `f5-chat.ts`, porque
  `claudeMcpOptions` pone todos los secretos MCP (encabezados y `env` de stdio) bajo `ORQ_MCP_*`.

### Otras opciones
- Transmitir los secretos de forma explícita: que `mindPlugins.refresh` (`f5-chat.ts:74-84`) devuelva también
  `mcpSecrets(servers)` del mapa neutro, que `MindPort` (`chat/service.ts:91`) los exponga y que `ConductorSession` acepte una opción
  `secrets` que se sume a `credentialsOf(env)`. Es más explícito y no depende del prefijo del nombre de la variable,
  pero cambia más firmas (`ChatService`, `ChatWiring`, `ConductorSessionOptions`).
- Tachado central en el almacén: inyectar en el `Store` (o en el hub) un proveedor de valores conocidos, por ejemplo
  `PluginService.knownSecrets()` (`plugins/service.ts:309`), que hoy solo usan las rutas y el estado de los plugins. Así
  cubriría cualquier evento de cualquier agente, incluidos los refresh tokens que la sesión nunca ve. A cambio, no tacha
  el stderr que va al log ni la respuesta antes de difundirla, así que conviene como capa extra y no como reemplazo.
- La propuesta no es la única ni tiene por qué ser la mejor: una función común para «secretos de un entorno de agente»,
  usada por la mente y por los adaptadores, evitaría que las dos listas vuelvan a separarse.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta en `tests/core/conductor/session.test.ts`: armar una `ConductorSession` con un `query`
  doble y `env: { ORQ_MCP_CANVA_AUTHORIZATION: 'Bearer ' + OPACO }`, donde `OPACO` es un token sintético sin prefijo ni
  forma de JWT (p. ej. `'q7Zt' + 'x'.repeat(30)`). Afirmar que:
  - el `secrets` que recibe el traductor (`inits`, como en la prueba de la línea 230) contiene el encabezado entero y
    `OPACO`;
  - `optionsOf(q).stderr?.('fallo ' + OPACO)` llega a `onStderr` sin `OPACO`;
  - `session.redact('token ' + OPACO)` devuelve `'token [REDACTADO]'`;
  - con el doble del SDK emitiendo un mensaje de asistente y un `tool_result` con `OPACO` en el texto, ningún evento de
    `session.events()` lo contiene.
- Prueba de punta a punta en `tests/core/chat/f5-chat.test.ts`: con `chatRouteModule` y un `comp.plugins.mcpServersFor`
  falso que devuelve Canva con `OPACO`, enviar un mensaje con un `query` doble que lo repita en texto, en un resultado
  de herramienta y en el `result` final. Afirmar que no aparece en la tabla `events`, en los mensajes del chat
  (`chat_messages`) ni en el log.
- Comando para correrlas (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/conductor/session.test.ts tests/core/chat/f5-chat.test.ts"`
  (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/core/conductor/session.test.ts tests/core/chat/f5-chat.test.ts`).
- Verificación manual: solo con un MCP de prueba (nunca con la cuenta real de Canva). Conectar un servidor HTTP local
  cuyo token sintético sea opaco y que lo devuelva en el resultado de una herramienta. Pedirle a la mente que use esa
  herramienta y comprobar que el token no se ve en el chat, en el panel de eventos ni en el log del núcleo.
