# Si una propuesta aprobada no llega a la flota, el chat la muestra «Aprobada» en verde, sin aviso y sin forma de reintentar

- **Área:** Interfaz: chat y composer
- **Severidad:** alta
- **Archivos:** `src/ui/features/chat/store.ts:40-50`, `src/ui/features/chat/store.ts:427-444`, `src/ui/features/chat/store.ts:446-462`, `src/ui/features/chat/components/ProposalsCard.tsx:9-14`, `src/ui/features/chat/components/ProposalsCard.tsx:80`, `src/ui/features/chat/components/ProposalsCard.tsx:117`, `src/ui/features/chat/components/ProposalsCard.tsx:125`, `src/ui/features/chat/ChatView.tsx:108`, `src/core/chat/routes.ts:38-44`, `src/core/chat/routes.ts:238-248`, `src/core/conductor/approve.ts:16-21`, `src/core/conductor/approve.ts:46-74`, `src/core/chat/service.ts:525-548`, `src/core/chat/proposals.ts:146-149`, `src/core/conductor/tools.ts:247-249`, `src/shared/api.ts:205-210`, `tests/ui/chat/helpers.ts:180-191`
- **Estado:** resuelta

## Cómo ocurre
En modo Plan la mente propone tareas y el usuario las aprueba en la tarjeta «Tareas propuestas» del chat. Al aprobar,
el núcleo aprueba y entrega la tarea a la flota en el mismo paso (`approveAndDeliver`). Si la entrega sale bien, la
propuesta pasa a `delegated` («Delegada») y aparece en el tablero. Si falla, se queda en `approved` y el motivo va en
`failed`. El contrato de la ruta lo dice así (`src/core/chat/routes.ts:38-44`):

```ts
export const approvalResponse = z.strictObject({
  proposals: z.array(proposalSchema),
  delivered: z.array(idSchema),
  /** Aprobadas que no se entregaron (siguen `approved`; aprobar de nuevo reintenta). */
  failed: z.array(z.strictObject({ taskId: idSchema, reason: z.string() })),
});
```

Pasos:

1. En modo Plan, la mente propone `f5-t1` y `f5-t2`, y `f5-t2.dependsOn = ['f5-t1']`.
2. El usuario pulsa «Aprobar f5-t2» antes que `f5-t1`. La interfaz hace `POST /chats/:id/proposals/f5-t2/approve`
   (`src/core/chat/routes.ts:238-248`), que llama a `ChatService.approve` (`src/core/chat/service.ts:525-536`).
3. `approveAndDeliver` aprueba `f5-t2`. Como `f5-t1` sigue `proposed` y no está en la flota, la entrega no se hace
   (`src/core/conductor/approve.ts:50-58`):
   ```ts
   if ((await proposals.get(dep))?.approval === 'delegated') continue;
   if (await fleet.status(dep)) continue;
   missing.push(dep);
   ...
   report.failed.push({ taskId: task.id, reason: `depende de ${missing.join(', ')}, que aún no está en la flota: apruébala antes` });
   ```
   Lo mismo pasa cuando `fleet.delegate` dice que no o lanza un error (`approve.ts:60-68`). Por ejemplo: «La flota
   se está deteniendo», el gestor de worktrees no está (`NO_WORKSPACES_REASON`, que también dice «La tarea sigue
   aprobada y se puede delegar cuando esté») o `queue.add` lanza un error (`src/core/app/fleet-port.ts:116-123`).
4. La respuesta trae `{ proposals: [... f5-t2 approved ...], delivered: [], failed: [{ taskId: 'f5-t2', reason }] }`.
   El store solo mira `proposals` (`src/ui/features/chat/store.ts:435-437`):
   ```ts
   const r = await api.post<unknown>(`/chats/${enc(chat.id)}/proposals/${enc(taskId)}/${decision}`);
   const next = proposalsFrom(r, get().proposals);
   if (next) set({ proposals: next });
   ```
   y `proposalsFrom` solo saca `proposals` o `proposal` (`store.ts:40-50`). `failed` se pierde y no se pone `notice`.
   `approveAll` hace lo mismo (`store.ts:453-455`).
5. La ficha muestra la etiqueta «Aprobada» con color `success` (`ProposalsCard.tsx:9-14`). Es la etiqueta que el
   usuario ve justo después de aprobar, así que nada indica que la tarea no está en la flota. Los botones Aprobar y
   Rechazar solo salen con `approval === 'proposed'` (`ProposalsCard.tsx:80`). «Aprobar todo» solo sale si en esa
   tarjeta queda alguna `proposed` (`ProposalsCard.tsx:117` y `125`), y su contador solo cuenta `proposed`
   (`ChatView.tsx:108`).
6. Después el usuario aprueba `f5-t1` con su botón. La entrega solo procesa los ids aprobados en esa llamada
   (`approve.ts:47-49`): `f5-t1` llega a la flota y `f5-t2` sigue `approved` para siempre. En toda la tarjeta ya no hay
   `proposed`, así que no queda ningún botón. La mente tampoco puede arreglarlo, porque en modo Plan `delegar` está
   bloqueado (`src/core/conductor/tools.ts:247-249`). La tarea nunca entra al tablero y el usuario cree que la flota la
   está haciendo.

El núcleo sí sabe reintentar: `#decide` acepta pasar de `approved` a `approved` (`src/core/chat/proposals.ts:146-149`,
`allowed = ['proposed', 'approved']`) y `approveAll` del servicio incluye las `approved` sin entregar
(`src/core/chat/service.ts:539-548`). Lo que falta es que la interfaz lo muestre.

Recargar tampoco sirve: `proposalSchema` solo trae `task`, `approval` y `proposedAt` (`src/shared/api.ts:205-210`) y el
mensaje `proposals` de `/ws` lleva la misma lista (`src/core/chat/service.ts:627`). El motivo solo existe en esa
respuesta HTTP y la interfaz no la lee.

Las pruebas no lo cubren: el núcleo falso de `tests/ui/chat/helpers.ts:180-191` responde a approve y approve-all solo
con `{ proposals }`, sin `delivered` ni `failed`.

## Por qué pasa
- El store no lee `failed` de `approvalResponse`: `proposalsFrom` (`store.ts:40-50`) ignora todo lo que no sea
  `proposals`, y ni `decide` ni `approveAll` (`store.ts:427-462`) avisan.
- La tarjeta trata `approved` como un estado terminal y positivo. No separa «aprobada y entregada» (que en la práctica
  pasa enseguida a `delegated`) de «aprobada sin entregar», y no ofrece ninguna acción para `approved`, aunque el núcleo
  dice que aprobar de nuevo reintenta (`routes.ts:42`).
- El estado durable de la propuesta no guarda el motivo del fallo, así que otras ventanas y las recargas tampoco
  pueden mostrarlo.

## Solución posible
1. `src/ui/features/chat/store.ts`: en `decide` (con `decision === 'approve'`) y en `approveAll`, leer `failed` de la
   respuesta (validarla con un esquema local o con `approvalResponse`, si se mueve a `src/shared/api.ts`). Si trae
   algo, poner `notice` con «No se pudo entregar f5-t2 a la flota: <reason>», una línea por tarea. Guardar también
   un mapa `undelivered: Record<taskId, reason>` en el store para la tarjeta. Vaciar la entrada de una tarea cuando
   pase a `delegated` (por la respuesta o por `applyLive` con `proposals`) o a `rejected`.
2. `src/ui/features/chat/components/ProposalsCard.tsx`: con `approval === 'approved'`, mostrar el chip «Aprobada · sin
   entregar» en color `warning`, con el motivo si se conoce. Añadir el botón «Reintentar entrega» (llama a
   `onDecide(id, 'approve')`) y dejar «Rechazar», que el núcleo admite para `approved` (`proposals.ts:148`).
3. `ProposalsCard.tsx:117` y `ChatView.tsx:108`: que «Aprobar todo» y su contador cuenten también las `approved`
   sin entregar, igual que `ChatService.approveAll` (`service.ts:544`).
4. `tests/ui/chat/helpers.ts`: que el núcleo falso devuelva `delivered` y `failed` como el real, para no ocultar
   la diferencia.

### Otras opciones
- **Guardar el motivo en el núcleo:** añadir `deliveryError` (opcional) a la propuesta, en la tabla `chat_proposals`
  y en `proposalSchema`. `approveAndDeliver` lo escribe al fallar y `markDelegated` lo borra. Así lo ven también
  `/ws`, las otras ventanas y las recargas, y la interfaz no necesita el mapa en memoria. Es la solución más sólida,
  pero toca el contrato Zod, una migración y el núcleo.
- **Estado nuevo `failed` (o `undelivered`) en `proposalApprovalSchema`:** deja el contrato más claro, pero afecta
  a todo el que compara `approval` (mente, terminal `/aprobar`, `#decide`, `markDelegated`).
- **Reintento automático en el núcleo:** cuando una tarea pasa a `delegated`, entregar las `approved` que dependían
  de ella. Esto arregla el caso de las dependencias aunque la interfaz no haga nada, pero no los rechazos de la flota.
  Por eso conviene sumarlo al aviso visible y no usarlo como única solución.

La propuesta de arriba es la más chica y no toca el contrato, pero no es la única. La primera alternativa es la más
robusta a largo plazo.

## Cómo probar que quedó resuelta
- **Prueba automatizada propuesta:** en `tests/ui/chat/chat-view.test.tsx`, un caso nuevo con
  `fakeCore({ chats: [chat], proposals: { [chat.id]: [makeProposal('f5-t1'), makeProposal('f5-t2', { task: { ...makeProposal('f5-t2').task, dependsOn: ['f5-t1'] } })] } }, override)`
  (`makeProposal` recibe un `Partial<Proposal>`, `tests/ui/chat/helpers.ts:53`).
  El `override` responde al `POST .../proposals/f5-t2/approve` con
  `{ proposals: [f5-t1 proposed, f5-t2 approved], delivered: [], failed: [{ taskId: 'f5-t2', reason: 'depende de f5-t1, que aún no está en la flota: apruébala antes' }] }`.
  Afirma:
  1. tras pulsar «Aprobar f5-t2» aparece un `role="alert"` cuyo texto contiene `f5-t2` y `depende de f5-t1`;
  2. la fila `proposal-f5-t2` no muestra solo «Aprobada»: muestra «sin entregar» y un botón «Reintentar entrega»;
  3. pulsar «Reintentar entrega» hace otro `POST /chats/chat_abc123/proposals/f5-t2/approve`; si esa respuesta trae
     f5-t2 `delegated` y `failed: []`, el botón desaparece y la fila dice «Delegada»;
  4. con f5-t1 ya `delegated` y f5-t2 `approved` sin entregar, «Aprobar todo» sigue visible y hace
     `POST .../approve-all`.
  Añadir otro caso igual con un rechazo de la flota (`reason: 'La flota se está deteniendo'`).
- **Comando (desde WSL):** `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/chat/chat-view.test.tsx"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/ui/chat/chat-view.test.tsx`).
- **Verificación manual:** en modo Plan, pedir a la mente dos tareas donde la segunda dependa de la primera. Aprobar
  primero la segunda. Debe salir el aviso con el motivo y la ficha debe decir «sin entregar» con «Reintentar entrega».
  Después aprobar la primera y pulsar «Reintentar entrega» en la segunda: las dos deben salir en el tablero.
