// Tile formats. Every format stores 8x8 tiles; a tile decodes to 64 palette indices, row by row.
//
// Planar formats keep one bit of each pixel per "plane": for row y and plane p, planeOff(y, p) gives the byte (from
// the start of the tile) holding that row's bits, leftmost pixel in bit 7. Packed formats store whole pixels per
// byte instead.
const planar = (id, name, bpp, planeOff) => {
  const offs = new Uint8Array(8 * bpp);
  for (let y = 0; y < 8; y++) for (let p = 0; p < bpp; p++) offs[y * bpp + p] = planeOff(y, p);
  return { id, name, bpp, bytes: 8 * bpp, offs };
};
const snesPlanes = (y, p) => (p >> 1) * 16 + 2 * y + (p & 1);

export const FORMATS = [
  planar("nes", "NES 2bpp", 2, (y, p) => y + 8 * p),
  planar("gb", "Game Boy / SNES 2bpp", 2, (y, p) => 2 * y + p),
  planar("snes4", "SNES / PC Engine 4bpp", 4, snesPlanes),
  planar("snes8", "SNES 8bpp", 8, snesPlanes),
  planar("sms", "Master System / Game Gear 4bpp", 4, (y, p) => 4 * y + p),
  { id: "md", name: "Genesis 4bpp", bpp: 4, bytes: 32, nibbles: "high-first" },
  { id: "gba4", name: "GBA 4bpp", bpp: 4, bytes: 32, nibbles: "low-first" },
  { id: "gba8", name: "GBA / linear 8bpp", bpp: 8, bytes: 64 },
  planar("1bpp", "1bpp (monochrome)", 1, y => y),
];

export function decodeTile(f, rom, off, px) {
  if (f.offs) {
    px.fill(0);
    for (let y = 0; y < 8; y++) {
      for (let p = 0; p < f.bpp; p++) {
        const b = rom[off + f.offs[y * f.bpp + p]];
        if (!b) continue;
        for (let x = 0; x < 8; x++) px[y * 8 + x] |= ((b >> (7 - x)) & 1) << p;
      }
    }
  } else if (f.bpp === 8) {
    for (let i = 0; i < 64; i++) px[i] = rom[off + i];
  } else {
    const hi = f.nibbles === "high-first";
    for (let i = 0; i < 32; i++) {
      const b = rom[off + i];
      px[2 * i] = hi ? b >> 4 : b & 15;
      px[2 * i + 1] = hi ? b & 15 : b >> 4;
    }
  }
}

export function encodeTile(f, px, rom, off) {
  const mask = (1 << f.bpp) - 1;
  if (f.offs) {
    for (let y = 0; y < 8; y++) {
      for (let p = 0; p < f.bpp; p++) {
        let b = 0;
        for (let x = 0; x < 8; x++) b |= (((px[y * 8 + x] & mask) >> p) & 1) << (7 - x);
        rom[off + f.offs[y * f.bpp + p]] = b;
      }
    }
  } else if (f.bpp === 8) {
    for (let i = 0; i < 64; i++) rom[off + i] = px[i];
  } else {
    const hi = f.nibbles === "high-first";
    for (let i = 0; i < 32; i++) {
      const a = px[2 * i] & 15, b = px[2 * i + 1] & 15;
      rom[off + i] = hi ? (a << 4) | b : (b << 4) | a;
    }
  }
}
