# Procedencia de fixtures del hub de skills

Copiadas de los experimentos de c4 (`C:\dev\orquestador-wt\c4-memoria\.orq\exp\`, 2026-11-01). Nunca se ejecutan: las pruebas solo las leen, las copian a carpetas temporales o las listan con `tar`.

- `flota-orquestador/`, `navegador-chrome/`: copias exactas de `C:\dev\agent-hub\skills` (skills reales, válidas).
- `con-scripts/`: skill de prueba con `LICENSE` MIT, `metadata` en JSON en línea (formato real de las skills de Codex), nombre de archivo no ASCII y tres **scripts trampa** (`instalar.sh`, `limpiar.ps1`, `sin-extension` con shebang) que crearían `EJECUTADO.txt` si alguien los lanzara.
- `nombre-distinto/`: `name` del frontmatter distinto de la carpeta; `list()` debe marcarla inválida.
- `zips/` (generados con `mkzip.mjs`/`mkzip2.mjs` de c4, sin compresión):
  - `ok.zip` (`5868e367…bb79`): `s/SKILL.md` sin `description` y `s/guía ñ.md`.
  - `mal.zip` (`005c5eb0…b79d`): `../evil.txt`, `/abs.txt`, `s/..\evil2.txt`, `C:/x.txt`, `s/a:b.txt` y dos entradas sanas.
  - `lnk.zip` (`b7ac03df…f5f8`): `s/link -> ../../etc` (modo Unix 0o120777, solo visible con `tar -tvf`), una carpeta y dos archivos.

Las demás entradas raras (saltos de línea, controles, ancho completo `．．／`, emoji, enlaces absolutos) las fabrica `buildZip` en `tests/core/skills/helpers.ts`.
