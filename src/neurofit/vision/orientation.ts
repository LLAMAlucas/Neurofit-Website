/**
 * Camera-orientation detection. PURE module.
 * ----------------------------------------------------------------------------
 * Classifies the camera position for a SET into front / side / ambiguous from
 * body-landmark geometry. Uses the facing score (shoulder x-spread ÷ torso
 * length, pose/facing.ts), which compresses as the subject rotates away from
 * front-on, and the relative-z of the two shoulders to tell which profile a side
 * view is.
 *
 * Angle convention (see config.ORIENTATION): facingAngleDeg ∈ [0,180],
 *   90° = front-on, 0°/180° = side-on (either profile).
 * The score→degrees map is anchored so the StakeFit facing bands line up with
 * the spec's ±15° tolerance zones: score 0.6 → 15° off front (front-zone edge),
 * score 0.3 → 15° off side (side-zone edge).
 *
 * "ambiguous" is a HARD boundary: callers must not fault-check, and must prompt
 * the user to reposition (no soft/low-confidence degrade).
 */
import { computeFacing } from "../pose/facing";
import { getLandmark, type Landmark } from "../pose/landmarks";
import { ORIENTATION } from "../squat/config";
import type { Orientation } from "../squat/metrics";

export type OrientationClass = Orientation | "ambiguous";

export interface OrientationEstimate {
  orientation: OrientationClass;
  /** 90 = front, 0/180 = side. null when the body isn't readable. */
  facingAngleDeg: number | null;
  /** Raw facing score (shoulder-spread / torso-length) for debugging. */
  score: number | null;
  label: string;
  /** True only when the body's shoulders+hips are confidently visible. */
  readable: boolean;
}

function lerp(x: number, x0: number, y0: number, x1: number, y1: number): number {
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

/**
 * Facing score → degrees OFF front (0 = dead front, 90 = dead side), anchored on
 * the tunable ORIENTATION.SCORE bands. The edge anchors line up with the ±15°
 * zones: FRONT_EDGE → 15° off front, SIDE_EDGE → 15° off side (75° off front).
 */
function scoreToDeviation(s: number): number {
  const { FRONT_FULL, FRONT_EDGE, SIDE_EDGE, SIDE_FULL } = ORIENTATION.SCORE;
  let dev: number;
  if (s >= FRONT_FULL) dev = 0;
  else if (s >= FRONT_EDGE) dev = lerp(s, FRONT_FULL, 0, FRONT_EDGE, 15);
  else if (s >= SIDE_EDGE) dev = lerp(s, FRONT_EDGE, 15, SIDE_EDGE, 75);
  else if (s >= SIDE_FULL) dev = lerp(s, SIDE_EDGE, 75, SIDE_FULL, 90);
  else dev = 90;
  return Math.min(90, Math.max(0, dev));
}

export function estimateOrientation(
  landmarks: readonly Landmark[],
  minVis: number,
): OrientationEstimate {
  const facing = computeFacing(landmarks, minVis);
  if (!facing) {
    return { orientation: "ambiguous", facingAngleDeg: null, score: null, readable: false, label: "Step into frame" };
  }

  const dev = scoreToDeviation(facing.score);
  // Which profile? sign of the shoulder z-difference (which shoulder is nearer).
  const ls = getLandmark(landmarks, "LEFT_SHOULDER");
  const rs = getLandmark(landmarks, "RIGHT_SHOULDER");
  const turnSign = ls && rs && ls.z !== rs.z ? Math.sign(ls.z - rs.z) : 1;
  const facingAngleDeg = turnSign >= 0 ? 90 - dev : 90 + dev;

  const orientation = classify(facingAngleDeg);
  return {
    orientation,
    facingAngleDeg,
    score: facing.score,
    readable: true,
    label: labelFor(orientation, facingAngleDeg),
  };
}

/** Classify a facing angle into front / side / ambiguous (global tolerance). */
export function classify(facingAngleDeg: number): OrientationClass {
  if (Math.abs(facingAngleDeg - ORIENTATION.FRONT_DEG) <= ORIENTATION.TOL_DEG) return "front";
  if (sideDistanceDeg(facingAngleDeg) <= ORIENTATION.TOL_DEG) return "side";
  return "ambiguous";
}

/** Degrees from the nearest side reference (0° or 180°). */
export function sideDistanceDeg(facingAngleDeg: number): number {
  return Math.min(Math.abs(facingAngleDeg - 0), Math.abs(facingAngleDeg - 180));
}

/** Degrees from a target orientation's reference, for per-check tolerance. */
export function distanceFromOrientation(facingAngleDeg: number, o: Orientation): number {
  return o === "front" ? Math.abs(facingAngleDeg - ORIENTATION.FRONT_DEG) : sideDistanceDeg(facingAngleDeg);
}

function labelFor(o: OrientationClass, angle: number): string {
  if (o === "front") return "Front-on";
  if (o === "side") return "Side-on";
  return `Ambiguous angle (${Math.round(angle)}°) — turn fully front-on or side-on`;
}
