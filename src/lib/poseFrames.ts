/**
 * The squat itself: two keyframes, a tempo curve, and the deformations that make
 * a rep go wrong.
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
import { BONES, J, JOINT_COUNT, boneIndex, type JointName } from "./pose";

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
const bump = (v: number, a: number, b: number, c: number, d: number) =>
  smoothstep(a, b, v) * (1 - smoothstep(c, d, v));

/* Phase landmarks within one rep. The descent gets more of the rep than the
   ascent (0.46 against 0.36) because a real squat is a slow eccentric and a
   faster concentric — and because the app's own eccentric-control check exists
   precisely to notice when that ratio inverts. */
const DESCENT_START = 0.06;
const DESCENT_END = 0.52;
const BOTTOM_END = 0.58;
const ASCENT_END = 0.94;

/** Rep phase (0…1) → depth (0 standing, 1 at parallel). */
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

/* ── what can go wrong ───────────────────────────────────────────────────── */

/**
 * The three things a rep can do here.
 *
 * They are NOT all faults, and the distinction is load-bearing. `valgus` and
 * `lean` are real triggers the app fires on (T7 and T1). `unlevel` is shoulder
 * levelness, which the app measures and reports as context but has DEMOTED from
 * asserting a fault — the reading is aspect-distorted and jittery. So it is
 * drawn as a measurement (see `marked` in `BEAT_SPEC`) and never in fault red:
 * the page should not claim a verdict the product does not make.
 */
export type BeatKind = "valgus" | "lean" | "unlevel";

/**
 * Knees caving, timed to the ASCENT — which is not a staging choice. The
 * 2026-07-31 eval run reconstructed the cave from the landmark buffer and found
 * it worst on the way UP (valgus ratio 0.63 → 0.59 → 0.52 as the lifter rose),
 * below the trigger's old 0.30 depth gate. That is why the gate moved to 0.15.
 */
export const valgusEnvelope = (phase: number) => bump(phase, 0.58, 0.72, 0.84, 0.93);

/** Trunk pitching forward, worst at the bottom where the moment arm is longest. */
export const leanEnvelope = (phase: number) => bump(phase, 0.32, 0.5, 0.64, 0.82);

/** The shoulders drifting out of level, later on the ascent than the knee cave —
 *  it builds as the rep grinds rather than appearing at a single instant. */
export const unlevelEnvelope = (phase: number) => bump(phase, 0.62, 0.8, 0.92, 0.98);

export const envelopeFor = (kind: BeatKind, phase: number) =>
  kind === "valgus"
    ? valgusEnvelope(phase)
    : kind === "lean"
      ? leanEnvelope(phase)
      : unlevelEnvelope(phase);

/**
 * The grind: a rep that stops being smooth. It sets in partway down and stays
 * for the rest of the rep, so the instability is established BEFORE anything is
 * measured — the shoulders drifting is what the grind turns into, not a second
 * unrelated event.
 */
export const grindEnvelope = (phase: number) => bump(phase, 0.22, 0.42, 0.88, 0.96);

/** Fraction of its half-stance each knee travels toward the midline at full cave. */
const VALGUS_COLLAPSE = 0.62;
/** Extra forward pitch of the trunk at full lean, in radians (~20°). */
const LEAN_EXTRA_RAD = 0.35;
/** Lateral tilt of the trunk at full shoulder drift, in radians before relaxation. */
const UNLEVEL_RAD = 0.26;

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

/* ── the grind ───────────────────────────────────────────────────────────── */

/**
 * Shudder, as a function of REP PHASE and nothing else.
 *
 * Deliberately not a clock and deliberately not random. The whole sequence is
 * scrubbed — scroll position *is* rep phase — so a wobble driven by elapsed time
 * would keep moving while the page sat still, and a wobble driven by `Math.random`
 * would differ every time the same scroll position was revisited. Two incommensurate
 * sines of the phase give something that reads as unsteady, replays identically,
 * and runs backwards cleanly when the reader scrolls back up.
 */
const wob = (phase: number, seed: number) =>
  Math.sin(phase * 47.3 + seed * 2.11) * 0.62 + Math.sin(phase * 88.7 + seed * 5.37) * 0.38;

/** Peak displacement of a joint at full grind, in world units, before relaxation. */
const TREMOR = 0.019;

/**
 * How much of the tremor each joint carries. Taken from standing height, so it
 * runs from nothing at the floor to full at the head: the feet are planted and
 * it is the mass above them that oscillates. Precomputed — this is read inside
 * the per-frame loop.
 */
const TREMOR_WEIGHT = Array.from({ length: JOINT_COUNT }, (_, k) => {
  const h = STAND[k * 3 + 1] / STAND[J.head * 3 + 1];
  return h * h;
});

/**
 * Vertical stall, added to depth rather than to the pose so both renderers and
 * the check script see the same rep. This is the part that reads as "grindy"
 * rather than merely shaky: the hips stop rising evenly and inch upward.
 */
export const grindStall = (phase: number) =>
  Math.sin(phase * 39.1) * 0.62 + Math.sin(phase * 61.7 + 1.7) * 0.38;

/** Depth swing of the stall at full grind. */
export const GRIND_STALL_DEPTH = 0.042;

/* ── keeping the skeleton rigid ──────────────────────────────────────────── */

/** Rest length of every bone, taken from the standing keyframe. */
const REST = BONES.map(([a, b]) =>
  Math.hypot(
    STAND[J[a] * 3] - STAND[J[b] * 3],
    STAND[J[a] * 3 + 1] - STAND[J[b] * 3 + 1],
    STAND[J[a] * 3 + 2] - STAND[J[b] * 3 + 2],
  ),
);

/** Feet are in contact with the floor and never move — everything else resolves
 *  around them, which is also why the figure never appears to slide. */
const PINNED = new Set([J.ankleL, J.ankleR, J.toeL, J.toeR]);

/**
 * Iterative length constraint (Jakobsen relaxation): walk every bone, and push
 * its two ends apart or together until it is its rest length again, with the
 * feet held fixed. A handful of passes converges because the chains are short.
 *
 * This is what makes interpolation between two keyframes viable at all. It also
 * handles the closed loops (the hip line, the shoulder line) that a parent-child
 * FK chain could not, and it keeps the FAULT poses honest too: pulling a knee
 * inward shortens its shin, and the constraint resolves that by letting the knee
 * ride up and over the ankle — which is what a real cave does.
 */
function relax(p: Pose, iterations = 10): void {
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < BONES.length; i++) {
      const [an, bn] = BONES[i];
      const ai = J[an] * 3;
      const bi = J[bn] * 3;
      const dx = p[bi] - p[ai];
      const dy = p[bi + 1] - p[ai + 1];
      const dz = p[bi + 2] - p[ai + 2];
      const d = Math.hypot(dx, dy, dz) || 1e-6;

      const aFixed = PINNED.has(J[an]);
      const bFixed = PINNED.has(J[bn]);
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
 * Write the pose for a given depth and beat into `out`.
 *
 * Deformations are applied on top of the interpolated pose rather than baked
 * into their own keyframes, so one can be dialled from nothing to full at any
 * depth and the clean reps share exactly one code path with the rest.
 *
 * Order matters: deform, then shake, then relax. Relaxing last is what turns a
 * per-joint tremor into a shudder that runs through a rigid skeleton instead of
 * sixteen dots vibrating independently.
 *
 * @param grind 0…1 instability, and `phase` the rep phase it is locked to.
 */
export function poseAt(
  depth: number,
  kind: BeatKind | null,
  amount: number,
  out: Pose,
  grind = 0,
  phase = 0,
): void {
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
      rotateUpper(out, LEAN_EXTRA_RAD * amount, 2);
    } else {
      // The same rotation in the FRONTAL plane: the trunk drifts sideways and
      // takes the shoulder line off horizontal with it. Rotating the shoulders
      // alone would shear them off the spine; rotating the trunk about the hips
      // is what a lifter actually does when one side stops contributing.
      rotateUpper(out, UNLEVEL_RAD * amount, 0);
    }
  }

  if (grind > 0) {
    const amp = TREMOR * grind;
    for (let k = 0; k < JOINT_COUNT; k++) {
      if (PINNED.has(k)) continue;
      const w = amp * TREMOR_WEIGHT[k];
      out[k * 3] += w * wob(phase, k);
      out[k * 3 + 1] += w * 0.55 * wob(phase, k + 7.3);
      out[k * 3 + 2] += w * wob(phase, k + 19.1);
    }
  }

  relax(out);
}

/**
 * Rotate the upper body about the hip line, in the plane spanned by Y and one
 * other axis: `axis` 2 pitches it forward (sagittal), `axis` 0 tips it sideways
 * (frontal). One function because the two faults differ only by which plane
 * they live in — which is the whole reason the camera has to move between them.
 */
function rotateUpper(out: Pose, theta: number, axis: 0 | 2): void {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const pivotY = (out[J.hipL * 3 + 1] + out[J.hipR * 3 + 1]) / 2;
  const pivotA = (out[J.hipL * 3 + axis] + out[J.hipR * 3 + axis]) / 2;

  for (const name of UPPER_BODY) {
    const i = J[name] * 3;
    const dy = out[i + 1] - pivotY;
    const da = out[i + axis] - pivotA;
    out[i + 1] = pivotY + dy * cos - da * sin;
    out[i + axis] = pivotA + dy * sin + da * cos;
  }
}

/* ── what turns red, and what only gets measured ─────────────────────────── */

/**
 * Per beat: the bones drawn as a FAULT, the bones drawn as a MEASUREMENT, and
 * the joints the camera pushes toward and the annotation attaches to.
 *
 * `bones` and `marked` are two different claims and are coloured differently on
 * purpose. Red means the app would flag it: valgus is T7 and lean is T1, both
 * live triggers. Green — the same green as the joints — means the app is reading
 * a number off the body without passing judgement, which is exactly the status
 * of shoulder levelness: computed every frame, sent as context, demoted from
 * asserting a fault because the reading is aspect-distorted. Painting it red
 * would put a verdict on screen that the product does not make.
 *
 * The three also sit across both planes — valgus and unlevel are frontal, lean
 * is sagittal — so each is only legible from the angle the sequence turns to for
 * it. That is the page's "where you put the phone changes what it knows"
 * argument, made before the Planes section states it.
 */
export const BEAT_SPEC: Record<
  BeatKind,
  { bones: number[]; marked: number[]; anchors: [JointName, JointName] }
> = {
  valgus: {
    bones: [boneIndex("kneeL", "ankleL"), boneIndex("kneeR", "ankleR")],
    marked: [],
    anchors: ["kneeL", "kneeR"],
  },
  lean: {
    bones: [
      boneIndex("neck", "shoulderL"),
      boneIndex("neck", "shoulderR"),
      boneIndex("shoulderL", "shoulderR"),
      boneIndex("shoulderL", "hipL"),
      boneIndex("shoulderR", "hipR"),
    ],
    marked: [],
    anchors: ["shoulderL", "shoulderR"],
  },
  unlevel: {
    bones: [],
    marked: [boneIndex("shoulderL", "shoulderR")],
    anchors: ["shoulderL", "shoulderR"],
  },
};

/** Every bone that can ever change colour — these get their own material
 *  instances, and every one of them is written on every frame so a beat that has
 *  just ended is cleared by the same line that set it. */
export const HIGHLIGHTABLE = [
  ...new Set(Object.values(BEAT_SPEC).flatMap((s) => [...s.bones, ...s.marked])),
];
