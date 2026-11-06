# Una junction interna hacia `.git` o `.claude` deja escribir en ellas

- **Área:** Seguridad y corrección (revisión de Codex)
- **Severidad:** media
- **Archivos:** `src/core/adapters/claude-sdk/shell-policy.ts:74-80`, `src/core/adapters/claude-sdk/shell-policy.ts:63-71`, `src/core/memory/safe-fs.ts:58-73`, `src/core/adapters/claude-sdk/shell-policy.ts:688`, `src/core/adapters/claude-sdk/shell-policy.ts:728-729`, `src/core/adapters/claude-sdk/permissions.ts:89`, `src/core/conductor/guard.ts:206`
- **Estado:** resuelta

## Cómo ocurre

Toda escritura de un worker Claude y de la mente en `bypass`/`chat` pasa por `writeProblem`. Lo usan las herramientas
`Write`/`Edit`/`NotebookEdit` del worker (`permissions.ts:89`), las de la mente (`guard.ts:206`, con
`writeRoots: [o.cwd, ...]` en `session.ts:313`) y las redirecciones y comandos de archivos del shell (`shell-policy.ts:107`).
Según la documentación del propio código, se permite escribir «si la ruta real (sigue junctions y enlaces) queda dentro del
worktree y no es `.git`, `.claude/` ni `.mcp.json`» (`permissions.ts:16-17`, y lo mismo en `guard.ts:13-15`).

El código no hace eso. La ruta real solo se usa para comprobar que el destino sigue dentro de la raíz. Los directorios
protegidos se buscan en el primer segmento de la ruta **escrita**:

```ts
// shell-policy.ts:74-80
const outside = await insideProblem(worktree, target);          // realpath: ¿sigue dentro?
if (outside) return `escritura fuera del worktree: ${outside}`;
const first = path.relative(path.resolve(worktree), path.resolve(target)).split(/[\\/]/)[0]?.toLowerCase();
if (first && PROTECTED.has(first)) return `ruta protegida del worktree (${first}): ${target}`;
```

`insideProblem` → `assertRealInside` (`safe-fs.ts:58-73`) resuelve el ancestro existente más cercano con `realpath`, solo
comprueba que siga dentro de la raíz y no devuelve la ruta real. Si `<proyecto>\alias` es una junction a `<proyecto>\.git`:

1. `alias\config` tiene como ruta real `<proyecto>\.git\config`, que sigue dentro del proyecto, así que `insideProblem` no
   pone problema.
2. El primer segmento léxico es `alias`, que no está en `PROTECTED`, así que se permite la escritura.

Esto se puede alcanzar con las mismas herramientas que la política permite. La mente en `bypass`/`chat` tiene `PowerShell`
(`session.ts:59`) y trabaja en la carpeta del proyecto, donde `.git` es un directorio real. Lo mismo vale para la flota en
modo local, con un repo sin commits. Pasos:

1. `New-Item -Type Junction -Path alias -Value .git` (PowerShell). La detección de enlaces solo mira el parámetro cuyo
   prefijo coincide con `itemtype` (`shell-policy.ts:728-729`: `'itemtype'.startsWith(p.name)`). `-Type`, el alias oficial
   de `-ItemType` en `New-Item`, se clasifica como valor (`'type'` en `PS_VALUE_PARAMS`, `shell-policy.ts:688`) y no
   coincide, así que la creación no se detecta. `-Value .git` también es valor y no se revisa como ruta. Solo se revisa
   `-Path alias`, que está dentro y no está protegida.
2. `Write`/`Edit` sobre `alias\config`, o `Add-Content alias\config ...`, o `echo ... >> alias/config`: se permite.

Lo mismo sirve con una junction a `.claude` para editar `.claude\settings.json`. Si la junction ya existe en el proyecto,
basta con el paso 2.

Consecuencia: `.git/config` admite claves que hacen que git lance programas (`core.hooksPath`, `core.fsmonitor`,
`core.sshCommand`…). Después, cualquier `git` en esa carpeta, del usuario o del núcleo, los ejecuta fuera de la política.
Esa es justamente la «configuración ejecutable» que la protección quiere cuidar (`shell-policy.ts:73`).

Las pruebas no lo cubren. `tests/core/adapters/claude-sdk/security.test.ts:186-205` y
`tests/core/conductor/guard.test.ts:157-186` solo prueban una junction que **sale** de la raíz y rutas escritas
literalmente como `.git\config` o `.claude\settings.json`. Ninguno de los issues 1 a 13 de `docs/plan/issues` cambió esto.
El 08 se apoya en `writeProblem` para proteger `.git` en `bypass`.

Por qué no es «alta»: el propio módulo dice que no es una frontera contra código hostil (`shell-policy.ts:20-23`). Un
agente que quiera escribir en `.git` puede escribir un script dentro del proyecto y ejecutarlo (`node x.js` se permite como
riesgo residual). Aun así, esto es un camino de dos pasos que usa solo herramientas permitidas y contradice el contrato
documentado de la guardia.

## Por qué pasa

`writeProblem` mezcla dos comprobaciones sobre rutas distintas. La de contención usa la ruta real
(`assertRealInside`). La de rutas protegidas usa la ruta léxica (`path.relative(...)` sobre `target` sin resolver). Como
`assertRealInside` no devuelve la ruta real, `writeProblem` no tiene con qué comparar. Aparte, la detección de
`New-Item` con enlaces depende del nombre exacto del parámetro y no reconoce su alias `-Type`.

## Solución posible

1. `src/core/memory/safe-fs.ts`: añadir `realPathInside(root, target): Promise<string>`. Hace lo mismo que
   `assertRealInside`, pero devuelve la ruta real: `realpath` del ancestro existente más cercano más los segmentos que
   todavía no existen. `assertRealInside` puede pasar a usarla.
2. `src/core/adapters/claude-sdk/shell-policy.ts`, `writeProblem`: calcular el primer segmento protegido dos veces, sobre la
   ruta léxica relativa a `worktree` y sobre la ruta real relativa a `realpath(worktree)`. Negar si cualquiera de los dos
   está en `PROTECTED`. Con la ruta real también conviene revisar todos los segmentos intermedios, no solo el primero, para
   cubrir una junction a `.git` dentro de una subcarpeta.
3. Mismo archivo, `evalWriteCommand`: reconocer el tipo de elemento por cualquier prefijo de `itemtype` **o** por `type`
   (alias de `New-Item`), por ejemplo
   `['itemtype', 'type'].some((n) => n.startsWith(p.name))`. Así `New-Item -Type Junction|SymbolicLink|HardLink` se niega
   como `-ItemType`.

### Otras opciones

- Negar cualquier escritura cuya ruta real difiera de la léxica, es decir, toda escritura a través de un enlace o una
  junction, aunque quede dentro. Es más simple y cierra también enlaces a otros archivos sensibles, pero rompe casos
  legítimos como los enlaces internos de `node_modules` con pnpm.
- Comparar contra las rutas reales de `.git`, `.claude` y `.mcp.json` calculadas una sola vez al crear la política, para no
  hacer un `realpath` extra por escritura. Es más rápido, pero no ve una `.claude` creada después.
- Los enlaces duros (`New-Item -Type HardLink`, sin permisos de administrador) no se detectan con `realpath`. Para ellos la
  defensa real es el punto 3, que impide crearlos, o revisar `nlink > 1` con `lstat` antes de permitir la escritura.
  La propuesta de arriba no es la única: la solución de fondo es aislar el proceso a nivel del sistema operativo, que el
  módulo ya reconoce como riesgo residual.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta:
  - `tests/core/conductor/guard.test.ts`, bloque «guardia de bypass: escritura y shell (disco real)». En `beforeAll`,
    crear `symlinkSync(path.join(root, '.git'), path.join(root, 'alias-git'), 'junction')`, una carpeta
    `root/.claude` y `symlinkSync(path.join(root, '.claude'), path.join(root, 'alias-claude'), 'junction')`. Afirmar que
    `reason('Write', { file_path: path.join(root, 'alias-git', 'config'), ... })`,
    `reason('Edit', { file_path: 'alias-claude/settings.json', ... })` y
    `reason('Write', { file_path: path.join(root, 'alias-git', 'hooks', 'nuevo', 'x'), ... })` (archivo y carpetas
    inexistentes) coinciden con `/protegida/`. Afirmar también que el shell niega
    `Add-Content alias-git\config x` (PowerShell) y `echo x >> alias-git/config` (Bash).
  - `tests/core/adapters/claude-sdk/security.test.ts`, bloque «hallazgo 5». Mismo escenario en un worktree aparte (para no
    cambiar el `WT` compartido), con `decideToolUse` para `Write`, `Edit` y redirección de Bash, todas `deny`. Añadir
    además `ps('New-Item -Type Junction -Path alias -Value .git')`, `ps('ni -Type SymbolicLink -Path a -Value b')` y
    `ps('New-Item -Type HardLink -Path h -Value a.txt')`, que deben dar `deny`.
- Comando para correrla (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/conductor/guard.test.ts tests/core/adapters/claude-sdk/security.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/conductor/guard.test.ts tests/core/adapters/claude-sdk/security.test.ts`).
- Verificación manual: en un proyecto descartable con `git init`, abrir la mente en modo `bypass` y pedirle que ejecute
  `New-Item -Type Junction -Path alias -Value .git` y luego que escriba una línea en `alias\config`. Ambas deben quedar
  bloqueadas por la guardia. Comprobar con `git config --list --local` que `.git\config` no cambió.
