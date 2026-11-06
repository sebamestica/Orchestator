# Vitest no tiene tope de workers y la flota corre varios gates a la vez sin coordinarlos

- **Área:** Pruebas y rendimiento
- **Severidad:** media
- **Archivos:** `vitest.config.ts:9-17`, `vitest.config.ts:13-16`, `node_modules/vitest/dist/chunks/cli-api.B0Pz1_R7.js:3832-3838`, `node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js:180`, `node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js:380`, `src/core/app/fleet-service.ts:126`, `src/shared/api.ts:60`, `src/shared/api.ts:74`, `src/core/orchestrator/fleet.ts:533`, `src/core/orchestrator/fleet.ts:577-581`, `src/core/app/workspaces.ts:138-146`, `src/core/workspace/manager.ts:163-167`, `src/core/workspace/integrate.ts:119`, `src/core/locks/names.ts:9-22`, `AGENTS.md:17`
- **Estado:** resuelta en el commit «fix(pruebas): tope de workers de Vitest al 50 % de la CPU» (sobre 5f64877). Se aplicó el cambio 1 (`maxWorkers: '50%'`, probado en `tests/config/vitest-workers.test.ts`). El reparto de `VITEST_MAX_WORKERS` por concurrencia queda pendiente hasta medir con la CPU libre.

## Cómo ocurre
El gate de este repo es `npm run -s check`, que encadena typecheck, lint, `vitest run` y los dos builds
(`package.json`, script `check`). La flota lo corre en tres sitios, y en dos de ellos no hay nada que impida que
coincida con otro:

1. **El autor**, dentro de su worktree. `AGENTS.md:17` le pide a cada agente validar con
   `scripts/win.sh npm run -s check`.
2. **El gate previo a la revisión** (añadido hoy en 802963d). `src/core/orchestrator/fleet.ts:533` llama a
   `#runGate`, y este llega a `src/core/app/workspaces.ts:144`:
   ```ts
   const results = await runCommands(project.gate, workspace.path, signal, { untrustedRoots: [project.worktreesRoot] });
   ```
   No hay candado ni cola. Cada tarea activa corre su gate cuando le toca.
3. **El gate de integración** (`src/core/workspace/integrate.ts:119`). Este sí va en serie, pero solo por repositorio
   (`src/core/workspace/manager.ts:166`: `this.serial(\`integrate:${repoKey(...)}\`, ...)`), no frente a los gates
   previos ni frente a los checks de los autores.

La cola deja correr 3 tareas a la vez (`src/core/app/fleet-service.ts:126`: `concurrency: tuning.concurrency ?? 3`,
y `DEFAULT_SETTINGS.concurrency: 3` en `src/shared/api.ts:74`). Desde Ajustes se puede subir hasta 8
(`src/shared/api.ts:60`: `z.number().int().min(1).max(8)`).

En cada `vitest run` (Vitest 4.1.12) el número de workers sale de
`node_modules/vitest/dist/chunks/cli-api.B0Pz1_R7.js:3832-3838`:
```js
function resolveMaxWorkers(project) {
	if (project.config.maxWorkers) return project.config.maxWorkers;
	if (project.vitest.config.maxWorkers) return project.vitest.config.maxWorkers;
	const numCpus = typeof nodeos.availableParallelism === "function" ? nodeos.availableParallelism() : nodeos.cpus().length;
	if (project.vitest.config.watch) return Math.max(Math.floor(numCpus / 2), 1);
	return Math.max(numCpus - 1, 1);
}
```
El pool por defecto es `forks` (`coverage.DM_a_rWm.js:180`: `resolved.pool ??= "forks"`), así que cada worker es un
`node.exe` aparte. Este equipo tiene 8 procesadores lógicos (`%NUMBER_OF_PROCESSORS%` = 8), y hay 162 archivos de
prueba fuera de `tests/live`. Por eso cada suite abre 7 forks.

`vitest.config.ts:9-17` no fija `maxWorkers` ni `fileParallelism`, y nada en `package.json` ni en `src/` define
`VITEST_MAX_WORKERS` (lo busqué en todo el repo sin `node_modules` y no aparece).

Pasos para que ocurra:
1. Se aprueban tres tareas de este repo. La cola las arranca a la vez.
2. Dos autores corren su `npm run -s check` mientras la tercera tarea ya está en el gate previo (`fleet.ts:533`).
   Son tres `vitest run` a la vez: 3 × 7 = 21 forks, más los 3 procesos principales de Vitest, los `git.exe` de las
   pruebas de `tests/core/workspace/repos.test.ts` y Defender revisando cada proceso nuevo, todo en 8 hilos.
3. Las pruebas se alargan tanto que vencen los topes cortos (ver `pruebas-01-ui-waitfor-timeout-1s.md`), y el gate
   falla sin que el cambio tenga la culpa. La tarea vuelve al autor con «La verificación del proyecto (gate) falló»
   (`fleet.ts:423-424`), gastando un intento.

El propio proyecto ya vio este síntoma. `vitest.config.ts:13-16` dice:
```ts
// 60 s: con la flota corriendo pruebas en paralelo en 4 núcleos, pruebas de 1 s llegaron a tardar 20 s.
// Una prueba colgada de verdad sigue fallando.
testTimeout: 60_000,
hookTimeout: 60_000,
```
Ante eso se subieron los topes, pero la concurrencia que causa la carga quedó igual.

## Por qué pasa
- La configuración de Vitest no pone tope a los workers, así que cada suite toma `availableParallelism() - 1`, como
  si fuera la única en el equipo.
- El núcleo no coordina las suites entre worktrees. El gate previo (`workspaces.ts:144`) y el de integración
  (`integrate.ts:119`) no piden ninguno de los candados de CPU que el propio núcleo ya conoce
  (`src/core/locks/names.ts:9` y `:16-19`: pool `heavy-cpu` con `heavy-cpu-1` y `heavy-cpu-2`).
- Los checks de los autores (`AGENTS.md:17`) corren fuera de todo control del núcleo.

## Solución posible
Son dos cambios chicos que se complementan:

1. **`vitest.config.ts`**: añadir `maxWorkers: '50%'` dentro de `test`. Vitest 4 acepta porcentajes y los redondea
   sobre `availableParallelism` (`coverage.DM_a_rWm.js:24-26` y `:152`). En este equipo da 4 workers en lugar de 7.
   Una suite sola sigue usando media CPU.
2. **Núcleo**: limitar aún más los workers cuando hay varias tareas, usando la variable que Vitest ya lee,
   `VITEST_MAX_WORKERS`. Esta variable se aplica después de la configuración (`coverage.DM_a_rWm.js:380`:
   `if (process.env.VITEST_MAX_WORKERS) resolved.maxWorkers = Number.parseInt(...)`), así que no hace falta inventar
   una propia como `ORQ_TEST_WORKERS`. El núcleo puede ponerla en el `env` de los comandos del gate
   (`resolveLaunch`/`runCommand` en `src/core/workspace/commands.ts`), por ejemplo
   `max(1, floor((availableParallelism() - 1) / concurrency))`. Para que llegue también a los agentes, se pasa en el
   entorno de sus sesiones. Esto funciona porque `childEnv` (`src/core/process/child-env.ts:21-31`) hereda el entorno
   del núcleo y solo quita credenciales. Solo acepta números enteros, no porcentajes.

### Otras opciones
- **Serializar los gates con candado**: envolver `verify` (`workspaces.ts:138-146`) y el gate de `integrate.ts:119`
  con `withLock` sobre el pool `heavy-cpu` (`src/core/locks/index.ts:27`, `names.ts:16-19`). Así nunca corren más de
  dos suites pesadas del núcleo a la vez, y tampoco chocan con builds o renders de otros agentes que respeten la
  skill `local-compute-scheduling`. A cambio, el gate espera en cola y un candado retenido largo lo frena. Ojo: la
  propuesta original habla de candados `cpu` o `build`, pero no existen. Los nombres reales son `heavy-cpu-1` y
  `heavy-cpu-2`.
- **Separar el check**: un `check:quick` (typecheck, lint y pruebas sin git real) para los autores en `AGENTS.md`, y
  el `check` completo solo para el gate del núcleo. Así cada tarea corre menos suites completas.
- **Aislar `repos.test.ts`**: la propuesta original sugiere `poolOptions.forks.singleFork`, pero Vitest 4 quitó
  `poolOptions` (`coverage.DM_a_rWm.js:179` lo marca como obsoleto). Lo equivalente en Vitest 4 sería un proyecto
  aparte con `maxWorkers: 1` o `fileParallelism: false` solo para las pruebas que lanzan git.

Ninguna opción sola es la definitiva. El tope en la configuración es lo más barato. Repartir los workers según
`concurrency` o usar un candado ataca la causa (que varias suites coincidan) y escala mejor si el usuario sube la
concurrencia a 8. Una medición con la CPU libre debería decidir entre ellas.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta:
  - `tests/config/vitest-workers.test.ts`: importa `vitest.config.ts` y afirma que `config.test.maxWorkers` está
    definido y que, resuelto sobre `os.availableParallelism()`, no pasa de la mitad.
  - Si se reparte por concurrencia: en `tests/core/workspace/launch.test.ts`, comprobar que `resolveLaunch` (o la
    función que arme el env del gate) devuelve `VITEST_MAX_WORKERS` entero y ≥ 1, con valores de concurrencia 1, 3
    y 8 y CPUs simuladas de 4 y 8.
  - Si se usa candado: en `tests/integration/project-workspaces.test.ts`, lanzar dos `verify()` a la vez con un
    gate falso (`node -e` que escribe el inicio y el fin en un archivo y espera 300 ms) y `ORQ_LOCKS_ROOT` en una
    carpeta temporal. Afirmar que los intervalos no se solapan más de lo que permite el pool (2).
- Comando para correrla (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/config/vitest-workers.test.ts tests/core/workspace/launch.test.ts"`
  (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/config/vitest-workers.test.ts`).
- Verificación manual (con la CPU libre): lanzar dos `npx vitest run` en paralelo, antes y después del cambio.
  Comparar el tiempo total, el pico de `node.exe` en `tasklist /fi "imagename eq node.exe"` y las pruebas vencidas.
  Después, aprobar tres tareas del repo en Berland y confirmar en el detalle que ningún gate falla por
  «tiempo agotado» o por un `waitFor`.
