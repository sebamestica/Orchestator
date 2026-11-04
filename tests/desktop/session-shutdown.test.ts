import { describe, expect, it } from 'vitest';
import { decodeSession, encodeSession, SESSION_KIND, type Cipher } from '../../apps/desktop/src/lib/session-file.ts';
import { decideOnClose } from '../../apps/desktop/src/lib/shutdown-policy.ts';

const TOKEN = 'k7Qp2vX9zL0aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV';
const SESSION = { port: 47811, pid: 43210, token: TOKEN, startedAt: '2026-11-04T13:00:00.000Z' };

/** Cifrador falso: XOR con una clave y un prefijo, como safeStorage pero sin DPAPI. */
function fakeCipher(key = 0x5a): Cipher & { calls: number } {
  const c = {
    calls: 0,
    encrypt(plain: string) {
      c.calls++;
      return Buffer.concat([Buffer.from('v10'), Buffer.from(Buffer.from(plain, 'utf8').map((b) => b ^ key))]);
    },
    decrypt(data: Buffer) {
      if (data.subarray(0, 3).toString() !== 'v10') throw new Error('no es de este cifrador');
      return Buffer.from(data.subarray(3).map((b) => b ^ key)).toString('utf8');
    },
  };
  return c;
}

describe('archivo de sesión', () => {
  it('no deja el token en claro (ni en base64, base64url o hex) ni el pid', () => {
    const cipher = fakeCipher();
    const text = encodeSession(SESSION, cipher);
    expect(cipher.calls).toBe(1);
    for (const form of [TOKEN, Buffer.from(TOKEN).toString('base64'), Buffer.from(TOKEN).toString('base64url'), Buffer.from(TOKEN).toString('hex')]) {
      expect(text).not.toContain(form);
    }
    expect(text).not.toContain(TOKEN.slice(0, 12));
    const file = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(file).sort()).toEqual(['cipher', 'kind', 'launchedBy', 'port', 'secret', 'startedAt', 'v']);
    expect(file).toMatchObject({ v: 1, kind: SESSION_KIND, launchedBy: 'desktop', port: 47811, cipher: 'safeStorage' });
    expect(text).not.toContain('43210');
  });

  it('se lee de vuelta con el mismo cifrador', () => {
    const cipher = fakeCipher();
    expect(decodeSession(encodeSession(SESSION, cipher), cipher)).toEqual(SESSION);
  });

  it('con otro cifrador (otro usuario u otro perfil) no se puede leer', () => {
    expect(decodeSession(encodeSession(SESSION, fakeCipher(0x5a)), fakeCipher(0x33))).toBeNull();
  });

  it('descarta archivos alterados: secreto cambiado, puerto en claro distinto, campos de más o JSON roto', () => {
    const cipher = fakeCipher();
    const file = JSON.parse(encodeSession(SESSION, cipher)) as Record<string, unknown>;
    const other = JSON.parse(encodeSession({ ...SESSION, port: 47899 }, cipher)) as Record<string, unknown>;
    expect(decodeSession(JSON.stringify({ ...file, port: 47899 }), cipher)).toBeNull();
    expect(decodeSession(JSON.stringify({ ...file, secret: other.secret }), cipher)).toBeNull();
    expect(decodeSession(JSON.stringify({ ...file, token: TOKEN }), cipher)).toBeNull();
    expect(decodeSession(JSON.stringify({ ...file, secret: Buffer.from('v10basura').toString('base64') }), cipher)).toBeNull();
    expect(decodeSession(JSON.stringify({ ...file, v: 2 }), cipher)).toBeNull();
    expect(decodeSession('{"v":1', cipher)).toBeNull();
    expect(decodeSession('', cipher)).toBeNull();
  });

  it('un descifrado que falla da null, no una excepción', () => {
    const text = encodeSession(SESSION, fakeCipher());
    const broken: Cipher = {
      encrypt: () => Buffer.alloc(0),
      decrypt: () => {
        throw new Error('DPAPI: clave no disponible');
      },
    };
    expect(decodeSession(text, broken)).toBeNull();
  });
});

describe('decideOnClose', () => {
  it('apaga el núcleo de Berland sin tareas en curso', () => {
    expect(decideOnClose('launched', { status: 'ok', running: 0 })).toMatchObject({ stop: true });
    expect(decideOnClose('adopted', { status: 'ok', running: 0 })).toMatchObject({ stop: true });
  });

  it('lo deja vivo con tareas en curso', () => {
    expect(decideOnClose('launched', { status: 'ok', running: 1 })).toEqual({ stop: false, reason: '1 tarea en curso: el núcleo sigue vivo' });
    expect(decideOnClose('adopted', { status: 'ok', running: 3 })).toEqual({ stop: false, reason: '3 tareas en curso: el núcleo sigue vivo' });
  });

  it('ante la duda (sin respuesta o token rechazado) no lo apaga', () => {
    expect(decideOnClose('launched', { status: 'error' }).stop).toBe(false);
    expect(decideOnClose('launched', { status: 'unauthorized' }).stop).toBe(false);
    expect(decideOnClose('launched', null).stop).toBe(false);
  });

  it('nunca apaga un núcleo ajeno ni hace nada sin núcleo', () => {
    expect(decideOnClose('external', { status: 'ok', running: 0 }).stop).toBe(false);
    expect(decideOnClose(null, null).stop).toBe(false);
  });
});
