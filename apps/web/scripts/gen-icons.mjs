// PWA icon 產生器：三條帳目訊號在粉色差額點重新對齊，純 Node 無依賴。
// 執行一次並提交輸出：node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const INK = [0x2b, 0x23, 0x56];
const VIOLET = [0x7e, 0x5e, 0xff];
const SIGNAL = [0xf5, 0x5b, 0xa8];
const PALE = [0xf8, 0xf7, 0xff];

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c;
    });
  }
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const cornerR = size * 0.22;
  const railHeight = size * 0.055;
  const railLeft = size * 0.19;
  const railRight = size * 0.81;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // 圓角方形背景
      const dx = Math.max(Math.abs(x - c) - (c - cornerR), 0);
      const dy = Math.max(Math.abs(y - c) - (c - cornerR), 0);
      const cornerDist = Math.hypot(dx, dy) - cornerR;
      if (cornerDist > 0) {
        px[i + 3] = 0;
        continue;
      }
      let [r, g, b] = INK;
      const rails = [0.35, 0.5, 0.65];
      for (let rail = 0; rail < rails.length; rail++) {
        const yCenter = size * rails[rail];
        const gap = size * (0.07 + rail * 0.025);
        const shift = size * (rail - 1) * 0.045;
        if (
          Math.abs(y - yCenter) <= railHeight &&
          x >= railLeft &&
          x <= railRight &&
          (x < c + shift - gap || x > c + shift + gap)
        ) {
          [r, g, b] = rail === 1 ? VIOLET : PALE;
        }
      }
      const diamond = Math.abs(x - c) + Math.abs(y - c);
      if (diamond < size * 0.085) [r, g, b] = SIGNAL;
      const feather = Math.min(1, -cornerDist);
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = Math.round(255 * feather);
    }
  }
  return encodePng(size, px);
}

for (const size of [512, 192, 180]) {
  writeFileSync(join(outDir, `icon-${size}.png`), drawIcon(size));
  console.log(`icon-${size}.png written`);
}
