/**
 * The three exercises the page shows, as one shape: what the app checks each rep
 * for, the scripted set the body runs through, how one rep of each check moves,
 * and the two angles the HUD reads off the live pose.
 *
 * PURE — no React, no three, no DOM.
 *
 * The checks are the app's own, named the way the page lists them. `miss` is not
 * a form fault: the rep just doesn't count (the squat that stops short of depth,
 * the pull-up whose chin never clears the bar), so it never turns anything red —
 * the counter not ticking IS the feedback, exactly as in the app.
 */
import { J } from "./pose";
import { poseAt, envelopeFor, depthAt, type BeatKind, type Pose } from "./poseFrames";
import { pushupBodyLineDeg, pushupElbowDeg, pushupRep, type PushupBeat } from "./pushup";
import { pullupElbowDeg, pullupRep, swingDeg, type PullupBeat } from "./pullup";
import { angleAt } from "./kinematics";

export type ExerciseId = "squat" | "pushup" | "pullup";
export type CheckKind = "clean" | "fault" | "miss";
export type Check = { id: string; label: string; kind: CheckKind };
export type Readout = { label: string; read: (p: Pose) => number };

export type ExerciseSpec = {
  id: ExerciseId;
  /** The heading's name for it. */
  name: string;
  /** Clean first, then what it catches, in the order the page lists them. */
  checks: readonly Check[];
  /** The set the body runs, one check per rep, then again from the top. */
  script: readonly string[];
  /** Seconds per rep. */
  repS: number;
  /** One rep of `check`, `phase` (0…1) of the way through, into `out`. */
  rep(check: string, phase: number, severity: number, out: Pose): { depth: number; envelope: number };
  readouts: readonly [Readout, Readout];
};

export const EXERCISE_ORDER: readonly ExerciseId[] = ["squat", "pushup", "pullup"];

/* ── the squat ─────────────────────────────────────────────────────────── */

/** How deep a squat that stops short gets, as a share of parallel: well above
 *  it, on either of the app's depth tests. */
export const SHALLOW_REACH = 0.55;

/** Interior knee angle (hip–knee–ankle), mean of both legs. ~170° standing. */
export const kneeAngleDeg = (p: Pose) => (angleAt(p, "hipL", "kneeL", "ankleL") + angleAt(p, "hipR", "kneeR", "ankleR")) / 2;

/** Trunk (hip midpoint → shoulder midpoint) from vertical, in the sagittal plane. */
export function trunkLeanDeg(p: Pose): number {
  const dy = (p[J.shoulderL * 3 + 1] + p[J.shoulderR * 3 + 1] - p[J.hipL * 3 + 1] - p[J.hipR * 3 + 1]) / 2;
  const dz = (p[J.shoulderL * 3 + 2] + p[J.shoulderR * 3 + 2] - p[J.hipL * 3 + 2] - p[J.hipR * 3 + 2]) / 2;
  return (Math.abs(Math.atan2(dz, dy)) * 180) / Math.PI;
}

const SQUAT_BEATS: Record<string, BeatKind> = { valgus: "valgus", lean: "lean", shift: "shift" };

const squat: ExerciseSpec = {
  id: "squat",
  name: "Squats",
  checks: [
    { id: "clean", label: "Clean rep", kind: "clean" },
    { id: "valgus", label: "Knee cave", kind: "fault" },
    { id: "lean", label: "Forward lean", kind: "fault" },
    { id: "shift", label: "Hip shift", kind: "fault" },
    { id: "shallow", label: "Not deep enough", kind: "miss" },
  ],
  script: ["clean", "valgus", "clean", "lean", "shift", "shallow"],
  repS: 3,
  rep(check, phase, severity, out) {
    const beat = SQUAT_BEATS[check] ?? null;
    const depth = depthAt(phase) * (check === "shallow" ? SHALLOW_REACH : 1);
    const envelope = beat ? envelopeFor(beat, phase) : 0;
    poseAt(depth, beat, envelope * severity, out);
    return { depth, envelope };
  },
  readouts: [
    { label: "Knee", read: kneeAngleDeg },
    { label: "Trunk", read: trunkLeanDeg },
  ],
};

/* ── the push-up ───────────────────────────────────────────────────────── */

const PUSHUP_BEATS: Record<string, PushupBeat> = { sag: "sag", pike: "pike", flare: "flare", uneven: "uneven" };

const pushup: ExerciseSpec = {
  id: "pushup",
  name: "Push-ups",
  checks: [
    { id: "clean", label: "Clean rep", kind: "clean" },
    { id: "sag", label: "Hips sagging", kind: "fault" },
    { id: "pike", label: "Hips piking", kind: "fault" },
    { id: "flare", label: "Elbows flaring", kind: "fault" },
    { id: "uneven", label: "Uneven press", kind: "fault" },
  ],
  script: ["clean", "sag", "clean", "flare", "pike", "uneven"],
  repS: 2.6,
  rep: (check, phase, severity, out) => pushupRep(PUSHUP_BEATS[check] ?? null, phase, severity, out),
  readouts: [
    { label: "Elbow", read: pushupElbowDeg },
    { label: "Body line", read: pushupBodyLineDeg },
  ],
};

/* ── the pull-up ───────────────────────────────────────────────────────── */

/** How high a pull-up that stops short gets: the chin stays under the bar. */
export const CHIN_SHORT_REACH = 0.62;

const PULLUP_BEATS: Record<string, PullupBeat> = { kip: "kip", legDrive: "legDrive", uneven: "uneven" };

const pullup: ExerciseSpec = {
  id: "pullup",
  name: "Pull-ups",
  checks: [
    { id: "clean", label: "Clean rep", kind: "clean" },
    { id: "kip", label: "Kipping", kind: "fault" },
    { id: "legDrive", label: "Leg drive", kind: "fault" },
    { id: "uneven", label: "Uneven pull", kind: "fault" },
    { id: "chinShort", label: "Chin short of the bar", kind: "miss" },
  ],
  // The set the example debrief describes, rep for rep (lib/postSet).
  script: ["clean", "kip", "clean", "uneven", "legDrive", "chinShort"],
  repS: 3,
  rep: (check, phase, severity, out) =>
    pullupRep(PULLUP_BEATS[check] ?? null, phase, severity, out, check === "chinShort" ? CHIN_SHORT_REACH : 1),
  readouts: [
    { label: "Elbow", read: pullupElbowDeg },
    { label: "Swing", read: (p) => Math.abs(swingDeg(p)) },
  ],
};

export const EXERCISES: Record<ExerciseId, ExerciseSpec> = { squat, pushup, pullup };

export const checkOf = (spec: ExerciseSpec, id: string): Check => {
  const c = spec.checks.find((k) => k.id === id);
  if (!c) throw new Error(`${spec.id} has no check ${id}`);
  return c;
};

/** The body at rest in this exercise: standing, locked out, or a dead hang. */
export const restPose = (spec: ExerciseSpec, out: Pose) => spec.rep("clean", 0, 0, out);
