# Un `cd` fuera de la carpeta del proyecto deja Bash y PowerShell bloqueados el resto de la sesión de la mente (bypass y chat)

- **Área:** Mente y chat
- **Severidad:** media
- **Archivos:** `src/core/conductor/guard.ts:216-217`, `src/core/conductor/guard.ts:239`, `src/core/adapters/claude-sdk/shell-policy.ts:388`, `src/core/adapters/claude-sdk/shell-policy.ts:639-645`, `src/core/conductor/session.ts:73`, `src/core/conductor/session.ts:270`, `src/core/conductor/session.ts:303`, `src/core/conductor/session.ts:313`, `src/core/conductor/session.ts:372`, `src/core/chat/service.ts:647-648`, `src/core/chat/service.ts:718-721`, `src/core/app/f5-chat.ts:119`, `src/core/conductor/prompt.ts:156`
- **Estado:** abierta

## Cómo ocurre

Contexto. En los modos `bypass` (con proyecto) y `chat`, la mente usa Bash y PowerShell. La barrera es el hook
`PreToolUse` de `createToolGuard`. Con `shellRoot` igual a la carpeta del chat (`session.ts:313`), el hook evalúa el
comando con la política de los workers y toma como carpeta actual el `cwd` que le pasa Claude Code:

```ts
// src/core/conductor/guard.ts:239
const decision = await decide(input.tool_name, input.tool_input, input.cwd || undefined);

// src/core/conductor/guard.ts:216-217
const dir = at ? path.resolve(shellRoot, at) : shellRoot;
if (!lexicallyInside(shellRoot, dir)) return { allow: false, reason: `${toolName}: la sesión trabaja fuera del proyecto (${dir}); vuelve a ${shellRoot}.` };
```

La política deja hacer `cd` a cualquier carpeta. `evalCd` no limita el destino: solo mueve el cwd que sigue el análisis
(`shell-policy.ts:388` y `639-645`):

```ts
async function evalCd(args: readonly Word[], c: ShellContext): Promise<Outcome> {
  ...
  const r = resolveShellPath(target, c.cwd);
  return { cwd: 'abs' in r ? r.abs : undefined };
}
```

Las carpetas de trabajo de Claude Code son el `cwd` más `additionalDirectories`, y `additionalDirectories` son las raíces
de lectura (`session.ts:303` y `372`):
- en bypass, todas las unidades (`service.ts:647-648`: `chat.mode === 'bypass' ? this.#drivesList() : []`);
- en chat, las carpetas extra, el hub de skills (`f5-chat.ts:119`) y las carpetas de los adjuntos (`service.ts:718-721`).

Claude Code (SDK 0.3.302, `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`) conserva el cwd del shell
entre llamadas si queda dentro de esas carpetas. Solo lo devuelve al original si sale de ellas o si
`CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` está activa. Código minificado extraído del binario:

```js
function oQn(){return Fe(process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR)}
function gyr(e,n){let r=vo(e).cwd,s=ke(),h=oQn();if(h||r!==s&&!Mh(r,n)){try{Rp(s,e)}catch{return!0}...}return!1}
```

Aquí `ke()` es el `originalCwd` y `Mh(r, n)` comprueba si `r` está dentro de las carpetas de trabajo. El `cwd` del hook
`PreToolUse` es el cwd vigente de la sesión, no el original:
`{...ou(s.session,xm(),h,s),hook_event_name:"PreToolUse",...}` con `xm()` → `ce()` (cwd actual). Berland no define esa
variable: `BYPASS_ENV` solo trae `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` (`session.ts:73`, aplicado en `session.ts:270`), y
`CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` no aparece en `src/`.

Pasos:
1. Abre un chat de proyecto en bypass, o un chat en modo chat con una carpeta extra.
2. La mente ejecuta `cd ..; ls` (o `cd C:\dev\otro-repo; Get-ChildItem`, o en chat `cd <carpeta extra>; ls`). La
   guardia lo permite: el cwd del hook todavía es el proyecto, `cd` es libre y listar es lectura.
3. El destino está dentro de `additionalDirectories` (en bypass, la unidad entera; en chat, la carpeta extra), así que
   Claude Code conserva ese cwd.
4. En la llamada siguiente, de Bash o de PowerShell, el hook recibe el cwd de afuera. La línea `guard.ts:217` niega
   antes de analizar el comando: «la sesión trabaja fuera del proyecto (…); vuelve a <proyecto>».
5. La mente obedece y prueba `cd <proyecto>`. Recibe la misma negativa, porque la comprobación no mira el comando. Desde
   ahí no puede ejecutar ningún comando.

El shell sigue inutilizable hasta que la sesión se recrea:
- tras 15 min sin uso (`CHAT_IDLE_MS`);
- cuando cambia la forma de la sesión (modo, modelo, raíces, plugins);
- si después de interrumpir el SDK no cierra el turno dentro de la gracia de 10 s (`service.ts:505-511`).

Una interrupción normal no la recrea. En bypass la mente trabaja sola y sin preguntar, así que la tarea queda a medias.
En chat el prompt invita a esto: dice que ejecuta comandos «en la carpeta de trabajo y en las carpetas extra del chat»
(`prompt.ts:156`).

Las pruebas actuales fijan la negativa con un cwd de afuera (`tests/core/conductor/guard.test.ts:214` y `:225`), pero no
prueban cómo se vuelve.

## Por qué pasa

Tres piezas que por separado son razonables chocan:
- la política deja salir de la raíz con `cd` (`shell-policy.ts:639-645`);
- Claude Code persiste ese cwd porque las raíces de lectura son carpetas de trabajo (`session.ts:372`) y no se activa
  `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` (`session.ts:73`);
- con el cwd afuera, la guardia niega cualquier comando, incluido el que vuelve, antes de mirarlo (`guard.ts:217`).

El mensaje «vuelve a <proyecto>» pide algo que la propia guardia impide.

## Solución posible

1. `src/core/conductor/session.ts:73`: agregar `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1'` a `BYPASS_ENV`. Así
   Claude Code devuelve el shell al `cwd` de la sesión después de cada comando, y el hook siempre recibe la carpeta del
   proyecto. Dentro de un mismo comando, `cd X && …` sigue analizándose con el cwd que lleva la política.
2. `src/core/conductor/guard.ts:217`, como respaldo por si el cwd igual queda afuera (versión del SDK que ignore la
   variable, subagentes): con `dir` fuera de `shellRoot`, no negar de inmediato. Aceptar el comando solo si su primer
   comando simple es `cd`/`Set-Location`/`pushd` a una ruta (resuelta contra `dir`) dentro de `shellRoot`, y evaluar el
   resto con `shellCommandProblem(command, kind, shellRoot, dir)`, que ya sigue el `cd`. Hace falta un ayudante
   exportado en `shell-policy.ts` (por ejemplo, `leadingCdTarget(command, kind, cwd)` sobre `parseShell`). El mensaje de
   la negativa debería decir cómo volver: «empieza el comando con `cd <proyecto>`».

### Otras opciones

La propuesta no es la única. Hay otras, cada una con su costo:
- **Limitar `cd` a la raíz solo para la mente.** Una opción de `ShellContext` (p. ej., `confineCd`) haría que `evalCd`
  niegue destinos fuera de `shellRoot`. Es simple, pero en bypass la mente puede leer todo el disco, y `cd C:\otro; git log`
  dejaría de valer aunque sea lectura. Además `popd`/`Pop-Location` dejan el cwd desconocido (`shell-policy.ts:389`) y
  habría que cubrirlos.
- **Evaluar siempre con `cwd = shellRoot` e ignorar el cwd del hook.** Es peligroso: la política juzgaría las rutas
  relativas contra el proyecto mientras el shell corre en otra carpeta. `rm -rf *`, `git clean -fdx` o `npm install`
  actúan sobre el cwd implícito y no se pueden detectar como «rutas relativas».
- **Dejar fuera de `additionalDirectories` las raíces que no hace falta tratar como carpetas de trabajo.** Por ejemplo, en
  bypass, las unidades: así Claude Code devolvería solo el cwd. Pero `additionalDirectories` también habilita la lectura
  de Read/Grep/Glob en Claude Code, así que esto cambia otro comportamiento.
- **Solo el prompt.** Pedirle a la mente que use rutas absolutas y no haga `cd` fuera del proyecto. No basta como
  barrera, pero sí ayuda junto con la opción 1.

La opción 1 (una línea) quita la causa. La opción 2 es la defensa en profundidad que hace que el mensaje de la guardia se
pueda cumplir.

## Cómo probar que quedó resuelta

- Pruebas automatizadas propuestas:
  - `tests/core/conductor/guard.test.ts`, en `describe('guardia de bypass: escritura y shell (disco real)')`, con el
    `guard` del `beforeAll` (`shellRoot: root`) y la carpeta `outside`:
    - `decide('Bash', { command: \`cd ${root}\` }, outside)` permite (hoy niega con /fuera del proyecto/);
    - `decide('PowerShell', { command: \`Set-Location ${root}; Get-ChildItem\` }, outside)` permite;
    - `decide('Bash', { command: \`cd ${path.join(root, 'src')} && git status\` }, outside)` permite;
    - siguen negados `decide('Bash', { command: 'git status' }, outside)` (/fuera del proyecto/),
      `decide('Bash', { command: \`cd ${root} && git push\` }, outside)` (/git push/) y
      `decide('Bash', { command: \`cd ${outside}\` }, outside)`;
    - `guard.hook(pre('Bash', { command: \`cd ${root}\` }, outside), …)` devuelve `{}`.
  - `tests/core/conductor/session.test.ts`: en las pruebas de bypass (junto a `:435`) y de chat (junto a `:553`),
    `expect(o.env?.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe('1')`; en el bucle de los modos que no actúan (junto a
    `:475`), `toBeUndefined()`.
- Comando (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/conductor/guard.test.ts tests/core/conductor/session.test.ts"`
  (o desde PowerShell en C:\dev\orquestador:
  `npx vitest run tests/core/conductor/guard.test.ts tests/core/conductor/session.test.ts`).
- Verificación manual en la app:
  1. En un chat de proyecto en bypass, pide a la mente que ejecute `cd ..; ls` y después `git status`.
  2. Hoy el segundo comando se niega con «la sesión trabaja fuera del proyecto», y también se niega `cd <proyecto>`.
  3. Con el arreglo, `git status` corre en la carpeta del proyecto.
  4. Repite en modo chat con una carpeta extra (`cd <carpeta extra>; ls` y luego `git status`).
