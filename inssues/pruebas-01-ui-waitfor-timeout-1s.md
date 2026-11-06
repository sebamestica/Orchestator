# En las pruebas de la interfaz, waitFor y findBy esperan solo 1 s y con la CPU cargada dan falsos rojos en el gate

- **Área:** Pruebas y rendimiento
- **Severidad:** media
- **Archivos:** `vitest.config.ts:9-17`, `vitest.config.ts:13-15`, `node_modules/@testing-library/dom/dist/config.js:15`, `node_modules/@testing-library/dom/dist/wait-for.js:16`, `tests/ui/settings/usage.test.tsx:124`, `tests/ui/settings/usage.test.tsx:155`, `tests/ui/settings/usage.test.tsx:160-161`, `tests/ui/settings/usage.test.tsx:172`, `tests/ui/settings/usage.test.tsx:183`, `tests/ui/settings/usage.test.tsx:189`, `tests/ui/settings/usage.test.tsx:202`, `src/ui/features/settings/UsageSection.tsx:54`, `src/core/orchestrator/fleet.ts:422-424`
- **Estado:** resuelta

## Cómo ocurre
Las pruebas de la interfaz (`tests/ui/**/*.test.tsx`, con `// @vitest-environment happy-dom`) renderizan vistas de HeroUI
y esperan el resultado con `findBy*` y `waitFor` de Testing Library. Estas utilidades tienen su propio tope de espera,
`asyncUtilTimeout`, que no depende del `testTimeout` de Vitest.

El proyecto ya sabe que la carga hace que todo vaya más lento. `vitest.config.ts:13-15` dice:

```ts
// 60 s: con la flota corriendo pruebas en paralelo en 4 núcleos, pruebas de 1 s llegaron a tardar 20 s.
testTimeout: 60_000,
hookTimeout: 60_000,
```

Ese margen cubre la prueba entera, pero cada `findBy`/`waitFor` sigue rindiéndose a los 1000 ms:

- `node_modules/@testing-library/dom/dist/config.js:15`: `asyncUtilTimeout: 1000,`
- `node_modules/@testing-library/dom/dist/wait-for.js:16`: `timeout = (0, _config.getConfig)().asyncUtilTimeout,`
- `@testing-library/react` (16.3.3) solo cambia `asyncWrapper`/`eventWrapper` (`dist/pure.js:77-84`), no el tope.

Pasos:
1. El gate (`npm run -s check`, que corre `vitest run`) se ejecuta con la CPU ocupada: otra copia del gate de la flota,
   otro agente o Defender revisando cada proceso nuevo.
2. `tests/ui/settings/usage.test.tsx:122-124` renderiza `SettingsView` y espera
   `await screen.findByTestId('total-month')`. Para que aparezca tienen que pasar el `fetch` falso, el parseo con Zod
   (`summaryFor` hace `usageSummaryResponse.parse`, línea 75, y `UsageSection` vuelve a validar con `usageSummaryResponse.safeParse`, `src/ui/features/settings/UsageSection.tsx:54`) y el render
   de las tarjetas y las tablas.
3. Si todo eso tarda más de 1 s, la prueba falla con «Unable to find an element by: [data-testid="total-month"]»
   aunque el código esté bien. Lo mismo vale para los `waitFor` de las líneas 155, 160-161, 172 y 183 y para los
   `findBy` de las líneas 151, 168, 189 y 202.
4. En la flota, un gate rojo devuelve la tarea al autor (`src/core/orchestrator/fleet.ts:422-424`: «La verificación
   del proyecto (gate) falló en el worktree»). El resultado es una ronda más del agente gastada, y el agente puede
   ponerse a «arreglar» código que estaba bien.

Sin carga, el margen ya es corto. En la última corrida guardada (`.orq/vite-cache/vitest/.../results.json`),
`usage.test.tsx` tardó 1332 ms en sus 6 pruebas, `chat-view.test.tsx` 4024 ms, `agents.test.tsx` 2937 ms y
`settings.test.tsx` 2778 ms. Con la ralentización de ×20 que documenta el propio `vitest.config.ts:13`, un render que
hoy dura 100-200 ms pasa de 1 s.

El riesgo no se limita a un archivo. Hay 207 llamadas a `findBy*`/`findAllBy*`/`waitFor(` en 14 archivos de
`tests/ui`: `chat/chat-view.test.tsx` 56, `settings/agents.test.tsx` 27, `composer/Composer.test.tsx` 23,
`settings/settings.test.tsx` 20, `settings/storage.test.tsx` 19, `projects/AddProjectDialog.test.tsx` 14,
`plugins/PluginsView.test.tsx` 14, `settings/usage.test.tsx` 10, y otras. Ninguna pasa `{ timeout }`, porque
`grep -rnE "timeout\s*:" tests/ui` no encuentra nada.

## Por qué pasa
Nadie configura Testing Library. `vitest.config.ts:9-17` no tiene `setupFiles`, y en `tests/` no hay ningún
`configure(` de Testing Library ni ningún `asyncUtilTimeout`. Queda el valor por defecto de 1000 ms. Al subir
`testTimeout` a 60 s se resolvió la mitad del problema (la prueba entera), pero en la interfaz el tope real que manda
es el de cada espera, y sigue en 1 s.

## Solución posible
1. Crear `tests/ui/setup.ts`. Dentro de `tests/ui` lo revisa `tsconfig.ui.json`, que tiene los tipos del DOM:
   ```ts
   // Solo en las pruebas con DOM (happy-dom): las del núcleo no cargan React ni Testing Library.
   if (typeof document !== 'undefined') {
     const { configure } = await import('@testing-library/react');
     // Igual que testTimeout: con la flota y Defender, un render de 100 ms llega a tardar segundos.
     // Un fallo de verdad sigue apareciendo, a los 15 s y no a los 60.
     configure({ asyncUtilTimeout: 15_000 });
   }
   ```
   Hay que importar desde `@testing-library/react`, que es lo que importan las pruebas, y no desde
   `@testing-library/dom`. Así se toca la misma instancia de configuración que usan `findBy`/`waitFor`, y se evita
   que Vite resuelva por `module` una copia distinta a la del `main` CJS.
2. En `vitest.config.ts`, dentro de `test`, agregar `setupFiles: ['tests/ui/setup.ts']`.

### Otras opciones
- Separar en `test.projects` de Vitest: un proyecto `core` con `environment: 'node'` y uno `ui` con
  `environment: 'happy-dom'` y su propio `setupFiles`. Así no hace falta la guardia `typeof document` ni el
  comentario `// @vitest-environment` en cada archivo. Además, cada proyecto podría tener su propio `maxWorkers`, lo
  que también ayuda con la carga. Es más cambio de configuración, pero queda más ordenado.
- Pasar `{ timeout: 10_000 }` en cada `findBy`/`waitFor`, o un helper tipo `findByTestIdSlow`. Son más de 200
  llamadas, mete ruido y es fácil olvidarlo en la próxima prueba.
- Limitar los workers de Vitest baja la carga, pero no quita el tope de 1 s. Sirve como complemento, no como
  reemplazo.
- El valor de 15 s es una propuesta. Cualquier valor bastante mayor que 1 s y menor que `testTimeout` (60 s) sirve.
  Quizás convenga leerlo de una variable de entorno, para que el gate de la flota use más margen que una corrida
  local.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: `tests/ui/setup-timeout.test.tsx` (`// @vitest-environment happy-dom`).
  1. `expect(getConfig().asyncUtilTimeout).toBe(15_000)` con `getConfig` de `@testing-library/react`. Así se confirma
     que el setup se cargó.
  2. Escenario determinista, sin depender de la CPU: un componente que muestra `<span data-testid="tarde" />` en un
     `setTimeout` de 1500 ms. `await screen.findByTestId('tarde')` debe resolverse. Hoy falla a los 1000 ms; con el
     arreglo pasa.
  3. Control: `await expect(screen.findByTestId('no-existe', {}, { timeout: 50 })).rejects.toThrow()`. El tope
     explícito se sigue respetando y un elemento que no está sigue fallando.
- Comando (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/setup-timeout.test.tsx tests/ui/settings/usage.test.tsx"`
  (o desde PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/setup-timeout.test.tsx tests/ui/settings/usage.test.tsx`).
- Verificación con carga, cuando la CPU esté libre para provocarla a propósito: correr dos `npx vitest run tests/core`
  en paralelo y a la vez `npx vitest run tests/ui`. Antes falla de vez en cuando con «Unable to find…» o con un
  `waitFor` vencido. Después pasa. Comprobar también que `npx vitest run tests/core` no se vuelve más lento: con la
  guardia `typeof document`, no carga React.
- No hay verificación manual en la app: el cambio es solo de pruebas.
