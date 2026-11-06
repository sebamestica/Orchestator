import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { installExitLog, stampedLog, STOP_SIGNALS } from '../../../src/core/app/core-log.ts';

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /;
const now = () => new Date('2026-11-05T01:40:34.380Z');

function fakeProcess(pid: number) {
  return Object.assign(new EventEmitter(), { pid });
}

describe('registro del núcleo (iniciar)', () => {
  it('cada línea del registro empieza con la hora ISO', () => {
    const lines: string[] = [];
    const log = stampedLog((l) => lines.push(l));
    log('GET /tasks 200 5ms');
    log('flota: 3 tarea(s) interrumpida');
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toMatch(ISO);
    expect(lines[0]).toMatch(/ GET \/tasks 200 5ms$/);
  });

  it('al salir deja «núcleo sale» con código, pid y hora', () => {
    const out: string[] = [];
    const proc = fakeProcess(5336);
    installExitLog(proc, (t) => out.push(t), now);
    proc.emit('exit', 0);
    expect(out).toEqual(['2026-11-05T01:40:34.380Z núcleo sale (código 0, pid 5336)\n']);
  });

  it('una excepción sin atrapar deja «núcleo cae» sin el secreto del mensaje', () => {
    const out: string[] = [];
    const proc = fakeProcess(5336);
    installExitLog(proc, (t) => out.push(t), now);
    const secret = `sk-ant-api03-${'a'.repeat(40)}`;
    proc.emit('uncaughtExceptionMonitor', new Error(`falló con ${secret}`), 'uncaughtException');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(ISO);
    expect(out[0]).toContain('núcleo cae (uncaughtException, pid 5336)');
    expect(out[0]).not.toContain(secret);
  });

  it('si stderr ya no se puede escribir, el manejador no lanza', () => {
    const proc = fakeProcess(1);
    installExitLog(proc, () => {
      throw new Error('EBADF');
    }, now);
    expect(() => proc.emit('exit', 1)).not.toThrow();
  });

  it('también se detiene de forma ordenada con SIGHUP (cierre de consola en Windows)', () => {
    expect(STOP_SIGNALS).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
  });
});
