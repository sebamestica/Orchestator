# Berland: app de escritorio (Electron)

Proceso principal y preload de Electron 44. La interfaz es la misma de la web (`src/ui`, servida por el núcleo).

```powershell
npm run desktop       # compila apps/desktop/out y abre Berland
npm run desktop:dev   # igual, con ORQ_UI_DEV=1 (interfaz de Vite en 5174) y DevTools
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\desktop-shortcut.ps1   # Berland.lnk en el Escritorio
node apps/desktop/tools/make-icon.ts    # regenera assets/icon.ico desde la geometría de assets/icon.svg
```

## Núcleo: buscar, lanzar, reutilizar y apagar

1. Al abrir, `GET http://127.0.0.1:<ORQ_PORT>/health`. Un 200 o un 401 `unauthorized` es un núcleo vivo.
2. **Núcleo vivo:** se usa solo si `session.json` tiene un token que ese núcleo acepta (`GET /tasks?state=running` responde 200). Si no lo tiene (lo abrió otra persona o programa, por ejemplo `iniciar` en una terminal o la flota), la ventana lo explica y **no lo toca**.
3. **Sin núcleo:** lanza el `node.exe` de Windows del PATH (o `ORQ_NODE`) con `src/core/app/cli.ts iniciar`, con `cwd` en la raíz del repo, sin shell, `windowsHide` y `detached`. Lee la línea `{"ready":true,…}` por stdout (con plazo `ORQ_CORE_TIMEOUT_MS`, 45 s por defecto). stderr va a `logs/nucleo-escritorio.log` como archivo, no como tubería: así el núcleo sigue escribiendo aunque la ventana muera.
4. **Al cerrar la ventana**, el núcleo se apaga (por PID, con `taskkill /T /F`) solo si lo abrió Berland **y** `GET /tasks?state=running` confirma que no hay tareas en curso. Con tareas en curso, sin respuesta del núcleo o con un núcleo ajeno, sigue vivo y la próxima apertura lo reutiliza (paso 2). Regla en `src/lib/shutdown-policy.ts`.

## Token

- Nunca en claro en disco ni en `localStorage`. `session.json` (en `%LOCALAPPDATA%\orquestador`) guarda en claro solo `port` y `startedAt`. Token, pid y puerto van juntos y cifrados con `safeStorage` (DPAPI del usuario protege la clave de `Local State` del perfil `desktop\`). Si alguien cambia el pid, no descifra: Berland no puede terminar matando otro proceso.
- Sin `safeStorage` disponible, el token vive solo en memoria y el núcleo no se puede reutilizar al reabrir.
- La interfaz lo pide con `window.orq.core()`. El proceso principal solo responde al marco principal de la ventana con una página del propio origen.
- `ORQ_CORE_TOKEN` (solo en memoria) conecta con un núcleo abierto a mano. Ese núcleo nunca se apaga.

## Ventana y seguridad

- Sin marco, con fondo `#090909`, mínimo de 960×600 y título «Berland». El estado se guarda en `desktop\window-state.json`. Instancia única: el candado va por perfil, y una segunda apertura trae al frente la primera.
- `contextIsolation`, `sandbox`, sin `nodeIntegration`, `webSecurity`, sin `<webview>`, sin menú y sin DevTools salvo `ORQ_DEVTOOLS=1`. Solo se conceden los permisos del portapapeles al propio origen.
- Solo navega a su origen. Los enlaces `https:` y `http://127.0.0.1` se abren en el navegador; el resto se bloquea, incluido un archivo soltado sobre la ventana: el `drop` lo maneja la interfaz con `window.orq.pathForFile`.
- Si el núcleo no sirve la interfaz, no arranca o se cae, la ventana muestra una página de estado propia (`data:`). Esa página no tiene acceso al token y solo usa los botones de la ventana.

## Variables

`ORQ_PORT`, `ORQ_DATA_DIR` (y las demás `ORQ_*` del núcleo, que pasan al hijo), `ORQ_UI_DEV`, `ORQ_DEVTOOLS`, `ORQ_NODE`, `ORQ_REPO_ROOT`, `ORQ_CORE_TOKEN` y `ORQ_CORE_TIMEOUT_MS`. Al núcleo hijo nunca le llegan `ELECTRON_*` ni las variables propias de la app. Se le agrega a `ORQ_ALLOWED_ORIGINS` el origen de la ventana.
