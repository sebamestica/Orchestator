# Issue 7 — Los agentes siguen trabajando aunque nadie mire la sesión

Estado: hecho · Commit: uno solo, a nombre del usuario y sin trailers

## Sospecha del usuario
«Los agentes no trabajan si yo no estoy mirando la sesión en la que están trabajando.»

## Lo que mostraron los datos (chat de marketing, 2026-11-05)
- **00:20:41.** La mente lanzó 4 investigadores en segundo plano (Agent asíncrono) y cerró su turno. Los
  investigadores **sí trabajaron solos**: entre 32 y 48 herramientas cada uno, hasta las 00:33.
- **00:29:07.** Terminó uno, y la mente siguió sola con un resumen. **Ese texto nunca llegó al historial del chat**,
  así que quien no estaba mirando en vivo no lo vio.
- **00:33:55.** El usuario escribió. **2 s después** el núcleo cerró la sesión de la mente y la reanudó, y los 3
  investigadores que quedaban se cancelaron: «didn't finish before the previous session ended».

## Causas en el código
1. **`ChatService.#ensureSession` recrea la sesión cuando cambia su clave** (modelo, esfuerzo, modo, carpetas,
   plugins…), aunque haya subagentes trabajando. Así los mata.
2. **La clave se calculaba con una lectura vieja de los plugins.** La caché de plugins se refresca al cargar el
   entorno de la mente, justo después de calcular la clave. Por eso el mensaje siguiente veía otra clave y recreaba la
   sesión. Pasó, por ejemplo, tras reconectar el plugin de Chrome.
3. **La sesión ociosa se cierra a los 15 min aunque haya subagentes trabajando.** Investigaciones largas morían ahí.
4. **Los turnos que la mente arranca sola** (cuando termina un subagente) no se registraban: no guardaban la
   respuesta ni ponían el chat en `running`.
5. **Al cerrar la ventana**, Berland apagaba el núcleo si no había tareas `running`. No contaba las tareas en
   revisión, traspaso o listas, ni a la mente trabajando.

## Cambios
- **`src/core/chat/service.ts`:**
  - Cuenta los subagentes vivos de cada chat (`Live.background`, a partir de los `status` de las sesiones hijas).
  - Con subagentes vivos, la sesión no se recrea por cambio de ajustes (el cambio rige al terminar) ni se cierra por
    inactividad.
  - La clave de la sesión se calcula con los plugins ya refrescados.
  - Un turno que arranca la mente sola (`startsMainTurn`) se trata como cualquier turno: el chat pasa a `running`, la
    respuesta se guarda en el historial y se difunde por `chat_message`.
- **`src/shared/api.ts`:** `Chat.backgroundTasks` (opcional, solo en memoria).
- **Interfaz:** `BackgroundLine` encima del input: «N agentes siguen trabajando en segundo plano: la mente te
  responde aquí cuando terminen».
- **Escritorio** (`apps/desktop/src/lib/core-client.ts`): al cerrar la ventana, el núcleo sigue vivo si hay tareas
  `ready`/`running`/`review`/`handed_off`, o chats respondiendo o con subagentes en segundo plano.

## Pruebas
- `tests/core/chat/background.test.ts`:
  - la mente sigue sola y su respuesta queda en el historial;
  - la inactividad no cierra la sesión con un subagente vivo;
  - un cambio de ajustes no la recrea hasta que termina el subagente;
  - los plugins refrescados no fuerzan una sesión nueva.
- `tests/desktop/core-client.test.ts`: cuenta las tareas activas y a la mente.
- Check completo: 1681 pruebas aprobadas.
