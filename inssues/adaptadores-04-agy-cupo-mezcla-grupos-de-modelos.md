# El cupo de agy junta los grupos Gemini y Claude/GPT y bloquea al agente por un grupo que no usa

- **Área:** Adaptadores de agentes (cupo de agy y router)
- **Severidad:** media
- **Archivos:** `src/core/quota/agy.ts:55-89`, `src/core/app/quotas.ts:33-34`, `src/shared/quota.ts:27-31`, `src/core/orchestrator/router.ts:248-273`, `src/core/orchestrator/router.ts:305-314`, `src/core/orchestrator/router.ts:320-328`, `src/core/quota/monitor.ts:98-111`, `src/core/adapters/agy-cli/index.ts:217-219`, `fixtures/agy/usage.json`, `fixtures/agy/stream-quota-error.jsonl`
- **Estado:** abierta

## Cómo ocurre

agy no lleva un cupo por cuenta. Lo lleva por **grupo de modelos**. `agy -p /usage --output-format json` devuelve dos grupos independientes, y cada uno tiene su ventana semanal y su ventana de 5 h (`fixtures/agy/usage.json`):

```
"description":"Within each group, models share a weekly limit and a 5-hour limit. ..."
{"name":"Gemini Models","description":"Models within this group: Gemini Flash, Gemini Pro", "buckets":[gemini-weekly, gemini-5h]}
{"name":"Claude and GPT models","description":"Models within this group: Claude Opus, Claude Sonnet, GPT-OSS", "buckets":[3p-weekly, 3p-5h]}
```

El error real de agotamiento también se refiere a un grupo (`fixtures/agy/stream-quota-error.jsonl`, con `init.model` = `gemini-3.8-flash-high`): `"quota exhausted for Gemini Models (5-hour limit)"`.

Berland lanza el worker con un único modelo, el de la configuración del agente (`src/core/adapters/agy-cli/index.ts:217-219`, `args.push('--model', this.config.model)`). Ese modelo consume un solo grupo. Aun así, la decisión de cupo usa los cuatro buckets:

1. `parseAgyUsage` (`src/core/quota/agy.ts:57`) aplana todos los grupos en una sola foto (`groups.flatMap(...)`). Además descarta `group.description`, que es justamente lo que dice qué modelos entran en cada grupo: el esquema lo lee en `agy.ts:18`, pero no lo copia al bucket.
2. La fábrica crea el lector sin el modelo (`src/core/app/quotas.ts:34`): `return new AgyQuotaProvider({ agentId });`. `config.model` existe (`src/shared/agents.ts:26`) pero no llega al lector.
3. `Router.checkQuota` calcula `minRemainingFraction(read.snapshot)` (`src/core/orchestrator/router.ts:261`). Esa función toma el mínimo de **todos** los buckets (`src/shared/quota.ts:28-31`), y el agente solo se permite si ese mínimo llega al piso (`router.ts:273`: `allowed: fraction === null || fraction >= floor`, con piso por defecto de 0,2).
4. `#allowedCli` (`router.ts:305-314`) descarta el agente con «agy descartado: …», y `#rankCli` (`router.ts:326`) también ordena por esa fracción mezclada.
5. `QuotaMonitor.checkAlerts` (`src/core/quota/monitor.ts:98-111`) recorre todos los buckets de la foto y lanza alertas de umbral también para el grupo que el agente no usa.

Pasos concretos:

- El agente agy de Berland trabaja con un modelo Gemini (por ejemplo `gemini-3.8-flash-high`, como en los fixtures).
- El usuario gasta el grupo «Claude and GPT models» desde el IDE de Antigravity, y su ventana de 5 h queda en 0,05.
- `minRemainingFraction` devuelve 0,05, por debajo de 0,2, así que `checkQuota('agy')` da `allowed: false` y el router saca a agy del reparto, aunque Gemini esté al 100 %. Con un agente configurado en `claude-sonnet-*` pasa lo mismo al revés.

Nada lo evita hoy. Las pruebas actuales (`tests/core/orchestrator/router.test.ts:66-71`, que usa `agyFixtureQuota()` de `fakes.ts:203`) solo prueban el fixture con ambos grupos casi al 100 %. Ninguno de los issues de hoy (`docs/plan/issues/01..13`) toca el cupo de agy: el 06 deja agy «sin cambios».

## Por qué pasa

El cupo se modela por agente, con una foto plana y un mínimo global, pero agy lo cobra por grupo de modelos. En la cadena lector → foto → router nadie sabe con qué modelo se lanza el agente, así que el mínimo global cuenta los buckets de un grupo que ese agente nunca gasta.

## Solución posible

1. `src/core/app/quotas.ts:34`: pasar el modelo, `new AgyQuotaProvider({ agentId, ...(config.model ? { model: config.model } : {}) })`.
2. `src/core/quota/agy.ts`: agregar `model?: string` a `AgyQuotaProviderOptions` y a `parseAgyUsage`. Con el modelo, elegir el grupo relevante cruzando el id del modelo con el nombre o la `description` del grupo («Models within this group: …»). Por ejemplo, `/gemini/i` para «Gemini Models» y `/claude|gpt/i` para «Claude and GPT models», o mejor un emparejamiento genérico con las familias listadas en la descripción. Se puede hacer de dos maneras:
   - devolver en la foto solo los buckets de ese grupo (es lo más simple, y router, monitor y conductor siguen funcionando sin cambios), o
   - devolver todos los buckets y marcar los del grupo relevante (ver «Otras opciones»).
3. Si no hay `config.model` o ningún grupo coincide, mantener el comportamiento actual (todos los grupos, que es lo conservador).

### Otras opciones

- **(a) Marcar el grupo relevante sin perder los demás.** Agregar al bucket (`src/shared/quota.ts`) un campo opcional, por ejemplo `relevant: boolean`, o a la foto un `activeGroupId`, y hacer que `minRemainingFraction` (o una variante que usen el router y el monitor) calcule el mínimo solo sobre ese grupo cuando esté marcado. Así la interfaz y la herramienta de cupo de la mente (`src/core/conductor/tools.ts:534-544`) siguen mostrando los dos grupos, y la decisión usa solo el que importa. Probablemente es la opción más completa, aunque toca el contrato compartido.
- **(b) Campo `quotaGroup` en la configuración del agente.** El usuario lo elige en Ajustes. Es explícito y no depende de heurísticas sobre nombres, pero agrega configuración manual y puede quedar desalineado si cambia el modelo.
- **(c) Usar el `init.model` de la última ejecución.** Cuando no hay `config.model`, tomar el modelo que agy informó en el último `init` (`src/core/adapters/agy-cli/translate.ts:175`) para saber qué grupo usa por defecto. Cubre a los agentes sin modelo fijo, pero requiere guardar ese dato fuera del adaptador.

La propuesta no es la única: (a) combinada con (c) evita perder información en la interfaz y cubre el caso sin modelo configurado.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta:
  - `tests/core/quota/agy.test.ts`: con una copia de `fixtures/agy/usage.json` modificada en memoria (grupo «Claude and GPT models» con `remaining_fraction` 0,02 y «Gemini Models» con 1), `parseAgyUsage(raw, 'agy', takenAt, { model: 'gemini-3.8-flash-high' })` (o el filtro nuevo) debe dar una foto con `minRemainingFraction` (o el mínimo del grupo relevante) igual a 1. Con `model: 'claude-sonnet-4-6'` debe dar 0,02. Sin modelo, debe dar 0,02, como hoy.
  - `tests/core/orchestrator/router.test.ts`: armar un `Router` con `agents.claude1` y `agents.agy` y un lector de cupo con esa foto. Con el modelo Gemini, `checkQuota('agy')` debe devolver `allowed: true` y `route(task(...))` debe poder asignar a agy. Con el modelo Claude, `allowed: false` y un aviso «agy descartado».
  - Opcional, `tests/core/quota/monitor.test.ts`: con el modelo Gemini, no debe saltar ninguna alerta por el grupo Claude/GPT.
- Comando para correrla (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/quota/agy.test.ts tests/core/orchestrator/router.test.ts"` (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/core/quota/agy.test.ts tests/core/orchestrator/router.test.ts`).
- Verificación manual en la app: con el agente agy en un modelo Gemini, gastar el grupo Claude/GPT desde Antigravity hasta bajar del piso. En el panel de cupos deben verse los dos grupos, y Berland debe seguir asignando tareas a agy sin el aviso «agy descartado».
