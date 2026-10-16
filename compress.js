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

// Range minimum over values filled in from the end, for the optimal-parse loops below: argmin(a, b) is the index in
// [a, b] with the smallest value.
class MinTree {
  constructor(n) { this.size = 1; while (this.size < n) this.size <<= 1; this.v = new Float64Array(2 * this.size).fill(Infinity); this.i = new Int32Array(2 * this.size); }
  set(j, x) {
    let k = j + this.size;
    this.v[k] = x; this.i[k] = j;
    for (k >>= 1; k; k >>= 1) { const l = 2 * k, r = l + 1, m = this.v[l] <= this.v[r] ? l : r; this.v[k] = this.v[m]; this.i[k] = this.i[m]; }
  }
  argmin(a, b) {
    let best = -1, bv = Infinity;
    for (let l = a + this.size, r = b + this.size + 1; l < r; l >>= 1, r >>= 1) {
      if (l & 1) { if (this.v[l] < bv) { bv = this.v[l]; best = this.i[l]; } l++; }
      if (r & 1) { r--; if (this.v[r] < bv) { bv = this.v[r]; best = this.i[r]; } }
    }
    return best;
  }
}

// Longest earlier match at each position for a copy that reads source bytes through `src(s, k)` (forwards, reversed
// bits or backwards), with hash chains keyed on the first three bytes as the copy would produce them.
function copyMatches(data, maxLen, { key, src, room, step = 1, maxStart = 0xffff, chain = 96 }) {
  const n = data.length, head = new Map(), prev = new Int32Array(n).fill(-1);
  const len = new Int32Array(n), from = new Int32Array(n);
  const k3 = (a, b, c) => a << 16 | b << 8 | c;
  for (let i = 0; i < n; i++) {
    // Inside a long match, the next position's best match is almost always the same one, one byte on.
    if (i && len[i - 1] > 24 && from[i - 1] + step <= maxStart) { len[i] = len[i - 1] - 1; from[i] = from[i - 1] + step; }
    else if (i + 2 < n) {
      const want = k3(data[i], data[i + 1], data[i + 2]);
      for (let s = head.has(want) ? head.get(want) : -1, c = chain; s >= 0 && c-- > 0; s = prev[s]) {
        const lim = Math.min(maxLen, n - i, room(s, i));
        let l = 0;
        while (l < lim && src(s, l) === data[i + l]) l++;
        if (l > len[i]) { len[i] = l; from[i] = s; if (l === lim) break; }
      }
    }
    // Position i can be a source for later positions once its first three output bytes exist.
    const kk = key(i);
    if (kk >= 0 && i <= maxStart) { prev[i] = head.has(kk) ? head.get(kk) : -1; head.set(kk, i); }
  }
  return { len, from };
}

// Optimal parse: best[i] is the fewest bytes that can encode data[i..]. Every command with a length up to 32 has a
// one-byte header, longer ones two, so each kind of command is a range query over best[] (and best[j] + j for
// literals, whose cost grows with their length).
function lzcmdCompress(data, v) {
  const n = data.length, MAX = 1024;
  const best = new Float64Array(n + 1), how = new Array(n);
  const tBest = new MinTree(n + 1), tLit = new MinTree(n + 1), tPair = [new MinTree((n >> 1) + 1), new MinTree((n >> 1) + 1)];
  tBest.set(n, 0); tLit.set(n, n); tPair[n & 1].set(n >> 1, 0);
  const fill = new Int32Array(n + 1), inc = new Int32Array(n + 1), alt = new Int32Array(n + 2);
  for (let i = n - 1; i >= 0; i--) {
    fill[i] = i + 1 < n && data[i + 1] === data[i] ? fill[i + 1] + 1 : 1;
    inc[i] = i + 1 < n && data[i + 1] === (data[i] + 1 & 255) ? inc[i + 1] + 1 : 1;
    alt[i] = i + 2 < n && data[i + 2] === data[i] ? alt[i + 1] + 1 : Math.min(2, n - i); // bytes repeating a 2-byte pattern
  }
  const fwd = copyMatches(data, MAX, { key: s => s + 2 < n ? data[s] << 16 | data[s + 1] << 8 | data[s + 2] : -1, src: (s, k) => data[s + k], room: () => Infinity });
  const opts = [fwd];
  if (v.hal) {
    opts.push(copyMatches(data, MAX, { key: s => s + 2 < n ? REV[data[s]] << 16 | REV[data[s + 1]] << 8 | REV[data[s + 2]] : -1, src: (s, k) => REV[data[s + k]], room: () => Infinity }));
    opts.push(copyMatches(data, MAX, { key: s => s >= 2 ? data[s] << 16 | data[s - 1] << 8 | data[s - 2] : -1, src: (s, k) => data[s - k], room: s => s + 1, step: -1 }));
  }
  for (let i = n - 1; i >= 0; i--) {
    let bc = Infinity, bh = null;
    const consider = (c, h) => { if (c < bc) { bc = c; bh = h; } };
    // A command taking 1..max bytes (in steps of 1) with `extra` bytes of payload: the best end point in each header size.
    const run = (cmd, max, extra, at) => {
      max = Math.min(max, MAX, n - i);
      let j = tBest.argmin(i + 1, i + Math.min(max, 32));
      consider(1 + extra + best[j], { cmd, take: j - i, at });
      if (max > 32) { j = tBest.argmin(i + 33, i + max); consider(2 + extra + best[j], { cmd, take: j - i, at }); }
    };
    { // literals
      let j = tLit.argmin(i + 1, i + Math.min(32, n - i));
      consider(1 + best[j] + j - i, { cmd: 0, take: j - i });
      if (n - i > 32) { j = tLit.argmin(i + 33, i + Math.min(MAX, n - i)); consider(2 + best[j] + j - i, { cmd: 0, take: j - i }); }
    }
    if (fill[i] > 1) run(1, fill[i], 1);
    if (inc[i] > 1) run(3, inc[i], 1);
    if (alt[i] >= 3) {
      if (!v.hal) run(2, alt[i], 2);
      else { // HAL counts pairs, so only end points two bytes apart
        const t = tPair[i & 1], b = i >> 1, w = Math.min(MAX, alt[i] >> 1);
        let j = t.argmin(b + 1, b + Math.min(w, 32)) * 2 + (i & 1);
        consider(1 + 2 + best[j], { cmd: 2, take: j - i });
        if (w > 32) { j = t.argmin(b + 33, b + w) * 2 + (i & 1); consider(2 + 2 + best[j], { cmd: 2, take: j - i }); }
      }
    }
    opts.forEach((m, k) => { if (m.len[i] >= 3) run(4 + k, m.len[i], 2, m.from[i]); });
    best[i] = bc; how[i] = bh;
    tBest.set(i, bc); tLit.set(i, bc + i); tPair[i & 1].set(i >> 1, bc);
  }
  const out = [];
  const head = (cmd, len) => {
    if (len <= 32) out.push(cmd << 5 | (len - 1));
    else out.push(0xe0 | cmd << 2 | (len - 1) >> 8, (len - 1) & 255);
  };
  for (let i = 0; i < n;) {
    const h = how[i];
    if (h.cmd === 0) { head(0, h.take); for (let k = 0; k < h.take; k++) out.push(data[i + k]); }
    else if (h.cmd === 1 || h.cmd === 3) out.push(...(head(h.cmd, h.take), [data[i]]));
    else if (h.cmd === 2) { head(2, v.hal ? h.take >> 1 : h.take); out.push(data[i], data[i + 1]); }
    else { head(h.cmd, h.take); out.push(...(v.le ? [h.at & 255, h.at >> 8] : [h.at >> 8, h.at & 255])); }
    i += h.take;
  }
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

// Optimal parse, in bits: a literal is 1 + 8, a short copy (2-5 bytes, up to 256 back) 4 + 8, a copy of 3-9 bytes
// up to 8 KB back 2 + 16, and a longer one (up to 256 bytes) 2 + 24.
function kosCompress(data) {
  const n = data.length, best = new Float64Array(n + 1), how = new Int32Array(n), dist = new Int32Array(n);
  const find = matcher(data, { maxDist: 0x2000, maxLen: 256, chain: 128 });
  const near = new Int32Array(n), nearDist = new Int32Array(n), far = new Int32Array(n), farDist = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const m = find(i);
    far[i] = m.len; farDist[i] = m.dist;
    // The closest earlier match of 2-5 bytes within 256: the hash chains only see matches of 3 or more.
    for (let d = 1; d <= Math.min(256, i); d++) {
      let l = 0;
      while (l < 5 && i + l < n && data[i - d + l] === data[i + l]) l++;
      if (l > near[i]) { near[i] = l; nearDist[i] = d; if (l === 5) break; }
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let bc = 9 + best[i + 1], bh = 1;
    for (let l = 2; l <= near[i]; l++) if (12 + best[i + l] < bc) { bc = 12 + best[i + l]; bh = -l; }
    for (let l = 3; l <= far[i]; l++) { const c = (l <= 9 ? 18 : 26) + best[i + l]; if (c < bc) { bc = c; bh = l; } }
    best[i] = bc; how[i] = bh;
  }
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
  for (let pos = 0; pos < n;) {
    const h = how[pos];
    if (h === 1) { bit(1); out.push(data[pos]); pos++; continue; }
    if (h < 0) {
      const len = -h;
      bit(0); bit(0); bit((len - 2) >> 1); bit((len - 2) & 1);
      out.push(0x100 - nearDist[pos]);
      pos += len;
    } else {
      bit(0); bit(1);
      const d = 0x2000 - farDist[pos];
      if (h <= 9) out.push(d & 255, (d >> 5) & 0xf8 | (h - 2));
      else out.push(d & 255, (d >> 5) & 0xf8, h - 1);
      pos += h;
    }
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
  lz1: { name: "Nintendo LZ1 (SNES: Zelda: A Link to the Past…)", short: "LZ1", align: 1,
    decompress: (r, o) => lzcmdDecompress(r, o, { le: true }), compress: d => lzcmdCompress(d, { le: true }) },
  hal: { name: "HAL LZ (SNES: Kirby, EarthBound…)", short: "HAL", align: 1,
    decompress: (r, o) => lzcmdDecompress(r, o, { hal: true }), compress: d => lzcmdCompress(d, { hal: true }) },
  nemesis: { name: "Nemesis (Genesis: Sonic and many Sega games)", short: "Nemesis", align: 2,
    decompress: (r, o) => nemDecompress(r, o), compress: nemCompress },
  kosinski: { name: "Kosinski (Genesis)", short: "Kosinski", align: 2, decompress: kosDecompress, compress: kosCompress },
};

export { nemDecompress };
