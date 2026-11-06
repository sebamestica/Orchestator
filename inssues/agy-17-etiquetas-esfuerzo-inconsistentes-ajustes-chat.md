# El mismo nivel de esfuerzo tiene dos nombres: «Medio» en Ajustes › Mente y «Equilibrado» en la barra del chat

- **Área:** Interfaz
- **Severidad:** baja
- **Archivos:** `src/ui/features/settings/MindSection.tsx:12-13`, `src/ui/features/settings/MindSection.tsx:132-133`, `src/ui/components/EffortSlider.tsx:15-21`, `src/ui/components/EffortSlider.tsx:108-119`, `src/ui/features/chat/ChatView.tsx:96-98`
- **Estado:** abierta
- **Origen:** revisión de agy, verificada por Claude

## Cómo ocurre
El esfuerzo de razonamiento se elige en dos sitios y cada uno trae su propia tabla de nombres para los mismos valores
de `effortSchema`.

Ajustes › Mente (`MindSection.tsx:12-13`) arma el control segmentado «Esfuerzo» con esta tabla local:

```ts
const EFFORT_LABEL: Record<Effort, string> = { low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo' };
const EFFORTS = effortSchema.options.map((value) => ({ value, label: EFFORT_LABEL[value] }));
```

y la usa en `MindSection.tsx:132-133` (`<Segmented label="Esfuerzo" value={settings.mind.effort} options={EFFORTS} …/>`).

La barra del composer usa `EffortSlider`, que exporta otra tabla (`EffortSlider.tsx:15-21`):

```ts
export const EFFORT_LABELS = { low: 'Rápido', medium: 'Equilibrado', high: 'Profundo', xhigh: 'Muy profundo', max: 'Máximo' };
```

y la muestra en el botón «Esfuerzo: <nivel>» y en la cabecera del panel (`EffortSlider.tsx:108`, `:119`, `:131`).

Las dos tablas tratan el mismo valor guardado. Si el chat no tiene una elección propia, el botón del composer enseña el
esfuerzo de Ajustes (`ChatView.tsx:96-98`: «Sin elección en este chat, el esfuerzo de la mente de Ajustes.»
`const effort: Effort = chosen ?? settings.mind.effort;`). Pasos:

1. Ir a `#/ajustes/mente`. En «Esfuerzo» aparecen «Bajo», «Medio», «Alto», «Muy alto» y «Máximo».
2. Elegir «Medio» (o dejarlo, si ya es el valor guardado).
3. Abrir un chat nuevo o uno en el que nunca se haya tocado el esfuerzo.
4. El botón de la barra dice «Esfuerzo: Equilibrado». Al abrirlo, la cabecera del panel también dice «Equilibrado»,
   con la frase de `EFFORT_HINTS` (`EffortSlider.tsx:23-29`).

Cuatro de los cinco niveles cambian de nombre (`low`, `medium`, `high`, `xhigh`) y solo «Máximo» coincide. Nada indica
que «Medio» y «Equilibrado» son lo mismo, así que parece que el chat ignora lo que se configuró en Ajustes.

Corrección a lo que reportó agy: el panel del deslizador no lista las cinco etiquetas. Solo muestra el nombre del nivel
actual (`EffortSlider.tsx:131`), el deslizador sin marcas con nombre y la frase de ayuda (`EffortSlider.tsx:180`). La
discrepancia se ve al recorrer los niveles o al comparar con Ajustes.

## Por qué pasa
El issue 10 (modo chat) dejó el `EffortSlider` de agy «tal cual» (`docs/plan/issues/10-modo-chat-ui.md:46-51`). Se
igualaron los niveles que ofrecen las dos vistas (los 5 de `effortSchema.options`, «como en Ajustes»), pero no sus
nombres. `MindSection` ya tenía su `EFFORT_LABEL` privado y nunca importa `EFFORT_LABELS`, que el componente exporta
justo para esto. No hay una única fuente de nombres para `Effort`.

## Solución posible
Que Ajustes use la tabla del componente compartido. En `MindSection.tsx`, borrar el `EFFORT_LABEL` local e importar
`EFFORT_LABELS` desde `../../components/EffortSlider.tsx`:

```ts
const EFFORTS = effortSchema.options.map((value) => ({ value, label: EFFORT_LABELS[value] }));
```

El cambio es de una línea, deja una sola tabla y conserva la terminología que ya fijan las pruebas del composer y del
deslizador (`tests/ui/components/effort-slider.test.tsx`, `tests/ui/composer/Composer.test.tsx:282`,
`tests/ui/chat/effort.test.tsx`). La prueba de Ajustes que existe hoy solo pulsa «Máximo»
(`tests/ui/settings/settings.test.tsx:56`), que es igual en las dos tablas, así que sigue pasando.

### Otras opciones
Esta propuesta no es la única y puede haber una más optimizada:
- Llevar los nombres a un módulo neutro (por ejemplo `src/ui/lib/effort.ts`, o junto a `effortSchema` en `src/shared`
  si el núcleo o el CLI llegan a necesitarlos), con nombres y frases de ayuda juntos, y que `EffortSlider` y
  `MindSection` lo importen. Así Ajustes no depende de un componente visual.
- Quedarse con la escala neutra de Ajustes («Bajo/Medio/Alto…») y cambiar `EFFORT_LABELS`. Es igual de coherente,
  pero hay que tocar las pruebas del deslizador, del composer y del chat que buscan «Rápido» o «Equilibrado».
- Además de unificar los nombres, mostrar en Ajustes la frase de `EFFORT_HINTS` del nivel elegido en lugar del texto
  fijo «Más esfuerzo piensa más y gasta más.» (`MindSection.tsx:132`), para que las dos vistas expliquen cada nivel
  igual.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta: en `tests/ui/settings/settings.test.tsx`, un caso «Ajustes › Mente nombra el esfuerzo
  como la barra del chat». Renderiza `<SettingsView section="mente" />` con `fakeCore` como el caso «el esfuerzo y el
  modo inicial se guardan» (líneas 52-60). Comprueba que los radios del `radiogroup` «Esfuerzo» se llaman, en orden,
  `effortSchema.options.map((e) => EFFORT_LABELS[e])`, y que el marcado coincide con `EFFORT_LABELS[settings.mind.effort]`.
  Si el núcleo devuelve `medium`, afirma que existe el radio «Equilibrado» y que no existe «Medio».
- Comando (WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/settings/settings.test.tsx tests/ui/components/effort-slider.test.tsx tests/ui/composer/Composer.test.tsx tests/ui/chat/effort.test.tsx"`; PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/settings/settings.test.tsx tests/ui/components/effort-slider.test.tsx tests/ui/composer/Composer.test.tsx tests/ui/chat/effort.test.tsx`.
- Verificación manual en la app: en `#/ajustes/mente`, pasar por cada nivel de «Esfuerzo». Después de cada cambio, abrir
  un chat sin esfuerzo propio y comprobar que el botón «Esfuerzo: …» y la cabecera del panel usan el mismo nombre que
  Ajustes.
