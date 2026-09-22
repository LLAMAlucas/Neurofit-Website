/**
 * Post-workout squat fault trends. PURE module (tested in check:squat).
 * ----------------------------------------------------------------------------
 * Pulled out of useWorkout so the numbers the post-workout coach treats as authority can be
 * unit-tested — the previous inline version shipped a field that did not mean what its name
 * said. `worsened_with_fatigue` was `present.includes(lastSetIndex)`: true for ANY fault that
 * appeared in the final set, velocity never consulted, while POSTWORKOUT_SYSTEM rule 5 named it
 * "the ONLY authority on whether a fault worsened with fatigue". It is replaced by
 * `co_occurred_with_slowing` (the push-up definition): the fault fired on at least one rep whose
 * OWN velocity ratio was below 1.0 — co-occurrence, which the data can support, and never cause,
 * which it cannot.
 */
import { METRICS, type MetricId } from "../squat/metrics";
import type { RepRecord, SetRecord } from "./types";

/** Faults the post-workout tracks. Levelness + knee symmetry are demoted (not faults). */
export const SQUAT_TREND_FAULTS: readonly MetricId[] = ["forwardLean", "kneeValgus", "eccentricControl", "hipShift"];

/** Per-rep "fault fired" truth for post-set/post-workout fault accounting. Each fault reads
 *  the layer that actually decided it: T11 hipShift its baseline-relative scored flag, T1/T7
 *  their gated mid-set trigger (`triggeredMetrics` — NOT the ungated worst-of-frames metric
 *  warn, which disagreed with the trigger layer), and eccentricControl its metric status,
 *  which IS its trigger. (T10 kneeSymmetry is demoted — not a fault here.) */
export function repFaultFired(r: RepRecord, id: MetricId): boolean {
  if (id === "hipShift") return r.shiftTriggered;
  if (id === "eccentricControl") return r.metrics[id].status === "warn";
  return r.triggeredMetrics.includes(id);
}

export interface SquatFaultTrend {
  id: MetricId;
  sets_present: number[];
  /** Sets whose camera view could observe this fault at all (agnostic faults: every set). */
  sets_observable: number[];
  /** "persistent" = present in every set that could SEE it — not every set in the session,
   *  which made a side-only fault present in all side sets read "intermittent". */
  trend: "persistent" | "intermittent";
  /** Fired on at least one rep whose own velocity ratio was < 1.0. Co-occurrence only. */
  co_occurred_with_slowing: boolean;
}

function slowerThanAverage(r: RepRecord): boolean {
  const ratio = r.velocity?.ratio ?? null;
  return ratio !== null && ratio < 1;
}

export function squatFaultTrends(sets: readonly SetRecord[]): SquatFaultTrend[] {
  const scored = sets.filter((s) => s.reps.length > 0);
  const out: SquatFaultTrend[] = [];
  for (const id of SQUAT_TREND_FAULTS) {
    const view = METRICS[id].appliesTo;
    const observable = scored.filter((s) => view === "agnostic" || s.orientation === view).map((s) => s.index);
    const present: number[] = [];
    let slowing = false;
    for (const s of scored) {
      const hits = s.reps.filter((r) => repFaultFired(r, id));
      if (!hits.length) continue;
      present.push(s.index);
      if (hits.some(slowerThanAverage)) slowing = true;
    }
    if (!present.length) continue;
    out.push({
      id,
      sets_present: present,
      sets_observable: observable,
      trend: present.length === observable.length ? "persistent" : "intermittent",
      co_occurred_with_slowing: slowing,
    });
  }
  return out;
}

/** Slowest rep's velocity ratio per set, or null when the set had no measured velocity — it
 *  used to be 1, which told the model "no slowing" about a set it had no data on. */
export function velocityDegradationPerSet(sets: readonly SetRecord[]): (number | null)[] {
  return sets
    .filter((s) => s.reps.length > 0)
    .map((s) => {
      const ratios = s.reps.map((r) => r.velocity?.ratio ?? null).filter((v): v is number => v !== null);
      return ratios.length ? Math.min(...ratios) : null;
    });
}
