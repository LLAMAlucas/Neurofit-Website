/**
 * Joint angles from a MediaPipe pose, for any exercise. PURE module.
 * ----------------------------------------------------------------------------
 * These are 2D angles in the image plane (video pixel space — see geometry.ts). A joint that
 * bends toward or away from the camera reads wrong: a knee bending straight at a head-on camera
 * barely changes its 2D angle. That is why every value travels with the view guess to Gemini,
 * and why the prompt treats them as estimates. Points below MIN_VISIBILITY give null — a hidden
 * joint is "not seen", never a number.
 */
import { MIN_VISIBILITY, type Landmark } from "../pose/landmarks";
import { computeFacing } from "../pose/facing";
import { ORIENTATION } from "../squat/config";
import { angleAt, leanFromVerticalDeg, toPx, type FrameSize, type Pt } from "./geometry";

/** The pose points the Analyze tools use (MediaPipe's 33-point indices), for skeleton drawing
 *  and joint snapping. "Left" is the lifter's left. */
export const ANALYZE_JOINTS = [
  { index: 0, id: "nose", label: "Nose" },
  { index: 7, id: "left_ear", label: "Left ear" },
  { index: 8, id: "right_ear", label: "Right ear" },
  { index: 11, id: "left_shoulder", label: "Left shoulder" },
  { index: 12, id: "right_shoulder", label: "Right shoulder" },
  { index: 13, id: "left_elbow", label: "Left elbow" },
  { index: 14, id: "right_elbow", label: "Right elbow" },
  { index: 15, id: "left_wrist", label: "Left wrist" },
  { index: 16, id: "right_wrist", label: "Right wrist" },
  { index: 23, id: "left_hip", label: "Left hip" },
  { index: 24, id: "right_hip", label: "Right hip" },
  { index: 25, id: "left_knee", label: "Left knee" },
  { index: 26, id: "right_knee", label: "Right knee" },
  { index: 27, id: "left_ankle", label: "Left ankle" },
  { index: 28, id: "right_ankle", label: "Right ankle" },
  { index: 29, id: "left_heel", label: "Left heel" },
  { index: 30, id: "right_heel", label: "Right heel" },
  { index: 31, id: "left_toe", label: "Left toes" },
  { index: 32, id: "right_toe", label: "Right toes" },
] as const;

export const JOINT_LABEL: Record<number, string> = Object.fromEntries(ANALYZE_JOINTS.map((j) => [j.index, j.label]));

/** Body links drawn as the skeleton (indices into the 33-point pose). Face and hands left out. */
export const SKELETON_LINKS: readonly (readonly [number, number])[] = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
  [7, 11], [8, 12],
];

export type AngleId =
  | "left_knee" | "right_knee"
  | "left_hip" | "right_hip"
  | "left_elbow" | "right_elbow"
  | "left_shoulder" | "right_shoulder"
  | "left_ankle" | "right_ankle"
  | "trunk_lean";

export interface AngleDef {
  id: AngleId;
  label: string;
  /** a–b–c, angle at b. Absent for trunk_lean (computed from the shoulder/hip line). */
  points?: readonly [number, number, number];
}

export const ANGLE_DEFS: readonly AngleDef[] = [
  { id: "left_knee", label: "Left knee", points: [23, 25, 27] },
  { id: "right_knee", label: "Right knee", points: [24, 26, 28] },
  { id: "left_hip", label: "Left hip", points: [11, 23, 25] },
  { id: "right_hip", label: "Right hip", points: [12, 24, 26] },
  { id: "left_elbow", label: "Left elbow", points: [11, 13, 15] },
  { id: "right_elbow", label: "Right elbow", points: [12, 14, 16] },
  { id: "left_shoulder", label: "Left shoulder", points: [23, 11, 13] },
  { id: "right_shoulder", label: "Right shoulder", points: [24, 12, 14] },
  { id: "left_ankle", label: "Left ankle", points: [25, 27, 31] },
  { id: "right_ankle", label: "Right ankle", points: [26, 28, 32] },
  { id: "trunk_lean", label: "Trunk lean (from vertical)" },
];

export const ANGLE_LABEL: Record<AngleId, string> = Object.fromEntries(ANGLE_DEFS.map((d) => [d.id, d.label])) as Record<AngleId, string>;

export type JointAngles = Record<AngleId, number | null>;

/** A landmark as a pixel point, or null when it is missing or not confidently seen. */
export function seenPx(lms: readonly Landmark[], index: number, size: FrameSize, minVis = MIN_VISIBILITY): Pt | null {
  const l = lms[index];
  if (!l || !(l.visibility >= minVis)) return null;
  return toPx(l.x, l.y, size);
}

function mid(a: Pt, b: Pt): Pt {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** Trunk lean from image vertical: shoulder-mid → hip-mid, or the one side that is seen. */
function trunkLean(lms: readonly Landmark[], size: FrameSize): number | null {
  const ls = seenPx(lms, 11, size);
  const rs = seenPx(lms, 12, size);
  const lh = seenPx(lms, 23, size);
  const rh = seenPx(lms, 24, size);
  const s = ls && rs ? mid(ls, rs) : (ls ?? rs);
  const h = lh && rh ? mid(lh, rh) : (lh ?? rh);
  if (!s || !h) return null;
  if (Math.hypot(s[0] - h[0], s[1] - h[1]) < 1) return null;
  return leanFromVerticalDeg(h, s);
}

export function computeJointAngles(lms: readonly Landmark[], size: FrameSize): JointAngles {
  const out = {} as JointAngles;
  for (const def of ANGLE_DEFS) {
    if (!def.points) {
      out[def.id] = trunkLean(lms, size);
      continue;
    }
    const [ia, ib, ic] = def.points;
    const a = seenPx(lms, ia, size);
    const b = seenPx(lms, ib, size);
    const c = seenPx(lms, ic, size);
    out[def.id] = a && b && c ? angleAt(a, b, c) : null;
  }
  return out;
}

/** The joints the rep finder may drive from — both sides averaged when both are seen. */
export type DriveJoint = "knee" | "hip" | "elbow" | "shoulder";
export const DRIVE_JOINTS: readonly DriveJoint[] = ["knee", "hip", "elbow", "shoulder"];

export function pairedAngle(a: JointAngles, joint: DriveJoint): number | null {
  const l = a[`left_${joint}` as AngleId];
  const r = a[`right_${joint}` as AngleId];
  if (l !== null && r !== null) return (l + r) / 2;
  return l ?? r;
}

export type ViewGuess = "side" | "front" | "angled" | "unknown";

/**
 * Which way the lifter faces the camera, from the live coach's facing score (shoulder width ÷
 * torso length, aspect space) and its tuned anchors. A GUESS from the median over the clip:
 * those anchors were tuned standing, and a horizontal body (push-up, bench) only roughly fits.
 */
export function guessView(scores: readonly number[]): ViewGuess {
  if (scores.length === 0) return "unknown";
  const s = [...scores].sort((x, y) => x - y)[Math.floor(scores.length / 2)];
  if (s >= ORIENTATION.SCORE.FRONT_EDGE) return "front";
  if (s <= ORIENTATION.SCORE.SIDE_EDGE) return "side";
  return "angled";
}

/** The facing score for one pose, or null when shoulders/hips are not seen. */
export function facingScore(lms: readonly Landmark[], size: FrameSize): number | null {
  return computeFacing(lms, MIN_VISIBILITY, size.width / size.height)?.score ?? null;
}
