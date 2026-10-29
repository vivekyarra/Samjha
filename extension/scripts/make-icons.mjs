// Generates extension/icons/icon{16,32,48,128}.png (indigo rounded square + white speech bubble). Run: node extension/scripts/make-icons.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
mkdirSync(out, { recursive: true });

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// Shape in unit coordinates (0..1). Returns [r,g,b,a] for a point.
function shade(x, y) {
  const r = 0.22, inset = 0.02;
  const cx = Math.min(Math.max(x, inset + r), 1 - inset - r), cy = Math.min(Math.max(y, inset + r), 1 - inset - r);
  if (Math.hypot(x - cx, y - cy) > r) return [0, 0, 0, 0];
  const bubble = ((x - 0.5) / 0.3) ** 2 + ((y - 0.45) / 0.22) ** 2 <= 1;
  const tail = y > 0.55 && y < 0.8 && x > 0.3 && x < 0.48 && (x - 0.3) < (0.8 - y) * 0.9;
  const dot = [0.38, 0.5, 0.62].some((dx) => Math.hypot(x - dx, y - 0.45) < 0.045);
  if ((bubble || tail) && !dot) return [255, 255, 255, 255];
  return [79, 70, 229, 255];
}

function png(size) {
  const S = 4, raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let acc = [0, 0, 0, 0];
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const c = shade((px + (sx + 0.5) / S) / size, (py + (sy + 0.5) / S) / size);
        acc = [acc[0] + c[0] * c[3], acc[1] + c[1] * c[3], acc[2] + c[2] * c[3], acc[3] + c[3]];
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      const a = acc[3] / (S * S);
      raw[o] = a ? Math.round(acc[0] / acc[3]) : 0;
      raw[o + 1] = a ? Math.round(acc[1] / acc[3]) : 0;
      raw[o + 2] = a ? Math.round(acc[2] / acc[3]) : 0;
      raw[o + 3] = Math.round(a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

for (const s of [16, 32, 48, 128]) writeFileSync(join(out, `icon${s}.png`), png(s));
console.log("icons written to", out);
