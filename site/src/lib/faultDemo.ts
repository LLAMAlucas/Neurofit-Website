/**
 * The pick-a-fault demo: one rep, on demand, and whether the camera can see it.
 *
 * PURE — no React, no three, no DOM.
 *
 * Unlike the page's camera path, which is scrubbed by scroll, this runs on a
 * CLOCK: you pick a fault and the body performs one rep of it. The rep itself is the same
 * one the rest of the site uses — `poseAt`, `depthAt` and the fault envelopes —
 * so the timing of the fault inside the rep (knee cave on the way UP, lean at
 * the bottom) is inherited, not re-staged.
 */
import { J } from "./pose";
import { depthAt, envelopeFor, poseAt, type BeatKind, type Pose } from "./poseFrames";

export type FaultId = "clean" | "valgus" | "lean";
export type Plane = "frontal" | "sagittal";

export type FaultSpec = {
  id: FaultId;
  /** What the picker button says. */
  label: string;
  /** The deformation `poseAt` applies. Null for a clean rep. */
  beat: BeatKind | null;
  /** The plane the tracker judges this fault in. Null: nothing to judge. */
  plane: Plane | null;
  /** HUD tag. */
  tag: string;
};

/**
 * Only the two triggers the product actually stands behind. Left out on the
 * repo's own evidence: hip shift (T11 — one correct fire in four), the
 * descent/bounce check (T2 — zero true positives), and shoulder levelness,
 * which is demoted to context and must never be drawn as a fault.
 */
export const FAULTS: Record<FaultId, FaultSpec> = {
  clean: { id: "clean", label: "Clean rep", beat: null, plane: null, tag: "CLEAN REP" },
  valgus: { id: "valgus", label: "Knee cave", beat: "valgus", plane: "frontal", tag: "KNEE CAVE" },
  lean: { id: "lean", label: "Forward lean", beat: "lean", plane: "sagittal", tag: "FORWARD LEAN" },
};

export const FAULT_ORDER: FaultId[] = ["clean", "valgus", "lean"];

const DEG = Math.PI / 180;

/**
 * How far off square-on each check still reads, from the tracker's own
 * `SQUAT.checkToleranceDeg` (src/neurofit/squat/config.ts): kneeValgus 15,
 * forwardLean 15. Copied, not imported — the site never imports tracker code.
 * Outside it the tracker returns "unknown", so the red must be gone by then.
 */
export const VIEW_TOLERANCE_DEG: Record<Plane, number> = { frontal: 15, sagittal: 15 };

/**
 * Camera azimuth, in radians: 0 puts the camera in front of the body (+Z, the
 * way the figure faces), π/2 at its side. These are where each plane is read
 * square-on — and the glide target when a fault is picked.
 */
export const SQUARE_ON: Record<Plane, number> = { frontal: 0, sagittal: Math.PI / 2 };

/** One rep, in seconds. Slow enough to watch the fault arrive. */
export const REP_S = 3.4;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * Angle between the camera and the nearest view that reads `plane` square-on.
 * Front and back both read the frontal plane; either side reads the sagittal.
 */
export function offPlane(plane: Plane, azimuth: number): number {
  const a = ((azimuth % Math.PI) + Math.PI) % Math.PI; // fold: 0 ≡ π
  const d = Math.abs(a - SQUARE_ON[plane]);
  return Math.min(d, Math.PI - d);
}

/**
 * 1 when the camera reads the plane square-on, 0 at the check's tolerance and
 * beyond. It eases off inside the band rather than snapping, but it reaches 0
 * AT the tolerance, never after it: past that edge the product has no verdict.
 */
export function planeVisibility(plane: Plane, azimuth: number): number {
  const tol = VIEW_TOLERANCE_DEG[plane] * DEG;
  return 1 - smoothstep(tol * 0.6, tol, offPlane(plane, azimuth));
}

export type RepSample = {
  /** 0…1 through the rep. */
  phase: number;
  depth: number;
  /** How present the fault is, 0…1, before severity. */
  envelope: number;
  done: boolean;
};

/**
 * The pose `t` seconds into a rep of `fault`, written into `out`.
 * @param severity 0…1 — scales the deformation, so a mild fault looks mild.
 */
export function repAt(fault: FaultId, t: number, severity: number, out: Pose): RepSample {
  const phase = clamp01(t / REP_S);
  const depth = depthAt(phase);
  const beat = FAULTS[fault].beat;
  const envelope = beat ? envelopeFor(beat, phase) : 0;
  poseAt(depth, beat, envelope * clamp01(severity), out);
  return { phase, depth, envelope, done: t >= REP_S };
}

/* ── readouts ─────────────────────────────────────────────────────────────
   Degrees are the only measurements the site quotes, and they are computed
   from the live pose — never typed. */

const angleAt = (p: Pose, a: number, b: number, c: number) => {
  const ux = p[a * 3] - p[b * 3], uy = p[a * 3 + 1] - p[b * 3 + 1], uz = p[a * 3 + 2] - p[b * 3 + 2];
  const vx = p[c * 3] - p[b * 3], vy = p[c * 3 + 1] - p[b * 3 + 1], vz = p[c * 3 + 2] - p[b * 3 + 2];
  const cos = (ux * vx + uy * vy + uz * vz) / (Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz) || 1);
  return Math.acos(Math.max(-1, Math.min(1, cos))) / DEG;
};

/** Interior knee angle (hip–knee–ankle), mean of both legs. ~180° standing. */
export function kneeAngleDeg(p: Pose): number {
  return (angleAt(p, J.hipL, J.kneeL, J.ankleL) + angleAt(p, J.hipR, J.kneeR, J.ankleR)) / 2;
}

/** Trunk (hip midpoint → shoulder midpoint) from vertical, in the sagittal plane. */
export function trunkLeanDeg(p: Pose): number {
  const dy = (p[J.shoulderL * 3 + 1] + p[J.shoulderR * 3 + 1] - p[J.hipL * 3 + 1] - p[J.hipR * 3 + 1]) / 2;
  const dz = (p[J.shoulderL * 3 + 2] + p[J.shoulderR * 3 + 2] - p[J.hipL * 3 + 2] - p[J.hipR * 3 + 2]) / 2;
  return Math.abs(Math.atan2(dz, dy)) / DEG;
}

/** What the HUD calls the current camera position. */
export function viewLabel(azimuth: number): string {
  if (offPlane("frontal", azimuth) <= VIEW_TOLERANCE_DEG.frontal * DEG) {
    const a = ((azimuth % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    return a > Math.PI / 2 && a < (3 * Math.PI) / 2 ? "BACK VIEW" : "FRONT VIEW";
  }
  if (offPlane("sagittal", azimuth) <= VIEW_TOLERANCE_DEG.sagittal * DEG) return "SIDE VIEW";
  return `OBLIQUE ${Math.round(offPlane("frontal", azimuth) / DEG)}°`;
}
