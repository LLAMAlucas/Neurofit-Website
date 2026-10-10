/**
 * What goes to Gemini with the Analyze images. PURE module.
 * ----------------------------------------------------------------------------
 * Same rules as the live coach's payloads: rounded numbers (degrees as integers, times to 0.01 s),
 * null — never 0 — for anything the pose model didn't see, and every field the prompts name
 * actually present (asserted by `check:analyze`). Degrees and rep numbers are the only numbers
 * the model may quote back, so nothing here is a normalized image coordinate.
 */
import { ANALYZE } from "./config";
import { ANGLE_DEFS, type AngleId, type JointAngles, type ViewGuess } from "./jointAngles";
import type { KeyFrame, KeyPhase } from "./keyFrames";
import type { FoundRep, RepFinding } from "./reps";

const s2 = (ms: number) => Math.round(ms / 10) / 100;
const deg = (v: number | null) => (v === null ? null : Math.round(v));

export type AnglesDeg = Record<AngleId, number | null>;

/** Integer degrees for every angle; null where unseen; all null when there was no pose at all. */
export function anglesDeg(a: JointAngles | null): AnglesDeg {
  const out = {} as AnglesDeg;
  for (const d of ANGLE_DEFS) out[d.id] = a ? deg(a[d.id]) : null;
  return out;
}

export interface ClipInfo {
  durationMs: number;
  width: number;
  height: number;
}

function cleanText(s: string | null | undefined, max: number): string | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return t ? t : null;
}

// --- clip ------------------------------------------------------------------------------

export interface ClipFrameRow {
  image: number;
  t_s: number;
  rep: number | null;
  phase: KeyPhase;
  angles_deg: AnglesDeg;
}

export interface ClipRepRow {
  rep: number;
  start_s: number;
  turnaround_s: number;
  end_s: number;
  duration_s: number;
  /** The drive joint's angle at rest and at the turnaround, degrees. */
  drive_angle_deg: { rest: number; turnaround: number };
}

export interface ClipPayload {
  task: "clip_analysis";
  exercise_hint: string | null;
  user_note: string | null;
  clip: { duration_s: number; analysed_from_s: number; analysed_to_s: number; width: number; height: number };
  view_guess: ViewGuess;
  /** Share of analysed frames where a body was found, as a whole percent. */
  pose_found_pct: number | null;
  reps: { found: number; driven_by: string | null; listed: ClipRepRow[] };
  frames: ClipFrameRow[];
}

export function repRow(r: FoundRep): ClipRepRow {
  return {
    rep: r.index,
    start_s: s2(r.startMs),
    turnaround_s: s2(r.turnMs),
    end_s: s2(r.endMs),
    duration_s: s2(r.endMs - r.startMs),
    drive_angle_deg: { rest: Math.round(r.restDeg), turnaround: Math.round(r.turnDeg) },
  };
}

export function buildClipPayload(args: {
  clip: ClipInfo;
  fromMs: number;
  toMs: number;
  exerciseHint: string | null;
  userNote: string | null;
  view: ViewGuess;
  poseFoundShare: number | null;
  finding: RepFinding;
  frames: readonly { key: KeyFrame; angles: JointAngles | null }[];
}): ClipPayload {
  const { clip, finding } = args;
  return {
    task: "clip_analysis",
    exercise_hint: cleanText(args.exerciseHint, ANALYZE.ai.maxExerciseChars),
    user_note: cleanText(args.userNote, ANALYZE.ai.frame.maxQuestionChars),
    clip: {
      duration_s: s2(clip.durationMs),
      analysed_from_s: s2(args.fromMs),
      analysed_to_s: s2(args.toMs),
      width: clip.width,
      height: clip.height,
    },
    view_guess: args.view,
    pose_found_pct: args.poseFoundShare === null ? null : Math.round(args.poseFoundShare * 100),
    reps: {
      found: finding.reps.length,
      driven_by: finding.joint ? `${finding.joint} angle` : null,
      listed: finding.reps.slice(0, ANALYZE.ai.clip.maxRepRows).map(repRow),
    },
    frames: args.frames.map((f, i) => ({
      image: i + 1,
      t_s: s2(f.key.tMs),
      rep: f.key.rep,
      phase: f.key.phase,
      angles_deg: anglesDeg(f.angles),
    })),
  };
}

// --- single frame ----------------------------------------------------------------------

export interface UserMeasurement {
  /** "angle", "line" or "length". */
  kind: string;
  /** What it measures, in words ("your angle at Left knee", "a line you drew"). */
  what: string;
  /** As shown on screen: "92°", "12° off level", "41.5 cm". */
  value: string;
}

export interface FramePayload {
  task: "frame_check";
  exercise_hint: string | null;
  question: string | null;
  view_guess: ViewGuess;
  clip: { duration_s: number; width: number; height: number };
  images: { image: number; role: "before" | "main" | "after"; t_s: number }[];
  main_frame: { t_s: number; rep: number | null; phase: KeyPhase | null };
  angles_deg: AnglesDeg;
  user_measurements: UserMeasurement[];
}

/** Which found rep a moment falls in, and roughly where in it. */
export function phaseAt(reps: readonly FoundRep[], tMs: number): { rep: number | null; phase: KeyPhase | null } {
  for (const r of reps) {
    if (tMs < r.startMs || tMs > r.endMs) continue;
    const near = Math.max(60, (r.endMs - r.startMs) * 0.1);
    if (Math.abs(tMs - r.turnMs) <= near) return { rep: r.index, phase: "turnaround" };
    if (tMs - r.startMs <= near) return { rep: r.index, phase: "start" };
    if (r.endMs - tMs <= near) return { rep: r.index, phase: "start" };
    return { rep: r.index, phase: tMs < r.turnMs ? "moving_out" : "moving_back" };
  }
  return { rep: null, phase: null };
}

export function buildFramePayload(args: {
  clip: ClipInfo;
  mainMs: number;
  /** Times of every image sent, in order; the one equal to mainMs is the main frame. */
  imageTimesMs: readonly number[];
  exerciseHint: string | null;
  question: string | null;
  view: ViewGuess;
  angles: JointAngles | null;
  reps: readonly FoundRep[];
  measurements: readonly UserMeasurement[];
}): FramePayload {
  const where = phaseAt(args.reps, args.mainMs);
  return {
    task: "frame_check",
    exercise_hint: cleanText(args.exerciseHint, ANALYZE.ai.maxExerciseChars),
    question: cleanText(args.question, ANALYZE.ai.frame.maxQuestionChars),
    view_guess: args.view,
    clip: { duration_s: s2(args.clip.durationMs), width: args.clip.width, height: args.clip.height },
    images: args.imageTimesMs.map((t, i) => ({
      image: i + 1,
      role: t === args.mainMs ? "main" : t < args.mainMs ? "before" : "after",
      t_s: s2(t),
    })),
    main_frame: { t_s: s2(args.mainMs), rep: where.rep, phase: where.phase },
    angles_deg: anglesDeg(args.angles),
    user_measurements: args.measurements.slice(0, 12).map((m) => ({ kind: m.kind, what: m.what.slice(0, 120), value: m.value.slice(0, 40) })),
  };
}
