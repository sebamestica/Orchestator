# Plan de implementación — Orquestador casero

Ubicación: `C:\dev\orquestador`. Fecha: 2026-11-01. Lenguaje: TypeScript. Plataforma: escritorio Windows (i7-7700HQ 4 núcleos/8 hilos, 31,9 GB RAM, GTX 1050 4 GB).

## 1. Objetivo

Una app de escritorio donde:

- Conversas con el orquestador (Claude) y le das un plan.
- El orquestador lo divide en tareas y las reparte entre Claude, Codex, agy y las APIs que agregues; cada tarea corre en su propio worktree para que nadie choque.
- Paneles a la derecha muestran, en vivo, qué hace cada agente y cada subagente de Claude.
- Ves los tokens que gastó cada agente y, en Codex y agy, el cupo restante y la hora de reinicio.
- Agregar un agente es pegar su clave de API: la app la prueba, detecta los modelos y mide el cupo cuando el proveedor lo permite.
- Hay un gestor de skills (cargar, revisar, descargar) y una memoria en Obsidian para no repetir contexto y ahorrar tokens.
- Sin login: es local.

Orden pedido: primero el backend, con pruebas que demuestren que las respuestas son correctas; después la interfaz.

## 2. Verificado antes de planificar (2026-11-01)

| Hecho | Cómo se comprobó |
|---|---|
| Codex (Windows, tu ChatGPT) ejecuta tareas sin ventana: `codex exec --json … -` con el encargo por stdin | Prueba real: respondió `CODEX-OK` (modelo `gpt-6.1-sol`) |
| `codex exec --json` emite `thread.started`, `item.completed` y `turn.completed.usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`) | Eventos capturados |
| Cupo de Codex: los registros `~/.codex/sessions/**/*.jsonl` traen `rate_limits.primary` (5 h, `used_percent`, `resets_at`) y `secondary` (semanal) | Leído en un registro real |
| El binario de Codex contiene el método `account/rateLimits/read` | Encontrado en el binario; protocolo sin probar |
| agy (Windows y WSL, tu Google AI Pro) ejecuta sin ventana: `agy -p "<encargo>"`; edita archivos con `--dangerously-skip-permissions` | Pruebas reales: `AGY-OK` y archivo creado |
| `agy --output-format stream-json` emite `init`, `step_update` (`text_delta`, `usage`) y `result` | Eventos capturados |
| Cupo de agy: `agy -p "/usage" --output-format json` devuelve `remaining_fraction` y `reset_time` por grupo (Gemini; «Claude and GPT models») y por ventana (5 h, semanal); no gasta tokens | Prueba real: Gemini 99,96 % semanal, 99,87 % en 5 h |
| agy también ejecuta Claude Opus/Sonnet 4.6 y GPT-OSS con un cupo propio de tu suscripción de Google | `agy models` y `/usage` |
| Tu Claude usa `ANTHROPIC_API_KEY` y `ANTHROPIC_BASE_URL=http://203.0.113.7` (servidor intermedio, HTTP sin cifrar) | `claude auth status` y variables (sin mostrar la clave) |
| Ese servidor responde bien y devuelve `usage`, pero **no** envía cabeceras de límite ni de saldo | Llamada mínima a `/v1/messages` |
| Un worker Claude sin ventana (`claude -p`) funciona con esa clave y reporta el costo (0,103 USD en la prueba) | Prueba real |
| El SDK de agentes de Claude (`@anthropic-ai/claude-agent-sdk` 0.3.316) incluye `parent_tool_use_id`, eventos `task_started`/`task_progress`/`task_updated`/`task_notification`, `total_cost_usd`, `modelUsage`, `includePartialMessages`, `createSdkMcpServer`, `cwd`, `abortController` y `settingSources` | Tipos revisados en el paquete; la forma exacta se confirma en la fase 0 |
| OpenRouter informa el saldo de una clave: `GET /api/v1/key` → `limit_remaining`, `usage_daily`… | Documentación oficial |
| Obsidian: bóveda `C:\Users\SEBASTIAN\OneDrive - Universidad Catolica del Maule\Documentos\Obsidian Vault` (2 notas) | `obsidian.json` |
| Skills: hub `C:\dev\agent-hub\skills` (1 skill, enlazada a todos los agentes por `vincular-skills.ps1`) y skills de proyecto (Vetworld: 25 en `.agents/skills`) | Inspección |

## 3. Arquitectura

```
┌───────────── apps/desktop (Electron + React) ─────────────┐
│ chat con el orquestador · tablero · paneles en vivo ·      │
│ agentes · skills · memoria · ajustes                       │
└──────────────┬─────────────────────────────────────────────┘
               │ HTTP + WebSocket en 127.0.0.1 (token por sesión)
┌──────────────┴──────── packages/core (Node 24, Windows) ───┐
│ API local      Registro de agentes   Bóveda de claves       │
│ Orquestador    Cola de tareas        Router por cupo        │
│ Adaptadores:   claude-sdk · codex-cli · agy-cli · api-*     │
│ Cupos:         agy /usage · codex rateLimits · OpenRouter · │
│                cabeceras · presupuesto manual               │
│ Worktrees + candados (C:\dev\agent-hub\locks)               │
│ Memoria Obsidian · Hub de skills · SQLite (eventos, uso)    │
└─────────────────────────────────────────────────────────────┘
```

- El núcleo es un proceso Node separado de la interfaz, para probarlo solo, sin UI, y para que una caída de la UI no detenga a los agentes.
- Todo corre nativo en Windows, donde Codex y agy ya tienen sesión. Claude corre con tu clave mediante el SDK de agentes.
- Datos en `%LOCALAPPDATA%\orquestador\` (SQLite, registros), fuera del repo.

Estructura del repo:

```
C:\dev\orquestador
  src/shared        tipos y esquemas Zod (agentes, eventos, tareas, cupos) — contratos
  src/core/<módulo> núcleo (adaptadores, cupos, orquestación, workspace, memoria, skills, servidor, store, vault)
  apps/desktop      Electron + React
  fixtures/         salidas reales grabadas de cada CLI/SDK para pruebas
  docs/             PLAN.md, DECISIONES.md, PROGRESO.md
```

Dependencias (versión actual en npm el 2026-11-01; en la fase 0 se fijan exactas, sin `^`, descartando las publicadas hace menos de 2 semanas): electron 45.2.1, electron-vite 6.0.0, electron-builder 26.18.0, vite 8.3.5, react 19.3.1, typescript 6.0.3 (la 7.0.2 salió hoy), @anthropic-ai/claude-agent-sdk 0.3.316, @anthropic-ai/sdk 1.3.0, ai 7.0.159 + @ai-sdk/openai, @ai-sdk/google y @ai-sdk/openai-compatible, hono 4.13.16 + @hono/node-server 2.1.5, ws 8.22.1, zod 4.6.7, vitest 5.0.5 y better-sqlite3 13.0.3 (o `node:sqlite`, a decidir en la fase 0).

## 4. Núcleo (backend)

### 4.1 Agentes

Dos tipos:

| Tipo | Ejemplos | Puede editar código | Cómo se agrega |
|---|---|---|---|
| Agente con herramientas | Claude (SDK de agentes), Codex CLI, agy CLI | Sí, en su worktree | Detección automática del CLI instalado y su sesión; Claude con tu clave + URL |
| Modelo por API | OpenAI, Gemini API, OpenRouter, cualquier compatible con OpenAI | Al principio solo chat, planificación, revisión y resúmenes; edición en la fase 6 | Proveedor + clave (+ URL base) → «Probar» |

Contrato común (resumen):

```ts
interface AgentAdapter {
  probe(): Promise<ProbeResult>;                          // instalado, autenticado, modelos
  run(task: TaskBrief, ctx: RunContext): AsyncIterable<AgentEvent>;
  cancel(sessionId: string): Promise<void>;
}
interface QuotaProvider { read(): Promise<QuotaSnapshot>; }  // buckets con ventana, % restante, reinicio y fuente
```

### 4.2 Eventos normalizados (lo que alimenta los paneles)

`AgentEvent = { sessionId, agentId, parentSessionId?, seq, ts, type, payload }`, donde `type` es `status | text | tool_call | tool_result | file_change | usage | error | done`.

| Fuente | Traducción |
|---|---|
| SDK de Claude | `system/init` → status; texto → text; `tool_use` → tool_call; mensajes con `parent_tool_use_id` → **subagente** (`parentSessionId`, arma el árbol); `task_*` → estado del subagente; `result` → usage (`total_cost_usd`, `modelUsage`) + done |
| Codex `exec --json` | `thread.started` → status; `item.completed` → text, tool_call o file_change según `item.type`; `turn.completed.usage` → usage |
| agy `stream-json` | `init` → status; `step_update` → text, tool_call y usage; `result` → done |

En la fase 0 se graban salidas reales de tareas que editan archivos para completar los tipos de `item` de Codex y los `step_type` de agy.

### 4.3 Tokens y cupo

| Agente | Tokens por tarea | Cupo restante | Fuente |
|---|---|---|---|
| agy | `usage` por paso | % restante de 5 h y semanal por grupo, con hora de reinicio | `agy -p "/usage" --output-format json` (verificado, 0 tokens) |
| Codex | `turn.completed.usage` | % usado de 5 h (`primary`) y semanal (`secondary`), con reinicio | `account/rateLimits/read` del app-server (por verificar); respaldo: último `rate_limits` de `~/.codex/sessions` (verificado) |
| Claude (tu clave) | usage por mensaje, `total_cost_usd`, `modelUsage` | Tu servidor no informa saldo: **presupuesto manual en USD** que el núcleo descuenta | SDK |
| OpenRouter | `usage` | `limit_remaining`, uso diario, semanal y mensual | `GET /api/v1/key` |
| Otras APIs | `usage` de la respuesta | Cabeceras de límite si el proveedor las envía (se verifica por proveedor) o presupuesto manual | — |

- Codex y agy informan **porcentaje**, no tokens restantes; la UI muestra el % restante y los tokens gastados.
- El costo de Claude lo calcula el SDK con precios públicos; tu servidor puede cobrar distinto.
- Lectura de cupos: cada 5 min, al terminar cada tarea y a pedido. Alertas al 25 % y al 10 % (configurables).

### 4.4 Orquestación

1. **Plan → tareas.** Claude convierte tu plan en tareas JSON validadas con Zod: `id`, objetivo, archivos propios (sin solapes), dependencias, criterio de aceptación, dificultad y agente sugerido. Tú apruebas la lista antes de ejecutar.
2. **Router:**
   - Claude, sin límite: orquestación, tareas difíciles, integración y revisión final.
   - Codex y agy: tareas acotadas en paralelo mientras su cupo de 5 h y semanal supere el 20 % (configurable); por debajo, la tarea pasa a Claude o espera al reinicio, según elijas.
   - agy también ofrece Claude 4.6 con el cupo de Google: capacidad extra.
   - El revisor siempre es un agente distinto del autor.
3. **Concurrencia:** hasta 3 agentes ejecutando más el orquestador (4 núcleos), ajustable. GPU, CPU pesada y E2E se reparten con candados en `C:\dev\agent-hub\locks` (skill `local-compute-scheduling`).
4. **Worktrees:**
   - Cada tarea va en `C:\dev\.worktrees\<proyecto>\<tarea>`, rama `orq/<tarea>`.
   - Preparación por proyecto: en Vetworld, junctions de `workbench`, `.tools` y `assets-source`, `npm ci` (~913 MB por worktree) y sincronización de skills.
   - Limpieza tras integrar.
5. **Integración:**
   - Merge tarea por tarea en `orq/integracion`, solo si la verificación del proyecto pasa (Vetworld: `npm run gate`).
   - Un fallo vuelve al autor; dos fallos seguidos lo reasignan a Claude.
   - Merge a `main` y push solo con tu aprobación.
6. **Claude como orquestador:** SDK de agentes con herramientas propias (`createSdkMcpServer`): `crear_tareas`, `delegar`, `estado`, `cupos`, `leer_memoria`, `escribir_memoria`, `buscar_skills`. Puede lanzar sus propios subagentes, que aparecen en vivo.

### 4.5 Memoria en Obsidian (ahorro de tokens)

- Carpeta `Orquestador/` dentro de tu bóveda: Markdown simple con frontmatter YAML y `[[enlaces]]`, sin plugin.
  - `Proyectos/<proyecto>/Contexto.md`: resumen vivo (estado, decisiones, rutas clave).
  - `Sesiones/AAAA-MM-DD-<tarea>.md`: objetivo, agente, archivos, resultado, tokens y hallazgos.
  - `Decisiones/`, `Agentes/<agente>.md` (cupos e historial) y `Skills.md`.
- Ahorro:
  - Cada encargo lleva solo el objetivo, los archivos propios, un extracto de `Contexto.md` y los nombres y rutas de las skills pertinentes (el agente abre la skill si la necesita), no el historial completo.
  - Al cerrar una tarea, un modelo barato escribe su nota de sesión.
  - El prompt del orquestador mantiene fijo su inicio para aprovechar la caché de Claude.
- La bóveda está en OneDrive y se sincroniza a la nube de la universidad: nunca se escriben ahí claves ni código sensible.

### 4.6 Hub de skills

- Fuentes: `C:\dev\agent-hub\skills` (global) y `.agents/skills` de cada proyecto.
- **Cargar:**
  - Desde una carpeta, un .zip o un repo git.
  - Lo descargado va primero a `C:\dev\agent-hub\skills-entrantes`, en cuarentena.
  - Revisión: se muestran `SKILL.md`, scripts incluidos, licencia y SHA-256.
  - Al aprobar, se copia y se registra en `skills.lock.json` (origen, commit, fecha, hash).
  - Nunca se ejecutan scripts de una skill nueva.
- **Descargar:** exportar como .zip.
- **Vincular:** reutilizar `vincular-skills.ps1`, que crea junctions en Claude, Codex, agy, Cursor y Copilot.

### 4.7 API local

- REST: `/agents` (listar, agregar, probar, borrar), `/quotas`, `/projects`, `/plans`, `/tasks`, `/sessions/:id/events`, `/skills`, `/memory`.
- WebSocket: eventos en vivo y cambios de cupo.
- Solo `127.0.0.1`, con un token aleatorio por arranque que recibe Electron; por eso no hay login.

### 4.8 Seguridad

- Claves cifradas con `safeStorage` de Electron (DPAPI de Windows).
  - El núcleo las recibe solo en memoria.
  - Nunca van a SQLite, registros, Obsidian ni prompts; los patrones de clave se tachan automáticamente.
- Permisos mínimos por agente, siempre dentro de su worktree:
  - Claude: `acceptEdits`.
  - Codex: `-s workspace-write`.
  - agy: `--dangerously-skip-permissions` solo dentro del worktree.
- Bloqueados sin tu aprobación: push, `reset --hard`, borrar ramas, desplegar y pagar.
- Si una URL de API es `http://`, la app muestra un aviso visible.

## 5. Interfaz (después del backend)

- **Centro:** chat con el orquestador; plan propuesto como lista de tareas aprobable.
- **Izquierda:** proyectos y tablero de tareas (pendiente, ejecutando, revisión, integrada, fallida).
- **Derecha:** un panel por agente activo con:
  - nombre, modelo y estado;
  - barra de cupo con hora de reinicio y tokens y costo de la sesión;
  - transmisión en vivo (texto, comandos, archivos cambiados);
  - para Claude, árbol desplegable de subagentes con su propio consumo.
- **Vistas:**
  - Agentes: «Agregar agente» = proveedor + clave (+ URL) → Probar → modelos y método de cupo detectados.
  - Skills, Memoria y Ajustes (umbrales, concurrencia, presupuesto de Claude, modelo del orquestador).
- Instalador NSIS (electron-builder) con acceso directo en el escritorio.

## 6. Fases

| Fase | Contenido | Criterio de aceptación |
|---|---|---|
| F0 Base y verificación | Repo, workspaces, versiones fijadas, TypeScript estricto, Vitest, ESLint. Confirmar con pruebas: SDK de Claude en Windows con tu URL, `account/rateLimits/read` de Codex, `agy.exe` lanzado desde Node con argumentos, SQLite. Grabar en `fixtures/` salidas reales de tareas que editan archivos | Cada incógnita resuelta y anotada en `docs/DECISIONES.md`; fixtures guardadas |
| F1 Núcleo de ejecución | Registro de agentes, bóveda de claves, 3 adaptadores (claude-sdk, codex-cli, agy-cli), eventos normalizados, SQLite, API local + WebSocket | Pruebas con fixtures en verde. Prueba en vivo opcional (`ORQ_LIVE=1`, encargo «Responde exactamente: OK»): los 3 agentes responden y el consumo queda guardado |
| F2 Medición | QuotaProviders (agy, Codex, OpenRouter, cabeceras, manual), lectura periódica, alertas | Los cupos del núcleo coinciden con `/usage` de agy y `/status` de Codex en el mismo momento |
| F3 Orquestación | Plan → tareas, cola con dependencias, router, worktrees, candados, revisión cruzada, integración con gate, orquestador Claude con herramientas y subagentes | Plan de prueba con 3 tareas independientes en un repo de ejemplo: corren en paralelo, se revisan, se integran sin conflictos y el gate pasa |
| F4 Memoria y skills | Notas en Obsidian, extractos para encargos, hub con cuarentena y `skills.lock.json` | Una tarea nueva lleva un encargo más corto (tokens medidos antes y después); importar y exportar una skill funciona |
| F5 Interfaz | Electron + React según §5, conectado a la API local | Plan completo ejecutado desde la UI viendo paneles, subagentes y cupos en vivo |
| F6 APIs con herramientas (opcional) | Herramientas mínimas (leer, escribir y parchear archivos, comandos permitidos) para que un modelo por API trabaje en un worktree | Una tarea pequeña resuelta por un modelo por API y revisada por otro agente |
| F7 Instalador | electron-builder NSIS, inicio opcional con Windows, acceso directo | Instalación limpia en Windows abre la app sin pasos manuales |

- Pruebas: Vitest con fixtures reales en cada adaptador y proveedor de cupo; pruebas en vivo solo con `ORQ_LIVE=1`, porque gastan cupo; tipado estricto y lint en cada fase.
- Quién construye: F0–F3 Claude (yo), porque son la base. Desde F3, el orquestador se usa para construirse a sí mismo y las piezas de UI se reparten a Codex y agy.

## 7. Riesgos y decisiones pendientes

1. **Tu servidor de Claude usa HTTP sin cifrar a una IP** (`http://203.0.113.7`): tu clave, tus prompts y el código que envían los agentes viajan sin cifrar. Conviene pedir en tu trabajo una URL HTTPS y confirmar que puedes usar esa clave para este proyecto. El servidor no informa saldo, así que el «restante» de Claude será un presupuesto que defines tú.
2. **Bóveda en OneDrive:** la memoria se sincroniza a la nube de la universidad. Alternativa: bóveda local en `C:\dev\orquestador-memoria`.
3. **Cupos en porcentaje:** Codex y agy no dicen cuántos tokens quedan, solo el %; la medición es por %.
4. **Disco y tiempo:** cada worktree de Vetworld instala ~913 MB de `node_modules`. Con 4 núcleos, más de 3 agentes en paralelo no acelera.
5. **Cambios de los CLI:** Codex y agy cambian sus formatos de evento. Los adaptadores validan con Zod y, si llega algo desconocido, lo muestran como texto en vez de fallar.
6. Por decidir:
   - umbral de cupo para dejar de usar Codex y agy (propuesto: 20 %);
   - qué hacer al llegar al límite (pasar a Claude o esperar);
   - modelo del orquestador (Claude Opus 5.5 por defecto, o Fable 5.1, más capaz y 2,5× más caro).
