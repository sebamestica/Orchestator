# La memoria puede registrar una sesión a medias: si falla Contexto.md o la nota del agente, la bitácora y los totales pierden esa sesión y nada la repara

- **Área:** Datos y almacenamiento
- **Severidad:** baja
- **Archivos:** `src/core/memory/obsidian-memory.ts:262`, `src/core/memory/obsidian-memory.ts:308-321`, `src/core/memory/obsidian-memory.ts:325-334`, `src/core/memory/safe-fs.ts:81-111`, `src/core/orchestrator/fleet.ts:353`, `src/core/orchestrator/fleet.ts:745-749`
- **Estado:** resuelta

## Cómo ocurre

Contexto: al terminar una tarea, la flota llama una sola vez a `#recordSessions` (`fleet.ts:353`), que por cada turno de autor llama a `ObsidianMemory.recordSession`. Ese método escribe tres cosas en la bóveda de Obsidian, todas bajo el candado de la bóveda:

1. la nota de la sesión en `Orquestador/Sesiones/<fecha>-<tarea>.md`;
2. una línea en la bitácora de `Proyectos/<proyecto>/Contexto.md`, más el contador `sesiones`;
3. los totales de tokens y costo, más una línea de historial, en `Agentes/<agente>.md`.

El método dice ser idempotente (`obsidian-memory.ts:262`: «Idempotente para la misma sesión (tarea, agente y hora)») y que no deja nada a medias (`obsidian-memory.ts:312`). Ninguna de las dos cosas se cumple cuando falla una escritura:

```ts
// obsidian-memory.ts:312-318
// Se preparan las tres notas antes de escribir: si algo falla, no queda la sesión a medias.
const projectText = await this.projectWithLog(...);
const agentText = await this.agentWithTotals(...);
if (!(await createFileExclusive(this.vaultPath, this.abs(note), stringifyNote(data, body)))) continue;
await this.writeNote(this.projectNote(s.projectId), projectText);
await this.writeNote(this.agentNote(s.agentId), agentText);
```

Preparar los textos antes evita que un fallo de lectura deje algo escrito, pero no protege contra un fallo de escritura. Las tres escrituras van una tras otra sin ningún deshacer.

Pasos:

1. La flota termina un turno y llama a `recordSession`.
2. `createFileExclusive` crea la nota de sesión (línea 316).
3. `writeNote(Contexto.md)` (línea 317) falla. `writeFileAtomic` escribe un temporal y lo renombra sobre `Contexto.md` (`safe-fs.ts:105-106`). Ese `rename` falla si `Contexto.md` tiene el atributo de solo lectura, si OneDrive (la bóveda puede estar en OneDrive, ver `obsidian-memory.ts:24`) u otro proceso lo retiene más de lo que aguanta `renameWithRetry` (9 intentos, unos 1,3 s, `safe-fs.ts:77-92`), o si el disco está lleno.
4. La excepción sale antes de la línea 318, así que la nota del agente tampoco se actualiza. Lo mismo pasa a la inversa: si `Contexto.md` se escribe y falla la nota del agente, la bitácora cuenta la sesión y los totales no.
5. La flota solo deja un aviso y sigue (`fleet.ts:745-749`). No hay ningún reintento, y `recordSessions` no se vuelve a llamar con esa sesión: al reactivar una tarea, `#runTask` arma `attempts` nuevos con otra hora.
6. Aunque se agregara un reintento, no repararía nada. `freeSessionNote` encuentra la nota con la misma tarea, agente y hora y devuelve `null` (`obsidian-memory.ts:332`), y `recordSession` termina en `if (note === null) return; // ya registrada` (línea 310) sin mirar si la bitácora o la nota del agente tienen esa sesión.

Efecto: la nota de sesión existe, y por eso `buildContext` la sigue usando (lee `Sesiones/`, `obsidian-memory.ts:495-537`). Lo que se pierde para siempre es la línea de la bitácora y el contador `sesiones` de `Contexto.md`, y los tokens, el costo y la línea de historial de `Agentes/<agente>.md`. Los totales del agente quedan por debajo de lo real y no hay nada que lo avise. Ninguna prueba cubre una escritura que falle a mitad de camino: `tests/core/memory/obsidian-memory.test.ts:156` solo prueba la idempotencia cuando todo sale bien.

## Por qué pasa

- Las tres notas se escriben en secuencia y sin compensación. El comentario de la línea 312 confunde «preparar los textos antes» con atomicidad.
- La única marca de idempotencia es la nota de sesión, que además se escribe primero. `freeSessionNote` (`obsidian-memory.ts:325-334`) no comprueba las otras dos notas, así que una sesión a medias se toma por completa.
- Del lado de la flota, el fallo se reduce a un aviso y no hay reintento (`fleet.ts:745-749`).

## Solución posible

Hacer que cada una de las tres escrituras sea idempotente por su cuenta, usando el enlace de la sesión como clave, y reintentar desde la flota:

1. `src/core/memory/obsidian-memory.ts`:
   - `freeSessionNote` devuelve `{ note, existing: boolean }` en vez de `string | null`. Cuando encuentra la misma sesión, devuelve esa ruta con `existing: true`.
   - En `recordSession`, si `existing` es true, no se sale. Se calcula `sessionLink` con esa ruta, se lee `Contexto.md` y se agrega la línea (y se suma `sesiones`) solo si su `## Bitácora` no contiene `sessionLink`. Con la nota del agente se hace lo mismo: los totales se suman solo si `## Sesiones` no contiene `sessionLink`. Si las dos ya lo tienen, no se escribe nada y la idempotencia de hoy se mantiene.
   - `projectWithLog` y `agentWithTotals` reciben `sessionLink` y devuelven `null` cuando la línea ya está, para no escribir de más.
   - Se corrige el comentario de la línea 312.
2. `src/core/orchestrator/fleet.ts` (`#recordSessions`, línea 745): si `recordSession` falla, se reintenta pocas veces con esperas cortas (por ejemplo 3 intentos a 1 s y 3 s) antes de dejar el aviso. Con el punto 1, un reintento completa lo que falte y no duplica nada.

Las dos escrituras de abajo siguen protegidas por el candado de la bóveda, que cubre la lectura y la escritura completas (`obsidian-memory.ts:230-243`).

### Otras opciones

- **Cambiar el orden** (escribir `Contexto.md` y la nota del agente primero y la nota de sesión al final), como se propuso al principio. Por sí solo no basta. Si `Contexto.md` se escribe y falla la nota del agente, no queda ninguna marca, y un reintento duplicaría la línea de la bitácora y el contador. Solo funciona junto con la comprobación por enlace de arriba.
- **Deshacer al fallar**: dentro del candado ya se tiene el texto anterior de `Contexto.md` (el que leyó `projectWithLog`). Si falla la línea 317 o la 318, se restaura `Contexto.md` y se borra la nota de sesión creada. Así el comentario de la línea 312 sería cierto, pero el deshacer también puede fallar por la misma causa (archivo retenido o disco lleno), y sin reintento la sesión se pierde completa, nota incluida. Es peor que dejarla a medias.
- **Marca `registro: parcial`** en el frontmatter de la nota de sesión, quitada al final. El siguiente `recordSession` del mismo proyecto completaría las sesiones parciales. Repara aunque la flota no reintente, pero agrega estado y obliga a recorrer `Sesiones/` en cada registro.
- Puede haber una solución más eficiente. Por ejemplo, sacar los totales del agente de la nota y calcularlos al leer, sumando las notas de `Sesiones/`. Eso deja la nota de sesión como única fuente de verdad y elimina el problema de raíz, pero cambia el formato de `Agentes/<agente>.md` que el usuario ve en Obsidian. La propuesta de arriba no es la única salida válida.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta: `tests/core/memory/obsidian-memory-registro-parcial.test.ts`.
  - Bóveda temporal con `mkdtemp`, igual que en `tests/core/memory/obsidian-memory.test.ts`.
  - Para que el fallo sea igual en Windows y en Linux, usar `vi.mock('../../../src/core/memory/safe-fs.ts', …)`: se conserva el módulo real, pero `writeFileAtomic` lanza un error `EPERM` cuando un indicador está activo y el destino termina en `Contexto.md`. (Con `fs.chmod(p, 0o444)` también falla en Windows, porque `rename` sobre un archivo de solo lectura da EPERM, pero en Linux no.)
  - Escenario A: se activa el fallo y se llama `recordSession(s)`, que debe rechazar. Se comprueba que existe la nota de sesión y que `Agentes/<agente>.md` no tiene los tokens. Luego se desactiva el fallo y se llama otra vez `recordSession(s)` con el mismo input. Se afirma que `Contexto.md` tiene `sesiones: 1` y exactamente una línea de bitácora con el enlace a la nota, que `Agentes/<agente>.md` tiene `sesiones: 1`, `tokens_entrada === s.inputTokens` y una sola línea en `## Sesiones`, y que `Sesiones/` tiene un solo archivo. Hoy esta prueba falla: la bitácora y el agente quedan vacíos.
  - Escenario B: el fallo se activa solo para `Agentes/<agente>.md`. Se reintenta y se afirma que `Contexto.md` sigue con una sola línea y `sesiones: 1` (sin duplicar) y que el agente quedó con los totales.
  - Escenario C (no empeorar): tres llamadas seguidas con el mismo input sin fallos dejan una sola línea en cada nota y totales simples, como la prueba de `obsidian-memory.test.ts:156`.
  - En la flota (opcional): con una memoria falsa cuyo `recordSession` falla la primera vez, se afirma que `#recordSessions` la llama de nuevo y que no queda el aviso «no se pudo guardar la sesión».
- Comando (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/memory/obsidian-memory-registro-parcial.test.ts"` (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/memory/obsidian-memory-registro-parcial.test.ts`).
- Verificación manual: en una bóveda de prueba, marcar `Proyectos/<proyecto>/Contexto.md` como solo lectura (Propiedades → Solo lectura) y lanzar una tarea corta. La app muestra el aviso «no se pudo guardar la sesión» y aparece la nota en `Sesiones/`. Con el arreglo, si se quita el atributo antes de que se agoten los reintentos de la flota, la bitácora de `Contexto.md` y `Agentes/<agente>.md` muestran la sesión, con un solo enlace a la nota en cada una.
