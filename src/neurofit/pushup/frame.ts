/**
 * Per-frame push-up features. PURE module.
 * ----------------------------------------------------------------------------
 * Turns one frame of MediaPipe landmarks into the scalars the push-up rep counter, checks and
 * triggers consume.
 *
 * ASPECT SPACE. MediaPipe normalizes x by image WIDTH and y by image HEIGHT, so on a 16:9 frame
 * one unit of x is 1.78× one unit of y and every angle computed on raw coordinates is distorted.
 * The squat lives with that caveat (its angles are relative proxies). Push-up geometry can't:
 * the body line and upper-arm angle are the decision numbers and the body is HORIZONTAL, so the
 * distortion lands exactly on them. Every point here is converted to [x·W/H, y] first.
 *
 * SIDE vs FRONT fields. A side view only trusts the NEAR-side limb chain — MediaPipe still
 * returns the occluded far limbs, at plausible-looking but invented positions. `nearSide` is
 * chosen by the caller (NearSideSelector) and is null on front sets, where every sagittal field
 * is null and only bilateral (frontal) spans are computed. Every field is nullable: a check whose
 * joints aren't visible is SKIPPED ("unknown"), never failed — occlusion ≠ bad form.
 */
import { calculateAngle } from "../pose/angle";
import { getLandmark, type Landmark, type LandmarkName } from "../pose/landmarks";
import type { PushupVariant } from "./config";

export type Pt = [number, number];
export type Side = "left" | "right";

export interface PushupFrame {
  t: number;
  /** W/H of the image the landmarks were normalized against. */
  aspect: number;
  nearSide: Side | null;

  /** Rep-counting points: near side on side sets, bilateral midpoint on front sets. */
  shoulder: Pt | null;
  wrist: Pt | null;

  // --- SAGITTAL (near side; null when nearSide is null) ---
  elbowAngleDeg: number | null;
  /** Upper arm vs horizontal (deg). + = shoulder BELOW elbow (deeper), 0 = parallel, −90 = arm vertical. */
  upperArmAngleDeg: number | null;
  /** Signed deviation of shoulder–hip–distal from a straight line (deg). + = sag, − = pike.
   *  Distal = ankle (toes) or knee (knees variant). */
  bodyLineDeg: number | null;
  /** Ear vs the extended hip→shoulder line (deg). + = head dropped below the line. Context only. */
  headDropDeg: number | null;
  /** Shoulder→wrist vs vertical (deg). + = hands ahead of the shoulders (toward the head). Context. */
  handOffsetDeg: number | null;
  /** Hip–knee–ankle angle (deg), for the knee-variant context check. */
  kneeAngleDeg: number | null;
  /** Knee height above the wrists, in arm lengths (shoulder→elbow→wrist). Knees down ≈ 0. */
  kneeHeightArms: number | null;
  /** Shoulder→hip line vs horizontal (deg), for the plank-posture lock gate. */
  torsoInclineDeg: number | null;

  // --- FRONTAL (bilateral; both sides required) ---
  shoulderWidth: number | null;
  elbowSpan: number | null;
  wristSpan: number | null;
  /** (elbowSpan − wristSpan)/shoulderWidth — elbows travelling outside the wrists. */
  flareRatio: number | null;
  /** wristSpan/shoulderWidth. Context only. */
  handWidthRatio: number | null;
  /** |shoulder-line tilt − wrist-line tilt| (deg). Roll-invariant: the wrists sit on the floor. */
  shoulderTiltDiffDeg: number | null;
}

const DEG = 180 / Math.PI;

function aspectPt(landmarks: readonly Landmark[], name: LandmarkName, minVis: number, aspect: number): Pt | null {
  const p = getLandmark(landmarks, name);
  return p && p.visibility >= minVis ? [p.x * aspect, p.y] : null;
}

function center(a: Pt | null, b: Pt | null): Pt | null {
  if (a && b) return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return null;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Tilt of the line a→b off horizontal, in degrees [-90, 90]. */
export function lineTiltDeg(a: Pt, b: Pt): number {
  let deg = Math.atan2(b[1] - a[1], b[0] - a[0]) * DEG;
  if (deg > 90) deg -= 180;
  if (deg < -90) deg += 180;
  return deg;
}

/**
 * Signed body-line deviation (deg): 180 − the shoulder–hip–distal angle, + when the hip sits
 * BELOW the shoulder→distal line (sag; y grows downward), − when above (pike). null unless the hip
 * lies horizontally between the shoulder and the distal point — anything else is not a plank.
 */
export function signedBodyLineDeg(shoulder: Pt | null, hip: Pt | null, distal: Pt | null): number | null {
  if (!shoulder || !hip || !distal) return null;
  const dx = distal[0] - shoulder[0];
  if (Math.abs(dx) < 1e-6) return null;
  const along = (hip[0] - shoulder[0]) / dx;
  if (along <= 0 || along >= 1) return null;
  const lineY = shoulder[1] + along * (distal[1] - shoulder[1]);
  const dev = 180 - calculateAngle(shoulder, hip, distal);
  return hip[1] > lineY ? dev : -dev;
}

/** Ear vs the extended hip→shoulder line (deg), + = ear below it, whichever way the lifter faces. */
export function headDropDeg(hip: Pt | null, shoulder: Pt | null, ear: Pt | null): number | null {
  if (!hip || !shoulder || !ear) return null;
  const dx = shoulder[0] - hip[0];
  const dy = shoulder[1] - hip[1];
  const ex = ear[0] - shoulder[0];
  const ey = ear[1] - shoulder[1];
  if (Math.hypot(dx, dy) < 1e-6 || Math.hypot(ex, ey) < 1e-6) return null;
  const ang = Math.atan2(dx * ey - dy * ex, dx * ex + dy * ey) * DEG;
  return (dx >= 0 ? 1 : -1) * ang;
}

/** Shoulder→wrist vs vertical (deg), + = wrists toward the head. null if the wrist isn't below. */
export function handOffsetDeg(shoulder: Pt | null, wrist: Pt | null, hip: Pt | null): number | null {
  if (!shoulder || !wrist || !hip) return null;
  const dy = wrist[1] - shoulder[1];
  if (dy <= 1e-6) return null;
  const headSign = shoulder[0] - hip[0] >= 0 ? 1 : -1;
  return Math.atan2((wrist[0] - shoulder[0]) * headSign, dy) * DEG;
}

/** Upper arm vs horizontal (deg), + = shoulder below elbow. */
export function upperArmAngleDeg(shoulder: Pt | null, elbow: Pt | null): number | null {
  if (!shoulder || !elbow) return null;
  const dx = Math.abs(shoulder[0] - elbow[0]);
  const dy = shoulder[1] - elbow[1];
  if (dx < 1e-6 && Math.abs(dy) < 1e-6) return null;
  return Math.atan2(dy, dx) * DEG;
}

interface Chain {
  shoulder: Pt | null;
  elbow: Pt | null;
  wrist: Pt | null;
  hip: Pt | null;
  knee: Pt | null;
  ankle: Pt | null;
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
    ear: at("EAR"),
  };
}

export function computePushupFrame(
  landmarks: readonly Landmark[],
  minVis: number,
  t: number,
  aspect: number,
  nearSide: Side | null,
  variant: PushupVariant,
): PushupFrame {
  const L = chain(landmarks, "left", minVis, aspect);
  const R = chain(landmarks, "right", minVis, aspect);
  const near = nearSide === "left" ? L : nearSide === "right" ? R : null;

  const shoulder = near ? near.shoulder : center(L.shoulder, R.shoulder);
  const wrist = near ? near.wrist : center(L.wrist, R.wrist);

  let elbowAngle: number | null = null;
  let upperArm: number | null = null;
  let bodyLine: number | null = null;
  let headDrop: number | null = null;
  let handOffset: number | null = null;
  let kneeAngle: number | null = null;
  let kneeHeightArms: number | null = null;
  let torsoIncline: number | null = null;
  if (near) {
    const { elbow, hip, knee, ankle, ear } = near;
    const s = near.shoulder;
    const w = near.wrist;
    if (s && elbow && w) elbowAngle = calculateAngle(s, elbow, w);
    upperArm = upperArmAngleDeg(s, elbow);
    bodyLine = signedBodyLineDeg(s, hip, variant === "knees" ? knee : ankle);
    headDrop = headDropDeg(hip, s, ear);
    handOffset = handOffsetDeg(s, w, hip);
    if (hip && knee && ankle) kneeAngle = calculateAngle(hip, knee, ankle);
    if (s && elbow && w && knee) {
      const armLen = dist(s, elbow) + dist(elbow, w);
      if (armLen > 1e-6) kneeHeightArms = (w[1] - knee[1]) / armLen;
    }
    if (s && hip) torsoIncline = Math.atan2(Math.abs(s[1] - hip[1]), Math.abs(s[0] - hip[0])) * DEG;
  }

  const span = (a: Pt | null, b: Pt | null) => (a && b ? Math.abs(a[0] - b[0]) : null);
  const shoulderWidth = span(L.shoulder, R.shoulder);
  const elbowSpan = span(L.elbow, R.elbow);
  const wristSpan = span(L.wrist, R.wrist);
  const wideEnough = shoulderWidth !== null && shoulderWidth > 1e-4;
  const flareRatio = wideEnough && elbowSpan !== null && wristSpan !== null ? (elbowSpan - wristSpan) / shoulderWidth : null;
  const handWidthRatio = wideEnough && wristSpan !== null ? wristSpan / shoulderWidth : null;
  const shoulderTiltDiffDeg =
    L.shoulder && R.shoulder && L.wrist && R.wrist
      ? Math.abs(lineTiltDeg(L.shoulder, R.shoulder) - lineTiltDeg(L.wrist, R.wrist))
      : null;

  return {
    t,
    aspect,
    nearSide,
    shoulder,
    wrist,
    elbowAngleDeg: elbowAngle,
    upperArmAngleDeg: upperArm,
    bodyLineDeg: bodyLine,
    headDropDeg: headDrop,
    handOffsetDeg: handOffset,
    kneeAngleDeg: kneeAngle,
    kneeHeightArms,
    torsoInclineDeg: torsoIncline,
    shoulderWidth,
    elbowSpan,
    wristSpan,
    flareRatio,
    handWidthRatio,
    shoulderTiltDiffDeg,
  };
}

const LEFT_CHAIN_IDX = [11, 13, 15, 23];
const RIGHT_CHAIN_IDX = [12, 14, 16, 24];

/**
 * Which limb chain is nearer the camera on a side set. Visibility alone is weak (MediaPipe
 * reports invented far limbs with decent confidence), so the shoulder z-difference is added:
 * a smaller z is closer to the camera. Smoothed with hysteresis so a noisy frame can't swap
 * every measurement onto the far arm mid-rep.
 */
export class NearSideSelector {
  private ema: number | null = null;
  private current: Side | null = null;

  constructor(
    private readonly alpha = 0.3,
    private readonly hysteresis = 0.1,
  ) {}

  update(landmarks: readonly Landmark[]): Side | null {
    const meanVis = (idx: number[]) => idx.reduce((s, i) => s + (landmarks[i]?.visibility ?? 0), 0) / idx.length;
    const ls = landmarks[11];
    const rs = landmarks[12];
    const zTerm = ls && rs ? Math.max(-0.5, Math.min(0.5, rs.z - ls.z)) : 0;
    const raw = meanVis(LEFT_CHAIN_IDX) - meanVis(RIGHT_CHAIN_IDX) + zTerm;
    this.ema = this.ema === null ? raw : this.alpha * raw + (1 - this.alpha) * this.ema;
    if (this.current === null) this.current = this.ema >= 0 ? "left" : "right";
    else if (this.current === "left" && this.ema < -this.hysteresis) this.current = "right";
    else if (this.current === "right" && this.ema > this.hysteresis) this.current = "left";
    return this.current;
  }

  side(): Side | null {
    return this.current;
  }

  reset(): void {
    this.ema = null;
    this.current = null;
  }
}

/** Landmark indices the per-rep visibility check reads, per view. Front-on the hips and legs sit
 *  behind the head/torso, so only the arms + shoulders are meaningful; side-on only the near chain. */
export function pushupVisibilityIndices(orientation: "front" | "side", nearSide: Side | null): number[] {
  if (orientation === "front") return [11, 12, 13, 14, 15, 16];
  return nearSide === "right" ? RIGHT_CHAIN_IDX : LEFT_CHAIN_IDX;
}
