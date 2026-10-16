// Indexed PNG writing and ZIP reading/writing, without libraries.

const CRC = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(data, crc = 0) {
  crc = ~crc;
  for (let i = 0; i < data.length; i++) crc = CRC[(crc ^ data[i]) & 255] ^ (crc >>> 8);
  return ~crc >>> 0;
}

async function zlib(data) {
  if (typeof CompressionStream === "function") {
    return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  }
  // Stored (uncompressed) deflate blocks, for browsers without CompressionStream.
  const out = [0x78, 0x01];
  for (let i = 0; i < data.length || i === 0; i += 65535) {
    const n = Math.min(65535, data.length - i), last = i + n >= data.length;
    out.push(last ? 1 : 0, n & 255, n >> 8, ~n & 255, ~n >> 8 & 255);
    for (let j = 0; j < n; j++) out.push(data[i + j]);
    if (last) break;
  }
  let a = 1, b = 0;
  for (const v of data) { a = (a + v) % 65521; b = (b + a) % 65521; }
  out.push(b >> 8, b & 255, a >> 8, a & 255);
  return Uint8Array.from(out);
}

// An 8-bit indexed PNG: paint programs keep the palette, which keeps edits within the colors the ROM can store.
export async function indexedPNG(w, h, px, palette) {
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) raw.set(px.subarray(y * w, y * w + w), y * (w + 1) + 1);
  const chunks = [];
  const chunk = (type, body) => {
    const b = new Uint8Array(12 + body.length), dv = new DataView(b.buffer);
    dv.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
    b.set(body, 8);
    dv.setUint32(8 + body.length, crc32(b.subarray(4, 8 + body.length)));
    chunks.push(b);
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr.set([8, 3, 0, 0, 0], 8);
  chunk("IHDR", ihdr);
  chunk("PLTE", Uint8Array.from(palette.flatMap(c => [c >> 16 & 255, c >> 8 & 255, c & 255])));
  chunk("IDAT", await zlib(raw));
  chunk("IEND", new Uint8Array(0));
  return new Blob([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), ...chunks], { type: "image/png" });
}

export function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), n = f.data.length;
    const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint16(12, 0x5821, true); // a fixed date, 2024-01-01
    lv.setUint32(14, crc, true); lv.setUint32(18, n, true); lv.setUint32(22, n, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const c = new Uint8Array(46 + name.length), cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(14, 0x5821, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, n, true); cv.setUint32(24, n, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    c.set(name, 46);
    parts.push(local, f.data);
    central.push(c);
    offset += local.length + n;
  }
  const size = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, size, true); ev.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

// Reads stored and deflated entries, which covers what Finder, Windows, Android and the iOS Files app produce.
export async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let e = bytes.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("That isn't a ZIP file.");
  const count = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  const dec = new TextDecoder(), files = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("The ZIP file is damaged.");
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) {
      data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    } else throw new Error(`${name} uses a ZIP compression method this app can't read.`);
    files.push({ name, data });
  }
  return files;
}
