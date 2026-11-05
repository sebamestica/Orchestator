# Issue 12 — «Conversaciones»: el chat sin proyecto ya no pide carpeta

Estado: hecho · Commit: uno solo, a nombre del usuario y sin trailers

## Lo que pidió el usuario
- «En "Agente suelto" me pide una carpeta y me parece estúpido: su función es la de un chatbot potenciado por Claude,
  Codex y agy.»
- «La idea es que no solicite ninguna carpeta, solo que me deje hablar con el chatbot para preguntas o cosas que
  necesite saber.»
- Su propuesta: encontrar el código que pide la carpeta y quitar ese parámetro, cuidando la lógica para que los
  componentes no se rompan.
- Cambiar el nombre «Agente suelto» por «Conversaciones».

## Dónde se pedía la carpeta
- **Interfaz:** `src/ui/features/chat/ChatView.tsx:144-160`. `createChat` abría `pickFolder()` antes del primer
  mensaje. Si no se elegía carpeta, el mensaje no se enviaba y aparecía «Elige una carpeta de trabajo para el agente
  suelto».
- **Núcleo:** `src/core/chat/service.ts:298`. `create()` rechazaba un chat sin proyecto y sin `cwd` («Un agente suelto
  necesita su carpeta (cwd)»).

## Por qué no basta con quitar el parámetro
La carpeta de trabajo (`chat.cwd`) la usan:
- la sesión de Claude Code (`cwd` del SDK);
- la guardia de la mente (raíz de lectura, escritura y shell, `session.ts:313`);
- la línea de destino (`resolveChangesTarget`);
- los modos chat y bypass.

Sin carpeta, todo eso se rompería.

## Solución
- **Núcleo.** Una conversación sin proyecto y sin `cwd` recibe una carpeta interna propia, creada por Berland:
  - Ubicación: `conversationsRoot(dataDir)/<chatId>`, en `src/core/chat/conversations.ts`, es decir
    `%LOCALAPPDATA%\berland-conversaciones\<chatId>`.
  - Va junto a la carpeta de datos del núcleo y no dentro de ella, para que la guardia siga negando por nombre esa
    carpeta (bóveda y base) en los comandos.
  - Es una carpeta por chat, para que el contexto de dos conversaciones no se mezcle (issue 9).
  - Solo se crea cuando el chat ya es válido.
  - Si alguien la vacía, vuelve a crearse al abrir la sesión.
  - Una conversación con `cwd` elegido (API o chats viejos) y los chats de proyecto no cambian.
- **Contrato.** `Chat.internalFolder: true` (opcional, se calcula al leer y no se guarda) marca la carpeta interna.
- **Interfaz.**
  - Crear la conversación ya no abre ningún selector.
  - Con carpeta interna, el encabezado no muestra la ruta ni el botón «Cerrar carpeta» (agy, hallazgo 14), y tampoco
    aparece la línea «Local · …» sobre el input.
  - Las carpetas extra siguen disponibles para quien quiera que lea archivos suyos.
- **Nombre.**
  - «Conversaciones» en la barra lateral, la portada y el encabezado (con el ícono de conversación).
  - La ruta pasa a `#/conversaciones`; los enlaces viejos `#/suelto` siguen abriendo lo mismo.
  - La mente lee «## Conversación»: responde directo como asistente y no pide carpeta.
  - Se actualizaron los mensajes de las herramientas sin flota y la documentación del API.

## Pruebas
- `tests/core/chat/conversations.test.ts`:
  - la raíz queda fuera de la carpeta de datos;
  - la carpeta interna es propia de cada chat y queda marcada;
  - la conversación responde sin que nadie elija carpeta, y la carpeta vuelve si se vació;
  - con `cwd` o proyecto nada cambia;
  - un chat inválido no deja carpeta.
- `tests/ui/chat/chat-view.test.tsx`: no pide carpeta, crea sin `cwd`, va a `#/conversaciones/<id>` y no muestra
  carpeta, línea ni «Cerrar carpeta».
- `tests/ui/routes.test.tsx`: `#/conversaciones` y el alias `#/suelto`.
- Los textos nuevos de la mente se ajustaron en prompt, session, tools, service y chat-mode.

## Fuera de alcance
Que «Conversaciones» responda con Codex o agy en lugar de Claude. Hoy la mente es Claude (Agent SDK); Codex y agy
trabajan como flota y necesitan proyecto. Queda como issue aparte si se quiere.
