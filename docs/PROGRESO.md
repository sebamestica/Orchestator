# Progreso

## F0 — base (2026-11-01)

Repo, contratos `src/shared`, `runJsonl`, `redactSecrets`, fixtures reales (Codex exec JSON y rollout con `rate_limits`; agy stream-json y `/usage`). Verificación: `npm run check` → typecheck OK, lint OK, 6/6 pruebas.

## F1 — núcleo de ejecución (en curso, 2026-11-01)

Flota lanzada a las 21:40 y relanzada a las 21:58 tras el corte de sesión (ver bitácora).

| Rama | Estado |
|---|---|
| `flota/codex-cli` | **Integrada** en `main` (`b2c40af`): `CodexCliAdapter` y `CodexQuotaProvider`. `npm run check` → 51/51 aprobadas y 2 en vivo omitidas. En vivo (`ORQ_LIVE=1`, sin inferencia): 2/2 aprobadas, sesión de Windows y cupo real leídos |
| `flota/agy-cli` | **Integrada** en `main` (`2b2f648`): `AgyCliAdapter` y `AgyQuotaProvider`, con 2 correcciones de A0 (un solo `done` al final; stderr solo fatal por cupo o sesión). `main` → 73/73 aprobadas y 4 en vivo omitidas |
| `flota/c1-claude-sdk` | En curso: adaptador del SDK de Claude, adaptador de API, cupos OpenRouter, cabeceras y presupuesto manual |
| `flota/c2-orquestacion` | En curso: plan, cola, router, supervisor, flota |
| `flota/c3-workspace` | En curso: worktrees, gate, guardia de git, candados |
| `flota/c4-memoria` | **Integrada** (`7293557`): `ObsidianMemory` (notas válidas, `buildContext` recortado y determinista, sin secretos). Ahorro medido: encargo de 19 758 → 622 tokens con 35 sesiones |
| `flota/c5-servidor` | En curso: servidor local, store, bóveda DPAPI, registro, Postman |

Pendiente detectado al revisar Codex: el respaldo de cupo lee todos los `~/.codex/sessions/**/*.jsonl` (98 MB hoy); conviene limitarlo a los archivos más recientes.

### Subdivisión para acelerar (22:15)

El usuario pidió acelerar y dio vía libre para usar el PC. Se separaron piezas sin código empezado y se dio trabajo nuevo a Codex y agy:

| Nueva rama | Viene de | Contenido |
|---|---|---|
| `flota/c6-api` | c1 | Adaptador de chat por API (5 proveedores) |
| `flota/c7-locks` | c3 | Candados de recursos |
| `flota/c8-skills` | c4 | Hub de skills con cuarentena |
| `flota/c9-orq-pruebas` | c2 | Pruebas de plan, grafo y rutas propias |
| `flota/c10-docs-api` | c5 | OpenAPI y colección de Postman |
| `flota/codex-cupos` | nuevo (F2) | Monitor de cupos con alertas y respaldo de Codex más rápido |
| `flota/agy-repo-ejemplo` | nuevo (F3) | Repo de ejemplo con plan de 3 tareas para la aceptación de F3 |

Pendiente de integración: unificar los `relativizeChange` de Codex y agy en un módulo común, y el lector de frontmatter de memoria (c4) con el de skills (c8).
| `flota/codex-cupos` | **Integrada** (`1b5cbf2`): `QuotaMonitor` (F2) y respaldo de Codex podado por mtime (14 → 1 archivos, 728 → 62 ms). A0 corrigió BOM y mojibake de PowerShell. `main` → 116/116 aprobadas, 4 en vivo omitidas |
| `flota/c11-conductor` | Nuevo (F3): Claude como orquestador, con herramientas MCP en proceso, prompt de inicio fijo y sesión de chat |
| `flota/codex-comun` | Nuevo: `relativizeChange` común a los adaptadores y prueba de aceptación de F2 en vivo |

### Integradas a las 22:32

| Rama | Resultado |
|---|---|
| `flota/c5-servidor` | Servidor Hono (32 rutas, token, Host, Origin, Zod, `/ws` con reenvío por `seq`), store SQLite, bóveda DPAPI real, registro y `main.ts`. 147/147 en su rama |
| `flota/c7-locks` | Candados con `mkdir` atómico, compatibles con la skill (bash y PowerShell reales), carrera entre 4 procesos probada. 50 pruebas |
| `flota/c2-orquestacion` | Supervisor con traspaso a Claude por cupo de punta a punta, flota completa (workspace → memoria → encargo → ejecutar → revisión → integrar → sesión). 66/66 |
| `flota/c9-orq-pruebas` | 217 pruebas de plan, grafo y rutas (con un oráculo de fuerza bruta); 8 fallos de c2 marcados con `it.fails`, que c2 está corrigiendo |
| `flota/agy-repo-ejemplo` | Repo de ejemplo de F3: plantilla, 3 tareas disjuntas y soluciones de referencia; el gate pasa en todos los casos |
| `flota/codex-comun` | `relativizeChange` común. **Aceptación de F2 aprobada en vivo**: % idénticos en los 6 buckets (agy y Codex) |

`main` → 587 aprobadas, 9 fallos esperados (c9 → c2), 6 en vivo omitidas, 0 fallidas.

En curso: c1 (SDK de Claude), c3 (worktrees y gate), c6 (API), c8 (skills), c10 (OpenAPI y Postman), c11 (orquestador Claude), c2 (fallos de c9), Codex (revisión de seguridad de c5, solo lectura) y agy (aceptación de F1 en vivo).

### Integradas a las 22:55

| Rama | Resultado |
|---|---|
| `flota/c1-claude-sdk` | `ClaudeSdkAdapter`: subagentes en árbol, costo, tope `budgetUsd`, corte temprano ante 401, política de permisos. **Funciona solo con la clave de API y la URL del usuario, sin login** (en vivo 4/4; A0 lo repitió: 13,8 s) |
| `flota/c8-skills` | `SkillHub`: cuarentena, informe con SHA-256, `skills.lock.json`, exportar; zip slip, enlaces y 13 scripts trampa probados |
| `flota/c6-api` | `ApiChatAdapter` para 5 proveedores; en vivo con anthropic contra el servidor del usuario (OK, 0,012 USD) |
| `flota/agy-f1-vivo` | **Aceptación de F1 aprobada en vivo con los 3 agentes**: Codex (23 217 de entrada / 5 de salida), agy (25 428 / 645) y Claude (46 536 / 121, 0,2351 USD); consumo guardado y consultado en SQLite |
| `flota/c2-orquestacion` | 15 correcciones (9 de c9 y 6 de la revisión de Codex), cada una con su prueba |
| `flota/c5-servidor` | 6 correcciones de seguridad de la revisión de Codex; todas las escrituras del store se tachan; candado entre procesos para la bóveda |

`main` → 851 aprobadas, 15 en vivo omitidas, 0 fallidas, 0 fallos esperados pendientes.

**F1 y F2 aceptadas.** En curso: c3 (worktrees, relanzado), c10 (OpenAPI y Postman), c11 (orquestador Claude), c12 (la clave del usuario de punta a punta: bóveda → Claude sin variables de entorno). Revisiones cruzadas en curso: Codex (permisos de c1, skills de c8) y agy (memoria y candados).

Dato del usuario: su servidor agrega unos 3700 tokens de entrada por llamada (un prompt de sistema propio; casi todo sale de caché) y cobra cerca de 30 % más que el precio público.

### Núcleo completo integrado (23:55)

| Rama | Resultado |
|---|---|
| `flota/c3-workspace` | `WorktreeManager`: crear con junctions y bloqueo de push (`pushurl` inválido + `pre-push` por worktree), integrar en `_integracion` con `merge --no-commit` + gate + commit o `--abort`, quitar sin borrar ramas. **Hallazgo crítico**: `git worktree remove` sigue junctions y vacía su destino; `remove` las quita antes. 35 pruebas en repos reales |
| `flota/c12-integracion` | Raíz de composición (`src/core/app`) y CLI: `agregar-claude`, `agentes`, `probar-claude`, `conversar`, `iniciar`. **Claude trabaja solo con la clave guardada en la bóveda DPAPI, sin variables de entorno**: punta a punta en vivo 2/2 (OK, 0,21–0,23 USD); la clave no aparece en `vault.json`, SQLite, registros ni respuestas |
| `flota/c1-claude-sdk` (2.ª ronda) | Política de permisos rehecha: hook `PreToolUse`, denegar por defecto, tokenizador de shell, git por subcomando, `settingSources: []`. En vivo: el hook deniega `git "push"` aunque `settings.json` permita Bash |
| `flota/c4-memoria` (2.ª ronda) | Candado entre procesos: 8/8 sesiones con 8 procesos (antes 3/8) |
| `flota/c7-locks` (2.ª ronda) | `release` atómico (rename + confirmar dueño) y token por adquisición |
| `flota/c8-skills` (2.ª ronda) | Junction en la raíz, bomba de carpetas y candado del lock |
| A0 | Un solo candado entre procesos (`src/core/fs/dir-lock.ts`): estrés 12/12 en 4/4 rondas (el de c5 daba 11/12) |

`main` → 1107 aprobadas, 18 en vivo omitidas, 0 fallidas.

Revisiones cruzadas: 5 rondas, **36 fallos reales** encontrados y corregidos (c5: 6, c2: 6, c1: 6, c8: 4, c4: 4, c7: 4, más 6 de c9 sobre plan/paths/graph).

En curso: c12 → aceptación de F3 con la flota real (repo de ejemplo, 3 tareas en paralelo con Claude, Codex y agy, revisión cruzada, integración con gate). Revisiones: Codex (`src/core/app`) y agy (`src/core/workspace`).

## F3 — orquestación: **ACEPTADA en vivo** (2026-11-02, 00:2x)

`tests/live/f3-acceptance.live.test.ts` (c12), repo de ejemplo de agy, 3 tareas en paralelo con la flota real; aprobó en la 1.ª ejecución (166 s):

| Tarea | Autor | Revisor | Resultado | Tokens (entrada/salida) | Costo de Claude | Duración |
|---|---|---|---|---|---|---|
| task-slug | claude (clave desde la bóveda DPAPI) | codex | integrada | 442 324 / 3 673 | 0,3655 USD | 95 s |
| task-truncate | agy (gemini-3.8-flash-low) | claude | integrada | 371 079 / 3 798 | 0,1232 USD | 108 s |
| task-case | codex (2 rondas: Claude rechazó la 1.ª) | claude | integrada | 653 098 / 5 020 | 0,5939 USD | 158 s |

Comprobado:
- el gate `node --test` pasa en la rama de integración final;
- eventos y uso de los 3 agentes quedan en SQLite;
- hay 3 notas de sesión;
- la copia del usuario no cambió (mismo commit, árbol limpio);
- `git push` falla en los worktrees (también con `--no-verify` y con URL explícita);
- la clave nunca aparece en la salida;
- se toma y libera el candado `e2e`;
- los worktrees se quitan sin restos.

Claude gastó 1,08 USD en total (tope 3).

**F0, F1, F2, F3 y F4 cumplidas.** Pendiente del backend: correcciones de la revisión de agy sobre `src/core/workspace` (c3: 2 críticos de la guardia de git). Después: F5 (interfaz Electron), F6 (APIs con herramientas, opcional) y F7 (instalador).

Propuesta pendiente (c12 → `fleet.ts`): gancho `prepare` para fallar antes de la revisión si el agente tocó archivos fuera de sus rutas. Hoy falla al integrar, después de pagar la revisión.

### Cierre del backend (2026-11-02, 00:5x)

- **c3, 2.ª ronda**: los 12 hallazgos de agy sobre `src/core/workspace` corregidos. La guardia de git pasa a lista blanca de subcomandos y opciones y niega toda opción global (`-c`, `--git-dir`…), `include.path`, alias, `clean`, `update-ref`, fontanería y las `GIT_*`. `create` deshace un worktree a medias, integrar va en una cola por proyecto, y se limpian los archivos no versionados del worktree de integración.
- **A0**: la lista blanca admite el paso de commit de la flota (c12) y la identidad del commit. `childEnv`: ningún proceso hijo hereda claves de IA.
- **c5, 3.ª ronda**: el alta por clave prueba con la clave solo en memoria y la guarda solo si la prueba sale bien.
- **c12, 2.ª ronda**: huecos de `compose` conectados (worktrees, API, cola real), commit de la flota con control de `ownedPaths`, y 3 hallazgos de Codex corregidos (el planificador tacha su clave, generaciones en `envFor`, stdin con tope).
- **F3 repetida en vivo con la guardia nueva**: 3/3 integradas en 107 s. Autores: claude, codex, agy. Revisores: agy, claude, claude. Claude gastó 0,71 USD.

`main` → 1136 aprobadas, 19 en vivo omitidas, 0 fallidas.

**Revisiones cruzadas en total: 9 rondas, 58 fallos reales encontrados y corregidos.**

## F5 — interfaz Berland (2026-11-04)

Plan: [docs/plan/F5-INTERFAZ.md](plan/F5-INTERFAZ.md). Contratos: `src/shared/api.ts`. El usuario llamó **Berland** a la app.

| Pieza | Quién | Resultado |
|---|---|---|
| Base: contratos, tema de studyapp, armazón, cliente REST, `/ws` y puente | A0 | `main` |
| c14 servidor: ajustes, mente y subagentes, carpetas, proyecto desde carpeta, tarea manual, interfaz estática sin token, `/ws` con subprotocolo | Claude | integrada |
| c15 chat con la mente: REST y `/ws`, modos plan/auto/bypass reales, adjuntos (imágenes como bloques), propuestas persistentes | Claude | integrada |
| c16 plugins: Chrome (`personal`/`agente`) y Canva (OAuth 2.1 con PKCE y registro dinámico, comprobado contra mcp.canva.com) para Claude y Codex | Claude | integrada |
| c17 plan obligatorio: `.orq/PLAN.md` y `.orq/PLAN-TAREA.md` en cada tarea, nota en Obsidian; `Fleet.run` despierta al aprobar | Claude | integrada |
| c18 escritorio: Electron 44, núcleo supervisado, sesión cifrada con safeStorage, acceso directo `Berland.lnk` | Claude | integrada |
| c19 vista de chat | Claude | integrada |
| ui-composer (pegar imagen, soltar archivos, Shift+Tab), ui-agentes-vivo, ui-plugins-proyectos | **Codex por la flota de Berland** (revisión de Claude) | rescatadas e integradas por A0 (fallo del paso de commit) |
| ui-ajustes (la tomó Claude: agy estaba ocupado), ui-tablero (agy) | **flota de Berland** | integradas por el núcleo con su gate |

`main` → 1597 pruebas aprobadas, 20 en vivo omitidas, 0 fallidas; build de la interfaz y del escritorio. Aceptación en vivo: conversación real con la mente en modo plan desde la interfaz (0,09 USD); Berland abre desde el acceso directo, lanza su núcleo y conecta en vivo.

Pendiente (F5.2): Codex y agy como mente (puente MCP), agy con plugins (`agy acp`), clonar repos, acceso desde otros equipos (puerta HTTPS) e instalador (F7).
