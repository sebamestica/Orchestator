import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildIco, crc32, encodePng, ICON_SIZES, PNG_SIGNATURE, renderIcon } from '../../apps/desktop/tools/icon.ts';

function readIco(ico: Buffer) {
  expect(ico.readUInt16LE(0)).toBe(0);
  expect(ico.readUInt16LE(2)).toBe(1);
  const count = ico.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => {
    const e = 6 + 16 * i;
    const size = ico[e] === 0 ? 256 : (ico[e] ?? -1);
    const length = ico.readUInt32LE(e + 8);
    const offset = ico.readUInt32LE(e + 12);
    return { size, bits: ico.readUInt16LE(e + 6), png: ico.subarray(offset, offset + length) };
  });
}

describe('icono', () => {
  it('crc32 da el valor de referencia', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('el PNG es válido: firma, IHDR RGBA y píxeles que se descomprimen', () => {
    const png = encodePng(renderIcon(32), 32, 32);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(32);
    expect(png.readUInt32BE(20)).toBe(32);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
    expect(png.readUInt32BE(29)).toBe(crc32(png.subarray(12, 29)));
    const idatLen = png.readUInt32BE(33);
    expect(inflateSync(png.subarray(41, 41 + idatLen)).length).toBe((32 * 4 + 1) * 32);
  });

  it('fondo #090909 opaco en el centro del lienzo, «B» clara y esquinas transparentes', () => {
    const size = 256;
    const px = renderIcon(size);
    const at = (x: number, y: number) => Array.from(px.subarray((y * size + x) * 4, (y * size + x) * 4 + 4));
    expect(at(0, 0)[3]).toBe(0);
    expect(at(40, 128)).toEqual([9, 9, 9, 255]);
    expect(at(86, 128)).toEqual([236, 236, 236, 255]);
  });

  it('el .ico trae todos los tamaños como PNG de 32 bits, y el del repo está al día', () => {
    const ico = buildIco();
    const entries = readIco(ico);
    expect(entries.map((e) => e.size)).toEqual([...ICON_SIZES]);
    for (const e of entries) {
      expect(e.bits).toBe(32);
      expect(e.png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      expect(e.png.readUInt32BE(16)).toBe(e.size);
    }
    const committed = readFileSync(new URL('../../apps/desktop/assets/icon.ico', import.meta.url));
    expect(committed.equals(ico)).toBe(true);
  });
});
