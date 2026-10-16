// Compression formats games use for graphics. Each codec can decompress data found at an offset in the ROM,
// returning the data and how many ROM bytes it took up, and compress edited data back into the same format.
// Decompressors throw on data that doesn't make sense, which is also how the graphics scanner rejects false hits.

const MAX_OUT = 1 << 21; // nothing a tileset needs; stops runaway decoding of non-graphics data

function fail(msg = "This doesn't look like data in that format.") { throw new Error(msg); }

// Finds the longest earlier match for data[pos..] using hash chains over 3-byte sequences. Matches may overlap the
// current position, like the decompressors' byte-by-byte copies do. `ok(dist)` can reject a distance.
function matcher(data, { maxDist, maxLen, minDist = 1, ok = null, chain = 512 }) {
  const head = new Int32Array(1 << 15).fill(-1), prev = new Int32Array(data.length);
  const hash = i => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & 0x7fff;
  let inserted = 0;
  return pos => {
    for (; inserted < pos; inserted++) {
      if (inserted + 2 < data.length) { const k = hash(inserted); prev[inserted] = head[k]; head[k] = inserted; }
    }
    let len = 0, dist = 0;
    if (pos + 2 >= data.length) return { len, dist };
    const lim = Math.min(maxLen, data.length - pos);
    for (let cand = head[hash(pos)], n = chain; cand >= 0 && n-- > 0; cand = prev[cand]) {
      const d = pos - cand;
      if (d > maxDist) break;
      if (d < minDist || (ok && !ok(d, cand))) continue;
      let l = 0;
      while (l < lim && data[cand + l] === data[pos + l]) l++;
      if (l > len) { len = l; dist = d; if (l === lim) break; }
    }
    return { len, dist };
  };
}

function byteReader(rom, off) {
  let p = off;
  return {
    get pos() { return p; },
    byte() { if (p >= rom.length) fail("The data runs past the end of the ROM."); return rom[p++]; },
  };
}

class Out {
  constructor(limit = MAX_OUT) { this.buf = new Uint8Array(4096); this.n = 0; this.limit = limit; }
  push(b) {
    if (this.n >= this.buf.length) {
      if (this.n >= this.limit) fail("The data decompresses to something far too big to be graphics.");
      const nb = new Uint8Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb;
    }
    this.buf[this.n++] = b;
  }
  copy(from, len) {
    if (from < 0 || from >= this.n) fail("A back-reference points outside the data.");
    for (let i = 0; i < len; i++) this.push(this.buf[from + i]);
  }
  done() { return this.buf.slice(0, this.n); }
}

// ---------------------------------------------------------------- GBA BIOS LZ77 (type 0x10)

function gbaHeader(rom, off, type) {
  if (rom[off] !== type) fail();
  const size = rom[off + 1] | rom[off + 2] << 8 | rom[off + 3] << 16;
  if (!size || size > MAX_OUT) fail();
  return size;
}

function lz77Decompress(rom, off) {
  const size = gbaHeader(rom, off, 0x10), r = byteReader(rom, off + 4), out = new Out(size);
  while (out.n < size) {
    const flags = r.byte();
    for (let bit = 7; bit >= 0 && out.n < size; bit--) {
      if (flags >> bit & 1) {
        const a = r.byte(), b = r.byte();
        const len = (a >> 4) + 3, dist = ((a & 15) << 8 | b) + 1;
        out.copy(out.n - dist, Math.min(len, size - out.n));
      } else out.push(r.byte());
    }
  }
  return { data: out.done(), size: r.pos - off };
}

function lz77Compress(data) {
  // VRAM-safe (no distance of 1), since games often decompress straight to VRAM, which is written 16 bits at a time.
  const find = matcher(data, { maxDist: 4096, maxLen: 18, minDist: 2 }), out = [0x10, data.length & 255, data.length >> 8 & 255, data.length >> 16];
  let pos = 0;
  while (pos < data.length) {
    const flagAt = out.length;
    out.push(0);
    for (let bit = 7; bit >= 0 && pos < data.length; bit--) {
      const m = find(pos);
      if (m.len >= 3) {
        out[flagAt] |= 1 << bit;
        out.push((m.len - 3) << 4 | (m.dist - 1) >> 8, (m.dist - 1) & 255);
        pos += m.len;
      } else out.push(data[pos++]);
    }
  }
  while (out.length % 4) out.push(0);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- GBA BIOS RLE (type 0x30)

function rleDecompress(rom, off) {
  const size = gbaHeader(rom, off, 0x30), r = byteReader(rom, off + 4), out = new Out(size);
  while (out.n < size) {
    const f = r.byte();
    if (f & 0x80) { const b = r.byte(); for (let i = 0; i < (f & 0x7f) + 3 && out.n < size; i++) out.push(b); }
    else for (let i = 0; i <= f && out.n < size; i++) out.push(r.byte());
  }
  return { data: out.done(), size: r.pos - off };
}

function rleCompress(data) {
  const out = [0x30, data.length & 255, data.length >> 8 & 255, data.length >> 16];
  let lit = [];
  const flush = () => { while (lit.length) { const n = lit.splice(0, 128); out.push(n.length - 1, ...n); } };
  for (let i = 0; i < data.length;) {
    let run = 1;
    while (i + run < data.length && data[i + run] === data[i] && run < 130) run++;
    if (run >= 3) { flush(); out.push(0x80 | (run - 3), data[i]); i += run; }
    else lit.push(data[i++]);
  }
  flush();
  while (out.length % 4) out.push(0);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- Nintendo LZ1/LZ2 and HAL (SNES)
//
// A command byte holds a 3-bit command and a 5-bit length (minus 1); command 7 means a 10-bit length follows the
// next 3 bits. 0xFF ends the data. Commands: 0 copy bytes, 1 repeat a byte, 2 repeat two bytes, 3 counting-up
// bytes, 4 copy from earlier output (absolute offset). HAL adds 5 (bit-reversed copy) and 6 (backwards copy), and
// its 2-byte repeat counts pairs rather than bytes.

const REV = Uint8Array.from({ length: 256 }, (_, b) => {
  let r = 0;
  for (let i = 0; i < 8; i++) r |= (b >> i & 1) << (7 - i);
  return r;
});

function lzcmdDecompress(rom, off, v) {
  const r = byteReader(rom, off), out = new Out();
  for (;;) {
    const h = r.byte();
    if (h === 0xff) break;
    let cmd = h >> 5, len;
    if (cmd === 7) { cmd = h >> 2 & 7; len = ((h & 3) << 8 | r.byte()) + 1; }
    else len = (h & 31) + 1;
    switch (cmd) {
      case 0: for (let i = 0; i < len; i++) out.push(r.byte()); break;
      case 1: { const b = r.byte(); for (let i = 0; i < len; i++) out.push(b); break; }
      case 2: {
        const a = r.byte(), b = r.byte();
        if (v.hal) for (let i = 0; i < len; i++) { out.push(a); out.push(b); }
        else for (let i = 0; i < len; i++) out.push(i & 1 ? b : a);
        break;
      }
      case 3: { const b = r.byte(); for (let i = 0; i < len; i++) out.push((b + i) & 255); break; }
      case 4: case 5: case 6: {
        const x = r.byte(), y = r.byte(), at = v.le ? y << 8 | x : x << 8 | y;
        if (cmd === 4) { out.copy(at, len); break; }
        if (!v.hal) fail();
        for (let i = 0; i < len; i++) {
          const src = cmd === 5 ? at + i : at - i;
          if (src < 0 || src >= out.n) fail("A back-reference points outside the data.");
          out.push(cmd === 5 ? REV[out.buf[src]] : out.buf[src]);
        }
        break;
      }
      default: fail();
    }
  }
  return { data: out.done(), size: r.pos - off };
}

function lzcmdCompress(data, v) {
  const out = [], n = data.length;
  const find = matcher(data, { maxDist: n, maxLen: 1024, ok: (d, cand) => cand <= 0xffff });
  const head = (cmd, len) => {
    if (len <= 32) out.push(cmd << 5 | (len - 1));
    else out.push(0xe0 | cmd << 2 | (len - 1) >> 8, (len - 1) & 255);
  };
  let lit = [];
  const flush = () => { while (lit.length) { const c = lit.splice(0, 1024); head(0, c.length); out.push(...c); } };
  let pos = 0;
  while (pos < n) {
    const lim = Math.min(1024, n - pos);
    let fill = 1; while (fill < lim && data[pos + fill] === data[pos]) fill++;
    let inc = 1; while (inc < lim && data[pos + inc] === ((data[pos] + inc) & 255)) inc++;
    let word = 2;
    if (pos + 1 < n) while (word < Math.min(n - pos, v.hal ? 2048 : 1024) && data[pos + word] === data[pos + (word & 1)]) word++;
    else word = 0;
    if (v.hal) word &= ~1;
    const m = pos ? find(pos) : { len: 0 };
    // Pick whichever saves the most bytes over storing the run as literals.
    const opts = [
      { cmd: 1, len: fill, cost: 1, take: fill },
      { cmd: 3, len: inc, cost: 1, take: inc },
      { cmd: 2, len: v.hal ? word >> 1 : word, cost: 2, take: word },
      { cmd: 4, len: m.len, cost: 2, take: m.len, at: pos - m.dist },
    ];
    let best = null;
    for (const o of opts) {
      if (o.len < 1) continue;
      const saving = o.take - o.cost - (o.len > 32 ? 2 : 1);
      if (saving > 0 && (!best || saving > best.saving)) best = { ...o, saving };
    }
    if (!best) { lit.push(data[pos++]); continue; }
    flush();
    head(best.cmd, best.len);
    if (best.cmd === 1 || best.cmd === 3) out.push(data[pos]);
    else if (best.cmd === 2) out.push(data[pos], data[pos + 1]);
    else out.push(...(v.le ? [best.at & 255, best.at >> 8] : [best.at >> 8, best.at & 255]));
    pos += best.take;
  }
  flush();
  out.push(0xff);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- Kosinski (Sega)
//
// 16-bit little-endian description fields, read a bit at a time from the low bit; a new field is loaded as soon as
// the last bit of the previous one is used. 1 = literal byte. 01 = copy with a 13-bit distance from 2 bytes (with a
// 3-bit length, or a length byte when that's 0). 00 = 2-bit length, then a 1-byte distance.

function kosDecompress(rom, off) {
  const r = byteReader(rom, off), out = new Out();
  let field = r.byte() | r.byte() << 8, left = 16;
  const bit = () => {
    const b = field & 1;
    field >>= 1;
    if (--left === 0) { field = r.byte() | r.byte() << 8; left = 16; }
    return b;
  };
  for (;;) {
    if (bit()) { out.push(r.byte()); continue; }
    let dist, count;
    if (bit()) {
      const lo = r.byte(), hi = r.byte();
      dist = 0x2000 - ((hi & 0xf8) << 5 | lo);
      count = hi & 7;
      if (count) count += 2;
      else {
        count = r.byte();
        if (count === 0) break;
        if (count === 1) continue;
        count += 1;
      }
    } else {
      count = (bit() << 1 | bit()) + 2;
      dist = 0x100 - r.byte();
    }
    out.copy(out.n - dist, count);
  }
  return { data: out.done(), size: r.pos - off };
}

function kosCompress(data) {
  const out = [0, 0];
  let fieldAt = 0, field = 0, nbits = 0;
  const bit = b => {
    field |= b << nbits;
    if (++nbits === 16) {
      out[fieldAt] = field & 255; out[fieldAt + 1] = field >> 8;
      fieldAt = out.length; out.push(0, 0);
      field = 0; nbits = 0;
    }
  };
  const find = matcher(data, { maxDist: 0x2000, maxLen: 256 });
  let pos = 0;
  while (pos < data.length) {
    const m = find(pos);
    if (m.len >= 2 && m.len <= 5 && m.dist <= 256) {
      bit(0); bit(0); bit((m.len - 2) >> 1); bit((m.len - 2) & 1);
      out.push(0x100 - m.dist);
    } else if (m.len >= 3) {
      bit(0); bit(1);
      const d = 0x2000 - m.dist;
      if (m.len <= 9) out.push(d & 255, (d >> 5) & 0xf8 | (m.len - 2));
      else out.push(d & 255, (d >> 5) & 0xf8, m.len - 1);
    } else {
      bit(1);
      out.push(data[pos]);
      pos++;
      continue;
    }
    pos += m.len;
  }
  bit(0); bit(1);
  out.push(0x00, 0xf0, 0x00);
  out[fieldAt] = field & 255; out[fieldAt + 1] = field >> 8;
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- Nemesis (Sega)
//
// A header word (bit 15: rows are XORed with the row above; the rest: number of 32-byte tiles), then a table of
// prefix codes for (nibble, repeat count) pairs, then the code stream, read from the high bit. 111111 marks a pair
// stored inline as 3 bits of count and 4 bits of nibble.

function nemDecompress(rom, off, strict = false) {
  let p = off + 2;
  if (p + 1 >= rom.length) fail();
  const hdr = rom[off] << 8 | rom[off + 1], xor = hdr & 0x8000, tiles = hdr & 0x7fff;
  if (!tiles || tiles * 32 > MAX_OUT) fail();
  const table = new Int32Array(256).fill(-1);
  let nib = -1, b = rom[p++], codes = 0;
  if (strict && (b & 0xf0) !== 0x80) fail();
  while (b !== 0xff) {
    if (p >= rom.length) fail();
    if (b & 0x80) { nib = b & 15; b = rom[p++]; continue; }
    const len = b & 15, count = (b >> 4 & 7) + 1, code = rom[p++];
    if (nib < 0 || len < 1 || len > 8 || (strict && code >> len)) fail();
    const first = (code << (8 - len)) & 255;
    for (let i = first; i < first + (1 << (8 - len)); i++) {
      if (strict && (table[i] >= 0 || i >> 2 === 0x3f)) fail();
      table[i] = len << 8 | (count - 1) << 4 | nib;
    }
    codes++;
    b = p < rom.length ? rom[p++] : fail();
  }
  if (strict && !codes) fail();
  const start = p;
  let acc = 0, have = 0, used = 0;
  const peek = n => {
    while (have < n) { acc = (acc << 8 | (p < rom.length ? rom[p] : 0)) & 0xffffff; p++; have += 8; }
    return acc >> (have - n) & ((1 << n) - 1);
  };
  const take = n => { const v = peek(n); have -= n; used += n; return v; };
  const out = new Uint8Array(tiles * 32);
  let o = 0, row = 0, nibs = 0, prev = 0;
  while (o < out.length) {
    let count, v;
    if (peek(6) === 0x3f) { take(6); count = take(3) + 1; v = take(4); }
    else {
      const e = table[peek(8)];
      if (e < 0) fail();
      take(e >> 8);
      count = (e >> 4 & 7) + 1; v = e & 15;
    }
    for (let i = 0; i < count && o < out.length; i++) {
      row = (row << 4 | v) >>> 0;
      if (++nibs === 8) {
        if (xor) { row = (row ^ prev) >>> 0; prev = row; }
        out[o++] = row >>> 24; out[o++] = row >> 16 & 255; out[o++] = row >> 8 & 255; out[o++] = row & 255;
        row = 0; nibs = 0;
      }
    }
    if (strict && start + (used >> 3) > rom.length) fail();
  }
  return { data: out, size: start - off + Math.ceil(used / 8) };
}

function huffmanLengths(freqs) {
  if (freqs.length === 1) return [1];
  let nodes = freqs.map((f, i) => ({ f, leaf: i }));
  const lens = new Array(freqs.length).fill(0);
  while (nodes.length > 1) {
    nodes.sort((a, b) => a.f - b.f);
    const [a, b] = nodes.splice(0, 2);
    nodes.push({ f: a.f + b.f, kids: [a, b] });
  }
  const walk = (n, d) => { if (n.kids) { walk(n.kids[0], d + 1); walk(n.kids[1], d + 1); } else lens[n.leaf] = d; };
  walk(nodes[0], 0);
  return lens;
}

// Picks code lengths (at most 8 bits) for the most common pairs, leaving the 111111 prefix free for inline pairs:
// keeping the codes' Kraft sum within 63/64 guarantees canonical codes never start with six 1s.
function nemCodeLengths(syms) {
  let best = null;
  const total = syms.reduce((s, x) => s + x.f, 0);
  for (let k = 1; k <= Math.min(syms.length, 252); k++) {
    const lens = huffmanLengths(syms.slice(0, k).map(s => s.f)).map(l => Math.min(l, 8));
    let kraft = lens.reduce((s, l) => s + (256 >> l), 0);
    while (kraft > 252) {
      let j = -1;
      for (let i = 0; i < k; i++) if (lens[i] < 8 && (j < 0 || syms[i].f < syms[j].f)) j = i;
      kraft -= 256 >> (lens[j] + 1);
      lens[j]++;
    }
    for (let i = 0; i < k; i++) {
      while (lens[i] > 1 && kraft + (256 >> lens[i]) <= 252) { kraft += 256 >> lens[i]; lens[i]--; }
    }
    let bits = 0, coded = 0;
    for (let i = 0; i < k; i++) { bits += syms[i].f * lens[i]; coded += syms[i].f; }
    bits += (total - coded) * 13 + 16 * k + 8 * 17;
    if (!best || bits < best.bits) best = { bits, lens: lens.slice(), k };
  }
  return best;
}

function nemEncode(data, xor) {
  const runs = [];
  let prevRow = 0, cur = -1, count = 0;
  for (let o = 0; o < data.length; o += 4) {
    const rowv = (data[o] << 24 | data[o + 1] << 16 | data[o + 2] << 8 | data[o + 3]) >>> 0;
    const enc = xor ? (rowv ^ prevRow) >>> 0 : rowv;
    prevRow = rowv;
    for (let s = 28; s >= 0; s -= 4) {
      const v = enc >>> s & 15;
      if (v === cur && count < 8) count++;
      else { if (count) runs.push(cur << 3 | (count - 1)); cur = v; count = 1; }
    }
  }
  runs.push(cur << 3 | (count - 1));
  const freq = new Map();
  for (const r of runs) freq.set(r, (freq.get(r) || 0) + 1);
  const syms = [...freq].map(([key, f]) => ({ key, f })).sort((a, b) => b.f - a.f || a.key - b.key);
  const { lens, k } = nemCodeLengths(syms);
  // Canonical codes, shortest first.
  const chosen = syms.slice(0, k).map((s, i) => ({ ...s, len: lens[i] })).sort((a, b) => a.len - b.len || a.key - b.key);
  const codes = new Map();
  let code = 0, prevLen = chosen[0].len;
  for (const s of chosen) { code <<= s.len - prevLen; prevLen = s.len; codes.set(s.key, { code, len: s.len }); code++; }

  const tiles = data.length / 32;
  const out = [(xor ? 0x80 : 0) | tiles >> 8, tiles & 255];
  for (let n = 0; n < 16; n++) {
    const mine = chosen.filter(s => s.key >> 3 === n);
    if (!mine.length) continue;
    out.push(0x80 | n);
    for (const s of mine) out.push((s.key & 7) << 4 | s.len, codes.get(s.key).code);
  }
  out.push(0xff);
  let acc = 0, nb = 0;
  const put = (v, n) => {
    for (let i = n - 1; i >= 0; i--) {
      acc = acc << 1 | (v >> i & 1);
      if (++nb === 8) { out.push(acc); acc = 0; nb = 0; }
    }
  };
  for (const r of runs) {
    const c = codes.get(r);
    if (c) put(c.code, c.len);
    else { put(0x3f, 6); put(r & 7, 3); put(r >> 3, 4); }
  }
  if (nb) out.push(acc << (8 - nb));
  return Uint8Array.from(out);
}

function nemCompress(data) {
  if (data.length % 32) { const p = new Uint8Array(Math.ceil(data.length / 32) * 32); p.set(data); data = p; }
  if (data.length / 32 > 0x7fff) fail("Too many tiles for Nemesis.");
  const a = nemEncode(data, false), b = nemEncode(data, true);
  return a.length <= b.length ? a : b;
}

// ---------------------------------------------------------------- the list

export const CODECS = {
  none: { name: "Uncompressed", short: "Raw", align: 1,
    decompress: (rom, off, len) => {
      if (!(len > 0) || off + len > rom.length) fail("That range runs past the end of the ROM.");
      return { data: rom.slice(off, off + len), size: len };
    },
    compress: d => d },
  lz77: { name: "GBA LZ77 (BIOS type 10)", short: "LZ77", align: 4, decompress: lz77Decompress, compress: lz77Compress },
  rle: { name: "GBA RLE (BIOS type 30)", short: "RLE", align: 4, decompress: rleDecompress, compress: rleCompress },
  lz2: { name: "Nintendo LZ2 (SNES: Super Mario World…)", short: "LZ2", align: 1,
    decompress: (r, o) => lzcmdDecompress(r, o, {}), compress: d => lzcmdCompress(d, {}) },
  lz1: { name: "Nintendo LZ1 (SNES)", short: "LZ1", align: 1,
    decompress: (r, o) => lzcmdDecompress(r, o, { le: true }), compress: d => lzcmdCompress(d, { le: true }) },
  hal: { name: "HAL LZ (SNES: Kirby, EarthBound…)", short: "HAL", align: 1,
    decompress: (r, o) => lzcmdDecompress(r, o, { hal: true }), compress: d => lzcmdCompress(d, { hal: true }) },
  nemesis: { name: "Nemesis (Genesis: Sonic and many Sega games)", short: "Nemesis", align: 2,
    decompress: (r, o) => nemDecompress(r, o), compress: nemCompress },
  kosinski: { name: "Kosinski (Genesis)", short: "Kosinski", align: 2, decompress: kosDecompress, compress: kosCompress },
};

export { nemDecompress };
