# Un doble clic en una sugerencia del chat vacío crea dos conversaciones y lanza dos turnos de la mente

- **Área:** Interfaz: chat y composer
- **Severidad:** media
- **Archivos:** `src/ui/features/chat/ChatView.tsx:280`, `src/ui/features/chat/ChatView.tsx:146`, `src/ui/features/chat/ChatView.tsx:148-161`, `src/ui/features/chat/components/EmptyChat.tsx:25`, `src/ui/features/chat/components/EmptyChat.tsx:46-47`, `src/ui/features/chat/store.ts:298-324`, `src/ui/features/chat/store.ts:400-415`, `src/ui/features/composer/Composer.tsx:66`, `src/ui/features/composer/Composer.tsx:146-161`, `src/core/chat/service.ts:306`, `src/core/chat/service.ts:418-421`
- **Estado:** abierta

## Cómo ocurre

Cuando un proyecto (o «Conversaciones») todavía no tiene chats, `ChatView` muestra `EmptyChat`, que ofrece tres primeros mensajes. Al elegir uno, la vista crea el chat con `POST /chats`, navega a él y manda el texto con `POST /chats/:id/messages`. Ese mensaje arranca un turno pagado de la mente.

El Composer se protege del doble envío con una guarda síncrona (`src/ui/features/composer/Composer.tsx:66` y `:147-148`):

```ts
const submitting = useRef(false);
...
if (!canSend || submitting.current) return;
submitting.current = true;
```

Las sugerencias no pasan por el Composer. `ChatView` llama directo a `onSubmit` y no le pasa `isDisabled` a `EmptyChat` (`src/ui/features/chat/ChatView.tsx:280`):

```tsx
body = <EmptyChat projectName={projectName} onPick={(text) => void onSubmit({ text, attachments: [] })} />;
```

`EmptyChat` acepta `isDisabled` (vale `false` por defecto, `EmptyChat.tsx:25`) y lo pone en el botón (`EmptyChat.tsx:46-47`), pero ese valor nunca llega a `true`.

`onSubmit` (`ChatView.tsx:148-155`) solo crea el chat si `useChat.getState().chat` es `null`:

```ts
let current = useChat.getState().chat;
if (!current) {
  current = await createChat();
  if (!current) return false;
  toChat(current.id, true);
}
```

`createChat` del store (`store.ts:298-324`) no lleva cuenta de una creación en curso: `chat` recién se llena cuando vuelve el `POST /chats` (`store.ts:311-323`). En el núcleo, `ChatService.create` (`src/core/chat/service.ts:306`) inserta un chat nuevo en cada llamada y no deduplica.

Pasos:

1. Abrir un proyecto sin conversaciones: aparece «¿Qué hacemos en …?» con las tres sugerencias.
2. Hacer doble clic en una, o un clic en dos distintas, antes de que vuelva el primer `POST /chats`.
3. Cada clic entra en `onSubmit` con `chat === null` y llama a `createChat()`, así que salen dos `POST /chats` y se crean dos chats.
4. Al volver cada respuesta, el store pone ese chat como activo (`store.ts:311-323`), `toChat` reemplaza la ruta y `store.send` hace su `POST /messages`. La guarda del núcleo (`live.busy`, `service.ts:419-421`) es **por chat**, así que no frena dos chats distintos: arrancan dos turnos de la mente.
5. El usuario termina en el segundo chat. El primero sigue corriendo en segundo plano con el mismo título (`titleFrom` del mismo texto, `service.ts:469`), y la respuesta de su `send` se descarta en la vista (`store.ts:404`). En modo `bypass` son dos mentes autónomas trabajando a la vez en la misma carpeta con el mismo encargo.

Cuándo se ven dos chats y cuándo no:

- **Dos chats y dos turnos:** si el segundo clic llega mientras el `POST /chats` del primero no ha vuelto. El handler es síncrono y en una máquina libre tarda poco, pero en este equipo la CPU está al límite (Defender) y el núcleo comparte un único hilo con la flota, el `/ws` y operaciones síncronas que lo bloquean (por ejemplo, `inssues/adaptadores-06-app-server-spawnsync-bloquea-nucleo.md`). Con la máquina cargada, la ventana alcanza para un doble clic.
- **Solo un aviso rojo pasajero:** si el segundo clic llega cuando ya hay chat pero antes de que vuelva el primer `POST /messages`, que puede tardar segundos porque espera a `#ensureSession`. Durante ese lapso `EmptyChat` sigue a la vista: `messages` está vacío y el chat sigue `idle` (`ChatView.tsx:231`). El segundo clic va a `send` sobre el mismo chat, el núcleo responde 409 («La mente todavía está respondiendo») y aparece el aviso. El `send` del primero lo borra al volver (`store.ts:408`). No se duplica el turno.

Una corrección al reporte original: en «Conversaciones» no se abren selectores de carpeta. Desde 5681da2, `createChat` no pide carpeta (`ChatView.tsx:145-146`), y la prueba «Conversaciones: no pide carpeta» lo comprueba. Lo que sí se duplica en ese caso es la carpeta interna: cada `create` hace `mkdirSync` de la suya (`service.ts:326`).

La prueba actual de las sugerencias (`tests/ui/chat/chat-view.test.tsx:355-374`) hace un solo `fireEvent.click` y no cubre el doble clic.

## Por qué pasa

Las sugerencias son una segunda vía de envío sin estado de «enviando». `ChatView` no tiene guarda propia en `onSubmit`, no pasa `isDisabled` a `EmptyChat`, y `createChat` del store no es reentrante. La única guarda contra envíos duplicados está dentro del Composer, y este camino no pasa por él.

## Solución posible

En `src/ui/features/chat/ChatView.tsx`, que el propio `onSubmit` tenga la guarda, así cubre las sugerencias y el Composer por igual:

- Un `const sending = useRef(false)` y un estado `const [starting, setStarting] = useState(false)`.
- Al entrar en `onSubmit`: `if (sending.current) return false; sending.current = true; setStarting(true);`, y soltar los dos en un `finally`.
- Pasar `isDisabled={starting}` a `<EmptyChat …/>` (`ChatView.tsx:280`), para que los botones se vean apagados (`disabled:opacity-50` ya existe en `EmptyChat.tsx:48`) y el usuario tenga una señal de que algo pasa.

El `ref` corta el segundo clic aunque React no haya vuelto a pintar todavía. El estado da la señal visual.

### Otras opciones

- **Creación en vuelo en el store** (`store.ts:298`): un `let creating: Promise<Chat | null> | null` para que dos `createChat()` seguidos devuelvan el mismo chat. Así también se arregla el doble clic en «Nueva conversación» (`ChatView.tsx:172-175`), que hoy crea dos chats vacíos. Sola no basta para las sugerencias: los dos `onSubmit` seguirían hasta `send` sobre el mismo chat y el segundo recibiría el 409 con su aviso. Conviene sumarla a la guarda de la vista, no usarla en su lugar.
- **Que la sugerencia solo rellene el Composer** y le dé el foco, sin enviar. La guarda del Composer cubriría el caso y el usuario podría editar el texto antes de mandarlo. Hoy el texto es estado interno del Composer (`Composer.tsx`), así que haría falta una prop nueva (un valor inicial o un `ref` imperativo). También cambia la interacción: elegir una sugerencia ya no enviaría al instante.
- **Mostrar un indicador** (spinner o «Creando la conversación…») en lugar de `EmptyChat` mientras dura el arranque. Mejora la señal pero no reemplaza a la guarda.

La propuesta no es la única: la guarda central en `onSubmit` es la de menor superficie, y la creación en vuelo en el store la complementa.

## Cómo probar que quedó resuelta

- **Prueba automatizada propuesta:** en `tests/ui/chat/chat-view.test.tsx`, dentro de `describe('estado vacío y primer mensaje')`, un caso «doble clic en una sugerencia crea un solo chat y envía un solo mensaje»:
  - `const { state, calls } = fakeCore({ chats: [] }); render(<ChatView projectId="demo" />);`
  - Buscar el botón «Revisa el estado del proyecto y propón los siguientes pasos» y hacer `fireEvent.click` **dos veces seguidas**, sin `await` entre medio. Con el `fetch` simulado, que ya es asíncrono, eso basta para que hoy los dos clics vean `chat === null`.
  - Afirmar `await waitFor(() => expect(posts(calls)).toEqual(['/chats', '/chats/chat_new001/messages']))`, `expect(state.chats).toHaveLength(1)` y `expect(window.location.hash).toBe('#/p/demo/c/chat_new001')`. Hoy fallaría con dos `/chats` y dos `/messages`, y la ruta terminaría en `chat_new002`.
  - Un segundo caso que compruebe los botones apagados: un `POST /chats` demorado con una promesa que se resuelve a mano. `installFetch` (`tests/ui/chat/helpers.ts:101`) hoy solo acepta respuestas síncronas, así que habría que dejar que `Handler` devuelva `Promise<Reply>` o envolver `fetch` con `vi.stubGlobal`. Tras el primer clic, afirmar que los tres botones de sugerencia tienen `disabled === true`. Luego resolver y afirmar un solo `POST /chats`.
  - Mismo escenario en «Conversaciones» (`projectId={null}`): un solo `POST /chats` y la ruta `#/conversaciones/chat_new001`.
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/chat/chat-view.test.tsx"` (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/ui/chat/chat-view.test.tsx`).
- **Verificación manual:** con un proyecto sin conversaciones, hacer doble clic rápido en una sugerencia, mejor con la máquina cargada. En el selector de conversaciones del encabezado debe aparecer una sola conversación nueva, y en el panel de la mente un solo turno. Los botones de sugerencia deben verse apagados hasta que aparezca el mensaje del usuario.
