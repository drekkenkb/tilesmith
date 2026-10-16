// Tilesets: finding graphics in a ROM, turning them into pixels and back, and writing edited (recompressed) graphics
// into the ROM, moving them and updating pointers when they no longer fit.
import { CODECS, nemDecompress } from "./compress.js";
import { decodeTile, encodeTile } from "./codecs.js";

export const LAYOUTS = { "1x1": [1, 1], "1x2": [1, 2], "2x2": [2, 2], "4x4": [4, 4] };

// Which tile goes in column c, row r, when tiles fill blocks of bw x bh tiles (left to right, top to bottom).
export function arrangeIndex(c, r, cols, bw, bh) {
  const per = bw * bh, perRow = cols / bw;
  return (Math.floor(r / bh) * perRow + Math.floor(c / bw)) * per + (r % bh) * bw + (c % bw);
}

export function gridRows(tiles, cols, bw, bh) {
  return Math.ceil(Math.ceil(tiles / (bw * bh)) / (cols / bw)) * bh;
}

export function extract(rom, set) {
  const codec = CODECS[set.codec];
  if (!codec) throw new Error(`Unknown compression "${set.codec}".`);
  return codec.decompress(rom, set.off, set.length);
}

// Tile data → palette indices, laid out as the tileset's grid.
export function toPixels(fmt, data, cols, layout = "1x1") {
  const [bw, bh] = LAYOUTS[layout], tiles = Math.floor(data.length / fmt.bytes);
  const w = cols * 8, h = gridRows(tiles, cols, bw, bh) * 8, px = new Uint8Array(w * h), t = new Uint8Array(64);
  for (let r = 0; r < h / 8; r++) {
    for (let c = 0; c < cols; c++) {
      const i = arrangeIndex(c, r, cols, bw, bh);
      if (i >= tiles) continue;
      decodeTile(fmt, data, i * fmt.bytes, t);
      for (let y = 0; y < 8; y++) px.set(t.subarray(y * 8, y * 8 + 8), (r * 8 + y) * w + c * 8);
    }
  }
  return { w, h, px };
}

// The reverse: returns a copy of `data` with every tile replaced from the pixels.
export function fromPixels(fmt, data, cols, layout, px) {
  const [bw, bh] = LAYOUTS[layout], tiles = Math.floor(data.length / fmt.bytes), w = cols * 8;
  const out = data.slice(), t = new Uint8Array(64);
  for (let r = 0; r < gridRows(tiles, cols, bw, bh); r++) {
    for (let c = 0; c < cols; c++) {
      const i = arrangeIndex(c, r, cols, bw, bh);
      if (i >= tiles) continue;
      for (let y = 0; y < 8; y++) t.set(px.subarray((r * 8 + y) * w + c * 8, (r * 8 + y) * w + c * 8 + 8), y * 8);
      encodeTile(fmt, t, out, i * fmt.bytes);
    }
  }
  return out;
}

// Maps colors to palette indices: exact matches first, otherwise the nearest color. `inexact` counts the latter.
export function colorMapper(palette) {
  const cache = new Map();
  const m = {
    inexact: 0,
    index(r, g, b, a) {
      if (a < 128) return 0;
      const key = r << 16 | g << 8 | b;
      let v = cache.get(key);
      if (v === undefined) {
        v = palette.indexOf(key);
        if (v < 0) {
          let best = Infinity;
          palette.forEach((c, i) => {
            const d = (r - (c >> 16)) ** 2 * 3 + (g - (c >> 8 & 255)) ** 2 * 4 + (b - (c & 255)) ** 2 * 2;
            if (d < best) { best = d; v = i; }
          });
          v = ~v;
        }
        cache.set(key, v);
      }
      if (v < 0) { m.inexact++; return ~v; }
      return v;
    },
  };
  return m;
}

// ---------------------------------------------------------------- finding graphics

// Graphics the scanner can find on its own. Other games' graphics need their offset and compression entered by hand.
export async function findGraphics(rom, system, progress = () => {}) {
  const found = [];
  const yieldNow = () => new Promise(r => setTimeout(r, 0));
  if (system === "gba") {
    for (let o = 0; o + 8 <= rom.length; o += 4) {
      if (o % 0x40000 === 0) { progress(o / rom.length); await yieldNow(); }
      if (rom[o] !== 0x10) continue;
      const size = rom[o + 1] | rom[o + 2] << 8 | rom[o + 3] << 16;
      if (size < 64 || size % 32 || size > 0x40000) continue;
      try {
        const r = CODECS.lz77.decompress(rom, o);
        if (r.size < size / 40 || allSame(r.data)) continue;
        found.push({ codec: "lz77", off: o, size: r.size, bytes: r.data.length });
        o += (r.size + 3 & ~3) - 4;
      } catch {}
    }
  } else if (system === "md") {
    for (let o = 0x200; o + 4 <= rom.length; o += 2) {
      if (o % 0x20000 === 0) { progress(o / rom.length); await yieldNow(); }
      if ((rom[o + 2] & 0xf0) !== 0x80) continue;
      const tiles = (rom[o] << 8 | rom[o + 1]) & 0x7fff;
      if (!tiles || tiles > 0x800 || rom[o] & 0x78) continue;
      try {
        const r = nemDecompress(rom, o, true);
        if (r.size < 16 || allSame(r.data)) continue;
        found.push({ codec: "nemesis", off: o, size: r.size, bytes: r.data.length });
        o += (r.size + 1 & ~1) - 2;
      } catch {}
    }
  }
  progress(1);
  return found;
}

const allSame = d => d.every(b => b === d[0]);

// ---------------------------------------------------------------- writing back

const u32le = (rom, i) => (rom[i] | rom[i + 1] << 8 | rom[i + 2] << 16 | rom[i + 3] << 24) >>> 0;
const u32be = (rom, i) => (rom[i] << 24 | rom[i + 1] << 16 | rom[i + 2] << 8 | rom[i + 3]) >>> 0;

// Places where the ROM stores the address of `off`, as each system's CPU would see it.
export function findPointers(rom, off, system, header = 0) {
  const hits = [];
  if (system === "gba") {
    const v = (0x08000000 + off) >>> 0;
    for (let i = 0; i + 4 <= rom.length; i += 4) if (u32le(rom, i) === v) hits.push({ at: i, kind: "gba" });
  } else if (system === "md") {
    if (off < 0x200) return hits;
    for (let i = 0; i + 4 <= rom.length; i += 2) if (u32be(rom, i) === off) hits.push({ at: i, kind: "md" });
  } else if (system === "snes") {
    const o = off - header;
    const forms = [
      { kind: "lorom", v: ((o >> 15) | 0x80) << 16 | (o & 0x7fff) | 0x8000 },
      { kind: "hirom", v: (0xc0 | o >> 16) << 16 | (o & 0xffff) },
    ];
    for (const f of forms) {
      for (let i = 0; i + 3 <= rom.length; i++) {
        if (rom[i] === (f.v & 255) && rom[i + 1] === (f.v >> 8 & 255) && rom[i + 2] === f.v >> 16) hits.push({ at: i, kind: f.kind });
      }
    }
  }
  return hits;
}

function writePointer(rom, p, off, header) {
  if (p.kind === "gba") new DataView(rom.buffer).setUint32(p.at, 0x08000000 + off, true);
  else if (p.kind === "md") new DataView(rom.buffer).setUint32(p.at, off, false);
  else {
    const o = off - header;
    const v = p.kind === "lorom" ? ((o >> 15) | 0x80) << 16 | (o & 0x7fff) | 0x8000 : (0xc0 | o >> 16) << 16 | (o & 0xffff);
    rom[p.at] = v & 255; rom[p.at + 1] = v >> 8 & 255; rom[p.at + 2] = v >> 16;
  }
}

// A run of unused bytes (all 0xFF or all 0x00) big enough for `size`, searching from the end of the ROM, where games
// usually leave their padding. A small margin is left on both sides in case the run's edges belong to real data.
function findFree(rom, size, align, reserved) {
  const margin = 16;
  let end = rom.length;
  while (end > 0) {
    const v = rom[end - 1];
    if (v !== 0xff && v !== 0x00) { end--; continue; }
    let start = end - 1;
    while (start > 0 && rom[start - 1] === v) start--;
    let at = Math.ceil((start + margin) / align) * align;
    if (at + size + margin <= end && !reserved.some(([a, b]) => at < b && a < at + size)) return at;
    end = start;
  }
  return -1;
}

// Works out where compressed data goes: in place if it fits, otherwise somewhere free with its pointers updated.
// Returns { at, pointers, grow } or { error }.
export function plan(rom, set, comp, system, others, header = 0) {
  const codec = CODECS[set.codec];
  const slot = Math.ceil(set.size / codec.align) * codec.align;
  if (comp.length <= slot) return { at: set.off, pointers: [] };
  const over = `${comp.length - slot} bytes too big for its old space`;
  if (system === "nes" || system === "gb" || system === "sms" || system === "other") {
    return { error: `${set.name} now compresses to ${over}. Moving graphics isn't supported on this system, so simplify the edits (repeated patterns and flat areas compress best).` };
  }
  const pointers = findPointers(rom, set.off, system, header);
  if (!pointers.length) {
    return { error: `${set.name} now compresses to ${over}, and no pointer to it was found, so it can't be moved safely. Simplify the edits so it compresses smaller.` };
  }
  const reserved = others.map(o => [o.off, o.off + o.size]);
  let at = findFree(rom, comp.length, Math.max(codec.align, 4), reserved);
  let grow = 0;
  if (at < 0) {
    const limit = system === "gba" ? 0x2000000 : system === "md" ? 0x400000 : 0;
    const end = Math.ceil(rom.length / 4) * 4;
    if (end + comp.length > limit) return { error: `${set.name} is ${over}, and there's no free space in the ROM to move it to.` };
    at = end;
    grow = Math.ceil((end + comp.length) / 16) * 16;
  }
  return { at, pointers, grow };
}

// Applies a plan, returning the (possibly enlarged) ROM.
export function place(rom, p, comp, header = 0) {
  if (p.grow) {
    const big = new Uint8Array(p.grow).fill(0xff);
    big.set(rom);
    // Genesis headers record the ROM's last address.
    if (big.length > 0x1a8 && String.fromCharCode(...big.subarray(0x100, 0x110)).includes("SEGA")) {
      new DataView(big.buffer).setUint32(0x1a4, big.length - 1, false);
    }
    rom = big;
  }
  rom.set(comp, p.at);
  for (const ptr of p.pointers) writePointer(rom, ptr, p.at, header);
  return rom;
}
