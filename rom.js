// Knowledge about ROM files: where the graphics usually are, header checksums, and IPS patches.

// Guesses the tile format and where to start looking, from the file's header and extension.
export function detect(name, rom) {
  const ext = (name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase() || "";
  const ascii = (o, n) => String.fromCharCode(...rom.subarray(o, o + n));

  if (ascii(0, 4) === "NES\x1a") {
    let prg = rom[4], chr = rom[5];
    if ((rom[7] & 0x0c) === 0x08) { // NES 2.0 keeps the high bits of both sizes in byte 9
      if ((rom[9] & 0x0f) !== 0x0f) prg |= (rom[9] & 0x0f) << 8;
      if ((rom[9] >> 4) !== 0x0f) chr |= (rom[9] >> 4) << 8;
    }
    const start = 16 + (rom[6] & 4 ? 512 : 0) + prg * 16384;
    if (chr) {
      return { system: "nes", fmt: "nes", offset: start, chr: chr * 8192, jump: { label: "CHR ROM", offset: start },
        info: `PRG ${prg * 16} KB, CHR ${chr * 8} KB starting at 0x${start.toString(16).toUpperCase()}.` };
    }
    return { system: "nes", fmt: "nes", offset: 16,
      info: `PRG ${prg * 16} KB with no CHR ROM: this game builds its tiles in RAM from data in PRG ROM, often compressed, so some graphics may not show up as tiles here.` };
  }
  if (rom.length > 0x150 && rom[0x104] === 0xce && rom[0x105] === 0xed) {
    return { system: "gb", fmt: "gb", offset: 0, info: rom[0x143] & 0x80 ? "Game Boy Color ROM." : "Game Boy ROM." };
  }
  if (rom.length > 0xc0 && rom[0xb2] === 0x96 && ["gba", "agb", "bin"].includes(ext)) {
    return { system: "gba", fmt: "gba4", offset: 0, info: `GBA ROM: ${ascii(0xa0, 12).replace(/\0/g, "").trim()}.` };
  }
  if (rom.length > 0x200 && ascii(0x100, 16).includes("SEGA")) {
    return { system: "md", fmt: "md", offset: 0, info: "Genesis / Mega Drive ROM." };
  }
  if (["sfc", "smc", "swc", "fig"].includes(ext)) {
    const h = rom.length % 1024 === 512 ? 512 : 0;
    return { system: "snes", header: h, fmt: "snes4", offset: h, info: h ? "SNES ROM with a 512-byte copier header." : "SNES ROM." };
  }
  if (["sms", "gg", "sg"].includes(ext)) return { system: "sms", fmt: "sms", offset: 0, info: "Master System / Game Gear ROM." };
  if (ext === "pce") {
    const h = rom.length % 8192 === 512 ? 512 : 0;
    return { system: "other", fmt: "snes4", offset: h, info: "PC Engine ROM. Background tiles use this format; sprites use a different layout." };
  }
  if (["gb", "gbc"].includes(ext)) return { system: "gb", fmt: "gb", offset: 0, info: "" };
  if (["gba", "agb"].includes(ext)) return { system: "gba", fmt: "gba4", offset: 0, info: "" };
  if (["md", "gen", "smd"].includes(ext)) return { system: "md", fmt: "md", offset: 0, info: "" };
  return { system: "other", fmt: "nes", offset: 0, info: "Unknown ROM type. Try the formats until the tiles look right." };
}

// Recomputes the checksum stored in the header, for the systems where an edit could make a game refuse to boot
// (some Genesis games check it themselves) or make emulators complain. Returns a message, or null if none applies.
export function fixChecksum(rom) {
  const n = rom.length;
  const ascii = (o, len) => String.fromCharCode(...rom.subarray(o, o + len));

  if (n > 0x200 && ascii(0x100, 16).includes("SEGA")) {
    // The checksum covers up to the ROM end address in the header, which can be short of the file's end.
    const end = ((rom[0x1a4] << 24 | rom[0x1a5] << 16 | rom[0x1a6] << 8 | rom[0x1a7]) >>> 0) + 1;
    const to = end > 0x200 && end < n ? end : n;
    let sum = 0;
    for (let i = 0x200; i < to; i += 2) sum = (sum + (rom[i] << 8) + (rom[i + 1] || 0)) & 0xffff;
    rom[0x18e] = sum >> 8; rom[0x18f] = sum & 0xff;
    return "Genesis checksum updated.";
  }
  if (n > 0x150 && rom[0x104] === 0xce && rom[0x105] === 0xed) {
    let sum = 0;
    for (let i = 0; i < n; i++) if (i !== 0x14e && i !== 0x14f) sum = (sum + rom[i]) & 0xffff;
    rom[0x14e] = sum >> 8; rom[0x14f] = sum & 0xff;
    return "Game Boy checksum updated.";
  }
  const base = n % 1024 === 512 ? 512 : 0;
  for (const h of [0x7fc0, 0xffc0, 0x40ffc0]) {
    const o = base + h;
    if (o + 0x20 > n) continue;
    const comp = rom[o + 0x1c] | rom[o + 0x1d] << 8, chk = rom[o + 0x1e] | rom[o + 0x1f] << 8;
    if ((comp ^ chk) !== 0xffff || !/^[\x20-\x7e]{21}$/.test(ascii(o, 21))) continue;
    // A valid checksum/complement pair always adds 0x1FE to the sum, so the old pair can stay in while summing.
    // ROMs that aren't a power of two in size are summed as the console sees them, with the last part mirrored.
    const body = rom.subarray(base), len = body.length;
    let p = 1;
    while (p * 2 <= len) p *= 2;
    const sumRange = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += body[i]; return s; };
    const rest = len - p;
    let sum = sumRange(0, p);
    if (rest) sum += p % rest === 0 ? sumRange(p, len) * (p / rest) : sumRange(p, len);
    sum &= 0xffff;
    rom[o + 0x1e] = sum & 0xff; rom[o + 0x1f] = sum >> 8;
    rom[o + 0x1c] = ~sum & 0xff; rom[o + 0x1d] = (~sum >> 8) & 0xff;
    return "SNES checksum updated.";
  }
  return null;
}

// Builds an IPS patch turning `a` into `b` (same length). Returns null if they're identical.
export function makeIPS(a, b) {
  const out = [0x50, 0x41, 0x54, 0x43, 0x48]; // "PATCH"
  const n = b.length;
  let i = 0, records = 0;
  while (i < n) {
    if (a[i] === b[i]) { i++; continue; }
    // An offset of 0x454F46 would read as the "EOF" marker, so such a record starts one byte earlier.
    const start = i === 0x454f46 ? i - 1 : i;
    if (start > 0xffffff) throw new Error("This ROM is bigger than 16 MB, which IPS patches can't describe.");
    let end = i;
    while (end < n && end - start < 0xffff) {
      if (a[end] !== b[end]) { end++; continue; }
      // Bridge short runs of unchanged bytes: a new record costs 5 bytes of header.
      let g = end;
      while (g < n && a[g] === b[g] && g - end < 6) g++;
      if (g < n && g - end < 6) end = g; else break;
    }
    end = Math.min(end, start + 0xffff);
    out.push(start >> 16, (start >> 8) & 0xff, start & 0xff, (end - start) >> 8, (end - start) & 0xff);
    for (let k = start; k < end; k++) out.push(b[k]);
    records++;
    i = end;
  }
  if (!records) return null;
  out.push(0x45, 0x4f, 0x46); // "EOF"
  return new Uint8Array(out);
}

export function applyIPS(rom, patch) {
  const out = rom.slice();
  let i = 5;
  while (i + 3 <= patch.length) {
    const off = patch[i] << 16 | patch[i + 1] << 8 | patch[i + 2];
    if (off === 0x454f46) break;
    const len = patch[i + 3] << 8 | patch[i + 4];
    i += 5;
    if (len) { out.set(patch.subarray(i, i + len), off); i += len; }
    else { out.fill(patch[i + 2], off, off + (patch[i] << 8 | patch[i + 1])); i += 3; }
  }
  return out;
}

// The NES's 64 colors (the common FCEUX palette), for picking palettes that match the console.
export const NES_PALETTE = [
  0x7c7c7c, 0x0000fc, 0x0000bc, 0x4428bc, 0x940084, 0xa80020, 0xa81000, 0x881400,
  0x503000, 0x007800, 0x006800, 0x005800, 0x004058, 0x000000, 0x000000, 0x000000,
  0xbcbcbc, 0x0078f8, 0x0058f8, 0x6844fc, 0xd800cc, 0xe40058, 0xf83800, 0xe45c10,
  0xac7c00, 0x00b800, 0x00a800, 0x00a844, 0x008888, 0x000000, 0x000000, 0x000000,
  0xf8f8f8, 0x3cbcfc, 0x6888fc, 0x9878f8, 0xf878f8, 0xf85898, 0xf87858, 0xfca044,
  0xf8b800, 0xb8f818, 0x58d854, 0x58f898, 0x00e8d8, 0x787878, 0x000000, 0x000000,
  0xfcfcfc, 0xa4e4fc, 0xb8b8f8, 0xd8b8f8, 0xf8b8f8, 0xf8a4c0, 0xf0d0b0, 0xfce0a8,
  0xf8d878, 0xd8f878, 0xb8f8b8, 0xb8f8d8, 0x00fcfc, 0xf8d8f8, 0x000000, 0x000000,
];
