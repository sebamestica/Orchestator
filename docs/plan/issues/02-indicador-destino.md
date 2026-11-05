# Issue 2 — Encima del input: ¿se guarda en local o se sube a un repositorio?

Estado: plan · Commit: uno solo, a nombre del usuario y sin trailers · Depende de: issue 1 (texto del modo local)

## Problema
- El pie del chat (`src/ui/features/chat/ChatView.tsx` ≈357) solo tiene `ModeChip` y `Composer`. No dice dónde
  quedan los cambios.
- El plan de implementación no tiene dónde declarar «súbelo a tal repositorio»: `crear_tareas`
  (`src/core/conductor/tools.ts:126`) recibe solo `plan` y `proyecto`.

## Qué se quiere
Una línea discreta encima del input. Dice **«Local»** salvo que el usuario haya indicado en el plan un repositorio
donde subir los cambios.

## Diseño
- **Contrato (`src/shared/api.ts`, lo escribe A0):** `changesTargetSchema`, unión por `kind`:
  - `{ kind: 'local', path, git: 'none' | 'local' | 'remote', worktrees: boolean }`
  - `{ kind: 'remote', path, remote: { name: string | null, url }, branch: string | null, configured: boolean }`

  `url` siempre va saneada. Se agrega la ruta `GET /chats/:id/target` → `{ target }` y el mensaje en vivo
  `chat_target`.
- **`crear_tareas`:** campo opcional `destino: { remoto: string, rama?: string }`. Descripción para la mente: «solo
  si el usuario indicó explícitamente un repositorio donde subir los cambios; si no, omítelo».
  - El valor se guarda por chat (tabla `chat_targets`, `CREATE TABLE IF NOT EXISTS` sobre `store.database`).
  - Si `remoto` es un nombre (`origin`), se resuelve contra `git remote`. Si es una URL, se sanea y se marca
    `configured` según coincida o no con un remoto de la carpeta.
  - Sin `destino`, el chat queda en `local`. Un plan nuevo sin `destino` no borra un destino anterior: hay que
    decirlo explícitamente.
- **Lectura del estado git:** se reusa `readProjectStorage` y `sanitizeRemoteUrl` de la tarea
  `nucleo-almacenamiento-local` (`src/core/workspace/storage.ts` del commit `784def2`). Se toman solo esas dos
  funciones y sus pruebas, sin `initLocalRepo`.
- **Línea en la interfaz:** `TargetLine.tsx` va en el footer, justo encima de `ModeChip`. Texto de 0,75 rem, icono
  de lucide y `aria-live="polite"`.
  - Local sin git: «Local · se guarda en C:\dev\marketing · sin git».
  - Local con git: «Local · se guarda en C:\dev\marketing · no se sube a ningún repositorio».
  - Proyecto con worktrees: «Local · C:\dev\orquestador · ramas orq/… · no se sube».
  - Remoto: «Se subirá a github.com/sebamestica/Orchestator · rama main · solo con tu aprobación». Si
    `configured: false`, se añade «(el remoto no está configurado en la carpeta)».
  - Chat sin proyecto: «Local · <carpeta del chat>».
  - La respuesta se valida con Zod y se recarga al cambiar de chat y con `chat_target`.
- **Fuera de alcance:** el push. Berland hoy no sube nada. La línea remota solo anota el destino.

## Rutas propias
- Núcleo: `src/core/conductor/tools.ts`, `src/core/conductor/session.ts` (texto del prompt sobre `destino`),
  `src/core/chat/target.ts` (nuevo), `src/core/chat/routes.ts`, `src/core/chat/service.ts`,
  `src/core/workspace/storage.ts`, `src/core/workspace/index.ts`, `tests/core/chat/target*.test.ts`,
  `tests/core/workspace/storage.test.ts`, `tests/core/conductor/destino*.test.ts`.
- Interfaz: `src/ui/features/chat/components/TargetLine.tsx`, `src/ui/features/chat/target-line.ts`,
  `src/ui/features/chat/ChatView.tsx`, `tests/ui/chat/target-line*.test.tsx`.

## Criterios de aceptación
1. Un chat sin destino da `local`, con `git` y `worktrees` correctos para una carpeta sin git, una git sin remoto y
   el proyecto orquestador.
2. `crear_tareas` con `destino: { remoto: 'origin' }` da `remote` con la URL saneada y la rama.
3. Saneado de URLs: `https://token@github.com/a/b` → `https://github.com/a/b` y `git@github.com:a/b.git` →
   `github.com/a/b`.
4. Un remoto que no está en `git remote` queda con `configured: false`.
5. La interfaz muestra los cinco textos y se actualiza con `chat_target` sin recargar.
6. `npm run -s check` en verde, con `build:ui`.
