# La bóveda de claves se reescribe sin flush, sin reintento ante EPERM y sin respaldo: un corte la deja ilegible y ya no deja ni volver a guardar claves

- **Área:** Datos y almacenamiento
- **Severidad:** media
- **Archivos:** `src/core/vault/vault.ts:154`, `src/core/vault/vault.ts:158`, `src/core/vault/vault.ts:159`, `src/core/vault/vault.ts:162`, `src/core/vault/vault.ts:135`, `src/core/vault/vault.ts:143`, `src/core/vault/vault.ts:150`, `src/core/vault/vault.ts:78`, `src/core/vault/vault.ts:79`, `src/core/memory/safe-fs.ts:77`, `src/core/memory/safe-fs.ts:81`, `src/core/memory/safe-fs.ts:105`, `src/core/plugins/canva.ts:229`, `src/core/plugins/canva.ts:240`, `src/core/plugins/canva.ts:272`, `src/core/registry/registry.ts:237`
- **Estado:** resuelta

## Cómo ocurre

Contexto. En Windows el núcleo usa `FileVault` (`src/core/main.ts:66-68`), que guarda todas las claves cifradas con
DPAPI en un único archivo, `%LOCALAPPDATA%\orquestador\vault.json`. Ahí están las claves de API de los agentes
(`registry.ts:237`) y la sesión OAuth de Canva (`canva.ts:272`). El blob DPAPI no se guarda en ningún otro sitio.
Cada `set` y cada `delete` reescriben el archivo completo con un temporal y un `rename`:

```ts
// vault.ts:157-163
try {
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, this.opts.path);
} catch (err) {
  await rm(tmp, { force: true });
  throw new VaultError(`No se pudo escribir la bóveda (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
}
```

La escritura falla de dos maneras.

**(a) EPERM/EBUSY en el `rename`, sin reintento.** En Windows, `rename` sobre un destino (o desde un origen) que
otro proceso tiene abierto sin `FILE_SHARE_DELETE` falla con EPERM. El propio repo documenta que esto lo provoca el
antivirus y por eso creó `renameWithRetry`:

```ts
// safe-fs.ts:77-80
 * `rename` con reintentos: en Windows el antivirus (u Obsidian) abre un instante el archivo recién escrito
 * y `rename` sobre él falla con EPERM. Esperas cortas y crecientes: 5, 10, 20… ms (≈ 1,3 s en total).
```

La memoria (`safe-fs.ts:106`) y las skills (`skills/tree.ts:253`, `skills/hub.ts:370`, `hub.ts:520`) usan
`renameWithRetry`. La bóveda no lo usa: `vault.ts:2` importa `rename` directamente y `vault.ts:159` lo llama una sola
vez. Pasos: se guardan dos secretos seguidos, por ejemplo al crear un agente y enseguida conectar Canva, o al refrescar
el token de Canva justo después de otro `set`. Defender (o el indexador) abre `vault.json` o el `.tmp` recién cerrado
para analizarlo, el `rename` cae con EPERM y `set` responde «No se pudo escribir la bóveda (EPERM)» sin reintentar.
Qué pasa en cada caso:
- Al crear un agente se revierte todo (`registry.ts:236-241`) y el usuario tiene que repetir el alta.
- Al refrescar Canva (`canva.ts:229`, a través de `#save`), el `VaultError` no es `OAuthError`, así que cae en la rama
  «Fallo pasajero» (`canva.ts:240-243`). Sigue con el `stored` viejo y vuelve a programar el refresco con el refresh
  token anterior. Si el servidor rota los refresh tokens, el token nuevo se pierde y el siguiente refresco termina en
  `invalid_grant`, que borra la sesión (`canva.ts:233-238`).

**(b) Corte de energía o cuelgue poco después de un `set`.** `writeFile` (`vault.ts:158`) no pasa `flush: true`, así
que no se hace fsync del temporal antes del `rename`. NTFS registra en su diario el cambio de nombre (metadatos), pero
los datos del temporal pueden seguir en la caché. Tras el reinicio `vault.json` puede aparecer con su tamaño y lleno
de bytes NUL (el caso conocido de `settings.json` en VS Code). Desde ese momento `read()` falla en todas las
operaciones:

```ts
// vault.ts:143-150
try {
  data = JSON.parse(raw);
} catch {
  throw new VaultError('La bóveda está dañada (JSON inválido)');
}
const parsed = fileSchema.safeParse(data);
if (!parsed.success) throw new VaultError('La bóveda está dañada (formato inválido)');
```

Esto también afecta a `set`, que lee antes de escribir (`vault.ts:78-79`: `return this.locked(async () => { const
file = await this.read(); …`). Con la bóveda dañada no se puede ni volver a introducir una clave: el usuario tiene
que encontrar y borrar `vault.json` a mano, y como no hay copia previa (`vault.json.bak` o similar) se pierden todas
las claves y la sesión de Canva. La prueba existente (`tests/core/vault/vault.test.ts:132`, «un archivo dañado da
VaultError sin repetir su contenido») confirma que este es el comportamiento esperado hoy. No hay ninguna prueba de
recuperación ni de reintento.

Ninguno de los issues de hoy (`docs/plan/issues/01…12`) toca `src/core/vault/`. El 09 habla de la «bóveda» de
Obsidian, no de la de claves.

Efecto secundario de menor peso: `writeFileAtomic` (`safe-fs.ts:105`) tampoco pasa `flush: true`, y la usan las notas
de memoria (`obsidian-memory.ts:227`) y la escritura de `hub.ts:175`. Esa ruta sí reintenta el `rename`.

## Por qué pasa

- `FileVault.write` usa `writeFile` sin `flush: true`, de modo que el `rename` puede quedar en disco antes que los
  datos, y un `rename` directo sin el reintento que `safe-fs.ts:81-92` implementa justo para el antivirus.
- No se guarda copia del archivo anterior antes de reemplazarlo.
- `read()` trata cualquier daño como fatal para todas las operaciones, también para `set`, que es la que podría
  repararlo.

## Solución posible

En `src/core/vault/vault.ts`:

1. En `write`, `await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600, flush: true })`. Node ≥ 21 hace
   `filehandle.sync()` antes de cerrar, y el proyecto exige Node 24 (`package.json`, `engines.node: "24.x"`).
2. Antes de reemplazar, si `vault.json` existe y parsea, copiarlo a `vault.json.bak` (`copyFile`, también con
   reintento) y reemplazar con `renameWithRetry(tmp, path)` importado de `../memory/safe-fs.ts`.
3. En `read()`, si `vault.json` no es JSON válido (o es solo NUL/vacío), intentar con `vault.json.bak` y registrar en
   el log «bóveda recuperada desde la copia». Si los dos fallan, que `set` aparte el archivo dañado como
   `vault.json.danada-<fecha>` (sin borrarlo), empiece una bóveda vacía y lo registre. `get` y `list` pueden seguir
   devolviendo el error claro. Ojo: un JSON válido con un `version` o `scheme` que esta versión no reconoce (archivo
   de una versión más nueva de Berland) no debe tratarse como daño ni apartarse; ahí conviene seguir fallando.

En `src/core/memory/safe-fs.ts`: añadir `flush: true` en `writeFileAtomic` (`safe-fs.ts:105`).

### Otras opciones

- Llamar a `FileHandle.sync()` de forma explícita (`open` → `write` → `sync` → `close`) en lugar de `flush: true`.
  Hace lo mismo y deja más control para medir el coste.
- Guardar los blobs DPAPI en una tabla de la base SQLite del núcleo (`node:sqlite`), que ya tiene diario y fsync,
  y dejar `vault.json` solo para migrar. Sería la solución más sólida: transacciones reales y sin carreras con el
  antivirus en el `rename`. A cambio cambia el candado entre procesos (`vault-lock.test.ts`) y obliga a migrar.
- Reutilizar `writeFileAtomic` en la bóveda. No encaja tal cual porque exige una raíz y no fija `mode`, pero se podría
  extraer un `atomicReplace(path, data, { mode, backup })` común a los dos.

Ninguna es la única válida. La propuesta de arriba es el cambio mínimo que cierra los dos caminos sin migrar datos.

## Cómo probar que quedó resuelta

- Prueba automatizada propuesta, en `tests/core/vault/vault-durability.test.ts`:
  1. *Reintento ante EPERM:* `vi.mock('node:fs/promises', …)` parcial con un `rename` que falla una o dos veces con
     `Object.assign(new Error('EPERM'), { code: 'EPERM' })` y después delega al real. Afirmar que
     `vault.set('k1', 'v')` resuelve, que `get('k1')` devuelve `'v'` y que no queda ningún `.tmp` en la carpeta.
  2. *Flush:* espiar `writeFile` y afirmar que la llamada del temporal recibe `flush: true`.
  3. *Recuperación desde la copia:* `set('k1','v1')`, `set('k2','v2')` (con eso ya hay `.bak`). Sobrescribir
     `vault.json` con `Buffer.alloc(200)` (NUL). Afirmar que `get('k1')` devuelve `'v1'` desde el `.bak`.
  4. *Daño sin copia:* escribir `vault.json` con 200 bytes NUL y sin `.bak`, y llamar a `set('x','v')`. Afirmar que
     resuelve, que existe un `vault.json.danada-*` con el contenido original y que `list()` devuelve solo `x`.
  5. *Versión desconocida:* `vault.json` con `{"version":2,…}` válido. Afirmar que `set` sigue lanzando `VaultError`
     y que el archivo no se mueve.
  Usar el `xorCipher` de `tests/core/vault/vault.test.ts`.
- Comando para correrla (desde WSL): `/mnt/c/dev/orquestador/scripts/win.sh "npx vitest run tests/core/vault/vault-durability.test.ts"`
  (o desde PowerShell en `C:\dev\orquestador`: `npx vitest run tests/core/vault/vault-durability.test.ts`). Correr
  también `tests/core/vault/vault.test.ts` y `vault-lock.test.ts` para confirmar que no cambia nada más.
- Verificación manual en Windows (con una bóveda de prueba, no la real): con un `vault.json` existente, abrirlo desde
  PowerShell sin compartir el borrado (`$f=[IO.File]::Open($p,'Open','Read','Read')`), guardar una clave desde la app
  y cerrar el handle (`$f.Close()`) antes de 1 s. Hoy falla al instante con EPERM. Con el arreglo termina en cuanto se
  cierra el handle.
