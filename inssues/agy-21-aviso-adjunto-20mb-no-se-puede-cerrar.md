# El aviso de adjunto rechazado («máximo 20 MB» o «máximo 20 archivos») no se puede cerrar y sigue visible después de enviar o de cambiar de chat

- **Área:** Interfaz
- **Severidad:** baja
- **Archivos:** `src/ui/features/composer/useAttachments.ts:20`, `src/ui/features/composer/useAttachments.ts:31-34`, `src/ui/features/composer/useAttachments.ts:45-55`, `src/ui/features/composer/useAttachments.ts:70-74`, `src/ui/features/composer/Composer.tsx:71-73`, `src/ui/features/composer/Composer.tsx:146-156`, `src/ui/features/composer/Composer.tsx:166-182`, `src/ui/features/chat/ChatView.tsx:337-349`, `src/ui/features/chat/ChatView.tsx:361`, `src/ui/app/App.tsx:26`, `src/ui/app/App.tsx:28`, `tests/ui/composer/Composer.test.tsx:136-143`
- **Estado:** resuelta
- **Origen:** revisión de agy, verificada por Claude

## Cómo ocurre
Cuando se adjunta un archivo de más de 20 MB, el composer lo rechaza y deja un aviso en rojo
(`useAttachments.ts:48-50`):

```ts
if (file.size > MAX_ATTACHMENT_BYTES) {
  setNotice('Cada archivo debe pesar como máximo 20 MB.');
  continue;
}
```

Lo mismo ocurre al pasar de 20 adjuntos (`useAttachments.ts:52-54`, «Puedes adjuntar como máximo 20 archivos.»).
El aviso se dibuja como un párrafo dentro de `<div role="alert">` y no trae botón para cerrarlo
(`Composer.tsx:178-182`):

```tsx
<div role="alert" className="flex flex-col gap-0.5 px-3 text-[0.8125rem] text-danger">
  {alerts.map((line, i) => <p key={`${i}:${line}`}>{line}</p>)}
</div>
```

Pasos:
1. En un chat de proyecto o en una conversación suelta, soltar, pegar o elegir con «+» un archivo de más de 20 MB.
2. Aparece «Cada archivo debe pesar como máximo 20 MB.» sobre el campo de texto.
3. Escribir un mensaje y enviarlo con éxito. El texto y la bandeja se vacían, pero el aviso sigue ahí.
4. Abrir otro chat del mismo proyecto desde la barra lateral. El aviso viejo sigue sobre el composer del chat nuevo.
5. Con 20 adjuntos y el aviso «máximo 20 archivos» visible, quitar varios con su «X». El aviso tampoco se va, aunque
   ya hay sitio.

El aviso solo se borra cuando se vuelve a llamar a `add` (`useAttachments.ts:46`, `setNotice('')`), es decir, al
intentar adjuntar otra cosa, o cuando se desmonta el composer (al salir del proyecto o cambiar de vista).

Lo que agy tenía mal: el aviso **no bloquea la interfaz**. `canSend` no mira `notice` (`Composer.tsx:71-73`), así que
se puede seguir escribiendo, adjuntando y enviando. El problema es de presentación: un `role="alert"` viejo que no se
descarta y que acaba contando algo que ya no corresponde al chat. Además, cualquier llamada a `add` lo limpia, no solo
la de un archivo válido.

## Por qué pasa
- `notice` es un estado propio del hook (`useAttachments.ts:20`) y solo `add` lo pone a `''` (`useAttachments.ts:46`).
  Ni `clear` (`useAttachments.ts:31-34`), al que llama `send` tras un envío aceptado (`Composer.tsx:155`), ni `remove`
  (`useAttachments.ts:70-74`) lo tocan. `send` sí limpia su propio `error` (`Composer.tsx:150`), pero no el aviso de
  adjuntos.
- `alerts` junta `attachments.notice`, los errores de subida y `error` en una sola lista sin acción de cierre
  (`Composer.tsx:166-170`). Los errores de subida se quitan quitando el adjunto y `error` se limpia al reenviar; el
  aviso de adjunto rechazado no tiene nada equivalente.
- El composer no se vuelve a montar al cambiar de chat: `ChatView` lleva `key` por proyecto (`App.tsx:26`,
  `` key={`p:${route.projectId}`} ``) o fija en las conversaciones sueltas (`App.tsx:28`, `key="suelto"`), y
  `<Composer>` no lleva `key` propia (`ChatView.tsx:361`). El estado del hook, aviso incluido, pasa de un chat a otro.
- Contraste en la misma pantalla: el aviso de la vista (`ChatView.tsx:337-349`) sí tiene botón «Cerrar aviso» que
  llama a `useChat.getState().setNotice(null)`. El del composer no.

## Solución posible
Hacer que el aviso caduque cuando deja de ser cierto y darle un cierre explícito:
1. En `useAttachments`, exponer `dismissNotice` (`() => setNotice('')`) y llamar a `setNotice('')` también dentro de
   `clear` y de `remove`. Así desaparece al enviar con éxito y al quitar adjuntos.
2. En `Composer.tsx`, pintar `attachments.notice` aparte de los errores de subida, en una fila con un botón
   `aria-label="Cerrar aviso"` (icono `X` de lucide, como en `ChatView.tsx:341-348`) que llame a
   `attachments.dismissNotice()`.

### Otras opciones
La propuesta no es la única y puede haber una más optimizada:
- Borrar el aviso solo cuando el usuario vuelve a escribir en el campo (en `onChange` del textarea) o al cabo de unos
  segundos. Un temporizador es más simple, pero un `role="alert"` que desaparece solo puede no dar tiempo a leerlo con
  lector de pantalla; si se elige, conviene un plazo largo y pausarlo con foco o con el puntero.
- Para que el estado no cruce de chat, dar al composer `key={chat?.id ?? 'nuevo'}` en `ChatView.tsx:361`. Esto también
  resetearía el borrador y la bandeja al cambiar de chat, que es un cambio de comportamiento aparte y habría que
  decidirlo a propósito; si no se quiere, basta con limpiar el aviso en un efecto que dependa del `chatId`.
- Mover el aviso al `notice` de la vista (`useChat.setNotice`), que ya tiene botón de cierre. Mezcla un aviso local del
  composer con los avisos del chat, así que parece peor opción.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta en `tests/ui/composer/Composer.test.tsx`, junto a «rechaza tamaño superior a 20 MB con
  aviso» (líneas 136-143):
  - Escenario «el aviso de 20 MB se puede cerrar»: pegar un archivo con `size` `MAX_ATTACHMENT_BYTES + 1`, comprobar el
    `alert` con «20 MB», pulsar el botón «Cerrar aviso» y afirmar que `screen.queryByText(/20 MB/)` es `null`.
  - Escenario «el aviso desaparece al enviar»: pegar el archivo grande, escribir texto, Enter, esperar a que
    `onSubmit` se llame y afirmar que ya no hay `alert` con «20 MB».
  - Escenario «quitar adjuntos borra el aviso de límite»: pegar 21 archivos, esperar las 20 subidas, quitar uno con
    su botón de quitar y afirmar que el texto «20 archivos» ya no está.
- Comando (WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/composer/Composer.test.tsx"`;
  PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/composer/Composer.test.tsx`.
- Verificación manual en la app: en un chat de proyecto, soltar un archivo de más de 20 MB; el aviso debe tener «X» y
  desaparecer al pulsarla. Repetir y enviar un mensaje: el aviso no debe seguir después del envío. Repetir y abrir otro
  chat del mismo proyecto: el aviso no debe aparecer en el chat nuevo.
