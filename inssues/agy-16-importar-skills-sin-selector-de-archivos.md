# Importar una skill obliga a escribir o pegar la ruta a mano: no hay botón para elegir la carpeta o el .zip

- **Área:** Interfaz
- **Severidad:** baja
- **Archivos:** `src/ui/features/settings/SkillsSection.tsx:93-100`, `src/ui/features/settings/SkillsSection.tsx:57-64`, `src/ui/features/chat/store.ts:52-58`, `apps/desktop/src/ipc.ts:39-44`, `apps/desktop/src/preload.ts:13-20`, `src/core/fs/folders.ts:422-437`, `src/core/app/f5-servidor.ts:166-177`, `src/core/server/app.ts:682-694`, `src/core/skills/hub.ts:255-302`
- **Estado:** abierta
- **Origen:** revisión de agy, verificada por Claude

## Cómo ocurre
En Ajustes › Skills (`#/ajustes/skills`), la tarjeta «Importar» dice «Carpeta o .zip local», pero solo trae un campo de texto y el botón de enviar:

```tsx
// src/ui/features/settings/SkillsSection.tsx:94-99
<form className="flex items-center gap-2 p-4" onSubmit={(e) => void doImport(e)}>
  <Input aria-label="Ruta de la skill" placeholder="C:\Users\yo\Downloads\mi-skill.zip" value={source} ... />
  <Button type="submit" size="sm" variant="primary" isPending={importing} isDisabled={source.trim() === ''}>
```

1. Abrir Ajustes › Skills.
2. Para importar hay que escribir o pegar la ruta absoluta (por ejemplo `C:\Users\SEBASTIAN\Downloads\skill.zip`). Mientras el campo está vacío, «Importar» queda deshabilitado (`:96`).
3. No hay ningún botón «Examinar…». Tampoco se puede arrastrar la carpeta o el zip a la tarjeta. Un error de tipeo recién aparece como error del núcleo al enviar (`doImport`, `:57-64`, que manda `{ source: path }` a `POST /skills/import`).

En otras pantallas sí hay selector. Agregar proyecto usa `window.orq.pickFolder()` o `POST /fs/pick-folder` (`src/ui/features/projects/AddProjectDialog.tsx:43`), y el chat usa `pickFolder()` de `src/ui/features/chat/store.ts:52-58` para las carpetas extra (`ChatView.tsx:188`).

## Por qué pasa
La sección se escribió solo con el campo de ruta. El núcleo necesita una ruta del disco: `importSkill` hace `stat` y, si es carpeta, `importFolder`; si no, exige `.zip` (`src/core/skills/hub.ts:255-302`). Por eso un `<input type="file">` normal no basta en la web, donde el navegador no da la ruta real.

Hay que corregir a agy en una cosa: la app **no** tiene un selector de archivos. Solo tiene uno de **carpetas**:
- Electron: `dialog.showOpenDialog(win, { title: 'Elige la carpeta del proyecto', properties: ['openDirectory'] })` (`apps/desktop/src/ipc.ts:42`).
- Web: `FolderBrowserDialog` de PowerShell con la descripción «Elige la carpeta del proyecto» por defecto (`src/core/fs/folders.ts:422-437`), servido en `POST /fs/pick-folder` (`src/core/app/f5-servidor.ts:166-177`).

Reusar `pickFolder()` tal cual resolvería solo el caso de la carpeta, con un título que habla de «proyecto», y dejaría el `.zip` sin selector. En Electron ya existe `pathForFile` (`apps/desktop/src/preload.ts:14-20`), que da la ruta real de un `File` elegido o soltado. El Composer ya lo usa con `<input type="file">` (`src/ui/features/composer/Composer.tsx:229`).

## Solución posible
Poner junto al campo dos botones con icono, «Carpeta…» y «Zip…», que rellenen `source` (sin importar solos, para que la persona vea la ruta antes de mandarla a cuarentena):
- **Carpeta:** llamar a `pickFolder()` de `chat/store.ts`. Lo ideal es que el título sea de skill, no de proyecto. Para eso `pickFolder` (IPC y `/fs/pick-folder`) tendría que aceptar un tipo de diálogo o una descripción validados (`folderPickerScript` ya recibe `description`).
- **Zip:** en Electron, un `<input type="file" accept=".zip" hidden>` y `window.orq.pathForFile(file)` para obtener la ruta. En la web, una ruta nueva del núcleo (`POST /fs/pick-file`, con `OpenFileDialog` y filtro `*.zip`) que siga el patrón de `createFolderPicker`: un solo diálogo a la vez, plazo, y 501 fuera de Windows.
- Si el selector falla o se cancela, avisar con `Notice` y dejar el campo como estaba.

### Otras opciones
Esta propuesta no es la única, y puede haber una más simple o más optimizada:
- Un solo diálogo nativo que acepte carpeta o zip. En Electron, `properties: ['openFile', 'openDirectory']` con filtro `zip`, aunque en Windows no se pueden combinar ambos en el mismo diálogo y habría que elegir. Con un IPC nuevo `pickSkillSource`, el preload expondría una sola orden.
- Arrastrar y soltar la carpeta o el zip sobre la tarjeta «Importar», usando `pathForFile` en Electron. Es cómodo, pero en la web no da la ruta.
- En la web, subir los bytes del zip (como hace `/attachments`) a una ruta de importación por carga. Así no depende de PowerShell, pero cambia el contrato y suma límites de tamaño en la subida.
- Como mínimo: seguir sin selector, pero con texto de ayuda («Copia la ruta con Mayús + clic derecho › Copiar como ruta») y quitar las comillas que Windows pone al pegar.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: `tests/ui/settings/skills.test.tsx` (nueva, con los ayudantes de `tests/ui/settings/helpers.ts`). Escenarios:
  1. Con `window.orq` simulado cuyo `pickFolder` devuelve `C:\skills\mi-skill`, pulsar «Carpeta…» deja esa ruta en el campo «Ruta de la skill» y habilita «Importar», sin llamar todavía a `POST /skills/import`.
  2. Sin `window.orq`, el mismo botón llama a `POST /fs/pick-folder` (o a la ruta nueva) y rellena el campo con `path`.
  3. Si se cancela (`null`), el campo no cambia. Si hay un error (por ejemplo 501), se muestra un `Notice` de error.
  4. En Electron, elegir un `File` en el input de zip usa `pathForFile` y rellena el campo con la ruta `.zip`.
- Comando (WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/settings/skills.test.tsx"`; PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/settings/skills.test.tsx`.
- Verificación manual en la app: abrir `#/ajustes/skills`, pulsar «Carpeta…», elegir una carpeta con `SKILL.md` y comprobar que la ruta aparece en el campo. Luego pulsar «Importar» y ver que la skill queda «En cuarentena». Repetir con «Zip…» y un `.zip`, y probarlo en la app de escritorio y en la web.
