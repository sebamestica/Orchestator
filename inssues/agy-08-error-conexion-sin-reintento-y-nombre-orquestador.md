# La pantalla «sin conexión con el núcleo» dice «el orquestador», nombra un enlace que no existe y no deja reintentar

- **Área:** Interfaz
- **Severidad:** baja
- **Archivos:** `src/ui/app/App.tsx:38-69`, `src/ui/app/App.tsx:118-130`, `src/ui/components/EmptyState.tsx:8`, `src/ui/components/EmptyState.tsx:21`, `src/ui/api/bridge.ts:52-62`, `apps/desktop/src/main.ts:76`, `apps/desktop/src/main.ts:130`, `apps/desktop/src/main.ts:162-166`, `apps/desktop/src/main.ts:231-243`, `src/core/app/cli-commands.ts:89-91`, `src/core/app/cli-commands.ts:112-128`, `docs/plan/F5-INTERFAZ.md:7`
- **Estado:** abierta
- **Origen:** revisión de agy, verificada por Claude

## Cómo ocurre
Cuando el arranque de la interfaz no termina en `ready`, `App.tsx` muestra un `EmptyState` con el ícono `Plug`:

```tsx
// src/ui/app/App.tsx:120-127
<EmptyState
  icon={Plug}
  title={core === 'missing' ? 'Sin conexión con el núcleo' : 'El núcleo no responde'}
  description={
    core === 'missing'
      ? 'Abre el orquestador desde el escritorio, o usa el enlace «Abrir en el navegador» que trae el token de la sesión.'
      : (coreError ?? 'Revisa que el núcleo esté corriendo.')
  }
/>
```

Esa pantalla tiene tres fallos:

1. **Nombre equivocado.** El texto dice «Abre **el orquestador** desde el escritorio» (`App.tsx:125`). `docs/plan/F5-INTERFAZ.md:7` lo prohíbe: «Todo texto visible para el usuario dice «Berland»». La barra lateral (`src/ui/app/Sidebar.tsx:32`) y las páginas de estado del escritorio («Vuelve a abrir Berland.», `apps/desktop/src/main.ts:214` y `:228`) ya dicen Berland.
2. **El texto manda a un enlace que no existe.** Ni la interfaz ni la app de escritorio tienen un enlace o botón «Abrir en el navegador». El único enlace web con token lo imprime en consola el comando `iniciar` del núcleo (`src/core/app/cli-commands.ts:123`: `io.out(\`web: ${web}\`)`) y, con `--abrir`, ese mismo comando lo abre (`cli-commands.ts:125-128`). El propio aviso del CLI lo llama «el enlace «web:»» (`cli-commands.ts:127`).
3. **No hay forma de reintentar.** `EmptyState` acepta `action?: ReactNode` (`EmptyState.tsx:8`) y la dibuja (`EmptyState.tsx:21`), pero `App.tsx:120-128` no le pasa nada. `useBootstrap` (`App.tsx:43-68`) corre una sola vez al montar la app. Si cae en el `catch` (`App.tsx:63-64`), la interfaz se queda en `error` sin volver a intentarlo.

**Corrección al escenario de agy.** agy decía que basta con abrir la web «antes de que el núcleo termine de levantar su servidor HTTP». No es así:
- En la web, la interfaz la sirve el mismo núcleo (`bridge.ts:58-59`: `url: dev ? '/__core' : ''`, mismo origen). Si el núcleo no está arriba, el navegador muestra su propio error y nunca carga React.
- En el escritorio, la ventana carga la interfaz recién cuando `supervisor.connect()` respondió bien (`main.ts:231-243`). Mientras tanto se ve la página de estado «Arrancando el núcleo…».

Los casos reales son estos:
- **`missing`** (`App.tsx:48-50`): solo en la web, cuando la pestaña no trae `#t=` ni tiene token en `sessionStorage` (`bridge.ts:54-55`). Por ejemplo, alguien escribe `http://127.0.0.1:47811/` a mano o abre una pestaña nueva. Reintentar no sirve aquí, porque el token sigue sin aparecer. Lo que falla es la instrucción (puntos 1 y 2).
- **`error`** (`App.tsx:63-64`): `resolveCore()` o `loadAll()` lanzan un error. Pasa si falla `/projects`, `/agents` o `/tasks` (`src/ui/store/app.ts:56-59`, sin `ignore`), si el token de la pestaña quedó viejo porque el núcleo se reinició (401), con `vite dev` y el núcleo apagado, o en el escritorio si `supervisor.current` es nulo (`main.ts:162-166`: «El núcleo no está conectado»). En el navegador basta con F5. **En el escritorio no se puede recargar**: la ventana no tiene marco (`main.ts:76`, `frame: false`) y no tiene menú (`main.ts:130`, `Menu.setApplicationMenu(null)`), así que tampoco funciona Ctrl+R. La única salida es cerrar Berland y volver a abrirlo.

El issue 14 (pantalla de carga, rama `flota/c35-carga`) no arregla esto. Solo cambia la rama `starting` por `<BootScreen label="Conectando con el núcleo…" />`. En esa rama el mismo `EmptyState`, con el mismo texto y sin `action`, pasa a `App.tsx:123-131`.

## Por qué pasa
- El texto de `App.tsx:125` es anterior a la decisión de llamar «Berland» a la app (`F5-INTERFAZ.md:7`). Además supone un enlace «Abrir en el navegador» que nunca se hizo.
- El arranque vive dentro de un `useEffect` sin dependencias que cambien (`App.tsx:68`), y no hay ninguna acción que lo vuelva a lanzar. El estado de error no tiene salida dentro de la interfaz.

## Solución posible
1. **Texto de `missing`:** decir «Berland» y apuntar a algo que existe. Por ejemplo: «Abre Berland desde el escritorio, o abre el enlace «web:» que muestra el núcleo al iniciar (trae el token de la sesión).»
2. **Reintento en `error`:**
   - Sacar el cuerpo de `useBootstrap` a una función `connect()` que se pueda volver a llamar. Puede vivir en el store, por ejemplo `bootstrap()` en `src/ui/store/app.ts`, o ser un contador `bootAttempt` en la dependencia del efecto.
   - En `App.tsx`, pasarle a `EmptyState` un `action` con un botón «Reintentar» (HeroUI `Button`, variante secundaria) solo cuando `core === 'error'`. Al pulsarlo se hace `setCore('starting')`, que tras el issue 14 muestra la `BootScreen`, y luego se vuelve a llamar a `connect()`.
   - Antes de reintentar, detener la conexión en vivo anterior si existe. Hoy `startLive` solo arranca después de `ready`, pero conviene no dejar dos sockets abiertos.
3. **En `missing` no mostrar «Reintentar»,** porque no cambia nada. Si se quiere un botón, que copie o explique cómo conseguir el enlace.

### Otras opciones
- **Reintento automático con espera creciente** (1 s, 2 s, 4 s… con un tope) mientras `core === 'error'`, además del botón. Así se cubre el caso del núcleo lento con la CPU al límite. Hay que limitarlo para no cargar el PC.
- **En el escritorio, pedirle al proceso principal que recargue la ventana** con un canal IPC de solo lectura, como `win.reload()`. Es más simple en la interfaz, pero suma un canal nuevo que habría que validar en `ipc.ts`.
- **Agregar de verdad un botón «Abrir en el navegador»** en la app de escritorio, usando `openInBrowser`/`webUrl` del núcleo por un IPC. Así el texto actual tendría sentido, salvo el nombre.

Esta propuesta no es la única y puede haber una más optimizada. Por ejemplo, unir el reintento con la reconexión que ya hace `startLive` cuando se corta el WebSocket.

## Cómo probar que quedó resuelta
- **Prueba automatizada propuesta:** `tests/ui/app-conexion.test.tsx` (nueva), con Testing Library, simulando `src/ui/api/bridge.ts` (`resolveCore`) y el cliente de la API.
  - Escenario `missing`: `resolveCore` devuelve `null`. Se afirma que el texto contiene «Berland», que no contiene «el orquestador» ni «Abrir en el navegador», y que no hay botón «Reintentar».
  - Escenario `error`: la primera llamada a `/projects` falla y la segunda responde bien. Se afirma que aparece «El núcleo no responde» con un botón «Reintentar» y que, al pulsarlo, se vuelve a llamar a `resolveCore`/`loadAll` y la vista pasa a la portada (`ready`).
- Comando (WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/app-conexion.test.tsx"`; PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/app-conexion.test.tsx`.
- **Verificación manual en la app:**
  - **Web sin token:** con el núcleo arriba, abrir `http://127.0.0.1:47811/` sin `#t=` en una pestaña nueva. Debe decir «Berland», nombrar el enlace «web:» y no mostrar «Reintentar».
  - **Error recuperable:** con `npm run dev:ui` y el núcleo apagado, abrir la interfaz con un `#t=` cualquiera. Debe salir «El núcleo no responde» con «Reintentar». Al levantar el núcleo con ese token y pulsar «Reintentar», debe pasar a la portada sin recargar la pestaña.
  - **Escritorio:** forzar un fallo de `/projects` y comprobar que «Reintentar» recupera la ventana sin cerrar Berland.
