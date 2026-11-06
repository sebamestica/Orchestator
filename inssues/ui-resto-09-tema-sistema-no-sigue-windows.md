# El tema «Sistema» no sigue a Windows mientras Berland está abierto, y con tema claro la ventana abre en oscuro

- **Área:** Interfaz: tablero, panel, ajustes
- **Severidad:** baja
- **Archivos:** `src/ui/app/App.tsx:85-95`, `src/ui/app/App.tsx:89`, `src/ui/features/settings/GeneralSection.tsx:38-39`, `src/ui/index.html:2`, `src/ui/index.html:6`, `src/ui/store/app.ts:65`, `src/ui/store/app.ts:95-96`, `src/shared/api.ts:75`, `apps/desktop/src/main.ts:14`, `apps/desktop/src/main.ts:77`, `apps/desktop/src/main.ts:97-99`
- **Estado:** abierta

## Cómo ocurre

El tema se guarda en los ajustes del núcleo (`appearance.theme`: `system`, `dark` o `light`, por defecto `dark`
en `src/shared/api.ts:75`). La interfaz lo aplica en el hook `useAppearance`, que pone la clase `dark`/`light` y
`data-theme` en `<html>`. Los colores de `src/ui/styles/index.css` cuelgan de esa clase. En Ajustes › General el
texto promete que «Sistema» sigue a Windows (`GeneralSection.tsx:38`):

```tsx
<SettingsRow label="Tema" description="Sistema sigue el tema de Windows.">
```

Pasos:

1. En Ajustes › General, elegir Tema = Sistema con Windows en modo claro. Berland se pone en claro.
2. Sin cerrar Berland, cambiar Windows a modo oscuro (Configuración › Personalización › Colores, o por la
   programación automática).
3. Berland sigue en claro. Solo cambia al reiniciar o cuando llega cualquier cambio de ajustes por `/ws`
   (`store/app.ts:95-96` reemplaza el objeto `settings` completo y el efecto vuelve a correr), por ejemplo al
   tocar la concurrencia.

Hay un segundo síntoma, también al abrir: con el tema Claro guardado, o Sistema con Windows en claro, la ventana
aparece en oscuro y cambia a claro cuando llegan los ajustes. `index.html:2` arranca fijo en oscuro:

```html
<html lang="es" class="dark" data-theme="dark">
```

y el proceso principal pinta el fondo oscuro y muestra la ventana en el primer pintado (`main.ts:14`,
`main.ts:77`, `main.ts:97-99`), antes de que React monte, resuelva el núcleo y traiga `/settings`
(`store/app.ts:65`). Lo mismo pasa con `<meta name="theme-color" content="#090909">` (`index.html:6`).

## Por qué pasa

`useAppearance` (`App.tsx:85-95`) lee la media query una sola vez por cada cambio de `appearance` y no se suscribe
al evento `change` del `MediaQueryList`:

```tsx
useEffect(() => {
  const root = document.documentElement;
  const dark = appearance.theme === 'dark' || (appearance.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.classList.toggle('dark', dark);
  ...
}, [appearance]);
```

Ningún otro sitio lo escucha. En `src/ui` y `apps/desktop` no hay otro uso de `matchMedia` ni de
`nativeTheme`, y el proceso principal no cambia `themeSource`. Por eso la media query de Chromium sí sigue a
Windows y dispara `change`, pero nadie atiende ese evento. Ninguno de los issues de hoy (`docs/plan/issues/01` a
`13`) toca esto, y ninguna prueba en `tests/` usa `useAppearance` ni `matchMedia`.

El destello sale de dejar el tema inicial fijo en oscuro en tres sitios (HTML, `theme-color` y `backgroundColor`
de la ventana) cuando el tema real solo se conoce después de una llamada HTTP al núcleo.

## Solución posible

1. Pasar `useAppearance` a su propio archivo exportado, por ejemplo `src/ui/app/use-appearance.ts`, para poder
   probarlo. `App.tsx` lo importa.
2. Dentro del efecto, cuando `appearance.theme === 'system'`, crear el `MediaQueryList`, aplicar el tema y
   suscribirse:

   ```ts
   useEffect(() => {
     const root = document.documentElement;
     const mql = appearance.theme === 'system' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
     const apply = () => {
       const dark = appearance.theme === 'dark' || (mql?.matches ?? false);
       root.classList.toggle('dark', dark);
       root.classList.toggle('light', !dark);
       root.dataset.theme = dark ? 'dark' : 'light';
     };
     apply();
     root.dataset.effects = appearance.reducedEffects ? 'reduced' : 'full';
     mql?.addEventListener('change', apply);
     return () => mql?.removeEventListener('change', apply);
   }, [appearance.theme, appearance.reducedEffects]);
   ```

   Depender de `theme` y `reducedEffects` en lugar de `appearance` evita volver a montar el oyente con cada
   mensaje `settings` de `/ws`.
3. Para el destello, guardar en `localStorage` el último tema efectivo cada vez que se aplica y leerlo antes del
   primer pintado. La CSP de `index.html:7` (`script-src 'self'`) no deja usar un script inline, así que tendría que
   ser un `<script src="./theme-boot.js">` clásico (no módulo, para que bloquee) en `<head>`, servido desde
   `public/`. Ese script pone la clase y `data-theme` en `<html>`.

### Otras opciones

- **Desde Electron:** escuchar `nativeTheme.on('updated')` en `main.ts` y avisar por el puente de `preload.ts`.
  Así también se puede cambiar `win.setBackgroundColor()` según el tema, lo que quita el fondo oscuro fijo de
  `main.ts:77`. Cuesta más, porque toca IPC y el puente, y en el navegador sin Electron no sirve. El `change` de
  `matchMedia` ya basta para el primer síntoma.
- **Destello sin `localStorage`:** que el proceso principal conozca el tema y retrase el `show()` de
  `main.ts:97-99` hasta que la interfaz avise que lo aplicó. O pasarlo con `additionalArguments` o por el
  preload. Esto también cubre el caso de abrir por primera vez, cuando `localStorage` todavía está vacío.
- Estas no son las únicas salidas. La más barata para el fallo principal es el oyente de `matchMedia`. El
  destello se puede tratar aparte y elegir ahí entre `localStorage` y el proceso principal según cuánto se quiera
  tocar Electron.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:** `tests/ui/app/appearance.test.tsx` con `// @vitest-environment happy-dom`.
  - Con `vi.stubGlobal('matchMedia', ...)`, poner un `MediaQueryList` falso con `matches` modificable y que
    guarde los oyentes de `addEventListener` y `removeEventListener`.
  - Poner `useApp.setState({ settings: { ...DEFAULT_SETTINGS, appearance: { theme: 'system', reducedEffects: false } } })`
    y montar `useAppearance` con `renderHook`.
  - Con `matches=false`, afirmar que `<html>` tiene `light` y `data-theme="light"`.
  - Cambiar `matches=true` y llamar a los oyentes de `change` dentro de `act`. Afirmar que `<html>` ahora tiene
    `dark` y `data-theme="dark"`.
  - Cambiar el tema a `dark` en el store y afirmar que el oyente se quitó. Desmontar y afirmar que no quedan
    oyentes.
  - Si se hace la parte del destello, una segunda prueba que cargue `theme-boot` con
    `localStorage.setItem(..., 'light')` y afirme que `<html>` queda en `light` antes de montar `App`.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/app/appearance.test.tsx"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/ui/app/appearance.test.tsx`).
- **Verificación manual:**
  - Con Tema = Sistema, abrir DevTools › Rendering › «Emulate CSS media feature prefers-color-scheme» y alternar
    entre light y dark. Berland debe cambiar en el acto. También se puede cambiar el modo de aplicaciones de
    Windows con Berland abierto.
  - Con Tema = Claro, cerrar y volver a abrir Berland. La ventana no debe verse oscura en ningún momento.
