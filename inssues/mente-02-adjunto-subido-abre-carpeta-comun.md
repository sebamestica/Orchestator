# Adjuntar un archivo subido (no imagen) abre a la mente la carpeta común de adjuntos de todos los chats y proyectos

- **Área:** Mente y chat
- **Severidad:** media
- **Archivos:** `src/core/chat/attachments.ts:157`, `src/core/app/f5-chat.ts:92`, `src/core/chat/service.ts:443-447`, `src/core/chat/service.ts:616-624`, `src/core/chat/service.ts:647-649`, `src/core/chat/service.ts:718-721`, `src/core/conductor/session.ts:303-310`, `src/core/conductor/session.ts:372`, `src/core/conductor/guard.ts:129-142`, `src/core/conductor/guard.ts:168-171`
- **Estado:** resuelta

## Cómo ocurre

Contexto: la mente (y sus subagentes, como `investigador`) leen con Read, Grep y Glob. La barrera es el hook
`PreToolUse` de `createToolGuard`, que permite leer dentro de `cwd` y de las raíces extra (`readRoots`). En el chat,
cada archivo adjunto que no es imagen agrega **su carpeta** a esas raíces para que la mente pueda leerlo.

Las subidas (`POST /attachments`) no guardan cada archivo en una carpeta propia. Todas quedan en la misma carpeta
plana del núcleo, sin importar el chat o el proyecto:

- `src/core/app/f5-chat.ts:92`: `new AttachmentStore({ db, dir: join(comp.config.dataDir, 'attachments'), ... })`
- `src/core/chat/attachments.ts:157`: `const file = path.join(this.dir, \`${id}-${name}\`);`

Suben por esta vía la interfaz web y, en Electron, los archivos que no tienen ruta en disco (pegados del
portapapeles): `src/ui/features/chat/store.ts:62-65` usa `/attachments/by-path` solo si `pathForFile` devuelve una
ruta; si no, `api.upload('/attachments', ...)`.

Al enviar, la carpeta del archivo pasa a ser raíz de lectura del chat:

```ts
// src/core/chat/service.ts:443-447
for (const f of files) {
  const root = path.dirname(f.path);          // para una subida: <dataDir>/attachments
  if (!live.roots.has(root)) addedRoots.push(root);
  live.roots.add(root);
}
```

Esa raíz no se cierra después del turno. `#liveOf` la reconstruye desde todos los adjuntos del chat cuando se recrea
el estado vivo (`service.ts:619-624`, `.filter((a) => a.kind !== 'image').map((a) => path.dirname(a.path))`).
`#rootsFor` la suma en cualquier modo, también en `plan` (`service.ts:647-649`). La sesión la pasa a la guardia
(`service.ts:718-721` → `session.ts:303-310`) y a `additionalDirectories` del SDK (`session.ts:372`).

La guardia solo comprueba que la ruta quede dentro de alguna raíz (`guard.ts:129-142`), y para Glob y Grep mira
`args.path` y la parte fija del patrón (`guard.ts:168-171`). `mindDenyPaths` (`src/core/app/conductor.ts:124-128`)
protege la bóveda, la base y la memoria, pero no `<dataDir>/attachments`.

Pasos:

1. En el chat del proyecto `marketing` el usuario sube `contrato.pdf` (web) y lo envía. Queda en
   `<dataDir>/attachments/<uuid1>-contrato.pdf`.
2. En el chat del proyecto `orquestador` sube `notas.txt` y lo envía. El mensaje a la mente dice
   `Adjuntos: <dataDir>/attachments/<uuid2>-notas.txt` (`composeUserText`, `service.ts:216-218`), así que la mente
   conoce la carpeta.
3. Desde ese momento, en ese chat de `orquestador`, la mente o su `investigador` pueden hacer
   `Glob { path: '<dataDir>/attachments', pattern: '*' }` y `Read` o `Grep` sobre `<uuid1>-contrato.pdf`. La guardia
   lo permite: la ruta está dentro de una raíz. También quedan legibles las imágenes pegadas en otros chats, que se
   guardan en la misma carpeta.

Es el mismo tipo de fuga entre proyectos que cerró el issue 9 (`docs/plan/issues/09-aislamiento-contexto.md`, punto 4:
el `investigador` hacía `Glob **/*.md` en la memoria de todos los proyectos). Ese issue cerró la memoria con
`denyPaths`, pero no tocó los adjuntos.

La prueba actual solo cubre el adjunto por ruta (`tests/core/chat/service.test.ts:394`,
«archivo por ruta: … su carpeta entra en readRoots»). Ninguna prueba cubre una subida que no sea imagen ni lo que
abre su carpeta.

## Por qué pasa

Para dar acceso a un adjunto se abre la carpeta que lo contiene (`path.dirname(f.path)`). Con un archivo por ruta,
esa carpeta es del usuario y la eligió él. Con una subida, la carpeta es el almacén compartido de todos los chats y
proyectos (`<dataDir>/attachments`). Abrirla da acceso a todas las subidas, no solo a la del chat.

## Solución posible

Hacer que la raíz de una subida sea solo suya, sin cambiar lo que ya funciona para los archivos por ruta:

1. `src/core/chat/attachments.ts` (`upload`, línea 155-158): guardar cada subida en su propia subcarpeta,
   `path.join(this.dir, id, name)`, con `mkdir(path.join(this.dir, id), { recursive: true })`. `remove` (línea 209-214)
   borra la subcarpeta (`rm(path.dirname(a.path), { recursive: true, force: true })` si está dentro de `this.dir`
   y `source === 'upload'`). Actualizar la descripción de la ruta en `src/core/chat/routes.ts:272`.
2. `src/core/chat/service.ts`: sacar a una función la raíz de un adjunto y usarla en `send` (443-447) y en `#liveOf`
   (619-624):
   - `source === 'path'`: `path.dirname(a.path)`, como ahora;
   - `source === 'upload'` con la forma nueva (`dirname` distinto de `attachments.dir`): esa subcarpeta;
   - `source === 'upload'` antiguo (carpeta plana): el archivo mismo como raíz. `within` ya acepta un archivo como raíz
     (`rel === ''`, `guard.ts:131-132`), pero ese archivo no debe ir a `additionalDirectories`, que espera carpetas.
     Hay que filtrar las raíces que no son carpetas antes de `session.ts:372`, o pasarlas aparte solo a la guardia.

Así `additionalDirectories` sigue recibiendo solo carpetas, y la guardia solo deja leer el adjunto del chat.

### Otras opciones

- **El archivo como raíz para todas las subidas**, sin subcarpetas (es lo que proponía el reporte). Cambia menos
  disco, pero obliga a separar las raíces de la guardia de `additionalDirectories` en `ConductorSession` (hoy son la
  misma lista, `session.ts:303-304` y `372`). Además depende de que la regla `Read` de `allowedTools` baste para
  que el SDK lea un archivo fuera de sus directorios en `permissionMode: 'dontAsk'`. Hay que confirmarlo con una
  prueba del SDK real.
- **Una carpeta por chat** (`<dataDir>/attachments/<chatId>/…`). Pide que `POST /attachments` reciba el `chatId`,
  y hoy la subida pasa antes de asociar el adjunto a un chat (un mismo adjunto puede ir a varios chats, ver la
  prueba «borrar el chat borra las copias subidas que solo usaba él»). Por eso es menos directa.
- **No abrir ninguna raíz para las subidas** y entregar su contenido en el mensaje (texto incrustado o bloque
  `document` para PDF). Cierra la fuga sin tocar la guardia, pero cambia cómo la mente recibe los archivos y su
  costo en tokens.
- Cualquiera de las opciones con raíz propia recrea la sesión (reanudada) en cada envío con una subida nueva, porque
  la clave de forma incluye `roots` (`service.ts:672`). Hoy eso pasa solo con la primera subida. Si molesta, se
  puede sacar de la clave lo que solo afecta a la guardia (que ya lee las raíces en cada llamada) y dejar en ella
  solo lo que va a `additionalDirectories`.

La propuesta no es la única. La de subcarpetas parece la más simple porque mantiene la regla «raíz = carpeta» en
toda la cadena.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta: en `tests/core/chat/service.test.ts`, bloque `ChatService: adjuntos`, un caso
  «una subida abre solo su propio archivo, no los de otros chats»:
  1. `const b = await bench()`; `b.store.putProject({ id: 'otro', name: 'Otro', repoPath: <carpeta temporal> })`.
  2. `chatA = b.service.create({ projectId: 'demo' })`, `chatB = b.service.create({ projectId: 'otro' })`.
  3. `a = await b.attachments.upload({ name: 'a.pdf', mime: 'application/pdf', bytes: ... })`, enviarlo en `chatA`
     y `settle`. Luego `bb = await b.attachments.upload({ name: 'b.txt', mime: 'text/plain', bytes: ... })`, enviarlo
     en `chatB` y `settle`.
  4. Con la guardia de la última sesión de B (`guardOf(optionsOf(b))`):
     - `Read { file_path: a.path }` debe dar `false` (hoy da `true`);
     - `Glob { path: b.attachments.dir, pattern: '*' }` y `Grep { path: b.attachments.dir, pattern: 'x' }` deben dar
       `false` (hoy `true`);
     - `Read { file_path: bb.path }` debe seguir en `true`.
  5. Comprobar que `optionsOf(b).additionalDirectories` no contiene `b.attachments.dir` y que solo tiene carpetas
     (cada entrada existe y es un directorio).
  6. Una subida antigua en la carpeta plana (insertar a mano un adjunto `source: 'upload'` con
     `path: join(b.attachments.dir, 'x-viejo.txt')`) también se lee y no abre la carpeta común.
  - En `tests/core/chat/attachments.test.ts`: `upload` deja el archivo en `<dir>/<id>/<nombre>` y `remove` borra la
    subcarpeta.
- Comando para correrla (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/chat/service.test.ts tests/core/chat/attachments.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/chat/service.test.ts tests/core/chat/attachments.test.ts`).
- Verificación manual en la app: en la interfaz web, subir un `.txt` en el chat de un proyecto y enviarlo. En el chat
  de otro proyecto, subir otro `.txt`, enviarlo y pedir a la mente: «lista los archivos de la carpeta de tus
  adjuntos». La guardia debe negar el Glob sobre `<dataDir>/attachments`, y la mente no debe ver el archivo del otro
  proyecto. Leer el adjunto propio debe seguir funcionando.
