import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CoreStartError, parseReadyLine, tailLines, waitForReady } from '../../apps/desktop/src/lib/ready-line.ts';

const TOKEN = 'A'.repeat(20) + 'b_c-'.repeat(6) + 'Z9z9';
const LINE = JSON.stringify({ ready: true, url: 'http://127.0.0.1:47899', wsUrl: 'ws://127.0.0.1:47899/ws', token: TOKEN });

function source() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  return { stdout, stderr, child };
}

async function rejection(p: Promise<unknown>): Promise<CoreStartError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CoreStartError) return err;
    throw err;
  }
  throw new Error('se esperaba un error');
}

describe('parseReadyLine', () => {
  it('lee la línea ready del núcleo y admite campos de más', () => {
    const r = parseReadyLine(JSON.stringify({ ...JSON.parse(LINE), link: 'http://127.0.0.1:47899/#t=x' }));
    expect(r).toEqual({ kind: 'ready', ready: { origin: 'http://127.0.0.1:47899', wsUrl: 'ws://127.0.0.1:47899/ws', token: TOKEN, port: 47899 } });
  });

  it('el resto de la salida es ruido', () => {
    expect(parseReadyLine('Núcleo en http://127.0.0.1:47811 (token arriba)')).toEqual({ kind: 'other' });
    expect(parseReadyLine('{"ready": tr')).toEqual({ kind: 'other' });
    expect(parseReadyLine('{"ready":false}')).toEqual({ kind: 'other' });
    expect(parseReadyLine('')).toEqual({ kind: 'other' });
  });

  it('una línea ready que apunta fuera de 127.0.0.1 o con token corto es inválida, sin el token en el motivo', () => {
    const cases = [
      { url: 'http://evil.example:47899', wsUrl: 'ws://127.0.0.1:47899/ws', token: TOKEN },
      { url: 'http://localhost:47899', wsUrl: 'ws://localhost:47899/ws', token: TOKEN },
      { url: 'http://127.0.0.1:47899', wsUrl: 'ws://127.0.0.1:47900/ws', token: TOKEN },
      { url: 'https://127.0.0.1:47899', wsUrl: 'wss://127.0.0.1:47899/ws', token: TOKEN },
      { url: 'http://127.0.0.1:47899', wsUrl: 'ws://127.0.0.1:47899/otra', token: TOKEN },
      { url: 'http://127.0.0.1:47899', wsUrl: 'ws://127.0.0.1:47899/ws', token: 'corto' },
    ];
    for (const c of cases) {
      const r = parseReadyLine(JSON.stringify({ ready: true, ...c }));
      expect(r.kind).toBe('invalid');
      if (r.kind === 'invalid') expect(r.reason).not.toContain(TOKEN);
    }
  });
});

describe('waitForReady', () => {
  it('une trozos partidos (también a mitad de un carácter UTF-8), ignora ruido y CRLF', async () => {
    const s = source();
    const p = waitForReady(s, { timeoutMs: 5000 });
    const bytes = Buffer.from(`aviso: ñandú «ruido»\r\n${LINE}\r\n`, 'utf8');
    // Corta justo dentro de «ñ» (dos bytes) y en medio del JSON.
    s.stdout.write(bytes.subarray(0, 8));
    s.stdout.write(bytes.subarray(8, 40));
    s.stdout.write(bytes.subarray(40));
    await expect(p).resolves.toMatchObject({ port: 47899, token: TOKEN });
  });

  it('no busca la línea ready en stderr: allí solo hay ruido para el mensaje de error', async () => {
    const s = source();
    const p = waitForReady(s, { timeoutMs: 150 });
    s.stderr.write(`${LINE}\nExperimentalWarning: Type Stripping\n`);
    const err = await rejection(p);
    expect(err.reason).toBe('timeout');
  });

  it('con stderr por tubería, el error de salida trae su cola tachada', async () => {
    const s = source();
    const p = waitForReady(s, { timeoutMs: 5000 });
    s.stderr.write('Error: listen EADDRINUSE 127.0.0.1:47899\nclave sk-ant-api03-abcdefghijklmnopqrstuvwxyz\n');
    await new Promise((r) => setTimeout(r, 20));
    s.child.emit('exit', 1);
    const err = await rejection(p);
    expect(err.reason).toBe('exit');
    expect(err.exitCode).toBe(1);
    expect(err.message).toContain('EADDRINUSE');
    expect(err.message).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('si stdout se cierra y luego llega exit, el error trae el código', async () => {
    const s = source();
    const p = waitForReady(s, { timeoutMs: 5000 });
    s.stdout.end();
    await new Promise((r) => setTimeout(r, 20));
    s.child.emit('exit', 3);
    const err = await rejection(p);
    expect(err.exitCode).toBe(3);
    expect(err.message).toContain('código 3');
  });

  it('vence el plazo si la línea nunca llega', async () => {
    const s = source();
    const p = waitForReady(s, { timeoutMs: 60 });
    s.stdout.write('arrancando…\n');
    const err = await rejection(p);
    expect(err.reason).toBe('timeout');
  });

  it('falla si no se pudo lanzar el proceso', async () => {
    const s = source();
    const p = waitForReady(s, { timeoutMs: 5000 });
    s.child.emit('error', Object.assign(new Error('spawn node.exe ENOENT'), { code: 'ENOENT' }));
    expect((await rejection(p)).reason).toBe('spawn');
  });

  it('falla si stdout se cierra antes, pero acepta una última línea sin salto', async () => {
    const s1 = source();
    const p1 = waitForReady(s1, { timeoutMs: 5000, endGraceMs: 30 });
    s1.stdout.end('sin ready\n');
    expect((await rejection(p1)).reason).toBe('exit');

    const s2 = source();
    const p2 = waitForReady(s2, { timeoutMs: 5000 });
    s2.stdout.end(LINE);
    await expect(p2).resolves.toMatchObject({ port: 47899 });
  });

  it('una línea ready inválida o de otro puerto corta la espera', async () => {
    const s1 = source();
    const p1 = waitForReady(s1, { timeoutMs: 5000 });
    s1.stdout.write(`${JSON.stringify({ ready: true, url: 'http://evil.example:1', wsUrl: 'ws://evil.example:1/ws', token: TOKEN })}\n`);
    const e1 = await rejection(p1);
    expect(e1.reason).toBe('invalid');
    expect(e1.message).not.toContain(TOKEN);

    const s2 = source();
    const p2 = waitForReady(s2, { timeoutMs: 5000, expectedPort: 47811 });
    s2.stdout.write(`${LINE}\n`);
    expect((await rejection(p2)).reason).toBe('port');
  });

  it('descarta una línea gigante sin salto y sigue leyendo', async () => {
    const s = source();
    const p = waitForReady(s, { timeoutMs: 5000, maxLineBytes: 1024 });
    s.stdout.write('x'.repeat(4000));
    s.stdout.write(`${'y'.repeat(10)}"ready":true}\n${LINE}\n`);
    await expect(p).resolves.toMatchObject({ token: TOKEN });
  });

  it('al resolverse suelta sus escuchas (quien llama sigue drenando stdout)', async () => {
    const s = source();
    const p = waitForReady(s, { timeoutMs: 5000 });
    s.stdout.write(`${LINE}\n`);
    await p;
    expect(s.child.listenerCount('exit')).toBe(0);
    expect(s.child.listenerCount('error')).toBe(0);
    expect(s.stdout.listenerCount('end')).toBe(0);
  });
});

describe('tailLines', () => {
  it('deja las últimas líneas no vacías y tacha secretos', () => {
    expect(tailLines('a\n\nb\r\nc\nd\n', 2)).toBe('c\nd');
    expect(tailLines(`token=${TOKEN}`, 5, [TOKEN])).not.toContain(TOKEN);
  });
});
