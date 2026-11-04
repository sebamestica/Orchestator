# Plan de implementación: text-utils

Necesito crear una pequeña librería nativa de utilidades de cadenas en Node 24 sin ninguna dependencia externa de npm.
La plantilla base ya cuenta con la estructura del proyecto y un ejecutor de pruebas nativo configurado como gate (`node --test`).

El trabajo se divide en 3 tareas independientes que se ejecutarán en paralelo en sus propios worktrees:

1. **task-slug: Generador de slugs para URL**
   - Implementar la función `slugify(text)` en `src/slug.mjs`.
   - La función debe convertir cualquier cadena en un slug apto para URL: limpiar diacríticos/acentos, convertir a minúsculas, sustituir caracteres especiales y espacios por guiones simples, y quitar guiones al inicio o final.
   - Completar las pruebas unitarias en `test/slug.test.mjs`.
   - Gate local: `node --test` debe pasar.

2. **task-case: Transformaciones camelCase y snake_case**
   - Implementar las funciones `camelCase(text)` y `snakeCase(text)` en `src/case.mjs`.
   - `camelCase` debe transformar frases separadas por espacios, guiones o mayúsculas en identificadores en camelCase (primera letra minúscula).
   - `snakeCase` debe transformar frases en palabras separadas por guión bajo en minúsculas.
   - Completar las pruebas unitarias en `test/case.test.mjs`.
   - Gate local: `node --test` debe pasar.

3. **task-truncate: Truncado de cadenas con elipsis**
   - Implementar la función `truncate(text, maxLength, suffix = '...')` en `src/truncate.mjs`.
   - Si la cadena es más corta o igual a `maxLength`, devolverla tal cual.
   - Si supera `maxLength`, recortarla y agregar el sufijo sin que el total supere `maxLength`.
   - Completar las pruebas unitarias en `test/truncate.test.mjs`.
   - Gate local: `node --test` debe pasar.

## Integración y aceptación
- Cada tarea modifica exclusivamente sus archivos asignados (`ownedPaths`).
- Al integrar las 3 tareas juntas en la rama principal, el gate general (`node --test`) debe pasar en verde sin conflictos ni regresiones.
