# Orquestador — reglas para agentes

Lee también la skill común `C:\dev\agent-hub\skills\flota-orquestador\SKILL.md` (WSL: `/mnt/c/dev/agent-hub/skills/flota-orquestador/SKILL.md`) y el plan [PLAN.md](PLAN.md). Las skills compartidas de este PC están en `C:\dev\agent-hub\skills`; revisa allí si alguna aplica a tu tarea.

## Proyecto

Núcleo (backend) en TypeScript de un orquestador local que reparte tareas entre Claude (SDK de agentes con la clave de API del usuario), Codex CLI y Antigravity CLI (`agy`). Corre en **Windows, Node 24** (`node:sqlite`, DPAPI). La interfaz Electron llega después; ahora solo backend.

## Reglas

- **Contratos:** `src/shared/` es la fuente de verdad (Zod + tipos). No lo modifiques: si necesitas un cambio, descríbelo en tu informe y el orquestador lo integra.
- **Propiedad de archivos:** modifica solo las rutas de tu encargo (`ownedPaths`). Fuera de ellas, propón en el informe.
- **Dependencias:** solo las de `package.json`, fijadas sin `^`. Si necesitas otra, pídela en el informe; no ejecutes `npm install`.
- **TypeScript estricto**, imports relativos con extensión `.ts`, sin `any`, sin `enum` ni `namespace` (Node ejecuta TS por borrado de tipos). Validar con Zod todo dato externo (salida de CLIs, HTTP, archivos).
- **Seguridad:** ninguna clave en código, pruebas, registros, SQLite, Obsidian ni eventos; pasar texto por `redactSecrets` antes de persistirlo. El servidor local escucha solo en `127.0.0.1` y exige token. Nada de `shell: true` con texto del usuario.
- **Pruebas:** cada módulo con pruebas Vitest en `tests/` que usen las salidas reales de `fixtures/`. Las pruebas que llaman a CLIs o APIs reales van en `tests/live/` (gastan cupo). Sin `ORQ_LIVE=1` ni se cargan: `vitest.config.ts` las excluye. Con `ORQ_LIVE=1` corren, y cada una sigue saltándose si le falta su clave o plataforma (`describe.skipIf`).
- **Comandos:** desde WSL, siempre con el Node de Windows: `scripts/win.sh npm run -s check` (typecheck + lint + test). En PowerShell/cmd: `npm run check`.
- **Git:** trabaja en tu rama del worktree; commits pequeños en español (`feat(core): …`, `test(core): …`). Nunca push, `reset --hard`, `rebase` ni borrar ramas.
- **Documentación** en español. Decisiones en `docs/DECISIONES.md` (solo el orquestador) y problemas de coordinación en tu informe (el orquestador los pasa a `docs/BITACORA-FLOTA.md`).

## Informe final (obligatorio)

Archivos cambiados; comandos ejecutados con su salida real resumida (cifras exactas); pruebas aprobadas y fallidas; lo no ejecutado («no ejecutado»); cambios propuestos fuera de tu zona; problemas encontrados al trabajar con otros agentes; bloqueos.
