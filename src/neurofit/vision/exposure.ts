/**
 * Lighting / exposure assessment. PURE module.
 * ----------------------------------------------------------------------------
 * Part of the environmental-robustness wedge: working when the setup is bad
 * (dark room, backlight). Given cheap luma statistics sampled from a frame (the
 * pixel sampling itself lives in the camera component), decide whether the image
 * is under/over-exposed or backlit and return a canvas/CSS filter that corrects
 * it BEFORE pose detection runs. The goal isn't perfection — it's to visibly
 * outperform doing nothing in a before/after demo.
 *
 * All thresholds are starting points to tune against real footage.
 */

export interface ExposureStats {
  /** Mean luma over the sampled pixels, 0–255. */
  meanLuma: number;
  /** Fraction of sampled pixels that are very dark (luma < 40). */
  darkFraction: number;
  /** Fraction of sampled pixels that are blown out (luma > 220). */
  brightFraction: number;
}

export type ExposureQuality = "good" | "dark" | "bright" | "backlit";

export interface ExposureDecision {
  quality: ExposureQuality;
  /** Canvas/CSS filter string to apply before detection ("none" when good). */
  filter: string;
  /** Brightness gain actually applied (1 = none). */
  gain: number;
  /** Human-readable status for the UI. */
  label: string;
  meanLuma: number;
}

/** Target mean luma we nudge the image toward. */
const TARGET_LUMA = 130;
const DARK_LUMA = 85;
const BRIGHT_LUMA = 200;
const BACKLIT_DARK_FRAC = 0.35; // lots of dark subject...
const BACKLIT_BRIGHT_FRAC = 0.2; // ...with a blown-out background

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function decideExposure(stats: ExposureStats): ExposureDecision {
  const { meanLuma, darkFraction, brightFraction } = stats;

  const backlit = darkFraction > BACKLIT_DARK_FRAC && brightFraction > BACKLIT_BRIGHT_FRAC;
  const dark = meanLuma < DARK_LUMA;
  const bright = meanLuma > BRIGHT_LUMA;

  if (!backlit && !dark && !bright) {
    return { quality: "good", filter: "none", gain: 1, label: "Lighting OK", meanLuma };
  }

  // Pull the mean toward TARGET, clamped so we never over-amplify noise.
  const gain = round2(clamp(TARGET_LUMA / Math.max(meanLuma, 1), 0.6, 2.2));
  const contrast = backlit ? 1.3 : 1.12;

  const quality: ExposureQuality = backlit ? "backlit" : dark ? "dark" : "bright";
  const label =
    quality === "backlit"
      ? "Backlit — correcting"
      : quality === "dark"
        ? "Low light — brightening"
        : "Overexposed — toning down";

  return {
    quality,
    filter: `brightness(${gain}) contrast(${contrast})`,
    gain,
    label,
    meanLuma,
  };
}

/**
 * Compute luma stats from raw RGBA pixel data (e.g. a small sampled canvas).
 * Steps through pixels by `stride` for speed. PURE.
 */
export function lumaStats(data: Uint8ClampedArray, stride = 4): ExposureStats {
  let sum = 0;
  let dark = 0;
  let bright = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4 * stride) {
    // Rec. 601 luma.
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += luma;
    if (luma < 40) dark++;
    if (luma > 220) bright++;
    n++;
  }
  if (n === 0) return { meanLuma: TARGET_LUMA, darkFraction: 0, brightFraction: 0 };
  return { meanLuma: sum / n, darkFraction: dark / n, brightFraction: bright / n };
}
