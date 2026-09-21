// Minimal, dependency-free QR Code generator (ISO/IEC 18004).
// Byte mode, error-correction level M, versions 1–14 (up to ~360 bytes) —
// plenty for a social-media page link. The offline POS cannot download a library,
// so the encoder lives here.

// [ecCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], ...]] for level M
const BLOCKS_M: Record<number, [number, Array<[number, number]>]> = {
  1: [10, [[1, 16]]],
  2: [16, [[1, 28]]],
  3: [26, [[1, 44]]],
  4: [18, [[2, 32]]],
  5: [24, [[2, 43]]],
  6: [16, [[4, 27]]],
  7: [18, [[4, 31]]],
  8: [22, [[2, 38], [2, 39]]],
  9: [22, [[3, 36], [2, 37]]],
  10: [26, [[4, 43], [1, 44]]],
  11: [30, [[1, 50], [4, 51]]],
  12: [22, [[6, 36], [2, 37]]],
  13: [22, [[8, 37], [1, 38]]],
  14: [24, [[4, 40], [5, 41]]],
};

const ALIGNMENT: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38],
  8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58],
  13: [6, 34, 62], 14: [6, 26, 46, 66],
};

const MAX_VERSION = 14;

// ─── GF(256) / Reed-Solomon ────────────────────────────────
const EXP = new Array<number>(512);
const LOG = new Array<number>(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: number[], degree: number): number[] {
  const gen = rsGenerator(degree);
  const result = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.shift();
    result.push(0);
    for (let i = 0; i < degree; i++) result[i] ^= gfMul(gen[i + 1], factor);
  }
  return result;
}

// ─── Data encoding ─────────────────────────────────────────
function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function dataCapacity(version: number): number {
  const [, groups] = BLOCKS_M[version];
  return groups.reduce((sum, [count, size]) => sum + count * size, 0);
}

function buildCodewords(bytes: number[], version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);

  const capacityBits = dataCapacity(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  for (let pad = 0xec; data.length < dataCapacity(version); pad = pad === 0xec ? 0x11 : 0xec) data.push(pad);

  // Split into blocks, add Reed-Solomon codewords, interleave.
  const [ecLen, groups] = BLOCKS_M[version];
  const dataBlocks: number[][] = [];
  let offset = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      dataBlocks.push(data.slice(offset, offset + size));
      offset += size;
    }
  }
  const ecBlocks = dataBlocks.map((block) => rsRemainder(block, ecLen));
  const result: number[] = [];
  const maxData = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < maxData; i++) for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  for (let i = 0; i < ecLen; i++) for (const block of ecBlocks) result.push(block[i]);
  return result;
}

// ─── Matrix construction ───────────────────────────────────
function bchFormat(data: number): number {
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function bchVersion(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

interface Grid {
  size: number;
  modules: boolean[][];
  reserved: boolean[][];
}

function newGrid(version: number): Grid {
  const size = version * 4 + 17;
  return {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function setFunction(grid: Grid, x: number, y: number, dark: boolean) {
  if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) return;
  grid.modules[y][x] = dark;
  grid.reserved[y][x] = true;
}

function drawFinder(grid: Grid, cx: number, cy: number) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(grid, cx + dx, cy + dy, dist !== 2 && dist !== 4);
    }
  }
}

function drawFunctionPatterns(grid: Grid, version: number) {
  const { size } = grid;
  for (let i = 0; i < size; i++) {
    setFunction(grid, 6, i, i % 2 === 0);
    setFunction(grid, i, 6, i % 2 === 0);
  }
  drawFinder(grid, 3, 3);
  drawFinder(grid, size - 4, 3);
  drawFinder(grid, 3, size - 4);

  const positions = ALIGNMENT[version];
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      const overlapsFinder =
        (i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0);
      if (overlapsFinder) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(grid, positions[i] + dx, positions[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Reserve format areas (real bits are written after masking).
  drawFormatBits(grid, 0);
  if (version >= 7) {
    const bits = bchVersion(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(grid, a, b, dark);
      setFunction(grid, b, a, dark);
    }
  }
}

function drawFormatBits(grid: Grid, mask: number) {
  const { size } = grid;
  const bits = bchFormat((0b00 << 3) | mask); // 00 = error correction level M
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) setFunction(grid, 8, i, bit(i));
  setFunction(grid, 8, 7, bit(6));
  setFunction(grid, 8, 8, bit(7));
  setFunction(grid, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFunction(grid, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) setFunction(grid, size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFunction(grid, 8, size - 15 + i, bit(i));
  setFunction(grid, 8, size - 8, true); // always-dark module
}

function placeData(grid: Grid, codewords: number[]) {
  const { size } = grid;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (grid.reserved[y][x]) continue;
        if (bitIndex < totalBits) {
          grid.modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
      }
    }
  }
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(grid: Grid, mask: number) {
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      if (!grid.reserved[y][x] && MASKS[mask](x, y)) grid.modules[y][x] = !grid.modules[y][x];
    }
  }
}

function penalty(grid: Grid): number {
  const { size, modules } = grid;
  let score = 0;
  const scanLine = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else {
        run = 1;
      }
    }
    // finder-like 1:1:3:1:1 pattern with 4 light modules on a side
    const pattern = [true, false, true, true, true, false, true];
    for (let i = 0; i + 7 <= size; i++) {
      if (!pattern.every((v, k) => get(i + k) === v)) continue;
      const lightBefore = i >= 4 && [1, 2, 3, 4].every((k) => !get(i - k));
      const lightAfter = i + 7 + 4 <= size && [0, 1, 2, 3].every((k) => !get(i + 7 + k));
      if (lightBefore || lightAfter) score += 40;
    }
  };
  for (let y = 0; y < size; y++) scanLine((i) => modules[y][i]);
  for (let x = 0; x < size; x++) scanLine((i) => modules[i][x]);
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
    }
  }
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/** Returns the QR matrix (true = dark) or null when the text is too long for versions 1–14. */
export function qrMatrix(text: string): boolean[][] | null {
  const bytes = utf8Bytes(text);
  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    const headerBits = 4 + (v <= 9 ? 8 : 16);
    if (Math.ceil((headerBits + bytes.length * 8) / 8) <= dataCapacity(v)) {
      version = v;
      break;
    }
  }
  if (version === 0) return null;

  const codewords = buildCodewords(bytes, version);
  let best: Grid | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const grid = newGrid(version);
    drawFunctionPatterns(grid, version);
    placeData(grid, codewords);
    applyMask(grid, mask);
    drawFormatBits(grid, mask);
    const score = penalty(grid);
    if (score < bestScore) {
      bestScore = score;
      best = grid;
    }
  }
  return best ? best.modules : null;
}

/**
 * Inline SVG of the QR code with a 2-module quiet zone.
 * `moduleMm` is the printed size of one module (0.75 mm ≈ 6 dots on a 203 dpi thermal printer).
 */
export function qrSvg(text: string, moduleMm = 0.75): string | null {
  const matrix = qrMatrix(text);
  if (!matrix) return null;
  const quiet = 2;
  const size = matrix.length + quiet * 2;
  let path = '';
  for (let y = 0; y < matrix.length; y++) {
    let x = 0;
    while (x < matrix.length) {
      if (!matrix[y][x]) { x++; continue; }
      let end = x;
      while (end < matrix.length && matrix[y][end]) end++;
      path += `M${x + quiet} ${y + quiet}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  }
  const mm = (size * moduleMm).toFixed(2);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${mm}mm" height="${mm}mm" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
