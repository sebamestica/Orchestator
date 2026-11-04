import { deflateSync } from 'node:zlib';

// Icono de Berland sin dependencias: la geometría de assets/icon.svg (caja de 256) dibujada con campos de
// distancia y antialiasing analítico, codificada a PNG a mano y empaquetada en un .ico con PNG embebidos.

type Vec = readonly [number, number];
type Shape = { kind: 'seg'; a: Vec; b: Vec } | { kind: 'arc'; c: Vec; r: number };

/** Lienzo #090909 y trazo #ececec (gris, los tres canales iguales). */
const BG = 9;
const FG = 236;
const BOX = { x: 8, y: 8, w: 240, h: 240, r: 56 } as const;
const BORDER = { width: 1.5, alpha: 0.12 } as const;
const STROKE = 20;

/** La «B»: asta, barra de arriba, centro y base, y dos medias circunferencias hacia la derecha. */
const GLYPH: readonly Shape[] = [
  { kind: 'seg', a: [86, 68], b: [86, 188] },
  { kind: 'seg', a: [86, 68], b: [132, 68] },
  { kind: 'arc', c: [132, 96], r: 28 },
  { kind: 'seg', a: [86, 124], b: [138, 124] },
  { kind: 'arc', c: [138, 156], r: 32 },
  { kind: 'seg', a: [138, 188], b: [86, 188] },
];

function distSeg(px: number, py: number, a: Vec, b: Vec): number {
  const [ax, ay] = a;
  const dx = b[0] - ax;
  const dy = b[1] - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distancia a la media circunferencia derecha (de arriba a abajo, como el arco del SVG). */
function distArc(px: number, py: number, c: Vec, r: number): number {
  const [cx, cy] = c;
  if (px >= cx) return Math.abs(Math.hypot(px - cx, py - cy) - r);
  return Math.min(Math.hypot(px - cx, py - (cy - r)), Math.hypot(px - cx, py - (cy + r)));
}

/** Distancia con signo a la caja redondeada (negativa dentro). */
function distBox(px: number, py: number): number {
  const hx = BOX.w / 2 - BOX.r;
  const hy = BOX.h / 2 - BOX.r;
  const qx = Math.abs(px - (BOX.x + BOX.w / 2)) - hx;
  const qy = Math.abs(py - (BOX.y + BOX.h / 2)) - hy;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - BOX.r;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** RGBA (sin premultiplicar) de `size`×`size`. En tamaños chicos el trazo no baja de 1,8 px para que la «B» se lea. */
export function renderIcon(size: number): Buffer {
  const scale = size / 256;
  const half = Math.max((STROKE / 2) * scale, 0.9);
  const borderHalf = Math.max((BORDER.width / 2) * scale, 0.5);
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / scale;
      const v = (y + 0.5) / scale;
      const box = distBox(u, v) * scale;
      const fill = clamp01(0.5 - box);
      if (fill <= 0) continue;
      // Borde de vidrio pegado al contorno interior, y la «B» encima.
      const border = clamp01(0.5 - (Math.abs(box + borderHalf) - borderHalf)) * BORDER.alpha;
      let d = Number.POSITIVE_INFINITY;
      for (const s of GLYPH) d = Math.min(d, s.kind === 'seg' ? distSeg(u, v, s.a, s.b) : distArc(u, v, s.c, s.r));
      const glyph = clamp01(0.5 - (d * scale - half));
      const k = Math.max(border, glyph);
      const i = (y * size + x) * 4;
      out.fill(Math.round(BG + (FG - BG) * k), i, i + 3);
      out[i + 3] = Math.round(fill * 255);
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG RGBA de 8 bits por canal (filtro 0 en cada fila). */
export function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** .ico con una imagen PNG por tamaño (Windows Vista en adelante). */
export function encodeIco(images: readonly { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header[e] = size >= 256 ? 0 : size;
    header[e + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((im) => im.png)]);
}

export const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256] as const;

export function buildIco(sizes: readonly number[] = ICON_SIZES): Buffer {
  return encodeIco(sizes.map((size) => ({ size, png: encodePng(renderIcon(size), size, size) })));
}
