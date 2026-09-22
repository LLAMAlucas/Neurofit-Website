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
 *
 * TWO SPACES, on purpose (2026-09-18). MediaPipe normalizes x by the frame WIDTH and y by the
 * HEIGHT, which bends every ANGLE by the camera's aspect ratio: on the 16:9 camera all the
 * recorded sessions used, a true 45° trunk lean read 29°; on a portrait phone it reads 61°. So
 * every angle here is computed on [x·W/H, y] (aspect space), where it is the real image angle.
 * The POINTS and SPANS stay normalized: everything else built from them is either y-only (depth
 * gap, depth ratio, hip travel, descent speed) or an x/x ratio (valgus, stance, hip shift, knee
 * symmetry), and both are already aspect-invariant — so those numbers, and every threshold on
 * them, are unchanged by the fix.
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
  /** Trunk lean from image vertical (deg, 0 = upright), aspect space. */
  torsoLean: number | null;
  /**
   * |shoulder-line tilt − hip-line tilt| (deg), aspect space; needs both shoulders AND both
   * hips. The differential cancels camera roll. Frontal-plane context (levelness is demoted).
   */
  levelnessDiffDeg: number | null;
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

function kneeAngle(hip: Landmark | null, knee: Landmark | null, ankle: Landmark | null, aspect: number): number | null {
  if (!hip || !knee || !ankle) return null;
  return calculateAngle([hip.x * aspect, hip.y], [knee.x * aspect, knee.y], [ankle.x * aspect, ankle.y]);
}

/** Angle (deg) of the a→b segment from image vertical, aspect space; null if either missing. */
function segAngleFromVertical(a: Landmark | null, b: Landmark | null, aspect: number): number | null {
  if (!a || !b) return null;
  return (Math.atan2(Math.abs(b.x - a.x) * aspect, Math.abs(b.y - a.y)) * 180) / Math.PI;
}

/** Tilt of the line a→b off horizontal, aspect space, in degrees [-90,90]. */
export function lineTiltDeg(a: Landmark, b: Landmark, aspect: number): number {
  let deg = (Math.atan2(b.y - a.y, (b.x - a.x) * aspect) * 180) / Math.PI;
  if (deg > 90) deg -= 180;
  if (deg < -90) deg += 180;
  return deg;
}

/** Average the non-null angles, or null if none. */
function avgAngleFromVertical(angles: (number | null)[]): number | null {
  const present = angles.filter((a): a is number => a !== null);
  return present.length ? present.reduce((s, a) => s + a, 0) / present.length : null;
}

/** `aspect` = W/H of the frame MediaPipe normalized against (CoachCamera passes it). */
export function computeSquatFrame(
  landmarks: readonly Landmark[],
  minVis: number,
  t: number,
  aspect: number,
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

  const leftKneeAngle = kneeAngle(lh, lk, la, aspect);
  const rightKneeAngle = kneeAngle(rh, rk, ra, aspect);
  const sides = [leftKneeAngle, rightKneeAngle].filter((a): a is number => a !== null);
  const kneeA = sides.length ? sides.reduce((s, a) => s + a, 0) / sides.length : null;

  const shoulderMid = center(ls, rs);
  const hipMid = center(lh, rh);

  let torsoLean: number | null = null;
  if (shoulderMid && hipMid) {
    const dx = (shoulderMid[0] - hipMid[0]) * aspect;
    const dy = shoulderMid[1] - hipMid[1];
    torsoLean = (Math.atan2(Math.abs(dx), Math.abs(dy)) * 180) / Math.PI;
  }

  const shinAngleDeg = avgAngleFromVertical([
    segAngleFromVertical(lk, la, aspect),
    segAngleFromVertical(rk, ra, aspect),
  ]);
  const footAngleDeg = avgAngleFromVertical([
    segAngleFromVertical(la, lf, aspect),
    segAngleFromVertical(ra, rf, aspect),
  ]);
  const levelnessDiffDeg =
    ls && rs && lh && rh ? Math.abs(lineTiltDeg(ls, rs, aspect) - lineTiltDeg(lh, rh, aspect)) : null;

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
    levelnessDiffDeg,
    shinAngleDeg,
    footAngleDeg,
    shoulderWidth: span(ls, rs),
    kneeWidth: span(lk, rk),
    ankleWidth: span(la, ra),
    hipWidth: span(lh, rh),
    bothLegsVisible: !!(lk && rk && la && ra),
  };
}
