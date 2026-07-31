/**
 * Minimal QR encoder: byte mode, error-correction level M, versions 1-10.
 * ISO/IEC 18004. Written here so the invite sheet never makes a network request to
 * a QR service - the invite URL contains the channel name, and handing that to a
 * third party would undo half the point of the app.
 *
 * Scope on purpose: byte mode only (URLs), level M, up to version 10 (271 bytes).
 * Anything longer throws and the UI falls back to showing the link as text.
 */

/** Data codewords available at level M, indexed by version (1-10). */
const DATA_CODEWORDS: readonly number[] = [0, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216];
/** EC codewords per block at level M. */
const EC_PER_BLOCK: readonly number[] = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
/** Block layout at level M: [count, dataCodewords] groups. */
const BLOCKS: readonly (readonly [number, number][])[] = [
  [],
  [[1, 16]],
  [[1, 28]],
  [[1, 44]],
  [[2, 32]],
  [[2, 43]],
  [[4, 27]],
  [[4, 31]],
  [
    [2, 38],
    [2, 39],
  ],
  [
    [3, 36],
    [2, 37],
  ],
  [
    [4, 43],
    [1, 44],
  ],
];
/** Alignment pattern centre coordinates by version. */
const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/* -------------------------------------------------------------- GF(256) */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // QR primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] as number;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] as number) + (LOG[b] as number)] as number;
}

/** Reed-Solomon generator polynomial of the given degree. */
function generatorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] as number) ^ (poly[j] as number);
      next[j + 1] = (next[j + 1] as number) ^ gfMul(poly[j] as number, EXP[i] as number);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon error correction codewords for one block. */
function ecCodewords(data: Uint8Array, count: number): Uint8Array {
  const gen = generatorPoly(count);
  const res = new Uint8Array(data.length + count);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = res[i] as number;
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      res[i + j] = (res[i + j] as number) ^ gfMul(gen[j] as number, factor);
    }
  }
  return res.subarray(data.length);
}

/* ------------------------------------------------------------ bit stream */

class Bits {
  readonly bits: number[] = [];
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
  get length(): number {
    return this.bits.length;
  }
}

/* ------------------------------------------------------------ BCH helpers */

function bch(value: number, poly: number, polyBits: number): number {
  let v = value;
  while (msb(v) >= polyBits) v ^= poly << (msb(v) - polyBits);
  return v;
}

function msb(v: number): number {
  let n = 0;
  while (v !== 0) {
    n++;
    v >>= 1;
  }
  return n;
}

/** 15-bit format information for level M and the chosen mask. */
function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // level M = 00
  const rem = bch(data << 10, 0x537, 11);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18-bit version information, required from version 7. */
function versionBits(version: number): number {
  const rem = bch(version << 12, 0x1f25, 13);
  return (version << 12) | rem;
}

/* --------------------------------------------------------------- encoder */

export interface QrCode {
  size: number;
  version: number;
  /** Row-major modules; true = dark. */
  modules: boolean[][];
}

function pickVersion(byteLength: number): number {
  for (let v = 1; v <= 10; v++) {
    const countBits = v < 10 ? 8 : 16;
    const capacity = (DATA_CODEWORDS[v] as number) * 8;
    if (4 + countBits + byteLength * 8 <= capacity) return v;
  }
  throw new Error(`qr: ${byteLength} bytes does not fit in version 10 at level M`);
}

/** Encode a string as a QR code. Throws if it is too long for version 10. */
export function encodeQr(text: string): QrCode {
  const data = new TextEncoder().encode(text);
  const version = pickVersion(data.length);
  const totalData = DATA_CODEWORDS[version] as number;

  const bits = new Bits();
  bits.push(0b0100, 4); // byte mode
  bits.push(data.length, version < 10 ? 8 : 16);
  for (const b of data) bits.push(b, 8);
  // Terminator, then pad to a byte boundary, then the standard pad bytes.
  const capacity = totalData * 8;
  bits.push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0, 1);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits.bits[i + j] as number);
    codewords.push(byte);
  }
  for (let pad = 0; codewords.length < totalData; pad++) {
    codewords.push(pad % 2 === 0 ? 0xec : 0x11);
  }

  // Split into blocks, compute EC, then interleave (ISO/IEC 18004 §7.6).
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  const ecCount = EC_PER_BLOCK[version] as number;
  let offset = 0;
  for (const [count, size] of BLOCKS[version] as readonly [number, number][]) {
    for (let i = 0; i < count; i++) {
      const block = new Uint8Array(codewords.slice(offset, offset + size));
      offset += size;
      dataBlocks.push(block);
      ecBlocks.push(ecCodewords(block, ecCount));
    }
  }
  const interleaved: number[] = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of dataBlocks) if (i < b.length) interleaved.push(b[i] as number);
  }
  for (let i = 0; i < ecCount; i++) {
    for (const b of ecBlocks) interleaved.push(b[i] as number);
  }

  const finalBits: number[] = [];
  for (const byte of interleaved) {
    for (let i = 7; i >= 0; i--) finalBits.push((byte >> i) & 1);
  }

  const size = 17 + version * 4;
  const modules: (boolean | null)[][] = Array.from({ length: size }, () =>
    new Array<boolean | null>(size).fill(null),
  );
  drawFunctionPatterns(modules, version, size);
  placeData(modules, finalBits, size);

  const mask = chooseMask(modules, size);
  applyMask(modules, mask, size);
  drawFormat(modules, mask, size);
  if (version >= 7) drawVersion(modules, version, size);

  return {
    size,
    version,
    modules: modules.map((row) => row.map((m) => m === true)),
  };
}

type Grid = (boolean | null)[][];

function set(grid: Grid, r: number, c: number, dark: boolean): void {
  const row = grid[r];
  if (row) row[c] = dark;
}

function get(grid: Grid, r: number, c: number): boolean | null {
  return grid[r]?.[c] ?? null;
}

function drawFinder(grid: Grid, r: number, c: number): void {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= grid.length || cc >= grid.length) continue;
      const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
      set(grid, rr, cc, ring !== 2 && ring <= 3);
    }
  }
}

function drawFunctionPatterns(grid: Grid, version: number, size: number): void {
  drawFinder(grid, 0, 0);
  drawFinder(grid, 0, size - 7);
  drawFinder(grid, size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    set(grid, 6, i, dark);
    set(grid, i, 6, dark);
  }

  // Alignment patterns, skipping the three finder corners.
  const centres = ALIGNMENT[version] as readonly number[];
  for (const r of centres) {
    for (const c of centres) {
      const nearFinder =
        (r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          set(grid, r + dr, c + dc, ring !== 1);
        }
      }
    }
  }

  // Reserve the format areas (written for real in drawFormat) and the dark module.
  for (let i = 0; i < 9; i++) {
    if (get(grid, 8, i) === null) set(grid, 8, i, false);
    if (get(grid, i, 8) === null) set(grid, i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    set(grid, 8, size - 1 - i, false);
    set(grid, size - 1 - i, 8, false);
  }
  set(grid, size - 8, 8, true); // dark module

  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        set(grid, size - 11 + j, i, false);
        set(grid, i, size - 11 + j, false);
      }
    }
  }
}

function placeData(grid: Grid, bits: number[], size: number): void {
  let bit = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // the vertical timing pattern column is skipped
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (get(grid, row, c) !== null) continue;
        set(grid, row, c, (bits[bit++] ?? 0) === 1);
      }
    }
    upward = !upward;
  }
}

function maskAt(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

/** Function-pattern modules must never be masked; they are the ones we drew first. */
function isFunctionModule(version: number, size: number, r: number, c: number): boolean {
  if (r === 6 || c === 6) return true;
  if (r < 9 && c < 9) return true;
  if (r < 9 && c >= size - 8) return true;
  if (r >= size - 8 && c < 9) return true;
  if (version >= 7) {
    if (r < 6 && c >= size - 11) return true;
    if (c < 6 && r >= size - 11) return true;
  }
  const centres = ALIGNMENT[version] as readonly number[];
  for (const cr of centres) {
    for (const cc of centres) {
      const nearFinder =
        (cr === 6 && cc === 6) || (cr === 6 && cc === size - 7) || (cr === size - 7 && cc === 6);
      if (nearFinder) continue;
      if (Math.abs(r - cr) <= 2 && Math.abs(c - cc) <= 2) return true;
    }
  }
  return false;
}

function applyMask(grid: Grid, mask: number, size: number): void {
  const version = (size - 17) / 4;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (isFunctionModule(version, size, r, c)) continue;
      if (maskAt(mask, r, c)) set(grid, r, c, get(grid, r, c) !== true);
    }
  }
}

/** Try all eight masks and keep the one with the lowest penalty (§7.8.3). */
function chooseMask(grid: Grid, size: number): number {
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const trial = grid.map((row) => row.slice());
    applyMask(trial, mask, size);
    const score = penalty(trial, size);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
  }
  return best;
}

function penalty(grid: Grid, size: number): number {
  const at = (r: number, c: number): boolean => get(grid, r, c) === true;
  let score = 0;

  // Rule 1: runs of five or more identical modules.
  for (let i = 0; i < size; i++) {
    for (const rowMode of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const a = rowMode ? at(i, j) : at(j, i);
        const b = rowMode ? at(i, j - 1) : at(j - 1, i);
        if (a === b) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns with four light modules beside them.
  const p1 = [true, false, true, true, true, false, true, false, false, false, false];
  const p2 = [false, false, false, false, true, false, true, true, true, false, true];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 11 <= size; j++) {
      let m1 = true;
      let m2 = true;
      let n1 = true;
      let n2 = true;
      for (let k = 0; k < 11; k++) {
        const rowVal = at(i, j + k);
        const colVal = at(j + k, i);
        if (rowVal !== p1[k]) m1 = false;
        if (rowVal !== p2[k]) m2 = false;
        if (colVal !== p1[k]) n1 = false;
        if (colVal !== p2[k]) n2 = false;
      }
      if (m1 || m2) score += 40;
      if (n1 || n2) score += 40;
    }
  }

  // Rule 4: deviation from 50% dark.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (at(r, c)) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

function drawFormat(grid: Grid, mask: number, size: number): void {
  const bits = formatBits(mask);
  // Coordinates are (row, col). The layout is not symmetric, so the two copies
  // walk different axes: ISO/IEC 18004 §7.9.1, figure 25.
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1;
    // Copy 1: up the left of the top-left finder, then along the top.
    if (i < 6) set(grid, i, 8, dark);
    else if (i === 6) set(grid, 7, 8, dark);
    else if (i === 7) set(grid, 8, 8, dark);
    else if (i === 8) set(grid, 8, 7, dark);
    else set(grid, 8, 14 - i, dark);
    // Copy 2: along row 8 on the right, then down column 8 at the bottom.
    if (i < 8) set(grid, 8, size - 1 - i, dark);
    else set(grid, size - 15 + i, 8, dark);
  }
  set(grid, size - 8, 8, true);
}

function drawVersion(grid: Grid, version: number, size: number): void {
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >> i) & 1) === 1;
    const a = Math.floor(i / 3);
    const b = (i % 3) + size - 11;
    set(grid, a, b, dark);
    set(grid, b, a, dark);
  }
}

/**
 * Draw a QR code onto a canvas, with the mandatory 4-module quiet zone.
 * Colours are read from CSS custom properties so light mode works too.
 */
export function drawQr(canvas: HTMLCanvasElement, text: string, dark: string, light: string): void {
  const qr = encodeQr(text);
  const quiet = 4;
  const total = qr.size + quiet * 2;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const px = Math.max(2, Math.floor((canvas.clientWidth * dpr) / total));
  const side = px * total;
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = dark;
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r]?.[c]) ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
    }
  }
}
