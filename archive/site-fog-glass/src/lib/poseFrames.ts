/**
 * The squat itself: two keyframes, a tempo curve, and the deformations that make
 * a rep go wrong. Also the pieces every exercise shares: the pose type, the rest
 * lengths of the skeleton, and the pass that keeps it rigid.
 *
 * PURE — no React, no three, no DOM. Poses are flat `Float32Array`s of
 * `JOINT_COUNT * 3` so the per-frame path never allocates.
 *
 * Matching bone lengths between STAND and BOTTOM is necessary but NOT sufficient:
 * interpolating two endpoints of a limb that swings through ~90° shortens the
 * chord between them, and the femur measured 25.6% short at mid-depth even with
 * both keyframes correct. So the lerp is followed by a length-constraint pass
 * (`relax`), which is what actually keeps the skeleton rigid.
 *
 * The proportions are deliberately long in the femur relative to the shin, which
 * is both what makes a squat tip forward and what the tracker's own thresholds
 * were measured on.
 */
import { BONES, J, JOINT_COUNT, type JointName } from "./pose";

export type Pose = Float32Array;

export const newPose = (): Pose => new Float32Array(JOINT_COUNT * 3);

/* eslint-disable prettier/prettier */
/** Standing, arms at the sides. Feet are planted here and never move. */
export const STAND: Pose = new Float32Array([
   0.000, 1.680,  0.010, // head
   0.000, 1.520, -0.010, // neck
  -0.200, 1.460, -0.010, // shoulderL
   0.200, 1.460, -0.010, // shoulderR
  -0.235, 1.200,  0.000, // elbowL
   0.235, 1.200,  0.000, // elbowR
  -0.250, 0.960,  0.020, // wristL
   0.250, 0.960,  0.020, // wristR
  -0.130, 0.940, -0.020, // hipL
   0.130, 0.940, -0.020, // hipR
  -0.175, 0.500,  0.020, // kneeL
   0.175, 0.500,  0.020, // kneeR
  -0.170, 0.070,  0.000, // ankleL
   0.170, 0.070,  0.000, // ankleR
  -0.170, 0.020,  0.160, // toeL
   0.170, 0.020,  0.160, // toeR
]);

/**
 * Parallel depth — hip crease level with the knee, which is the app's default
 * preset. The hip drops 0.505 while the knee drops only 0.065 and travels
 * forward: that asymmetry is exactly why depth is measured as hip-Y against
 * knee-Y and not as a knee angle, and why it reads from either camera angle.
 * Arms reach forward as a counterweight, as they do in a real bodyweight squat.
 */
export const BOTTOM: Pose = new Float32Array([
   0.000, 1.087,  0.135, // head
   0.000, 0.936,  0.080, // neck
  -0.200, 0.885,  0.049, // shoulderL
   0.200, 0.885,  0.049, // shoulderR
  -0.220, 0.734,  0.264, // elbowL
   0.220, 0.734,  0.264, // elbowR
  -0.230, 0.671,  0.497, // wristL
   0.230, 0.671,  0.497, // wristR
  -0.130, 0.435, -0.211, // hipL
   0.130, 0.435, -0.211, // hipR
  -0.200, 0.435,  0.228, // kneeL
   0.200, 0.435,  0.228, // kneeR
  -0.170, 0.070,  0.000, // ankleL
   0.170, 0.070,  0.000, // ankleR
  -0.170, 0.020,  0.160, // toeL
   0.170, 0.020,  0.160, // toeR
]);
/* eslint-enable prettier/prettier */

/* ── tempo ───────────────────────────────────────────────────────────────── */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** A trapezoid: 0 → 1 across [a,b], 1 across [b,c], 1 → 0 across [c,d]. */
export const bump = (v: number, a: number, b: number, c: number, d: number) =>
  smoothstep(a, b, v) * (1 - smoothstep(c, d, v));

/* Phase landmarks within one rep. The descent gets more of the rep than the
   ascent (0.46 against 0.36) because a real squat is a slow eccentric and a
   faster concentric — and because the app's own eccentric-control check exists
   precisely to notice when that ratio inverts. */
const DESCENT_START = 0.06;
const DESCENT_END = 0.52;
const BOTTOM_END = 0.58;
const ASCENT_END = 0.94;

/** Rep phase (0…1) → depth (0 standing, 1 at the bottom). Every exercise uses
 *  this tempo: down slow, a beat at the bottom, up faster. */
export function depthAt(phase: number): number {
  if (phase <= DESCENT_START) return 0;
  if (phase < DESCENT_END) {
    const t = (phase - DESCENT_START) / (DESCENT_END - DESCENT_START);
    return t * t * (3 - 2 * t);
  }
  if (phase < BOTTOM_END) return 1;
  if (phase < ASCENT_END) {
    const t = (phase - BOTTOM_END) / (ASCENT_END - BOTTOM_END);
    return 1 - t * t * (3 - 2 * t);
  }
  return 0;
}

/** Where the bottom of a rep is, as rep phase: the middle of the pause. */
export const BOTTOM_PHASE = (DESCENT_END + BOTTOM_END) / 2;

/* ── what can go wrong ───────────────────────────────────────────────────── */

/**
 * The squat's faults. All three are things the app checks: knee cave (T7),
 * forward lean (T1) and hip shift (T11). A rep that stops short of depth is not
 * a fault at all — the counter just doesn't tick — so it is a depth cap in the
 * loop, not a deformation here.
 */
export type BeatKind = "valgus" | "lean" | "shift";

/**
 * Knees caving, timed to the ASCENT — which is not a staging choice. The
 * 2026-07-31 eval run reconstructed the cave from the landmark buffer and found
 * it worst on the way UP (valgus ratio 0.63 → 0.59 → 0.52 as the lifter rose),
 * below the trigger's old 0.30 depth gate. That is why the gate moved to 0.15.
 */
export const valgusEnvelope = (phase: number) => bump(phase, 0.58, 0.72, 0.84, 0.93);

/** Trunk pitching forward, worst at the bottom where the moment arm is longest. */
export const leanEnvelope = (phase: number) => bump(phase, 0.32, 0.5, 0.64, 0.82);

/** Hips drifting to one side out of the bottom — the lifter unloading one leg
 *  as they drive up. Gone again by lockout, where the tracker's shift reading
 *  stops meaning anything (it peaks near 1.4 hip-widths standing). */
export const shiftEnvelope = (phase: number) => bump(phase, 0.46, 0.6, 0.78, 0.9);

export const envelopeFor = (kind: BeatKind, phase: number) =>
  kind === "valgus" ? valgusEnvelope(phase) : kind === "lean" ? leanEnvelope(phase) : shiftEnvelope(phase);

/** Fraction of its half-stance each knee travels toward the midline at full cave. */
const VALGUS_COLLAPSE = 0.62;
/** Extra forward pitch of the trunk at full lean, in radians (~20°). */
const LEAN_EXTRA_RAD = 0.35;
/** How far the hips slide sideways at full shift, metres: ~0.35 hip-widths,
 *  past the tracker's 0.3 warn line. */
export const SHIFT_M = 0.09;

const UPPER_BODY: JointName[] = [
  "head",
  "neck",
  "shoulderL",
  "shoulderR",
  "elbowL",
  "elbowR",
  "wristL",
  "wristR",
];

/* ── keeping the skeleton rigid ──────────────────────────────────────────── */

/** Rest length of every bone, taken from the standing keyframe. Every exercise
 *  is the same body, so every exercise holds these. */
export const REST = BONES.map(([a, b]) =>
  Math.hypot(
    STAND[J[a] * 3] - STAND[J[b] * 3],
    STAND[J[a] * 3 + 1] - STAND[J[b] * 3 + 1],
    STAND[J[a] * 3 + 2] - STAND[J[b] * 3 + 2],
  ),
);

/** Squat contacts: the feet are on the floor and never move — everything else
 *  resolves around them, which is also why the figure never appears to slide. */
export const SQUAT_PINNED: ReadonlySet<number> = new Set([J.ankleL, J.ankleR, J.toeL, J.toeR]);

/**
 * Iterative length constraint (Jakobsen relaxation): walk every bone, and push
 * its two ends apart or together until it is its rest length again, with the
 * contact points held fixed. A handful of passes converges because the chains
 * are short.
 *
 * This is what makes interpolation between two keyframes viable at all. It also
 * handles the closed loops (the hip line, the shoulder line) that a parent-child
 * FK chain could not, and it keeps the FAULT poses honest too: pulling a knee
 * inward shortens its shin, and the constraint resolves that by letting the knee
 * ride up and over the ankle — which is what a real cave does.
 */
export function relax(p: Pose, pinned: ReadonlySet<number> = SQUAT_PINNED, iterations = 10): void {
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < BONES.length; i++) {
      const [an, bn] = BONES[i];
      const ai = J[an] * 3;
      const bi = J[bn] * 3;
      const dx = p[bi] - p[ai];
      const dy = p[bi + 1] - p[ai + 1];
      const dz = p[bi + 2] - p[ai + 2];
      const d = Math.hypot(dx, dy, dz) || 1e-6;

      const aFixed = pinned.has(J[an]);
      const bFixed = pinned.has(J[bn]);
      if (aFixed && bFixed) continue;

      const diff = (d - REST[i]) / d;
      const wa = aFixed ? 0 : bFixed ? 1 : 0.5;
      const wb = bFixed ? 0 : aFixed ? 1 : 0.5;

      p[ai] += dx * diff * wa;
      p[ai + 1] += dy * diff * wa;
      p[ai + 2] += dz * diff * wa;
      p[bi] -= dx * diff * wb;
      p[bi + 1] -= dy * diff * wb;
      p[bi + 2] -= dz * diff * wb;
    }
  }
}

/**
 * Write the squat pose for a given depth and beat into `out`.
 *
 * Deformations are applied on top of the interpolated pose rather than baked
 * into their own keyframes, so one can be dialled from nothing to full at any
 * depth and the clean reps share exactly one code path with the rest.
 *
 * Order matters: deform, then relax. Relaxing last is what turns a moved joint
 * into a skeleton that moved with it, instead of one joint pulled off its bones.
 */
export function poseAt(depth: number, kind: BeatKind | null, amount: number, out: Pose): void {
  for (let i = 0; i < out.length; i++) {
    out[i] = STAND[i] + (BOTTOM[i] - STAND[i]) * depth;
  }

  if (kind && amount > 0) {
    if (kind === "valgus") {
      // Ankles stay planted, so pulling the knees toward the midline is what
      // tips the shins inward — the segment the eye actually reads as the fault.
      const k = 1 - VALGUS_COLLAPSE * amount;
      out[J.kneeL * 3] *= k;
      out[J.kneeR * 3] *= k;
    } else if (kind === "lean") {
      // Rotate the upper body about the hip line in the SAGITTAL plane. A
      // rotation, not a translation — a translated torso keeps its angle and
      // reads as a glitch.
      rotateUpper(out, LEAN_EXTRA_RAD * amount);
    } else {
      // The hips slide toward the lifter's right (+X), the knees half as far,
      // and the trunk goes with the hips: the whole body sits over one leg.
      const dx = SHIFT_M * amount;
      for (const name of ["hipL", "hipR", ...UPPER_BODY] as JointName[]) out[J[name] * 3] += dx;
      out[J.kneeL * 3] += dx * 0.5;
      out[J.kneeR * 3] += dx * 0.5;
    }
  }

  relax(out);
}

/** Pitch the upper body forward about the hip line, in the sagittal plane. */
function rotateUpper(out: Pose, theta: number): void {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const pivotY = (out[J.hipL * 3 + 1] + out[J.hipR * 3 + 1]) / 2;
  const pivotZ = (out[J.hipL * 3 + 2] + out[J.hipR * 3 + 2]) / 2;

  for (const name of UPPER_BODY) {
    const i = J[name] * 3;
    const dy = out[i + 1] - pivotY;
    const dz = out[i + 2] - pivotZ;
    out[i + 1] = pivotY + dy * cos - dz * sin;
    out[i + 2] = pivotZ + dy * sin + dz * cos;
  }
}
