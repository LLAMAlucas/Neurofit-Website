/**
 * Pictures as characters — the dragonfly.xyz look: a luminance grid mapped onto a glyph ramp, with
 * edges that face the light drawn denser so a flat image reads as lit from the top-left.
 *
 * PURE: no DOM. The caller samples pixels (a canvas, a video frame) and hands over RGBA; this only
 * does arithmetic, so `npm run check:mirror` tests it in Node.
 *
 * ⚠️ Mirrored byte-for-byte at src/neurofit/chrome/ and site/src/chrome/ — change both
 * (npm run check:mirror fails on any drift).
 */

/** Dark → light. Space is "nothing there", π the brightest ink (the reference's densest glyph). */
export const RAMP = " .:-/o0π";

/** How many character cells fit a box, given one cell's size in px. */
export function fitGrid(wPx: number, hPx: number, charW: number, lineH: number): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.floor(wPx / Math.max(1, charW))),
    rows: Math.max(1, Math.floor(hPx / Math.max(1, lineH))),
  };
}

/**
 * Box-average luminance (Rec. 709, weighted by alpha) of an RGBA image into a cols×rows grid of 0..1.
 * `out` is reused when it is the right size, so a 10 fps loop allocates nothing.
 */
export function lumaGrid(rgba: ArrayLike<number>, w: number, h: number, cols: number, rows: number, out?: Float32Array): Float32Array {
  const grid = out && out.length === cols * rows ? out : new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const y0 = Math.floor((r * h) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * h) / rows));
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * w) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * w) / cols));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < h; y++) {
        for (let x = x0; x < x1 && x < w; x++) {
          const i = (y * w + x) * 4;
          const a = rgba[i + 3] / 255;
          sum += ((0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]) / 255) * a;
          n++;
        }
      }
      grid[r * cols + c] = n ? sum / n : 0;
    }
  }
  return grid;
}

export interface ShadeOptions {
  /** Unit-ish direction the light comes FROM, in grid space (x right, y down). */
  light?: [number, number];
  /** How much a light-facing edge is boosted (0 = none). */
  relief?: number;
  /** <1 lifts the shadows, >1 deepens them. */
  gamma?: number;
}

/**
 * Light-facing emphasis: a cell whose brightness RISES away from the light sits on an edge that
 * faces it, so it is boosted; flat areas and away-facing edges keep their value. Returns a new grid.
 */
export function shade(grid: Float32Array, cols: number, rows: number, opts: ShadeOptions = {}): Float32Array {
  const [lx, ly] = opts.light ?? [-0.7, -0.7];
  const relief = opts.relief ?? 1.5;
  const gamma = opts.gamma ?? 1;
  const out = new Float32Array(grid.length);
  const at = (c: number, r: number) => grid[Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = grid[r * cols + c];
      const gx = (at(c + 1, r) - at(c - 1, r)) / 2;
      const gy = (at(c, r + 1) - at(c, r - 1)) / 2;
      const facing = Math.max(0, -(gx * lx + gy * ly));
      out[r * cols + c] = Math.min(1, Math.pow(Math.max(0, v), gamma) * (1 + relief * facing));
    }
  }
  return out;
}

/** One string, rows joined by "\n", each cell the ramp glyph for its value. */
export function toGlyphs(grid: Float32Array, cols: number, rows: number, ramp: string = RAMP): string {
  const glyphs = Array.from(ramp);
  const top = glyphs.length - 1;
  let s = "";
  for (let r = 0; r < rows; r++) {
    if (r) s += "\n";
    for (let c = 0; c < cols; c++) {
      const v = grid[r * cols + c];
      s += glyphs[Math.max(0, Math.min(top, Math.round((v > 0 ? v : 0) * top)))];
    }
  }
  return s;
}

/* Value noise: a hashed lattice, smoothly interpolated. Deterministic for a given seed. */
function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function smooth(t: number) {
  return t * t * (3 - 2 * t);
}
function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = smooth(x - xi);
  const ty = smooth(y - yi);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/**
 * A drifting cloud of 0..1 for loading screens: two octaves of value noise moving with `t`
 * (seconds), pushed toward sparse so most of the field stays dark like the reference's black.
 */
export function noiseGrid(cols: number, rows: number, t: number, seed = 1, out?: Float32Array): Float32Array {
  const grid = out && out.length === cols * rows ? out : new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * 0.09 + t * 0.35;
      const y = r * 0.16 - t * 0.12;
      const n = 0.65 * valueNoise(x, y, seed) + 0.35 * valueNoise(x * 2.3 + 11, y * 2.3 - 7, seed + 1);
      grid[r * cols + c] = Math.max(0, (n - 0.45) / 0.55);
    }
  }
  return grid;
}
