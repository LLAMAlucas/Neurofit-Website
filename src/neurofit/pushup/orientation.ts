/**
 * Push-up camera orientation + plank-posture gate. PURE module.
 * ----------------------------------------------------------------------------
 * Same contract as vision/orientation.ts (front = 90°, side = 0°/180°, "ambiguous" is a hard
 * stop) and it reuses its `classify`, but with a push-up facing score — see
 * PUSHUP_ORIENTATION for why the squat's shoulder÷torso score can't work on a horizontal body.
 *
 * `inPlank` is separate from `readable` on purpose: the LOCK requires a plank (a standing person
 * must never start a push-up set), but mid-set the hook only needs `readable` — at the bottom of a
 * deep rep the wrists sit barely below the shoulders, and re-checking the plank there would flash
 * "return to position" on every good rep.
 */
import { getLandmark, type Landmark, type LandmarkName } from "../pose/landmarks";
import { classify, type OrientationEstimate } from "../vision/orientation";
import { PUSHUP_ORIENTATION } from "./config";
import type { Pt } from "./frame";

export interface PushupOrientationEstimate extends OrientationEstimate {
  /** Lifter is in a push-up top/plank position (lock gate only). */
  inPlank: boolean;
}

const DEG = 180 / Math.PI;

function lerp(x: number, x0: number, y0: number, x1: number, y1: number): number {
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

/** Facing score → degrees OFF front (0 = dead front, 90 = dead side), push-up anchors. */
export function pushupScoreToDeviation(s: number): number {
  const { FRONT_FULL, FRONT_EDGE, SIDE_EDGE, SIDE_FULL } = PUSHUP_ORIENTATION.SCORE;
  let dev: number;
  if (s >= FRONT_FULL) dev = 0;
  else if (s >= FRONT_EDGE) dev = lerp(s, FRONT_FULL, 0, FRONT_EDGE, 15);
  else if (s >= SIDE_EDGE) dev = lerp(s, FRONT_EDGE, 15, SIDE_EDGE, 75);
  else if (s >= SIDE_FULL) dev = lerp(s, SIDE_EDGE, 75, SIDE_FULL, 90);
  else dev = 90;
  return Math.min(90, Math.max(0, dev));
}

function pt(landmarks: readonly Landmark[], name: LandmarkName, minVis: number, aspect: number): Pt | null {
  const p = getLandmark(landmarks, name);
  return p && p.visibility >= minVis ? [p.x * aspect, p.y] : null;
}

function upperArm(landmarks: readonly Landmark[], side: "LEFT" | "RIGHT", minVis: number, aspect: number): number | null {
  const s = pt(landmarks, `${side}_SHOULDER`, minVis, aspect);
  const e = pt(landmarks, `${side}_ELBOW`, minVis, aspect);
  return s && e ? Math.hypot(s[0] - e[0], s[1] - e[1]) : null;
}

/** Longest confidently-visible upper arm (aspect space), or null. */
function maxUpperArm(landmarks: readonly Landmark[], minVis: number, aspect: number): number | null {
  const lens = [upperArm(landmarks, "LEFT", minVis, aspect), upperArm(landmarks, "RIGHT", minVis, aspect)].filter(
    (v): v is number => v !== null && v > 1e-6,
  );
  return lens.length ? Math.max(...lens) : null;
}

/** Shoulder x-separation ÷ longest visible upper arm (aspect space); null if unreadable. */
export function pushupFacingScore(landmarks: readonly Landmark[], minVis: number, aspect: number): number | null {
  const farVis = minVis * PUSHUP_ORIENTATION.farShoulderVisFrac;
  const ls = getLandmark(landmarks, "LEFT_SHOULDER");
  const rs = getLandmark(landmarks, "RIGHT_SHOULDER");
  if (!ls || !rs) return null;
  if (Math.max(ls.visibility, rs.visibility) < minVis || Math.min(ls.visibility, rs.visibility) < farVis) return null;
  const arm = maxUpperArm(landmarks, minVis, aspect);
  if (arm === null) return null;
  return (Math.abs(ls.x - rs.x) * aspect) / arm;
}

/**
 * Is the lifter in a push-up top position? `sideish` picks the geometry (profile vs head-on).
 * Side: the near shoulder→hip line is near-horizontal and the wrists hang below the shoulders.
 * Front: wrists below the shoulders, and the hips (when readable at all) sit near shoulder height
 * rather than a torso-length below them.
 */
export function inPlankPosture(landmarks: readonly Landmark[], minVis: number, aspect: number, sideish: boolean): boolean {
  const { maxTorsoInclineDeg, minWristDropUpperArms, frontMaxHipDropShoulderWidths } = PUSHUP_ORIENTATION.plank;
  const arm = maxUpperArm(landmarks, minVis, aspect);
  if (arm === null) return false;

  if (sideish) {
    const meanVis = (side: "LEFT" | "RIGHT") =>
      ((getLandmark(landmarks, `${side}_SHOULDER`)?.visibility ?? 0) + (getLandmark(landmarks, `${side}_HIP`)?.visibility ?? 0)) / 2;
    const side = meanVis("LEFT") >= meanVis("RIGHT") ? "LEFT" : "RIGHT";
    const s = pt(landmarks, `${side}_SHOULDER`, minVis, aspect);
    const h = pt(landmarks, `${side}_HIP`, minVis, aspect);
    const w = pt(landmarks, `${side}_WRIST`, minVis, aspect);
    if (!s || !h || !w) return false;
    const incline = Math.atan2(Math.abs(s[1] - h[1]), Math.abs(s[0] - h[0])) * DEG;
    return incline <= maxTorsoInclineDeg && (w[1] - s[1]) / arm >= minWristDropUpperArms;
  }

  const ls = pt(landmarks, "LEFT_SHOULDER", minVis, aspect);
  const rs = pt(landmarks, "RIGHT_SHOULDER", minVis, aspect);
  const lw = pt(landmarks, "LEFT_WRIST", minVis, aspect);
  const rw = pt(landmarks, "RIGHT_WRIST", minVis, aspect);
  if (!ls || !rs || !lw || !rw) return false;
  const shoulderY = (ls[1] + rs[1]) / 2;
  const wristY = (lw[1] + rw[1]) / 2;
  if ((wristY - shoulderY) / arm < minWristDropUpperArms) return false;
  const lh = pt(landmarks, "LEFT_HIP", minVis, aspect);
  const rh = pt(landmarks, "RIGHT_HIP", minVis, aspect);
  if (!lh || !rh) return true; // hips hidden behind the head/shoulders — normal head-on
  const width = Math.abs(ls[0] - rs[0]);
  if (width < 1e-6) return false;
  return Math.abs((lh[1] + rh[1]) / 2 - shoulderY) / width <= frontMaxHipDropShoulderWidths;
}

export function estimatePushupOrientation(
  landmarks: readonly Landmark[],
  minVis: number,
  aspect: number,
): PushupOrientationEstimate {
  const score = pushupFacingScore(landmarks, minVis, aspect);
  if (score === null) {
    return {
      orientation: "ambiguous",
      facingAngleDeg: null,
      score: null,
      readable: false,
      inPlank: false,
      label: "Get shoulders and arms in frame",
    };
  }
  const dev = pushupScoreToDeviation(score);
  const ls = getLandmark(landmarks, "LEFT_SHOULDER");
  const rs = getLandmark(landmarks, "RIGHT_SHOULDER");
  const turnSign = ls && rs && ls.z !== rs.z ? Math.sign(ls.z - rs.z) : 1;
  const facingAngleDeg = turnSign >= 0 ? 90 - dev : 90 + dev;
  const orientation = classify(facingAngleDeg);
  const inPlank = inPlankPosture(landmarks, minVis, aspect, score < PUSHUP_ORIENTATION.SCORE.FRONT_EDGE);
  let label: string;
  if (orientation === "ambiguous") label = `Ambiguous angle (${Math.round(facingAngleDeg)}°) — turn fully side-on or head-on`;
  else if (!inPlank) label = "Get into the top of a push-up";
  else label = orientation === "front" ? "Head-on" : "Side-on";
  return { orientation, facingAngleDeg, score, readable: true, inPlank, label };
}
