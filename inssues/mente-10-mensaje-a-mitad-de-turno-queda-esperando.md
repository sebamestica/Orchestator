# Un mensaje enviado a mitad del trabajo deja a la mente «pensando» sin mostrar nada hasta que termina o se detiene

- **Área:** Mente y chat (núcleo, prompt e interfaz)
- **Severidad:** alta
- **Archivos:** `src/core/chat/service.ts:676-705`, `src/core/conductor/session.ts:179-186` (`SendOptions.priority`), `src/core/conductor/prompt.ts:45`, `src/core/conductor/guard.ts:199-211`, `src/ui/features/chat/timeline.ts:174-197`, `src/ui/features/chat/components/MessageList.tsx:63-79`, `src/ui/features/chat/store.ts:649-658`, `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts:792-796`
- **Estado:** resuelta en lo principal (capas 1, 2 y 4, y el tope de turnos autónomos). Queda abierta la capa 3: el aviso «Recibido…» y el botón «Atender ya». Ver «Lo que se hizo».
- **Origen:** uso real, chat `faf636ea…` de `radio_example-` (2026-11-07), con la base y el log del núcleo
- **Relacionadas:** `ui-chat-08-enviar-mientras-razona.md` (resuelta: abrió el envío «Ahora», pero no cubre este caso), `mente-09-subagentes-de-la-mente-solo-leen.md`

## Cómo ocurre

Pedido del usuario: «al tener al agente trabajando, si le mando un mensaje extra para pedir un cambio, se queda
pensando y solo vuelve a mostrar el trabajo cuando terminó y lo vuelvo a activar. Necesito que, al darle instrucciones
entre pensamientos, las razone, siga trabajando en lo que ya tenía y después las sume al razonamiento de forma
estratégica».

Lo que pasó en el chat (horas UTC; tabla `events`, sesión `chat-faf636ea…`, y `chat_messages`):

| Hora | Qué |
|---|---|
| 16:48:19 | El usuario manda «continua» y empieza el turno |
| 16:49–16:55 | La mente lee, edita `mic.css`, `index.html` y `script.js` (eventos 2806–2852) |
| 16:55:50 | La mente lanza `Agent` «investigador: Sonnet: revisa issues y micrófono» **en primer plano** (2855) |
| 16:56:31 | El usuario manda «levanta la página para verla en localhost» con «Ahora» (`POST /chats/:id/messages 201 3ms`) |
| 16:56–17:06 | Ningún evento de la mente: el investigador trabaja en su propia sesión |
| 17:06:12 | El usuario manda «??» |
| 17:06:39 | El usuario pulsa «Detener»: el `Agent` vuelve con «The user doesn't want to proceed» (3070) y el turno se cancela |

Pasos para reproducirlo:

1. En bypass, pedir algo que haga que la mente lance un subagente largo y espere su resultado.
2. Mientras ese subagente trabaja, mandar otro mensaje con «Ahora».
3. El mensaje aparece en el hilo y debajo solo dice «Pensando…». La mente no lo contesta ni lo menciona hasta que el
   subagente termina, y eso pueden ser 10 minutos o más. Si el usuario pierde la paciencia y detiene el turno, se pierde
   también lo que hacía el subagente.
4. Además, el trabajo que la mente ya había mostrado en ese turno (lecturas, ediciones) pasa a un bloque «Este turno
   terminó sin respuesta» bajo el mensaje anterior, aunque el turno sigue vivo.

## Por qué pasa

Hay tres causas, y se suman:

1. **El mensaje espera a que termine la herramienta en curso.** `#joinTurn` (`service.ts:676-705`) entrega el mensaje al
   SDK con `priority: 'next'`. El SDK lo incorpora «entre dos rondas de herramientas», pero un `Agent` en primer plano es
   una sola herramienta que dura lo que dure el subagente. Hasta que vuelve, la mente no ve el mensaje.
   - Nada empuja a la mente a lanzar en segundo plano: el prompt (`prompt.ts:45`) no lo menciona.
   - La guardia (`guard.ts:199-211`) no mira `run_in_background`.
   - El SDK lanza en segundo plano por omisión (`sdk-tools.d.ts:792-796`), pero la mente lo apagó en la llamada de las
     16:55:50: el resultado llegó como respuesta de la herramienta a las 17:06:39, no como aviso de tarea.
2. **La mente no tiene una regla para mensajes a mitad de turno.** Cuando por fin lo ve, el mensaje llega como un texto
   de usuario más, sin decirle que el turno ya tenía un plan en marcha. Puede abandonar lo que hacía o seguir sin
   contestar. No hay instrucción de contestar corto, seguir y ajustar el plan, ni de pasarle la indicación al subagente
   que la necesita: `SendMessage` no está entre las herramientas de la sesión.
3. **La interfaz parte el turno en dos.** `splitTurns` (`timeline.ts:174-197`) corta los eventos por la hora de cada
   mensaje. Con un mensaje de usuario a mitad de turno pasa esto:
   - los pasos anteriores quedan como «huérfanos» del mensaje previo y se dibujan como «Este turno terminó sin
     respuesta» (`MessageList.tsx:63-79`);
   - el borrador nuevo empieza vacío;
   - los pasos del subagente no entran al borrador porque son de otra sesión (`store.ts:649-658` filtra por
     `sessionId`).

   El usuario ve «Pensando…» sin nada debajo, aunque la mente y su subagente siguen trabajando.

## Solución posible

En capas. Se puede entregar en ese orden, y cada una mejora algo por sí sola.

1. **Subagentes en segundo plano por omisión** (núcleo, `session.ts` y `guard.ts`).
   - La guardia devuelve `updatedInput` con `run_in_background: true` en cada `Agent`/`Task` de la mente.
     `PreToolUseHookSpecificOutput.updatedInput` existe en el SDK 0.3.302.
   - Excepción: que la mente pueda pedir primer plano solo para un encargo corto, con `run_in_background: false` y un
     `maxTurns` bajo. O bien que no haya excepción y la mente espere el aviso.
   - Con eso, el bucle de la mente queda libre: el mensaje «Ahora» entra en la ronda siguiente, y cuando el subagente
     termina, el aviso abre un turno autónomo, algo que ya está resuelto (`background.test.ts`).
2. **Regla de mensajes a mitad de turno** (prompt y `#joinTurn`).
   - `#joinTurn` antepone una marca al texto, del tipo `[Mensaje del usuario a mitad de tu trabajo]`, como ya se hace
     con `effortNote`.
   - El prompt dice qué hacer con esa marca:
     - acusar recibo en una línea y seguir con lo que estaba;
     - si el mensaje cambia el plan, ajustarlo en el paso siguiente y decir qué cambió;
     - si es una pregunta, contestarla corto y seguir;
     - si afecta a un subagente vivo, pasárselo con `SendMessage`. Eso exige sumar `SendMessage` a `allowedTools`, con
       la guardia limitada a los subagentes de la sesión, y lanzar los subagentes con `name`.
3. **Aviso visible mientras el mensaje espera** (núcleo e interfaz).
   - Si al llegar el mensaje hay una herramienta larga en curso (`Agent` en primer plano o un `Bash` de más de N
     segundos), el chat muestra bajo el mensaje: «Recibido. La mente lo lee cuando termine: investigador «revisa issues y
     micrófono» (lleva 2 min)».
   - Un botón «Atender ya» lo reenvía con `priority: 'now'`, que corta solo esa herramienta, y queda como decisión
     explícita del usuario.
4. **Un solo turno en la vista** (`timeline.ts` y `MessageList.tsx`).
   - Un mensaje que entró al turno en curso, con una marca en el `ChatMessage` como `joinedTurn: true` (cambio opcional
     en `src/shared/api.ts`), se dibuja dentro de la respuesta en curso y no la parte.
   - Los pasos anteriores siguen en el borrador, no como «terminó sin respuesta».
   - El borrador muestra los subagentes vivos (`chat.backgroundTasks` y los `Agent` en curso) con su descripción y el
     tiempo que llevan.

### Otras opciones

- **`priority: 'now'` siempre.** El SDK aborta la herramienta en curso. Atiende enseguida, pero corta el trabajo del
  subagente, que es justo lo que el usuario no quiere: «que siga trabajando en lo que ya tenía».
- **Cortar el turno y reanudar con el mensaje.** Es lo que hace hoy el usuario a mano con «Detener». Pierde el trabajo a
  medias.
- **Solo la capa 4 (interfaz).** El usuario vería que la mente sigue viva, pero el mensaje seguiría esperando al
  subagente.

## Lo que se hizo (2026-11-07)

1. **Subagentes siempre en segundo plano.**
   - `ToolGuardOptions.backgroundSubagents` (`guard.ts`), que la sesión de la mente activa (`session.ts`): el hook
     devuelve cada `Agent`/`Task` permitido con `permissionDecision: 'allow'` y `updatedInput.run_in_background: true`.
     Si ya venía en segundo plano, no lo toca.
   - No hay excepción para primer plano: la mente lanza, sigue o cierra su respuesta, y retoma cuando llega el
     resultado.
2. **Tope de turnos autónomos con tandas en paralelo** (`service.ts` y `limits.ts`).
   - Con todo en segundo plano, 12 programadores podían abrir 12 turnos autónomos al terminar uno por uno. Con el tope
     de 5, el sexto turno habría cortado a los que seguían vivos.
   - Ahora un turno abierto por un subagente que terminó mientras otros de la tanda siguen trabajando
     (`Live.subagentEnded` con `background.size > 0`) no suma a `autonomous`.
   - Sí suma a `autonomousTotal`, con un techo de `maxAutonomousTurns × AUTONOMOUS_TOTAL_FACTOR` (10, o sea 50 con el
     tope por defecto) contra una mente que siempre deja uno vivo. El tope por mensaje en USD sigue contando todo.
3. **Mensaje a mitad de turno marcado, con su regla.**
   - `#joinTurn` le manda a la mente `MID_TURN_NOTE` (`[Mensaje del usuario a mitad de tu trabajo]`) antes del texto.
     En el hilo queda el texto tal cual lo escribió el usuario.
   - El prefijo del prompt suma «Mensajes durante el trabajo»: acusar recibo en una línea, atender lo corto y seguir,
     ajustar el plan sin rehacer lo hecho y juntar con el resultado del subagente.
4. **La vista no parte el turno** (`timeline.ts`).
   - Si los pasos que preceden a un mensaje del usuario no traen nada que cierre el turno (`done`, `error` o estado
     cancelado, fallido o terminado), `splitTurns` los pasa a la respuesta de ese turno o al borrador, en vez de
     dibujarlos como «Este turno terminó sin respuesta».

Queda pendiente:
- **Capa 3:** el aviso «Recibido, la mente lo lee cuando termine X» y el botón «Atender ya» (`priority: 'now'`). Con los
  subagentes en segundo plano quedan pocos casos: un comando o una herramienta de un plugin que tarde mucho.
- **`SendMessage`:** para que la mente pase una corrección a un subagente vivo. No se sumó porque también llega a otras
  sesiones de Claude de la máquina (`ListAgents`) y habría que limitarlo en la guardia a los subagentes de la sesión.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta, núcleo** (`tests/core/chat/` y `tests/core/conductor/`):
  - la guardia devuelve `updatedInput.run_in_background === true` para un `Agent` de la mente sin la opción, y respeta
    lo acordado para `false`;
  - con un `Agent` en curso (doble del SDK que no devuelve su resultado), `submit` con `delivery: 'now'` publica el
    aviso «Recibido… cuando termine» con el nombre de la herramienta;
  - el texto que llega al SDK lleva la marca de mensaje a mitad de turno y el prompt de bypass y de chat tiene la regla.
- **Prueba automatizada propuesta, interfaz** (`tests/ui/chat/`): eventos de un turno vivo, luego un mensaje
  `joinedTurn` y luego más eventos. No aparece `orphan-turn`, el borrador muestra los pasos de antes y de después, y el
  subagente vivo aparece con su descripción.
- **Pruebas que ya existen** (con `mente-10` en el nombre o en el comentario):
  - `tests/core/conductor/session.test.ts`: `Agent` con `run_in_background: false` sale permitido y en segundo plano, y
    el prefijo trae la regla y la marca;
  - `tests/core/chat/enviar-en-curso.test.ts`: «Ahora» llega al SDK con la marca y con `priority: 'next'`, y el hilo
    guarda el texto sin la marca;
  - `tests/core/chat/background.test.ts`: con un tope de 1, tres subagentes que terminan uno por uno no cortan la
    cadena, y un turno más sin subagentes sí la corta;
  - `tests/ui/chat/timeline.test.tsx`: un mensaje con el turno vivo no deja `orphans` y la respuesta se queda con todos
    los pasos; si el turno se canceló antes, sus pasos siguen siendo un turno sin respuesta.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh npx vitest run tests/core/chat tests/core/conductor tests/ui/chat`.
- **Verificación manual:** en bypass, pedir «revisa con 2 investigadores todo el CSS». Mientras trabajan, mandar «y
  levanta la vista previa en localhost». En segundos la mente contesta que lo recibió, levanta la vista previa y sigue;
  cuando terminan los investigadores, junta su resultado con el pedido nuevo. En ningún momento aparece «Este turno
  terminó sin respuesta».
