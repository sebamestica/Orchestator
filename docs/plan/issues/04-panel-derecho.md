# Issue 4 — Panel derecho: solo si la mente y los subagentes están trabajando

Estado: hecho (interfaz) · Commit: uno solo, a nombre del usuario y sin trailers · Depende de: nada (conviene después del 3)

## Problema
El panel derecho (`src/ui/features/agents-panel/AgentsPanel.tsx` y `model.ts`, montado en `App.tsx:132`) muestra
demasiado. Hoy tiene:
- cabecera «Agentes en vivo» con «N activos» y el gasto de hoy;
- árbol de sesiones con «Subagentes (n)», que en realidad son los subagentes internos de Claude, no la flota;
- una tarjeta por sesión con modelo, «Tarea X», los últimos 3 eventos (hasta 500 si se expande), tokens, costo y
  barra de cupo;
- un desplegable «Recientes (≤50)».

Al montar, y en cada reconexión, pide la historia completa de 50 sesiones (hasta 50 × 500 eventos).

Además, los datos que necesita el panel nuevo hoy no son fiables:
- **`sessions.task_id` nunca se rellena.** `store.startSession` no se llama, así que las 90 sesiones de la base
  dicen «Sin tarea asociada».
- **Los cambios de estado de la cola no llegan a `/ws`.** `fleet-service.ts:67-69` los guarda en SQLite sin
  `hub.publishTask`, y `useApp.tasks` se queda desactualizado.
- **En revisión no se sabe quién revisa.** La tarea guarda el agente del autor, y el revisor corre como
  `<id>-revision`.
- **Las sesiones que quedan colgadas al caerse el núcleo** siguen «running» para siempre.
- **«Hoy» compara con la fecha UTC**, pero el núcleo usa la zona local. En Chile marca 0 desde las 21:00.

## Qué se quiere
Saber de un vistazo si la **mente** (el agente de cabeza) está trabajando, si cada **subagente** de la flota
trabaja o está detenido, y qué está haciendo.

## Diseño
- **Fila fija «Mente».**
  - Estados: Pensando / En espera / Error / Libre.
  - Una línea con lo que hace: su última herramienta, o «pensando…».
  - «· n ayudantes» si tiene sesiones hijas.
  - Fuente: `Chat.state` del mensaje `chat` del hub (`chat/service.ts:391,722`), más el último evento de la sesión
    `chat-<id>`.
  - Muestra el chat que está pensando. Si hay varios, primero el del chat abierto.
- **Una fila por agente de la flota** (de `settings.workers`), con su nombre y uno de estos estados:

  | Estado | Cuándo |
  |---|---|
  | Trabajando | tiene una sesión `running` |
  | En espera | sesión `waiting` (límite o reintento) |
  | Sin señal | lleva más de N min sin eventos |
  | Detenido | su última tarea falló, con el motivo del issue 3 |
  | Libre | sin trabajo |

  - Una línea «`<tarea>` · `<rol autor/revisor>` · `<última acción>`».
- **Se quita:** la transmisión de eventos, los archivos, los tokens y el costo por tarjeta, la barra de cupo (pasa a
  un aviso mínimo solo si queda < 10 %), el modelo, el árbol de subagentes internos, «Recientes», la llamada a
  `/usage` (se va al perfil, issue 5) y la carga de la historia de 50 sesiones. Solo se pide la cola de las sesiones
  activas.
- **Núcleo:**
  - Enlazar sesión y tarea, con su rol: el `Supervisor` registra `task_id` y rol (`author`/`reviewer`) al primer
    evento de cada intento (`supervisor.ts:222,367`), con un `SessionLinker` inyectado.
  - Difundir los cambios de la cola con `hub.publishTask` en `fleet-service.ts:67-69`.
  - Al arrancar, marcar `cancelled` las sesiones `starting`/`running`/`waiting` que quedaron colgadas.
- **Arreglo:** «Hoy» con la zona horaria del núcleo.

## Rutas propias
- Interfaz: `src/ui/features/agents-panel/**`, `tests/ui/agents-panel/**`.
- Núcleo: `src/core/orchestrator/supervisor.ts` (solo el enlace sesión–tarea), `src/core/store/store.ts`
  (`linkSession`, limpieza al arrancar), `src/core/app/fleet-service.ts` (`publishTask`),
  `tests/core/store/session-link*.test.ts`, `tests/core/orchestrator/supervisor-link*.test.ts`.
- Contrato (A0): `role` y `taskId` en el resumen de sesión de `src/shared/api.ts`, si no están.

## Criterios de aceptación
1. Con un turno de la mente en curso, la fila «Mente» dice «Pensando» y muestra su última herramienta. Al terminar,
   «Libre».
2. Con una tarea de la flota en curso, la fila del agente dice «Trabajando», con la tarea, el rol y la última acción.
   El revisor aparece como «revisor».
3. Una sesión colgada de antes de reiniciar no aparece como «Trabajando».
4. `sessions.task_id` queda relleno en las sesiones nuevas de la flota.
5. Los cambios de la cola llegan por `/ws` sin recargar.
6. El panel ya no carga la historia de 50 sesiones al abrir: lo comprueba una prueba que cuenta las llamadas.
7. `npm run -s check` en verde.

## Dudas abiertas para el usuario
- ¿Muestro los agentes libres, o solo los que trabajan o están detenidos?
- ¿Quito del todo el cupo, o dejo el aviso mínimo si queda menos del 10 %?

## Resultado (implementado por Codex; verificado por A0)
- **Lo que pidió el usuario:** «sí, muéstrame también a los agentes libres, y con animaciones».
- **Fila fija «Mente»:** Pensando / Trabajando en segundo plano (`Chat.backgroundTasks`, del issue 7) / Libre / Error, con su última acción.
- **Una fila por agente habilitado, siempre visible:** Trabajando / En espera / Sin señal / Detenido (con el motivo, del issue 3) / Libre.
- **Animaciones:** un punto que late, un anillo para «pensando», una barra de actividad y una transición al cambiar de estado. Todas se desactivan con `prefers-reduced-motion`.
- **Se quitó:** la transmisión de eventos, las métricas por tarjeta, la barra de cupo, «Recientes», `/usage` y la carga de la historia de 50 sesiones.
- **Pruebas:** 18 en `tests/ui/agents-panel/`. El check completo quedó en verde, con 1732 pruebas.
- **Pendiente para el núcleo:** que las sesiones activas se filtren en el servidor. Hoy el panel consulta un evento por sesión activa.
