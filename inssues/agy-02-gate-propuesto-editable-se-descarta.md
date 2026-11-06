# «Abrir una carpeta local» muestra el «Gate propuesto» en un campo editable y luego descarta lo que se escribe

- **Área:** Interfaz
- **Severidad:** baja
- **Archivos:** `src/ui/features/projects/AddProjectDialog.tsx:20`, `src/ui/features/projects/AddProjectDialog.tsx:36`, `src/ui/features/projects/AddProjectDialog.tsx:48-49`, `src/ui/features/projects/AddProjectDialog.tsx:73-74`, `src/shared/api.ts:567-571`, `src/core/app/f5-servidor.ts:218-225`, `tests/ui/projects/AddProjectDialog.test.tsx:33`
- **Estado:** abierta
- **Origen:** revisión de agy, verificada por Claude

## Cómo ocurre
El diálogo «Abrir una carpeta local» se abre desde la barra lateral (`src/ui/app/Sidebar.tsx:78`) y desde la portada (`src/ui/features/home/HomeView.tsx:46`).

1. Pulsar «Elegir carpeta» o «Explorar carpetas» y elegir una carpeta con `package.json` y un script `check`.
2. En el paso 2 («Revisa el proyecto antes de agregarlo») aparece un `<textarea>` editable con el gate detectado:
   ```tsx
   // AddProjectDialog.tsx:73-74
   <label className="block">Gate propuesto<textarea className={inputClass} value={gate} disabled={busy} placeholder="npm run -s check" onChange={(e) => setGate(e.target.value)} /></label>
   <p className="text-sm text-muted">Al agregar se usará el gate detectado; los cambios de este campo aún no se guardan.</p>
   ```
3. Cambiar el texto, por ejemplo a `npm test`, y pulsar «Agregar».
4. El cuerpo que se envía no lleva el gate:
   ```tsx
   // AddProjectDialog.tsx:48
   const body = projectFromFolderBody.parse({ path: inspection.path, name: name.trim(), id: id.trim() });
   ```
   El estado `gate` (`:20`, rellenado en `:36`) solo se usa para pintar el campo. El núcleo vuelve a inspeccionar la carpeta y guarda el gate que detectó él (`f5-servidor.ts:224`, `gate: gateForWorkspace(inspection.gate)`). En Ajustes › Proyectos sale ese gate, no el que se escribió.

Cuando no se detecta gate, el campo aparece vacío con el placeholder `npm run -s check`, que parece un valor sugerido, y el texto de ayuda sigue diciendo «se usará el gate detectado» aunque no se detectó ninguno. Si el usuario escribe un gate esperando que haya worktrees, el proyecto igual queda en modo local (`f5-servidor.ts:218`, `if (inspection.isGitRepo && report.hasCommits && inspection.gate)`). Lo atenúa el aviso de `src/core/fs/folders.ts:403-404` («No se encontró una verificación (gate): se trabajará en local…»), que la lista de avisos sí muestra (`AddProjectDialog.tsx:75`).

La interfaz no miente, porque la línea 74 avisa que no se guarda. El problema es que ofrece un control que no hace nada, y por eso la severidad es baja y no media como decía agy.

## Por qué pasa
El contrato no tiene dónde poner el gate. `projectFromFolderBody` es un `z.strictObject` con solo `path`, `name` e `id` (`src/shared/api.ts:567-571`). Si la interfaz añadiera `gate` al cuerpo, el `parse` de `AddProjectDialog.tsx:48` lanzaría un error de clave no reconocida, y el núcleo lo rechazaría con 400. El campo se dejó editable antes de que existiera el soporte en el núcleo, y en lugar de quitar la edición se agregó la aclaración de la línea 74. La prueba actual lo confirma: lee el valor del `<textarea>` (`tests/ui/projects/AddProjectDialog.test.tsx:33`) y comprueba que el cuerpo enviado es solo `{ path, name, id }` (`:37`).

## Solución posible
Mientras el núcleo no acepte un gate a medida, mostrar el gate detectado como texto de solo lectura y quitar el `<textarea>` y el estado `gate`:

- Con gate: `<p className="font-mono text-sm">npm run -s check</p>` con la etiqueta «Gate detectado». Con varios comandos, uno por línea o unidos con ` && `, como en `src/ui/features/settings/ProjectsSection.tsx:14`.
- Sin gate: un texto como «Sin gate: se trabajará en local», sin el placeholder `npm run -s check` que hoy parece una sugerencia.
- Quitar la frase de la línea 74, porque ya no habría nada editable que aclarar.

### Otras opciones
Esta propuesta no es la única y puede haber una más optimizada:

- **Permitir de verdad un gate a medida.** Añadir `gate?: { command, args }[]` a `projectFromFolderBody` (`src/shared/api.ts:567`) y, en `f5-servidor.ts`, usarlo en lugar de `inspection.gate` cuando venga, con el mismo filtro que aplica `gateForWorkspace`. Un gate manual también podría activar los worktrees en una carpeta git con commits donde no se detectó gate. Habría que decidir cómo convertir el texto a `{ command, args }`. Hoy `:36` une los argumentos con espacios y pierde las comillas, así que un argumento con espacios no se podría reconstruir; un editor por comando, con argumentos separados, evitaría ese problema. También hay que pensar en la seguridad, porque el gate es un comando que el núcleo ejecuta.
- **Dejar el campo, pero desactivado** (`readOnly` o `disabled`) con un enlace a dónde se podrá cambiar más adelante. Es el cambio más pequeño, aunque un `<textarea>` desactivado sigue pareciendo un formulario a medias.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: en `tests/ui/projects/AddProjectDialog.test.tsx`, ajustar el caso «elige con el puente, inspecciona y registra con nombre editable»:
  - Con la opción de solo lectura: `screen.queryByRole('textbox', { name: 'Gate propuesto' })` es `null`, el texto `npm run -s check` aparece como texto, y la frase «los cambios de este campo aún no se guardan» no aparece.
  - Nuevo caso con `gate: null` en la inspección: no se muestra el placeholder `npm run -s check` y sí el texto de modo local.
  - Si se elige permitir un gate a medida: editar el campo y comprobar que el `fetch` a `/projects/from-folder` lleva ese `gate` en el cuerpo, más una prueba del núcleo que verifique que el proyecto guardado tiene `workspace.gate` con el comando escrito.
- Comando (WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/projects/AddProjectDialog.test.tsx"`; PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/projects/AddProjectDialog.test.tsx`.
- Verificación manual en la app: abrir «Abrir una carpeta local», elegir una carpeta con script `check` y comprobar que el gate se ve como texto que no se puede editar (o, con la otra opción, que el gate escrito es el que aparece después en Ajustes › Proyectos). Repetir con una carpeta sin gate y comprobar que no aparece el placeholder `npm run -s check`.
