# Las skills en cuarentena desaparecen de Ajustes › Skills al cambiar de sección o recargar, y ya no se pueden aprobar ni rechazar

- **Área:** Interfaz
- **Severidad:** media
- **Archivos:** `src/ui/features/settings/SkillsSection.tsx:41-42`, `src/ui/features/settings/SkillsSection.tsx:65`, `src/ui/features/settings/SkillsSection.tsx:103`, `src/ui/features/settings/SettingsView.tsx:29-42`, `src/core/server/app.ts:30-35`, `src/core/server/app.ts:674-703`, `src/core/skills/hub.ts:437-457`
- **Estado:** abierta
- **Origen:** revisión de agy, verificada por Claude

## Cómo ocurre
Ajustes › Skills (`#/ajustes/skills`) muestra la tarjeta «En cuarentena» solo con lo que la propia
pantalla importó mientras estaba abierta. La lista vive en un `useState` local:

```tsx
// src/ui/features/settings/SkillsSection.tsx:41-42
// La cuarentena solo se conoce por la respuesta de importar (no hay ruta que la liste).
const [pending, setPending] = useState<Quarantined[]>([]);
```

y solo se llena con la respuesta de `POST /skills/import` (`SkillsSection.tsx:65`:
`setPending((p) => [r.result, ...p.filter((q) => q.id !== r.result.id)]);`). Al montar, el componente
solo pide `GET /skills` (`SkillsSection.tsx:45-55`), que lista las instaladas. La tarjeta se dibuja
solo si `pending.length > 0` (`SkillsSection.tsx:103`).

`SettingsView` monta una sola sección a la vez (`SettingsView.tsx:29-42`, un `switch` que devuelve
`<SkillsSection />` solo para `'skills'`), así que basta con cambiar de sección dentro de Ajustes para
desmontarla y perder `pending`.

Pasos:
1. Ir a Ajustes › Skills e importar una carpeta o un `.zip` válido. Aparece «En cuarentena» con
   «Aprobar» y «Rechazar».
2. Pasar a Ajustes › Memoria (u otra vista: Chat, Tablero) o recargar la ventana.
3. Volver a Ajustes › Skills: la tarjeta «En cuarentena» ya no está y la skill tampoco figura en
   «Instaladas».

La skill no se pierde en disco: sigue en `<hub>/skills-entrantes/<nombre>-<marca>/` con su informe
`<id>.revision.json` (`hub.ts:211`, `hub.ts:367-369`, `hub.ts:398`). Pero desde la interfaz ya no hay
forma de aprobarla ni de rechazarla.

## Por qué pasa
El núcleo sabe listar la cuarentena: `SkillHub.quarantine()` lee los informes de `quarantineDir`
(`src/core/skills/hub.ts:437-457`), y `approve`/`reject` la usan a través de `getReview`
(`hub.ts:460-468`). Pero esa lectura no llega a la API:

- La interfaz `SkillsService` que inyecta el servidor solo expone `list`, `importSkill`, `approve` y
  `reject` (`src/core/server/app.ts:30-35`).
- Las rutas de skills son `GET /skills`, `POST /skills/import`, `POST /skills/:name/approve` y
  `POST /skills/:name/reject` (`app.ts:679-703`). Ninguna devuelve lo que está en cuarentena, y
  `list()` recorre solo las raíces instaladas (`hub.ts:209`, `hub.ts:222-250`), no `skills-entrantes`.

Por eso la interfaz guarda la cuarentena en memoria del componente, que se pierde al desmontarlo.

Consecuencias:
- No se puede rechazar desde la interfaz una skill importada en una visita anterior, así que su copia
  y su informe se quedan en `skills-entrantes` sin límite de tiempo.
- La única salida es volver a importar. Como el id lleva fecha, hora y bytes al azar (`hub.ts:271-274`,
  `hub.ts:367`), cada reimportación crea una entrada nueva y la anterior queda huérfana en disco.
- El texto de la sección promete otra cosa: «Skills instaladas y en cuarentena.»
  (`SettingsView.tsx:24`).

(agy propuso la severidad «alta» y dijo que la skill queda «atrapada». No se pierde nada ni se
ejecuta nada, y reimportar sirve de salida, así que la dejo en «media».)

## Solución posible
Dejar que el núcleo sea la fuente de la cuarentena y que la interfaz la cargue al montar:

1. Añadir `quarantine(): Promise<unknown>` a `SkillsService` (`app.ts:30-35`). `SkillHub` ya lo
   implementa (`hub.ts:438`), y `compose.ts:157` inyecta esa misma instancia.
2. Registrar `GET /skills/quarantine` en `app.ts`, junto a las demás rutas de skills (no choca con
   `POST /skills/:name/...`), con la misma forma `{ result: [...] }` o `{ skills: [...] }` y el mismo
   tachado que las demás respuestas. Conviene no mandar `path` absoluto si la interfaz no lo usa.
3. En `SkillsSection.tsx`, cargar `pending` desde esa ruta en el `useEffect` de montaje (junto a
   `load()`) y volver a pedirla después de importar, aprobar o rechazar, en vez de editar el arreglo a
   mano. Quitar el comentario de la línea 41.

### Otras opciones
Hay otras salidas, y puede haber una más optimizada que esta:
- Incluir la cuarentena en la propia respuesta de `GET /skills` (por ejemplo,
  `{ skills, quarantine }`). Ahorra una petición pero mezcla dos conceptos en una ruta.
- Guardar `pending` en el store global (`useApp`). Sobrevive a cambiar de sección pero no a una
  recarga ni a un reinicio de Berland, y no ve lo importado por otra vía (CLI, mente). Sirve solo como
  parche.
- Guardarla en `localStorage`. Mismo problema: la verdad está en disco y puede desincronizarse (por
  ejemplo, si alguien borra `skills-entrantes` a mano).
- Además, Ajustes › Almacenamiento podría contar `skills-entrantes` y ofrecer vaciar la cuarentena
  vieja.

## Cómo probar que quedó resuelta
- Prueba automatizada propuesta:
  - `tests/core/server/routes.test.ts`, en «rutas: skills, memoria y WebSocket en proceso»: con el hub
    falso de `tests/core/server/helpers.ts` ampliado con `quarantine()`, `GET /skills/quarantine`
    responde 200 con las entradas y 501 si no hay servicios (`makeTestApp({ withServices: false })`).
  - `tests/core/skills/hub.test.ts`: después de `importSkill`, `quarantine()` devuelve la entrada, y
    tras `reject` ya no la incluye (en buena parte ya cubierto; revisar).
  - Nueva `tests/ui/settings/skills.test.tsx` con `fakeCore` de `tests/ui/settings/helpers.ts`:
    `GET /skills/quarantine` devuelve una skill. Al montar `<SkillsSection />` (sin importar nada)
    aparece «En cuarentena» con su nombre y los botones «Aprobar» y «Rechazar». Al desmontar y volver
    a montar sigue ahí. Tras pulsar «Rechazar» se llama a `POST /skills/<id>/reject` y la entrada
    desaparece.
- Comando (WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/ui/settings/skills.test.tsx tests/core/server/routes.test.ts"`; PowerShell en C:\dev\orquestador: `npx vitest run tests/ui/settings/skills.test.tsx tests/core/server/routes.test.ts`.
- Verificación manual en la app:
  1. Importar una skill en Ajustes › Skills.
  2. Ir a Ajustes › Memoria, volver y comprobar que sigue en «En cuarentena».
  3. Recargar la ventana (y reiniciar Berland) y comprobar lo mismo.
  4. Rechazarla y confirmar que su carpeta y su `.revision.json` desaparecen de
     `C:\dev\agent-hub\skills-entrantes`.
