# Ajustes › Mente no deja elegir «Chat» como modo inicial de los chats

- **Área:** Interfaz
- **Severidad:** baja
- **Archivos:** `src/ui/features/settings/MindSection.tsx:18-22`, `src/ui/features/settings/MindSection.tsx:159-186`, `src/shared/api.ts:29`, `src/shared/api.ts:32`, `src/shared/api.ts:56`, `src/shared/api.ts:88`, `src/ui/features/chat/format.ts:7-12`, `src/core/chat/service.ts:335`, `src/ui/features/chat/ChatView.tsx:90`, `tests/ui/settings/settings.test.tsx:52-61`
- **Estado:** resuelta
- **Origen:** revisión de agy, verificada por Claude

## Cómo ocurre
El issue 10 sumó el modo `chat` (la mente trabaja como Claude Code, sin flota) al contrato, al ciclo de Shift+Tab y a la
ficha de modo del chat. La tarjeta «Modo inicial de los chats» de Ajustes › Mente se quedó con los tres modos de antes.

Pasos:
1. Abrir Berland en Ajustes › Mente (`#/ajustes/mente`).
2. Bajar a la tarjeta «Modo inicial de los chats».
3. Solo aparecen «Plan», «Auto» y «Bypass». No hay forma de que un chat nuevo arranque en «Chat»: hay que cambiarlo
   con Shift+Tab en cada chat.

Evidencia:
- El contrato admite `chat` como modo y como modo inicial:
  - `src/shared/api.ts:29`: `export const mindModeSchema = z.enum(['plan', 'auto', 'bypass', 'chat']);`
  - `src/shared/api.ts:32`: `MIND_MODE_CYCLE: readonly MindMode[] = ['auto', 'plan', 'bypass', 'chat'];`
  - `src/shared/api.ts:56`: `defaultMode: mindModeSchema,` (en `settingsSchema`), y `src/shared/api.ts:88`:
    `defaultMode: mindModeSchema.optional(),` (en `settingsPatchSchema`). El núcleo lo guarda tal cual
    (`src/core/settings/store.ts:36`) y lo usa al crear el chat (`src/core/chat/service.ts:335`:
    `mode: body.mode ?? settings.defaultMode,`). La interfaz también lo usa como modo del borrador
    (`src/ui/features/chat/ChatView.tsx:90`, `store.ts:271`).
- La lista del selector no lo trae (`src/ui/features/settings/MindSection.tsx:18-22`):
  ```ts
  export const MODES: readonly { value: MindMode; label: string; description: string }[] = [
    { value: 'plan', ... },
    { value: 'auto', ... },
    { value: 'bypass', ... },
  ];
  ```
- La tarjeta dibuja solo esa lista (`MindSection.tsx:161`: `{MODES.map((m) => {`), y cada opción se marca con
  `const on = settings.defaultMode === m.value;` (`MindSection.tsx:162`).

Efecto secundario: si `defaultMode` ya vale `chat` (por ejemplo, porque llegó por `PATCH /settings` desde fuera de esta
pantalla), ninguna de las tres opciones sale marcada y el grupo de radios queda sin selección.

## Por qué pasa
`MODES` es un arreglo tipado como `{ value: MindMode; ... }[]`. Agregar `chat` a `MindMode` no obliga a que el arreglo
lo incluya, así que TypeScript no avisó. En cambio, `MODE_INFO` (`src/ui/features/chat/format.ts:7`) es un
`Record<MindMode, ...>` y sí dejó de compilar sin `chat`. Por eso el issue 10 lo actualizó
(`docs/plan/issues/10-modo-chat.md:73`: «Al agregar `chat` a `MindMode`, `format.ts` y `Composer.tsx` dejan de compilar
(son mapas por modo)») y `MindSection.tsx` se quedó como estaba. La prueba de la tarjeta
(`tests/ui/settings/settings.test.tsx:52-61`) solo elige «Bypass», así que tampoco lo detectó.

## Solución posible
Agregar la opción que falta a `MODES` en `src/ui/features/settings/MindSection.tsx`, con un texto en la línea de los
demás y de `MODE_INFO.chat`:

```ts
{ value: 'chat', label: 'Chat', description: 'Como Claude Code: la mente responde y hace los cambios en la carpeta ella misma, sin crear tareas ni usar la flota.' },
```

### Otras opciones
La propuesta no es la única, y puede haber una más optimizada:
- Tipar la tabla como `Record<MindMode, { label; description }>` y recorrer `mindModeSchema.options` (como ya hace
  `EFFORTS` con `effortSchema.options` en `MindSection.tsx:13`). Así, un modo nuevo que falte en la tabla rompe la
  compilación, en vez de desaparecer en silencio de Ajustes.
- Reusar `MODE_INFO` de `src/ui/features/chat/format.ts` (`label` y `hint`) para que la ficha del chat y Ajustes no
  tengan dos textos distintos para el mismo modo. El detalle de `MODES` es más largo que el `hint`, así que habría que
  decidir si basta con uno o se suma un campo `description` a `MODE_INFO`.
- Ordenar las opciones como `MIND_MODE_CYCLE` (auto, plan, bypass, chat) para que coincidan con el orden de Shift+Tab,
  o dejar el orden actual con «Chat» al final.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: en `tests/ui/settings/settings.test.tsx`, un caso nuevo (o una extensión de
  «el esfuerzo y el modo inicial se guardan»):
  - el grupo `radiogroup` «Modo inicial» tiene una opción por cada valor de `mindModeSchema.options` (4), y entre ellas
    `radio` «Chat»;
  - al pulsar «Chat», `useApp.getState().settings.defaultMode` pasa a `'chat'` y el único `PATCH /settings` lleva
    `{ defaultMode: 'chat' }`;
  - con ajustes iniciales `defaultMode: 'chat'`, el radio «Chat» tiene `aria-checked="true"` y los demás `"false"`.
- Comando (WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/settings/settings.test.tsx"`;
  PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/settings/settings.test.tsx`.
- Verificación manual en la app:
  1. En `#/ajustes/mente`, la tarjeta «Modo inicial de los chats» muestra «Chat».
  2. Al elegirlo, en la pestaña de red `PATCH /settings` envía `{ "defaultMode": "chat" }` y la opción queda marcada
     al recargar.
  3. Abrir un chat nuevo, con proyecto y sin proyecto: la ficha de modo (`data-testid="mode-chip"`) sale en «Chat»
     (`data-mode="chat"`).
