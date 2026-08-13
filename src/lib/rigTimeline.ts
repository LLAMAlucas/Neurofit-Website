/**
 * The five-rep sequence, as a pure function of scroll.
 *
 * PURE — no React, no three, no DOM. All lengths are in VIEWPORT HEIGHTS, so
 * the runway scales with the window and nothing here needs to measure anything.
 *
 * The rep is SCRUBBED, not played: scroll position *is* rep phase, so scrolling
 * back up runs the squat in reverse. That is the whole reason the timeline is a
 * pure function of a single number rather than a clock — there is no playhead to
 * get out of sync, and no state to reset when someone flicks up and down.
 */
import { FRAME_CENTER_Y, J } from "./pose";
import {
  BOTTOM,
  GRIND_STALL_DEPTH,
  STAND,
  depthAt,
  envelopeFor,
  grindEnvelope,
  grindStall,
  type BeatKind,
} from "./poseFrames";

const HALF_PI = Math.PI / 2;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const bump = (v: number, a: number, b: number, c: number, d: number) =>
  smoothstep(a, b, v) * (1 - smoothstep(c, d, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/* ── runway ──────────────────────────────────────────────────────────────── */

/* The expansion is NOT sized here. It runs from wherever the hero lens is best
   framed to wherever the stage pins, both of which are layout facts SquatRig
   measures. Fixing it at a constant number of viewport heights put the start of
   the window below the point at which the lens had already scrolled off the top,
   so the frame opened from a rect whose centre was above the viewport and the
   figure's head was cropped for the whole transition. */

/** A beat standing still after the lens opens, before the first rep. */
export const SETTLE_VH = 0.4;
export const REP_VH = 1;
export const REPS = 5;
/** The camera pulls back and the closing panel comes up over the standing figure. */
export const CARD_VH = 1;
/** The frame closing again at the end. */
export const OUTRO_VH = 0.6;

/** Scroll at which the reps are done and the closing panel begins. */
export const CARD_START = SETTLE_VH + REPS * REP_VH;
/** Scroll for which the stage stays pinned. */
export const PINNED_VH = CARD_START + CARD_VH + OUTRO_VH;
/** Section height. The sticky child is 100vh of it, so pinning lasts PINNED_VH. */
export const RIG_VH = 1 + PINNED_VH;

/**
 * What each rep does. Reps 1 and 3 are clean and nothing fires on them — that
 * matters as much as the other three do. A page where every rep is flagged would
 * be describing a different product.
 */
export const BEATS: ReadonlyArray<BeatKind | null> = [null, "valgus", null, "lean", "unlevel"];

/**
 * Which reps are unsteady. The grind is a separate channel from the beat because
 * it spans the WHOLE of rep 5 — it sets in on the way down, before there is
 * anything to measure, and the shoulders drifting on the way up is what it turns
 * into. Folding it into the beat envelope would make the two simultaneous and
 * lose that order.
 */
export const GRINDY: ReadonlyArray<boolean> = [false, false, false, false, true];

/* ── camera ──────────────────────────────────────────────────────────────── */

type Cam = { camY: number; camZ: number; targetY: number };

/** Whole figure in frame, standing height, with margin. */
const WIDE: Cam = { camY: FRAME_CENTER_Y, camZ: 4.2, targetY: FRAME_CENTER_Y };

/** Pulled back for the closing panel, so the figure reads as a backdrop to it. */
const CARD_CAM: Cam = { camY: FRAME_CENTER_Y, camZ: 5.3, targetY: FRAME_CENTER_Y };

/**
 * Where the camera pushes to while each beat is happening.
 *
 * Two of the three can be a fixed height because their subject barely moves
 * through the window it is watched in: the knees travel almost nothing in a
 * squat (the same fact that makes depth a hip measurement and not a knee angle),
 * and the lean is judged at the bottom, where everything is briefly still.
 */
const FIXED_FOCUS: Record<"valgus" | "lean", Cam> = {
  valgus: { camY: 0.62, camZ: 2.0, targetY: 0.46 },
  lean: { camY: 0.95, camZ: 2.3, targetY: 0.8 },
};

/** Shoulder height at each end of the rep, read off the poses rather than
 *  transcribed, so editing a keyframe moves the camera with it. */
const SHOULDER_STAND = STAND[J.shoulderL * 3 + 1];
const SHOULDER_BOTTOM = BOTTOM[J.shoulderL * 3 + 1];

/**
 * The shoulder beat TRACKS instead.
 *
 * It is watched across most of an ascent, over which the shoulders climb the
 * better part of two thirds of a metre — a fixed height framed for the top of
 * that window puts them half a frame low at the start of it, and framed for the
 * bottom it loses them out of the top. Pushed in this close there is no height
 * that works for both ends, so the camera rides up with them. It is slightly
 * wider than the other two as well: the annotation needs room for a horizontal
 * running out past both shoulders, not just for the joints themselves.
 */
const focusFor = (kind: BeatKind, depth: number): Cam => {
  if (kind !== "unlevel") return FIXED_FOCUS[kind];
  const y = mix(SHOULDER_STAND, SHOULDER_BOTTOM, depth);
  return { camY: y, camZ: 2.5, targetY: y };
};

/**
 * The push leads the beat slightly and holds slightly past it, so the move feels
 * like a camera operator anticipating rather than a trigger reacting. The
 * unlevel push starts earliest — it is following a rep that is already unsteady
 * on the way down, before the shoulders have anything to show.
 */
const focusEnvelope = (kind: BeatKind, phase: number) =>
  kind === "valgus"
    ? bump(phase, 0.46, 0.66, 0.88, 0.98)
    : kind === "lean"
      ? bump(phase, 0.2, 0.44, 0.7, 0.9)
      : bump(phase, 0.44, 0.66, 0.95, 1);

/**
 * Rotation track over the pinned scroll, in (vh, radians) pairs. 0 is head-on,
 * HALF_PI is side-on.
 *
 * Every turn lands on a rep whose fault the new angle can actually see, and
 * every turn happens where there is nothing to miss. Head-on for reps 1–2
 * because a knee cave is FRONTAL; the orbit to side-on runs across rep 3, which
 * is clean; side-on for rep 4 because forward lean is SAGITTAL; and back to
 * head-on across rep 5's DESCENT, so the camera is already square to the
 * shoulders by the time they start drifting on the way up.
 */
const ROT_KEYS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [SETTLE_VH + 2 * REP_VH + 0.15, 0], // holds head-on through reps 1 and 2
  [SETTLE_VH + 2 * REP_VH + 0.85, HALF_PI], // turns across clean rep 3
  [SETTLE_VH + 3 * REP_VH + 0.85, HALF_PI], // holds side-on past rep 4's lean
  [SETTLE_VH + 4 * REP_VH + 0.45, 0], // back to head-on during rep 5's descent
  [PINNED_VH, 0],
];

function track(keys: ReadonlyArray<readonly [number, number]>, at: number): number {
  if (at <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [x1, v1] = keys[i];
    if (at <= x1) {
      const [x0, v0] = keys[i - 1];
      return mix(v0, v1, smoothstep(x0, x1, at));
    }
  }
  return keys[keys.length - 1][1];
}

/* ── whether the camera can see what it is annotating ────────────────────── */

/** Which plane each beat lives in, and therefore which view can read it. */
const PLANE: Record<BeatKind, "frontal" | "sagittal"> = {
  valgus: "frontal",
  lean: "sagittal",
  unlevel: "frontal",
};

/**
 * How far off square the camera may be before a beat's annotation is withheld.
 *
 * Set by the DECIMAL on the drawn number, not by what looks square: turning the
 * camera 10° off foreshortens the shoulder line by cos 10° = 0.985, which reads
 * a real 12.0° tilt as 12.2° — inside the last digit shown. At 18° the same tilt
 * reads 12.6°, and the page would be showing a figure that is wrong where it
 * claims to be precise.
 *
 * This is the same rule the app runs on itself: a check outside its view
 * tolerance returns "unknown" and never a value, because frontal geometry is
 * UNDEFINED edge-on rather than merely extreme. Measured here it is stark — the
 * shoulder line viewed side-on projects to a near-vertical segment and the same
 * arithmetic reports 87°, an entirely invented number about a level pair of
 * shoulders.
 */
export const VIEW_TOLERANCE_RAD = (10 * Math.PI) / 180;

/* ── sample ──────────────────────────────────────────────────────────────── */

export type RigSample = {
  /** 1 = full viewport, 0 = the hero lens rect. Driven by the pre-pin scroll. */
  clipT: number;
  /** 1 = frame closing at the end of the sequence. */
  outT: number;
  rotY: number;
  depth: number;
  beat: BeatKind | null;
  /** How far into the beat's deformation, 0…1. */
  beatAmount: number;
  /** How unsteady the rep is, 0…1 — independent of `beat`. */
  grind: number;
  /** How far the camera has pushed in, 0…1. */
  focusAmount: number;
  /** Whether the camera is square enough to the beat's plane to say anything
   *  about it. False during the turns, and for every beat-less sample. */
  planeVisible: boolean;
  /** 0…1 as the closing panel comes up. */
  cardT: number;
  camY: number;
  camZ: number;
  targetY: number;
  /** 1-based; 0 during the settle, the closing panel and the outro. */
  repIndex: number;
  /** 0…1 through the current rep. */
  phase: number;
  /** Reps that have passed the bottom — what the on-screen counter shows. All
   *  five reach parallel, including the three that go wrong: an imperfect rep
   *  still counts, which is the app's own rule and worth showing rather than
   *  stating. */
  repsCounted: number;
};

/**
 * @param expandT 0…1 as the lens grows, reaching 1 exactly when the stage pins.
 * @param seqT    0…1 across the pinned scroll.
 */
export function timelineAt(expandT: number, seqT: number): RigSample {
  const e = clamp01(expandT);
  const vh = clamp01(seqT) * PINNED_VH;

  // Before the stage pins the figure is still turning out of the hero's side-on
  // view; after it, the rotation track owns the angle. The two meet at 0 rad.
  const rotY = e < 1 ? mix(HALF_PI, 0, smoothstep(0, 1, e)) : track(ROT_KEYS, vh);

  const repFloat = (vh - SETTLE_VH) / REP_VH;
  const i = Math.floor(repFloat);
  const inReps = i >= 0 && i < REPS;
  const phase = inReps ? repFloat - i : 0;
  const beat = inReps ? BEATS[i] : null;

  const grind = inReps && GRINDY[i] ? grindEnvelope(phase) : 0;
  // The stall goes on DEPTH rather than on the pose, so the hips themselves stop
  // rising evenly — and so both renderers and the check script see one rep.
  const depth = inReps
    ? clamp01(depthAt(phase) + grind * GRIND_STALL_DEPTH * grindStall(phase))
    : 0;

  const beatAmount = beat ? envelopeFor(beat, phase) : 0;
  const focusAmount = beat ? focusEnvelope(beat, phase) : 0;

  // The panel comes up after the last rep, and is gone again before the frame
  // starts closing — a glass panel shrinking with the frame reads as a bug.
  const outT = smoothstep(PINNED_VH - OUTRO_VH, PINNED_VH, vh);
  const cardT = smoothstep(CARD_START + 0.15, CARD_START + 0.55, vh) * (1 - outT);

  const focus = beat ? focusFor(beat, depth) : WIDE;
  const camY = mix(mix(WIDE.camY, CARD_CAM.camY, cardT), focus.camY, focusAmount);
  const camZ = mix(mix(WIDE.camZ, CARD_CAM.camZ, cardT), focus.camZ, focusAmount);
  const targetY = mix(mix(WIDE.targetY, CARD_CAM.targetY, cardT), focus.targetY, focusAmount);

  return {
    clipT: e,
    outT,
    rotY,
    depth,
    beat,
    beatAmount,
    grind,
    focusAmount,
    planeVisible: beat
      ? Math.abs(PLANE[beat] === "frontal" ? rotY : rotY - HALF_PI) < VIEW_TOLERANCE_RAD
      : false,
    cardT,
    camY,
    camZ,
    targetY,
    repIndex: inReps ? i + 1 : 0,
    phase,
    repsCounted: Math.max(0, Math.min(REPS, i + (phase > 0.58 ? 1 : 0))),
  };
}

/* ── what the sequence says, and when ─────────────────────────────────────── */

export type TagId = "valgus" | "lean" | "fatigue" | "shoulders";

/**
 * How present each label is, 0…1. Pure, so the offscreen check can assert the
 * ORDER of them — which is the whole point of rep 5: the rep goes unsteady on
 * the way down and the shoulders drift on the way up, and a page that showed
 * both at once would be describing something else.
 *
 * Note what each one rides:
 * - the two faults follow the CAMERA, which leads and holds around the fault;
 * - the shoulder label follows the DRIFT itself, because it claims the shoulders
 *   are uneven and so should arrive when they are, not when the camera set off;
 * - fatigue trails the grind by its own margin, on its own curve.
 *
 * Everything except fatigue is gated on the camera being able to see the plane
 * it is talking about. Fatigue is not, and that is not an oversight — velocity
 * is agnostic, readable from either angle, so gating it would suppress a finding
 * the app can genuinely make from anywhere.
 */
export function tagAmounts(s: RigSample): Record<TagId, number> {
  const seen = s.planeVisible;
  return {
    valgus: s.beat === "valgus" && seen ? clamp01(s.focusAmount * 1.6) : 0,
    lean: s.beat === "lean" && seen ? clamp01(s.focusAmount * 1.6) : 0,
    shoulders: s.beat === "unlevel" && seen ? clamp01(s.beatAmount * 2) : 0,
    /* Phase-shaped rather than derived from the grind, because what it needed
       was a LAG and a threshold on the grind cannot give one: the grind rises
       fast, so any threshold low enough to reach still fires almost as soon as
       the shaking starts. Deriving it put the word on screen at phase 0.27,
       about five percent of a rep after the first wobble, which read as the page
       calling fatigue on a single frame of movement. On its own curve it waits
       until the shaking has been going a while and is plainly not a stumble —
       still on the way down, so the finding is established before the shoulders
       have anything to say. It leaves with the grind at the top of the rep. */
    fatigue: s.grind > 0 ? bump(s.phase, 0.36, 0.46, 0.88, 0.96) : 0,
  };
}
