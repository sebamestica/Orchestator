# Issues abiertos de Berland (`inssues/`)

Esta carpeta junta los problemas **abiertos** que se encontraron en Berland (el orquestador de `C:\dev\orquestador`)
el 2026-11-05, después de integrar los planes de `docs/plan/issues/`. Hay **123 issues** (23 de ellas `autoeval-*`, agregadas después, y `mente-09`, `mente-10` y `skills-01`, verificadas el 2026-11-07 con las líneas de `edfc8a2`), uno por archivo `.md`, y
cada uno se verificó leyendo el código (archivo:línea). Los `uso-real-*` se verificaron además con copias de solo lectura
de la base y de los registros reales. Los números de línea son los del código en el commit `63748b8`. Si el código se
mueve, busca el fragmento citado.

No repiten lo que ya resolvieron los planes de `docs/plan/issues/`. Si un issue menciona «el issue 7» o «el issue 1»,
habla de esos planes, no de esta carpeta.

Origen de cada prefijo:

| Prefijo | De dónde salió |
|---|---|
| `flota-`, `adaptadores-`, `mente-`, `servidor-`, `datos-`, `plugins-`, `ui-chat-`, `ui-resto-`, `escritorio-`, `pruebas-` | Revisión por áreas (Claude) |
| `agy-` | Revisión de agy (Antigravity), verificada y corregida por Claude (lo que agy tenía mal está anotado en cada archivo) |
| `codex-` | Revisión de seguridad y corrección de Codex, verificada por Claude |
| `uso-real-` | Evidencia de uso real: la base `%LOCALAPPDATA%\orquestador\orquestador.db` y `logs\nucleo-escritorio.log` |
| `skills-` | Catálogo de skills del hub y cómo llegan a las tareas (`buscar_skills`, planificador, briefs) |
| `autoeval-` | Las vulnerabilidades que la propia mente de Berland dijo tener. Cada una se verificó en el código (5 verificadores, más un revisor que intentó refutar cada borrador) y se cruzó con las demás issues: solo se escribió lo que ninguna cubría |

La numeración tiene huecos (por ejemplo `flota-05` o `agy-03`): esos números no tienen archivo. Los cinco
duplicados que se fusionaron hoy están en «Duplicados fusionados».

## Cómo leer cada issue

Todos tienen la misma forma:

- **Cabecera.** Título (el síntoma, dicho como lo vería el usuario), `Área`, `Severidad`, `Archivos` (todas las
  citas archivo:línea que sostienen el diagnóstico) y `Estado`. Según el caso también traen `Origen`, `Fusiona` (qué
  duplicado absorbió) y `Relacionadas`.
- **Cómo ocurre.** Contexto mínimo y pasos concretos para reproducirlo, con el código citado.
- **Por qué pasa.** La causa raíz, separada del síntoma.
- **Solución posible** y **Otras opciones.** Una propuesta concreta, archivo por archivo, y alternativas con sus
  costos. La propuesta está abierta: cada issue dice que no es la única y que puede haber una mejor. Si eliges otra,
  basta con que la prueba del final pase.
- **Cómo probar que quedó resuelta.** La prueba automatizada que falta (archivo, escenario y qué afirmar), el comando
  para correrla desde WSL y desde PowerShell, y una verificación manual en la app.

Severidad (criterio aproximado con el que se calificó):

- **alta:** el usuario pierde trabajo o datos, un permiso o una desconexión no se cumple, o un fallo silencioso
  deja algo roto sin aviso.
- **media:** algo funciona mal de forma visible o cuesta cupo o dinero, pero hay salida.
- **baja:** molestias de interfaz, rendimiento, textos o pruebas poco fiables.

Al cerrar uno, cambia `Estado` a `resuelta` con el commit y deja el archivo, para conservar el diagnóstico.

## Duplicados fusionados

Se fusionaron en el archivo más completo, sumando lo que aportaba el otro, y el duplicado se borró:

| Se conserva | Se borró (su contenido quedó dentro) |
|---|---|
| [agy-09-datos-flota-obsoletos-tras-reconexion-ws.md](agy-09-datos-flota-obsoletos-tras-reconexion-ws.md) | `ui-resto-03-reconexion-ws-no-recarga-estado.md` |
| [agy-10-filtro-proyecto-tablero-deshabilitado-en-ruta.md](agy-10-filtro-proyecto-tablero-deshabilitado-en-ruta.md) | `ui-resto-06-tablero-global-hereda-filtro-proyecto.md` |
| [codex-03-quitar-carpeta-extra-no-revoca-permisos-sesion-viva.md](codex-03-quitar-carpeta-extra-no-revoca-permisos-sesion-viva.md) | `mente-07-quitar-carpeta-extra-no-revoca.md` (era baja; queda media) |
| [mente-06-subagentes-fantasma-tras-fin-de-sesion.md](mente-06-subagentes-fantasma-tras-fin-de-sesion.md) | `codex-07-caida-flujo-sdk-deja-investigadores-fantasma.md` (era baja; queda media) |
| [uso-real-03-codex-falla-en-proyectos-locales-sin-git.md](uso-real-03-codex-falla-en-proyectos-locales-sin-git.md) | `adaptadores-01-codex-local-sin-git-rechaza.md` |

Hay pares que se parecen pero **no** son el mismo problema. Están en el orden sugerido como «hacer juntas»: por
ejemplo `mente-06`, `uso-real-05` y `uso-real-06` (subagentes de la mente), `servidor-02` y `servidor-04` (aprobar
tareas) o `plugins-01`, `codex-06` y `plugins-07` (candado de Chrome).

## Índice

Ordenado por severidad (alta, media, baja) y después por área.

| Archivo | Título | Severidad | Área |
|---|---|---|---|
| [uso-real-02-gasto-de-la-mente-contado-dos-veces-al-reanudar.md](uso-real-02-gasto-de-la-mente-contado-dos-veces-al-reanudar.md) | El uso y el gasto de la mente se cuentan dos veces cada vez que su sesión se recrea con `resume` | alta | Evidencia de uso real |
| [ui-chat-01-entrega-fallida-de-propuesta-silenciosa.md](ui-chat-01-entrega-fallida-de-propuesta-silenciosa.md) | Si una propuesta aprobada no llega a la flota, el chat la muestra «Aprobada» en verde, sin aviso y sin forma de reintentar | alta | Interfaz: chat y composer |
| [mente-09-subagentes-de-la-mente-solo-leen.md](mente-09-subagentes-de-la-mente-solo-leen.md) | La mente no puede repartir cambios entre subagentes: los suyos solo leen y ella aplica todo sola (resuelta) | alta | Mente y chat |
| [mente-10-mensaje-a-mitad-de-turno-queda-esperando.md](mente-10-mensaje-a-mitad-de-turno-queda-esperando.md) | Un mensaje enviado a mitad del trabajo deja a la mente «pensando» sin mostrar nada hasta que termina o se detiene | alta | Mente y chat |
| [mente-01-plugins-chrome-saltan-guardia-lectura.md](mente-01-plugins-chrome-saltan-guardia-lectura.md) | Con el plugin Chrome, la mente lee por `file://` archivos que la guardia le niega (otros proyectos, la memoria de Obsidian y credenciales), en todos los modos | alta | Mente y chat |
| [flota-01-modo-local-reglas-fuera-del-prompt.md](flota-01-modo-local-reglas-fuera-del-prompt.md) | En modo local las reglas «sin commits, sin stash/checkout/reset» no llegan al prompt del agente: solo quedan en `.orq/BRIEF.md` | alta | Núcleo de la flota |
| [plugins-01-puerta-chrome-cancelacion-en-curso-bloquea-candado.md](plugins-01-puerta-chrome-cancelacion-en-curso-bloquea-candado.md) | Al cancelar una llamada que ya llegó al servidor, la puerta de Chrome no suelta el candado | alta | Plugins y navegador |
| [plugins-02-mente-no-ve-cambios-de-plugins-ni-desconexion.md](plugins-02-mente-no-ve-cambios-de-plugins-ni-desconexion.md) | La mente sigue usando tu Chrome personal (y Canva) después de «Desconectar», mientras su sesión siga viva | alta | Plugins y navegador |
| [servidor-01-segundo-nucleo-marca-tareas-fallidas.md](servidor-01-segundo-nucleo-marca-tareas-fallidas.md) | Un segundo `iniciar` con el puerto ocupado marca como fallidas las tareas del núcleo vivo, cancela sus sesiones y pasa sus chats a `idle` antes de fallar con EADDRINUSE | alta | Servidor, API y contratos |
| [adaptadores-02-codex-falso-cupo-por-texto-del-agente.md](adaptadores-02-codex-falso-cupo-por-texto-del-agente.md) | Codex marca «cupo agotado» cuando el propio agente escribe insufficient_quota o usage_limit_reached en su mensaje | media | Adaptadores de agentes |
| [adaptadores-03-claude-pista-429-pegajosa.md](adaptadores-03-claude-pista-429-pegajosa.md) | Claude: un 429 que se resolvió al reintentar convierte cualquier fallo posterior del mismo intento en «cupo agotado» | media | Adaptadores de agentes |
| [adaptadores-04-agy-cupo-mezcla-grupos-de-modelos.md](adaptadores-04-agy-cupo-mezcla-grupos-de-modelos.md) | El cupo de agy junta los grupos Gemini y Claude/GPT y bloquea al agente por un grupo que no usa | media | Adaptadores de agentes |
| [adaptadores-05-runjsonl-espera-close-sin-respaldo.md](adaptadores-05-runjsonl-espera-close-sin-respaldo.md) | runJsonl solo termina con 'close': si un proceso nieto hereda stdout, ni el plazo ni la cancelación lo liberan | media | Adaptadores de agentes |
| [datos-01-boveda-escritura-sin-flush-ni-reintento.md](datos-01-boveda-escritura-sin-flush-ni-reintento.md) | La bóveda de claves se reescribe sin flush, sin reintento ante EPERM y sin respaldo: un corte la deja ilegible y ya no deja ni volver a guardar claves | media | Datos y almacenamiento |
| [escritorio-02-reabrir-durante-cierre.md](escritorio-02-reabrir-durante-cierre.md) | Reabrir Berland mientras la anterior se cierra: la ventana vuelve y desaparece sola, o la nueva adopta un núcleo que se está matando | media | Escritorio y arranque |
| [uso-real-03-codex-falla-en-proyectos-locales-sin-git.md](uso-real-03-codex-falla-en-proyectos-locales-sin-git.md) | Codex falla al instante en proyectos locales sin git: gasta dos intentos y Claude arranca con más esfuerzo | media | Evidencia de uso real |
| [uso-real-04-nucleo-muere-sin-dejar-rastro.md](uso-real-04-nucleo-muere-sin-dejar-rastro.md) | El núcleo murió con 3 tareas y 4 sesiones en curso y ningún registro dice cuándo ni cómo terminó | media | Evidencia de uso real |
| [uso-real-05-chat-cortado-por-reinicio-queda-libre-sin-aviso.md](uso-real-05-chat-cortado-por-reinicio-queda-libre-sin-aviso.md) | Tras un reinicio del núcleo, el chat que estaba respondiendo queda «Libre» sin respuesta ni aviso, y sus subagentes perdidos no dejan rastro | media | Evidencia de uso real |
| [agy-09-datos-flota-obsoletos-tras-reconexion-ws.md](agy-09-datos-flota-obsoletos-tras-reconexion-ws.md) | Al reconectar `/ws`, el Tablero y el panel de agentes se quedan con las tareas, agentes y cupos de antes del corte | media | Interfaz (revisión de agy) |
| [agy-15-skills-cuarentena-se-pierden-al-navegar.md](agy-15-skills-cuarentena-se-pierden-al-navegar.md) | Las skills en cuarentena desaparecen de Ajustes › Skills al cambiar de sección o recargar, y ya no se pueden aprobar ni rechazar | media | Interfaz (revisión de agy) |
| [ui-chat-02-carga-pisa-estado-vivo-del-chat.md](ui-chat-02-carga-pisa-estado-vivo-del-chat.md) | Al abrir o recargar un chat, la respuesta REST pisa lo que llegó por /ws mientras cargaba y el chat se queda en «trabajando» (o pierde la respuesta) | media | Interfaz: chat y composer |
| [ui-chat-03-errores-de-turno-sin-respuesta-desaparecen.md](ui-chat-03-errores-de-turno-sin-respuesta-desaparecen.md) | El error y los pasos de un turno que terminó sin respuesta desaparecen del hilo cuando el usuario manda otro mensaje | media | Interfaz: chat y composer |
| [ui-chat-04-sugerencia-doble-clic-crea-dos-chats.md](ui-chat-04-sugerencia-doble-clic-crea-dos-chats.md) | Un doble clic en una sugerencia del chat vacío crea dos conversaciones y lanza dos turnos de la mente | media | Interfaz: chat y composer |
| [ui-chat-05-replay-recorre-toda-la-historia.md](ui-chat-05-replay-recorre-toda-la-historia.md) | Al abrir un chat, la interfaz pide por /ws toda la historia de la sesión de la mente, de 500 en 500, y solo se queda con los últimos 500 eventos | media | Interfaz: chat y composer |
| [ui-chat-08-enviar-mientras-razona.md](ui-chat-08-enviar-mientras-razona.md) | Mientras la mente razona no se le puede escribir: hay que detener el turno para mandarle lo que faltó | media | Interfaz: chat y composer |
| [ui-resto-01-sin-error-boundary-ventana-en-blanco.md](ui-resto-01-sin-error-boundary-ventana-en-blanco.md) | Sin error boundary: si falla una vista perezosa (por ejemplo tras recompilar dist/ui) la ventana queda en blanco y sin controles | media | Interfaz: tablero, panel, ajustes |
| [ui-resto-02-detalle-tarea-arrastra-agente-y-error.md](ui-resto-02-detalle-tarea-arrastra-agente-y-error.md) | El detalle de una tarea arrastra el agente elegido y el aviso de error de la tarea anterior, y puede aprobar otra tarea con ese agente | media | Interfaz: tablero, panel, ajustes |
| [ui-resto-04-panel-mente-ciega-fuera-del-chat.md](ui-resto-04-panel-mente-ciega-fuera-del-chat.md) | La fila «Mente» del panel solo ve los chats de la vista de chat abierta: en el Tablero siempre dice «Libre» | media | Interfaz: tablero, panel, ajustes |
| [ui-resto-05-textos-modos-mente-desactualizados.md](ui-resto-05-textos-modos-mente-desactualizados.md) | Ajustes y la ficha del chat describen Bypass como «Auto que lee fuera de la carpeta»: no dicen que la mente edita archivos y ejecuta comandos sin preguntar | media | Interfaz: tablero, panel, ajustes |
| [skills-01-catalogo-de-skills-para-crear-tareas.md](skills-01-catalogo-de-skills-para-crear-tareas.md) | Las skills casi no llegan a las tareas: el catálogo es corto, la búsqueda falla y las referencias salen rotas | media | Mente, planificador y skills |
| [mente-02-adjunto-subido-abre-carpeta-comun.md](mente-02-adjunto-subido-abre-carpeta-comun.md) | Adjuntar un archivo subido (no imagen) abre a la mente la carpeta común de adjuntos de todos los chats y proyectos | media | Mente y chat |
| [mente-03-crear-tareas-acepta-otro-proyecto.md](mente-03-crear-tareas-acepta-otro-proyecto.md) | crear_tareas acepta otro proyecto: en auto y bypass la tarea se aprueba sola y la flota trabaja en el repo ajeno | media | Mente y chat |
| [mente-04-reanudar-sesion-sdk-inexistente-rompe-chat.md](mente-04-reanudar-sesion-sdk-inexistente-rompe-chat.md) | Si la transcripción del SDK ya no existe, el chat no vuelve a responder: cada mensaje reanuda con el mismo id | media | Mente y chat |
| [mente-05-cd-fuera-bloquea-shell-sesion.md](mente-05-cd-fuera-bloquea-shell-sesion.md) | Un `cd` fuera de la carpeta del proyecto deja Bash y PowerShell bloqueados el resto de la sesión de la mente (bypass y chat) | media | Mente y chat |
| [mente-06-subagentes-fantasma-tras-fin-de-sesion.md](mente-06-subagentes-fantasma-tras-fin-de-sesion.md) | Si el proceso del SDK de la mente termina solo, el chat sigue anunciando subagentes que ya no existen y el núcleo no se apaga al cerrar la ventana | media | Mente y chat |
| [flota-02-gate-ensucia-worktree-integracion.md](flota-02-gate-ensucia-worktree-integracion.md) | Si el gate modifica archivos versionados, `_integracion` queda sucio y las integraciones siguientes del proyecto fallan como «Error del orquestador» | media | Núcleo de la flota |
| [flota-03-restos-gate-previo-entran-al-commit.md](flota-03-restos-gate-previo-entran-al-commit.md) | Lo que deja el gate previo a la revisión en el worktree de la tarea entra en el commit o tumba la integración ya aprobada | media | Núcleo de la flota |
| [flota-04-orq-compartida-modo-local.md](flota-04-orq-compartida-modo-local.md) | Modo local: las tareas de una misma carpeta comparten `.orq/`. Una tarea hereda el plan y el HANDOFF de otra fallida, y si termina bien borra el HANDOFF que la fallida necesita para el reintento | media | Núcleo de la flota |
| [flota-06-reintento-durante-cierre-de-ciclo.md](flota-06-reintento-durante-cierre-de-ciclo.md) | Reintentar una tarea mientras su ciclo aún guarda las sesiones arranca un segundo ciclo con el mismo id y `Fleet.run` pierde la cuenta de lo que corre | media | Núcleo de la flota |
| [plugins-03-mente-sin-notas-de-chrome-y-canva.md](plugins-03-mente-sin-notas-de-chrome-y-canva.md) | La mente maneja tu Chrome personal y tu Canva sin las reglas que sí reciben los agentes de la flota | media | Plugins y navegador |
| [plugins-04-canva-error-pegado-tras-fallo-de-red.md](plugins-04-canva-error-pegado-tras-fallo-de-red.md) | Si renovar el token de Canva falla una vez por la red, Canva queda en «error» aunque la renovación siguiente funcione | media | Plugins y navegador |
| [pruebas-01-ui-waitfor-timeout-1s.md](pruebas-01-ui-waitfor-timeout-1s.md) | En las pruebas de la interfaz, waitFor y findBy esperan solo 1 s y con la CPU cargada dan falsos rojos en el gate | media | Pruebas y rendimiento |
| [pruebas-02-h4-repos-git-lento-y-gate-huerfano.md](pruebas-02-h4-repos-git-lento-y-gate-huerfano.md) | Las dos H4 de repos.test.ts lanzan entre 55 y 61 git seguidos y, si se cortan antes de abrir la barrera, dejan el gate vivo y `_integracion` sin borrar | media | Pruebas y rendimiento |
| [pruebas-03-vitest-sin-tope-de-workers.md](pruebas-03-vitest-sin-tope-de-workers.md) | Vitest no tiene tope de workers y la flota corre varios gates a la vez sin coordinarlos | media | Pruebas y rendimiento |
| [codex-01-lecturas-escapan-por-enlaces-o-junctions.md](codex-01-lecturas-escapan-por-enlaces-o-junctions.md) | Read, Grep y Glob siguen enlaces y junctions sin comprobar la ruta real: salen del proyecto y esquivan `denyPaths` | media | Seguridad y corrección (revisión de Codex) |
| [codex-02-alias-interno-permite-escribir-en-git-o-claude.md](codex-02-alias-interno-permite-escribir-en-git-o-claude.md) | Una junction interna hacia `.git` o `.claude` deja escribir en ellas | media | Seguridad y corrección (revisión de Codex) |
| [codex-03-quitar-carpeta-extra-no-revoca-permisos-sesion-viva.md](codex-03-quitar-carpeta-extra-no-revoca-permisos-sesion-viva.md) | Quitar una carpeta extra del chat no revoca su lectura ni su escritura mientras la sesión de la mente sigue viva | media | Seguridad y corrección (revisión de Codex) |
| [codex-04-secretos-mcp-mente-sin-tachado-por-valor.md](codex-04-secretos-mcp-mente-sin-tachado-por-valor.md) | La mente no tacha por valor los secretos de sus plugins MCP (token de Canva) | media | Seguridad y corrección (revisión de Codex) |
| [codex-05-proyectos-misma-carpeta-por-junction-en-paralelo.md](codex-05-proyectos-misma-carpeta-por-junction-en-paralelo.md) | Modo local: dos proyectos que llegan a la misma carpeta por una junction corren tareas a la vez y se borran `.orq/` entre sí | media | Seguridad y corrección (revisión de Codex) |
| [servidor-02-aprobar-tarea-queda-ready-sin-flota.md](servidor-02-aprobar-tarea-queda-ready-sin-flota.md) | Aprobar una tarea guarda `ready` antes de que la flota la acepte: si la flota la rechaza, queda `ready` fuera de la cola y el servidor responde 500 | media | Servidor, API y contratos |
| [servidor-03-flota-ignora-cambios-de-agentes.md](servidor-03-flota-ignora-cambios-de-agentes.md) | La flota ya armada no ve los cambios de agentes (deshabilitar, agregar, detectar, cambiar la clave o borrar) hasta reiniciar el núcleo | media | Servidor, API y contratos |
| [servidor-04-aprobada-esperando-dependencias-parece-pendiente.md](servidor-04-aprobada-esperando-dependencias-parece-pendiente.md) | Una tarea aprobada que espera a sus dependencias vuelve a `pending` en la base: el tablero la muestra «Pendiente» con el botón Aprobar, y aprobarla da 500 y deja la base distinta de la cola | media | Servidor, API y contratos |
| [servidor-05-tachado-falso-positivo-palabras-pegadas.md](servidor-05-tachado-falso-positivo-palabras-pegadas.md) | El tachado genérico de claves corta palabras pegadas a «authorization», «bearer» o «apikey»: hay carpetas que no se pueden abrir ni registrar, y rutas que se guardan rotas | media | Servidor, API y contratos |
| [adaptadores-06-app-server-spawnsync-bloquea-nucleo.md](adaptadores-06-app-server-spawnsync-bloquea-nucleo.md) | Cada lectura del cupo de Codex congela el núcleo mientras corre `taskkill` síncrono | baja | Adaptadores de agentes |
| [adaptadores-07-runjsonl-stdin-sin-manejador-error.md](adaptadores-07-runjsonl-stdin-sin-manejador-error.md) | runJsonl escribe el encargo en stdin sin oyente de 'error': un EPIPE o EOF tumba el núcleo | baja | Adaptadores de agentes |
| [datos-03-memoria-contexto-lee-todas-las-sesiones.md](datos-03-memoria-contexto-lee-todas-las-sesiones.md) | buildContext abre y parsea en serie todas las notas de Sesiones/, de todos los proyectos, en cada encargo | baja | Datos y almacenamiento |
| [datos-04-cupos-fotos-sin-limpieza.md](datos-04-cupos-fotos-sin-limpieza.md) | La tabla de fotos de cupo crece sin límite y `latestQuotas` recorre todo su índice en cada lectura | baja | Datos y almacenamiento |
| [datos-05-memoria-registro-sesion-a-medias.md](datos-05-memoria-registro-sesion-a-medias.md) | La memoria puede registrar una sesión a medias: si falla Contexto.md o la nota del agente, la bitácora y los totales pierden esa sesión y nada la repara | baja | Datos y almacenamiento |
| [datos-06-candado-owner-rename-sin-reintento.md](datos-06-candado-owner-rename-sin-reintento.md) | Al tomar un candado, el archivo `owner` se renombra sin reintentos: un EPERM pasajero del antivirus hace fallar la toma en vez de reintentar | baja | Datos y almacenamiento |
| [datos-07-migraciones-version-fuera-de-transaccion.md](datos-07-migraciones-version-fuera-de-transaccion.md) | Dos procesos que abren la base a la vez pueden aplicar la misma migración, y el segundo no arranca | baja | Datos y almacenamiento |
| [datos-08-uso-resumen-sin-indice-por-dia.md](datos-08-uso-resumen-sin-indice-por-dia.md) | El resumen de uso filtra por `day` sin un índice que empiece por esa columna y recorre toda la tabla `usage` en cada consulta | baja | Datos y almacenamiento |
| [escritorio-04-nucleo-propio-sin-sesion.md](escritorio-04-nucleo-propio-sin-sesion.md) | Si `session.json` no se guarda, el núcleo que lanzó Berland queda huérfano y la próxima apertura dice que «no lo abrió Berland» | baja | Escritorio y arranque |
| [escritorio-05-adoptar-nucleo-en-modo-dev.md](escritorio-05-adoptar-nucleo-en-modo-dev.md) | Con ORQ_UI_DEV=1, Berland adopta un núcleo que no acepta el origen 5174: la interfaz carga, pero /ws y todo POST o PATCH responden 403 | baja | Escritorio y arranque |
| [uso-real-06-sesiones-fantasma-de-subagentes-de-la-mente.md](uso-real-06-sesiones-fantasma-de-subagentes-de-la-mente.md) | Las sesiones de los subagentes de la mente quedan «running» para siempre y su cancelación cae en sesiones duplicadas `task-*` | baja | Evidencia de uso real |
| [uso-real-07-interrumpir-muestra-error-criptico.md](uso-real-07-interrumpir-muestra-error-criptico.md) | Al detener un turno de la mente, el chat muestra el error rojo «[ede_diagnostic] result_type=user …» y la sesión del chat queda `failed` | baja | Evidencia de uso real |
| [agy-01-modo-chat-ausente-en-modo-inicial.md](agy-01-modo-chat-ausente-en-modo-inicial.md) | Ajustes › Mente no deja elegir «Chat» como modo inicial de los chats | baja | Interfaz (revisión de agy) |
| [agy-02-gate-propuesto-editable-se-descarta.md](agy-02-gate-propuesto-editable-se-descarta.md) | «Abrir una carpeta local» muestra el «Gate propuesto» en un campo editable y luego descarta lo que se escribe | baja | Interfaz (revisión de agy) |
| [agy-04-boton-opciones-proyecto-sidebar-no-contextual.md](agy-04-boton-opciones-proyecto-sidebar-no-contextual.md) | El botón «…» de un proyecto en la barra lateral promete «Opciones de <proyecto>» y solo lleva a la lista general de Ajustes › Proyectos | baja | Interfaz (revisión de agy) |
| [agy-05-tarjeta-tarea-a-mano-no-abre-dialogo.md](agy-05-tarjeta-tarea-a-mano-no-abre-dialogo.md) | La tarjeta «Darle una tarea a mano» de la portada lleva al Tablero pero no abre el diálogo de la tarea | baja | Interfaz (revisión de agy) |
| [agy-06-portada-ordena-por-creacion-no-ultimo-uso.md](agy-06-portada-ordena-por-creacion-no-ultimo-uso.md) | La portada ordena «Retoma donde quedaste» por la fecha de alta del proyecto y la muestra como si fuera el último uso | baja | Interfaz (revisión de agy) |
| [agy-08-error-conexion-sin-reintento-y-nombre-orquestador.md](agy-08-error-conexion-sin-reintento-y-nombre-orquestador.md) | La pantalla «sin conexión con el núcleo» dice «el orquestador», nombra un enlace que no existe y no deja reintentar | baja | Interfaz (revisión de agy) |
| [agy-10-filtro-proyecto-tablero-deshabilitado-en-ruta.md](agy-10-filtro-proyecto-tablero-deshabilitado-en-ruta.md) | El Tablero general queda filtrado por un proyecto si se llega desde el tablero de ese proyecto | baja | Interfaz (revisión de agy) |
| [agy-11-estado-tarea-en-ingles-en-modal-detalle.md](agy-11-estado-tarea-en-ingles-en-modal-detalle.md) | El detalle de una tarea en el Tablero muestra el estado en inglés crudo («pending», «handed_off»…) | baja | Interfaz (revisión de agy) |
| [agy-12-boton-panel-agentes-enganoso-y-oculto-bajo-lg.md](agy-12-boton-panel-agentes-enganoso-y-oculto-bajo-lg.md) | El botón «agentes en vivo» de la barra de título no dice la verdad: fuera del chat y del tablero, y con la ventana por debajo de 1024 px, se enciende y se apaga sin que aparezca el panel | baja | Interfaz (revisión de agy) |
| [agy-13-filas-actividad-tabindex-sin-interaccion.md](agy-13-filas-actividad-tabindex-sin-interaccion.md) | Cada fila del panel «Agentes en vivo» es una parada de Tab que no hace nada | baja | Interfaz (revisión de agy) |
| [agy-16-importar-skills-sin-selector-de-archivos.md](agy-16-importar-skills-sin-selector-de-archivos.md) | Importar una skill obliga a escribir o pegar la ruta a mano: no hay botón para elegir la carpeta o el .zip | baja | Interfaz (revisión de agy) |
| [agy-17-etiquetas-esfuerzo-inconsistentes-ajustes-chat.md](agy-17-etiquetas-esfuerzo-inconsistentes-ajustes-chat.md) | El mismo nivel de esfuerzo tiene dos nombres: «Medio» en Ajustes › Mente y «Equilibrado» en la barra del chat | baja | Interfaz (revisión de agy) |
| [agy-19-tarea-a-mano-sin-proyectos-registrados.md](agy-19-tarea-a-mano-sin-proyectos-registrados.md) | «Nueva tarea a mano» se deja rellenar sin ningún proyecto registrado y solo avisa al pulsar «Crear tarea» | baja | Interfaz (revisión de agy) |
| [agy-20-presupuesto-usd-solo-para-claude-sdk.md](agy-20-presupuesto-usd-solo-para-claude-sdk.md) | Los agentes por API (OpenAI, Gemini, compatible) piden «define budgetUsd» pero Ajustes › Agentes no deja fijarlo, y aunque se fijara no se descontaría | baja | Interfaz (revisión de agy) |
| [agy-21-aviso-adjunto-20mb-no-se-puede-cerrar.md](agy-21-aviso-adjunto-20mb-no-se-puede-cerrar.md) | El aviso de adjunto rechazado («máximo 20 MB» o «máximo 20 archivos») no se puede cerrar y sigue visible después de enviar o de cambiar de chat | baja | Interfaz (revisión de agy) |
| [ui-chat-06-borrador-pasa-entre-conversaciones.md](ui-chat-06-borrador-pasa-entre-conversaciones.md) | El texto y los adjuntos sin enviar del Composer se quedan al cambiar de conversación y se mandan a la otra | baja | Interfaz: chat y composer |
| [ui-chat-07-error-de-adjunto-duplicado-y-enganoso.md](ui-chat-07-error-de-adjunto-duplicado-y-enganoso.md) | Si falla un adjunto salen dos avisos de error, y el del composer culpa al servicio aunque el núcleo dio el motivo real | baja | Interfaz: chat y composer |
| [ui-resto-07-tablero-columnas-esconden-lo-nuevo.md](ui-resto-07-tablero-columnas-esconden-lo-nuevo.md) | El tablero ordena cada columna por fecha de creación y, pasadas 100 tareas, esconde las más nuevas | baja | Interfaz: tablero, panel, ajustes |
| [ui-resto-08-menos-efectos-no-quita-blur-ni-animaciones.md](ui-resto-08-menos-efectos-no-quita-blur-ni-animaciones.md) | «Menos efectos» deja el desenfoque del tablero y no detiene ninguna animación | baja | Interfaz: tablero, panel, ajustes |
| [ui-resto-09-tema-sistema-no-sigue-windows.md](ui-resto-09-tema-sistema-no-sigue-windows.md) | El tema «Sistema» no sigue a Windows mientras Berland está abierto, y con tema claro la ventana abre en oscuro | baja | Interfaz: tablero, panel, ajustes |
| [mente-08-turno-autonomo-pisado-por-envio.md](mente-08-turno-autonomo-pisado-por-envio.md) | Si la mente arranca sola un turno mientras `send` espera, el turno del usuario lo pisa y el chat queda libre con el mensaje sin procesar | baja | Mente y chat |
| [flota-08-apagado-cancela-tareas-en-curso.md](flota-08-apagado-cancela-tareas-en-curso.md) | Detener el núcleo con Ctrl+C en `iniciar` deja las tareas en curso y sus dependientes `cancelled`, sin poder reintentarlas | baja | Núcleo de la flota |
| [flota-09-gate-doble-modo-local.md](flota-09-gate-doble-modo-local.md) | Modo local: el gate completo corre dos veces por tarea aprobada, antes de revisar y al «integrar», sobre la misma carpeta | baja | Núcleo de la flota |
| [plugins-05-probar-conexion-quita-chrome-y-pisa-desconectar.md](plugins-05-probar-conexion-quita-chrome-y-pisa-desconectar.md) | «Probar conexión» le quita Chrome a las sesiones nuevas mientras prueba, y al terminar deshace un «Desconectar» hecho durante la prueba | baja | Plugins y navegador |
| [plugins-06-codex-sin-startup-timeout-para-la-puerta.md](plugins-06-codex-sin-startup-timeout-para-la-puerta.md) | Codex arranca `chrome-personal` (puerta, cmd y chrome-devtools-mcp) con su tope de arranque por defecto, sin margen para un PC cargado | baja | Plugins y navegador |
| [plugins-07-puerta-pierde-handle-si-falla-soltar.md](plugins-07-puerta-pierde-handle-si-falla-soltar.md) | Si soltar el candado de Chrome falla por un error pasajero de Windows, la puerta pierde el handle y deja el Chrome bloqueado hasta que termina la sesión, también para sí misma | baja | Plugins y navegador |
| [plugins-08-interfaz-canva-sin-enlace-de-autorizacion.md](plugins-08-interfaz-canva-sin-enlace-de-autorizacion.md) | La tarjeta de Canva no muestra el enlace de autorización: si la pestaña no se abrió o se cerró, no hay cómo retomarlo | baja | Plugins y navegador |
| [pruebas-04-temporales-de-pruebas-sin-borrar.md](pruebas-04-temporales-de-pruebas-sin-borrar.md) | Las pruebas dejan carpetas en %TEMP%: la plantilla de repos nunca se borra, `makeRepo().cleanup` falla callado y f5-chat deja a la flota escribiendo memoria | baja | Pruebas y rendimiento |
| [pruebas-05-cupos-descifran-clave-dpapi-cada-5-min.md](pruebas-05-cupos-descifran-clave-dpapi-cada-5-min.md) | La lectura de cupos (cada 5 min) descifra con PowerShell la clave de cada agente aunque su lector no la use | baja | Pruebas y rendimiento |
| [pruebas-06-pruebas-live-se-cargan-en-cada-check.md](pruebas-06-pruebas-live-se-cargan-en-cada-check.md) | Las 11 pruebas live se importan en cada `npm test` y en cada gate aunque luego se salten | baja | Pruebas y rendimiento |
| [pruebas-07-esperas-por-vueltas-sin-aviso.md](pruebas-07-esperas-por-vueltas-sin-aviso.md) | Varias pruebas del chat esperan el fin del turno contando vueltas (1-3 s) y siguen sin avisar si el turno no terminó | baja | Pruebas y rendimiento |
| [pruebas-08-postman-run-usa-carpetas-reales.md](pruebas-08-postman-run-usa-carpetas-reales.md) | La prueba de la colección de Postman lee C:\dev y C:\dev\Vetworld reales: su resultado depende del equipo | baja | Pruebas y rendimiento |
| [codex-06-cerrar-puerta-chrome-deja-candado-huerfano.md](codex-06-cerrar-puerta-chrome-deja-candado-huerfano.md) | Si la puerta de Chrome se cierra mientras toma el candado, el candado puede quedar tomado sin dueño y bloquear el Chrome para todos | baja | Seguridad y corrección (revisión de Codex) |
| [servidor-06-ownedpaths-sin-validar-en-tareas-rest.md](servidor-06-ownedpaths-sin-validar-en-tareas-rest.md) | POST /tasks y POST /tasks/manual aceptan rutas propias absolutas, con «..» o negadas: la tarea se trabaja entera y falla al revisar o integrar | baja | Servidor, API y contratos |
| [servidor-07-docs-api-sin-chats-adjuntos-plugins.md](servidor-07-docs-api-sin-chats-adjuntos-plugins.md) | La documentación del API (OpenAPI y Postman) omite las 21 rutas de chats, adjuntos y plugins, y sus pruebas no pueden detectarlo | baja | Servidor, API y contratos |

Totales: 7 de severidad alta, 43 media y 47 baja.

### Autoevaluación de la mente (`autoeval-*`)

Se agregaron después del índice principal. Ordenadas por severidad.

| Archivo | Título | Severidad | Área |
|---|---|---|---|
| [autoeval-navegador-02-modo-plan-actua-en-chrome-y-canva.md](autoeval-navegador-02-modo-plan-actua-en-chrome-y-canva.md) | En modo plan (y en auto) la mente hace clic, rellena formularios y ejecuta JavaScript en tu Chrome, y confirma cambios en Canva, sin tu aprobación | alta | Mente y chat |
| [autoeval-navegador-03-acciones-de-salida-sin-confirmacion.md](autoeval-navegador-03-acciones-de-salida-sin-confirmacion.md) | En chat y bypass ninguna acción de salida en tu Chrome o tu Canva pide confirmación: una página puede llevar a la mente a enviar un formulario, ejecutar JavaScript con tus sesiones o publicar un diseño | alta | Mente y chat |
| [autoeval-navegador-05-red-devuelve-cookies-de-sesion.md](autoeval-navegador-05-red-devuelve-cookies-de-sesion.md) | Al revisar la red del Chrome personal, la mente y la flota reciben las cookies de sesión y los encabezados de autorización de tus cuentas abiertas | alta | Plugins y navegador |
| [autoeval-reglas-01-mente-git-en-tu-carpeta-sin-barrera.md](autoeval-reglas-01-mente-git-en-tu-carpeta-sin-barrera.md) | En bypass y chat la mente puede fusionar en `main`, hacer commits, cambiar de rama y descartar tus cambios sin confirmar en tu carpeta: la política de shell frena push, rebase, `reset --hard`, `clean -f` y borrar ramas, pero deja pasar `merge`, `commit`, `checkout`, `restore` y `stash` | alta | Mente y chat |
| [autoeval-reglas-02-worktree-alcanza-stash-y-ramas-del-repo.md](autoeval-reglas-02-worktree-alcanza-stash-y-ramas-del-repo.md) | Desde el worktree de una tarea, `git stash pop\|drop\|clear` saca o borra tu stash y `git checkout -B`/`git switch -C` mueve cualquier rama del repo (también `main`, con `--ignore-other-worktrees`) | alta | Núcleo de la flota (política de shell de los workers Claude, que también usa la mente) |
| [autoeval-reglas-03-modo-local-sin-bloqueo-de-push.md](autoeval-reglas-03-modo-local-sin-bloqueo-de-push.md) | En modo local no se aplica el bloqueo de push de los worktrees: Codex y agy pueden publicar desde tu carpeta con tus credenciales de git | alta | Núcleo de la flota |
| [autoeval-trabajo-01-decisiones-de-memoria-no-vuelven.md](autoeval-trabajo-01-decisiones-de-memoria-no-vuelven.md) | Las decisiones que la mente guarda con `escribir_memoria`, incluido el «Plan: …» obligatorio, nunca vuelven en `leer_memoria` ni en los encargos de la flota | alta | Datos y almacenamiento |
| [autoeval-trabajo-02-prompt-de-sistema-congelado-al-reanudar.md](autoeval-trabajo-02-prompt-de-sistema-congelado-al-reanudar.md) | Al cambiar de modo, sumar una carpeta extra o retomar el chat otro día, la mente sigue leyendo el contexto de la primera sesión: cree estar en el modo viejo, con la fecha y los cupos de entonces | alta | Mente y chat |
| [autoeval-gasto-01-mente-sin-tope-por-turno-sesion-ni-dia.md](autoeval-gasto-01-mente-sin-tope-por-turno-sesion-ni-dia.md) | La mente no tiene tope de gasto por turno, por sesión ni por día: un turno con subagentes, o una cadena de turnos autónomos, puede gastar hasta el presupuesto total del agente Claude (hoy 60.000 USD) | media | Mente y chat (gasto) |
| [autoeval-gasto-02-presupuesto-claude-no-es-tope-comun.md](autoeval-gasto-02-presupuesto-claude-no-es-tope-comun.md) | El presupuesto del agente Claude no es un tope común: la flota y el panel de cupos no descuentan lo que gasta la mente, y cada chat abierto recibe el saldo entero | media | Mente y chat (gasto) · Cupos |
| [autoeval-gasto-03-mente-reintenta-sin-limite-tope-de-tarea.md](autoeval-gasto-03-mente-reintenta-sin-limite-tope-de-tarea.md) | En auto y bypass, la mente puede reintentar sin límite una tarea que la flota frenó por el tope de gasto, y cada reintento arranca con el tope entero | media | Mente y chat · Flota (gasto) |
| [autoeval-gasto-04-bajar-y-ejecutar-desde-internet.md](autoeval-gasto-04-bajar-y-ejecutar-desde-internet.md) | En bypass y chat, la mente (y los workers Claude) pueden bajar un script o un ejecutable de internet y correrlo en el mismo comando; `certutil`, `bitsadmin` y `msiexec` ni siquiera pasan por la regla de escritura | media | Mente y chat · Seguridad (política de shell) |
| [autoeval-navegador-01-prompt-sin-aviso-de-contenido-externo.md](autoeval-navegador-01-prompt-sin-aviso-de-contenido-externo.md) | La mente no sabe que lo que lee en páginas, diseños de Canva, archivos y adjuntos son datos y no órdenes: su prompt propio dejó fuera el aviso de inyección que trae Claude Code | media | Mente y chat |
| [autoeval-navegador-04-agentes-manejan-pestanas-del-usuario.md](autoeval-navegador-04-agentes-manejan-pestanas-del-usuario.md) | Cualquier agente puede leer, navegar o cerrar las pestañas que tú tienes abiertas en tu Chrome (correo, banco), no solo las suyas: «trabaja solo en tu pestaña» no lo hace cumplir nadie | media | Plugins y navegador |
| [autoeval-reglas-04-agy-sin-ninguna-barrera-tecnica.md](autoeval-reglas-04-agy-sin-ninguna-barrera-tecnica.md) | agy corre sin ninguna barrera técnica de Berland: escribe fuera del worktree, ejecuta cualquier git y se salta el bloqueo de push con `git -C <tu copia del repo> push` o `-c remote.<r>.pushurl= -c remote.<r>.pushurl=… push --no-verify` | media | Adaptadores de agentes |
| [autoeval-reglas-05-worker-claude-ve-la-clave-y-commit-sin-revisar-secretos.md](autoeval-reglas-05-worker-claude-ve-la-clave-y-commit-sin-revisar-secretos.md) | Los workers Claude tienen tu clave de API (y el token de Canva) en el entorno de Bash y PowerShell, y Berland confirma a tu nombre lo que escriban sin buscar secretos | media | Adaptadores de agentes |
| [autoeval-reglas-06-modo-local-rutas-propias-solo-por-lo-que-informa-el-agente.md](autoeval-reglas-06-modo-local-rutas-propias-solo-por-lo-que-informa-el-agente.md) | En modo local, las rutas propias solo se comprueban con lo que el agente dice haber tocado: lo que escriba por Bash, PowerShell o un script fuera de ellas no se ve ni se frena, y la tarea se integra igual | media | Núcleo de la flota |
| [autoeval-reglas-07-codex-sandbox-depende-de-config-global.md](autoeval-reglas-07-codex-sandbox-depende-de-config-global.md) | La única barrera de Codex es su sandbox, y en Windows lo configura tu `~/.codex/config.toml`: Berland no lo fija ni comprueba que esté activo, y en modo `unelevated` la red no queda cortada | media | Adaptadores de agentes |
| [autoeval-subagentes-01-subagentes-integrados-con-todas-las-herramientas.md](autoeval-subagentes-01-subagentes-integrados-con-todas-las-herramientas.md) | La mente lanza los subagentes que trae el SDK (general-purpose, Plan, Explore, claude), no el `investigador` de Berland: reciben tu Chrome personal, Canva y las herramientas de la flota, sin las reglas de Berland | media | Mente y chat |
| [autoeval-trabajo-03-resultados-cortados-y-subagentes-ocultos.md](autoeval-trabajo-03-resultados-cortados-y-subagentes-ocultos.md) | En el hilo del chat, cada resultado de herramienta se corta a 300 caracteres y los pasos de los subagentes no aparecen: el usuario no puede comprobar de dónde sacó la mente sus cifras | media | Interfaz: chat y composer |
| [autoeval-trabajo-04-trabajo-propio-de-la-mente-sin-memoria.md](autoeval-trabajo-04-trabajo-propio-de-la-mente-sin-memoria.md) | Lo que la mente cambia ella misma en modo bypass o chat no queda en la memoria del proyecto: la flota y los chats siguientes no saben qué tocó ni por qué | media | Mente y chat |
| [autoeval-trabajo-05-estado-sin-tarea-ciego-tras-reinicio.md](autoeval-trabajo-05-estado-sin-tarea-ciego-tras-reinicio.md) | Tras reiniciar el núcleo, `estado()` sin `taskId` deja fuera el estado de las tareas: la mente informa la flota a medias, sin las fallidas ni las integradas | media | Mente y chat |
| [autoeval-trabajo-06-compactacion-invisible-en-el-chat.md](autoeval-trabajo-06-compactacion-invisible-en-el-chat.md) | Cuando el SDK compacta la conversación de la mente, el chat no lo muestra: el usuario no sabe que la mente resumió lo anterior y puede haber perdido detalles | baja | Interfaz: chat y composer |

Totales con las `autoeval-*`: 15 de severidad alta, 57 media y 48 baja.

## Orden sugerido

La idea: primero que el gate dé resultados fiables, después las altas, y cada una junto con las que tocan el mismo
código. Dentro de cada bloque, el orden indica dependencias.

### 0. Que el gate no dé falsos rojos (solo pruebas y configuración)

Cada arreglo tiene que pasar `npm run -s check`. Con la CPU al límite, hoy el gate falla por tiempos y no por errores.

1. `pruebas-03` (tope de workers de Vitest) y `pruebas-06` (no cargar `tests/live/**` en cada `npm test`). Son dos
   cambios en `vitest.config.ts` y van juntos.
2. `pruebas-01` (esperas de 1 s en las pruebas de la interfaz). `pruebas-03` lo cita: cuando las pruebas se alargan,
   son esos topes cortos los que vencen.
3. `pruebas-02` (H4 de `repos.test.ts`) y `pruebas-04` (temporales sin borrar). Comparten `tests/core/workspace/`.
4. `pruebas-07` y `pruebas-08`, cuando haya tiempo.

### 1. Altas, cada una con su grupo

1. **Arranque y apagado del núcleo:** `servidor-01` primero. Saca la recuperación (tareas huérfanas, sesiones
   abiertas, `resetRunning` de los chats) a después de `listen`. Encima de ese cambio van:
   - `uso-real-05`: el aviso en el chat cortado. Toca el mismo `resetRunning` que `servidor-01` mueve
     (`chat/service.ts:256`).
   - `uso-real-06`, punto 1: `cancelOpenSessions` del arranque (`fleet-service.ts:258`), que también está en esa
     recuperación.
   - `flota-08`: Ctrl+C deja las tareas `cancelled`.
   - `uso-real-04`: hora en el registro y rastro de la muerte del núcleo.
2. **Modo local:** `flota-01` (las reglas del modo local llegan al prompt). Agrega `local` a `RunHints` y cambia la
   llamada a `renderBrief` de cada adaptador. Después:
   - `uso-real-03` (`--skip-git-repo-check`): el mismo adaptador de Codex (`codex-cli/index.ts:174` y `:191`). Si se
     elige su variante «solo en modo local», usa el dato que agrega `flota-01`.
   - `flota-04`, `codex-05` y `flota-09`: los tres cambian `local-workspaces.ts` (estado por tarea en `.orq/`, clave
     física de la carpeta y caché del gate). Conviene hacerlos en una sola pasada.
3. **Plugins de la mente:** `plugins-02` (la mente sigue usando Chrome y Canva tras «Desconectar») junto con:
   - `plugins-03` (notas de Chrome y Canva para la mente): las dos rehacen `mindPlugins`/`mcpServersFor` en
     `f5-chat.ts`.
   - `codex-04` (tachado por valor del token de Canva). La huella de `plugins-02` se arma con esos mismos valores.
   - `plugins-05` («Probar conexión» baja el `status`). Con `plugins-02`, la mente relee los plugins en cada mensaje.
     Mientras dure una prueba los vería sin Chrome y recrearía la sesión sin él.
4. **Guardia de lectura de la mente:** `mente-01` (`file://` y rutas de Chrome saltan la guardia). Va en el mismo
   bloque que `codex-01` y `codex-02`, que agregan un ayudante `realpath` en `memory/safe-fs.ts`. Hay que escribirlo una
   sola vez y usarlo en la guardia y en la política de shell. Siguen `codex-03` (carpetas extra que no se revocan),
   `mente-02` (carpeta común de adjuntos), `mente-05` (`cd` fuera bloquea el shell) y `mente-03` (`crear_tareas`
   acepta otro proyecto). Todas cambian las raíces, la guardia o las herramientas de la mente (`conductor/session.ts`,
   `guard.ts`, `tools.ts`, `chat/service.ts`). `codex-03` y `plugins-02` comparten además el patrón «la sesión viva con
   subagentes conserva permisos viejos»: si la guardia lee el estado vigente en cada llamada, sirve para las dos.
5. **Candado de Chrome:** `plugins-01` (la cancelación en curso no suelta el candado) junto con `codex-06` (cerrar
   durante la toma) y `plugins-07` (falla al soltar). Las tres cambian `chrome-gate.ts` (`#inFlight`, `#acquire`,
   `#release`, `close`). Con ellas va `datos-06` (`rename` de `owner` sin reintento en `locks/manager.ts`). Hace fallar
   la toma del candado de Chrome (`chrome-gate.ts:216-223`), así que conviene probarla con las otras.
6. **Aprobar y entregar tareas:** `ui-chat-01` (en el chat, una propuesta «Aprobada» que no llegó a la flota). El
   núcleo ya devuelve `failed` y lo que falta es mostrarlo. Del mismo tema, por la ruta REST del tablero, son
   `servidor-02` y `servidor-04`. Las dos cambian `approve()` (`server/app.ts:245-252`) y el error de `onApproved`
   (`fleet-service.ts:323`): hay que hacerlas juntas, o la segunda pisa a la primera. Cerca
   quedan `ui-resto-02` (el detalle aprueba con el agente de otra tarea) y `flota-06` (reintento durante el cierre del
   ciclo).
7. **Gasto de la mente:** `uso-real-02` (uso contado dos veces al reanudar) junto con `mente-04` (reanudar una
   transcripción que ya no existe). Las dos tocan la sesión que se recrea con `resume`: `uso-real-02` en el traductor
   del SDK y `mente-04` en `#ensureSession`/`#read` de `chat/service.ts`.

### 2. Medias

- **Subagentes de la mente:** `mente-06` (contador en memoria tras una caída) y `uso-real-06`, puntos 2 a 4 (sesiones
  hijas en la tienda y `task-*` duplicadas). `uso-real-06` propone un `#cancelBackground` que sirva para los dos. Si
  se hizo el bloque 1.1, `uso-real-05` ya cerró las hijas tras un reinicio.
- **Gate e integración:** `flota-02` (el gate ensucia `_integracion`) y `flota-03` (restos del gate previo entran al
  commit). Es el mismo patrón en dos lugares: foto antes del gate y limpieza después.
- **Cupos y procesos de los adaptadores:**
  - `adaptadores-02` (Codex) y `adaptadores-03` (Claude): falsos «cupo agotado».
  - `adaptadores-04`: cupo de agy por grupo de modelos.
  - `adaptadores-05` y `adaptadores-07`: los dos en `process/run-jsonl.ts`, juntos.
  - `adaptadores-06` y `pruebas-05`: los dos abaratan la lectura de cupos cada 5 min.
- **Flota y agentes:** `servidor-03` (la flota no ve cambios de agentes) y `servidor-06` (`ownedPaths` sin validar).
- **Tachado de claves:** `servidor-05`. Cambia `src/shared/redact.ts`. Según `AGENTS.md`, `src/shared/` es el
  contrato y lo integra el orquestador.
- **Chat (interfaz):**
  - `ui-chat-02` (la carga REST pisa el estado vivo) y `ui-chat-05` (replay de toda la historia): la misma carga del
    chat.
  - `ui-chat-03` (errores de turno que desaparecen) y `uso-real-07` (error críptico al interrumpir): el mismo hilo de
    errores.
  - `ui-chat-04` (doble clic crea dos chats) y `mente-08` (turno autónomo pisado): dos carreras al enviar, una en la
    interfaz y otra en el núcleo. Comparten tema, no código.
  - `ui-chat-08` (enviar mensajes mientras la mente razona: ahora, al terminar o más tarde): sola. Toca el envío en el
    núcleo (`service.ts`, `session.ts`), el contrato (`src/shared/api.ts`) y el Composer.
- **Estado global (interfaz):** `agy-09` (resincronizar al reconectar `/ws`) y `ui-resto-04` (el panel no ve la mente
  fuera del chat). Los dos dependen de lo que el store global sabe de los chats. `agy-09` usa la misma regla de mezcla
  por `updatedAt` que `ui-chat-02`.
- **Pantallas de error:** `ui-resto-01` (sin error boundary) y `agy-08` (pantalla sin conexión sin reintento).
- **Textos de los modos:** `ui-resto-05`, junto con `agy-01` y `agy-17`. Las tres tocan Ajustes › Mente y la ficha
  del chat (`ui-resto-05` ya cita `agy-01`).
- **Skills:** `agy-15` (cuarentena que se pierde), con `agy-16` (selector de archivos).
- **Datos:** `datos-01` (bóveda sin flush ni respaldo) sola.
- **Escritorio:** `escritorio-02` (reabrir durante el cierre) junto con `escritorio-04` y `escritorio-05`. Las tres
  cambian `apps/desktop/src` (`main.ts`, `core-supervisor.ts`, `lib/core-client.ts`), igual que `uso-real-04`.
- **Canva:** `plugins-04` (error pegado tras un fallo de red), con `plugins-08` (enlace de autorización).

### 3. Bajas

- **Composer:** `ui-chat-06` (el borrador pasa a otra conversación) y `agy-21` (aviso de adjunto que no se cierra)
  tienen la misma causa: el `Composer` no se reinicia por chat (`ui-chat-06` cita a `agy-21`). Con ellas va
  `ui-chat-07` (aviso de adjunto doble).
- **Panel de agentes:** `agy-12` y `agy-13`.
- **Tablero:** `agy-10` (filtro heredado), `agy-11` (estado en inglés) y `ui-resto-07` (columnas que esconden lo
  nuevo), con `agy-06` (orden de la portada).
- **Tarea a mano:** `agy-05` y `agy-19` (`agy-19` cita a `agy-05`).
- **Apariencia:** `ui-resto-08` y `ui-resto-09`.
- **Datos:** `datos-07` y `datos-08` juntos. Primero `datos-07` (versión de la migración dentro de la transacción) y
  después la migración v4 de `datos-08`. Siguen `datos-04` (retención de fotos de cupo) en `store.ts`, y `datos-03`
  con `datos-05` (memoria de Obsidian, `obsidian-memory.ts`).
- **Documentación del API:** `servidor-07` y `pruebas-08`, en `docs/api/` y `tests/docs/`.
- **Sueltas:** `agy-02`, `agy-04`, `agy-20`, `plugins-06`.

### 4. Autoevaluación de la mente (`autoeval-*`)

Entran según su severidad: las altas, después de las altas del bloque 1; las medias, al final de las medias; la baja,
con las bajas.

- **Altas:**
  - `autoeval-navegador-02` (plan y auto actúan en Chrome y Canva) y `autoeval-navegador-03` (acciones de salida sin
    confirmación): las dos cambian el permiso de los plugins en `conductor/session.ts` y la guardia (`guard.ts`).
  - `autoeval-navegador-05` (la red devuelve cookies de sesión): el lanzador de Chrome personal.
  - `autoeval-reglas-01` (la mente usa git en tu carpeta), `autoeval-reglas-02` (stash y ramas desde el worktree) y
    `autoeval-reglas-03` (push en modo local): la política de shell y el modo local.
  - `autoeval-trabajo-01` (las decisiones de memoria no vuelven) y `autoeval-trabajo-02` (prompt de sistema congelado
    al reanudar).
- **Medias:** `autoeval-navegador-01` y `autoeval-navegador-04`; `autoeval-subagentes-01`; `autoeval-reglas-04` a
  `autoeval-reglas-07`; `autoeval-gasto-01` a `autoeval-gasto-04`; `autoeval-trabajo-03` a `autoeval-trabajo-05`.
- **Baja:** `autoeval-trabajo-06` (la compactación no se ve en el chat).

## Cómo levantar todo después de resolver las issues

Los comandos salen de `package.json`, `scripts/win.sh`, `scripts/desktop-shortcut.ps1`, `apps/desktop/README.md`,
`AGENTS.md`, `docs/BITACORA-FLOTA.md` y las cabeceras de `tests/live/*.ts`.

### Requisitos

- Windows con **Node 24** de Windows en el `PATH` (`engines.node: "24.x"`). El núcleo usa `node:sqlite` y DPAPI.
- Desde WSL, **nunca** el Node ni el npm de WSL: `node_modules` se instala con el npm de Windows. Todo pasa por
  `scripts/win.sh`. Ese script hace `cd` a la raíz de **su propio** checkout y ejecuta el comando con `cmd.exe`:

  ```bash
  cd "$(dirname "$0")/.."
  exec cmd.exe /d /c "cd /d $(wslpath -w "$PWD") && $*"
  ```

  Para el repo principal es `/mnt/c/dev/orquestador/scripts/win.sh`. En un worktree de la flota usa el `scripts/win.sh`
  de ese worktree. Si el comando lleva `&&` o `set`, va entre comillas. Agrega `< /dev/null` al final: según
  `docs/BITACORA-FLOTA.md`, sin eso quedaron consolas `conhost` huérfanas consumiendo CPU.

### 1. Instalar dependencias

Cierra Berland antes de empezar. `npm ci` borra `node_modules` entero, y Windows no deja borrar el `electron.exe` que
está corriendo desde `node_modules\electron\dist`.

PowerShell, en `C:\dev\orquestador`:

```powershell
npm ci
node node_modules\electron\install.js   # baja el binario de Electron si falta; si ya está, sale sin hacer nada
```

WSL:

```bash
/mnt/c/dev/orquestador/scripts/win.sh npm ci < /dev/null
/mnt/c/dev/orquestador/scripts/win.sh 'node node_modules\electron\install.js' < /dev/null
```

`install.js` sale enseguida si el binario ya está instalado (`if (isInstalled()) process.exit(0)`). El acceso directo
necesita `node_modules\electron\dist\electron.exe`.

### 2. Verificar todo (un check a la vez)

`npm run -s check` corre en serie `typecheck`, `lint`, `test`, `build:ui` y `build:desktop`.

```powershell
npm run -s check
```

```bash
/mnt/c/dev/orquestador/scripts/win.sh npm run -s check < /dev/null
```

Por partes, si hace falta aislar un fallo (de a una):

```powershell
npm run -s typecheck        # tsc del núcleo, de la interfaz (tsconfig.ui.json) y del escritorio (tsconfig.desktop.json)
npm run -s lint
npm test                    # vitest run
npx vitest run tests/core/chat/background.test.ts   # un solo archivo
npm test -- --maxWorkers=2  # con tope de workers mientras pruebas-03 siga abierta
```

Desde WSL, lo mismo con `scripts/win.sh "<comando>"`. `--maxWorkers` es una opción de Vitest 4
(`node_modules/vitest/dist/chunks/cac.DzDtg8hz.js:927`). Hoy `vitest.config.ts` no fija ningún tope.

### 3. Compilar interfaz y escritorio

```powershell
npm run -s build:ui         # src/ui → dist/ui (la sirve el núcleo; ORQ_UI_DIR la reemplaza)
npm run -s build:desktop    # apps/desktop/src → apps/desktop/out (proceso principal y preload de Electron)
```

El núcleo **no se compila**. Berland lanza `node.exe src/core/app/cli.ts iniciar` y Node 24 ejecuta el TypeScript
directo. Después de arreglar algo en `src/core/` hay que reiniciar el núcleo (ver abajo). Si recompilas `dist/ui` con
Berland abierto, cierra y vuelve a abrir la ventana: las vistas perezosas viejas fallan y la ventana queda en blanco
(`ui-resto-01`).

### 4. Levantar el núcleo y la app

**Con Berland (lo normal):**

1. Una vez, el acceso directo del Escritorio (necesita `apps\desktop\out` compilado):

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\desktop-shortcut.ps1
   ```

   Crea `Berland.lnk` con destino `C:\dev\orquestador\node_modules\electron\dist\electron.exe`, argumento
   `"C:\dev\orquestador\apps\desktop\out"` y carpeta de trabajo `C:\dev\orquestador`.
2. Abrir Berland con doble clic en `Berland.lnk`. Comandos equivalentes:

   ```powershell
   & C:\dev\orquestador\node_modules\electron\dist\electron.exe "C:\dev\orquestador\apps\desktop\out"
   npm run desktop             # compila apps/desktop/out y abre Berland
   ```

   ```bash
   /mnt/c/dev/orquestador/scripts/win.sh npm run desktop < /dev/null   # la terminal queda tomada hasta cerrar la ventana
   ```

3. Al abrir, Berland busca un núcleo en `127.0.0.1:47811` (`ORQ_PORT`). Si no hay, lanza `node.exe
   src/core/app/cli.ts iniciar` con el Node del `PATH` (u `ORQ_NODE`). El stderr del núcleo va a
   `%LOCALAPPDATA%\orquestador\logs\nucleo-escritorio.log` y el de la ventana a `...\logs\escritorio.log`.
4. **Reiniciar el núcleo** (después de cambiar `src/core/`): cierra Berland sin tareas en curso y vuelve a abrirla.
   Berland apaga el núcleo al cerrar solo si lo lanzó ella y no hay trabajo en curso (`apps/desktop/src/lib/shutdown-policy.ts`).
   Si hay tareas corriendo, el núcleo sigue vivo y la próxima apertura lo reutiliza.

Modo desarrollo de la interfaz: en una terminal `npm run dev:ui` (Vite en `127.0.0.1:5174`) y en otra
`npm run desktop:dev` (`ORQ_UI_DEV=1` y DevTools). Antes, cierra cualquier núcleo vivo. Si Berland adopta uno que no
acepta el origen 5174, `/ws` y los POST responden 403 (`escritorio-05`).

**Solo el núcleo, por terminal** (para Postman, la CLI o pruebas a mano):

```powershell
node src/core/app/cli.ts iniciar            # --abrir abre la interfaz web en el navegador
```

```bash
/mnt/c/dev/orquestador/scripts/win.sh node src/core/app/cli.ts iniciar < /dev/null
```

Imprime una línea `{"ready":true,"url":…,"wsUrl":…,"token":…}` y un enlace `web:`. Las dos llevan el token: no las
pegues en chats, issues ni registros. Se detiene con Ctrl+C. Con tareas en curso, Ctrl+C las deja `cancelled` sin
poder reintentarlas (`flota-08`).

**No lances `iniciar` con Berland abierta** sobre la misma carpeta de datos mientras `servidor-01` siga abierta. Aunque
falle con EADDRINUSE, antes marca como fallidas las tareas del núcleo vivo. Para un segundo núcleo de prueba, usa
datos y puerto propios:

```powershell
$env:ORQ_DATA_DIR = "$env:TEMP\orq-prueba"; $env:ORQ_PORT = "47812"; node src/core/app/cli.ts iniciar
```

```bash
/mnt/c/dev/orquestador/scripts/win.sh "set ORQ_DATA_DIR=%TEMP%\orq-prueba&& set ORQ_PORT=47812&& node src/core/app/cli.ts iniciar" < /dev/null
```

Ese núcleo tiene una bóveda vacía: no ve las claves ni los proyectos del núcleo real.

### 5. Comprobar que el núcleo responde en 127.0.0.1:47811

`GET /health` también exige el token, así que sin token un núcleo vivo responde **401** `unauthorized`. Así lo
detecta la propia app de escritorio (`apps/desktop/README.md`).

```powershell
curl.exe -sS -i http://127.0.0.1:47811/health       # «HTTP/1.1 401» = núcleo vivo; «Failed to connect» = no hay núcleo
Get-NetTCPConnection -LocalPort 47811 -State Listen  # qué proceso tiene el puerto
```

```bash
/mnt/c/dev/orquestador/scripts/win.sh curl.exe -sS -i http://127.0.0.1:47811/health < /dev/null
```

Desde WSL, pasa por `win.sh`: el `127.0.0.1` de WSL no es necesariamente el de Windows. Con el token del núcleo que
lanzaste a mano, la misma ruta responde `{"ok":true,"version":…,"startedAt":…,"uptimeMs":…}`. En Berland, la barra
lateral dice «Conectado en vivo».

### 6. Pruebas en vivo (`ORQ_LIVE`, `tests/live/**`)

Estas pruebas usan las CLIs, las APIs y el Chrome reales. Gastan cupo o saldo y algunas necesitan al usuario
(sesiones iniciadas o aceptar la conexión en Chrome). Sin `ORQ_LIVE=1` se saltan. Corre **una a la vez**:

```bash
# WSL, pruebas que no usan la clave de Claude
/mnt/c/dev/orquestador/scripts/win.sh "set ORQ_LIVE=1&& npx vitest run tests/live/codex.live.test.ts" < /dev/null
# WSL, pruebas con la clave de Claude: con ANTHROPIC_API_KEY exportada en esa terminal, WSLENV la pasa a Windows (indicador /w)
WSLENV=ANTHROPIC_API_KEY/w:ANTHROPIC_BASE_URL/w /mnt/c/dev/orquestador/scripts/win.sh "set ORQ_LIVE=1&& npx vitest run tests/live/claude-sdk.live.test.ts" < /dev/null
```

```powershell
# PowerShell: la clave solo en la variable de esa terminal, nunca en archivos
$env:ORQ_LIVE = '1'; npx vitest run tests/live/codex.live.test.ts
Remove-Item Env:ORQ_LIVE   # si no, el próximo «npm test» de esa terminal también corre las pruebas en vivo
```

`npm run test:live` (`set ORQ_LIVE=1&& vitest run tests/live`) las corre **todas** seguidas. Funciona desde
PowerShell porque npm ejecuta los scripts con `cmd`. Úsalo solo si de verdad quieres gastar todo eso de una vez.

| Archivo | Qué necesita | Gasto |
|---|---|---|
| `agy.live.test.ts` | `ORQ_LIVE=1`; agy instalado y con sesión en Windows | sin inferencia (lee `/usage`) |
| `codex.live.test.ts` | `ORQ_LIVE=1`; Codex instalado y con sesión | sin inferencia (cupo por app-server o sesiones) |
| `quota-acceptance.live.test.ts` | `ORQ_LIVE=1`; Codex y agy | sin turnos ni tokens |
| `chrome-personal.live.test.ts` | `ORQ_LIVE=1`: solo argumentos de Codex y agy. `+ ORQ_LIVE_CHROME=1`: toca tu Chrome (activar la depuración remota en `chrome://inspect/#remote-debugging` y aceptar la conexión). `+ ORQ_LIVE_CUPO=1`: Codex abre example.com en tu Chrome | cupo de Codex solo con `ORQ_LIVE_CUPO=1` |
| `f1-acceptance.live.test.ts` | `ORQ_LIVE=1`; Codex y agy reales; Claude solo si hay `ANTHROPIC_API_KEY` | cupo de cada agente |
| `api.live.test.ts` | `ORQ_LIVE=1` + `ANTHROPIC_API_KEY` (`ORQ_LIVE_MODEL` opcional) | un encargo corto |
| `claude-sdk.live.test.ts` | `ORQ_LIVE=1` + `ANTHROPIC_API_KEY` | unos 0,55 USD |
| `conductor.live.test.ts` | `ORQ_LIVE=1` + `ANTHROPIC_API_KEY` | tope de 0,50 USD |
| `chat.live.test.ts` | `ORQ_LIVE=1` + `ANTHROPIC_API_KEY` | tope de 0,50 USD |
| `e2e-claude.live.test.ts` | `ORQ_LIVE=1` + `ANTHROPIC_API_KEY`; solo Windows | tope de 1 USD |
| `f3-acceptance.live.test.ts` | `ORQ_LIVE=1` + `ANTHROPIC_API_KEY`; solo Windows; flota real con Claude, Codex y agy | tope de 3 USD, más cupo de Codex y agy |

Para `chrome-personal`, las variables se encadenan como en su cabecera, por ejemplo
`scripts/win.sh "set ORQ_LIVE=1&& set ORQ_LIVE_CHROME=1&& npx vitest run tests/live/chrome-personal.live.test.ts"`.

## Avisos

- **Un check a la vez.** No corras varios `npm run -s check`, `npm test` o `vitest` en paralelo, ni mientras la flota
  corre sus gates. Con Defender y la CPU al límite, pruebas de 1 s llegaron a tardar 20 s con la flota corriendo
  pruebas en paralelo (comentario de `vitest.config.ts`; ver `pruebas-03`). Fallan por tiempo, no por errores. Cierra
  los demás antes de lanzar uno.
- **Worktrees y `node_modules`.** Los worktrees de la flota tienen `node_modules` como junction hacia
  `C:\dev\orquestador\node_modules`. `git worktree remove`, y sobre todo `--force`, sigue la junction en Windows y
  **vacía el `node_modules` principal**. Antes de quitar un worktree a mano, borra solo el enlace:
  `cmd /c rmdir <worktree>\node_modules` (quita el enlace, no el destino). El `WorktreeManager` del núcleo ya lo hace
  solo (`docs/BITACORA-FLOTA.md`).
- **`npm ci` con Berland cerrada**, y también sin gates de la flota corriendo, porque usan el mismo `node_modules` por
  la junction.
- **Un solo núcleo por carpeta de datos** mientras `servidor-01` siga abierta (ver el paso 4).
- **Ctrl+C en `iniciar` con tareas en curso** las deja `cancelled` sin reintento (`flota-08`).
- **El token** está en la línea `{"ready":true,…}`, en el enlace `web:` y, cifrado, en
  `%LOCALAPPDATA%\orquestador\session.json`. No lo copies a issues, chats ni registros.
