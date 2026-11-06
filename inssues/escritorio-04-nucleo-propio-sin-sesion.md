# Si `session.json` no se guarda, el núcleo que lanzó Berland queda huérfano y la próxima apertura dice que «no lo abrió Berland»

- **Área:** Escritorio y arranque
- **Severidad:** baja
- **Archivos:** `apps/desktop/src/core-supervisor.ts:233`, `apps/desktop/src/core-supervisor.ts:294-313`, `apps/desktop/src/core-supervisor.ts:284-292`, `apps/desktop/src/core-supervisor.ts:162-184`, `apps/desktop/src/core-supervisor.ts:208-216`, `apps/desktop/src/core-supervisor.ts:229-230`, `apps/desktop/src/lib/shutdown-policy.ts:24-27`, `src/core/app/cli-commands.ts:121-124`, `src/core/memory/safe-fs.ts:77-91`
- **Estado:** resuelta

## Cómo ocurre

Cuando Berland lanza el núcleo, la única prueba de que es suyo es `session.json` en `%LOCALAPPDATA%\orquestador`. Ese archivo guarda cifrados con `safeStorage` el token, el pid y el puerto (`apps/desktop/README.md:15` y `:21`). El token es aleatorio en cada arranque (`src/core/server/security.ts:11-13`) y el núcleo solo lo imprime por stdout (`src/core/app/cli-commands.ts:121-124`). Berland lee esa salida por una tubería y descarta el resto (`core-supervisor.ts:229-230`, `stdout.on('data', () => undefined)`), así que el enlace `web:` no queda en ningún lado.

La escritura de la sesión se intenta una sola vez y, si falla, solo se registra:

```ts
// apps/desktop/src/core-supervisor.ts:296-312
if (!cipher) { log('safeStorage no está disponible: …'); return; }
try {
  …
  const tmp = `${config.sessionPath}.${process.pid}.tmp`;
  …
  renameSync(tmp, config.sessionPath);
} catch (err) {
  log(`no se pudo guardar la sesión: …`);
}
```

`launch` no mira el resultado: llama a `writeSession` (`:233`) y devuelve el núcleo conectado como `launched` (`:235`). La ventana no avisa de nada (`main.ts:232-237`).

Pasos:

1. Berland lanza el núcleo. `renameSync` (`:309`) falla con EPERM, EACCES o EBUSY porque el antivirus tiene abierto el `.tmp` recién cerrado, o porque algo tiene abierto `session.json` en ese momento. El propio repo describe este fallo de Windows en `src/core/memory/safe-fs.ts:77-79` («el antivirus … abre un instante el archivo recién escrito y `rename` sobre él falla con EPERM») y por eso ahí se reintenta. Aquí no hay reintento. El `.tmp`, que contiene el token cifrado, queda en disco, y como lleva el pid de Electron se suma uno por cada fallo. Hay dos variantes con el mismo final: que no haya cifrado (`cipher` null, `:296`; en Windows es poco probable) o que se borre el perfil `desktop\`, con lo que cambia la clave de `Local State` y `decodeSession` devuelve `null` (`session-file.ts:67-71`).
2. Se cierra la ventana con trabajo pendiente. `decideOnClose` deja vivo el núcleo (`shutdown-policy.ts:24-27`), y eso es lo correcto. Cuenta como pendiente cualquier tarea `ready`, `running`, `review` o `handed_off`, o un chat ocupado (`core-client.ts:16`, `:66-68`).
3. Al reabrir, el sondeo responde `alive` (`core-supervisor.ts:159`), `readSession` devuelve `null` (`:286` o `:289-290`) y `adopt` contesta:

```ts
// apps/desktop/src/core-supervisor.ts:178-183
title: `Ya hay un núcleo en 127.0.0.1:${port} que no abrió Berland`,
detail: '… ese núcleo se abrió de otra forma (por ejemplo con «iniciar» en una terminal).',
hint: 'Ciérralo (Ctrl+C en su terminal) … o abre la interfaz con el enlace que imprimió ese núcleo.',
```

Las tres frases son falsas en este caso. Ese núcleo lo lanzó Berland con `windowsHide: true` y `detached: true` (`:213-214`), así que no tiene consola ni terminal donde hacer Ctrl+C, y su enlace se perdió en la tubería. El núcleo no se apaga solo cuando queda inactivo, porque `iniciar` espera `waitForStop` (`cli-commands.ts:129-131`). Mientras siga vivo, ninguna apertura de Berland puede usarlo ni apagarlo. La única salida es buscar `node.exe` en el Administrador de tareas o reiniciar.

Las pruebas actuales cubren las dos mitades por separado, pero no la secuencia completa: «sin safeStorage … no guarda la sesión» (`tests/desktop/core-supervisor.test.ts:219-224`) y «un núcleo vivo sin sesión … la app explica qué pasa» (`:174-180`). Ninguna comprueba qué ve el usuario al reabrir después de que la sesión no se pudo guardar.

## Por qué pasa

- `writeSession` hace una sola escritura con `renameSync`, sin reintentos ante los errores transitorios de Windows. Si falla, no borra el `.tmp` y no avisa a quien la llamó (devuelve `void`).
- `launch` no distingue un núcleo cuya sesión quedó guardada de uno que la próxima apertura no podrá reconocer, así que el cierre lo trata igual y lo deja vivo.
- `adopt` da por hecho que todo núcleo vivo sin sesión válida se abrió desde una terminal, y su mensaje dice cómo cerrarlo en ese caso, no en este.

## Solución posible

1. `apps/desktop/src/core-supervisor.ts`, `writeSession`: reintentar el `rename` ante EPERM, EACCES o EBUSY con esperas crecientes, durante 1 a 2 s en total. Se puede usar `renameWithRetry` de `src/core/memory/safe-fs.ts:81` (el escritorio ya importa de `src/core`, ver `lib/config.ts:2`) haciendo `writeSession` asíncrona, ya que `launch` lo es. Si al final falla, borrar el `.tmp` con `rmSync(tmp, { force: true })` y devolver `false`.
2. Si `writeSession` devuelve `false` (o no hay `cipher`), marcar el núcleo conectado, por ejemplo con `sessionSaved: false` en `ConnectedCore`. En `onAppClose`, si es `launched`, la sesión no se guardó y hay trabajo en curso, avisar antes de dejarlo vivo: que la próxima apertura no podrá reutilizarlo y que conviene esperar a que termine o detenerlo ahora. Basta un `dialog.showMessageBox` en `main.ts` con «Detener núcleo» y «Dejarlo vivo».
3. En `adopt` (`:177-183`), cambiar el texto para que no afirme lo que no sabe. Por ejemplo: «Berland no tiene el token de ese núcleo: lo abrió otro programa o una apertura anterior que no pudo guardar su sesión. Si lo abriste en una terminal, ciérralo con Ctrl+C; si no, ciérralo en el Administrador de tareas (proceso node.exe) y vuelve a abrir Berland».

### Otras opciones

La propuesta no es la única, y quizá no sea la mejor:

- **Reconocer el núcleo sin la sesión cifrada.** En `adopt`, averiguar qué PID escucha en el puerto (`Get-NetTCPConnection -LocalPort <puerto> -State Listen`) y leer su línea de órdenes (`Get-CimInstance Win32_Process`). Si es `node.exe …\src\core\app\cli.ts iniciar` dentro de `repoRoot`, ofrecer «Detener ese núcleo». Comprobar la línea de órdenes mantiene la garantía de `README.md:21`, que Berland nunca mate otro proceso, aunque el pid no venga del archivo cifrado.
- **Marcador del propio núcleo.** El núcleo lanzado por el escritorio escribe en `dataDir` un `core.lock` con su pid, la hora de arranque y un hash del token (nunca el token). Con eso Berland lo reconoce y, junto con la comprobación anterior, puede apagarlo. Así no se depende de `safeStorage` y la escritura queda en el núcleo, que ya tiene `writeFileAtomic` con reintentos.
- **Canal de apagado local.** Un `POST /shutdown` autenticado de otra forma, por ejemplo con un secreto de un solo uso en un archivo con ACL del usuario. Es más trabajo y agranda la superficie de ataque.

Las dos primeras resuelven también el caso del perfil `desktop\` borrado, que los reintentos del punto 1 no cubren.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta, en `tests/desktop/core-supervisor.test.ts`:
  1. *Renombre transitorio:* inyectar en `SupervisorDeps` una función de renombre que lance un error con `code: 'EPERM'` las dos primeras veces y luego delegue en la real. Lanzar contra `fake-core` con `fakeSpawn('ready')` y comprobar que `config.sessionPath` existe, que `decodeSession` lo lee con el token correcto y que en `config.dataDir` no queda ningún `session.json.*.tmp`.
  2. *Renombre que siempre falla:* el mismo montaje, pero con un renombre que siempre da EPERM (o una carpeta creada en `config.sessionPath`). Comprobar que no queda `.tmp`, que el núcleo conectado lleva la marca de sesión no guardada y que `onAppClose` con `running > 0` devuelve la decisión o aviso nuevos.
  3. *Reapertura:* después del caso 2 (o con `cipher: null`), crear un segundo `supervisor({ fetch: fakeFetch({ up: true, running: 1 }) })` y llamar a `connect()`. Comprobar que `hint` y `detail` ya no dicen solo «Ctrl+C en su terminal» y que mencionan el Administrador de tareas. Si se adopta la opción del PID, comprobar que devuelve la acción de detener cuando una función inyectada que lee la línea de órdenes del proceso en escucha dice `cli.ts iniciar` dentro de `repoRoot`.
- Comando para correrla (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/desktop/core-supervisor.test.ts"` (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/desktop/core-supervisor.test.ts`).
- Verificación manual en la app:
  1. Abrir Berland y dejar una tarea en `ready` o `running`.
  2. Antes de abrir, crear una carpeta llamada `session.json` en `%LOCALAPPDATA%\orquestador`. Con eso el `rename` falla siempre.
  3. Cerrar la ventana.
  4. Hoy: al reabrir sale «Ya hay un núcleo … que no abrió Berland … Ctrl+C en su terminal», no hay terminal y `escritorio.log` dice «no se pudo guardar la sesión». Después del arreglo: el aviso aparece al cerrar, y al reabrir el mensaje indica cómo cerrarlo o lo ofrece detener.
  5. Al terminar, borrar la carpeta `session.json`.
