# La flota ya armada no ve los cambios de agentes (deshabilitar, agregar, detectar, cambiar la clave o borrar) hasta reiniciar el núcleo

- **Área:** Servidor, API y contratos
- **Severidad:** media
- **Archivos:** `src/core/app/fleet-service.ts:299`, `src/core/app/fleet-service.ts:300-306`, `src/core/app/fleet-service.ts:356-364`, `src/core/app/compose.ts:165-180`, `src/core/orchestrator/router.ts:92`, `src/core/orchestrator/router.ts:277-289`, `src/core/orchestrator/supervisor.ts:178`, `src/core/orchestrator/supervisor.ts:285`, `src/core/app/env.ts:112-124`, `src/core/server/app.ts:261-341`
- **Estado:** abierta

## Cómo ocurre

`FleetService` arma la flota (Router, Supervisor con sus adaptadores, Fleet y FleetRuntime) **una sola vez**, la
primera vez que alguien pide el puerto: al aprobar una tarea (`hooks().onApproved`, `fleet-service.ts:322`), al
delegar desde la mente (`f5-chat.ts:49`) o al reintentar (`fleet-service.ts:227`). La promesa queda memorizada y
nunca se invalida:

```ts
// src/core/app/fleet-service.ts:299-306
/** Arma la flota (una sola vez). Agentes agregados después requieren `reset()`. */
runtime(): Promise<{ fleet: Fleet; port: FleetRuntime; router: Router }> {
  this.#runtime ??= this.#build().catch(...);
  return this.#runtime;
}
```

El comentario habla de `reset()`, pero ese método no existe en `FleetService` ni en ningún otro lado del núcleo.

`#build()` toma una foto de los agentes habilitados en ese momento:

- `compose.ts:166`: `registry.list().filter((a) => a.config.enabled)`; para cada uno crea el adaptador con la clave
  de ese momento (`compose.ts:171`) y la carga en `AgentEnvironment` (`compose.ts:172`).
- `fleet-service.ts:364`: `new Router({ agents: adapters.map((a) => a.config), ... })`. El Router copia esa lista a un
  `Map` de solo lectura (`router.ts:92`) y no tiene ningún método para cambiarla.
- `supervisor.ts:178`: el Supervisor guarda los adaptadores en otro `Map` fijo.
- `fleet-service.ts:360-363`: los proveedores de cupo se crean solo para los agentes habilitados en ese momento.

`registry.list()` y `registry.update()` leen y escriben SQLite y devuelven objetos nuevos (`registry.ts:148-150`,
`:173-184`), así que la configuración que guarda el Router es una copia que no cambia. Las rutas de agentes
(`app.ts:261-341`) solo escriben en el registro y difunden por el hub (`hub.publishAgent`, `hub.publishAgentDeleted`).
Nunca avisan a la flota. Lo único que sí se relee en caliente son los ajustes (`f5-servidor.ts:300-301`, `useSettings`
y `settingsChanged`), y eso solo cambia la concurrencia, los `workers` y el `quotaFloor` global.

Pasos (todos después de que la primera tarea armó la flota):

1. **Deshabilitar no detiene al agente.** `PATCH /agents/codex { "enabled": false }` responde 200 y la interfaz lo
   muestra deshabilitado. El Router sigue mirando su copia con `enabled: true`:
   ```ts
   // src/core/orchestrator/router.ts:277-279
   #usable(agentId, exclude, onlyWorkers = true) {
     const a = this.#agents.get(agentId);
     if (a === undefined || a.enabled === false || ...) return false;
   ```
   La siguiente tarea apta para Codex se le asigna igual, y también la revisión (`chooseReviewer` usa el mismo `Map`).
   Con un `quotaFloor` propio del agente pasa lo mismo: el Router sigue aplicando el valor viejo.
   Al revés tampoco funciona: un agente que estaba deshabilitado al armar la flota no tiene adaptador
   (`compose.ts:166`), y volver a habilitarlo no sirve hasta reiniciar.
2. **Un agente agregado o detectado no existe para la flota.** `POST /agents` o `POST /agents/detect`
   (`app.ts:279-302`) lo guardan, pero el Router no lo conoce. Si se aprueba con `agentId` igual a ese agente, `route`
   lo descarta con el aviso «El agente sugerido X no está disponible» (`router.ts:155-160`) y la tarea va a otro.
   Si además en Ajustes se elige solo ese agente como subagente (`workers: ['X']`), `#workers()` quita los ids que no
   conoce y, como la lista queda vacía, **levanta la restricción**:
   ```ts
   // src/core/orchestrator/router.ts:285-288
   #workers() {
     const known = (this.#settings?.()?.workers ?? []).filter((id) => this.#agents.has(id));
     return known.length > 0 ? new Set(known) : undefined;
   }
   ```
   Así, la tarea puede ir a cualquier agente habilitado, justo lo contrario de lo que pidió el usuario.
3. **Cambiar la clave de Claude rompe todas sus tareas.** `addAgentFromKey` no reemplaza un id existente
   (`registry.ts:205`, conflicto 409), así que para cambiar la clave hay que hacer `DELETE /agents/claude` y luego
   `POST /agents` con el mismo id. El agente nuevo tiene otro `secretRef`, porque se genera al azar
   (`registry.ts:213`). La flota conserva el adaptador viejo y, en cada intento, el Supervisor pide el entorno
   (`supervisor.ts:285`). `envFor` compara el `secretRef` en caché con el vigente, no coinciden y lanza:
   ```ts
   // src/core/app/env.ts:116-121
   if (c && c.kind === cached.kind && c.secretRef === cached.secretRef && c.baseUrl === cached.baseUrl) return cached.env;
   this.#cache.delete(agentId);
   ...
   throw new AgentEnvError(`La clave del agente ${agentId} no está cargada o el agente cambió (llama a load antes de ejecutar)`);
   ```
   `execute` captura el error y la tarea termina `failed` (`supervisor.ts:272-273`). Nadie vuelve a llamar a
   `env.load`, porque eso solo ocurre en `loadAdapters` al armar la flota. Todas las tareas que vayan a Claude, que es
   también el destino de la dificultad alta y de los rescates, fallan hasta reiniciar el núcleo. Lo mismo pasa con
   `PATCH /agents/claude { "baseUrl": ... }`, porque `envFor` también compara `baseUrl`.
4. **Borrar un agente no lo saca de la flota.** Después de `DELETE /agents/codex`, el Router y el Supervisor lo
   siguen teniendo. Para un CLI, `envFor` devuelve el entorno vacío (`env.ts:120-123`: sin agente no lanza) y la tarea
   corre igual con un agente que ya no aparece en Ajustes.

Ninguna prueba cubre esto. `tests/core/f5-servidor/router-settings.test.ts` solo prueba cambios de `/settings`, y los
issues 1 a 13 de `docs/plan/issues` no tocan este flujo.

## Por qué pasa

`FleetService.runtime()` memoriza la flota y no la invalida nunca (`fleet-service.ts:300-306`). Además, ni el Router
(`router.ts:76`, `:92`) ni el Supervisor (`supervisor.ts:162`, `:178`) permiten cambiar sus agentes o adaptadores
después de construirse. Las rutas `POST/PATCH/DELETE /agents` y `/agents/detect` (`app.ts:261-341`) no tienen ningún
gancho hacia la flota, y `TaskHooks` no tiene un evento de «cambiaron los agentes». La flota tampoco escucha al
registro.

## Solución posible

Actualizar la flota en caliente sin rearmarla. Rearmarla no conviene: la mente guarda el `FleetRuntime` que recibió
(`conductor.ts:157`), y la carga y los arriendos del Router se perderían con tareas en curso.

1. `src/core/orchestrator/router.ts`: agregar `setAgents(configs: AgentConfig[])`, que reemplace el contenido de
   `#agents` y `#order` y conserve `#load`, `#lastAssigned` y `#exhaustedAt` por id. Agregar también
   `setQuotaProvider(agentId, provider | undefined)`, que invalide `#quotaCache` de ese agente. Un agente que se va con
   arriendos abiertos sigue liberándose bien, porque `release` no mira `#agents`.
2. `src/core/orchestrator/supervisor.ts`: agregar `setAdapter(adapter)` y `removeAdapter(agentId)` sobre `#adapters`.
   Un intento en curso ya tiene su adaptador en una variable local (`supervisor.ts:284`), así que no le afecta.
3. `src/core/app/fleet-service.ts`: agregar `agentsChanged(): Promise<void>`. Si la flota no está armada, no hace nada,
   porque la próxima `#build()` ya lee lo vigente. Si está armada, para cada agente del registro:
   - si está habilitado y es nuevo, o cambió `kind`, `secretRef`, `baseUrl` o `model`: `registry.createAdapter(id)`,
     `env.load(id)` y `supervisor.setAdapter(...)`;
   - si está deshabilitado o fue borrado: `supervisor.removeAdapter(id)`;
   - al final, `router.setAgents(...)` con las configuraciones de los adaptadores vigentes, y un proveedor de cupo nuevo
     para los agentes que se sumaron.

   Los errores se registran con `redactSecrets`, igual que en `loadAdapters`. Para esto, `FleetDeps` necesita
   `env.load`, o un `loadAdapters(ids)` que ya existe con ese parámetro (`compose.ts:165`). Hay que borrar el comentario
   sobre `reset()`.
4. `src/core/server/app.ts`: llamar al gancho después de `POST /agents`, `/agents/detect`, `PATCH /agents/:id` y
   `DELETE /agents/:id`. Se puede sumar como `agentsChanged?: () => void | Promise<void>` en `TaskHooks`, que
   `FleetService.hooks()` ya entrega al servidor (`compose.ts:198`). Así el servidor no depende de la flota.

### Otras opciones

- Que el Router reciba `agents: () => AgentConfig[]` y lea el registro en cada decisión, igual que ya hace con
  `settings`. `enabled` y `quotaFloor` quedarían siempre al día sin ganchos. Igual hay que resolver los adaptadores
  nuevos y la clave, con una caché de adaptadores por id que se invalide por `secretRef`, `baseUrl` o `kind`. Es más
  simple de razonar, pero lee SQLite en cada decisión.
- Un oyente en `AgentRegistry` (`onChange`) en vez de un gancho en el servidor. Cubriría también los cambios que no
  pasan por HTTP, como la CLI o un `probe`, y evitaría olvidar una ruta.
- Rearmar la flota completa cuando no hay tareas vivas (`LIVE_STATES` vacío y `fleet.inFlight()` vacío, la misma
  comprobación de `fleet-service.ts:255`), y, si hay tareas, solo marcar «pendiente de rearmar». Es más corto, pero hay
  que arreglar la referencia que guarda la mente y los arriendos del Router.
- Como mínimo, mientras tanto: avisar en la respuesta de las rutas y en Ajustes que el cambio se aplica al reiniciar el
  núcleo. Y en `#workers()` no levantar la restricción cuando los ids elegidos son desconocidos: fallar con un aviso
  claro en vez de repartir a todos.

La propuesta no es la única: la variante «Router lee el registro en cada decisión + caché de adaptadores por
`secretRef`» puede salir más corta y más robusta si se acepta el costo de leer SQLite en cada decisión.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta: `tests/core/f5-servidor/flota-agentes-en-caliente.test.ts`. Usa el mismo armado del
  caso «compose + f5Servidor» de `tests/core/f5-servidor/router-settings.test.ts:158-200`: `compose` con
  `MemoryVault`, `constructors` falsos que anotan qué agente corre, un repo git temporal y `startCore`. Escenarios:
  1. Se aprueba una tarea (arma la flota). Luego `PATCH /agents/codex { enabled: false }` y se aprueba otra con
     `agentId: 'codex'`: afirmar que la corre otro agente y que `codex` no aparece en las ejecuciones anotadas.
  2. Después de armar la flota, `POST /agents` (CLI `codex2`) y `PATCH /settings { workers: ['codex2'] }`: la
     siguiente tarea la corre `codex2`, no Claude ni `codex`.
  3. Después de armar la flota, `DELETE /agents/claude` y `POST /agents` con una clave nueva y el mismo id: la
     siguiente tarea de dificultad alta termina bien (sin `AgentEnvError`), y el `ctx.env` que recibe el constructor
     falso trae la clave nueva. Comparar contra la clave de la prueba, sin imprimirla.
  4. `DELETE /agents/codex`: la siguiente tarea no la recibe `codex`.
  Además, una prueba unitaria en `tests/core/orchestrator/` para `Router.setAgents` (la carga de un agente arrendado se
  conserva y `release` no falla si el agente ya no está) y para `Supervisor.setAdapter`/`removeAdapter`.
- Comando para correrla (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/f5-servidor/flota-agentes-en-caliente.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/f5-servidor/flota-agentes-en-caliente.test.ts`).
- Verificación manual en la app: aprobar una tarea cualquiera. En Ajustes › Agentes, deshabilitar Codex y aprobar otra
  tarea fijada a Codex: en el panel derecho debe verse que la toma otro agente. Luego borrar y volver a agregar Claude
  con otra clave y aprobar una tarea de dificultad alta: debe terminar bien sin reiniciar Berland.
