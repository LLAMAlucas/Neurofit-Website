/**
 * How much of the scene a device gets: how many of the body's particles are
 * drawn, the pixel ratio, and whether the depth-of-field pass runs.
 *
 * The body's cost is in DRAWING its particles — its physics measured at about
 * one frame per second of the total — so a tier changes how many are drawn, not
 * how many exist. Every tier samples the same body; a lower one draws a prefix
 * of it (the sampler spreads skin and fill through the order, so a prefix is
 * still the whole body) with each grain drawn a little larger to keep it solid.
 * That also makes stepping down mid-session free: no rebuild, one uniform.
 */

export type TierName = "high" | "mid" | "phone";

export type Tier = {
  name: TierName;
  /** Particles drawn of the body's full set. */
  particles: number;
  /** Most device pixels per CSS pixel. */
  dpr: number;
  /** The rack-focus pass: pretty, and the most expensive thing on screen. */
  dof: boolean;
};

export const FULL_BODY = 71000;

export const TIERS: Record<TierName, Tier> = {
  high: { name: "high", particles: FULL_BODY, dpr: 1.5, dof: true },
  mid: { name: "mid", particles: 42000, dpr: 1.25, dof: false },
  phone: { name: "phone", particles: 26000, dpr: 1.25, dof: false },
};

export type DeviceHints = {
  coarsePointer: boolean;
  /** The shorter side of the screen, CSS px. */
  shortSide: number;
  cores: number;
  /** GB, where the browser says (Chrome only). */
  memory?: number;
};

/** PURE: the tier to start on. */
export function tierFor(d: DeviceHints): Tier {
  if (d.coarsePointer || d.shortSide < 600) return TIERS.phone;
  if (d.cores <= 4 || (d.memory !== undefined && d.memory <= 4)) return TIERS.mid;
  return TIERS.high;
}

/** One step down, once the device has shown it can't hold the frame rate. */
export function stepDown(t: Tier): Tier {
  return t.name === "high" ? TIERS.mid : TIERS.phone;
}

/** The start tier for this browser. */
export function detectTier(): Tier {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return tierFor({
    coarsePointer: window.matchMedia("(pointer: coarse)").matches,
    shortSide: Math.min(window.screen.width, window.screen.height),
    cores: nav.hardwareConcurrency ?? 4,
    memory: nav.deviceMemory,
  });
}

/** How much larger each grain is drawn when only `drawn` of `full` are: the
 *  area they cover together stays about the same. Capped — past 1.5× a grain
 *  stops reading as a grain. */
export function grainScale(full: number, drawn: number): number {
  return Math.min(1.5, Math.sqrt(full / Math.max(1, Math.min(full, drawn))));
}
