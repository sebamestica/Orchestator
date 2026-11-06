# Ajustes y la ficha del chat describen Bypass como «Auto que lee fuera de la carpeta»: no dicen que la mente edita archivos y ejecuta comandos sin preguntar

- **Área:** Interfaz: tablero, panel, ajustes
- **Severidad:** media
- **Archivos:** `src/ui/features/settings/MindSection.tsx:18-22`, `src/ui/features/settings/MindSection.tsx:159-184`, `src/ui/features/chat/format.ts:7-12`, `src/ui/features/chat/components/ModeChip.tsx:36`, `src/ui/features/chat/ChatView.tsx:360`, `src/core/conductor/prompt.ts:143-153`, `src/core/conductor/session.ts:59-67`, `src/shared/api.ts:20-23`, `tests/ui/settings/settings.test.tsx:52-61`, `tests/ui/chat/mode-chip.test.tsx:16`
- **Estado:** resuelta

## Cómo ocurre
Desde el issue 8 (commit `ee6b125`, `docs/plan/issues/08-bypass-autonomo.md`), el modo Bypass ya no es «Auto con más
lectura». En un chat con proyecto, la mente trabaja sola, como un Claude Code autónomo: edita y crea archivos y ejecuta
Bash o PowerShell en la carpeta del proyecto y en las carpetas extra del chat. No pregunta ni muestra el plan. El núcleo
lo dice así:

- Contrato (`src/shared/api.ts:20-23`): «`bypass`: la mente trabaja sola, como un Claude Code autónomo con la flota a
  mano. Edita, crea archivos y ejecuta comandos ella misma en la carpeta del proyecto […] No pregunta ni muestra planes».
- Prompt de la mente (`src/core/conductor/prompt.ts:145`): «Hazlo tú mismo cuando sea más rápido que delegar: lee,
  edita y crea archivos (Read, Edit, Write) y ejecuta comandos (Bash, PowerShell) en la carpeta del proyecto…».
  Y en `prompt.ts:147`: «No preguntes ni pidas confirmación».
- Herramientas (`src/core/conductor/session.ts:59`):
  `export const BYPASS_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell'] as const;`. Se activan con
  `modeActs` (`session.ts:65-67`): `mode === 'chat' || (mode === 'bypass' && !standalone)`.

La interfaz nunca se actualizó. Muestra el texto de antes del issue 8 en dos lugares:

1. Ajustes › Mente y subagentes › «Modo inicial de los chats» (`src/ui/features/settings/MindSection.tsx:21`):
   ```ts
   { value: 'bypass', label: 'Bypass', description: 'Como Auto, y además lee fuera de la carpeta y pasa a main sin preguntar si el gate pasa.' },
   ```
2. La ficha de modo que va encima del composer en cada chat (`ChatView.tsx:360` → `ModeChip.tsx:36`, que pinta
   `info.hint`). El texto sale de `src/ui/features/chat/format.ts:10`:
   ```ts
   bypass: { label: 'Bypass', hint: 'Como Auto, lee fuera de la carpeta y pasa a main si el gate pasa.', tone: 'text-danger' },
   ```

Pasos:
1. Abrir `#/ajustes/mente` y leer la opción «Bypass» de «Modo inicial de los chats». Dice que es como Auto, con más
   lectura y paso a main.
2. Elegir Bypass como modo inicial, abrir un chat nuevo en un proyecto y pedir un cambio pequeño (por ejemplo,
   «agrega una línea al README»).
3. La mente edita el archivo de la carpeta del proyecto ella misma, sin crear tarea ni pedir aprobación
   (`prompt.ts:145-147`). En Auto, un cambio así habría pasado por una tarea de la flota, un worktree y el gate. Ni
   Ajustes ni la ficha del chat avisan de esa diferencia.

Quien elige Bypass por la descripción cree que sus chats nuevos solo delegan a la flota, como en Auto, y que sus cambios
pasan por worktree y gate. En realidad, la mente puede tocar la carpeta del proyecto directamente.

Relacionado, ya reportado aparte: la misma tarjeta tampoco ofrece «Chat» como modo inicial (ver
`inssues/agy-01-modo-chat-ausente-en-modo-inicial.md`). Este issue trata solo del texto de los modos. Las dos cosas se
pueden arreglar en el mismo cambio.

## Por qué pasa
- Los textos de los modos están en dos tablas de la interfaz que no se comparten: `MODES` en `MindSection.tsx:18-22` y
  `MODE_INFO` en `format.ts:7-12`. Ninguna sale del núcleo.
- El issue 8 solo tocó el núcleo: prompt, session, guard y sus pruebas. Su diagnóstico enumera `prompt.ts`,
  `session.ts`, `guard.ts` y `tools.ts`, pero no los textos de la interfaz (`docs/plan/issues/08-bypass-autonomo.md:21-41`).
  Por eso las dos descripciones de Bypass se quedaron como estaban.
- Ninguna prueba mira el contenido de esas descripciones:
  - `tests/ui/settings/settings.test.tsx:58` busca el radio por `/Bypass/`;
  - `tests/ui/chat/mode-chip.test.tsx:16` solo pide que la etiqueta no esté vacía.

## Solución posible
1. Reescribir la descripción de Bypass en `src/ui/features/settings/MindSection.tsx:21` para que diga lo que hace hoy.
   Por ejemplo: «La mente hace el trabajo ella misma, sin preguntar: edita archivos y ejecuta comandos en la carpeta del
   proyecto, delega lo largo a la flota y pasa a main si el gate pasa. Además lee fuera de la carpeta.»
2. Cambiar en el mismo sentido el `hint` corto de `src/ui/features/chat/format.ts:10`. Por ejemplo: «Hace los cambios
   ella misma sin preguntar, delega lo largo y pasa a main si el gate pasa.» Va truncado en una línea
   (`ModeChip.tsx:36`), así que conviene que lo importante (editar sin preguntar) vaya al principio.
3. Opcional, en la misma tarjeta: destacar Bypass con el mismo tono rojo de la ficha (`MODE_INFO.bypass.tone`,
   `text-danger`), para que en Ajustes también se vea que es el modo de más riesgo.

### Otras opciones
La propuesta no es la única, y puede haber una mejor:
- **Una sola fuente de textos.** Sumar a `MODE_INFO` un campo `description` largo y hacer que `MindSection` recorra
  `mindModeSchema.options` con `MODE_INFO[m].label` y `.description`. Así Ajustes y la ficha no pueden contar cosas
  distintas, y un modo nuevo (como `chat`) aparece solo en Ajustes. Esto también arregla
  `agy-01-modo-chat-ausente-en-modo-inicial.md`.
- **Matiz «con proyecto».** En una conversación sin proyecto, Bypass no edita ni ejecuta (`modeActs` en
  `session.ts:65-67` exige `!standalone`). Se puede decir en la descripción larga («en un proyecto…»), o dejarlo fuera
  para que el texto quede corto.
- **Dejar fijo el texto en una prueba.** Si se prefiere no tocar la estructura, basta con corregir los dos textos y
  sumar las afirmaciones de la prueba de abajo, para que el próximo cambio de modo los rompa.

## Cómo probar que quedó resuelta
- Pruebas automatizadas propuestas:
  - `tests/ui/settings/settings.test.tsx`, caso nuevo «la descripción de Bypass avisa que edita y ejecuta sin
    preguntar». Arma `fakeCore` con `GET /mind/candidates` (como en `:52-55`) y renderiza
    `<SettingsView section="mente" />`. Dentro del `radiogroup` «Modo inicial», el radio `/Bypass/` debe contener un
    texto que mencione editar archivos (`/edita/i`), ejecutar comandos (`/comandos/i`) y no preguntar (`/sin preguntar/i`).
    No debe empezar por «Como Auto».
  - `tests/ui/chat/mode-chip.test.tsx`, caso nuevo: con `render(<ModeChip mode="bypass" … />)` aparece un `hint` que
    menciona `/sin preguntar/i`. Si se unifica en `MODE_INFO`, también: para cada `mindModeSchema.options`,
    `MODE_INFO[m].description` no está vacío, y `MindSection` muestra cada descripción.
- Comando (desde WSL):
  `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/settings/settings.test.tsx tests/ui/chat/mode-chip.test.tsx"`
  (o, en PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/settings/settings.test.tsx tests/ui/chat/mode-chip.test.tsx`).
- Verificación manual en la app:
  1. En `#/ajustes/mente`, la opción Bypass de «Modo inicial de los chats» dice que la mente edita y ejecuta comandos
     sin preguntar.
  2. En un chat de proyecto, pasar a Bypass con Shift+Tab: la línea junto a la ficha dice lo mismo, en corto.
