# Quitar una carpeta extra del chat no revoca su lectura ni su escritura mientras la sesión de la mente sigue viva

- **Área:** Seguridad y corrección (revisión de Codex)
- **Severidad:** media
- **Archivos:** `src/core/conductor/session.ts:159`, `src/core/conductor/session.ts:301-304`, `src/core/conductor/session.ts:313`, `src/core/conductor/session.ts:347`, `src/core/chat/service.ts:348-355`, `src/core/chat/service.ts:677-691`, `src/core/chat/service.ts:712`, `src/core/chat/service.ts:718-721`, `src/core/conductor/guard.ts:120-122`, `src/ui/features/chat/components/ChatHeader.tsx:204`, `src/ui/features/chat/store.ts:386`
- **Estado:** abierta
- **Fusiona:** `mente-07-quitar-carpeta-extra-no-revoca.md` (revisión de «Mente y chat»), que describía el mismo defecto
  encontrado por otra vía. Ese archivo se borró. Lo calificaba de severidad baja; se deja **media** porque es una
  revocación de permisos que el usuario hace a propósito y que no tiene efecto.

## Cómo ocurre

Cada chat tiene «Carpetas extra» (`chat.extraRoots`). La mente siempre puede leerlas y, en los modos `chat` y `bypass`
con proyecto (`modeActs`, `session.ts:65-67`), también escribir en ellas. La única barrera es el hook `PreToolUse` de
`createToolGuard`, que también ve las llamadas de los subagentes. La guardia ya acepta raíces dinámicas, porque
`readRoots` y `writeRoots` pueden ser funciones que se leen en cada llamada:

```ts
// src/core/conductor/guard.ts:120-122
const listOf = (v) => (typeof v === 'function' ? v() : (v ?? []));
const roots = (): string[] => [cwd, ...listOf(opts.readRoots).map(...)];
const writeRoots = (): string[] => listOf(opts.writeRoots).map(...);
```

Sin embargo, `ConductorSession` copia las carpetas extra una sola vez, al construirse, y esa copia entra en los dos
caminos:

```ts
// src/core/conductor/session.ts:301-303 y 313
const extraRoots = [...(opts.extraRoots ?? [])];
const readRoots = (): string[] => [...extraRoots, ...(typeof rootsOption === 'function' ? rootsOption() : (rootsOption ?? []))];
...
...(acts ? { writeRoots: [o.cwd, ...extraRoots], shellRoot: o.cwd } : {}),
```

El servicio le pasa esa copia (`service.ts:712`, `extraRoots: chat.extraRoots`). Además le pasa una función que sí lee
las carpetas vigentes (`service.ts:718-721`), pero esa función solo **suma** raíces a la lectura. No puede quitar las
de la copia, y la escritura no la usa.

`PATCH /chats/:id` (`routes.ts:136`) llama a `patch`, que solo guarda el cambio (`service.ts:354`). Su comentario
dice: «Rige desde el turno siguiente» (`service.ts:348`). Sin subagentes eso se cumple, porque la clave de la sesión
incluye `extraRoots` (`service.ts:671`) y el mensaje siguiente recrea la sesión. Con subagentes vivos, en cambio, el
arreglo del issue 7 devuelve a propósito la sesión vieja aunque la clave haya cambiado:

```ts
// src/core/chat/service.ts:680-689
const busy = live.background.size > 0;
if (sameShape || busy) {
  ...
  if (busy) {
    // Recrear la sesión mataría a los subagentes que siguen trabajando: el cambio rige cuando terminen.
    ...
    return alive;
  }
}
```

Pasos:

1. Crear un chat en modo `chat` (o `bypass` con proyecto) con la carpeta extra `X`.
2. Pedirle a la mente algo que lance un `investigador` en segundo plano (`task_started` deja `live.background` con un
   elemento).
3. Quitar `X` desde el encabezado del chat («Carpetas extra», botón «Quitar carpeta» de `ChatHeader.tsx:204`), lo que
   envía `PATCH /chats/:id {extraRoots: []}` desde `store.ts:386`.
4. Mientras el investigador siga vivo, cada mensaje del usuario y cada turno que la mente arranca sola cuando termina
   un subagente reutilizan la misma sesión (`service.ts:689`). El hook sigue permitiendo:
   - `Read`, `Grep` y `Glob` sobre `X\…`, tanto a la mente como al investigador, porque `X` sigue en la copia de
     `session.ts:301`.
   - `Edit`, `Write` y `NotebookEdit` sobre `X\…` a la mente, porque `writeRoots` quedó fijo en `session.ts:313`.
     El investigador no escribe: sus herramientas son solo de lectura (`session.ts:83`).
5. El acceso a `X` solo se pierde cuando terminan todos los subagentes y llega otro mensaje, o cuando vence la
   inactividad. El único aviso queda en el log del núcleo (`service.ts:687`); en el chat no aparece nada.

El cambio contrario tampoco es coherente. Una carpeta agregada se puede **leer** al instante, porque la función del
servicio lee `current.extraRoots`, pero solo se puede **escribir** en ella desde la sesión siguiente.

En `bypass`, la lectura de `X` sigue permitida de todas formas, porque `#rootsFor` suma las unidades locales
(`service.ts:648`, `chat.mode === 'bypass' ? this.#drivesList()`). Ahí lo que importa es la escritura. En `chat`
importan las dos.

No encontré ninguna prueba ni guardia que lo evite. `tests/core/conductor/session.test.ts:329` solo comprueba que
`readRoots` dinámico **agrega** raíces, y `tests/core/chat/service.test.ts:593-600` solo comprueba que `patch` guarda
la lista vacía. Ningún issue de `docs/plan/issues` toca este punto.

## Por qué pasa

`ConductorSessionOptions.extraRoots` es un arreglo fijo (`session.ts:159`). Al crear la sesión se copia
(`session.ts:301`) y entra en la guardia por dos vías que nunca se vuelven a leer: se antepone a la función de lectura
(`session.ts:303`) y forma parte de un `writeRoots` estático (`session.ts:313`). La sesión ya hace lo correcto con el
modo: lo lee en cada llamada precisamente porque puede seguir viva con subagentes trabajando (`session.ts:317`). Con
las carpetas extra no se hizo lo mismo. El issue 7 conserva la sesión mientras haya subagentes, así que la
revocación tampoco llega en los turnos siguientes.

## Solución posible

1. `src/core/conductor/session.ts`: aceptar `extraRoots?: readonly string[] | (() => readonly string[])` y leerlo en
   cada decisión.

   ```ts
   const extraOption = opts.extraRoots;
   const extra = (): readonly string[] => (typeof extraOption === 'function' ? extraOption() : (extraOption ?? []));
   const readRoots = (): string[] => [...extra(), ...(typeof rootsOption === 'function' ? rootsOption() : (rootsOption ?? []))];
   ...
   ...(acts ? { writeRoots: () => [o.cwd, ...extra()], shellRoot: o.cwd } : {}),
   ```

   El prompt (`session.ts:347`) y `additionalDirectories` (`session.ts:372`) pueden seguir usando el valor inicial,
   como ya ocurre con el modo. Lo que manda es el hook.
2. `src/core/chat/service.ts:712`: pasar `extraRoots: () => this.#repo.get(chatId)?.chat.extraRoots ?? []` y quitar
   `current.extraRoots` de la función `readRoots` (`service.ts:720`), que quedaría duplicado. (mente-07 proponía
   `?? chat.extraRoots` como respaldo; `?? []` es más estricto si el chat ya no existe.)
3. Corregir el comentario de `patch` (`service.ts:348`): las carpetas extra, igual que el modo, rigen al instante en la
   guardia.

Con esto, la llamada siguiente a una herramienta ya no puede usar la carpeta quitada, aunque sea de un subagente ya
lanzado, y no hace falta cerrar la sesión.

### Otras opciones

- **Cerrar la sesión en `patch` cuando la lista de carpetas se reduce** (`#dropSession`, aunque haya subagentes) y
  avisarlo en el chat. Revoca sin dejar dudas, pero mata a los subagentes en curso, justo lo que el issue 7 quiso
  evitar.
- **Volver dinámica solo la escritura.** Es el cambio mínimo, pero en modo `chat` la lectura seguiría sin revocarse.
- **Avisar a la mente** en el turno siguiente («la carpeta X ya no está disponible») para que no siga intentando
  usarla por lo que dice su prompt inicial. Sirve como complemento de la guardia, no como barrera.

La propuesta no es la única ni tiene por qué ser la mejor. Una solución más limpia sería que el servicio entregue una
sola función de raíces (lectura y escritura) y que `ConductorSession` no copie nunca listas de permisos al
construirse.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta, en `tests/core/chat/background.test.ts`, que ya tiene `injectableQuery`,
  `taskStarted` y el guion `'investiga'`:
  1. Crear un chat en modo `chat` con `extraRoots: [X]`, donde `X` es una carpeta temporal con `a.txt`, y enviar
     `'investiga'` para que quede un subagente vivo.
  2. `service.patch(chat.id, { extraRoots: [] })`.
  3. Tomar el hook de `q.calls[0].options.hooks.PreToolUse[0].hooks[0]` y llamarlo con `Read {file_path: X/a.txt}` y
     con `Write {file_path: X/b.txt}`. Repetir con `agent_id` para simular al subagente. Afirmar que se niegan todas
     las llamadas (hoy se permiten).
  4. Enviar otro mensaje con el subagente aún vivo y afirmar que `q.calls` sigue en 1 (la sesión no se recrea) y que
     el hook sigue negando `X`.
  5. Contraprueba: volver a agregar `X` con `patch` y afirmar que `Read` y `Write` sobre `X` se permiten otra vez
     sin recrear la sesión.

  Caso unitario en `tests/core/conductor/session.test.ts`, junto al de `readRoots` dinámico (línea 329): pasar
  `extraRoots` como función y `mode: 'chat'`, cambiar la lista entre dos llamadas al hook y afirmar que `Read` y
  `Write` siguen el cambio en los dos sentidos.
- Comando para correrlas (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/chat/background.test.ts tests/core/conductor/session.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/chat/background.test.ts tests/core/conductor/session.test.ts`).
- Verificación manual en la app: en un chat en modo `chat` con una carpeta extra temporal, pedir una investigación que
  lance un subagente en segundo plano. Mientras trabaja, quitar la carpeta desde «Carpetas extra» y pedir de inmediato
  que lea y escriba un archivo dentro de ella. Las dos operaciones deben fallar, con «solo puedes leer dentro del
  proyecto… y de las carpetas extra» y «solo puedes escribir dentro del proyecto…».
