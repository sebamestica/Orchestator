# Read, Grep y Glob siguen enlaces y junctions sin comprobar la ruta real: salen del proyecto y esquivan `denyPaths`

- **Área:** Seguridad y corrección (revisión de Codex)
- **Severidad:** media
- **Archivos:** `src/core/conductor/guard.ts:137`, `src/core/conductor/guard.ts:168`, `src/core/conductor/guard.ts:227`, `src/core/adapters/claude-sdk/permissions.ts:49`, `src/core/adapters/claude-sdk/permissions.ts:98`, `src/core/adapters/claude-sdk/shell-policy.ts:62`, `src/core/memory/safe-fs.ts:58`
- **Estado:** abierta

## Cómo ocurre
Berland tiene dos guardias de herramientas para los agentes Claude:

- la de la mente (`createToolGuard`, en `src/core/conductor/guard.ts`), enganchada como hook `PreToolUse`
  (`src/core/conductor/session.ts:366`);
- la de los workers (`decideToolUse`, en `src/core/adapters/claude-sdk/permissions.ts`).

Las dos prometen dos cosas: las lecturas quedan dentro del proyecto o worktree y de las raíces extra, y las rutas de
`denyPaths` no se leen nunca. Esas rutas son la bóveda, `orquestador.db` con `-wal` y `-shm`, y la memoria de
Obsidian con las notas de todos los proyectos (`src/core/app/conductor.ts:124-128`). Para escribir, las guardias
siguen junctions y enlaces (`writeProblem` → `insideProblem` → `assertRealInside`, `shell-policy.ts:62-80`,
`safe-fs.ts:58-73`). Para leer, comparan solo el texto de la ruta.

Guardia de la mente, `guard.ts:141-145`:

```ts
const target = p.resolve(cwd, raw);
if (!inside(target)) return { allow: false, reason: `${tool}: solo puedes leer dentro del proyecto ...` };
if (SENSITIVE_FILE.test(p.basename(target)) || within(denied, target)) { ... }
return { allow: true };
```

`decide` aplica a Read, Grep y Glob solo esa parte síncrona y no mira el disco (`guard.ts:227`:
`if (!decision.allow || !isEditOrShell(toolName)) return decision;`). La guardia de los workers hace lo mismo
(`permissions.ts:49-54`: `lexicallyInside(worktree, abs)` y `lexicallyInside(path.resolve(r), abs)`).

**Caso 1: mente en modo `plan` o `auto` (sin shell ni edición, `session.ts:65-67`).** Aquí la guardia es la única
barrera de lectura.
1. La carpeta del proyecto tiene una junction o un enlace simbólico `referencias` → `D:\otra-carpeta`. Puede
   haberla creado el usuario, un enlace versionado en el repo (con `core.symlinks=true`) o un script. La política de
   shell niega `mklink`, `ln`, `New-Item -ItemType Junction` y `fsutil` (`shell-policy.ts:165-168`, `:729`), pero
   un script sí puede crearla. Ese riesgo residual está documentado en `shell-policy.ts:20-23`.
2. La mente pide `Read { file_path: "referencias/documento.txt" }`.
3. `p.resolve(cwd, raw)` da `<proyecto>\referencias\documento.txt`. Esa ruta está dentro de `cwd` en el texto, no
   coincide con `SENSITIVE_FILE` ni con `denied`, y se permite. El sistema operativo sigue la junction y entrega el
   archivo de `D:\otra-carpeta`.
4. Pasa lo mismo si la junction apunta a `C:\dev\orquestador-memoria`: la mente lee las notas de otros proyectos.
   Según `conductor.ts:126`, esas notas solo deberían leerse con `leer_memoria`, acotada al proyecto.

**Caso 2: modo `bypass`, sin crear ningún enlace.** En bypass las raíces de lectura incluyen todas las unidades
(`src/core/chat/service.ts:647-648`, `localDrives()` en `:184-196`), así que la pertenencia siempre se cumple. La
única barrera queda en `denyPaths`, y esa comparación es solo de texto. La carpeta de datos del núcleo está en
`%LOCALAPPDATA%\orquestador` (`src/core/config/config.ts:34-36`). Windows en español crea por defecto la junction
heredada `C:\Users\<usuario>\Configuración local` → `AppData\Local`. En este equipo existe (lo comprobé con
`ls -la` en el perfil; también están `Datos de programa` → `AppData\Roaming` y `Mis documentos` → `Documents`).
`Read { file_path: "C:\\Users\\<usuario>\\Configuración local\\orquestador\\vault.json" }` está dentro de `C:\`, no
está bajo `...\AppData\Local\orquestador\vault.json` en el texto, y `vault.json` no coincide con `SENSITIVE_FILE`.
La guardia lo permite. El contenido de la bóveda está cifrado con DPAPI, así que no salen secretos en claro, pero
la regla «nunca se leen» (`guard.ts:39`, `guard.ts:10-12`) no se cumple. Para `orquestador.db`, el resultado
depende de si la herramienta Read del SDK acepta archivos binarios, y eso no lo verifiqué.

**Workers.** `permissions.ts:98-116` tiene el mismo hueco con `Read`, `Grep`, `Glob` y `LS` en la junction `enlace`
que ya preparan las pruebas (`tests/core/adapters/claude-sdk/security.test.ts:28`). El impacto es menor porque la
política de shell solo vigila escrituras (`shell-policy.ts:5-18`), y un `cat` por Bash ya lee fuera del worktree.

**Pruebas actuales.** Las pruebas con junction real cubren solo la escritura
(`tests/core/conductor/guard.test.ts:179-188`, `tests/core/adapters/claude-sdk/security.test.ts:186-193`).
Ninguna lee a través de `enlace`. Ningún issue de `docs/plan/issues` lo trata. El 08 documenta como riesgo la
lectura por shell (`08-bypass-autonomo.md:128-129`) y el 09 documenta `Grep`/`Glob` sobre una carpeta que contiene
una ruta negada (`09-aislamiento-contexto.md:164-166`). La lectura con Read a través de enlaces no aparece en
ninguno de los dos.

## Por qué pasa
`checkPath` (`guard.ts:137-147`) y `readProblem` (`permissions.ts:49-54`) deciden con `path.resolve` y una
comparación de texto (`within` / `lexicallyInside`), sin `realpath`. `decide` (`guard.ts:224-235`) solo llama al
disco para Edit/Write/NotebookEdit y shell. Por eso la pertenencia a las raíces y las exclusiones de `denyPaths` se
comprueban sobre la ruta aparente, no sobre el archivo que de verdad se abre. La comprobación con la ruta real que
existe para escribir (`insideProblem` / `assertRealInside`) no se usa en las lecturas.

## Solución posible
1. **`src/core/memory/safe-fs.ts`:** añadir `realOrNearest(target)`, que devuelva el `realpath` del ancestro
   existente más cercano con el resto de la ruta añadido. Es el mismo recorrido de `assertRealInside`, pero
   devuelve la ruta en vez de lanzar un error.
2. **`src/core/conductor/guard.ts`:** en `decide`, para `READ_TOOLS`, cuando `precheck` permita, hacer una segunda
   comprobación asíncrona con el módulo `path` del sistema (como `editDecision`):
   - calcular `realOrNearest` del objetivo (`file_path` o `path`, y la parte fija del patrón de Glob/Grep si es
     absoluta);
   - exigir que quede dentro de `realpath` de alguna raíz de `roots()`;
   - negar si queda dentro de `realpath` de alguna ruta de `deniedOnDisk` (si la ruta negada no existe, usar su
     forma de texto);
   - aplicar `SENSITIVE_FILE` también al `basename` real, porque un enlace a archivo `notas.txt` → `id_rsa` hoy
     pasa.

   `check` puede seguir siendo síncrona y de texto (en `src` no la usa nadie fuera de las pruebas), con un
   comentario que diga que no sigue enlaces.
3. **`src/core/adapters/claude-sdk/permissions.ts`:** convertir `readProblem` en asíncrona y hacer lo mismo contra
   `realpath(worktree)` y `realpath` de cada `readRoot`. Ojo: `createLinks` (`src/core/workspace/links.ts:26-60`)
   crea junctions del worktree hacia la copia principal (p. ej. `node_modules`), que está fuera del worktree. Hay
   que añadir como raíces de lectura las rutas reales `<repoReal>/<enlace>` de `project.links`, o leer a través de
   esos enlaces dejaría de funcionar.

### Otras opciones
- Recorrer cada componente con `lstat` y negar cualquier lectura que cruce un enlace o una junction, con una lista
  blanca para los enlaces que crea `createLinks`. Es más estricto y no depende de cómo quede la ruta resuelta.
  Rompe los proyectos del usuario que usan junctions a propósito.
- Comprobar solo `denyPaths` con la ruta real y dejar la pertenencia como está. Es el cambio mínimo para el caso 2
  (bypass), donde las raíces ya son las unidades, pero no cierra el caso 1.
- Calcular una vez, al crear la guardia, las rutas reales de `denyPaths` y de las raíces fijas, y en cada llamada
  resolver solo el objetivo. Así se ahorran `realpath` repetidos.
- Lo más robusto sería aislar el proceso a nivel del sistema operativo (AppContainer o un usuario aparte). Así
  también se cierran la lectura por shell y el TOCTOU, que esta propuesta no evita: alguien puede cambiar el enlace
  entre la comprobación y la lectura.

La propuesta no es la única opción. Elegir entre ellas depende de si se quiere admitir que el usuario tenga
junctions propias en sus proyectos.

## Cómo probar que quedó resuelta
- **Prueba automatizada (mente):** en `tests/core/conductor/guard.test.ts`, dentro de
  `describe('guardia de bypass: escritura y shell (disco real)')`, que ya crea `enlace` → `fuera`:
  - crear una segunda guardia con `readRoots: [extra]` (sin `C:\`) y escribir `fuera/doc.txt`, y afirmar que
    `decide('Read', { file_path: path.join(root, 'enlace', 'doc.txt') })` niega con un motivo de ruta real;
  - afirmar que `Grep { path: 'enlace' }` y `Glob { path: root, pattern: path.join(root, 'enlace', '*') }` también
    niegan;
  - crear `symlinkSync(data, path.join(root, 'datos'), 'junction')` y afirmar que, aun con la guardia de la prueba
    (`readRoots: [extra, 'C:\\']`), `Read { file_path: path.join(root, 'datos', 'vault.json') }` se niega;
  - prueba de control: una junction interna (`root/alias` → `root/src`) sigue permitiendo
    `Read alias/a.ts`.
- **Prueba automatizada (workers):** en `tests/core/adapters/claude-sdk/security.test.ts`, en el bloque
  «hallazgo 5», afirmar `decision('Read', { file_path: join(WT, 'enlace', 'existente.txt') })` → `'deny'`,
  `decision('Grep', { pattern: 'x', path: 'enlace' })` → `'deny'` y `decision('LS', { path: 'enlace' })` →
  `'deny'`. Añadir un caso positivo con una junction creada por `createLinks` hacia la copia principal, que debe
  seguir leyéndose.
- **Comando** (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/conductor/guard.test.ts tests/core/adapters/claude-sdk/security.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`:
  `npx vitest run tests/core/conductor/guard.test.ts tests/core/adapters/claude-sdk/security.test.ts`).
- **Verificación manual:** en un proyecto de prueba, crear `mklink /J referencias C:\temp\señuelo` con un
  `señuelo.txt` sin datos reales. En modo `plan`, pedir a la mente que lea `referencias\señuelo.txt`: debe responder
  que la guardia lo bloquea. En `bypass`, pedirle que lea
  `C:\Users\<usuario>\Configuración local\orquestador\vault.json`: debe bloquearse por `denyPaths` sin abrir el
  archivo. Comprobarlo en el registro de herramientas, sin mostrar el contenido.
