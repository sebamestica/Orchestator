# Issue 10 — Modo chat (núcleo)

Estado: hecho · Commit: uno solo con la interfaz (`10-modo-chat-ui.md`), a nombre del usuario y sin trailers

## Lo que pidió el usuario
«Un modo chat donde pueda hablar con algún agente como si estuviera hablando con Claude Code, donde pueda subirle
archivos e imágenes. En el chat con el agente, algo parecido a la barra de pensamiento de ChatGPT para elegir si quiero
que su respuesta sea rápida o en el momento.»

## Contrato (`src/shared/api.ts`, líneas indicadas por A0)
- `sendMessageBody`: `effort: effortSchema.optional()`, justo después de `attachmentIds`.
- `mindModeSchema = z.enum(['plan', 'auto', 'bypass', 'chat'])` y `MIND_MODE_CYCLE = ['auto', 'plan', 'bypass', 'chat']`,
  con el comentario del modo `chat`.

## Diseño
### Modo `chat` (`src/core/conductor/session.ts`, `prompt.ts`)
- **La mente deja de orquestar** y trabaja como un Claude Code directo en la carpeta del chat, con o sin proyecto.
- **Herramientas de la flota.**
  - `crear_tareas` y `delegar` salen de `allowedTools` y entran en `disallowedTools`, así el modelo no las ve.
  - Además, la guardia las niega mientras el modo sea `chat`.
  - Siguen `estado` (con proyecto), `cupos`, `leer_memoria`, `buscar_skills` y `escribir_memoria` (con proyecto).
- **Herramientas de Claude Code.** Read, Grep, Glob, Agent y `BYPASS_TOOLS` (Edit, Write, NotebookEdit, Bash, PowerShell),
  con la misma guardia que en bypass:
  - escritura en la carpeta del chat y sus carpetas extra;
  - shell con la política de los workers y la carpeta como raíz;
  - push y lo demás, prohibido;
  - `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`.
- **Agente suelto.** También tiene modo `chat`, con la carpeta del chat como raíz. En bypass, el agente suelto sigue
  sin edición, como en el issue 8.
- **Cambio de modo a mitad de sesión** (la sesión sigue viva si hay subagentes trabajando):
  - edición y shell valen solo en `chat`, o en `bypass` con proyecto;
  - `crear_tareas` y `delegar` se niegan en cuanto el modo pasa a `chat`.
- **Lectura.** Como en plan y auto: la carpeta, las carpetas extra, los adjuntos y el hub de skills. No lee las
  unidades enteras: eso es solo del bypass.
- **Adjuntos.** Las imágenes y los archivos ya funcionan por `/attachments`. No cambia nada.

### Prompt
- **Prefijo.** Sigue idéntico en todos los modos. Solo se ajustan las frases que nombran los modos que editan
  («Fuera de los modos bypass y chat…», «Solo en bypass y chat…»), y se aclara que en chat la forma de trabajar de la
  flota no aplica.
- **`MODE_TEXT.chat`** (contexto dinámico):
  - el texto de A0;
  - las herramientas y sus límites;
  - los adjuntos;
  - la concisión según el esfuerzo del turno;
  - preguntar solo si elegir mal cuesta trabajo;
  - sin commits ni cambios de rama salvo que lo pida el usuario;
  - las prohibiciones de siempre.
- **El modo `chat` siempre muestra su texto**, también sin proyecto, en lugar del bloque «Agente suelto».
- **Nota de esfuerzo.** Si el mensaje trae `effort`, al texto que recibe la mente se le antepone una línea
  `[Esfuerzo de este turno: …]`. Así sabe qué tan breve ser. El historial guarda el texto del usuario sin esa nota.

### Esfuerzo por mensaje (`src/core/chat/service.ts`, `routes.ts`, `ConductorSession`)
- **Esfuerzo del turno:** `input.effort ?? settings.mind.effort`. Sale de la clave de la sesión: cambiarlo no recrea el
  proceso.
- **`ConductorSession.setEffort(effort)`:**
  - antes del primer mensaje, cambia las opciones;
  - con la conversación en marcha, usa `Query.applyFlagSettings({ effortLevel })` del SDK 0.3.302, sin recrear;
  - devuelve `false` si el SDK no lo permite.
- **Si no se pudo aplicar:**
  - sin subagentes vivos, la sesión se recrea con `resume`, que conserva la conversación;
  - con subagentes vivos (regla del issue 7), no se recrea. El turno usa el esfuerzo de la sesión viva y el log lo anota.
- **La ruta `POST /chats/:id/messages`** ya pasa el cuerpo validado. Se documenta `effort` y se regenera `docs/api/**`.

### Elegir el modelo del chat
No lo hago. Pide un campo `model` en `chatSchema` y una columna en `src/core/chat/db.ts`, que no es mío. Lo propongo en
el informe: `patchChatBody.model` (opus-5-5, sonnet-5-5, haiku-5-5), y la sesión lo aplica en vivo con
`Query.setModel()`.

### Interfaz mínima
- `ModeChip.tsx` muestra `chat` («Chat · como Claude Code»). Las etiquetas viven en `MODE_INFO`
  (`src/ui/features/chat/format.ts`).
- Al agregar `chat` a `MindMode`, `format.ts` y `Composer.tsx` dejan de compilar (son mapas por modo), y las pruebas del
  ciclo de Shift+Tab cambian. Hago lo mínimo para que compilen y lo informo.

## Rutas
- **Propias:**
  - `src/shared/api.ts` (lo indicado);
  - `src/core/conductor/**`, salvo `tools.ts`;
  - `src/core/chat/service.ts` y `src/core/chat/routes.ts`;
  - `src/ui/features/chat/components/ModeChip.tsx`;
  - `tests/core/conductor/**`, `tests/core/chat/**` y `tests/ui/chat/mode*.test.tsx`;
  - `docs/api/**` (regenerado);
  - este documento.
- **Fuera de mis rutas, solo lo que el contrato obliga** (se informa):
  - `src/ui/features/chat/format.ts` (`MODE_INFO.chat`);
  - `src/ui/features/composer/Composer.tsx` (los dos mapas del modo);
  - `tests/ui/chat/chat-view.test.tsx` y `tests/ui/composer/Composer.test.tsx` (ciclo con `chat`).

## Criterios de aceptación
1. En modo `chat`, el SDK recibe Read, Grep, Glob, Agent, Edit, Write, NotebookEdit, Bash y PowerShell, y no recibe
   `crear_tareas` ni `delegar` (fuera de `allowedTools` y dentro de `disallowedTools`). Vale con proyecto y sin él.
2. La guardia del modo `chat`:
   - escribe en la carpeta y en las carpetas extra;
   - niega fuera de ellas y en `denyPaths`;
   - niega `git push` y `rm -rf` fuera;
   - niega `crear_tareas` y `delegar`.
3. El prefijo es idéntico byte a byte en los cuatro modos.
4. El `effort` de un mensaje llega a las opciones del SDK, en vivo con `applyFlagSettings` o al recrear la sesión con
   `resume`. Con subagentes vivos no se recrea y queda en el log.
5. El ciclo con Shift+Tab incluye `chat`: auto → plan → bypass → chat → auto.
6. `npm run -s check` en verde, con cifras reales.

## Resultado
- **Pruebas nuevas o ampliadas:**
  - `tests/core/conductor/session.test.ts`: +7, sobre el modo chat con proyecto y sin él, la guardia, el cambio de modo
    en vivo y `setEffort`;
  - `tests/core/conductor/prompt.test.ts`: +2, y el de prefijo idéntico ahora cubre cuatro modos con proyecto y sin él;
  - `tests/core/chat/chat-mode.test.ts`: 7, nuevo;
  - `tests/core/chat/background.test.ts`: +1;
  - `tests/ui/chat/mode-chip.test.tsx`: 3, nuevo;
  - las pruebas del ciclo en `tests/ui/chat/chat-view.test.tsx` y `tests/ui/composer/Composer.test.tsx`.
- **`docs/api/openapi.json`** regenerado: el enum de modos suma `chat`. Las rutas `/chats` no están en la documentación
  generada.
- **`scripts/win.sh npm run -s check`:** exit 0 (typecheck, lint, test, build:ui y build:desktop).
  - Archivos de prueba: 140 aprobados y 10 saltados, de 150.
  - Pruebas: 1766 aprobadas y 20 saltadas, de 1786.
- **No ejecutado:** `applyFlagSettings` con el SDK real (el núcleo sigue detenido; está probado con dobles).

## Propuestas fuera de mis rutas
- **Modelo por chat:**
  - `chatSchema.model?` y `patchChatBody.model?`, validados (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`);
  - una columna `model` en `src/core/chat/db.ts`;
  - en `ChatService`, aplicarlo en vivo con `Query.setModel()`, igual que el esfuerzo.
- **`src/core/app/conductor.ts:42`:** `mode?: Exclude<MindMode, 'bypass'>` ahora admite `chat` en la terminal antigua.
  Propongo `Exclude<MindMode, 'bypass' | 'chat'>`.
- **`src/core/conductor/tools.ts`:** no hace falta tocarlo. `crear_tareas` y `delegar` se ocultan con `allowedTools`,
  `disallowedTools` y la guardia.
