# F6 · Flujo rápido de la flota

Estado: **aprobado con cambios** (2026-11-06, ver §2.1 bis). En ejecución por A0.

Objetivo: que más agentes trabajando signifique menos tiempo de respuesta, no más. Hoy pasa lo contrario: Codex solo
termina antes que la flota completa. El plan junta el flujo que pidió el usuario con las recomendaciones de Claude
(menos capas de supervisión, verificación automática, planificar una vez, esfuerzo por tarea, medir antes de optimizar).

---

## 1. Diagnóstico (medido el 2026-11-06)

Fuentes: copia de `%LOCALAPPDATA%\orquestador\orquestador.db` (solo lectura) y el código de `main` (`326831c`).

### 1.1 Cifras

| Quién | Sesiones | Duración media | Máxima |
|---|---|---|---|
| Codex (flota) | 15 | **3,0 min** | 9,9 min |
| agy (flota) | 7 | 11,4 min | 37,7 min |
| Claude (flota, siempre Opus) | 36 | **19,3 min** | 216,6 min |

- Las sesiones de la tabla mezclan autoría y revisión (las revisiones de Codex duran menos de 1 min), así que sirven para comparar agentes, no etapas.
- Tareas de dificultad media sugeridas a Codex/agy (`ui-*`): de 76 a 92 min desde que se crearon hasta que se integraron. Esa cifra incluye la espera de aprobación, y sin marcas por etapa (C8) no se puede separar.
- `pruebas-03` (dificultad media): 19 sesiones para una sola tarea.
- En la base hay 17 tareas: 6 integradas y 11 fallidas. Las 6 de `marketing` fallaron en 0 min, antes de ejecutarse.
- El caché de prompt ya funciona: 81 % de la entrada de los Claude de la flota y 86 % de la mente sale de caché. **No es el cuello de botella.**

### 1.2 Causas encontradas en el código

| # | Causa | Dónde | Efecto |
|---|---|---|---|
| C1 | El subagente `investigador` tiene `model: 'inherit'`: corre en **Opus con esfuerzo alto**, no en Haiku | `src/core/conductor/session.ts:100` | Búsquedas lentas y caras. El turno de radio_example llegó a 5,54 USD y se cortó |
| C2 | No existen subagentes Haiku ni Sonnet para la mente. El único tipo permitido es `investigador` | `session.ts` (`CONDUCTOR_SUBAGENTS`), `prompt.ts:45` | La mente no puede repartir por velocidad |
| C3 | El worker Claude de la flota **siempre usa Opus**. La dificultad solo cambia el esfuerzo | `adapters/claude-sdk/adapter.ts:46` y `profile()` | Una tarea fácil tarda lo mismo que una difícil |
| C4 | Codex y agy aceptan **1 tarea a la vez** cada uno (`maxParallelPerCli = 1`). Lo que sobra va a Claude Opus | `orchestrator/router.ts:97` | El paralelismo es falso: con 5 tareas medias, 2 corren y 3 caen en Opus |
| C5 | El gate completo (`npm run -s check`: 2418 pruebas, typecheck, lint y builds) corre **dos veces por tarea**: antes de revisar y al integrar. La integración es **en serie** por repo (`integrate:<repo>`) | `fleet.ts` `#runGate`, `workspace/integrate.ts`, `manager.ts:168` | N tareas = 2N checks completos, uno tras otro, y Defender los frena todavía más |
| C6 | Cada tarea pasa por resumen del diff, gate, revisor LLM y hasta 3 rondas, sea cual sea su tamaño | `fleet.ts` `#cycle`/`#review` | Tareas triviales cargan la ceremonia completa |
| C7 | El encargo no dice qué pruebas rápidas correr: el autor corre la suite completa o no corre nada | `brief/render-brief.ts` | Minutos perdidos por tarea, o fallos que aparecen recién en el gate |
| C8 | **No se puede medir dónde se va el tiempo**: 130 sesiones de subagentes quedan con `ended_at = NULL`, el uso de los subagentes no se asigna a su sesión y no hay marcas por etapa (plan, autor, gate, revisión, integración) | `store/store.ts`, tabla `sessions`/`usage` | No se puede comprobar si una optimización sirve |
| C9 | Tope de 5 USD por mensaje (`DEFAULT_MIND_LIMITS.turnUsd`) | `src/shared/api.ts:58` | Corta los turnos de orquestación a la mitad. Con C1 resuelto pasa mucho menos |

### 1.3 Conclusión

El problema no es el razonamiento de los modelos. El tiempo se pierde en tres cosas: modelos grandes haciendo trabajo
chico (C1, C3), colas en serie (C4, C5) y ceremonia fija por tarea (C6, C7). Además no hay datos para confirmarlo
etapa por etapa (C8), así que lo primero es instrumentar.

---

## 2. Flujo nuevo

### 2.1 Cómo encaja lo que pediste con la recomendación de Claude

Pediste: Haiku busca → Codex/agy/Claude implementan → Haiku revisa → Sonnet revisa → Opus confirma. Claude recomienda
quitar la capa de vigilancia de Sonnet y cambiarla por verificación automática. Tu idea nueva resuelve las dos cosas:
**Sonnet deja de vigilar después y pasa a escribir las pruebas antes.** Opus revisa esas pruebas una vez, y después
la verificación la hacen las pruebas, no tres modelos en cadena.

```
            ┌── Haiku ×N (rápido, solo lee) ── mapa del repo, archivos exactos, comandos de prueba
SONDEO ─────┤
            └── Sonnet (pruebas) ── scripts de prueba rápidos por tarea, FUERA de git
                         │
PLAN ─────── Opus (una sola vez) ── revisa las pruebas de Sonnet y arma tareas independientes
                         │           con archivos, contrato, criterios y la prueba que las cierra
                         ▼
EJECUCIÓN ── en paralelo, un worktree por tarea:
             baja → Claude Haiku · media → Codex / agy (o Claude Sonnet) · alta → Claude Opus
             cada uno corre SOLO sus pruebas rápidas
                         │
VERIFICACIÓN gate rápido (typecheck + lint de lo tocado + pruebas relacionadas + pruebas de .orq/pruebas)
             revisión LLM solo si la tarea es alta o sensible (seguridad, datos, concurrencia, UI sin pruebas)
                         │
INTEGRACIÓN  cola por lotes: merge con gate rápido; check completo UNA vez por lote
```

### 2.1 bis · Decisión del usuario (2026-11-06): escalado por fallos

Se quita la cadena Haiku → Sonnet → Opus después de cada tarea. Queda así:

1. **Opus** designa las tareas.
2. **Sonnet** escribe los scripts de prueba de cada tarea.
3. **Opus** revisa esos scripts antes de que empiece la ejecución.
4. **Haiku** (o Codex/agy en tareas medias) ejecuta la tarea.
5. Al terminar, se corren **sus pruebas** (las de Sonnet y el gate rápido). No hay revisión de un modelo.
6. Si fallan, la salida del fallo (qué prueba, qué error, el diff) llega a **Sonnet**, que corrige en el mismo worktree.
7. Si vuelve a fallar, todo pasa a **Opus** (el fallo, lo que intentó Sonnet y el contexto amplio del plan) para que lo vea con más perspectiva.
8. Si Opus tampoco lo resuelve, la tarea queda `failed` con el informe, para el usuario.

En Berland esto reemplaza a `#reworkAgent` (hoy: mismo autor, y después de 2 fallos un Claude cualquiera, siempre Opus)
por una escalera fija según el modelo: `haiku → sonnet → opus`. Si el autor fue Codex o agy, el primer escalón es Sonnet.

Otras decisiones: el tope por mensaje lo sube el usuario en Ajustes; Codex y agy toman 2 tareas a la vez cada uno;
A0 (Claude Code) ejecuta este plan con la misma escalera, para medir si así se trabaja más rápido.

### 2.2 Roles

| Rol | Modelo | Esfuerzo | Qué hace | Qué no hace |
|---|---|---|---|---|
| Mente | Opus 5.5 | alto, solo al planificar | Plan único, revisa las pruebas de Sonnet, reparte, confirma tareas altas o sensibles | Buscar en el repo, ediciones mecánicas |
| `rapido` (nuevo) | Haiku 5.5 | bajo | Búsquedas de solo lectura, mapa de módulos, ubicar archivos | Opinar sobre diseño |
| `pruebas` (nuevo) | Sonnet 5.5 | medio | Escribe scripts de prueba rápidos por tarea en la carpeta de pruebas | Tocar el repo |
| Ejecutor bajo | Claude Haiku | bajo | Ediciones acotadas, 1–2 archivos | Arquitectura |
| Ejecutor medio | Codex / agy, o Claude Sonnet si no hay cupo | medio | Módulos acotados | Cambios transversales |
| Ejecutor alto | Claude Opus | alto | Arquitectura, integración, bugs difíciles | Tareas mecánicas |
| Corrector 1 | Sonnet | medio | Recibe el fallo de las pruebas y corrige | Rehacer la tarea desde cero |
| Corrector 2 | Opus | alto | Si Sonnet no lo arregla: lo ve con el contexto del plan | Tareas sin fallo |

### 2.3 Pruebas de sondeo fuera de git

- Se guardan en `<dataDir>/pruebas/<proyecto>/<plan>/` (fuera del repo) y Berland las copia a `.orq/pruebas/` de cada
  worktree al crear la tarea, igual que `BRIEF.md`.
- `.orq/` ya está en el `.gitignore` de Berland. En repos ajenos, Berland agrega `.orq/` a `.git/info/exclude` al
  crear el worktree (verificar que lo haga hoy; si no, agregarlo).
- El subagente `pruebas` no recibe `Write`: devuelve los scripts y la mente los guarda con una herramienta nueva,
  `guardar_prueba(plan, nombre, contenido)`, que solo escribe en esa carpeta. Así la guardia no se abre.

---

## 3. Lotes de implementación

Cada lote dice qué rutas son suyas, para que corran en paralelo sin pisarse.

### Lote A · en paralelo, sin dependencias

**A1 · Medición** (media → Codex)
- Rutas: `src/core/store/**`, `src/core/usage-stats/**`, `src/core/orchestrator/supervisor.ts`, pruebas de esas rutas.
- Cerrar `ended_at` de las sesiones de subagentes; asignar el uso a la sesión del subagente.
- Marcas por etapa en cada tarea: `planned`, `author_start/end`, `gate_start/end`, `review_start/end`, `integrate_start/end`.
- Ruta `GET /stats/etapas` (o sección en Uso) con «dónde se va el tiempo» por tarea y por agente.
- Aceptación: una tarea de prueba muestra las 5 etapas con duración; ninguna sesión de subagente queda sin `ended_at`.

**A2 · Manual y skills** (solo documentos → agy o Claude Sonnet; Opus revisa)
- Rutas: `docs/PROCESO.md`, `C:\dev\agent-hub\skills\{proceso-estandar,desarrollo-issues,backend,frontend-ingenieria,seguridad-web}\SKILL.md`, actualización de `flota-orquestador`.
- Contenido en la sección 4.
- Aceptación: cada `SKILL.md` tiene `name` y `description` válidos para el hub (`src/core/skills/skill-md.ts`) y aparece en `buscar_skills`.

**A3 · Subagentes de la mente** (alta, toca la guardia → Claude Opus; revisión de Codex en solo lectura)
- Rutas: `src/core/conductor/{session,prompt,tools,guard}.ts` y sus pruebas.
- `investigador` → `model: 'claude-haiku-5-5'` y renombrarlo `rapido` (alias del nombre viejo para sesiones guardadas).
- Nuevo `pruebas` en Sonnet, sin `Write`, con la herramienta `guardar_prueba` limitada a la carpeta de pruebas.
- El prompt de la mente explica el sondeo: Haiku ×N en paralelo, un `pruebas`, y luego plan único.
- Aceptación: una prueba con `query` doble confirma el modelo de cada subagente; `guardar_prueba` rechaza rutas fuera de su carpeta (`..`, absolutas, junctions).

### Lote B · línea base (después de A1)

**B1 · Benchmark A/B/C** (lo corro yo como A0)
- La misma tarea media (una issue real de radio_example o de `inssues/`) con: (a) Codex solo, (b) Opus planifica + 1 ejecutor + gate, (c) la flota actual.
- Se mide: tiempo de punta a punta, costo, rondas de corrección y si pasa.
- Si (b) no mejora a (c), el problema es la forma de las tareas, no los modelos, y se revisa el lote E antes que C y D.

### Lote C · reparto por modelo (después de B1)

**C1 · Router y modelo por dificultad** (media/alta → Claude Opus)
- Rutas: `src/core/orchestrator/router.ts`, `src/core/adapters/claude-sdk/adapter.ts`, `src/shared/api.ts` (ajustes), pruebas.
- `profile()` elige modelo por dificultad: baja → Haiku, media → Sonnet, alta → Opus, configurable en Ajustes.
- `maxParallelPerCli` configurable (propuesta: 2 para Codex y 2 para agy, según sus cupos).
- Si Codex/agy están ocupados, una tarea media va a Claude **Sonnet**, no a Opus.

### Lote D · verificación rápida e integración por lotes (después de A1)

**D1 · Gate rápido y cola de integración** (alta, núcleo sensible → Claude Opus; ciclo de revisión de Codex hasta «apto»)
- Rutas: `src/core/workspace/{integrate,manager}.ts`, `src/core/orchestrator/fleet.ts` (`#review`, `#runGate`), ajustes del proyecto (`gateRapido`), pruebas.
- El proyecto define dos gates: `gateRapido` (por tarea: `tsc --noEmit` incremental, lint de lo tocado, `vitest related <archivos>` y `.orq/pruebas`) y `gate` (completo).
- Por tarea corre solo `gateRapido`. El `gate` completo corre **una vez por lote** de merges; si falla, se bisecta el lote para encontrar la tarea culpable.
- Revisión LLM solo para dificultad alta o tareas marcadas `sensible`.
- Comparte `fleet.ts` con A1: D1 empieza cuando A1 está integrado.

### Lote E · encargo con pruebas y seguridad (después de A3)

**E1 · Contrato de la tarea** (media → Codex)
- Rutas: `src/shared/tasks.ts`, `src/core/brief/render-brief.ts`, `src/core/orchestrator/plan.ts`, pruebas.
- `TaskBrief` suma `checks: [{ cmd, desc }]` (con valor por defecto `[]`, para no romper tareas guardadas), `effort` opcional y `sensible` opcional.
- El encargo agrega la sección **Pruebas rápidas** (los comandos de `checks` y los archivos de `.orq/pruebas/`) y, si la tarea es sensible o toca backend, auth o despliegue, la sección **Seguridad** con la lista corta de `seguridad-web` y su `skillRef`.
- El prompt del planificador pide `checks` y `sensible` en cada tarea.

### Orden y responsables

| Lote | Depende de | Quién | Paralelo con |
|---|---|---|---|
| A1 Medición | — | Codex | A2, A3 |
| A2 Manual y skills | — | agy / Sonnet | A1, A3 |
| A3 Subagentes | — | Claude Opus | A1, A2 |
| B1 Benchmark | A1 | A0 | C1 |
| C1 Router | B1 | Claude Opus | E1 |
| D1 Gate e integración | A1 | Claude Opus | C1, E1 |
| E1 Contrato | A3 | Codex | C1, D1 |

Cada lote: worktree propio, `<worktree>/scripts/win.sh npm run -s check` en verde, commit a nombre del usuario sin
trailers, `merge --no-ff` a `main` y publicación por la rama `publico`.

---

## 4. Manual de procesos y skills nuevas

### 4.1 `docs/PROCESO.md` y skill `proceso-estandar`

Un mismo procedimiento para cualquier agente, aunque solo esté Codex:

1. **Sondeo**: mapa del repo, archivos exactos, comandos de prueba.
2. **Pruebas de sondeo**: scripts rápidos por tarea en `.orq/pruebas/`, nunca en git.
3. **Plan único**: tareas independientes con archivos, contrato, criterios, `checks` y dificultad.
4. **Ejecución**: un worktree por tarea, solo las rutas propias.
5. **Verificación**: gate rápido y pruebas de la tarea; revisión de un modelo solo si la tarea es alta o sensible.
6. **Integración**: por lotes, check completo una vez por lote, un commit por issue a nombre del usuario.

Qué hace cada uno según quién esté disponible:

| Etapa | Con Claude | Solo Codex | Solo agy |
|---|---|---|---|
| Sondeo | Haiku ×N | `codex exec -s read-only`, una pasada por área | agy en solo lectura |
| Pruebas de sondeo | Sonnet | Codex las escribe en `.orq/pruebas/` | agy |
| Plan | Opus | Codex con esfuerzo alto, usando la plantilla del plan | agy |
| Revisión de pruebas | Opus | una segunda pasada de Codex en solo lectura | Codex si hay cupo |
| Ejecución | Haiku / Codex / agy / Sonnet / Opus | Codex | agy |
| Revisión sensible | Sonnet → Opus confirma | Codex en solo lectura, otra sesión | Codex |

Incluye plantillas: plan, encargo, informe e issue.

### 4.2 Skills nuevas (en `C:\dev\agent-hub\skills`)

| Skill | Para qué |
|---|---|
| `desarrollo-issues` | Tomar una issue: reproducir con una prueba roja, arreglo mínimo, prueba verde, un commit por issue. Plantilla de issue (contexto, pasos, esperado, real, criterios, archivos) |
| `backend` | API: validación con zod en el borde, errores, migraciones ordenadas, transacciones, idempotencia, logs, N+1 e índices, arranque en frío (el caso de Render: 42,7 s) |
| `frontend-ingenieria` | Complementa `frontend-design`, que cubre lo visual: estado, estados de carga, error y vacío, formularios, accesibilidad, rendimiento (Lighthouse), pruebas, nada secreto en el bundle |
| `seguridad-web` | Reglas obligatorias, sección 4.3 |

### 4.3 `seguridad-web`: reglas mínimas

Lo de radio_example es el ejemplo de lo que hay que evitar: el despliegue publicaba el repo entero, con credenciales
y una contraseña maestra en el código.

- **Secretos**: nunca en el código ni en issues o docs. `.env*` fuera de git. Revisión con gitleaks antes del commit. Un secreto que se publicó se da por filtrado y se rota.
- **Qué se despliega**: solo la carpeta de build. Vercel con `outputDirectory` y `.vercelignore`; Render con su carpeta raíz. Comprobar con una petición que `/.git`, `/*.md`, `/prisma` y `/src` no se descarguen.
- **Auth**: contraseñas con argon2 o bcrypt, sin contraseñas maestras, sesión en cookie `httpOnly`, `Secure` y `SameSite`, con expiración. Permisos por rol comprobados en el servidor.
- **Borde HTTP**: CORS con lista blanca, límite de peticiones en login y en la API, validación de entrada y salida, consultas parametrizadas, CSP y cabeceras de seguridad, protección CSRF donde haya cookies.
- **Datos**: staging separado de producción, respaldo antes de cada migración, scripts destructivos con confirmación y bloqueados contra la BD de producción.
- **Dependencias y logs**: `npm audit` en el gate; logs sin secretos ni datos personales.
- **Antes de desplegar**: lista de verificación en la skill, que el revisor de tareas sensibles también usa.

---

## 5. Decisiones que necesito de ti

1. **Revisión en cadena**: propongo quitar Haiku → Sonnet → Opus después de cada tarea baja o media y dejar las pruebas de Sonnet más el gate rápido. La cadena quedaría solo para tareas altas o sensibles. ¿De acuerdo?
2. **Plan por tarea** (tu regla de F5: toda tarea lleva `.orq/PLAN-TAREA.md`): para tareas bajas, propongo que Berland escriba ese archivo con los pasos del plan de Opus, en vez de que el agente gaste un turno en eso. La regla se mantiene y la tarea va más rápido.
3. **Quién ejecuta este plan**: (a) yo como A0 desde Claude Code, con worktrees, Codex y agy, como en las 119 issues, que ya funcionó; o (b) la flota de Berland por `POST /tasks`. Propongo (a) para los lotes A, C, D y E, y (b) solo para el benchmark, porque ahí se mide a Berland misma. Para (b) necesito el enlace «Abrir en el navegador».
4. **Tope por mensaje**: 5 USD corta los turnos de orquestación. Como la API la paga tu empresa, propongo subirlo a 20 USD en Ajustes. Lo cambias tú.
5. **Codex y agy en paralelo**: ¿cuántas tareas a la vez aguantan tus cupos? Propongo 2 y 2.

## 6. Fuera de este plan

- radio_example: las credenciales publicadas siguen sin rotar. Es tu cuenta y tus despliegues: hay que hacerlo en Vercel, Render y la BD. La skill `seguridad-web` deja la regla para que no se repita.
- Docker Compose y F5.2 siguen como estaban.
