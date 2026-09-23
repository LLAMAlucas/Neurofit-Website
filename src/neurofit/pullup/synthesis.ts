/**
 * Post-workout pull-up synthesis. PURE module.
 * ----------------------------------------------------------------------------
 * Produces the SAME WorkoutReport shape as session/synthesis.ts, so SynthesisReport renders it
 * unchanged. Each fault reads the layer that decided it: triggers from `triggeredMetrics`, the top
 * and the full hang from the counting misses. Anything a set's view couldn't see is reported as
 * not assessed, never as clean — which matters more here than for the other exercises, because a
 * doorway bar ("head-on only") never produces a side set at all.
 */
import { compactRanges, type MetricSynthesis, type SetSummary, type SynthStatus, type WorkoutReport } from "../session/synthesis";
import type { Orientation } from "../squat/metrics";
import { PULLUP_METRICS, type PullupMetricId } from "./metrics";
import type { PullupRepRecord, PullupSetRecord } from "./session";

/** Report cards, in display order (repCount is implicit in the tallies). */
const REPORT_METRICS: PullupMetricId[] = ["top", "extension", "swing", "legDrive", "eccentricControl", "velocity", "evenness"];

function observableIn(id: PullupMetricId, o: Orientation): boolean {
  const applies = PULLUP_METRICS[id].appliesTo;
  return applies === "agnostic" || applies === o;
}

function flaggedReps(reps: PullupRepRecord[], id: PullupMetricId): number[] {
  const pick = (f: (r: PullupRepRecord) => boolean) => reps.filter(f).map((r) => r.index);
  switch (id) {
    case "top":
      return pick((r) => r.misses.some((m) => m.reason === "top_miss"));
    case "extension":
      return pick((r) => r.misses.some((m) => m.reason === "extension_miss"));
    case "velocity":
      return pick((r) => r.metrics.velocity.status === "warn");
    case "evenness":
      // Post-set evenness only trusts reliable reps (same rule as the payload).
      return pick((r) => !r.landmarkUnreliable && r.triggeredMetrics.includes(id));
    default:
      return pick((r) => r.triggeredMetrics.includes(id));
  }
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}

function summarizeSet(s: PullupSetRecord): SetSummary {
  const counted = s.reps.filter((r) => r.counted).length;
  const topMissed = flaggedReps(s.reps, "top");
  const hangMissed = flaggedReps(s.reps, "extension");
  const misses: string[] = [];
  if (topMissed.length) misses.push(`short of the top: rep${plural(topMissed.length)} ${compactRanges(topMissed)}`);
  if (hangMissed.length) misses.push(`no full hang: rep${plural(hangMissed.length)} ${compactRanges(hangMissed)}`);
  const notes: string[] = [];
  if (topMissed.length >= 2) notes.push(`Stopped short of the top on ${topMissed.length} reps — check the top target suits you, or finish each rep before lowering.`);
  if (hangMissed.length >= 2) notes.push(`Started ${hangMissed.length} reps from bent arms — lower all the way to straight arms between reps.`);
  const uneven = flaggedReps(s.reps, "evenness");
  if (uneven.length) notes.push(`Uneven pull on rep${plural(uneven.length)} ${compactRanges(uneven)} — one side rose more than in the warm-up.`);
  const partials = s.reps.filter((r) => r.endedBy === "partial").length;
  if (partials) notes.push(`${partials} rep${plural(partials)} turned around before reaching the hang.`);
  return {
    index: s.index,
    orientation: s.orientation,
    counted,
    attempts: s.reps.length,
    depthMissed: topMissed,
    tallyText: `Set ${s.index} · ${s.orientation} — ${counted}/${s.reps.length} reps counted${misses.length ? ` — ${misses.join("; ")}` : ""}`,
    postSetNotes: notes,
  };
}

function synthesizeMetric(id: PullupMetricId, sets: PullupSetRecord[]): MetricSynthesis {
  const label = PULLUP_METRICS[id].label;
  const relevant = sets.filter((s) => observableIn(id, s.orientation));
  if (!relevant.length) {
    const need = PULLUP_METRICS[id].appliesTo;
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

export function synthesizePullup(sets: PullupSetRecord[]): WorkoutReport {
  const scored = sets.filter((s) => s.reps.length > 0);
  const metrics = REPORT_METRICS.map((id) => synthesizeMetric(id, scored));
  const orientationsUsed = [...new Set(scored.map((s) => s.orientation))];
  const flagged = metrics.filter((m) => m.status === "warn");
  const side = scored.filter((s) => s.orientation === "side").map((s) => s.index);
  const front = scored.filter((s) => s.orientation === "front").map((s) => s.index);
  const parts: string[] = [];
  if (front.length) parts.push(`head-on set${plural(front.length)} ${front.join(", ")}`);
  if (side.length) parts.push(`side-on set${plural(side.length)} ${side.join(", ")}`);
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
