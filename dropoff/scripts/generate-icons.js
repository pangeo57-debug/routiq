// Generates DropOff's PNG app icons (gradient background + a simple parcel-box
// glyph) with zero dependencies, since no image library is available in this
// environment. Pure pixel buffer -> PNG chunks (IHDR/IDAT/IEND) via Node's
// built-in zlib. Run with: node scripts/generate-icons.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgbaBuffer) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Each scanline needs a leading filter-type byte (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgbaBuffer.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idatData = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function lerp(a, b, t) { return a + (b - a) * t; }

function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const c1 = [249, 115, 22]; // orange-500
  const c2 = [194, 65, 12];  // orange-700
  const tapeColor = [234, 88, 12]; // orange-600, slightly darker than the box white

  // Parcel box geometry (fractions of `size`).
  const boxMargin = size * 0.24;
  const boxX0 = boxMargin, boxY0 = boxMargin;
  const boxX1 = size - boxMargin, boxY1 = size - boxMargin;
  const boxR = size * 0.06; // corner radius
  const tapeHalf = size * 0.045; // half-width of the packing-tape cross

  function setPx(x, y, r, g, b, a) {
    const i = (y * size + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  }

  function inRoundedRect(x, y) {
    if (x < boxX0 || x > boxX1 || y < boxY0 || y > boxY1) return false;
    const cx = x < boxX0 + boxR ? boxX0 + boxR : (x > boxX1 - boxR ? boxX1 - boxR : x);
    const cy = y < boxY0 + boxR ? boxY0 + boxR : (y > boxY1 - boxR ? boxY1 - boxR : y);
    const dx = x - cx, dy = y - cy;
    if ((x < boxX0 + boxR || x > boxX1 - boxR) && (y < boxY0 + boxR || y > boxY1 - boxR)) {
      return dx * dx + dy * dy <= boxR * boxR;
    }
    return true;
  }

  const boxCx = (boxX0 + boxX1) / 2, boxCy = (boxY0 + boxY1) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Diagonal gradient background, full-bleed (safe for maskable icons).
      const t = (x + y) / (size * 2);
      const r = lerp(c1[0], c2[0], t), g = lerp(c1[1], c2[1], t), b = lerp(c1[2], c2[2], t);
      setPx(x, y, Math.round(r), Math.round(g), Math.round(b), 255);

      if (inRoundedRect(x, y)) {
        const onTape = Math.abs(x - boxCx) <= tapeHalf || Math.abs(y - boxCy) <= tapeHalf;
        if (onTape) {
          setPx(x, y, tapeColor[0], tapeColor[1], tapeColor[2], 255);
        } else {
          setPx(x, y, 255, 255, 255, 255);
        }
      }
    }
  }

  return encodePNG(size, size, buf);
}

const outDir = path.join(__dirname, '..');
const targets = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
];
for (const [name, size] of targets) {
  fs.writeFileSync(path.join(outDir, name), makeIcon(size));
  console.log('wrote', name, size + 'x' + size);
}
