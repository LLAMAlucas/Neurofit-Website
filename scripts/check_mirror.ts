/* The two apps share their chrome (tokens, flat controls, the top bar, the menu, sheets, ASCII
   fields) as a folder copied byte-for-byte into each — they build from separate Vercel roots, so
   neither can import the other. Run with:
     npm run check:mirror

   1. src/neurofit/chrome/ and site/src/chrome/ hold the same files, identical after normalising
      line endings (core.autocrlf rewrites them on checkout).
   2. chrome/ascii.ts (pure) maps pictures to glyphs as designed. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RAMP, fitGrid, lumaGrid, noiseGrid, shade, toGlyphs } from "../src/neurofit/chrome/ascii";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

// ── 1. the mirror ──────────────────────────────────────────────────────────────────────
const A = "src/neurofit/chrome";
const B = "site/src/chrome";
const list = (d: string) => readdirSync(d).filter((f) => !f.startsWith(".")).sort();
const a = list(A);
const b = list(B);
check(`same files in both chrome/ folders (${a.join(", ")})`, a.join("|") === b.join("|"));
const norm = (s: string) => s.replace(/\r\n/g, "\n");
for (const f of a) {
  if (!b.includes(f)) continue;
  check(`${f} is identical in both apps`, norm(readFileSync(join(A, f), "utf8")) === norm(readFileSync(join(B, f), "utf8")));
}

// ── 2. ascii.ts ────────────────────────────────────────────────────────────────────────
const glyphs = Array.from(RAMP);
const one = (v: number) => toGlyphs(Float32Array.of(v), 1, 1);
check("ascii: 0 is a space, 1 is the densest glyph", one(0) === " " && one(1) === glyphs[glyphs.length - 1]);
{
  let mono = true;
  let prev = -1;
  for (let v = 0; v <= 1.0001; v += 0.05) {
    const k = glyphs.indexOf(one(v));
    if (k < prev) mono = false;
    prev = k;
  }
  check("ascii: brighter never maps to a lighter glyph (monotonic ramp)", mono);
}
check("ascii: out-of-range values clamp", one(-3) === " " && one(9) === glyphs[glyphs.length - 1]);
{
  const s = toGlyphs(new Float32Array(6 * 3).fill(0.5), 6, 3);
  const lines = s.split("\n");
  check("ascii: rows × cols shape", lines.length === 3 && lines.every((l) => Array.from(l).length === 6));
}
check("fitGrid: whole cells only, never zero", (() => {
  const g = fitGrid(100, 50, 6, 10);
  const z = fitGrid(0, 0, 6, 10);
  return g.cols === 16 && g.rows === 5 && z.cols === 1 && z.rows === 1;
})());
{
  // A uniform grey picture → a constant grid at its luminance.
  const w = 20;
  const h = 10;
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([128, 128, 128, 255], i * 4);
  const g = lumaGrid(px, w, h, 5, 2);
  check("lumaGrid: uniform picture → constant grid", g.every((v) => Math.abs(v - 128 / 255) < 1e-6));
  // Transparent pixels count as dark.
  const clear = lumaGrid(new Uint8ClampedArray(w * h * 4).fill(255).map((v, i) => (i % 4 === 3 ? 0 : v)), w, h, 5, 2);
  check("lumaGrid: transparent pixels read as dark", clear.every((v) => v === 0));
}
{
  // A bright square on black, light from the top-left: its top-left edge must come out denser
  // than its bottom-right edge.
  const cols = 12;
  const rows = 12;
  const g = new Float32Array(cols * rows);
  for (let r = 4; r < 8; r++) for (let c = 4; c < 8; c++) g[r * cols + c] = 0.5;
  const s = shade(g, cols, rows);
  check("shade: the edge facing the light is boosted", s[4 * cols + 4] > s[7 * cols + 7]);
  check("shade: away-facing edge keeps its value", Math.abs(s[7 * cols + 7] - 0.5) < 1e-6);
  check("shade: nothing exceeds 1", s.every((v) => v <= 1));
}
{
  const n1 = noiseGrid(30, 10, 1.5, 3);
  const n2 = noiseGrid(30, 10, 1.5, 3);
  const n3 = noiseGrid(30, 10, 2.5, 3);
  check("noiseGrid: deterministic for a seed and time", n1.every((v, i) => v === n2[i]));
  check("noiseGrid: drifts with time", n1.some((v, i) => v !== n3[i]));
  check("noiseGrid: stays in 0..1", n1.every((v) => v >= 0 && v <= 1));
  const dark = n1.filter((v) => v < 0.15).length / n1.length;
  check(`noiseGrid: mostly dark, like the reference's black (${(dark * 100).toFixed(0)}% < 0.15)`, dark > 0.4);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
if (failures) process.exit(1);
