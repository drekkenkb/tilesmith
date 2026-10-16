import { FORMATS, decodeTile, encodeTile } from "./codecs.js";
import { detect, fixChecksum, makeIPS, NES_PALETTE } from "./rom.js";
import { CODECS } from "./compress.js";
import { LAYOUTS, arrangeIndex, gridRows, extract, toPixels, fromPixels, colorMapper, findGraphics, plan, place } from "./project.js";
import { indexedPNG, zip, unzip } from "./files.js";

const $ = s => document.querySelector(s);
const fmtById = Object.fromEntries(FORMATS.map(f => [f.id, f]));
const MAX_EDIT_TILES = 32;
const hex = (n, w = 0) => n.toString(16).toUpperCase().padStart(w, "0");
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// The ROM being edited and the untouched original (for IPS patches). `view` is what the tile view shows: the ROM
// itself, or the decompressed data of the open tileset (`cur`). Each has its own undo history (`hist`).
const S = {
  name: "", orig: null, rom: null, view: null, fmt: fmtById.nes, shift: 0, cols: 16, layout: "1x1", grid: true,
  fixsum: true, sel: null, selMode: false, romHist: null, hist: null, pal: [], color: 1, jump: null, unsaved: false,
  system: "other", header: 0, sets: [], cur: null, romView: null,
};
const newHist = () => ({ undo: [], redo: [] });

const viewer = $("#viewer"), canvas = $("#tiles"), spacer = $("#spacer");

// ---------------------------------------------------------------- palette

const PICO8 = [0x000000, 0x1d2b53, 0x7e2553, 0x008751, 0xab5236, 0x5f574f, 0xc2c3c7, 0xfff1e8,
  0xff004d, 0xffa300, 0xffec27, 0x00e436, 0x29adff, 0x83769c, 0xff77a8, 0xffccaa];

function defaultPalette(f) {
  if (f.id === "nes") return [0x000000, 0x0058f8, 0xfca044, 0xfcfcfc];
  if (f.id === "gb") return [0xe0f8d0, 0x88c070, 0x346856, 0x081820];
  if (f.bpp === 1) return [0x000000, 0xffffff];
  if (f.bpp <= 4) return PICO8.slice(0, 1 << f.bpp);
  return Array.from({ length: 256 }, (_, i) => i < 16 ? PICO8[i] : i * 0x010101);
}

function loadPalette(f = S.fmt) {
  try {
    const p = JSON.parse(localStorage.getItem("tilesmith.pal." + f.id));
    if (Array.isArray(p) && p.length === 1 << f.bpp) return p;
  } catch {}
  return defaultPalette(f);
}

function savePalette() {
  try { localStorage.setItem("tilesmith.pal." + S.fmt.id, JSON.stringify(S.pal)); } catch {}
}

// Palette as ImageData pixels (RGBA bytes, read as little-endian 32-bit words).
const pal32 = new Uint32Array(256);
function setPalette(p) {
  S.pal = p;
  pal32.fill(0xff000000);
  p.forEach((c, i) => { pal32[i] = 0xff000000 | (c & 0xff) << 16 | (c & 0xff00) | (c >> 16 & 0xff); });
  S.color = Math.min(S.color, p.length - 1);
  renderSwatches($("#pal"), i => editColor(i));
  renderSwatches($("#ed-pal"), i => { S.color = i; renderSwatches($("#ed-pal")); }, true);
  draw();
  edDraw();
}

function renderSwatches(el, onPick = el._onPick, showCurrent = false) {
  el._onPick = onPick;
  el.classList.toggle("tiny", S.pal.length > 16);
  el.replaceChildren(...S.pal.map((c, i) => {
    const b = document.createElement("button");
    b.style.background = "#" + hex(c, 6);
    b.title = `Color ${i}: #${hex(c, 6)}`;
    if (S.pal.length <= 16) b.innerHTML = `<span>${i}</span>`;
    if (showCurrent || el.id === "ed-pal") b.classList.toggle("current", i === S.color);
    b.onclick = () => onPick(i);
    return b;
  }));
}

let editingColor = 0;
function editColor(i) {
  editingColor = i;
  const cur = "#" + hex(S.pal[i], 6);
  if (S.fmt.id === "nes") {
    $("#nes-custom").value = cur;
    $("#nes-pal").showModal();
  } else {
    const input = $("#color-pick");
    input.value = cur;
    input.click();
  }
}

function setColor(i, c) {
  const p = S.pal.slice();
  p[i] = c;
  setPalette(p);
  savePalette();
}

$("#color-pick").addEventListener("input", e => setColor(editingColor, parseInt(e.target.value.slice(1), 16)));
$("#nes-custom").addEventListener("input", e => setColor(editingColor, parseInt(e.target.value.slice(1), 16)));
$("#nes-grid").append(...NES_PALETTE.map((c, i) => {
  const b = document.createElement("button");
  b.style.background = "#" + hex(c, 6);
  b.title = `$${hex(i, 2)}`;
  b.onclick = () => { setColor(editingColor, c); $("#nes-pal").close(); };
  return b;
}));
$("#nes-pal-close").onclick = () => $("#nes-pal").close();
$("#pal-reset").onclick = () => {
  try { localStorage.removeItem("tilesmith.pal." + S.fmt.id); } catch {}
  setPalette(defaultPalette(S.fmt));
};

// ---------------------------------------------------------------- the tile view

// The view is a grid of S.cols columns. Tiles fill it in blocks (bw x bh tiles) so sprites made of several tiles
// line up; within a block they go left to right, top to bottom.
const G = { dpr: 1, scale: 1, tileDev: 8, tile: 8, total: 0, rows: 0, bw: 1, bh: 1 };

const tileOff = idx => S.shift + idx * S.fmt.bytes;

function tileAt(c, r) {
  if (c < 0 || c >= S.cols || r < 0) return -1;
  const idx = arrangeIndex(c, r, S.cols, G.bw, G.bh);
  return idx < G.total ? idx : -1;
}

function cellOf(idx) {
  const per = G.bw * G.bh, perRow = S.cols / G.bw, block = Math.floor(idx / per), w = idx % per;
  return { c: (block % perRow) * G.bw + w % G.bw, r: Math.floor(block / perRow) * G.bh + Math.floor(w / G.bw) };
}

function layout() {
  [G.bw, G.bh] = LAYOUTS[S.layout];
  G.dpr = window.devicePixelRatio || 1;
  const W = viewer.clientWidth, H = viewer.clientHeight;
  // Whole device pixels per ROM pixel, so every pixel comes out the same size.
  G.scale = Math.max(1, Math.floor(W * G.dpr / (S.cols * 8)));
  G.tileDev = G.scale * 8;
  G.tile = G.tileDev / G.dpr;
  G.total = Math.max(0, Math.floor((S.view.length - S.shift) / S.fmt.bytes));
  G.rows = gridRows(G.total, S.cols, G.bw, G.bh);
  canvas.width = Math.round(W * G.dpr);
  canvas.height = Math.round(H * G.dpr);
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  spacer.style.height = Math.max(0, G.rows * G.tile - H) + "px";
  draw();
}

let frame = 0;
function draw() {
  if (S.view && !frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
}

const px64 = new Uint8Array(64);
const off = document.createElement("canvas"), offCtx = off.getContext("2d");
let img = null;

function render() {
  const ctx = canvas.getContext("2d");
  const top = viewer.scrollTop, H = viewer.clientHeight;
  const r0 = Math.floor(top / G.tile), n = Math.ceil(H / G.tile) + 1;
  const w = S.cols * 8, h = n * 8;
  if (!img || img.width !== w || img.height !== h) {
    img = new ImageData(w, h);
    off.width = w; off.height = h;
  }
  const buf = new Uint32Array(img.data.buffer);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < S.cols; c++) {
      const idx = tileAt(c, r0 + r), base = r * 8 * w + c * 8;
      if (idx < 0) {
        for (let y = 0; y < 8; y++) buf.fill(0, base + y * w, base + y * w + 8);
        continue;
      }
      decodeTile(S.fmt, S.view, tileOff(idx), px64);
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) buf[base + y * w + x] = pal32[px64[y * 8 + x]];
    }
  }
  offCtx.putImageData(img, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  const y0 = Math.round((r0 * G.tile - top) * G.dpr), td = G.tileDev;
  const rowY = r => y0 + (r - r0) * td;
  ctx.drawImage(off, 0, y0, w * G.scale, h * G.scale);

  if (S.grid && G.scale >= 2) {
    const gridW = S.cols * td, lastRow = Math.min(r0 + n, G.rows);
    for (const strong of [false, true]) {
      ctx.beginPath();
      for (let c = 1; c < S.cols; c++) {
        if ((c % G.bw === 0) !== strong) continue;
        ctx.moveTo(c * td + .5, Math.max(0, y0)); ctx.lineTo(c * td + .5, rowY(lastRow));
      }
      for (let r = r0 + 1; r < lastRow; r++) {
        if ((r % G.bh === 0) !== strong) continue;
        ctx.moveTo(0, rowY(r) + .5); ctx.lineTo(gridW, rowY(r) + .5);
      }
      ctx.strokeStyle = strong && (G.bw > 1 || G.bh > 1) ? "rgba(255,255,255,.35)" : "rgba(255,255,255,.13)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  if (S.sel) {
    const { c0, r0: s0, c1, r1 } = S.sel;
    const x = c0 * td, y = rowY(s0), sw = (c1 - c0 + 1) * td, sh = (r1 - s0 + 1) * td;
    const lw = Math.max(2, Math.round(G.dpr * 1.5));
    ctx.lineWidth = lw + 2; ctx.strokeStyle = "rgba(0,0,0,.8)";
    ctx.strokeRect(x + lw / 2, y + lw / 2, sw - lw, sh - lw);
    ctx.lineWidth = lw; ctx.strokeStyle = "#ffd43b";
    ctx.strokeRect(x + lw / 2, y + lw / 2, sw - lw, sh - lw);
  }
}

// The byte offset of the first tile on screen.
function topOffset() {
  const idx = tileAt(0, Math.floor(viewer.scrollTop / G.tile));
  return idx < 0 ? S.shift : tileOff(idx);
}

function gotoOffset(o) {
  o = clamp(o, 0, Math.max(0, S.view.length - 1));
  // Start the view so that `o` begins a row. (Bytes before the first tile aren't shown; going to 0 shows them.)
  S.shift = o % (S.fmt.bytes * S.cols * LAYOUTS[S.layout][1]);
  layout();
  viewer.scrollTop = cellOf(Math.floor((o - S.shift) / S.fmt.bytes)).r * G.tile;
  showOffset();
  draw();
  saveSoon();
}

function showOffset() {
  if (document.activeElement !== $("#offset")) $("#offset").value = hex(topOffset());
}

viewer.addEventListener("scroll", () => { draw(); showOffset(); saveSoon(); });
new ResizeObserver(() => { if (S.view) layout(); }).observe(viewer);

// ---------------------------------------------------------------- selecting

function cellFromEvent(e) {
  const rect = viewer.getBoundingClientRect();
  const x = e.clientX - rect.left, y = e.clientY - rect.top + viewer.scrollTop;
  return { c: clamp(Math.floor(x / G.tile), 0, S.cols - 1), r: clamp(Math.floor(y / G.tile), 0, Math.max(0, G.rows - 1)) };
}

function setSel(a, b) {
  S.sel = a && { c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c), r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r), anchor: a };
  showSel();
  draw();
}

function selTiles() {
  const { c0, c1, r0, r1 } = S.sel, cells = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.push(tileAt(c, r));
  return { tc: c1 - c0 + 1, tr: r1 - r0 + 1, cells };
}

// Offsets in a tileset are within its decompressed data, so they're shown with a "+".
const where = o => S.cur ? `+0x${hex(o)}` : `0x${hex(o)}`;

function showSel() {
  const has = !!S.sel;
  for (const id of ["#edit", "#export", "#import"]) $(id).disabled = !has;
  if (!has) { $("#sel-info").textContent = "Tap a tile to select it"; return; }
  const { tc, tr, cells } = selTiles();
  const first = cells.find(i => i >= 0);
  const at = first === undefined ? "past the end" : `tile ${hex(first)} at ${where(tileOff(first))}`;
  $("#sel-info").textContent = tc * tr === 1 ? `Selected ${at}` : `${tc}×${tr} tiles from ${at}`;
}

function hoverStatus(e) {
  const { c, r } = cellFromEvent(e), idx = tileAt(c, r);
  $("#status").textContent = idx < 0 ? "" : `Tile ${hex(idx)}  ·  offset ${where(tileOff(idx))}  ·  ${S.fmt.name}`;
}

let drag = null;
viewer.addEventListener("pointerdown", e => {
  if (!S.view || e.button > 0) return;
  const cell = cellFromEvent(e);
  if (e.pointerType === "mouse" || S.selMode) {
    e.preventDefault();
    viewer.focus({ preventScroll: true });
    viewer.setPointerCapture(e.pointerId);
    const anchor = e.shiftKey && S.sel ? S.sel.anchor : cell;
    drag = { anchor };
    setSel(anchor, cell);
  } else {
    drag = { tap: true, x: e.clientX, y: e.clientY, cell };
  }
});
viewer.addEventListener("pointermove", e => {
  if (e.pointerType === "mouse") hoverStatus(e);
  if (!drag || drag.tap) return;
  // Scroll while dragging past the top or bottom edge.
  const rect = viewer.getBoundingClientRect();
  if (e.clientY < rect.top + 24) viewer.scrollTop -= G.tile / 2;
  else if (e.clientY > rect.bottom - 24) viewer.scrollTop += G.tile / 2;
  setSel(drag.anchor, cellFromEvent(e));
});
viewer.addEventListener("pointerup", e => {
  if (drag?.tap && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 10) {
    setSel(drag.cell, drag.cell);
    hoverStatus(e);
  }
  drag = null;
});
viewer.addEventListener("pointercancel", () => { drag = null; });
viewer.addEventListener("dblclick", () => openEditor());
$("#sel-mode").onclick = () => {
  S.selMode = !S.selMode;
  $("#sel-mode").setAttribute("aria-pressed", S.selMode);
  viewer.classList.toggle("selecting", S.selMode);
};

// ---------------------------------------------------------------- changes, undo and redo

// Every change is a list of operations, each with a `before` and `after`: bytes at `off` in the view; `swap`, the
// whole ROM (when it grew); or `entry`, a tileset's location in the ROM.
function commit(ops, hist = S.hist) {
  ops = ops.filter(p => !p.before?.some || p.before.some((b, i) => b !== p.after[i]));
  if (!ops.length) return;
  hist.undo.push(ops);
  if (hist.undo.length > 300) hist.undo.shift();
  hist.redo = [];
  if (S.cur && hist === S.hist) S.cur.dirty = true;
  changed();
}

function changed() {
  S.unsaved = true;
  showHistory();
  draw();
  renderSets();
  saveSoon();
}

function showHistory() {
  $("#undo").disabled = $("#ed-undo").disabled = !S.hist.undo.length;
  $("#redo").disabled = $("#ed-redo").disabled = !S.hist.redo.length;
}

function applyOps(ops, key) {
  for (const op of key === "before" ? [...ops].reverse() : ops) {
    if (op.swap) {
      const was = S.rom;
      S.rom = op.swap[key];
      if (S.view === was) S.view = S.rom;
    } else if (op.entry) {
      const set = S.sets.find(x => x.id === op.entry);
      if (set) Object.assign(set, op[key]);
    } else S.view.set(op[key], op.off);
  }
}

function undo() {
  const p = S.hist.undo.pop();
  if (!p) return;
  applyOps(p, "before");
  S.hist.redo.push(p);
  afterHistory();
}

function redo() {
  const p = S.hist.redo.pop();
  if (!p) return;
  applyOps(p, "after");
  S.hist.undo.push(p);
  afterHistory();
}

function afterHistory() {
  if (S.cur) S.cur.dirty = true;
  layout();
  changed();
  if ($("#editor").open) { edLoad(); edDraw(); }
}

$("#undo").onclick = $("#ed-undo").onclick = undo;
$("#redo").onclick = $("#ed-redo").onclick = redo;

// ---------------------------------------------------------------- PNG export and import

const baseName = () => S.name.replace(/\.[^.]+$/, "");

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

$("#export").onclick = async () => {
  const { tc, tr, cells } = selTiles(), w = tc * 8, h = tr * 8, px = new Uint8Array(w * h);
  cells.forEach((idx, i) => {
    if (idx < 0) return;
    decodeTile(S.fmt, S.view, tileOff(idx), px64);
    const base = Math.floor(i / tc) * 8 * w + (i % tc) * 8;
    for (let y = 0; y < 8; y++) px.set(px64.subarray(y * 8, y * 8 + 8), base + y * w);
  });
  const first = cells.find(i => i >= 0) ?? 0;
  const prefix = S.cur ? slug(S.cur.name) + "-" : "";
  download(await indexedPNG(w, h, px, S.pal), `${baseName()}-${prefix}${hex(tileOff(first), 6)}-${S.fmt.id}-${tc}x${tr}.png`);
  toast("Exported. Edit it using only the palette's colors, keep the size the same, then import it back onto the same tile.");
};

const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tiles";

// Decodes an image file to RGBA, keeping the exact color values.
async function readImage(blob) {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const cv = document.createElement("canvas");
  cv.width = bmp.width; cv.height = bmp.height;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0);
  return cx.getImageData(0, 0, bmp.width, bmp.height);
}

$("#import").onclick = () => $("#png-file").click();

async function importImage(file) {
  if (!S.sel) { toast("Select the tile where the image's top-left corner should go first."); return; }
  let im;
  try { im = await readImage(file); } catch {
    toast("That image couldn't be read.");
    return;
  }
  const w = im.width, h = im.height, data = im.data, tw = Math.ceil(w / 8), th = Math.ceil(h / 8);
  const { c0, r0 } = S.sel;
  if (c0 + tw > S.cols) {
    toast(`The image is ${tw} tiles wide, but only ${S.cols - c0} fit to the right of the selected tile. Select a tile further left or show more columns.`);
    return;
  }
  const colors = colorMapper(S.pal);

  const patches = [];
  let skipped = 0;
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      const idx = tileAt(c0 + tx, r0 + ty);
      if (idx < 0) { skipped++; continue; }
      const o = tileOff(idx), before = S.view.slice(o, o + S.fmt.bytes);
      decodeTile(S.fmt, S.view, o, px64); // pixels outside a partial edge tile stay as they were
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const ix = tx * 8 + x, iy = ty * 8 + y;
          if (ix >= w || iy >= h) continue;
          const p = (iy * w + ix) * 4;
          px64[y * 8 + x] = colors.index(data[p], data[p + 1], data[p + 2], data[p + 3]);
        }
      }
      encodeTile(S.fmt, px64, S.view, o);
      patches.push({ off: o, before, after: S.view.slice(o, o + S.fmt.bytes) });
    }
  }
  commit(patches);
  setSel({ c: c0, r: r0 }, { c: c0 + tw - 1, r: Math.min(r0 + th - 1, G.rows - 1) });
  const notes = [`Imported ${tw}×${th} tiles.`];
  if (colors.inexact) notes.push(`${colors.inexact} pixels weren't palette colors and were matched to the nearest one.`);
  if (skipped) notes.push(`${skipped} tiles ran past the end and were left out.`);
  toast(notes.join(" "));
}

// ---------------------------------------------------------------- pixel editor

const E = { tc: 0, tr: 0, w: 0, h: 0, cells: [], px: null, tool: "pen", grid: true, stroke: null, dirty: new Set(), last: null };
const edCanvas = $("#ed-canvas");

function openEditor() {
  if (!S.sel) return;
  const { tc, tr, cells } = selTiles();
  if (tc > MAX_EDIT_TILES || tr > MAX_EDIT_TILES) {
    toast(`Select at most ${MAX_EDIT_TILES}×${MAX_EDIT_TILES} tiles to edit. For bigger areas, export a PNG.`);
    return;
  }
  if (cells.every(i => i < 0)) return;
  Object.assign(E, { tc, tr, w: tc * 8, h: tr * 8, cells });
  edLoad();
  const first = cells.find(i => i >= 0);
  $("#ed-info").textContent = `${tc}×${tr} tiles at ${where(tileOff(first))} · ${S.fmt.name}`;
  renderSwatches($("#ed-pal"));
  $("#editor").showModal();
  edLayout();
}

function edLoad() {
  E.px = new Uint8Array(E.w * E.h);
  E.cells.forEach((idx, ci) => {
    if (idx < 0) return;
    decodeTile(S.fmt, S.view, tileOff(idx), px64);
    const bx = (ci % E.tc) * 8, by = Math.floor(ci / E.tc) * 8;
    for (let y = 0; y < 8; y++) E.px.set(px64.subarray(y * 8, y * 8 + 8), (by + y) * E.w + bx);
  });
}

function edLayout() {
  if (!$("#editor").open) return;
  const wrap = $("#ed-wrap"), dpr = window.devicePixelRatio || 1;
  const s = Math.max(1, Math.floor(Math.min((wrap.clientWidth - 16) / E.w, (wrap.clientHeight - 16) / E.h) * dpr));
  E.scale = s;
  edCanvas.width = E.w * s;
  edCanvas.height = E.h * s;
  edCanvas.style.width = E.w * s / dpr + "px";
  edCanvas.style.height = E.h * s / dpr + "px";
  edDraw();
}
new ResizeObserver(edLayout).observe($("#ed-wrap"));

function edDraw() {
  if (!$("#editor").open || !E.px) return;
  const ctx = edCanvas.getContext("2d"), s = E.scale;
  const im = new ImageData(E.w, E.h), buf = new Uint32Array(im.data.buffer);
  for (let i = 0; i < E.px.length; i++) {
    const ci = Math.floor(i / E.w / 8) * E.tc + Math.floor(i % E.w / 8);
    buf[i] = E.cells[ci] < 0 ? 0xff202020 : pal32[E.px[i]];
  }
  const t = document.createElement("canvas");
  t.width = E.w; t.height = E.h;
  t.getContext("2d").putImageData(im, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(t, 0, 0, E.w * s, E.h * s);
  if (!E.grid) return;
  const lines = (step, style) => {
    ctx.beginPath();
    for (let x = step; x < E.w; x += step) { ctx.moveTo(x * s + .5, 0); ctx.lineTo(x * s + .5, E.h * s); }
    for (let y = step; y < E.h; y += step) { ctx.moveTo(0, y * s + .5); ctx.lineTo(E.w * s, y * s + .5); }
    ctx.strokeStyle = style;
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  if (s >= 6) lines(1, "rgba(128,128,128,.25)");
  lines(8, "rgba(255,255,255,.45)");
}

const edCellIndex = (x, y) => (y >> 3) * E.tc + (x >> 3);

function edSet(x, y, v) {
  if (x < 0 || y < 0 || x >= E.w || y >= E.h) return;
  const ci = edCellIndex(x, y), idx = E.cells[ci];
  if (idx < 0 || E.px[y * E.w + x] === v) return;
  if (!E.stroke.has(ci)) E.stroke.set(ci, S.view.slice(tileOff(idx), tileOff(idx) + S.fmt.bytes));
  E.px[y * E.w + x] = v;
  E.dirty.add(ci);
}

// Writes the changed tiles back into the view's data, so the main view updates while drawing.
function edFlush() {
  for (const ci of E.dirty) {
    const bx = (ci % E.tc) * 8, by = Math.floor(ci / E.tc) * 8;
    for (let y = 0; y < 8; y++) px64.set(E.px.subarray((by + y) * E.w + bx, (by + y) * E.w + bx + 8), y * 8);
    encodeTile(S.fmt, px64, S.view, tileOff(E.cells[ci]));
  }
  E.dirty.clear();
  edDraw();
  draw();
}

function edEndStroke() {
  if (!E.stroke) return;
  const patches = [...E.stroke].map(([ci, before]) => {
    const o = tileOff(E.cells[ci]);
    return { off: o, before, after: S.view.slice(o, o + S.fmt.bytes) };
  });
  E.stroke = null;
  commit(patches);
}

function edPoint(e) {
  const r = edCanvas.getBoundingClientRect();
  return { x: Math.floor((e.clientX - r.left) / r.width * E.w), y: Math.floor((e.clientY - r.top) / r.height * E.h) };
}

function edPick(p) {
  if (p.x < 0 || p.y < 0 || p.x >= E.w || p.y >= E.h) return;
  S.color = E.px[p.y * E.w + p.x];
  renderSwatches($("#ed-pal"));
}

function edFill(p) {
  if (p.x < 0 || p.y < 0 || p.x >= E.w || p.y >= E.h || E.cells[edCellIndex(p.x, p.y)] < 0) return;
  const from = E.px[p.y * E.w + p.x];
  if (from === S.color) return;
  const stack = [p.x, p.y];
  while (stack.length) {
    const y = stack.pop(), x = stack.pop();
    if (x < 0 || y < 0 || x >= E.w || y >= E.h || E.px[y * E.w + x] !== from || E.cells[edCellIndex(x, y)] < 0) continue;
    edSet(x, y, S.color);
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
}

edCanvas.addEventListener("contextmenu", e => e.preventDefault());
edCanvas.addEventListener("pointerdown", e => {
  e.preventDefault();
  const p = edPoint(e);
  if (E.tool === "pick" || e.button === 2) { edPick(p); return; }
  if (e.button > 0) return;
  edCanvas.setPointerCapture(e.pointerId);
  E.stroke = new Map();
  if (E.tool === "fill") {
    edFill(p);
    edFlush();
    edEndStroke();
    return;
  }
  E.last = p;
  edSet(p.x, p.y, S.color);
  edFlush();
});
edCanvas.addEventListener("pointermove", e => {
  if (!E.stroke || !E.last) return;
  const p = edPoint(e);
  // Fill in the pixels between pointer events, so fast strokes don't leave gaps.
  let { x, y } = E.last;
  const dx = Math.abs(p.x - x), dy = -Math.abs(p.y - y), sx = x < p.x ? 1 : -1, sy = y < p.y ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    edSet(x, y, S.color);
    if (x === p.x && y === p.y) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  E.last = p;
  edFlush();
});
for (const ev of ["pointerup", "pointercancel"]) edCanvas.addEventListener(ev, () => { E.last = null; edEndStroke(); });

document.querySelectorAll("[data-tool]").forEach(b => {
  b.onclick = () => {
    E.tool = b.dataset.tool;
    document.querySelectorAll("[data-tool]").forEach(o => o.setAttribute("aria-pressed", o === b));
  };
});
$("#ed-grid").onchange = e => { E.grid = e.target.checked; edDraw(); };
$("#ed-done").onclick = () => $("#editor").close();
$("#editor").addEventListener("close", () => { edEndStroke(); E.px = null; });
$("#edit").onclick = openEditor;

// ---------------------------------------------------------------- tilesets
//
// A tileset is graphics at an offset in the ROM, possibly compressed. Opening one decompresses it into the view;
// writing it compresses the edited data and puts it back, moving it (and updating pointers) if it grew.

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function describe(set) {
  const c = CODECS[set.codec];
  return `${c.short} · 0x${hex(set.off)} · ${set.tiles} tiles${set.codec === "none" ? "" : ` · ${set.size} bytes packed`}`;
}

function renderSets() {
  const ul = $("#sets");
  $("#sets-empty").hidden = S.sets.length > 0;
  ul.replaceChildren(...S.sets.map(set => {
    const li = document.createElement("li");
    li.classList.toggle("current", set === S.cur);
    li.classList.toggle("dirty", !!set.dirty);
    const b = document.createElement("button");
    b.innerHTML = "<b></b><small></small>";
    b.firstChild.textContent = set.name;
    b.lastChild.textContent = describe(set);
    b.onclick = () => openSet(set);
    li.append(b);
    return li;
  }));
  if (S.cur) {
    $("#set-info").innerHTML = "<b></b><small></small>";
    $("#set-info b").textContent = S.cur.name + (S.cur.dirty ? " (not written to the ROM yet)" : "");
    $("#set-info small").textContent = `${CODECS[S.cur.codec].name} at 0x${hex(S.cur.off)} · ${S.cur.tiles} tiles`;
  }
}

function makeSet(fields) {
  const fmt = fmtById[fields.fmt] || S.fmt;
  const set = { id: newId(), cols: 16, layout: "1x1", dirty: false, ...fields, fmt: fmt.id };
  const r = extract(S.rom, set);
  set.size = r.size;
  set.tiles = Math.floor(r.data.length / fmt.bytes);
  if (!set.tiles) throw new Error("That decompresses to less than one tile.");
  return set;
}

function defaultSets(d) {
  if (d.system !== "nes" || !d.chr) return [];
  // NES CHR ROM: one tileset per 4 KB pattern table.
  const sets = [];
  for (let o = 0; o < d.chr; o += 4096) {
    try { sets.push(makeSet({ name: `CHR ${hex(o / 4096)} (tiles ${hex(o / 16, 3)}–${hex(o / 16 + 255, 3)})`, off: d.offset + o, codec: "none", length: Math.min(4096, d.chr - o), fmt: "nes" })); } catch {}
  }
  return sets;
}

function viewSettings() { return { fmt: S.fmt.id, cols: S.cols, layout: S.layout, offset: topOffset() }; }

function applyView(v) {
  S.fmt = fmtById[v.fmt] || S.fmt;
  S.cols = v.cols;
  S.layout = v.layout;
  $("#fmt").value = S.fmt.id;
  $("#cols").value = S.cols;
  $("#layout").value = S.layout;
  S.sel = null;
  showSel();
  setPalette(loadPalette());
}

function openSet(set) {
  if (set === S.cur) return;
  if (!set.dirty || !set.buf) {
    try {
      const r = extract(S.rom, set);
      set.buf = r.data;
      set.size = r.size;
    } catch (err) {
      toast(`${set.name} couldn't be decompressed: ${err.message}`);
      return;
    }
  }
  if (!S.cur) S.romView = viewSettings();
  S.cur = set;
  set.hist ||= newHist();
  S.view = set.buf;
  S.hist = set.hist;
  applyView({ fmt: set.fmt, cols: set.cols, layout: set.layout });
  $("#set-bar").hidden = false;
  $("#jump").hidden = true;
  showHistory();
  renderSets();
  gotoOffset(0);
}

function backToRom() {
  if (!S.cur) return;
  S.cur = null;
  S.view = S.rom;
  S.hist = S.romHist;
  $("#set-bar").hidden = true;
  $("#jump").hidden = !S.jump;
  const v = S.romView || { fmt: S.fmt.id, cols: 16, layout: "1x1", offset: 0 };
  applyView(v);
  showHistory();
  renderSets();
  gotoOffset(v.offset);
}

// Compresses the given tilesets and writes them into the ROM, as one undoable change. Data that no longer fits is
// moved, after asking. Every write is decompressed again and compared before it's kept.
async function writeSets(sets) {
  let work = S.rom;
  const errors = [], moves = [], metas = [];
  for (const set of sets) {
    try {
      if (!set.buf) continue;
      const codec = CODECS[set.codec];
      const comp = codec.compress(set.buf);
      const others = S.sets.filter(o => o !== set);
      const p = plan(work, set, comp, S.system, others, S.header);
      if (p.error) { errors.push(p.error); continue; }
      const next = place(work === S.rom ? work.slice() : work, p, comp, S.header);
      const check = extract(next, { ...set, off: p.at });
      if (check.data.length < set.buf.length || set.buf.some((b, i) => b !== check.data[i])) {
        throw new Error("the recompressed data didn't decompress back to the same tiles, so it wasn't written");
      }
      work = next;
      if (p.at !== set.off) moves.push(`${set.name}: 0x${hex(set.off)} → 0x${hex(p.at)}, ${p.pointers.length} pointer${p.pointers.length === 1 ? "" : "s"} updated (at ${p.pointers.map(x => "0x" + hex(x.at)).join(", ")})${p.grow ? `, ROM enlarged to ${(p.grow / 1024) | 0} KB` : ""}`);
      metas.push({ entry: set.id, before: { off: set.off, size: set.size, dirty: set.dirty }, after: { off: p.at, size: check.size, dirty: false } });
    } catch (err) {
      errors.push(`${set.name}: ${err.message}`);
    }
  }
  if (moves.length && !confirm(`Some graphics grew too big for their old space and need to move:\n\n${moves.join("\n")}\n\nThe game finds them through those pointers. Go ahead?`)) return false;
  if (metas.length) {
    const ops = [];
    if (work.length !== S.rom.length) ops.push({ swap: { before: S.rom, after: work } });
    else {
      for (let i = 0; i < work.length; i++) {
        if (work[i] === S.rom[i]) continue;
        let j = i;
        while (j < work.length && (work[j] !== S.rom[j] || (j + 16 < work.length && work.subarray(j, j + 16).some((b, k) => b !== S.rom[j + k])))) j++;
        ops.push({ off: i, before: S.rom.slice(i, j), after: work.slice(i, j) });
        i = j;
      }
    }
    ops.push(...metas);
    // The new bytes go in through the ROM's own history, so "Undo" in the ROM view takes the write back.
    const romWasView = S.view === S.rom;
    applyOps(ops.filter(o => o.entry), "after");
    if (ops[0].swap) S.rom = work;
    else for (const o of ops) if (o.after && !o.entry) S.rom.set(o.after, o.off);
    if (romWasView) S.view = S.rom;
    S.romHist.undo.push(ops);
    S.romHist.redo = [];
    $("#rom-info").textContent = `${(S.rom.length / 1024).toFixed(0)} KB. ${S.info || ""}`;
    layout();
    changed();
  }
  if (errors.length) alert(`Not written:\n\n${errors.join("\n\n")}`);
  return !errors.length;
}

$("#set-write").onclick = async () => {
  if (!S.cur) return;
  const set = S.cur;
  if (await writeSets([set])) toast(`${set.name} was compressed and written into the ROM (${set.size} bytes).`);
};
$("#set-back").onclick = backToRom;
$("#set-rename").onclick = () => {
  const name = prompt("Name this tileset", S.cur.name);
  if (name?.trim()) { S.cur.name = name.trim(); renderSets(); saveSoon(); }
};
$("#set-remove").onclick = () => {
  const set = S.cur;
  if (set.dirty && !confirm(`${set.name} has edits that haven't been written into the ROM. Remove it anyway?`)) return;
  backToRom();
  S.sets = S.sets.filter(s => s !== set);
  renderSets();
  saveSoon();
};
$("#set-png").onclick = async () => {
  const set = S.cur, { w, h, px } = toPixels(S.fmt, set.buf, set.cols, set.layout);
  download(await indexedPNG(w, h, px, S.pal), `${baseName()}-${slug(set.name)}.png`);
  toast("Exported. Keep the size and the palette's colors, then use Import tileset to bring it back.");
};
$("#set-import").onclick = () => { setImport = true; $("#png-file").click(); };

let setImport = false;
$("#png-file").addEventListener("change", e => {
  const f = e.target.files[0], whole = setImport;
  setImport = false;
  e.target.value = "";
  if (!f) return;
  if (whole) importSetImage(f);
  else importImage(f);
});

// Replaces the whole open tileset from a PNG of the same size.
async function importSetImage(file) {
  const set = S.cur;
  let im;
  try { im = await readImage(file); } catch { toast("That image couldn't be read."); return; }
  const { w, h } = toPixels(S.fmt, set.buf, set.cols, set.layout);
  if (im.width !== w || im.height !== h) {
    toast(`That image is ${im.width}×${im.height}, but ${set.name} is ${w}×${h} with ${set.cols} columns. Keep the exported size.`);
    return;
  }
  const colors = colorMapper(S.pal), px = new Uint8Array(w * h);
  for (let i = 0; i < px.length; i++) px[i] = colors.index(im.data[4 * i], im.data[4 * i + 1], im.data[4 * i + 2], im.data[4 * i + 3]);
  const after = fromPixels(S.fmt, set.buf, set.cols, set.layout, px);
  commit([{ off: 0, before: set.buf.slice(), after }]);
  set.buf.set(after);
  draw();
  toast(`Imported into ${set.name}.${colors.inexact ? ` ${colors.inexact} pixels weren't palette colors and were matched to the nearest one.` : ""} Press Write to ROM when you're ready.`);
}

// ---- finding and adding tilesets

$("#scan").onclick = async () => {
  const btn = $("#scan");
  if (S.system === "nes") {
    const add = defaultSets(detect(S.name, S.rom)).filter(n => !S.sets.some(s => s.off === n.off && s.codec === n.codec));
    S.sets.push(...add);
    renderSets();
    saveSoon();
    toast(add.length ? `Added ${add.length} CHR banks.`
      : S.sets.length ? "The CHR banks are already listed. Graphics stored elsewhere in NES games use each game's own compression, so add them by offset."
        : "This game has no CHR ROM. Its graphics are in PRG ROM, usually in a compression of its own, so add them by offset with Uncompressed if they show up as tiles in the ROM view.");
    return;
  }
  if (S.system !== "gba" && S.system !== "md") {
    toast("Automatic search works for GBA (LZ77) and Genesis (Nemesis) games. For this one, use Add… with the offset and compression the game uses.");
    return;
  }
  btn.disabled = true;
  try {
    const found = await findGraphics(S.rom, S.system, f => { btn.textContent = `Searching… ${Math.round(f * 100)}%`; });
    const fmt = S.system === "gba" ? "gba4" : "md";
    const add = found.filter(f => !S.sets.some(s => s.off === f.off)).map(f => ({
      id: newId(), name: `${CODECS[f.codec].short} at ${hex(f.off)}`, off: f.off, codec: f.codec, size: f.size,
      fmt, cols: 16, layout: "1x1", tiles: Math.floor(f.bytes / fmtById[fmt].bytes), dirty: false,
    })).filter(s => s.tiles > 0);
    S.sets.push(...add);
    S.sets.sort((a, b) => a.off - b.off);
    renderSets();
    saveSoon();
    toast(add.length ? `Found ${add.length} compressed graphics. Open one to see it; some may be other data, which you can remove.` : "No compressed graphics found.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Find graphics";
  }
};

$("#add-codec").replaceChildren(...Object.entries(CODECS).map(([id, c]) => new Option(c.name, id)));
$("#add-fmt").replaceChildren(...FORMATS.map(f => new Option(f.name, f.id)));
const showLen = () => { $("#add-len-row").hidden = $("#add-codec").value !== "none"; };
$("#add-codec").onchange = showLen;

$("#add-set").onclick = () => {
  let off = 0, len = 256;
  if (!S.cur) {
    off = topOffset();
    if (S.sel) {
      const { cells } = selTiles(), first = cells.find(i => i >= 0);
      if (first !== undefined) { off = tileOff(first); len = cells.filter(i => i >= 0).length; }
    }
  } else off = S.cur.off;
  $("#add-name").value = "";
  $("#add-off").value = hex(off);
  $("#add-len").value = len;
  $("#add-codec").value = { gba: "lz77", md: "nemesis", snes: "lz2" }[S.system] || "none";
  $("#add-fmt").value = S.fmt.id;
  $("#add-err").hidden = true;
  showLen();
  $("#add-dlg").showModal();
};
$("#add-cancel").onclick = () => $("#add-dlg").close();
$("#add-form").addEventListener("submit", e => {
  e.preventDefault();
  const off = parseInt($("#add-off").value.replace(/^(0x|\$)/i, ""), 16), codec = $("#add-codec").value;
  const fmt = fmtById[$("#add-fmt").value];
  const err = msg => { $("#add-err").textContent = msg; $("#add-err").hidden = false; };
  if (!Number.isFinite(off) || off < 0 || off >= S.rom.length) return err("Enter an offset inside the ROM, in hex.");
  const fields = { name: $("#add-name").value.trim() || `${CODECS[codec].short} at ${hex(off)}`, off, codec, fmt: fmt.id };
  if (codec === "none") {
    const n = parseInt($("#add-len").value, 10);
    if (!(n > 0)) return err("Enter how many tiles long it is.");
    fields.length = Math.min(n * fmt.bytes, S.rom.length - off);
  }
  let set;
  try { set = makeSet(fields); } catch (ex) { return err(`That didn't work: ${ex.message} Check the offset and compression.`); }
  S.sets.push(set);
  S.sets.sort((a, b) => a.off - b.off);
  $("#add-dlg").close();
  openSet(set);
  saveSoon();
});

// ---- exporting and importing every tileset as PNGs

$("#zip-export").onclick = async () => {
  if (!S.sets.length) { toast("There are no tilesets to export. Find graphics or add one first."); return; }
  const files = [], manifest = { app: "TileSmith", version: 1, rom: S.name, tilesets: [] };
  const btn = $("#zip-export");
  btn.disabled = true;
  try {
    for (const [i, set] of S.sets.entries()) {
      let data = set.buf;
      if (!set.dirty || !data) {
        try { data = set.buf = extract(S.rom, set).data; } catch { continue; }
      }
      const fmt = fmtById[set.fmt], pal = loadPalette(fmt);
      const { w, h, px } = toPixels(fmt, data, set.cols, set.layout);
      set.file = `${String(i + 1).padStart(2, "0")}-${slug(set.name)}.png`;
      files.push({ name: set.file, data: new Uint8Array(await (await indexedPNG(w, h, px, pal)).arrayBuffer()) });
      manifest.tilesets.push({ file: set.file, id: set.id, name: set.name, off: set.off, codec: set.codec, length: set.length,
        fmt: set.fmt, cols: set.cols, layout: set.layout, palette: pal.map(c => "#" + hex(c, 6)) });
    }
    files.push({ name: "tilesmith.json", data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
    files.push({ name: "README.txt", data: new TextEncoder().encode(
      `Graphics from ${S.name}, decompressed by TileSmith.\n\nEdit the PNGs in any paint program. Keep each image's size, and use only the colors already in it\n(the PNGs are indexed, so most editors will keep you to that palette). Then open the ROM in TileSmith,\nchoose Import PNGs, and pick this ZIP (or the PNGs and tilesmith.json). Edited tilesets are compressed\nand written back into the ROM; ones you didn't change are left alone.\n`) });
    download(zip(files), `${baseName()}-graphics.zip`);
    saveSoon();
  } finally {
    btn.disabled = false;
  }
};

$("#zip-import").onclick = () => $("#zip-file").click();
$("#zip-file").addEventListener("change", async e => {
  const picked = [...e.target.files];
  e.target.value = "";
  if (picked.length) importPNGs(picked);
});

async function importPNGs(picked) {
  let files = [];
  try {
    for (const f of picked) {
      const data = new Uint8Array(await f.arrayBuffer());
      if (/\.zip$/i.test(f.name) || (data[0] === 0x50 && data[1] === 0x4b)) files.push(...await unzip(data));
      else files.push({ name: f.name, data });
    }
  } catch (err) { toast(err.message); return; }
  const base = n => n.split("/").pop();
  let manifest = null;
  const mf = files.find(f => base(f.name) === "tilesmith.json");
  if (mf) try { manifest = JSON.parse(new TextDecoder().decode(mf.data)); } catch { toast("tilesmith.json couldn't be read."); return; }
  if (manifest && manifest.rom !== S.name && !confirm(`These PNGs were exported from ${manifest.rom}, but ${S.name} is open. Import them anyway?`)) return;

  const changedSets = [], notes = [];
  let unchanged = 0;
  for (const f of files.filter(f => /\.png$/i.test(f.name) && !base(f.name).startsWith("._"))) {
    const name = base(f.name), info = manifest?.tilesets.find(t => t.file === name);
    let set = info ? S.sets.find(s => s.id === info.id) : S.sets.find(s => s.file === name);
    try {
      if (!set && info) {
        set = makeSet({ id: info.id, name: info.name, off: info.off, codec: info.codec, length: info.length, fmt: info.fmt, cols: info.cols, layout: info.layout });
        S.sets.push(set);
      }
      if (!set) { notes.push(`${name}: not one of this ROM's tilesets, skipped.`); continue; }
      if (!set.dirty || !set.buf) set.buf = extract(S.rom, set).data;
      const fmt = fmtById[set.fmt], pal = info ? info.palette.map(c => parseInt(c.slice(1), 16)) : loadPalette(fmt);
      const im = await readImage(new Blob([f.data], { type: "image/png" }));
      const { w, h } = toPixels(fmt, set.buf, set.cols, set.layout);
      if (im.width !== w || im.height !== h) { notes.push(`${name}: is ${im.width}×${im.height} but should be ${w}×${h}, skipped.`); continue; }
      const colors = colorMapper(pal), px = new Uint8Array(w * h);
      for (let i = 0; i < px.length; i++) px[i] = colors.index(im.data[4 * i], im.data[4 * i + 1], im.data[4 * i + 2], im.data[4 * i + 3]);
      const data = fromPixels(fmt, set.buf, set.cols, set.layout, px);
      if (data.every((b, i) => b === set.buf[i]) && !set.dirty) { unchanged++; continue; }
      if (colors.inexact) notes.push(`${name}: ${colors.inexact} pixels weren't palette colors and were matched to the nearest one.`);
      set.buf = data;
      set.dirty = true;
      set.hist = newHist();
      changedSets.push(set);
    } catch (err) {
      notes.push(`${name}: ${err.message}`);
    }
  }
  if (S.cur && changedSets.includes(S.cur)) { S.view = S.cur.buf; S.hist = S.cur.hist; layout(); }
  renderSets();
  if (!changedSets.length) {
    toast(`Nothing to write: ${unchanged} PNG${unchanged === 1 ? " was" : "s were"} unchanged.${notes.length ? " " + notes.join(" ") : ""}`);
    return;
  }
  const ok = await writeSets(changedSets);
  const written = changedSets.filter(s => !s.dirty).length;
  toast(`Wrote ${written} edited tileset${written === 1 ? "" : "s"} into the ROM${unchanged ? `, ${unchanged} unchanged` : ""}.${ok ? "" : " Some couldn't be written; they're marked \"not written\"."}${notes.length ? " " + notes.join(" ") : ""}`);
}

// ---------------------------------------------------------------- opening, saving, closing

async function openFile(file) {
  const rom = new Uint8Array(await file.arrayBuffer());
  if (!rom.length) { toast("That file is empty."); return; }
  if (S.rom && S.unsaved && !confirm(`Open ${file.name}? Changes to ${S.name} that you haven't saved will be lost.`)) return;
  const d = detect(file.name, rom);
  start({ name: file.name, orig: rom.slice(), rom, fmt: d.fmt, offset: d.offset, info: d.info, jump: d.jump, system: d.system, header: d.header });
  S.sets = defaultSets(d);
  renderSets();
  await idbPut("orig", S.orig).catch(() => {});
  saveNow();
}

// Shows a ROM. `v` is either a freshly opened file or a session restored from IndexedDB.
function start(v) {
  Object.assign(S, {
    name: v.name, orig: v.orig, rom: v.rom, view: v.rom, fmt: fmtById[v.fmt] || fmtById.nes, cols: v.cols || 16,
    layout: v.layout || "1x1", jump: v.jump || null, sel: null, romHist: newHist(), unsaved: !!v.unsaved,
    system: v.system || "other", header: v.header || 0, sets: v.sets || [], cur: null, info: v.info, romView: null,
  });
  S.hist = S.romHist;
  document.body.classList.add("open");
  $("#welcome").hidden = true;
  $("#work").hidden = false;
  $("#set-bar").hidden = true;
  $("#rom-name").textContent = S.name;
  $("#fmt").value = S.fmt.id;
  $("#cols").value = S.cols;
  $("#layout").value = S.layout;
  $("#rom-info").textContent = `${(S.rom.length / 1024).toFixed(0)} KB. ${v.info || ""}`;
  $("#jump").hidden = !S.jump;
  if (S.jump) $("#jump").textContent = `Go to ${S.jump.label} (0x${hex(S.jump.offset)})`;
  setPalette(loadPalette());
  showSel();
  changed();
  S.unsaved = !!v.unsaved;
  gotoOffset(v.offset || 0);
}

// Edited tilesets only reach the ROM when they're written; offer to do that before saving.
async function writePending() {
  const dirty = S.sets.filter(s => s.dirty);
  if (!dirty.length) return true;
  if (!confirm(`${dirty.length} tileset${dirty.length === 1 ? " has" : "s have"} edits that aren't in the ROM yet (${dirty.map(s => s.name).join(", ")}). Write ${dirty.length === 1 ? "it" : "them"} into the ROM first?`)) return true;
  return writeSets(dirty);
}

function outputRom() {
  const out = S.rom.slice();
  const msg = S.fixsum ? fixChecksum(out) : null;
  return { out, msg };
}

$("#save").onclick = async () => {
  await writePending();
  const { out, msg } = outputRom();
  const ext = (S.name.match(/\.[^.]+$/) || [""])[0];
  download(new Blob([out]), `${baseName()}-edited${ext}`);
  S.unsaved = false;
  if (msg) toast(msg);
};

$("#ips").onclick = async () => {
  await writePending();
  const { out } = outputRom();
  let patch;
  try { patch = makeIPS(S.orig, out); } catch (err) { toast(err.message); return; }
  if (!patch) { toast("There are no changes to put in a patch yet."); return; }
  download(new Blob([patch]), `${baseName()}.ips`);
  S.unsaved = false;
};

$("#close").onclick = async () => {
  if ((S.unsaved || S.sets.some(s => s.dirty)) && !confirm("Close this ROM? Changes you haven't saved will be lost.")) return;
  clearTimeout(saveTimer);
  S.rom = S.view = S.cur = null;
  document.body.classList.remove("open");
  $("#work").hidden = true;
  $("#welcome").hidden = false;
  $("#rom-name").textContent = "";
  await idbDel("session").catch(() => {});
  await idbDel("orig").catch(() => {});
};

for (const id of ["#rom-file", "#rom-file-2"]) {
  $(id).addEventListener("change", e => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) openFile(f);
  });
}

addEventListener("dragover", e => { e.preventDefault(); document.body.classList.add("dragging"); });
addEventListener("dragleave", e => { if (!e.relatedTarget) document.body.classList.remove("dragging"); });
addEventListener("drop", e => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  const fs = [...e.dataTransfer.files];
  if (!fs.length) return;
  if (S.rom && fs.some(f => /\.(zip|json)$/i.test(f.name) || fs.length > 1)) importPNGs(fs);
  else if (S.rom && /^image\//.test(fs[0].type)) (S.cur && !S.sel ? importSetImage : importImage)(fs[0]);
  else openFile(fs[0]);
});

// ---------------------------------------------------------------- view settings

// In a tileset, the format and grid belong to the tileset (and go into its PNGs).
const rememberView = () => { if (S.cur) Object.assign(S.cur, { fmt: S.fmt.id, cols: S.cols, layout: S.layout }); saveSoon(); };

$("#fmt").replaceChildren(...FORMATS.map(f => new Option(f.name, f.id)));
$("#fmt").onchange = e => {
  const o = topOffset();
  S.fmt = fmtById[e.target.value];
  S.sel = null;
  showSel();
  setPalette(loadPalette());
  if (S.cur) S.cur.tiles = Math.floor(S.view.length / S.fmt.bytes);
  rememberView();
  gotoOffset(o);
  renderSets();
};
$("#cols").onchange = e => { const o = topOffset(); S.cols = +e.target.value; fitLayout(); rememberView(); gotoOffset(o); };
$("#layout").onchange = e => { const o = topOffset(); S.layout = e.target.value; fitLayout(); rememberView(); gotoOffset(o); };
function fitLayout() {
  if (S.cols < LAYOUTS[S.layout][0]) { S.cols = LAYOUTS[S.layout][0]; $("#cols").value = S.cols; }
  S.sel = null;
  showSel();
}
$("#grid").onchange = e => { S.grid = e.target.checked; draw(); };
$("#fixsum").onchange = e => { S.fixsum = e.target.checked; };
$("#offset").addEventListener("change", e => {
  const o = parseInt(e.target.value.replace(/^(0x|\$|\+)/i, "").replace(/^0x/i, ""), 16);
  if (Number.isFinite(o)) gotoOffset(o);
  else showOffset();
});
$("#offset").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });
$("#offset").addEventListener("blur", showOffset);
const nudge = d => { gotoOffset(topOffset() + d); showSel(); };
$("#byte-back").onclick = () => nudge(-1);
$("#byte-fwd").onclick = () => nudge(1);
$("#jump").onclick = () => S.jump && gotoOffset(S.jump.offset);

addEventListener("keydown", e => {
  if (!S.rom || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || document.querySelector("dialog[open]:not(#editor)")) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
  else if (!mod && !$("#editor").open && (e.key === "e" || e.key === "Enter")) { e.preventDefault(); openEditor(); }
});

// ---------------------------------------------------------------- keeping work across reloads

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("tilesmith", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", mode), req = fn(tx.objectStore("kv"));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}
const idbGet = k => idbDo("readonly", s => s.get(k));
const idbPut = (k, v) => idbDo("readwrite", s => s.put(v, k));
const idbDel = k => idbDo("readwrite", s => s.delete(k));

let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  if (S.rom) saveTimer = setTimeout(saveNow, 800);
}
function saveNow() {
  if (!S.rom) return;
  const romView = S.cur ? S.romView : viewSettings();
  idbPut("session", {
    name: S.name, rom: S.rom, ...romView, info: S.info, jump: S.jump, unsaved: S.unsaved, system: S.system, header: S.header,
    sets: S.sets.map(({ hist, buf, ...set }) => (set.dirty ? { ...set, buf } : set)), cur: S.cur?.id,
  }).catch(() => {});
}
addEventListener("pagehide", saveNow);

let toastTimer = 0;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2500 + msg.length * 40);
}

if (matchMedia("(max-width: 760px)").matches) document.querySelectorAll("#side details").forEach(d => { d.open = false; });

(async () => {
  try {
    const [v, orig] = await Promise.all([idbGet("session"), idbGet("orig")]);
    if (!v?.rom || !orig) return;
    start({ ...v, orig });
    renderSets();
    const cur = S.sets.find(s => s.id === v.cur);
    if (cur) openSet(cur);
  } catch {}
})();

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js");
