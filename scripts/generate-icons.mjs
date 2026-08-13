#!/usr/bin/env node
/**
 * Generate the placeholder application icons Tauri requires.
 *
 * Written as a tiny PNG/ICO encoder rather than adding an image library
 * (development rule 20). The icons are a flat rounded square with a dot — a
 * stand-in until real artwork exists, but valid, correctly-sized files so the
 * build is not blocked on design.
 *
 * Run: node scripts/generate-icons.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'apps', 'desktop', 'src-tauri', 'icons');

// Brand colours: deep slate ground, warm amber mark.
const BG = [17, 24, 39, 255];
const FG = [251, 191, 36, 255];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Render the mark into an RGBA pixel buffer. */
function renderPixels(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const centre = (size - 1) / 2;
  const dotRadius = size * 0.17;
  const ringInner = size * 0.3;
  const ringOuter = size * 0.38;

  const put = (x, y, [r, g, b, a]) => {
    const offset = (y * size + x) * 4;
    pixels[offset] = r;
    pixels[offset + 1] = g;
    pixels[offset + 2] = b;
    pixels[offset + 3] = a;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      // Rounded-square mask.
      const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
      const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
      const outsideCorner = Math.hypot(dx, dy) > radius;
      if (outsideCorner) {
        put(x, y, [0, 0, 0, 0]);
        continue;
      }

      const distance = Math.hypot(x - centre, y - centre);
      const inDot = distance <= dotRadius;
      const inRing = distance >= ringInner && distance <= ringOuter;
      put(x, y, inDot || inRing ? FG : BG);
    }
  }
  return pixels;
}

function encodePng(size) {
  const pixels = renderPixels(size);

  // Each scanline is prefixed with a filter byte (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO wrapping PNG entries (supported on Vista and later). */
function encodeIco(sizes) {
  const images = sizes.map((size) => ({ size, png: encodePng(size) }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size; // 0 means 256
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32BE(0, 8);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

fs.mkdirSync(outDir, { recursive: true });

const pngTargets = [
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['icon.png', 512],
];

for (const [name, size] of pngTargets) {
  fs.writeFileSync(path.join(outDir, name), encodePng(size));
  console.log(`wrote ${name} (${size}x${size})`);
}

fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeIco([16, 32, 48, 256]));
console.log('wrote icon.ico (16, 32, 48, 256)');
