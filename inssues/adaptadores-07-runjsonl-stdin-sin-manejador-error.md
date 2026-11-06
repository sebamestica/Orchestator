# runJsonl escribe el encargo en stdin sin oyente de 'error': un EPIPE o EOF tumba el núcleo

- **Área:** Adaptadores de agentes (proceso hijo común: `runJsonl`, usado por el adaptador de Codex)
- **Severidad:** baja
- **Archivos:** `src/core/process/run-jsonl.ts:69`, `src/core/process/run-jsonl.ts:77`, `src/core/process/run-jsonl.ts:78`, `src/core/adapters/codex-cli/index.ts:190`, `src/core/adapters/codex-cli/index.ts:193`, `src/core/adapters/codex-cli/executable.ts:9`, `src/shared/tasks.ts:9`, `src/shared/api.ts:530`, `apps/desktop/src/main.ts:227`
- **Estado:** abierta

## Cómo ocurre

`runJsonl` lanza los CLI de la flota con tres pipes. Su único usuario que manda datos por stdin es el adaptador de
Codex: lanza `node codex.js exec --json … -` y le pasa el encargo completo (el brief más la sección de plugins) por
stdin.

```ts
// src/core/adapters/codex-cli/index.ts:190-193
for await (const line of this.runner({ command: this.executable.command,
  args: [...this.executable.args, 'exec', '--json', …, '-'],
  cwd: ctx.worktreePath, stdin: section ? `${brief}\n\n${section}\n` : brief,
```

`runJsonl` escribe ese texto y cierra el pipe. Solo registra oyentes de `'error'` en el proceso (`child.on('error')`,
línea 69), no en `child.stdin`:

```ts
// src/core/process/run-jsonl.ts:69 y 77-78
child.on('error', (err) => { push({ kind: 'stderr', line: `spawn error: ${err.message}` }); });
…
if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
else child.stdin.end();
```

En Windows, libuv crea el pipe de stdin del hijo con un búfer de unos 64 KiB. Si el encargo cabe, la escritura termina
enseguida y no hay riesgo. Si no cabe, la escritura queda pendiente hasta que el hijo lea. Cuando el hijo muere antes
de leerlo todo, la escritura pendiente falla con `write EPIPE` o `write EOF`, y `child.stdin` (un `net.Socket`) emite
`'error'`. Un `'error'` sin oyente en un `EventEmitter` se lanza como excepción no capturada.

Pasos:

1. El encargo para Codex pasa de 64 KiB en UTF-8. Es poco común, pero posible: el objetivo de una tarea no tiene tope
   (`src/shared/tasks.ts:9`, `objective: z.string().min(1)`), `withFeedback` le agrega las observaciones de cada ronda
   (`src/core/orchestrator/fleet.ts:877-886`), y en una tarea manual el tope es de 20 000 unidades UTF-16
   (`src/shared/api.ts:530`), que con texto CJK o emojis pegados ya son entre 40 y 60 KB.
2. El hijo directo (`node codex.js`, `executable.ts:9`) termina antes de leer stdin. Puede pasar de tres formas.
   Una es que el usuario cancele o venza el plazo durante el arranque: `kill()` usa `taskkill /T /F`
   (`run-jsonl.ts:44`), y con Defender cargando la CPU el arranque de Node tarda más. Otra es que el envoltorio
   falle antes de lanzar el binario nativo: `codex.js` lanza
   `Missing optional dependency …` en su línea 107. La última es que el binario nativo salga por un error de argumentos.
3. La escritura pendiente falla, `child.stdin` emite `'error'` y nadie lo escucha. El `try/catch` de
   `codex-cli/index.ts:221` no lo atrapa, porque el error sale de un callback del bucle de eventos y no de la cadena de
   `await` del generador.
4. No hay `process.on('uncaughtException')` ni en `src` ni en `apps` (lo comprobé con grep). El proceso del núcleo
   cae y arrastra al servidor (127.0.0.1:47811), a la mente y a todas las tareas en curso. La app de escritorio no lo
   relanza: solo muestra «El núcleo se detuvo» y pide volver a abrir Berland (`apps/desktop/src/main.ts:227-228`,
   `apps/desktop/src/core-supervisor.ts:246-251`).

El resto del código que escribe al stdin de un hijo ya se protege, así que `runJsonl` es la excepción:

- `src/core/adapters/codex-cli/app-server.ts:40`: `child.stdin.on('error', () => finish(…))`
- `src/core/plugins/chrome-gate.ts:292`: `child.stdin.on('error', () => undefined)`
- `src/core/plugins/mcp-probe.ts:128`: `child.stdin.on('error', () => { /* … lo informa 'exit' */ })`
- `src/core/vault/dpapi.ts:106`: `child.stdin.on('error', () => { /* … lo informa 'close' */ })`

## Por qué pasa

En `runJsonl` (`src/core/process/run-jsonl.ts:77`) falta un oyente de `'error'` en `child.stdin`. El fallo de
escritura es un evento normal cuando el hijo sale antes de leer, pero sin oyente se convierte en una excepción no
capturada a nivel de proceso. El caso exige un encargo grande y un hijo que muera en una ventana corta, así que es
raro. Cuando ocurre, el daño es total.

## Solución posible

En `src/core/process/run-jsonl.ts`, registrar el oyente antes de escribir (entre las líneas 75 y 77):

```ts
// El hijo pudo salir sin leer todo el encargo (EPIPE/EOF): lo informa 'exit'; no debe tumbar el núcleo.
child.stdin.on('error', (err) => { push({ kind: 'stderr', line: `stdin: ${err.message}` }); });
if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
else child.stdin.end();
```

La línea `stderr` llega al adaptador de Codex como evento `raw`, porque `classifyCodexError` no la reconoce
(`codex-cli/index.ts:211-213`). El fallo real ya lo informa el `exit` con código distinto de 0
(`codex-cli/index.ts:195-200`). Si el `'error'` llega después del `close`, el elemento queda en la cola sin efecto,
porque el generador ya terminó.

### Otras opciones

- Ignorar en silencio `EPIPE` y `EOF` (`if (code !== 'EPIPE' && code !== 'EOF') push(…)`), como hacen
  `chrome-gate.ts:292` y `mcp-probe.ts:128`. Hay menos ruido en el registro, pero se pierde la pista de por qué Codex
  no recibió el encargo completo.
- Hacer lo mismo que agy (`src/core/adapters/agy-cli/index.ts:200-205`): escribir el encargo en
  `.orq/BRIEF-<id>.md` y pasarle a Codex un prompt corto por stdin que lo cite. Así el stdin queda siempre por debajo
  del búfer y el problema desaparece de raíz. Además, el agente puede releer el encargo si pierde el hilo. La
  desventaja es que Codex tiene que leer un archivo más, y su comportamiento con un prompt indirecto habría que
  validarlo.
- Poner un tope al objetivo en `taskBriefSchema` o al encargo renderizado, y avisar si se supera. Eso evita encargos
  desmedidos, pero no quita la necesidad del oyente, porque cualquier otro fallo de escritura seguiría tumbando el
  proceso.
- Agregar un `process.on('uncaughtException')` en el arranque del núcleo que registre el error y siga. Sirve de red
  general, pero tapa errores de verdad y deja el estado sin definir. No reemplaza al oyente local.

Lo más sólido es combinar el oyente en `runJsonl` con el encargo en un archivo, como hace agy. La propuesta de arriba
es el cambio mínimo, no la única salida.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta: en `tests/core/run-jsonl.test.ts`, un caso nuevo que lance un hijo que sale sin
  leer stdin y le mande un stdin muy superior al búfer del pipe. Se repite unas veces para cubrir la carrera entre la
  rotura del pipe y el aviso de salida:

  ```ts
  it('no cae si el hijo sale sin leer un stdin grande', async () => {
    for (let i = 0; i < 5; i++) {
      const items = await collect(runJsonl({ command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: process.cwd(), stdin: 'x'.repeat(2_000_000) }));
      expect(items.at(-1)).toMatchObject({ kind: 'exit', code: 0, timedOut: false, aborted: false });
    }
  });
  ```

  Sin el arreglo, Vitest informa un «Unhandled Error» (`write EOF` o `write EPIPE`) y la ejecución falla aunque la
  afirmación pase. Con el arreglo pasa limpia. Si se elige informar el error, se puede afirmar además que, cuando
  aparece una línea `stderr` que empieza por `stdin:`, va antes del `exit`.
- Comando para correrla (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/run-jsonl.test.ts"`
  (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/core/run-jsonl.test.ts`).
- Verificación manual en la app: crear una tarea manual para Codex con un objetivo de más de 64 KiB (por ejemplo,
  20 000 caracteres CJK) y cancelarla apenas pase a «running». El núcleo debe seguir vivo: la tarea queda
  cancelada, el servidor sigue respondiendo y la interfaz no muestra «El núcleo se detuvo».
