# Si falla un adjunto salen dos avisos de error, y el del composer culpa al servicio aunque el núcleo dio el motivo real

- **Área:** Interfaz: chat y composer
- **Severidad:** baja
- **Archivos:** `src/ui/features/chat/ChatView.tsx:163-170`, `src/ui/features/chat/ChatView.tsx:337-349`, `src/ui/features/chat/ChatView.tsx:368`, `src/ui/features/composer/useAttachments.ts:16`, `src/ui/features/composer/useAttachments.ts:59-66`, `src/ui/features/composer/Composer.tsx:166-182`, `src/ui/features/chat/store.ts:61-67`, `src/core/chat/attachments.ts:149`, `src/core/chat/attachments.ts:172-174`, `tests/ui/composer/Composer.test.tsx:163-170`
- **Estado:** resuelta

## Cómo ocurre
El composer (`Composer.tsx`) recibe de la vista de chat la función `onAttach`, que sube o registra cada archivo. En
`ChatView` esa función llama a `attachFile` (`store.ts:61-67`), que en Electron usa `POST /attachments/by-path` y en
la web sube los bytes a `POST /attachments`. Cuando el núcleo rechaza el archivo devuelve un `ApiError` con un
mensaje ya en español y preciso (`routes.ts:51-57`). Algunos ejemplos reales de `src/core/chat/attachments.ts`:

- `:149` «El adjunto está vacío» (web, archivo de 0 bytes; la UI solo filtra los de más de 20 MB, `useAttachments.ts:48`).
- `:172` «No existe el archivo» (Electron, la ruta ya no existe).
- `:174` «La ruta no es un archivo» (Electron, el usuario suelta una carpeta: `Composer.tsx:108-116` no filtra
  carpetas y `preload.ts:14-17` devuelve su ruta).

`ChatView` publica ese motivo en el aviso del pie y vuelve a lanzar el error (`ChatView.tsx:163-170`):

```ts
} catch (err) {
  useChat.getState().setNotice(`No se pudo adjuntar ${file.name}: ${errorText(err)}`);
  throw err;
}
```

`useAttachments` atrapa ese mismo error, descarta su mensaje y guarda un texto fijo (`useAttachments.ts:16` y `:63-64`):

```ts
const UPLOAD_ERROR = 'El servicio puede no estar disponible. Quita el archivo y vuelve a intentarlo.';
...
} catch {
  if (mounted.current) update(current.current.map((entry) => entry.id === item.id ? { ...entry, error: UPLOAD_ERROR } : entry));
}
```

El composer lo dibuja en su propio `role="alert"` (`Composer.tsx:168` y `:178-181`), y el pie dibuja el suyo
(`ChatView.tsx:337-338`, `<div role="alert" …>{notice}`).

Pasos (en la app de escritorio):
1. Abrir un chat y soltar una carpeta sobre la ventana.
2. El núcleo responde 400 «La ruta no es un archivo».
3. Aparecen dos alertas a la vez:
   - pie: «No se pudo adjuntar MiCarpeta: La ruta no es un archivo»;
   - composer: «No se pudo adjuntar MiCarpeta. El servicio puede no estar disponible. Quita el archivo y vuelve a intentarlo.»
4. El lector de pantalla anuncia las dos. La segunda contradice a la primera, porque el núcleo sí respondió.
5. Al quitar la ficha con su «X», la alerta del composer se va, pero la del pie sigue ahí hasta cerrarla a mano,
   cambiar de chat o enviar un mensaje con éxito (`store.ts:289`, `store.ts:408`). `remove` no la toca
   (`useAttachments.ts:70-74`).

En la web pasa lo mismo con un archivo vacío («El adjunto está vacío»).

Nota sobre el informe original: decía que el núcleo responde 415 «Tipo de archivo no admitido». Eso no existe. Los
códigos de `AttachmentError` son solo `invalid`, `not_found` y `too_large` (`attachments.ts:17`), que se traducen
a 400, 404 y 413 (`routes.ts:48`). Los motivos reales son los de la lista de arriba.

Las pruebas actuales no lo detectan. `tests/ui/chat/chat-view.test.tsx` usa un composer simulado
(`tests/ui/chat/fake-composer.tsx`) y solo prueba adjuntos que se suben bien (`chat-view.test.tsx:402-421`).
`tests/ui/composer/Composer.test.tsx:163-170` rechaza con `new Error('404')` y comprueba que la alerta diga
«servicio», o sea, fija el texto genérico como comportamiento esperado.

## Por qué pasa
Dos capas informan del mismo fallo sin coordinarse: `ChatView.onAttach` pone el aviso en el store del chat y relanza,
y `useAttachments` marca la ficha con su propio error. Además, `useAttachments` ignora el mensaje del error y siempre
usa `UPLOAD_ERROR`, que presume una caída del servicio aunque el núcleo haya respondido con un motivo concreto.

## Solución posible
1. `src/ui/features/composer/useAttachments.ts:63`: usar el mensaje del error y dejar el texto genérico solo para
   fallos de conexión:
   ```ts
   } catch (err) {
     const offline = err instanceof TypeError || (err instanceof ApiError && err.code === 'no_core') || !(err instanceof Error);
     const error = offline ? UPLOAD_ERROR : err.message;
     ...
   }
   ```
   `ApiError` está en `src/ui/api/client.ts:3`. Si el composer no debe depender del cliente, basta con
   `err instanceof Error && !(err instanceof TypeError) ? err.message : UPLOAD_ERROR`. El texto que se ve sería
   «No se pudo adjuntar X. La ruta no es un archivo», porque `Composer.tsx:168` ya antepone el nombre.
2. `src/ui/features/chat/ChatView.tsx:163-170`: quitar el `setNotice` y dejar que `onAttach` sea `attachFile`
   directamente, o solo relanzar. Así el error se ve en un solo lugar, junto a la ficha, y se va al quitarla.
3. Actualizar `tests/ui/composer/Composer.test.tsx:163-170` para que el caso «sin conexión» rechace con un
   `TypeError` (o `ApiError(0, 'no_core', …)`) y siga esperando «servicio».

### Otras opciones
- Dejar el aviso del pie con el motivo real y no poner texto de error en el composer: solo el borde rojo de la ficha
  y el bloqueo de envío (`Composer.tsx:72`). Es menos trabajo, pero el aviso queda lejos de la ficha y no se va al
  quitarla, así que habría que limpiarlo en `remove`.
- Filtrar antes, en el composer, los casos que se saben inválidos: archivos de 0 bytes, y carpetas en Electron
  (`file.size === 0 && file.type === ''` como pista, o una función del puente que diga si la ruta es carpeta). Así
  esos casos ni llegan al núcleo y se avisan como los de 20 MB (`useAttachments.ts:48-50`). Esto complementa la
  solución, no la sustituye: los fallos del núcleo (archivo borrado entre soltar y registrar) siguen necesitando el
  mensaje real.

La propuesta no es la única. La versión más limpia probablemente sea mostrar el error en un solo lugar (la ficha) con
el mensaje del núcleo y dejar el texto genérico solo para fallos de red.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta:
  - `tests/ui/composer/Composer.test.tsx`: `onAttach` rechaza con `new ApiError(400, 'invalid_request', 'La ruta no es un archivo')`.
    Tras pegar o soltar un archivo, esperar un único `role="alert"` que contenga «La ruta no es un archivo» y que no
    contenga «servicio puede no estar disponible». En otro caso, `onAttach` rechaza con
    `new TypeError('Failed to fetch')` y la alerta sí debe contener «servicio».
  - `tests/ui/chat/chat-view.test.tsx` (describe «adjuntos»): con `fakeCore` responder a `/attachments/by-path` con
    400 `{ error: { code: 'invalid_request', message: 'La ruta no es un archivo' } }`, llamar a `composer().onAttach(file)`,
    comprobar que rechaza y que el pie no muestra ningún `role="alert"` (`useChat.getState().notice` sigue en `null`).
- Comando (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/composer/Composer.test.tsx tests/ui/chat/chat-view.test.tsx"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/ui/composer/Composer.test.tsx tests/ui/chat/chat-view.test.tsx`).
- Verificación manual: en la app de escritorio, soltar una carpeta sobre un chat. Debe verse un solo aviso, junto a
  la ficha, con «La ruta no es un archivo», y debe desaparecer al quitarla. Con el núcleo detenido, adjuntar un
  archivo debe seguir mostrando el texto de «servicio no disponible».
