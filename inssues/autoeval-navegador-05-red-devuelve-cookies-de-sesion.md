# Al revisar la red del Chrome personal, la mente y la flota reciben las cookies de sesión y los encabezados de autorización de tus cuentas abiertas

- **Área:** Plugins y navegador
- **Severidad:** alta
- **Archivos:** `src/core/plugins/chrome.ts:55`, `src/core/plugins/chrome.ts:101`, `src/core/conductor/session.ts:298`, `src/core/conductor/session.ts:314`, `src/core/conductor/guard.ts:184`, `src/core/chat/service.ts:448`, `src/core/adapters/claude-sdk/translate.ts:38`, `src/core/adapters/claude-sdk/translate.ts:69`, `src/core/adapters/claude-sdk/translate.ts:467`, `src/shared/redact.ts:6`, `src/shared/redact.ts:13`, `src/core/conductor/prompt.ts:28`, `C:\dev\agent-hub\tools\browser\chrome-personal.cmd:3` (fuera del repo), `C:\dev\agent-hub\tools\browser\node_modules\chrome-devtools-mcp\build\src\config\mcp-options.js:170`, `…\ToolHandler.js:270`, `…\formatters\NetworkFormatter.js:102`, `…\formatters\NetworkFormatter.js:128`, `…\formatters\NetworkFormatter.js:188`, `…\tools\network.js:78`, `…\tools\network.js:79`, `…\config\ConfigLocator.js:28`, `…\third_party\index.js:64892`, `…\third_party\index.js:65738`, `…\third_party\index.js:65113`, `…\third_party\index.js:165492`
- **Estado:** abierta
- **Origen:** autoevaluación de la mente (2026-11-05)
- **Relacionadas:** `mente-01` (otra opción que falta en el mismo lanzador: `--no-file-navigations`), `codex-04` (tachado de secretos de los plugins en la mente), `autoeval-navegador-01` (inyección), `autoeval-navegador-04` (pestañas del usuario)

## Cómo ocurre

**Contexto.** Revisar la red es parte del uso normal del navegador («leer consola y red», skill `navegador-chrome`).
`get_network_request` (`network.js:78`) devuelve el detalle de una petición: encabezados de ida y vuelta y cuerpos. Su
propia descripción, que el modelo lee, la ofrece para eso: «Useful for inspecting request headers (including 'Cookie')
and response headers (including 'Set-Cookie' …)» (`network.js:79`). Está permitida para la mente en todos los modos
(`session.ts:298`, `guard.ts:184`; el `deny` de `session.ts:314-324` no toca plugins) y para la flota de Claude y Codex.

`chrome-devtools-mcp` 1.11.0 tiene una opción para tachar los encabezados sensibles, pero viene apagada:

```js
// config/mcp-options.js:170-175
redactNetworkHeaders: {
    type: 'boolean',
    describe: 'If true, redacts some of the network headers considered sensitive before returning to the client.',
    default: false,
```

El lanzador del hub no la enciende (`chrome-personal.cmd:3`: `--autoConnect --usageStatistics=false
--performanceCrux=false --screenshotMaxWidth 1280 --workspace C:\dev %*`), y Berland no agrega nada
(`defaultChromeLauncher`, `chrome.ts:55-57`, solo `/c <lanzador>`). `ToolHandler.js:270` aplica ese valor en cada
respuesta, y con `false` el formateador devuelve los encabezados tal cual (`NetworkFormatter.js:128-136`), una línea
`- <nombre>:<valor>` por encabezado (`:188-201`).

Esos encabezados son los reales. Puppeteer mezcla en la petición los de `Network.requestWillBeSentExtraInfo`
(`third_party/index.js:65716`, `:65728` y `:65738` → `updateHeaders`, `:64892-64895`), que son los que Chrome manda de
verdad, con la cabecera `cookie` completa, **incluidas las cookies `HttpOnly`** que ni el JavaScript de la página puede
leer. La respuesta usa igual los encabezados reales (`third_party/index.js:65113`), con `set-cookie`.

**Pasos.**

1. El usuario tiene sesión abierta en un sitio (correo, panel de su hosting, banco). Chrome está conectado.
2. En un chat, la mente revisa por qué una página carga mal: `list_network_requests` y luego
   `get_network_request { reqid: … }` de una petición a ese sitio. O una página le pide que lo haga «para depurar»
   (`autoeval-navegador-01`).
3. La respuesta trae `- cookie:SID=…; HSID=…` y, si la hay, `- authorization:Bearer …`. Con eso, cualquiera puede usar
   la sesión del usuario.
4. Ese texto queda:
   - en el contexto del modelo, que lo puede repetir o mandar por un formulario (`autoeval-navegador-03`);
   - en la transcripción del SDK en disco (el propio código lo dice en `chat/service.ts:448`: «el SDK guarda la
     transcripción de la sesión en disco»);
   - en el evento `tool_result` de Berland (SQLite y `/ws`), resumido a 300 caracteres (`translate.ts:38` y `:467`), si
     el encabezado cae dentro de ese tramo. El tachado reconoce `authorization` y `bearer` (`redact.ts:13`) pero no
     `cookie` ni `set-cookie` (`redact.ts:6-14`), así que la cookie pasa sin tachar. Comprobado con los patrones
     actuales: `- authorization:Bearer abcdefghijklmnopqrstuvwx` sale como `- authorization:Bearer [REDACTADO]`, pero
     `- cookie:SID=g.a000abcdefghijklmnop…; HSID=AbCdEfGhIjKlMnOp` y `- set-cookie:session=s%3Aabcdef…; HttpOnly`
     salen iguales.

Lo mismo le pasa a un worker de Codex o de Claude que use la herramienta: su transcripción queda en su carpeta de
sesiones.

## Por qué pasa

El valor por defecto del MCP está pensado para depurar sitios propios en un navegador de prueba. En Berland el
navegador es el Chrome personal, con todas las sesiones del usuario, y nadie cambió ese valor al hacer el issue 11. La
regla del proyecto, «Ninguna clave ni secreto en tareas, memoria, mensajes ni respuestas» (`prompt.ts:28`), no alcanza
a las credenciales del navegador.

## Solución posible

1. **`src/core/plugins/chrome.ts:55-57`.** Que `defaultChromeLauncher` agregue `--redact-network-headers` a los
   argumentos. El `.cmd` del hub los reenvía con `%*`, y la puerta los pasa tal cual (`chromeServerSpec`,
   `chrome.ts:101-111`), así que cubre a la mente, a sus subagentes y a la flota de una vez. El MCP usa entonces el
   saneador de DevTools, una lista de encabezados permitidos: todo lo que no está en ella vuelve como `<redacted>`
   (`third_party/index.js:165492-165499`, llamado desde `NetworkFormatter.js:102-110`). Es la misma vía que propone
   `mente-01` para `--no-file-navigations`: conviene hacerlas juntas.
2. **Segunda red en `src/shared/redact.ts`.** Un patrón que tache el valor de `cookie` y `set-cookie` cuando vienen como
   encabezado (`- cookie:…`, `Cookie: …`, `"cookie": "…"`), hasta el fin de línea o la comilla. Cubre otras fuentes
   (salida de `curl -v` en bypass, registros pegados por el usuario). En `translate.ts:467` el tachado corre antes de
   `truncate`, que junta todo en una línea (`translate.ts:69-71`), así que el fin de línea sirve de tope. El segundo
   tachado del almacén ve el resumen ya aplanado y taparía el resto del resumen tras `cookie:`, lo que es aceptable.

### Otras opciones

- **Cambiar `chrome-personal.cmd` en el hub** (`C:\dev\agent-hub\tools\browser`, fuera del repo). Cubre también a Claude
  Code y Codex cuando se usan fuera de Berland, y a agy, que ni dentro de Berland recibe la puerta y usa su propio
  `chrome-personal` (`plugins/service.ts:461`), si ese apunta al mismo lanzador. Conviene hacerlo además del punto 1,
  no en su lugar, porque el lanzador del hub puede cambiar sin que Berland lo note.
- **Archivo de configuración del MCP.** `chrome-devtools-mcp` lee `%LOCALAPPDATA%\Google\cd4a\config.json`
  (`config/ConfigLocator.js:28-31`; hoy no existe). Con `"redactNetworkHeaders": true` ahí lo cubre todo lo que lance el
  MCP en esta cuenta, pero queda fuera del repo y nadie lo ve. Si existe, la línea de comandos le gana
  (`config/ConfigParser.js:229-235`), así que el punto 1 sigue mandando.
- **Negar `get_network_request` a la mente.** Corta la fuga, pero se pierde la depuración de red, que es un uso legítimo.
- **Tachar en la puerta** (`chrome-gate.ts`) las líneas `cookie` y `authorization` de las respuestas. Sirve aunque el
  MCP cambie, pero hay que mantener un formato de salida que no es nuestro.
- Queda un riesgo: el **cuerpo** de una respuesta puede traer un token (por ejemplo, la respuesta de un inicio de
  sesión), y la opción del MCP no lo tacha. Tampoco tacha la **URL**: `:path` y `referer` están en la lista de
  permitidos (`third_party/index.js:165708`), así que un `?token=` o un `code=` de OAuth en la URL sigue pasando. Lo
  cubren en parte `autoeval-navegador-03` (confirmar salidas) y el patrón de `redact.ts` para JWT (`redact.ts:12`).

La propuesta es abierta. Si se elige otra vía, basta con que pasen las pruebas.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta.**
  - `tests/core/plugins/chrome.test.ts`: un caso que afirme que `defaultChromeLauncher('C:\\x').args` termina en
    `--redact-network-headers`. Actualizar el caso «servidor `chrome-personal` = la puerta delante de `cmd.exe /c
    <lanzador>`…» (línea 151), que hoy fija la lista exacta de argumentos: ese caso usa `defaultChromeLauncher` con otra
    carpeta (`plugins/service.ts:466-468`), así que su lista esperada debe terminar en `--redact-network-headers`.
  - `tests/shared/redact.test.ts` (nuevo): `redactSecrets('- cookie:SID=abc123def456; HSID=zzz999yyy888')` no contiene
    `abc123def456` ni `zzz999yyy888` y sí `[REDACTADO]`. Lo mismo con `Set-Cookie: sesion=valor-largo-de-prueba;
    HttpOnly` y con `"cookie": "a=b1234567890"`. Afirmar también que `cookies del sitio` en una frase normal no se tacha.
- **Comando** (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/plugins/chrome.test.ts tests/shared/redact.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`:
  `npx vitest run tests/core/plugins/chrome.test.ts tests/shared/redact.test.ts`).
- **Verificación manual en la app.** Primero, a mano y en una pestaña tuya, abre
  `https://httpbin.org/cookies/set?prueba=valor-secreto-123` para que Chrome guarde la cookie (así el valor no pasa por
  el chat). Con Berland reiniciado con el cambio y Chrome conectado, abre un chat nuevo en modo chat y pide: «abre
  https://httpbin.org/robots.txt en una pestaña nueva, usa get_network_request con esa petición y muéstrame sus
  encabezados». Se usa `robots.txt` porque su cuerpo no repite las cookies (`/cookies` y `/headers` sí, y el cuerpo no
  se tacha). La línea `cookie` debe decir `<redacted>` y `valor-secreto-123` no debe aparecer en la respuesta, en el
  panel de actividad del chat ni en la transcripción del SDK. Antes del cambio, la misma prueba muestra
  `- cookie:prueba=valor-secreto-123`.
