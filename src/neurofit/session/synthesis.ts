/**
 * Post-workout synthesis. PURE module.
 * ----------------------------------------------------------------------------
 * Combines the alternating sets into ONE coherent report covering every metric,
 * each attributed to the set(s) it came from. It is explicit about anything
 * never checked this session (e.g. "knee valgus not assessed — no front-facing
 * sets"), rather than omitting it silently, and surfaces bar path as a known,
 * intentional gap ("not available — requires equipment detection").
 *
 * This is deterministic and always works offline; the optional Gemini deep
 * analysis (ai/gemini.ts) layers a narrative on top of this structure.
 */
import {
  METRICS,
  METRIC_ORDER,
  type MetricId,
  type Orientation,
} from "../squat/metrics";
import { TRIGGERS } from "../squat/config";
import type { RepRecord, SetRecord, TriggerKind, WorkoutSession } from "./types";

export type SynthStatus = "ok" | "warn" | "not-assessed" | "unavailable";

export interface MetricSynthesis {
  /** Metric id in the session's exercise vocabulary (squat MetricId or PushupMetricId). */
  metric: string;
  label: string;
  status: SynthStatus;
  /** Set numbers in which this metric was observable and run. */
  setsChecked: number[];
  /** Warning reps grouped by set. */
  warnings: { set: number; reps: number[] }[];
  summary: string;
}

/** Per-set rep tally: how many attempts counted, and (side) which missed depth. */
export interface SetSummary {
  index: number;
  orientation: Orientation;
  /** Reps that counted — side: reached depth; front: passed the floor. */
  counted: number;
  /** Attempts recorded (hip dropped past the movement floor). */
  attempts: number;
  /** Side sets only: attempt numbers that did NOT reach the depth target. */
  depthMissed: number[];
  /** Pre-rendered tally line for exercises whose counting isn't depth-only (push-ups also gate
   *  on lockout). Absent for squats, which keep the original "reps hit depth" wording. */
  tallyText?: string;
  /** v2 post-set-tier findings for this set (levelness, symmetry, hip shift,
   *  loaded butt wink, repeated depth misses) — never surfaced mid-set. */
  postSetNotes: string[];
}

/** An AI coaching cue captured live, attributed to the rep that triggered it. */
export interface CoachingCue {
  set: number;
  rep: number;
  triggers: TriggerKind[];
  faultChecks: string[];
  cue: string;
}

export interface WorkoutReport {
  setCount: number;
  totalReps: number;
  orientationsUsed: Orientation[];
  metrics: MetricSynthesis[];
  /** Metrics never assessed this session (no set of the required orientation). */
  notAssessed: string[];
  /** Per-set rep tallies (depth-met / attempts), including zero-attempt sets. */
  setSummaries: SetSummary[];
  /** Every AI coaching cue fired during the workout, in order (spec §4). */
  coachingCues: CoachingCue[];
  headline: string;
}

export function synthesize(session: WorkoutSession): WorkoutReport {
  // Zero-attempt sets are shown as an advisory but excluded from the session
  // totals/metrics — they shouldn't count toward the set count or rep total.
  const scored = session.sets.filter((s) => s.reps.length > 0);
  const scoredSession: WorkoutSession = { sets: scored };
  const orientationsUsed = unique(scored.map((s) => s.orientation));
  const totalReps = scored.reduce((n, s) => n + s.reps.filter((r) => r.counted).length, 0);

  // shoulderHipLevelness AND kneeSymmetry are DEMOTED to context-only (levelness is an
  // aspect-distorted jitter proxy; symmetry is anti-correlated with knee cave on n=2 bodies)
  // — excluded from the report cards + headline so neither asserts anything; each survives
  // only as its raw context value in the post-set Gemini payload.
  const metrics = METRIC_ORDER
    .filter((id) => id !== "shoulderHipLevelness" && id !== "kneeSymmetry")
    .map((id) => synthesizeMetric(id, scoredSession));
  const notAssessed = metrics.filter((m) => m.status === "not-assessed").map((m) => m.metric);

  const setSummaries = session.sets.map(summarizeSet);

  const coachingCues: CoachingCue[] = [];
  for (const s of scored) {
    for (const r of s.reps) {
      if (r.coaching) {
        coachingCues.push({
          set: s.index,
          rep: r.index,
          triggers: r.coaching.triggers,
          faultChecks: r.coaching.faultChecks,
          cue: r.coaching.cue,
        });
      }
    }
  }

  return {
    setCount: scored.length,
    totalReps,
    orientationsUsed,
    metrics,
    notAssessed,
    setSummaries,
    coachingCues,
    headline: headline(scoredSession, metrics),
  };
}

function summarizeSet(s: SetRecord): SetSummary {
  const counted = s.reps.filter((r) => r.counted).length;
  const depthMissed = s.orientation === "side" ? s.reps.filter((r) => !r.counted).map((r) => r.index) : [];
  return {
    index: s.index,
    orientation: s.orientation,
    counted,
    attempts: s.reps.length,
    depthMissed,
    postSetNotes: postSetNotes(s, depthMissed),
  };
}

/** Attempt numbers in this set where `id` warned. */
function warnedReps(s: SetRecord, id: MetricId): number[] {
  return s.reps.filter((r) => r.metrics[id]?.status === "warn").map((r) => r.index);
}

/** Attempt numbers in this set where a per-rep trigger flag is set (baseline-relative
 *  faults — kneeSymmetry/hipShift — read these instead of the absolute metric warn). */
function triggeredReps(s: SetRecord, pick: (r: RepRecord) => boolean): number[] {
  return s.reps.filter(pick).map((r) => r.index);
}

/** v2 post-set-tier findings — the signals that never fire a mid-set cue. */
function postSetNotes(s: SetRecord, depthMissed: number[]): string[] {
  const notes: string[] = [];
  const s1 = (xs: number[]) => (xs.length > 1 ? "s" : "");
  if (s.orientation === "side" && depthMissed.length >= 3) {
    notes.push(`Missed depth on ${depthMissed.length} reps — check the preset fits your mobility, or drill the position.`);
  }
  // shoulder/hip levelness AND knee symmetry are DEMOTED to context-only — levelness is an
  // aspect-distorted jitter proxy, symmetry is anti-correlated with knee cave (reads lower on
  // genuine caves). Neither asserts a fault in the report; they survive only as raw context
  // values in the Gemini payload. T11 lateral shift keeps its baseline-relative trigger flag.
  const shift = triggeredReps(s, (r) => r.shiftTriggered);
  if (shift.length >= TRIGGERS.lateralShift.severeReps) {
    notes.push(`Lateral hip shift across ${shift.length} reps — worth addressing (one hip working harder).`);
  } else if (shift.length) {
    notes.push(`Slight lateral hip shift on rep${s1(shift)} ${compactRanges(shift)}.`);
  }
  const wink = warnedReps(s, "buttWink");
  if (wink.length) notes.push(`Loaded: early-onset lower-back rounding on rep${s1(wink)} ${compactRanges(wink)} — ease depth/load if it persists.`);
  return notes;
}

function synthesizeMetric(id: MetricId, session: WorkoutSession): MetricSynthesis {
  const spec = METRICS[id];
  const label = spec.label;

  if (spec.appliesTo === "none") {
    return {
      metric: id,
      label,
      status: "unavailable",
      setsChecked: [],
      warnings: [],
      summary: "Not available — requires equipment detection (planned).",
    };
  }

  // Sets whose orientation can observe this metric (agnostic = all).
  const relevantSets = session.sets.filter(
    (s) => spec.appliesTo === "agnostic" || spec.appliesTo === s.orientation,
  );
  if (relevantSets.length === 0) {
    return {
      metric: id,
      label,
      status: "not-assessed",
      setsChecked: [],
      warnings: [],
      summary: notAssessedReason(id),
    };
  }

  const setsChecked = relevantSets.map((s) => s.index);
  // T11 hipShift is baseline-relative + scored: the report reads its per-rep trigger flag,
  // not the absolute warn, so a naturally slightly-shifted stance and warm-up reps aren't
  // flagged. Other metrics: absolute warn. (kneeSymmetry never reaches here — it's excluded
  // from the report metrics above, demoted to context-only.)
  const warnings = relevantSets
    .map((s) => {
      const reps =
        id === "hipShift"
          ? triggeredReps(s, (r) => r.shiftTriggered)
          : s.reps.filter((r) => r.metrics[id].status === "warn").map((r) => r.index);
      return { set: s.index, reps };
    })
    .filter((w) => w.reps.length > 0);

  const status: SynthStatus = warnings.length > 0 ? "warn" : "ok";
  return { metric: id, label, status, setsChecked, warnings, summary: metricSummary(label, setsChecked, warnings, status) };
}

function metricSummary(
  label: string,
  setsChecked: number[],
  warnings: { set: number; reps: number[] }[],
  status: SynthStatus,
): string {
  const where = `set${setsChecked.length > 1 ? "s" : ""} ${setsChecked.join(", ")}`;
  if (status === "ok") return `${label}: within target across ${where}.`;
  const detail = warnings.map((w) => `set ${w.set} rep${w.reps.length > 1 ? "s" : ""} ${compactRanges(w.reps)}`).join("; ");
  return `${label}: flagged on ${detail}.`;
}

function notAssessedReason(id: MetricId): string {
  const need = METRICS[id].appliesTo;
  return `${METRICS[id].label} not assessed this session — no ${need}-facing sets completed.`;
}

function headline(session: WorkoutSession, metrics: MetricSynthesis[]): string {
  if (session.sets.length === 0) return "No sets recorded.";
  const flagged = metrics.filter((m) => m.status === "warn");
  const sideSets = session.sets.filter((s) => s.orientation === "side").map((s) => s.index);
  const frontSets = session.sets.filter((s) => s.orientation === "front").map((s) => s.index);
  const parts: string[] = [];
  if (sideSets.length) parts.push(`side-facing set${sideSets.length > 1 ? "s" : ""} ${sideSets.join(", ")}`);
  if (frontSets.length) parts.push(`front-facing set${frontSets.length > 1 ? "s" : ""} ${frontSets.join(", ")}`);
  const span = parts.join(" + ");
  if (flagged.length === 0) return `Clean session across ${span} — no faults flagged.`;
  return `${flagged.length} metric${flagged.length > 1 ? "s" : ""} flagged across ${span}: ${flagged.map((m) => m.label.toLowerCase()).join(", ")}.`;
}

// --- helpers ---------------------------------------------------------------

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** "6-8" / "6, 9" compaction for readable rep lists. */
export function compactRanges(reps: number[]): string {
  const sorted = [...reps].sort((a, b) => a - b);
  const out: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    if (i < sorted.length && sorted[i] === prev + 1) {
      prev = sorted[i];
      continue;
    }
    out.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = sorted[i];
    prev = sorted[i];
  }
  return out.join(", ");
}
