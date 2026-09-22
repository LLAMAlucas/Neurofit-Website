/**
 * Post-workout push-up synthesis. PURE module.
 * ----------------------------------------------------------------------------
 * Produces the SAME WorkoutReport shape as session/synthesis.ts, so SynthesisReport renders it
 * unchanged. Each fault reads the layer that decided it: triggers from `triggeredMetrics`,
 * depth/lockout from the counting misses. Anything a set's view couldn't see is reported as
 * not assessed, never as clean.
 */
import { compactRanges, type MetricSynthesis, type SetSummary, type SynthStatus, type WorkoutReport } from "../session/synthesis";
import type { Orientation } from "../squat/metrics";
import { PUSHUP_METRICS, type PushupMetricId } from "./metrics";
import type { PushupRepRecord, PushupSetRecord } from "./session";

/** Report cards, in display order (repCount is implicit in the tallies). */
const REPORT_METRICS: PushupMetricId[] = ["depth", "lockout", "bodyLine", "eccentricControl", "velocity", "elbowFlare", "shoulderLevel"];

/** Depth and lockout gate counting from BOTH views, even though the depth GRADE is side-only. */
function observableIn(id: PushupMetricId, o: Orientation): boolean {
  if (id === "depth" || id === "lockout") return true;
  const applies = PUSHUP_METRICS[id].appliesTo;
  return applies === "agnostic" || applies === o;
}

function flaggedReps(reps: PushupRepRecord[], id: PushupMetricId): number[] {
  const pick = (f: (r: PushupRepRecord) => boolean) => reps.filter(f).map((r) => r.index);
  switch (id) {
    case "depth":
      return pick((r) => r.misses.some((m) => m.reason === "depth_miss"));
    case "lockout":
      return pick((r) => r.misses.some((m) => m.reason === "lockout_miss"));
    case "velocity":
      return pick((r) => r.metrics.velocity.status === "warn");
    default:
      return pick((r) => r.triggeredMetrics.includes(id));
  }
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

function summarizeSet(s: PushupSetRecord): SetSummary {
  const counted = s.reps.filter((r) => r.counted).length;
  const depthMissed = flaggedReps(s.reps, "depth");
  const lockoutMissed = flaggedReps(s.reps, "lockout");
  const misses: string[] = [];
  if (depthMissed.length) misses.push(`missed depth: rep${plural(depthMissed.length)} ${compactRanges(depthMissed)}`);
  if (lockoutMissed.length) misses.push(`missed lockout: rep${plural(lockoutMissed.length)} ${compactRanges(lockoutMissed)}`);
  const notes: string[] = [];
  if (depthMissed.length >= 3) notes.push(`Missed depth on ${depthMissed.length} reps — check the depth target suits you, or practise the bottom position.`);
  if (lockoutMissed.length >= 2) notes.push(`Stopped short of lockout on ${lockoutMissed.length} reps — finish every rep on straight arms.`);
  const uneven = flaggedReps(s.reps.filter((r) => !r.landmarkUnreliable), "shoulderLevel");
  if (uneven.length) notes.push(`Uneven press on rep${plural(uneven.length)} ${compactRanges(uneven)} — one side dipped more than in the warm-up.`);
  if (s.variantObserved !== null && s.variantObserved !== s.variant) {
    notes.push(`The camera saw ${s.variantObserved} on the floor during the warm-up, but ${s.variant} push-ups are selected — check the variant in Settings.`);
  }
  return {
    index: s.index,
    orientation: s.orientation,
    counted,
    attempts: s.reps.length,
    depthMissed,
    tallyText: `Set ${s.index} · ${s.orientation} — ${counted}/${s.reps.length} reps counted${misses.length ? ` — ${misses.join("; ")}` : ""}`,
    postSetNotes: notes,
  };
}

function synthesizeMetric(id: PushupMetricId, sets: PushupSetRecord[]): MetricSynthesis {
  const label = PUSHUP_METRICS[id].label;
  const relevant = sets.filter((s) => observableIn(id, s.orientation));
  if (!relevant.length) {
    const need = PUSHUP_METRICS[id].appliesTo;
    return {
      metric: id,
      label,
      status: "not-assessed",
      setsChecked: [],
      warnings: [],
      summary: `${label} not assessed this session — no ${need}-facing sets completed.`,
    };
  }
  const setsChecked = relevant.map((s) => s.index);
  const warnings = relevant.map((s) => ({ set: s.index, reps: flaggedReps(s.reps, id) })).filter((w) => w.reps.length > 0);
  const status: SynthStatus = warnings.length ? "warn" : "ok";
  const where = `set${setsChecked.length > 1 ? "s" : ""} ${setsChecked.join(", ")}`;
  const summary =
    status === "ok"
      ? `${label}: within target across ${where}.`
      : `${label}: flagged on ${warnings.map((w) => `set ${w.set} rep${plural(w.reps.length)} ${compactRanges(w.reps)}`).join("; ")}.`;
  return { metric: id, label, status, setsChecked, warnings, summary };
}

export function synthesizePushup(sets: PushupSetRecord[]): WorkoutReport {
  const scored = sets.filter((s) => s.reps.length > 0);
  const metrics = REPORT_METRICS.map((id) => synthesizeMetric(id, scored));
  const orientationsUsed = [...new Set(scored.map((s) => s.orientation))];
  const flagged = metrics.filter((m) => m.status === "warn");
  const side = scored.filter((s) => s.orientation === "side").map((s) => s.index);
  const front = scored.filter((s) => s.orientation === "front").map((s) => s.index);
  const parts: string[] = [];
  if (side.length) parts.push(`side-on set${plural(side.length)} ${side.join(", ")}`);
  if (front.length) parts.push(`head-on set${plural(front.length)} ${front.join(", ")}`);
  const span = parts.join(" + ");
  const headline = !scored.length
    ? "No sets recorded."
    : flagged.length === 0
      ? `Clean session across ${span} — no faults flagged.`
      : `${flagged.length} check${plural(flagged.length)} flagged across ${span}: ${flagged.map((m) => m.label.toLowerCase()).join(", ")}.`;
  return {
    setCount: scored.length,
    totalReps: scored.reduce((n, s) => n + s.reps.filter((r) => r.counted).length, 0),
    orientationsUsed,
    metrics,
    notAssessed: metrics.filter((m) => m.status === "not-assessed").map((m) => m.metric),
    setSummaries: sets.map(summarizeSet),
    coachingCues: [],
    headline,
  };
}
