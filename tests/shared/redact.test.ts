import { describe, expect, it } from 'vitest';
import { REDACTED, redactSecrets } from '../../src/shared/index.ts';

// autoeval-navegador-05: `get_network_request` devuelve la cabecera `cookie` real (con las HttpOnly) y `set-cookie`.
describe('redactSecrets: cookies de sesión en encabezados', () => {
  it('tacha el valor de `cookie` como lo formatea chrome-devtools-mcp (`- cookie:…`)', () => {
    const out = redactSecrets('- cookie:SID=abc123def456; HSID=zzz999yyy888');
    expect(out).not.toContain('abc123def456');
    expect(out).not.toContain('zzz999yyy888');
    expect(out).toContain(REDACTED);
  });

  it('tacha `Set-Cookie:` de una respuesta y el `"cookie"` de un JSON', () => {
    const header = redactSecrets('Set-Cookie: sesion=valor-largo-de-prueba; HttpOnly');
    expect(header).not.toContain('valor-largo-de-prueba');
    expect(header).toContain(REDACTED);
    const json = redactSecrets('{"cookie": "a=b1234567890", "accept": "text/html"}');
    expect(json).not.toContain('b1234567890');
    expect(json).toContain('"accept": "text/html"');
  });

  it('como encabezado sigue tras una comilla del valor (`personalization_id="v1_x"` es una cookie válida)', () => {
    const out = redactSecrets('- cookie:guest_id=v1; personalization_id="v1_x"; auth_token=SECRETO123abc');
    expect(out).toBe(`- cookie:${REDACTED}`);
  });

  it('corta en el fin de línea: el resto de la salida queda', () => {
    const out = redactSecrets('- cookie:SID=abc123def456\n- accept:text/html');
    expect(out).toBe(`- cookie:${REDACTED}\n- accept:text/html`);
  });

  it('no tacha la palabra en una frase ni el `<redacted>` del propio MCP', () => {
    for (const text of ['Borra las cookies del sitio y vuelve a entrar.', 'La cookie de sesión venció.', '- cookie:<redacted>']) {
      expect(redactSecrets(text)).toBe(text);
    }
  });
});

describe('redactSecrets: cookies sin costo cuadrático', () => {
  // Sin el tope del nombre, `'cookie:'.repeat(n)` recorre el resto del texto desde cada `cookie:` (O(n²)).
  it('un token largo sin `=` o `cookie:` repetido no lo frenan', () => {
    const t0 = performance.now();
    redactSecrets(`cookie: ${'a'.repeat(200_000)}`);
    redactSecrets('cookie:'.repeat(30_000));
    redactSecrets('set-cookie:'.repeat(20_000));
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
