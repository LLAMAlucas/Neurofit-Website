/**
 * Per-frame pull-up features. PURE module.
 * ----------------------------------------------------------------------------
 * Turns one frame of MediaPipe landmarks into the scalars the pull-up rep counter, checks and
 * triggers consume. Every point is converted to ASPECT space [x·W/H, y] first (see pushup/frame.ts
 * and CLAUDE.md "Orientation & metrics") — the swing and joint angles are decision numbers.
 *
 * SIDE vs FRONT fields, same contract as push-ups: a side view trusts only the NEAR-side limb chain
 * (MediaPipe invents the occluded far limbs), chosen by the caller's NearSideSelector; on front
 * sets `nearSide` is null, every sagittal field is null and only bilateral spans are computed.
 * Every field is nullable — a check whose joints aren't visible is SKIPPED, never failed.
 */
import { calculateAngle } from "../pose/angle";
import { getLandmark, type Landmark, type LandmarkName } from "../pose/landmarks";
import { lineTiltDeg, type Pt, type Side } from "../pushup/frame";
import { PULLUP_FACE } from "./config";

export type { Pt, Side };

export interface PullupFrame {
  t: number;
  /** W/H of the image the landmarks were normalized against. */
  aspect: number;
  nearSide: Side | null;

  /** Counting points: near side on side sets, bilateral midpoint on front sets. */
  shoulder: Pt | null;
  wrist: Pt | null;
  /** Knuckle height of the grip (index/pinky #1 knuckles) — the bar line sample. null if unseen. */
  handY: number | null;
  /** Estimated chin height from the nose + mouth corners. null without a readable face. */
  chinY: number | null;
  /** Longest confidently-visible upper arm (aspect units), for the wrist→bar fallback. */
  upperArmLen: number | null;
  /** Wrists above the head — the hands are up at a bar (or reaching for it). */
  armsOverhead: boolean;

  /** Elbow angle (deg, 180 = straight): near arm side-on; the MORE bent arm head-on. */
  elbowAngleDeg: number | null;

  // --- SAGITTAL (near side; null when nearSide is null) ---
  /** Hand→hip line vs vertical (deg). + = hips in front of the hands (the way the lifter faces). */
  swingDeg: number | null;
  /** Shoulder–hip–knee angle (deg) — hip flexion reads smaller. */
  hipAngleDeg: number | null;
  /** Hip–knee–ankle angle (deg) — knee flexion reads smaller. */
  kneeAngleDeg: number | null;

  // --- FRONTAL (bilateral; both sides required) ---
  shoulderWidth: number | null;
  wristSpan: number | null;
  /** wristSpan/shoulderWidth. Context only. */
  gripWidthRatio: number | null;
  /** |shoulder-line tilt − hand-line tilt| (deg). Roll-invariant: both hands hold one level bar. */
  shoulderTiltDiffDeg: number | null;
}

const DEG = 180 / Math.PI;

function aspectPt(landmarks: readonly Landmark[], name: LandmarkName, minVis: number, aspect: number): Pt | null {
  const p = getLandmark(landmarks, name);
  return p && p.visibility >= minVis ? [p.x * aspect, p.y] : null;
}

function center(a: Pt | null, b: Pt | null): Pt | null {
  return a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function meanY(pts: (Pt | null)[]): number | null {
  const ys = pts.filter((p): p is Pt => p !== null).map((p) => p[1]);
  return ys.length ? ys.reduce((s, y) => s + y, 0) / ys.length : null;
}

/**
 * Chin height from the face: mouth + k·(mouth − nose), vertically [DERIVED — see PULLUP_FACE].
 * A head tilted so far back that the mouth reads above the nose collapses the estimate to the
 * mouth itself rather than extrapolating upward.
 */
export function estimateChinY(noseY: number | null, mouthY: number | null): number | null {
  if (noseY === null || mouthY === null) return null;
  return mouthY + PULLUP_FACE.chinBelowMouth * Math.max(0, mouthY - noseY);
}

/**
 * Hand→hip line vs vertical (deg), signed so + = hips toward the way the lifter faces. `faceDir`
 * is +1 when the lifter faces +x in the image. null unless the hips hang below the hands.
 */
export function swingAngleDeg(wrist: Pt | null, hip: Pt | null, faceDir: 1 | -1): number | null {
  if (!wrist || !hip) return null;
  const dy = hip[1] - wrist[1];
  if (dy <= 1e-6) return null;
  return Math.atan2((hip[0] - wrist[0]) * faceDir, dy) * DEG;
}

interface Chain {
  shoulder: Pt | null;
  elbow: Pt | null;
  wrist: Pt | null;
  hip: Pt | null;
  knee: Pt | null;
  ankle: Pt | null;
  index: Pt | null;
  pinky: Pt | null;
  mouth: Pt | null;
  ear: Pt | null;
}

function chain(landmarks: readonly Landmark[], side: Side, minVis: number, aspect: number): Chain {
  const P = side === "left" ? "LEFT_" : "RIGHT_";
  const at = (n: string) => aspectPt(landmarks, (P + n) as LandmarkName, minVis, aspect);
  return {
    shoulder: at("SHOULDER"),
    elbow: at("ELBOW"),
    wrist: at("WRIST"),
    hip: at("HIP"),
    knee: at("KNEE"),
    ankle: at("ANKLE"),
    index: at("INDEX"),
    pinky: at("PINKY"),
    mouth: aspectPt(landmarks, side === "left" ? "MOUTH_LEFT" : "MOUTH_RIGHT", minVis, aspect),
    ear: at("EAR"),
  };
}

function elbowAngle(c: Chain): number | null {
  return c.shoulder && c.elbow && c.wrist ? calculateAngle(c.shoulder, c.elbow, c.wrist) : null;
}

export function computePullupFrame(
  landmarks: readonly Landmark[],
  minVis: number,
  t: number,
  aspect: number,
  nearSide: Side | null,
): PullupFrame {
  const L = chain(landmarks, "left", minVis, aspect);
  const R = chain(landmarks, "right", minVis, aspect);
  const near = nearSide === "left" ? L : nearSide === "right" ? R : null;
  const nose = aspectPt(landmarks, "NOSE", minVis, aspect);

  const shoulder = near ? near.shoulder : center(L.shoulder, R.shoulder);
  const wrist = near ? near.wrist : center(L.wrist, R.wrist);
  const handY = near ? meanY([near.index, near.pinky]) : meanY([L.index, L.pinky, R.index, R.pinky]);
  // Both mouth corners when readable (a profile often shows the far one too, at a similar height).
  const chinY = estimateChinY(nose ? nose[1] : null, meanY([L.mouth, R.mouth]));

  const armLens = (near ? [near] : [L, R])
    .map((c) => (c.shoulder && c.elbow ? dist(c.shoulder, c.elbow) : null))
    .filter((v): v is number => v !== null && v > 1e-6);
  const upperArmLen = armLens.length ? Math.max(...armLens) : null;

  // Head level: the nose, else the ears, else a clearly raised arm (a full upper arm above the
  // shoulder). At the TOP of a rep the nose is above the hands — this only gates the HANG.
  const earY = meanY([L.ear, R.ear]);
  const headY = nose ? nose[1] : earY ?? (shoulder && upperArmLen !== null ? shoulder[1] - upperArmLen : null);
  const armsOverhead = wrist !== null && headY !== null && wrist[1] < headY;

  let elbowAngleDeg: number | null;
  if (near) elbowAngleDeg = elbowAngle(near);
  else {
    const both = [elbowAngle(L), elbowAngle(R)].filter((v): v is number => v !== null);
    elbowAngleDeg = both.length ? Math.min(...both) : null;
  }

  let swingDeg: number | null = null;
  let hipAngleDeg: number | null = null;
  let kneeAngleDeg: number | null = null;
  if (near) {
    const faceDir: 1 | -1 = nose && near.shoulder && nose[0] < near.shoulder[0] ? -1 : 1;
    swingDeg = swingAngleDeg(near.wrist, near.hip, faceDir);
    if (near.shoulder && near.hip && near.knee) hipAngleDeg = calculateAngle(near.shoulder, near.hip, near.knee);
    if (near.hip && near.knee && near.ankle) kneeAngleDeg = calculateAngle(near.hip, near.knee, near.ankle);
  }

  let shoulderWidth: number | null = null;
  let wristSpan: number | null = null;
  let gripWidthRatio: number | null = null;
  let shoulderTiltDiffDeg: number | null = null;
  if (!near) {
    const span = (a: Pt | null, b: Pt | null) => (a && b ? Math.abs(a[0] - b[0]) : null);
    shoulderWidth = span(L.shoulder, R.shoulder);
    wristSpan = span(L.wrist, R.wrist);
    if (shoulderWidth !== null && shoulderWidth > 1e-4 && wristSpan !== null) gripWidthRatio = wristSpan / shoulderWidth;
    if (L.shoulder && R.shoulder && L.wrist && R.wrist) {
      shoulderTiltDiffDeg = Math.abs(lineTiltDeg(L.shoulder, R.shoulder) - lineTiltDeg(L.wrist, R.wrist));
    }
  }

  return {
    t,
    aspect,
    nearSide,
    shoulder,
    wrist,
    handY,
    chinY,
    upperArmLen,
    armsOverhead,
    elbowAngleDeg,
    swingDeg,
    hipAngleDeg,
    kneeAngleDeg,
    shoulderWidth,
    wristSpan,
    gripWidthRatio,
    shoulderTiltDiffDeg,
  };
}

/**
 * Bar-line sample for this frame: the grip knuckles, else the wrist lifted by the [DERIVED] palm
 * offset. null when neither is readable.
 */
export function barSampleY(f: PullupFrame): number | null {
  if (f.handY !== null) return f.handY;
  if (f.wrist && f.upperArmLen !== null) return f.wrist[1] - PULLUP_FACE.barAboveWristUpperArms * f.upperArmLen;
  return null;
}

/** Landmark indices the per-rep visibility check reads, per view: both arms + shoulders head-on,
 *  the near shoulder/arm/hip chain side-on (the hanging legs are often cropped by the frame). */
export function pullupVisibilityIndices(orientation: "front" | "side", nearSide: Side | null): number[] {
  if (orientation === "front") return [11, 12, 13, 14, 15, 16];
  return nearSide === "right" ? [12, 14, 16, 24] : [11, 13, 15, 23];
}
