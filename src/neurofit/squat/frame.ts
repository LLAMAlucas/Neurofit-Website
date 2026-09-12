/**
 * Per-frame squat features. PURE module.
 * ----------------------------------------------------------------------------
 * Turns one frame of MediaPipe landmarks into the scalars the rep counter,
 * velocity tracker and the orientation-gated form checks consume.
 *
 * SIDE-VIEW NOTE: the far-side joints are occluded in a profile view, so the
 * shoulder/hip/knee/ankle "centres" FALL BACK to whichever side is visible
 * rather than requiring both — otherwise depth and forward-lean (side-only
 * checks) would never have a hip/knee/torso reference. Width metrics
 * (knee/ankle/hip spread) still require BOTH sides, since they're frontal-plane.
 *
 * Every field is nullable: a check whose joints aren't visible is SKIPPED
 * ("unknown"), never failed — occlusion ≠ bad form.
 */
import { calculateAngle } from "../pose/angle";
import { getLandmark, type Landmark } from "../pose/landmarks";

export type Pt = [number, number];

export interface SquatFrame {
  t: number;
  /** Visibility-weighted average knee angle over the visible legs. */
  kneeAngle: number | null;
  leftKneeAngle: number | null;
  rightKneeAngle: number | null;
  /** Centres (normalized): midpoint when both sides visible, else the near side. */
  hipMid: Pt | null;
  kneeMid: Pt | null;
  ankleMid: Pt | null;
  shoulderMid: Pt | null;
  /** Raw bilateral points, for tilt / levelness / lateral-shift / symmetry checks. */
  leftShoulder: Pt | null;
  rightShoulder: Pt | null;
  leftHip: Pt | null;
  rightHip: Pt | null;
  leftKnee: Pt | null;
  rightKnee: Pt | null;
  leftAnkle: Pt | null;
  rightAnkle: Pt | null;
  /** Trunk lean from image vertical (deg, 0 = upright). */
  torsoLean: number | null;
  /**
   * Shin inclination from vertical (deg) — knee→ankle vector, visible legs
   * averaged. The v2 ANKLE PROXY: more forward shin ≈ more dorsiflexion; a shin
   * stuck near-vertical at depth hints at restricted ankles (upstream of lean,
   * valgus, butt wink). Context only — never a fault on its own.
   */
  shinAngleDeg: number | null;
  /**
   * Coarse foot orientation (deg from vertical of the ankle→foot-index vector),
   * visible feet averaged. Low-reliability proxy for toe-out; foot landmarks are
   * weak, so this is frequently null. Read ~once at rep 1 (quasi-static).
   */
  footAngleDeg: number | null;
  /** Horizontal spreads (normalized) — require BOTH sides (frontal plane). */
  shoulderWidth: number | null;
  kneeWidth: number | null;
  ankleWidth: number | null;
  hipWidth: number | null;
  /** Both knees AND both ankles visible — valgus is only observable then. */
  bothLegsVisible: boolean;
}

function vis(landmarks: readonly Landmark[], name: Parameters<typeof getLandmark>[1], minVis: number): Landmark | null {
  const p = getLandmark(landmarks, name);
  return p && p.visibility >= minVis ? p : null;
}

function asPt(p: Landmark | null): Pt | null {
  return p ? [p.x, p.y] : null;
}

/** Midpoint when both visible, else the single visible side (occlusion-robust). */
function center(a: Landmark | null, b: Landmark | null): Pt | null {
  if (a && b) return [(a.x + b.x) / 2, (a.y + b.y) / 2];
  const one = a ?? b;
  return one ? [one.x, one.y] : null;
}

/** Horizontal spread — needs BOTH sides (null otherwise). */
function span(a: Landmark | null, b: Landmark | null): number | null {
  return a && b ? Math.abs(a.x - b.x) : null;
}

function kneeAngle(hip: Landmark | null, knee: Landmark | null, ankle: Landmark | null): number | null {
  if (!hip || !knee || !ankle) return null;
  return calculateAngle([hip.x, hip.y], [knee.x, knee.y], [ankle.x, ankle.y]);
}

/** Angle (deg) of the a→b segment from image vertical; null if either missing. */
function segAngleFromVertical(a: Landmark | null, b: Landmark | null): number | null {
  if (!a || !b) return null;
  return (Math.atan2(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 180) / Math.PI;
}

/** Average the non-null angles, or null if none. */
function avgAngleFromVertical(angles: (number | null)[]): number | null {
  const present = angles.filter((a): a is number => a !== null);
  return present.length ? present.reduce((s, a) => s + a, 0) / present.length : null;
}

export function computeSquatFrame(
  landmarks: readonly Landmark[],
  minVis: number,
  t: number,
): SquatFrame {
  const ls = vis(landmarks, "LEFT_SHOULDER", minVis);
  const rs = vis(landmarks, "RIGHT_SHOULDER", minVis);
  const lh = vis(landmarks, "LEFT_HIP", minVis);
  const rh = vis(landmarks, "RIGHT_HIP", minVis);
  const lk = vis(landmarks, "LEFT_KNEE", minVis);
  const rk = vis(landmarks, "RIGHT_KNEE", minVis);
  const la = vis(landmarks, "LEFT_ANKLE", minVis);
  const ra = vis(landmarks, "RIGHT_ANKLE", minVis);
  const lf = vis(landmarks, "LEFT_FOOT_INDEX", minVis);
  const rf = vis(landmarks, "RIGHT_FOOT_INDEX", minVis);

  const leftKneeAngle = kneeAngle(lh, lk, la);
  const rightKneeAngle = kneeAngle(rh, rk, ra);
  const sides = [leftKneeAngle, rightKneeAngle].filter((a): a is number => a !== null);
  const kneeA = sides.length ? sides.reduce((s, a) => s + a, 0) / sides.length : null;

  const shoulderMid = center(ls, rs);
  const hipMid = center(lh, rh);

  // NOTE (v2 coordinate caveat): these angles are computed in raw normalized
  // space like the existing torsoLean, so they share its aspect-ratio sensitivity.
  // They're used as RELATIVE proxies/context, not absolute thresholds. A global
  // pixel/world-space pass for all angle math is tracked separately.
  let torsoLean: number | null = null;
  if (shoulderMid && hipMid) {
    const dx = shoulderMid[0] - hipMid[0];
    const dy = shoulderMid[1] - hipMid[1];
    torsoLean = (Math.atan2(Math.abs(dx), Math.abs(dy)) * 180) / Math.PI;
  }

  const shinAngleDeg = avgAngleFromVertical([
    segAngleFromVertical(lk, la),
    segAngleFromVertical(rk, ra),
  ]);
  const footAngleDeg = avgAngleFromVertical([
    segAngleFromVertical(la, lf),
    segAngleFromVertical(ra, rf),
  ]);

  return {
    t,
    kneeAngle: kneeA,
    leftKneeAngle,
    rightKneeAngle,
    hipMid,
    kneeMid: center(lk, rk),
    ankleMid: center(la, ra),
    shoulderMid,
    leftShoulder: asPt(ls),
    rightShoulder: asPt(rs),
    leftHip: asPt(lh),
    rightHip: asPt(rh),
    leftKnee: asPt(lk),
    rightKnee: asPt(rk),
    leftAnkle: asPt(la),
    rightAnkle: asPt(ra),
    torsoLean,
    shinAngleDeg,
    footAngleDeg,
    shoulderWidth: span(ls, rs),
    kneeWidth: span(lk, rk),
    ankleWidth: span(la, ra),
    hipWidth: span(lh, rh),
    bothLegsVisible: !!(lk && rk && la && ra),
  };
}
