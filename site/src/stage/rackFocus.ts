/**
 * The rack focus (postprocessing's DepthOfFieldEffect), sampled for the size
 * the page uses it at.
 *
 * Its bokeh is measured in device pixels: at `bokehScale` 1.6 the widest disk
 * is 1.6 px in radius, and that is all the page's depth of field is — a slight
 * softening of the floor and the dust away from the body. The effect samples
 * it as if it might be dozens of pixels wide, 64 taps a texel for the blur and
 * 16 for the max-filter "fill" after it, and it was the most expensive thing on
 * screen: over half of a high-tier frame's GPU time (SwiftShader, 1280×800,
 * timed pass by pass).
 *
 * The blur now takes 16 taps on the same kind of spiral, still spread evenly
 * over the whole disk, and the fill drops its two innermost taps — one of them
 * sat exactly on the centre it already reads. Against the stock effect on the
 * same frames (six points down the page and a swipe, rendered the same way
 * twice): at most 9 levels of 255 apart on any pixel, 0.02 on average, well
 * inside the film grain laid over it — removing the depth of field altogether
 * moves the image ~20× as much. A whole frame costs 13–17% less.
 *
 * This reaches into passes postprocessing doesn't type as public. If an
 * upgrade reshapes them, nothing is touched and the stock effect runs — slower,
 * never wrong.
 */
import type { DepthOfFieldEffect } from "postprocessing";
import type { ShaderMaterial } from "three";

/** Taps in each texel's blur (a mean over the disk). */
const BLUR_TAPS = 16;
/** Taps kept of the fill's 16 (a max over the disk): the outermost. */
const FILL_TAPS = 14;

// The stock shader's loops and the mean's divisor, as its source spells them.
const BLUR_LOOP = "for(int i=0;i<32;++i){vec4 kernel=kernel64[i];";
const BLUR_MEAN = "gl_FragColor=acc/64.0;";
const FILL_LOOP = "for(int i=0;i<8;++i){vec4 kernel=kernel16[i];";

type Bokeh = { fullscreenMaterial?: ShaderMaterial };
type Passes = Partial<Record<"bokehNearBasePass" | "bokehFarBasePass" | "bokehNearFillPass" | "bokehFarFillPass", Bokeh>>;

const trimmed = new WeakSet<DepthOfFieldEffect>();

/** `n` points spread evenly over the unit disk (a golden-angle spiral), packed
 *  two to a vec4 the way the shader reads them. */
function spiral(n: number): Float32Array {
  const out = new Float32Array(128);
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n);
    const a = i * 2.39996323;
    out[i * 2] = r * Math.cos(a);
    out[i * 2 + 1] = r * Math.sin(a);
  }
  return out;
}

/** The `n` points of a packed kernel furthest from its centre. */
function outermost(kernel: ArrayLike<number>, n: number): Float32Array {
  const points: [number, number][] = [];
  for (let i = 0; i + 1 < kernel.length; i += 2) points.push([kernel[i], kernel[i + 1]]);
  points.sort((a, b) => Math.hypot(b[0], b[1]) - Math.hypot(a[0], a[1]));
  const out = new Float32Array(kernel.length);
  points.slice(0, n).forEach(([x, y], i) => out.set([x, y], i * 2));
  return out;
}

/** Cut the effect's taps, once. Leaves it untouched if its passes aren't the
 *  shape this was written against. */
export function trimDepthOfField(effect: DepthOfFieldEffect): void {
  if (trimmed.has(effect)) return;
  const p = effect as unknown as Passes;
  const blur = [p.bokehNearBasePass, p.bokehFarBasePass].map((x) => x?.fullscreenMaterial);
  const fill = [p.bokehNearFillPass, p.bokehFarFillPass].map((x) => x?.fullscreenMaterial);
  const fits = (m: ShaderMaterial | undefined, kernel: string, ...code: string[]): m is ShaderMaterial =>
    !!m?.uniforms[kernel]?.value && code.every((c) => m.fragmentShader.includes(c));
  if (!blur.every((m) => fits(m, "kernel64", BLUR_LOOP, BLUR_MEAN)) || !fill.every((m) => fits(m, "kernel16", FILL_LOOP))) {
    if (import.meta.env.DEV) console.warn("rackFocus: postprocessing's depth of field has changed shape; left untrimmed");
    return;
  }
  for (const m of blur as ShaderMaterial[]) {
    m.fragmentShader = m.fragmentShader
      .replace(BLUR_LOOP, BLUR_LOOP.replace("i<32", `i<${BLUR_TAPS / 2}`))
      .replace(BLUR_MEAN, `gl_FragColor=acc/${BLUR_TAPS}.0;`);
    m.uniforms.kernel64.value = spiral(BLUR_TAPS);
    m.needsUpdate = true;
  }
  for (const m of fill as ShaderMaterial[]) {
    m.fragmentShader = m.fragmentShader.replace(FILL_LOOP, FILL_LOOP.replace("i<8", `i<${FILL_TAPS / 2}`));
    m.uniforms.kernel16.value = outermost(m.uniforms.kernel16.value, FILL_TAPS);
    m.needsUpdate = true;
  }
  trimmed.add(effect);
}
