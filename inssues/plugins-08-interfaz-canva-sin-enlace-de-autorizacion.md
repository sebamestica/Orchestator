# La tarjeta de Canva no muestra el enlace de autorización: si la pestaña no se abrió o se cerró, no hay cómo retomarlo

- **Área:** Plugins y navegador
- **Severidad:** baja
- **Archivos:** `src/ui/features/plugins/PluginsView.tsx:57`, `src/ui/features/plugins/PluginsView.tsx:72`, `src/ui/features/plugins/PluginsView.tsx:80`, `src/ui/features/plugins/PluginsView.tsx:86`, `src/core/plugins/service.ts:71`, `src/core/plugins/service.ts:211`, `src/core/plugins/service.ts:424`, `src/shared/api.ts:473`, `tests/ui/plugins/PluginsView.test.tsx:36`
- **Estado:** abierta

## Cómo ocurre
Conectar Canva es un OAuth en dos tiempos. `POST /plugins/canva/connect` descubre el servidor, registra el cliente
(o reutiliza el que ya tenía) y deja un intento pendiente de 10 minutos. El plugin queda en `connecting`, con los pasos
`CANVA_CONNECTING_STEPS` (`src/core/plugins/service.ts:424`). Mientras ese intento siga vivo, `status()` incluye el
`authUrl` en el `Plugin` que devuelven `GET /plugins` y `/ws` (`src/core/plugins/service.ts:211`):

```ts
const authUrl = id === 'canva' && s.status === 'connecting' && this.#canva.pendingAlive() ? this.#authUrl : undefined;
```

El contrato también lo describe como algo que la interfaz abre (`src/shared/api.ts:473-474`: «URL que la interfaz abre
en el navegador para iniciar sesión (OAuth)»), y los pasos que se muestran al usuario dan por hecho que el enlace está a
la vista (`src/core/plugins/service.ts:71-74`):

```ts
'Inicia sesión en Canva en la pestaña que se abrió y acepta los permisos.',
'Si no se abrió, abre el enlace de autorización (vale 10 minutos y una sola vez).',
```

Pasos:
1. En Plugins, pulsas «Conectar» en Canva.
2. La vista abre la URL una sola vez, al recibir la respuesta del POST (`PluginsView.tsx:57-63`). En Electron llama a
   `window.orq.openExternal` (navegador del sistema). En la web usa `window.open` después de un `await` de red, y con
   `noopener` el valor de retorno siempre es `null`, así que la vista no puede saber si el navegador lo bloqueó.
3. La pestaña no se abre, o el usuario la cierra antes de autorizar. La tarjeta muestra el paso «Si no se abrió, abre el
   enlace de autorización…» (`PluginsView.tsx:80`), pero no dibuja `plugin.authUrl` en ningún lado. En `src/ui`,
   `authUrl` solo se usa dentro de `change()` (`PluginsView.tsx:55-59`).
4. Con `connecting`, `active` es verdadero (`PluginsView.tsx:72`). Por eso el único botón de Canva es «Desconectar»
   (`PluginsView.tsx:86`). Para recuperar el enlace hay que pulsar «Desconectar» (llama a `disconnect()`, que descarta el
   intento y además pasa por la revocación y borra la entrada de la bóveda) y luego «Conectar» otra vez. La alternativa
   es esperar 10 minutos a que `status()` lo marque como caducado (`service.ts:208-209`).

La prueba actual (`tests/ui/plugins/PluginsView.test.tsx:36-42`) solo comprueba que se llama a `window.open` al pulsar
«Conectar». No cubre el estado `connecting` que llega por `GET /plugins` o `/ws`.

Corrección al reporte original: volver a conectar no registra otro cliente OAuth mientras el puerto siga igual.
`CanvaConnector.start` reutiliza el cliente si coinciden el emisor y la `redirectUri` (`src/core/plugins/canva.ts:114`),
y `disconnect()` no lo borra (`canva.ts:174-191`). El costo real es tener que desconectar y reconectar, y que la
instrucción que se muestra no se puede seguir.

## Por qué pasa
La interfaz usa el `authUrl` del contrato `Plugin` solo como efecto inmediato del clic en «Conectar» y nunca lo pinta.
En cambio, el núcleo lo sigue enviando mientras el intento está vivo y redacta los pasos como si el enlace estuviera
visible. Además, `active` agrupa `connecting` con `connected`, así que durante el intento solo se ofrece «Desconectar».

## Solución posible
En `src/ui/features/plugins/PluginsView.tsx`:
- Sacar a una función la apertura con validación de protocolo que ya existe (líneas 59-62), por ejemplo
  `openAuthUrl(href)`: `new URL`, solo `https:`/`http:`, y luego `window.orq.openExternal` o
  `window.open(..., 'noopener,noreferrer')`.
- Cuando `plugin.id === 'canva' && plugin.status === 'connecting' && plugin.authUrl`, mostrar un botón
  «Abrir la página de Canva» (`aria-label="Abrir la página de Canva"`) que llame a `openAuthUrl(plugin.authUrl)` y
  muestre el error en el `role="alert"` si falla.
- Mientras el estado sea `connecting`, poner «Cancelar» en lugar de «Desconectar» en el botón de Canva, con
  `aria-label="Cancelar conexión de Canva"`. Puede seguir llamando a `POST /plugins/canva/disconnect`.

### Otras opciones
- Cambiar el segundo paso de `CANVA_CONNECTING_STEPS` (`service.ts:73`) para que no hable de un enlace, por ejemplo «Si
  no se abrió, pulsa Cancelar y vuelve a Conectar». Es el cambio mínimo, pero el `authUrl` que ya llega a la interfaz
  seguiría sin usarse.
- Permitir «Conectar» de nuevo mientras está en `connecting`, como «Reintentar». `start()` ya invalida el intento
  anterior (`canva.ts:121-123`), así que no haría falta pasar por `disconnect()`, que además revoca y borra la bóveda.
  Se podría combinar con el botón de abrir: «Abrir la página de Canva» reutiliza el intento vivo y «Reintentar» crea
  uno nuevo.
- Mostrar el enlace como `<a href target="_blank" rel="noopener noreferrer">`. En la web, el clic directo del usuario
  evita el bloqueo de ventanas emergentes. En Electron, `setWindowOpenHandler` (`apps/desktop/src/main.ts:55-59`) ya
  manda esa URL a `shell.openExternal` si `allowedExternalUrl` la acepta, así que no haría falta código aparte.

La propuesta no es la única. La opción más barata es combinar «Reintentar» con el texto del paso corregido. El botón de
abrir es mejor para el usuario porque no gasta un intento nuevo.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta, en `tests/ui/plugins/PluginsView.test.tsx`: el primer `GET /plugins` responde con
  `{ ...canva, status: 'connecting', steps: [...], authUrl: 'https://www.canva.com/oauth?x=1' }`, sin pulsar «Conectar».
  Se afirma que existe `getByRole('button', { name: 'Abrir la página de Canva' })`, que al pulsarlo se llama a
  `window.open('https://www.canva.com/oauth?x=1', '_blank', 'noopener,noreferrer')` (o a `window.orq.openExternal` si se
  simula `window.orq`), y que el botón de la tarjeta dice «Cancelar» y no «Desconectar». Un segundo caso con
  `connecting` sin `authUrl` (intento caducado) afirma que el botón de abrir no aparece, y otro con
  `authUrl: 'javascript:alert(1)'` (lo rechazaría el `z.url()` del esquema o la validación de protocolo) afirma que no se
  abre nada.
- Comando (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/plugins/PluginsView.test.tsx"`
  (o, desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/ui/plugins/PluginsView.test.tsx`).
- Verificación manual: en Berland, Plugins → Canva → «Conectar». Cierra la pestaña de Canva sin autorizar y vuelve a
  Plugins. Tiene que aparecer «Abrir la página de Canva», que abre de nuevo la autorización, y al aceptar la tarjeta
  pasa a «Conectado».
