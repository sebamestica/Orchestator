# Las 11 pruebas live se importan en cada `npm test` y en cada gate aunque luego se salten

- **Área:** Pruebas y rendimiento
- **Severidad:** baja
- **Archivos:** `vitest.config.ts:2`, `vitest.config.ts:11`, `package.json:13-15`, `tests/live/f3-acceptance.live.test.ts:8`, `tests/live/f3-acceptance.live.test.ts:19`, `tests/live/f3-acceptance.live.test.ts:26`, `tests/live/e2e-claude.live.test.ts:7-9`, `tests/live/e2e-claude.live.test.ts:21`, `tests/live/conductor.live.test.ts:10-12`, `tests/live/conductor.live.test.ts:18`, `tests/live/chrome-personal.live.test.ts:48`, `AGENTS.md:16`, `tsconfig.json:24-29`, `docs/plan/issues/09-aislamiento-contexto.md:149`
- **Estado:** resuelta

## Cómo ocurre
`AGENTS.md:16` fija la regla: las pruebas que llaman a CLIs o APIs reales van en `tests/live/` y «se saltan salvo
`ORQ_LIVE=1`». Hoy hay 11 archivos ahí (`agy`, `api`, `chat`, `chrome-personal`, `claude-sdk`, `codex`, `conductor`,
`e2e-claude`, `f1-acceptance`, `f3-acceptance` y `quota-acceptance`, todos `*.live.test.ts`).

El salto se hace solo dentro de cada archivo, en tiempo de ejecución. La configuración de Vitest los incluye igual que a
cualquier otra prueba (`vitest.config.ts:11`):

```ts
include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
```

No hay `exclude` (el archivo solo importa `defineConfig`, `vitest.config.ts:2`), ni `projects`, ni otra configuración
para las live. Y `npm test` es `vitest run` a secas (`package.json:13`), que es lo que corre `npm run -s check`
(`package.json:15`).

Pasos:
1. Se corre `npm run -s check`, a mano o como gate de la flota en un worktree.
2. Vitest recoge los 11 `tests/live/*.live.test.ts`. Con `isolate: true` por defecto, cada archivo se ejecuta en su
   propio worker, que tiene que importar el módulo entero antes de saber que se salta.
3. La guarda está en el `describe`, después de los `import`. Por ejemplo, en `tests/live/f3-acceptance.live.test.ts`:

   ```ts
   import { compose, type Composition } from '../../src/core/app/compose.ts';   // :8
   ...
   const live = process.env.ORQ_LIVE === '1' && !!process.env.ANTHROPIC_API_KEY && process.platform === 'win32'; // :19
   ...
   describe.skipIf(!live)('Aceptación F3: flota real con claude, codex y agy', () => {   // :26
   ```

   `compose.ts` arrastra casi todo el núcleo (store, registro, plugins, planner, flota, memoria). Lo mismo pasa en
   `e2e-claude.live.test.ts:7-9` (`compose`, `smoke` y `startCore` de `main.ts`, saltado en `:21`) y en
   `conductor.live.test.ts:10-12` (el SDK de Claude Agent y `ConductorSession`, saltado en `:18`). El resto importa
   adaptadores, cupos y `run-jsonl`.
4. Resultado: en cada check y en cada worktree se pagan 11 workers con su grafo de importaciones y no se ejecuta ni una
   prueba. El informe del issue 09 ya lo registra: «144 archivos aprobados y 10 saltados»
   (`docs/plan/issues/09-aislamiento-contexto.md:149`). Eran 10 porque `chrome-personal.live.test.ts` (saltado con
   `describe.skipIf(!LIVE)` en `:48`) llegó después, con el issue 11.

Ninguno de los issues 1 a 11 de hoy cambió `vitest.config.ts` ni la forma de saltar las live.

El costo por check es modesto: las transformaciones de Vite quedan en caché en el proceso principal, así que se pierde
sobre todo arrancar el worker y evaluar los módulos. Por eso la severidad es baja. Aun así, son unos 11 de ~155 archivos
de prueba, en un gate que corre en paralelo en varios worktrees con la CPU al límite (`vitest.config.ts:13-14` ya
advierte que pruebas de 1 s llegaron a tardar 20 s).

## Por qué pasa
Las pruebas live se apagan solo con `describe.skipIf(...)` dentro de cada archivo. La configuración no las excluye.
`skipIf` corre durante la recolección, que en Vitest ocurre importando el archivo, así que la guarda llega tarde para
ahorrar esa importación.

## Solución posible
Excluir `tests/live/**` en `vitest.config.ts` salvo que `ORQ_LIVE=1`:

```ts
import { configDefaults, defineConfig } from 'vitest/config';

const live = process.env.ORQ_LIVE === '1';

export default defineConfig({
  // ...
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Las pruebas live (CLIs y APIs reales) ni se cargan sin ORQ_LIVE=1; dentro siguen su skipIf por clave y plataforma.
    exclude: [...configDefaults.exclude, ...(live ? [] : ['tests/live/**'])],
    // ...
  },
});
```

- `npm run test:live` ya pone `ORQ_LIVE=1` antes de `vitest run tests/live` (`package.json:14`), así que sigue igual.
  Los comandos documentados en cada archivo (`set ORQ_LIVE=1&& npx vitest run tests/live/<archivo>`) también.
- Los `skipIf` internos se quedan: siguen filtrando por `ANTHROPIC_API_KEY`, `win32`, `ORQ_LIVE_CHROME` y
  `ORQ_LIVE_CUPO`.
- No se pierde la comprobación de tipos ni de lint de esos archivos: `tsconfig.json:24-29` incluye `tests` en
  `tsc --noEmit` y `eslint .` los recorre igual.
- Actualizar `AGENTS.md:16` para decir que sin `ORQ_LIVE=1` ni se cargan.

Un efecto a tener en cuenta: `npx vitest run tests/live/x.live.test.ts` **sin** `ORQ_LIVE=1` pasa de «saltado, en verde»
a «No test files found», que sale con código 1. Eso sirve de aviso de que falta la variable, pero hay que saberlo.

### Otras opciones
La propuesta no es la única, y puede haber una más ordenada:
- **Proyectos de Vitest** (`test.projects`): uno `unit` con `exclude: ['tests/live/**']` y otro `live` con
  `include: ['tests/live/**/*.live.test.ts']`. `npm test` pasaría a `vitest run --project unit` y `test:live` a
  `vitest run --project live`. Elegir sería explícito y no dependería de una variable de entorno al cargar la
  configuración, pero hay que tocar los scripts y revisar que el gate de la flota (`GATE_SCRIPTS` en
  `src/core/fs/folders.ts:234`, que busca `check`/`gate`/`test`) siga corriendo el proyecto correcto.
- **Configuración aparte** `vitest.live.config.ts` (con `mergeConfig` sobre la base) y `tests/live/**` excluido de la
  principal sin condición: `test:live` sería `vitest run -c vitest.live.config.ts`. Es el corte más limpio. Lo malo es
  que hay que cambiar los comandos `npx vitest run tests/live/...` escritos en la cabecera de cada archivo live.
- **Renombrar el patrón:** que el `include` principal no capture `*.live.test.ts` (por ejemplo, que esos archivos se
  llamen `*.live.ts`) y que solo la configuración live los incluya. Evita la variable de entorno, pero obliga a
  renombrar 11 archivos y sus referencias (`tests/core/orchestrator/paths.test.ts:373-399`, ayudas de grabación).

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: `tests/core/vitest-config.test.ts`.
  - Escenario 1: `vi.stubEnv('ORQ_LIVE', '')`, `vi.resetModules()` y `await import('../../vitest.config.ts')`. Afirma
    que `config.test.exclude` contiene `'tests/live/**'` y conserva los de `configDefaults.exclude`
    (p. ej. `'**/node_modules/**'`).
  - Escenario 2: `vi.stubEnv('ORQ_LIVE', '1')`, `vi.resetModules()` y se vuelve a importar. Afirma que `exclude` ya no
    contiene `'tests/live/**'`.
  - `afterEach(() => vi.unstubAllEnvs())`.
- Comando para correrla (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/vitest-config.test.ts"`
  (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/core/vitest-config.test.ts`).
- Verificación manual, sin gastar cupo:
  - `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest list --filesOnly"`: no aparece ningún `tests/live/`. Antes
    aparecían los 11.
  - `/mnt/c/dev/orquestador/scripts/win.sh "set ORQ_LIVE=1&& npx vitest list --filesOnly tests/live"`: siguen apareciendo
    los 11.
  - El resumen de `npm run -s check` deja de mostrar archivos «skipped» por las live (hoy «… y 10/11 saltados»).
