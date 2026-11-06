# runJsonl solo termina con 'close': si un proceso nieto hereda stdout, ni el plazo ni la cancelación lo liberan

- **Área:** Adaptadores de agentes (proceso hijo común: `runJsonl`)
- **Severidad:** media
- **Archivos:** `src/core/process/run-jsonl.ts:39`, `src/core/process/run-jsonl.ts:40`, `src/core/process/run-jsonl.ts:49`, `src/core/process/run-jsonl.ts:50`, `src/core/process/run-jsonl.ts:68`, `src/core/process/run-jsonl.ts:70`, `src/core/process/run-jsonl.ts:80`, `src/core/process/run-jsonl.ts:88`, `src/core/adapters/codex-cli/index.ts:160`, `src/core/adapters/codex-cli/index.ts:190`, `src/core/adapters/codex-cli/index.ts:226`, `src/core/adapters/codex-cli/index.ts:237`, `src/core/adapters/agy-cli/index.ts:221`, `src/core/adapters/agy-cli/index.ts:300`, `src/core/orchestrator/supervisor.ts:305`, `src/core/orchestrator/supervisor.ts:336`, `src/core/orchestrator/supervisor.ts:340`, `src/core/orchestrator/supervisor.ts:380`, `src/core/orchestrator/supervisor.ts:253`, `src/core/workspace/commands.ts:190`, `src/core/workspace/integrate.ts:119`, `src/core/quota/agy.ts:118`, `src/core/registry/detectors.ts:65`, `src/core/skills/tar.ts:19`
- **Estado:** abierta

## Cómo ocurre

`runJsonl` es el único lanzador de procesos que usan los adaptadores de Codex y agy, el gate y `postCreate`
(`runCommand`), el cupo de agy, el detector de `--version` y `tar`. Lanza el CLI con tres pipes y entrega su salida
línea a línea. Según su contrato, «siempre termina con un elemento `exit`».

En Node, `'exit'` se emite cuando el proceso termina. `'close'` llega después, cuando además se cerraron sus stdio.
Un pipe solo da EOF cuando se cierran todos los handles de su extremo de escritura, también los que heredó un
descendiente. Codex se lanza como `node codex.js` (`src/core/adapters/codex-cli/executable.ts:9`), y ese
`codex.js` lanza el binario nativo con `stdio: "inherit"` (`@openai/codex/bin/codex.js:241-242`), así que el
binario escribe en el mismo pipe que lee Berland. Cualquier proceso que el agente deje vivo y que haya heredado esos
handles mantiene el pipe abierto: un servidor de desarrollo en segundo plano, un demonio de compilación (MSBuild con
`nodeReuse`, VBCSCompiler) o un servidor MCP que sobrevive. En Windows, `CreateProcess` con `bInheritHandles`
reparte todos los handles heredables. En Linux pasa lo mismo con los fd sin `CLOEXEC`.

Pasos:

1. Codex (o agy) termina bien su turno. Ya emitió `usage` (turno confirmado) y el proceso directo sale. Un nieto
   sigue vivo con stdout o stderr heredados.
2. Node emite `'exit'` y fija `child.exitCode`, pero no emite `'close'`. `runJsonl` solo escucha `'close'`:

   ```ts
   // run-jsonl.ts:68-75
   let exited = false;
   child.on('close', (code, signal) => {
     exited = true;
     if (timer) clearTimeout(timer);
     opts.signal?.removeEventListener('abort', onAbort);
     push({ kind: 'exit', code, signal, timedOut, aborted });
   });
   ```

   El bucle `while (true)` (`run-jsonl.ts:80-90`) queda dormido para siempre en
   `await new Promise<void>((resolve) => { wake = resolve; })` (línea 88). La guardia `if (exited && …)` de la
   línea 87 no sirve, porque `exited` también depende de `'close'`.
3. Cuando vence el plazo (`run-jsonl.ts:49`) o llega la cancelación (`run-jsonl.ts:50`), los dos llaman a `kill()`,
   que no hace nada porque el hijo directo ya salió:

   ```ts
   // run-jsonl.ts:39-40
   const kill = () => {
     if (child.exitCode !== null) return;
   ```

   Aunque no existiera esa guardia, `taskkill /pid <pid> /T` sobre un PID ya muerto no encuentra el árbol.
4. El adaptador de Codex está dentro de `for await (const line of this.runner(...))`
   (`codex-cli/index.ts:190`) y nunca sale. Por eso no se ejecutan ni el saneado de `.orq/ultimo-mensaje.md`
   (`codex-cli/index.ts:226-236`) ni el `done` (`codex-cli/index.ts:237`). Tampoco corre el `finally` que libera los
   plugins (`codex-cli/index.ts:160-164`, `await grant.release()`): un generador asíncrono que está esperando no
   atiende `return()` hasta que se resuelve su `next()`. agy tiene el mismo patrón (`agy-cli/index.ts:221`) y retiene su
   `done` hasta el final (`agy-cli/index.ts:300`).
5. El Supervisor no recibe más eventos. Pasado el plazo por inactividad (por defecto 60 minutos,
   `supervisor.ts:13` y `supervisor.ts:305`), aborta, da `graceMs` de margen (5 s, `supervisor.ts:336`), abandona el
   iterador (`supervisor.ts:340`) y marca el intento como `timeout` (`supervisor.ts:380`), aunque Codex ya había
   confirmado el turno. En el primer fallo vuelve al mismo agente (`supervisor.ts:253`) en el mismo worktree,
   mientras el proceso huérfano sigue vivo. El generador abandonado queda pendiente en memoria con sus dos
   `readline` y el pipe abierto.

Esto no queda solo en los agentes. `runCommand` (`workspace/commands.ts:190`), que corre el gate y `postCreate`,
pasa `timeoutMs` y `signal` a `runJsonl` y no tiene otro plazo propio. Si un comando del gate deja un demonio con
stdout heredado, `integrate.ts:119` espera para siempre. `AgyQuotaProvider.read` (`quota/agy.ts:118`, plazo de
30 s), el detector de versión (`registry/detectors.ts:65`, 15 s) y `tar` (`skills/tar.ts:19`) tienen el mismo
riesgo: su plazo deja de valer en cuanto el hijo directo sale.

Ninguna prueba cubre el caso. `tests/core/run-jsonl.test.ts` solo prueba un proceso que sale limpio y un plazo
sobre un proceso que sigue vivo, donde `kill()` sí actúa. Ninguno de los issues 1 a 13 de `docs/plan/issues` toca
`run-jsonl.ts`: sus únicos commits son `e21f751` (base), `493a2df` y `2bb24de` (credenciales), todos anteriores
a los de hoy.

## Por qué pasa

`runJsonl` solo reconoce un fin: `'close'`. Su única salida de emergencia, `kill()`, supone que el hijo directo
sigue vivo. Si el proceso ya salió pero algún descendiente tiene abiertos sus pipes, nada hace avanzar el
generador. El plazo y la cancelación se ejecutan, pero no tienen efecto.

## Solución posible

En `src/core/process/run-jsonl.ts`:

1. Escuchar también `'exit'`. Al recibirlo, guardar `code` y `signal` y armar un plazo corto de drenaje (2 a 5 s,
   con `unref()`).
2. Si `'close'` no llega en ese plazo, destruir `child.stdout` y `child.stderr` (`destroy()`). Con eso los
   `readline` reciben `close`. Limpiar el `timer` y el listener de `abort` y hacer `push` del `exit` con el código ya
   conocido. Conviene marcarlo, por ejemplo con `orphanedStdio: true` en el tipo `JsonlLine` o con un `stderr`
   sintético que diga «stdio retenido por un proceso descendiente», para que los adaptadores emitan un `raw` y se vea
   el problema.
3. En `kill()`: si `child.exitCode !== null || child.signalCode !== null`, en vez de no hacer nada, cerrar los
   streams de inmediato con el mismo camino del punto 2, para que el plazo y la cancelación siempre terminen la
   iteración.
4. Un `exit` debe salir una sola vez: proteger con una bandera el caso en que `'close'` llega después del cierre
   forzado.

Con esto el adaptador sale del `for await`, sanea `ultimo-mensaje.md`, emite `done` y libera los plugins en su
`finally`. El Supervisor recibe el resultado real del turno en lugar de un `timeout` una hora después. No hace falta
tocar `codex-cli`, `agy-cli`, `commands.ts` ni `supervisor.ts`.

### Otras opciones

- **Job Object de Windows con `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`:** se lanza el CLI dentro de un job (con un
  ayudante nativo o un lanzador de PowerShell). Al terminar o cancelar se cierra el job y mueren todos los
  descendientes, incluido el huérfano que retiene el pipe. Es la solución más completa, porque además no deja procesos
  vivos en el worktree antes del reintento, pero suma una dependencia nativa o un salto por PowerShell.
- **Registrar los descendientes antes de que salga el hijo** (`Get-CimInstance Win32_Process` filtrando por
  `ParentProcessId`, repetido mientras corre) y matarlos al terminar o cancelar. Es más barato que un Job Object, pero
  no ve a los nietos cuyo padre ya murió y es frágil por la reutilización de PID.
- **Solo avisar:** emitir un `raw` cuando llega `'exit'` sin `'close'` tras N segundos. No arregla el cuelgue, pero lo
  hace visible.

La propuesta (drenaje con plazo y cierre forzado de los streams) es la más simple y basta para que el núcleo no se
quede colgado. No es la única. Lo ideal es combinarla con un Job Object para no dejar procesos huérfanos vivos en el
worktree, y esa parte puede quedar para otro issue.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta, en `tests/core/run-jsonl.test.ts` (sirve en Windows y en Linux):
  - **Escenario A (fin normal con nieto):** `runJsonl` sobre `node -e` con un script que lanza un nieto con
    `spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'inherit', detached: true }).unref()`,
    imprime `{"ok":true}` y sale con `process.exit(0)`. La prueba afirma que la colección termina en menos de unos
    segundos (`it(..., 15_000)`), que contiene el `json` `{ ok: true }` y que el último elemento es
    `{ kind: 'exit', code: 0 }`.
  - **Escenario B (plazo):** el mismo script con `timeoutMs: 1000`. Afirma que la iteración termina y entrega un
    solo `exit`.
  - **Escenario C (cancelación):** el mismo script con un `AbortController` abortado tras recibir el primer
    `json`. Afirma que la iteración termina y que el `exit` llega una sola vez.
  - En cada caso, guardar el PID del nieto (impreso por el script) y matarlo en `afterEach` (`process.kill(pid)`, o
    `taskkill /pid <pid> /T /F` en Windows) para no dejar procesos vivos.
  - Prueba de adaptador opcional en `tests/core/adapters/codex-cli/adapter.test.ts`: con un `runner` falso que entrega
    `usage` y el `exit` tras el cierre forzado, afirmar que llega `done` con `ok: true`.
- Comando (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/run-jsonl.test.ts"` (o desde
  PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/run-jsonl.test.ts`).
- Verificación manual en la app: encargar a Codex una tarea cuyo encargo deje un proceso en segundo plano (por
  ejemplo, `Start-Job { Start-Sleep 600 }` o un servidor de desarrollo sin `-Wait`) y termine. La tarea debe pasar a
  revisión o a terminada a los pocos segundos de que Codex confirme el turno, sin quedar «en curso» hasta el plazo
  por inactividad ni contarse como `timeout`.
