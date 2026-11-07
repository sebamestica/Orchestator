# Las skills casi no llegan a las tareas: el catálogo es corto, la búsqueda falla y las referencias salen rotas

- **Área:** Mente, planificador y skills
- **Severidad:** media
- **Archivos:** `src/core/conductor/tools.ts:421-451` (`buscar_skills`), `src/core/conductor/tools.ts:30` (`MAX_SKILLS`), `src/core/app/f5-chat.ts:104-105`, `src/core/app/conductor.ts:111-124` (`projectSkillsPort`), `src/core/app/planner.ts`, `src/core/adapters/claude-sdk/adapter.ts:132-137` (`taskReadRoots`), `src/core/brief/render-brief.ts:91`, `src/shared/tasks.ts:16-18`, `C:\dev\agent-hub\skills\*`, `docs/plan/F6-FLUJO-RAPIDO.md` §4
- **Estado:** abierta
- **Origen:** pedido del usuario (2026-11-07) y la base real (`orquestador.db`, copia de solo lectura)
- **Relacionadas:** `mente-09-subagentes-de-la-mente-solo-leen.md` (los programadores también usan `buscar_skills`), F6 lote A2 «Manual y skills»

## Cómo ocurre

Pedido del usuario: «actualizar el listado de skills que tenemos en Berland para la creación de tareas o trabajos, para
que sea más eficiente y más rápido».

Lo que muestra la base real:

- **Tareas:** de 19 tareas, solo 7 llevan `skillRefs`. Esas 7 suman 15 referencias, y 13 son un nombre suelto
  (`reels-sin-errores` ×6, `navegador-chrome` ×4, `videos-editoriales` ×2, `uix-skills` ×1). Solo 2 son una ruta a un
  `SKILL.md`.
- **Búsquedas:** la mente llamó a `buscar_skills` con textos como «investigación web búsqueda fuentes», «empaquetado
  instalador distribución zip electron», «linkedin perfil profesional» y «github profile readme». En el hub no hay ninguna
  skill para esos trabajos.

El hub común (`C:\dev\agent-hub\skills`, el mismo que `~/.claude/skills`) tiene 12 skills:

- de herramientas puntuales: blender-mcp-interactivo, canva-mcp, canva-navegador, navegador-chrome, py-malla-qa,
  slicer-segmentacion-osea, powerpoint-presentaciones, whatsapp-flota y local-compute-scheduling;
- de estilo: frontend-design y humanizer, las dos con la descripción en inglés;
- de reglas de flota: flota-orquestador, con 37 líneas.

Ninguna cubre el trabajo de software de todos los días: escribir una issue, resolverla con una prueba roja, backend,
frontend más allá de lo visual, seguridad web, revisión o repartir trabajo entre subagentes. Las del plan F6 §4.2
(`proceso-estandar`, `desarrollo-issues`, `backend`, `frontend-ingenieria` y `seguridad-web`) siguen sin escribirse.

## Por qué pasa

1. **Faltan las skills de proceso.** Cada tarea arranca sin el método común: qué leer, cómo probar, cómo informar. El
   método existe, pero está repartido en documentos que la búsqueda no ve:
   - `inssues/README.md`, con el formato de las issues;
   - `agent-hub/salidas/berland/prompt-issues.md`, con el método para resolverlas;
   - `docs/plan/F6-FLUJO-RAPIDO.md` §4.
2. **La búsqueda es por subcadena exacta** (`tools.ts:428-444`).
   - Suma 3 puntos si el término aparece en el nombre y 1 si aparece en la descripción.
   - No reduce las palabras a su raíz ni usa sinónimos: «issues» no encuentra «incidencia» y «prueba» no encuentra
     «tests».
   - Las descripciones en inglés no responden a búsquedas en español.
   - Devuelve como mucho 5 resultados (`MAX_SKILLS`).
3. **En el chat de F5 la mente no ve las skills del proyecto.** `f5-chat.ts:105` llama a
   `projectSkillsPort(comp.skills)` sin `projectDir`, así que solo lista el hub. Por ejemplo, las 19 skills de
   `C:\dev\Vetworld\.agents\skills` (`quality-gate-and-commits`, `playwright-webgl-e2e`, `critico-morfologico`…) no
   aparecen nunca en un chat de Vetworld. El comentario de `conductor.ts:111-115` explica por qué no se usa la carpeta
   del núcleo, pero el chat sí conoce la carpeta de su proyecto (`chat.cwd`).
4. **El planificador no sabe que existen las skills.** `planner.ts` (Sonnet, convierte el plan de `crear_tareas` en
   tareas) no menciona `skillRefs`. Una tarea lleva skills solo si la mente las escribió en el texto del plan y el
   planificador las copió.
5. **Los nombres sueltos no sirven.**
   - `taskReadRoots` (`adapter.ts:132-137`) solo abre para lectura las referencias absolutas.
   - `render-brief.ts:91` escribe «- skill: \`navegador-chrome\`» sin ruta.
   - Resultado: el worker recibe un nombre que no puede abrir, y 13 de las 15 referencias reales no le llegaron.

## Solución posible

### A. Catálogo de skills (en `C:\dev\agent-hub\skills`, con el método de `skill-creator`)

Cada skill nueva o revisada sigue estas reglas:

- **Descripción.** `description` en español dice qué hace y **cuándo usarla**, con las frases que diría el usuario y algo
  insistente, porque los modelos tienden a no usar las skills. Es lo único que ven la mente y `buscar_skills`.
- **Cuerpo.** Menos de 500 líneas, en imperativo y explicando por qué. Las plantillas van en `references/` o `assets/` y
  los scripts repetidos en `scripts/`.
- **Pruebas.** Cada skill trae 2 o 3 encargos de prueba en `evals/evals.json`, corridos con la skill y sin ella, más 20
  consultas de disparo (las que deben activarla y las casi parecidas que no) para ajustar la descripción con
  `run_loop.py`.
- **Validación.** Valida con `src/core/skills/skill-md.ts`: `name` y `description` de hasta 1024 caracteres.

Skills nuevas, en orden de impacto:

| Skill | Para qué | De dónde sale |
|---|---|---|
| `crear-issues` | Escribir una issue verificada en el código: síntoma visto por el usuario, cabecera (área, severidad, archivos con archivo:línea, estado), cómo ocurre, por qué pasa, solución y otras opciones, cómo probar (prueba, comando WSL y PowerShell, verificación manual). Evidencia de uso real con copias de solo lectura de la base y del log | `inssues/README.md` y esta misma carpeta |
| `desarrollo-issues` | Tomar una issue: prueba roja, arreglo mínimo, prueba verde, gate (`scripts/win.sh npm run -s check`, uno a la vez), un commit por issue a nombre del usuario, `Estado: resuelta` con el commit | F6 §4.2 y `prompt-issues.md` |
| `subagentes-en-paralelo` | Repartir un cambio entre programadores: archivos propios sin solapes, encargo con resultado y verificación, Sonnet por defecto y Opus solo en lo difícil, segundo plano por omisión, revisión del conjunto | `mente-09`, `mente-10` y F6 |
| `proceso-estandar` | Sondeo, pruebas de sondeo, plan único, ejecución, verificación e integración, según quién esté disponible (Claude, Codex o agy) | F6 §4.1 |
| `backend`, `frontend-ingenieria`, `seguridad-web` | Las reglas de F6 §4.2 y §4.3 | F6 |

Skills que hay que mejorar:

- **`flota-orquestador`:** agregar el modo local, el subagente programador, el reparto de F6 y las trampas que ya están
  en la memoria: `win.sh` del worktree, junction de `node_modules`, Defender con varios checks.
- **`frontend-design` y `humanizer`:** agregar en `description` las frases en español con que se piden («rediseña»,
  «se ve mal», «que no suene a IA»).

### B. Núcleo: que las skills lleguen a la tarea

1. **`f5-chat.ts`:** pasar la carpeta del chat, `projectSkillsPort(comp.skills, chat.cwd)`, para que la mente y sus
   subagentes vean las skills del proyecto.
2. **`buscar_skills`:**
   - normalizar tildes y reducir cada término a su raíz (un prefijo de 5 letras basta para el español);
   - buscar también en los encabezados del cuerpo del `SKILL.md`, o en `metadata.palabras` si se define;
   - subir `MAX_SKILLS` a 8;
   - devolver la frase de «cuándo usarla».
3. **Catálogo en el contexto de la sesión:** una lista compacta de nombre y una línea por skill, después del marcador
   dinámico, para que la mente no tenga que adivinar qué buscar. Con 20 skills son unos 2 000 tokens, como la lista de
   skills de Claude Code.
4. **Planificador:** recibir el mismo catálogo y llenar `skillRefs` con **rutas absolutas** a `SKILL.md`.
   `plan.ts:271`, o `fleet.ts:907` al delegar, convierte un nombre suelto en su ruta usando el catálogo, y avisa en el
   resultado de `crear_tareas` si una referencia no existe.

### Otras opciones

- **Copiar el contenido de la skill en el encargo.** Es más directo, pero agranda cada brief y rompe la regla de citar la
  ruta: el agente abre solo lo que necesita.
- **Búsqueda semántica con embeddings.** Encuentra mejor, pero suma una dependencia y un índice que mantener. Con 20 o 40
  skills, el catálogo en el contexto y la raíz de palabras bastan.
- **Solo escribir las skills, sin tocar el núcleo.** Mejora la mente, pero las tareas seguirían llegando con nombres que
  el worker no puede abrir.

## Cómo probar que quedó resuelta

- **Pruebas automatizadas propuestas:**
  - `tests/core/conductor/tools.test.ts`: con un catálogo falso, «arreglar una issue con prueba roja» devuelve
    `desarrollo-issues`, «pruebas» encuentra una skill que dice «tests» o «prueba», y «diseño» encuentra
    `frontend-design` con la descripción ampliada;
  - `tests/core/app/`: el puerto del chat F5 con `cwd` lista las skills de `<cwd>/.agents/skills`;
  - planificador y plan: un `skillRefs: ['navegador-chrome']` llega al brief como
    `C:\dev\agent-hub\skills\navegador-chrome\SKILL.md`, `taskReadRoots` lo abre y una referencia inexistente da aviso;
  - `tests/core/skills/skill-md.test.ts`, o un script del hub: cada `SKILL.md` nuevo pasa `readSkillMeta`.
- **Evaluación de cada skill:** `evals/evals.json` con 2 o 3 encargos, corridos con la skill y sin ella, más el informe de
  `run_loop.py` sobre la descripción, revisados por el usuario en el visor de `skill-creator`.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh npx vitest run tests/core/conductor tests/core/skills tests/core/app`.
- **Verificación manual:** en un chat de Vetworld en bypass, pedir «arregla la issue X». La mente cita
  `desarrollo-issues` y las skills del proyecto, el brief de la tarea muestra rutas que se pueden abrir y el informe del
  worker dice que las leyó.
