# Las sesiones de los subagentes de la mente quedan «running» para siempre y su cancelación cae en sesiones duplicadas `task-*`

- **Área:** Evidencia de uso real
- **Severidad:** baja
- **Archivos:** `src/core/app/fleet-service.ts:258`, `src/core/store/store.ts:520`, `src/core/store/store.ts:524`, `src/core/store/store.ts:561`, `src/core/store/store.ts:562`, `src/core/adapters/claude-sdk/translate.ts:168`, `src/core/adapters/claude-sdk/translate.ts:333`, `src/core/adapters/claude-sdk/translate.ts:512`, `src/core/adapters/claude-sdk/translate.ts:519`, `src/core/conductor/session.ts:382`, `src/core/chat/service.ts:738`, `src/core/chat/service.ts:762`, `src/ui/features/agents-panel/AgentsPanel.tsx:58`, `src/ui/features/agents-panel/AgentsPanel.tsx:73`
- **Estado:** abierta

## Cómo ocurre

Cuando la mente (agente `orquestador`) lanza subagentes, el traductor del SDK abre una sesión por subagente en la tabla
`sessions`. El id es el `tool_use_id` de la llamada `Agent` (`toolu_…`) y el padre es la sesión del chat (`chat-…`). La
sesión hija se cierra solo con el `status` terminal que genera el `task_notification` del SDK. Al morir el proceso del
SDK nadie la cierra: ni el chat ni el arranque del núcleo.

### Evidencia real

Datos tomados de una copia de solo lectura de `%LOCALAPPDATA%\orquestador\orquestador.db` del 2026-11-05.

- Seis sesiones hijas del chat `chat-ec3e1f2b…` siguen en `running` con `ended_at` nulo:
  - `toolu_bdrk_01FXwV…`, `toolu_bdrk_018CFY…` y `toolu_bdrk_0153ny…` empezaron a las 00:20:41Z. Su último evento es de
    las 00:33:47–00:33:55Z.
  - `toolu_bdrk_014g5Q…`, `toolu_bdrk_012joi…` y `toolu_bdrk_01H2Ev…` empezaron a las 01:22:38Z. Su último evento es de
    las 01:37:18–01:37:35Z.
- A las 00:33:55.994Z hubo un turno nuevo («pensando», `service.ts:472`) que creó otro proceso del SDK reanudado. Ese
  proceso avisó que los tres primeros no terminaron: `status cancelled` con el texto
  `Background agent "<descripción>" didn't finish before the previous session ended`. Los tres avisos llegaron
  **en sesiones nuevas**: `task-ae2bd0d43de8cec45`, `task-a2138a1e69a3c6035` y `task-acdbdf487053f01c5`. Las
  `toolu_…` originales siguieron en `running`.
- El núcleo se reinició después a las 00:37:58, 02:20:21, 02:29:53, 02:31:11, 02:46:01, 04:29:28, 14:27:07 y
  14:28:57 (`logs/nucleo-escritorio.log`). Los dos últimos reinicios ya corren con el arreglo del issue 7 (commit
  `81012d6`). Ninguno cerró esas seis sesiones. El único que cerró sesiones fue el de las 02:20, y solo de workers
  («4 sesión(es) de agentes abiertas al reiniciar quedan canceladas»).
- Además, la sesión principal `chat-faf636ea…` figura `running` con `ended_at = 01:36:01.910Z`, una contradicción.

Los dos disparadores concretos de la evidencia fueron:

1. A las 00:33 se recreó el proceso con subagentes vivos.
2. A las 01:37:5x, justo 15 min (`CHAT_IDLE_MS`, `service.ts:70`) después del último evento de la mente (01:22:51), el
   plazo de inactividad cerró el proceso.

Los dos ocurrieron con código anterior a `81012d6`, que hoy los impide (`service.ts:680-690` y `service.ts:892`). Aun
así, el defecto sigue en el código actual por tres caminos.

### 1. El arranque del núcleo no cierra las sesiones hijas de la mente

```ts
// src/core/app/fleet-service.ts:258
const closed = store.cancelOpenSessions({ exceptAgents: [CONDUCTOR_AGENT_ID] });
```

```ts
// src/core/store/store.ts:521-525
const notIn = except.length ? ` AND agent_id NOT IN (${except.map(() => '?').join(', ')})` : '';
... `UPDATE sessions SET state = 'cancelled', ... WHERE state IN ('starting', 'running', 'waiting')${notIn}`
```

La excepción quiere proteger la sesión principal de cada chat, que se reutiliza (`store.ts:517-518`). Pero filtra por
`agent_id`, y los subagentes también son del agente `orquestador`, así que quedan excluidos. Un `toolu_…` no se reanuda
nunca: el proceso nuevo no vuelve a emitir eventos con ese id. `ChatService` tampoco lo arregla al arrancar.
`resetRunning` (`service.ts:256` → `chat/db.ts:230-232`) solo toca `chat_chats`. Las seis sesiones de arriba ya no se
cierran con ningún reinicio.

### 2. Cerrar o recrear el proceso de la mente olvida las hijas en la tienda

`#dropSession` (`service.ts:762-776`) mata el proceso y vacía `live.background` solo en memoria:

```ts
// src/core/chat/service.ts:766-769
if (live.background.size) {
  live.background.clear();
  this.#publishLive(chatId);
}
```

Lo mismo hace `#ensureSession` al crear un proceso nuevo (`service.ts:738-742`, «Los subagentes de un proceso anterior
ya no existen»). Ninguno emite un `status` terminal para esas sesiones, así que siguen `running` en `sessions`. Con el
código actual eso pasa en estos casos:

- `close(chatId)` (`service.ts:359-366`);
- `delete` (`:370-376`);
- `shutdown` del núcleo (`:563-568`);
- el plazo de gracia de `interrupt` (`:509`);
- la caída del proceso, que ya describe `inssues/mente-06-subagentes-fantasma-tras-fin-de-sesion.md` para el contador
  en memoria.

En todos ellos puede haber subagentes en segundo plano.

### 3. El aviso de cancelación del proceso reanudado abre una sesión `task-*`

Cada `ConductorSession` crea su propio traductor (`conductor/session.ts:382`, una instancia por proceso del SDK). El mapa
`task_id → sesión` vive en esa instancia:

```ts
// src/core/adapters/claude-sdk/translate.ts:168
readonly #taskSession = new Map<string, string>();
// translate.ts:332-335
#taskSessionFor(taskId: string, toolUseId: string | undefined) {
  const sessionId = toolUseId ?? this.#taskSession.get(taskId) ?? `task-${taskId}`;
```

El proceso reanudado avisa de las tareas huérfanas del anterior con un `task_notification` `status: 'stopped'` y
`reason: 'worker_restart'` (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:6149-6151`). `tool_use_id` es
opcional (`:6146`) y en este aviso no vino. `task_updated` tampoco pasa nunca el `tool_use_id` (`translate.ts:512`). El
traductor nuevo no conoce el `task_id`, así que inventa `task-<task_id>` y la cancelación queda en una sesión duplicada.
Las tres `task-*` de la evidencia salen de ahí.

### Efecto visible

`GET /sessions?parentSessionId=chat-…` devuelve las `toolu_…` fantasma como activas. Cada vez que ese chat pasa a
`running` o cambia `backgroundTasks`, `AgentsPanel.tsx:73-74` las pide, las mezcla en `views` y les pide un `replay`
(`AgentsPanel.tsx:57-58`). Su última acción, de hace horas, entra como candidata en `mindRow` (`model.ts:76-78`).
Normalmente pierde frente a eventos más nuevos porque se ordena por `ts`. El daño principal es que la tabla `sessions`
miente: hay subagentes «trabajando» para siempre y cancelaciones registradas en sesiones que no corresponden.

## Por qué pasa

- (a) `cancelOpenSessions` excluye por agente y no por tipo de sesión, así que protege también a las hijas, que nunca
  se retoman (`fleet-service.ts:258`, `store.ts:521-524`).
- (b) `ChatService` da por muertos a los subagentes solo en memoria (`service.ts:738-742`, `:766-769`) y no deja
  constancia en la tienda.
- (c) El mapa `task_id → sesión` es de cada instancia del traductor (`translate.ts:168`). Un aviso sin `tool_use_id`
  sobre una tarea de un proceso anterior cae en el respaldo `task-${taskId}` (`translate.ts:333`).
- (d) Detalle menor: `appendEvent` fija `ended_at` con cada `done` de turno. Un `status running` posterior reabre la
  sesión pero conserva `ended_at` (`store.ts:561-562`: `ended_at = COALESCE(excluded.ended_at, sessions.ended_at)`).
  De ahí sale `chat-faf636ea…` en `running` con `ended_at`.

## Solución posible

1. **`src/core/store/store.ts` (`cancelOpenSessions`).** Que la excepción proteja solo las sesiones raíz. Cambiar el
   filtro por `AND (agent_id NOT IN (…) OR parent_session_id IS NOT NULL)`. Así el arranque (`fleet-service.ts:258`)
   cancela las hijas de la mente y respeta la sesión principal de cada chat. Con eso se cierran también las seis
   fantasma que ya existen, en el próximo reinicio.
2. **`src/core/chat/service.ts`.** En `#dropSession` y en el vaciado de `#ensureSession` (`:738-742`), antes de
   `live.background.clear()`, emitir con `#emit` un `status` `cancelled` por cada id de `live.background`:
   - `sessionId` = el id;
   - `agentId: CONDUCTOR_AGENT_ID`;
   - `parentSessionId` = `chat.sessionId`;
   - detalle «la sesión de la mente se cerró».

   Así la tienda y el panel ven el cierre en el momento. Conviene hacerlo en un helper (`#cancelBackground`) que también
   use el arreglo de `mente-06`.
3. **`src/core/adapters/claude-sdk/translate.ts`.** En `#taskSessionFor`/`#subagentStatus`, si no hay `tool_use_id` y
   el `task_id` es desconocido para esta instancia, no inventar `task-${taskId}` cuando el estado es terminal. En ese
   caso basta con devolver un `raw` en la sesión principal, que no cambia su estado (`store.ts:561`), o nada. Las
   `toolu_…` ya las cierran los puntos 1 y 2. Añadir `reason: z.string().optional()` a `taskNotificationSchema`
   (`schemas.ts:134-142`) para distinguir `worker_restart`.
4. **`src/core/store/store.ts` (`appendEvent`).** Al volver a un estado abierto, limpiar `ended_at`:
   `ended_at = CASE WHEN ? IN ('starting','running','waiting') THEN NULL ELSE COALESCE(excluded.ended_at, sessions.ended_at) END`,
   con `state` como parámetro.

### Otras opciones

- **Mapa compartido entre procesos.** En vez de descartar el aviso (punto 3), `ChatService` guarda en `Live` un
  `Map<task_id, sessionId>` y se lo pasa a cada traductor nuevo, ampliando `TranslatorInit` y la opción `translator` de
  `ConductorSession`. Así el `worker_restart` cierra la `toolu_…` correcta con su motivo real. Sirve dentro de una misma
  vida del núcleo, no tras un reinicio, salvo que el `task_id` se persista, p. ej. en el `detail` o en una columna de
  `sessions`. Es más fiel, pero toca más piezas.
- **Resolver por descripción.** Buscar la descripción citada en el texto del aviso entre las hijas abiertas. Es frágil:
  depende del texto en inglés del CLI y de que no haya dos subagentes con la misma descripción.
- **Cerrar el árbol completo.** Un método de tienda `cancelChildSessions(rootSessionId)` con CTE recursiva cerraría
  también a los nietos, que `live.background` no sigue (`service.ts:825` solo cuenta los hijos directos). Es más
  completo que el punto 2.
- **Filtrar en la interfaz.** Que el panel ignore las hijas cuyo `updatedAt` sea anterior al último `init` del chat.
  Esconde el síntoma, pero la tienda sigue mintiendo.

La propuesta no es la única ni necesariamente la óptima. Los puntos 1 y 2 bastan para que no queden fantasmas. El 3 y
el 4 son limpieza de datos y se pueden priorizar aparte.

## Cómo probar que quedó resuelta

- Pruebas automatizadas propuestas:
  - `tests/core/store/task-detail.test.ts`, junto a la prueba de `cancelOpenSessions` (`:85-97`):
    - Arma una sesión `chat-1` (`orquestador`, sin padre) en `running` y una hija `toolu_x` (`orquestador`,
      `parentSessionId: 'chat-1'`) en `running`, más una de `codex`.
    - Afirma que `cancelOpenSessions({ exceptAgents: ['orquestador'] })` devuelve 2, que `toolu_x` queda `cancelled`
      con `endedAt` y que `chat-1` sigue `running`.
    - Otro caso: `done` y luego `status running` sobre la misma sesión. Afirma `endedAt === null`.
  - `tests/core/chat/background.test.ts`, con `injectableQuery` y `launchScript`:
    - `send('investiga')` y `settle`. Comprueba `backgroundTasks === 1`.
    - Luego `b.service.close(chat.id)`. Afirma `b.store.getSession('tu1')?.state === 'cancelled'`.
    - Reabre con `send('hola')`, con un guion para el proceso 2 que emita, antes del `init`, un `task_notification`
      `{ task_id: 't1', status: 'stopped', reason: 'worker_restart', summary: '…' }` sin `tool_use_id`.
    - Afirma que `b.store.getSession('task-t1')` es `undefined` y que
      `b.store.listSessions({ parentSessionId: chat.sessionId })` no tiene ninguna en `starting`, `running` ni
      `waiting`.
  - `tests/core/adapters/claude-sdk/translate.test.ts`: con un traductor nuevo, un `task_notification` sin
    `tool_use_id` para un `task_id` desconocido y `status: 'stopped'` no produce eventos con `sessionId` `task-…`.
- Comando para correrlas (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/store/task-detail.test.ts tests/core/chat/background.test.ts tests/core/adapters/claude-sdk/translate.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/store/task-detail.test.ts tests/core/chat/background.test.ts tests/core/adapters/claude-sdk/translate.test.ts`).
- Verificación manual en la app:
  1. Pedirle a la mente una investigación con subagentes en segundo plano y cerrar el chat (o reiniciar Berland)
     mientras trabajan.
  2. Sobre una copia de la base, en solo lectura, correr
     `SELECT count(*) FROM sessions WHERE agent_id='orquestador' AND parent_session_id IS NOT NULL AND state IN ('starting','running','waiting')`.
     Debe dar 0, y no debe aparecer ninguna sesión `task-%` nueva al reabrir el chat.
  3. Tras el primer reinicio con el arreglo, las seis `toolu_…` de la evidencia deben quedar `cancelled`.
