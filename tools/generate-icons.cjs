'use strict';

// Original cloud/check artwork. No imported image, font, or personal metadata.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const ICON_SIZES = Object.freeze([16, 32, 48, 128]);
const cache = new Map();

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); name.copy(result, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return result;
}
function segmentDistance(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}
function colorAt(x, y) {
  const qx = Math.max(Math.abs(x - 64) - 32, 0), qy = Math.max(Math.abs(y - 64) - 32, 0);
  if (qx * qx + qy * qy > 28 * 28) return null;
  const circle = (cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  const cloud = circle(44, 75, 19) || circle(64, 59, 25) || circle(87, 74, 20) ||
    (x >= 44 && x <= 87 && y >= 70 && y <= 94);
  const check = segmentDistance(x, y, 48, 68, 60, 80) <= 4 || segmentDistance(x, y, 60, 80, 83, 56) <= 4;
  return cloud && !check ? [52, 41, 32] : [254, 229, 0];
}
function createIcon(size) {
  if (!ICON_SIZES.includes(size)) throw new Error('Unsupported icon size.');
  if (cache.has(size)) return Buffer.from(cache.get(size));
  const samples = 4, raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let alpha = 0, r = 0, g = 0, b = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const color = colorAt((x + (sx + 0.5) / samples) * 128 / size, (y + (sy + 0.5) / samples) * 128 / size);
      if (color) { alpha++; r += color[0]; g += color[1]; b += color[2]; }
    }
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    if (alpha) { raw[offset] = Math.round(r / alpha); raw[offset + 1] = Math.round(g / alpha); raw[offset + 2] = Math.round(b / alpha); }
    raw[offset + 3] = Math.round(alpha * 255 / samples ** 2);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  cache.set(size, png);
  return Buffer.from(png);
}
function generate(root, io = fs) {
  const base = path.resolve(root), directory = path.join(base, 'extension', 'icons');
  for (const target of [base, path.join(base, 'extension'), directory]) {
    if (io.existsSync(target)) {
      const info = io.lstatSync(target);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Icon directory must be an ordinary directory.');
    }
  }
  io.mkdirSync(directory, { recursive: true });
  for (const size of ICON_SIZES) {
    const target = path.join(directory, `icon${size}.png`), data = createIcon(size);
    if (io.existsSync(target)) {
      if (!io.lstatSync(target).isFile() || io.lstatSync(target).isSymbolicLink() || !io.readFileSync(target).equals(data)) {
        throw new Error('Existing icon differs; preserve and review it before replacement.');
      }
    } else io.writeFileSync(target, data, { flag: 'wx' });
  }
}
if (require.main === module) {
  if (process.argv.length !== 2) { console.error('Usage: node tools/generate-icons.cjs'); process.exitCode = 1; }
  else { generate(path.resolve(__dirname, '..')); console.log('Generated or verified four yellow extension icons.'); }
}
module.exports = { ICON_SIZES, createIcon, generate };
