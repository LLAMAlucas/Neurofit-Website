/**
 * The scripted set each exercise stop plays on its own: rep after rep from the
 * exercise's script, a short rest, then the set again from the top.
 *
 * PURE — no React, no three, no DOM. Deterministic in `t`: the same moment of
 * the loop is always the same pose, the same count and the same line lit, so
 * `npm run check` can walk it without a clock.
 *
 * Replaces the old pick-a-fault demo. Nobody orders a fault here — the lifter
 * just does a set, some reps go wrong on their own, and the list at the side
 * lights the one that happened.
 */
import { newPose, BOTTOM_PHASE, type Pose } from "./poseFrames";
import { checkOf, type CheckKind, type ExerciseSpec } from "./exercises";

/** Standing still between reps, seconds. */
export const GAP_S = 0.6;
/** Resting between one run of the set and the next, seconds. */
export const SET_REST_S = 1.8;
/** A fault's line lights once the fault is this present in the pose. */
const LIGHT_AT = 0.15;

export type LoopSample = {
  /** Which rep of the script, 0-based; −1 while resting between sets. */
  index: number;
  check: string;
  kind: CheckKind;
  /** 0…1 through the rep in progress (1 in the gap after it). */
  phase: number;
  depth: number;
  /** How present the rep's fault is in the pose, 0…1 (0 for clean and misses). */
  envelope: number;
  /** Reps counted so far this set. A miss is a rep that doesn't count. */
  counted: number;
  /** The check the list lights: from the moment the rep shows it, through the
   *  pause after the rep. Null while nothing has been decided yet. */
  lit: string | null;
};

export const newLoopSample = (): LoopSample => ({
  index: 0,
  check: "clean",
  kind: "clean",
  phase: 0,
  depth: 0,
  envelope: 0,
  counted: 0,
  lit: null,
});

/** Seconds for one run of the set, rest included. */
export const cycleS = (spec: ExerciseSpec) => spec.script.length * (spec.repS + GAP_S) + SET_REST_S;

const scratch = newPose();
const litCache = new Map<string, number>();

/**
 * The phase at which a rep of `check` is decided, and its line lights: when a
 * fault first shows, and for a clean rep or a miss, the bottom of the rep —
 * where the app has seen whether it went deep enough.
 */
export function litFrom(spec: ExerciseSpec, check: string): number {
  const key = `${spec.id}:${check}`;
  const hit = litCache.get(key);
  if (hit !== undefined) return hit;
  let at = BOTTOM_PHASE;
  if (checkOf(spec, check).kind === "fault") {
    for (let ph = 0; ph <= 1; ph += 0.005) {
      if (spec.rep(check, ph, 1, scratch).envelope > LIGHT_AT) {
        at = ph;
        break;
      }
    }
  }
  litCache.set(key, at);
  return at;
}

/** The loop `t` seconds in: writes the pose into `out`, the rest into `s`. */
export function loopAt(spec: ExerciseSpec, t: number, severity: number, out: Pose, s: LoopSample = newLoopSample()): LoopSample {
  const cycle = cycleS(spec);
  const tc = ((t % cycle) + cycle) % cycle;
  const slot = spec.repS + GAP_S;
  const n = spec.script.length;
  const k = Math.floor(tc / slot);

  const countedBefore = (upTo: number) => {
    let c = 0;
    for (let i = 0; i < upTo; i++) if (checkOf(spec, spec.script[i]).kind !== "miss") c++;
    return c;
  };

  if (k >= n) {
    // Resting between sets: at ease, the set's count still up.
    const r = spec.rep("clean", 0, 0, out);
    s.index = -1;
    s.check = "clean";
    s.kind = "clean";
    s.phase = 0;
    s.depth = r.depth;
    s.envelope = 0;
    s.counted = countedBefore(n);
    s.lit = null;
    return s;
  }

  const check = spec.script[k];
  const kind = checkOf(spec, check).kind;
  const local = tc - k * slot;
  const phase = Math.min(1, local / spec.repS);
  const r = spec.rep(check, phase, severity, out);
  s.index = k;
  s.check = check;
  s.kind = kind;
  s.phase = phase;
  s.depth = r.depth;
  s.envelope = kind === "fault" ? r.envelope : 0;
  s.counted = countedBefore(k) + (phase >= 1 && kind !== "miss" ? 1 : 0);
  s.lit = phase >= litFrom(spec, check) ? check : null;
  return s;
}
