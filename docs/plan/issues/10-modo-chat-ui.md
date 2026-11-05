# Issue 10 — Modo chat: la interfaz (composer y esfuerzo por mensaje)

Estado: hecho (interfaz) · Rama: `flota/c28-modo-chat` · Commit: lo hace A0, a nombre del usuario y sin trailers

## Lo que pidió el usuario
- «Quiero un modo chat donde pueda hablar con algún agente como si estuviera hablando con Claude Code, donde pueda
  subirle archivos e imágenes y cosas así.»
- «Puedes construirlo a partir de la studyapp que tenemos, sacando piezas.»
- «Algo parecido a la barra de pensamiento de ChatGPT, para elegir si quiero que su respuesta sea rápida […] para
  preguntas puntuales o cosas que necesito que me diga ahora ya.»

## Reparto
| Parte | Quién | Rutas |
|---|---|---|
| Núcleo del modo `chat` (modo nuevo de la mente, herramientas de Claude Code, esfuerzo por mensaje en la sesión) | otro agente, después | `src/core/**`, `ModeChip.tsx` |
| Barra de esfuerzo (`EffortSlider`) | agy, en otra rama | `src/ui/components/EffortSlider.tsx` |
| **Esta parte:** contrato `effort`, composer, envío, recuerdo por chat | c28 | abajo |

## Piezas que se toman de studyapp (`C:\dev\studyapp\packages\web\src`)
| Pieza de studyapp | Qué se toma | Dónde queda |
|---|---|---|
| `shared/components/AttachmentTray` | bandeja horizontal de miniaturas con botón redondo «quitar» en la esquina (`glass-surface`, `-right-1.5 -top-1.5`) | `composer/AttachmentTray.tsx` |
| `shared/components/FileThumbnail` | miniatura cuadrada `rounded-2xl` con imagen `object-cover` o el icono del tipo de archivo; esqueleto `animate-pulse` mientras carga | `composer/AttachmentTray.tsx` |
| `shared/utils/file-glyph.ts` | icono y color por extensión. Las marcas propias de Office y PDF (`FileMarks`) se cambian por iconos de `lucide-react` | `composer/file-glyph.ts` |
| `shared/components/Composer` (`hasFiles`, `pastedFiles`, `isEditable`, `claims`) | pegar con Ctrl+V en cualquier parte de la vista, no solo en el campo, salvo en otro campo editable; si el portapapeles trae texto, se pega el texto; con varios composers montados, solo el último atiende al soltar o pegar | `composer/files.ts`, `Composer.tsx` |
| `shared/utils/grow-textarea.ts` | el campo crece con el texto, hasta un tope | `composer/files.ts` |
| `shared/hooks/use-attachments.ts` | ya estaba portado en `useAttachments.ts` (miniatura por `URL.createObjectURL`, liberar al quitar o desmontar) | sin cambios de fondo |

Lo que no se copia: lingui (Berland escribe en español directo), `ContextMenu` y `CommandPicker` propios de
studyapp (se usa el `Popover` de HeroUI que ya usa el composer), dictado por voz y vista previa de PDF (pdf.js no
está en `package.json`).

## Diseño
**Composer, al estilo Claude Code.** Dentro de la caja redondeada `rounded-[1.625rem] bg-foreground/[0.06]`:
1. bandeja de adjuntos arriba: imágenes como miniaturas de 64 px y archivos como fichas con icono, nombre y tamaño;
   cada una con su «quitar» en la esquina; mientras sube, un indicador giratorio (`motion-reduce:animate-none`);
2. el campo de texto, a todo el ancho; mientras se arrastran archivos, el texto de ayuda cambia a «Suelta los archivos
   para adjuntarlos»;
3. barra inferior: «+» (adjuntar), ficha de modo (si la vista no dibuja la suya), **esfuerzo de razonamiento**, y a la
   derecha enviar o detener.

Al arrastrar archivos sobre la ventana aparece la capa `.drop-overlay` «Suelta para adjuntar» y la caja se resalta.
Las imágenes pegadas sin nombre propio (`image.png`) se renombran `imagen-pegada-N.png`, para que cada ficha tenga
su nombre y su «Quitar …» no se repita.

**Esfuerzo de razonamiento.** El `EffortSlider` de agy va tal cual en la barra del composer, junto a la ficha de
modo. Trae su propio botón «Esfuerzo: Equilibrado ⌄» y su panel flotante con el nivel, el deslizador y una frase de
ayuda (`EFFORT_HINTS`), así que el composer no lo envuelve. En la vista de chat, la ficha de modo del núcleo
(`ModeChip`) queda justo encima de la caja. La vista le pasa los 5 niveles (`effortSchema.options`), como en
Ajustes: con los 4 que trae por defecto, un esfuerzo `xhigh` de Ajustes mostraría «Muy profundo» con el
deslizador en «Rápido».

**Recuerdo por chat** (`chat/store.ts`):
- `efforts: Record<chatId, Effort>` en el store, con respaldo en `localStorage` (`berland.chat.effort`). Cada lectura
  y escritura va con try/catch, se valida con `effortSchema` y se guardan como máximo 200 chats;
- `draftEffort`: lo elegido antes de que exista el chat; al crearlo pasa al chat nuevo;
- sin elección, vale el esfuerzo de la mente de Ajustes (`settings.mind.effort`);
- borrar un chat (o recibir `chat_deleted`) olvida su esfuerzo.

**Envío.** `send(chatId, text, attachments, effort)` manda `{ text, attachmentIds, effort }` a
`POST /chats/:id/messages`. La vista pasa el esfuerzo vigente del chat en cada mensaje, también en las sugerencias
del chat vacío.

**Contrato.** `src/shared/api.ts`, `sendMessageBody`: `effort: effortSchema.optional()`, justo después de
`attachmentIds`. El agente del núcleo agrega la misma línea. Sin ella, el `strictObject` del núcleo rechazaría el
mensaje.

## Rutas
- `src/shared/api.ts`: solo la línea de `effort`;
- `src/ui/features/composer/**`: `Composer.tsx`, `useAttachments.ts`, `AttachmentTray.tsx`, `file-glyph.ts`,
  `files.ts`;
- `src/ui/features/chat/store.ts`, `src/ui/features/chat/ChatView.tsx`;
- `src/ui/components/EffortSlider.tsx`: de agy, se usa sin cambios;
- pruebas: `tests/ui/composer/**`, `tests/ui/chat/**`.

## Criterios de aceptación
1. Soltar o pegar una imagen crea un adjunto con vista previa (`<img>` con la URL local) y lo sube con `attachFile`.
2. Pegar con Ctrl+V fuera del campo de texto también adjunta; en otro campo editable no.
3. Quitar un adjunto lo saca de la bandeja, libera su URL y no vuelve aunque la subida termine después.
4. El esfuerzo elegido viaja como `effort` en el cuerpo de `POST /chats/:id/messages`.
5. El esfuerzo se recuerda por chat: al volver a un chat se ve el suyo, y sobrevive a recargar (por `localStorage`).
   Un chat sin elección usa el de Ajustes.
6. Accesibilidad: foco visible en todos los botones, `aria-label` en los que solo tienen icono y en el panel, y
   `motion-reduce` en las animaciones.
7. `npm run -s check` en verde (incluye `build:ui`).

## Lo que necesita del núcleo
- Leer `effort` de `sendMessageBody` y usarlo en ese turno, sin recrear la sesión de la mente por cambiarlo (hoy
  el esfuerzo forma parte de la clave de sesión; ver issue 7).
- El modo `chat` en `mindModeSchema`, `MODE_INFO` y `ModeChip`. El composer ya no lleva su propia tabla de nombres
  de modo: usa `MODE_INFO`, así que un modo nuevo aparece solo.
