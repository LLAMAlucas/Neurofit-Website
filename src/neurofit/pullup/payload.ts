/**
 * Pull-up Gemini payloads — post-set + post-workout. PURE module.
 * ----------------------------------------------------------------------------
 * Built here (not inline in the hook) so plane-nulling, disarmed-check reporting and the
 * prompt↔payload field contract are unit-tested in Node, exactly like pushup/payload.ts.
 *
 * Payload honesty rules (CLAUDE.md, all enforced here):
 *   - A field the set's view cannot see is `null` — never 0/false, which read as "checked, absent".
 *   - `checks_disarmed` names only checks THIS view could have run.
 *   - `triggers_fired` reads the TRIGGER layer (`triggeredMetrics`), never metric warns.
 *   - Every uncounted rep says which gate it missed, in the basis that decided it, with a band.
 *     Pull-ups can decide the same gate in two bases within one set (the chin is readable on one
 *     rep and hidden by an arm on the next), so the basis travels with EACH miss and each achieved
 *     value rather than once per set.
 *   - Raw numbers stay for auditability; the prompt forbids quoting the normalized ones.
 */
import type { Severity } from "../squat/metrics";
import type { ShortfallBand, VelocityBand } from "../squat/config";
import { velocityBand } from "../squat/checks";
import { gripWidthBand, pullupSeverityFor, type GripWidthBand, type PullupMissReason } from "./checks";
import { PULLUP, PULLUP_TOP_PRESETS, type PullupBasis, type PullupGrip } from "./config";
import type { PullupMetricId } from "./metrics";
import { PULLUP_FAULT_TYPES, type PullupFaultType, type PullupRepRecord, type PullupSetRecord } from "./session";

export interface PullupPostSetData {
  exercise: "pullup";
  call_type: "post_set";
  set_summary: {
    set_number: number;
    orientation: string;
    grip: PullupGrip;
    total_reps_attempted: number;
    total_reps_counted: number;
    top_misses: number;
    extension_misses: number;
  };
  baseline_frames_included: number;
  baseline: {
    /** SAGITTAL — warm-up body-swing range (deg). */
    swing_range_deg: number | null;
    /** FRONTAL — warm-up shoulder-vs-hand tilt (deg). */
    shoulder_tilt_diff_deg: number | null;
    /** Agnostic — warm-up lowering speed. */
    descent_velocity: number | null;
    valid: boolean;
    checks_disarmed: string[];
  };
  triggers_fired: {
    type: PullupFaultType;
    /** Body swing only: whether the fixed limit or the lifter's own warm-up decided the fire. */
    basis: "absolute" | "baseline_relative" | "both" | null;
    rep_numbers: number[];
    /** Worst value: degrees for body_swing / leg_drive / uneven_pull, a speed multiple for
     *  eccentric_control. */
    peak_severity_ratio: number;
    severity: Severity;
    /** Degrees past the warm-up baseline (swing range, shoulder tilt). Never quoted. */
    baseline_delta_deg: number | null;
    /** Lowering speed ÷ warm-up baseline. Never quoted. */
    baseline_multiple: number | null;
  }[];
  context: {
    velocity_collapse_ratio: number | null;
    velocity_ratios_by_rep: { rep_number: number; ratio: number }[];
    velocity_band: VelocityBand | null;
    /** SAGITTAL — typical body-swing range across the set (deg, median). */
    swing_range_deg: number | null;
    /** SAGITTAL — typical hip/knee angle change across the set (deg, median). */
    leg_angle_change_deg: number | null;
    /** Agnostic — 2D elbow angle each rep started from (deg; projection-lenient, never quoted). */
    start_elbow_angle_deg_by_rep: { rep_number: number; deg: number }[];
    /** FRONTAL context. */
    grip_width_ratio: number | null;
    grip_width_band: GripWidthBand | null;
  };
  top_context: {
    preset: string;
    preset_reason: "preference";
    miss_count: number;
    chin_clearance_target: number;
    pull_ratio_target: number;
    achieved_by_rep: { rep_number: number; basis: "chin_clearance" | "pull_ratio"; value: number | null }[];
  };
  extension_context: {
    miss_count: number;
    elbow_angle_target_deg: number;
    pull_ratio_max: number;
  };
  uncounted_reps: {
    rep_number: number;
    counted: false;
    misses: { reason: PullupMissReason; basis: PullupBasis; measured: number | null; target: number; band: ShortfallBand | null }[];
  }[];
  delivery: { tone: string; verbosity: string; user_name: string };
}

export interface PullupPostWorkoutData {
  exercise: "pullup";
  call_type: "post_workout";
  session_summary: {
    total_sets: number;
    total_reps_counted: number;
    total_reps_attempted: number;
    orientations: string[];
    grip: PullupGrip;
  };
  per_set_debriefs: { set_number: number; orientation: string; text: string }[];
  fault_trends: {
    type: PullupFaultType;
    sets_present: number[];
    /** Sets whose camera view could observe this fault at all. */
    sets_observable: number[];
    trend: "persistent" | "intermittent";
    /** The fault fired on at least one rep whose OWN velocity ratio was below 1.0. Co-occurrence
     *  only — never evidence that slowing or fatigue caused it. */
    co_occurred_with_slowing: boolean;
  }[];
  cross_set_metrics: {
    velocity_degradation_per_set: (number | null)[];
    top_consistency: "good" | "variable" | "poor";
    extension_consistency: "good" | "variable" | "poor";
  };
  uncounted_reps: {
    set_number: number;
    rep_number: number;
    counted: false;
    misses: { reason: PullupMissReason; basis: PullupBasis; measured: number | null; target: number }[];
  }[];
  delivery: { tone: string; verbosity: string; user_name: string };
}

const DELIVERY = { tone: "encouraging", verbosity: "detailed", user_name: "" };

function round(v: number | null, dp: number): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const k = 10 ** dp;
  return Math.round(v * k) / k;
}

function median(xs: (number | null)[]): number | null {
  const s = xs.filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function hasMiss(r: PullupRepRecord, reason: PullupMissReason): boolean {
  return r.misses.some((m) => m.reason === reason);
}

/** Which view can observe each fault (payload honesty + post-workout trend denominators). */
export const PULLUP_FAULT_VIEW: Record<PullupFaultType, "side" | "front" | "agnostic"> = {
  body_swing: "side",
  leg_drive: "side",
  eccentric_control: "agnostic",
  uneven_pull: "front",
};

export const PULLUP_FAULT_METRIC: Record<PullupFaultType, PullupMetricId> = {
  body_swing: "swing",
  leg_drive: "legDrive",
  eccentric_control: "eccentricControl",
  uneven_pull: "evenness",
};

/** Reps a fault fired on, per the trigger layer. */
function repsForFault(reps: PullupRepRecord[], type: PullupFaultType): PullupRepRecord[] {
  const id = PULLUP_FAULT_METRIC[type];
  return reps.filter((r) => r.triggeredMetrics.includes(id));
}

/** Within ONE fault type, is severity `a` worse than `b`? Every pull-up fault is higher = worse. */
export function pullupTagMoreSevere(a: number, b: number): boolean {
  return a > b;
}

/** Measurement precision per basis: degrees to 0.1, fractions of hang height to 0.001. */
function roundFor(basis: PullupBasis, v: number | null): number | null {
  return round(v, basis === "elbow_angle_deg" ? 1 : 3);
}

export interface PullupPostSetOptions {
  /** Baseline key frames actually attached (0–2). */
  baselineFramesIncluded: number;
}

export function buildPullupPostSetData(set: PullupSetRecord, opts: PullupPostSetOptions): PullupPostSetData {
  const reps = set.reps;
  const onSide = set.orientation === "side";
  const onFront = set.orientation === "front";
  const preset = PULLUP_TOP_PRESETS[set.topPreset];
  const base = set.baselines;
  const reliable = reps.filter((r) => !r.landmarkUnreliable);

  const triggers_fired: PullupPostSetData["triggers_fired"] = [];
  for (const type of PULLUP_FAULT_TYPES) {
    // Post-set evenness (like squat T11) only trusts reliable reps; the other faults read all.
    const hits = repsForFault(type === "uneven_pull" ? reliable : reps, type);
    if (!hits.length) continue;
    let values: number[];
    let delta: number | null = null;
    let multiple: number | null = null;
    let basis: PullupPostSetData["triggers_fired"][number]["basis"] = null;
    if (type === "body_swing") {
      values = hits.map((r) => r.swingRangeDeg).filter((v): v is number => v !== null);
      const bases = new Set(hits.map((r) => r.swingFire));
      basis = bases.size > 1 ? "both" : bases.has("absolute") ? "absolute" : "baseline_relative";
      if (base.swingRangeDeg !== null && values.length) delta = Math.max(...values) - base.swingRangeDeg;
    } else if (type === "leg_drive") {
      values = hits.map((r) => r.legRangeDeg).filter((v): v is number => v !== null);
    } else if (type === "eccentric_control") {
      values = hits.map((r) => r.descentMultiple).filter((v): v is number => v !== null);
      multiple = values.length ? Math.max(...values) : null;
    } else {
      values = hits.map((r) => r.tiltPeakDeg).filter((v): v is number => v !== null);
      if (base.shoulderTiltDiffDeg !== null && values.length) delta = Math.max(...values) - base.shoulderTiltDiffDeg;
    }
    const peak = values.length ? Math.max(...values) : null;
    triggers_fired.push({
      type,
      basis,
      rep_numbers: hits.map((r) => r.index),
      peak_severity_ratio: round(peak, type === "eccentric_control" ? 2 : 1) ?? 0,
      severity: pullupSeverityFor(PULLUP_FAULT_METRIC[type], "warn", peak),
      baseline_delta_deg: round(delta, 1),
      baseline_multiple: round(multiple, 2),
    });
  }

  // Disarmed = the warm-up never calibrated a baseline this view could have used.
  const checks_disarmed: string[] = [];
  if (onSide && base.swingRangeDeg === null) checks_disarmed.push("body swing vs warm-up (the fixed swing limit still ran)");
  if (base.descentVelocity === null) checks_disarmed.push("lowering control");
  if (onFront && base.shoulderTiltDiffDeg === null) checks_disarmed.push("left/right evenness");

  const velCollapse = reliable.reduce<number | null>((m, r) => {
    const rr = r.velocity?.ratio ?? null;
    return rr === null ? m : m === null ? rr : Math.min(m, rr);
  }, null);
  const gripRatio = onFront ? median(reliable.map((r) => r.gripWidthRatio)) : null;
  const topMisses = reps.filter((r) => hasMiss(r, "top_miss")).length;
  const extensionMisses = reps.filter((r) => hasMiss(r, "extension_miss")).length;

  return {
    exercise: "pullup",
    call_type: "post_set",
    set_summary: {
      set_number: set.index,
      orientation: set.orientation,
      grip: set.grip,
      total_reps_attempted: reps.length,
      total_reps_counted: reps.filter((r) => r.counted).length,
      top_misses: topMisses,
      extension_misses: extensionMisses,
    },
    baseline_frames_included: opts.baselineFramesIncluded,
    baseline: {
      swing_range_deg: onFront ? null : round(base.swingRangeDeg, 1),
      shoulder_tilt_diff_deg: onSide ? null : round(base.shoulderTiltDiffDeg, 1),
      descent_velocity: round(base.descentVelocity, 4),
      valid: checks_disarmed.length === 0,
      checks_disarmed,
    },
    triggers_fired,
    context: {
      velocity_collapse_ratio: round(velCollapse, 3),
      velocity_ratios_by_rep: reliable
        .map((r) => ({ rep_number: r.index, ratio: round(r.velocity?.ratio ?? null, 3) }))
        .filter((x): x is { rep_number: number; ratio: number } => x.ratio !== null),
      velocity_band: velocityBand(velCollapse),
      swing_range_deg: onSide ? round(median(reliable.map((r) => r.swingRangeDeg)), 1) : null,
      leg_angle_change_deg: onSide ? round(median(reliable.map((r) => r.legRangeDeg)), 1) : null,
      start_elbow_angle_deg_by_rep: reps
        .filter((r) => r.startElbowDeg !== null)
        .map((r) => ({ rep_number: r.index, deg: Math.round(r.startElbowDeg as number) })),
      grip_width_ratio: round(gripRatio, 2),
      grip_width_band: onFront ? gripWidthBand(gripRatio) : null,
    },
    top_context: {
      preset: preset.specName,
      preset_reason: "preference",
      miss_count: topMisses,
      chin_clearance_target: preset.chinClearanceTarget,
      pull_ratio_target: preset.pullRatioTarget,
      achieved_by_rep: reps.map((r) => ({ rep_number: r.index, basis: r.top.basis, value: roundFor(r.top.basis, r.top.measured) })),
    },
    extension_context: {
      miss_count: extensionMisses,
      elbow_angle_target_deg: PULLUP.extension.elbowMinDeg,
      pull_ratio_max: PULLUP.extension.ratioMax,
    },
    uncounted_reps: reps
      .filter((r) => !r.counted)
      .map((r) => ({
        rep_number: r.index,
        counted: false as const,
        misses: r.misses.map((m) => ({ reason: m.reason, basis: m.basis, measured: roundFor(m.basis, m.measured), target: m.target, band: m.band })),
      })),
    delivery: DELIVERY,
  };
}

function consistency(misses: number, attempts: number): "good" | "variable" | "poor" {
  const rate = attempts ? misses / attempts : 0;
  return rate < 0.1 ? "good" : rate < 0.3 ? "variable" : "poor";
}

export function buildPullupPostWorkoutData(
  sets: PullupSetRecord[],
  per_set_debriefs: PullupPostWorkoutData["per_set_debriefs"],
): PullupPostWorkoutData {
  const scored = sets.filter((s) => s.reps.length > 0);
  const allReps = scored.flatMap((s) => s.reps);
  const fault_trends: PullupPostWorkoutData["fault_trends"] = [];
  for (const type of PULLUP_FAULT_TYPES) {
    const view = PULLUP_FAULT_VIEW[type];
    const observable = scored.filter((s) => view === "agnostic" || s.orientation === view).map((s) => s.index);
    const present: number[] = [];
    let slowing = false;
    for (const s of scored) {
      const hits = repsForFault(s.reps, type);
      if (!hits.length) continue;
      present.push(s.index);
      if (hits.some((r) => (r.velocity?.ratio ?? null) !== null && (r.velocity?.ratio as number) < 1)) slowing = true;
    }
    if (!present.length) continue;
    fault_trends.push({
      type,
      sets_present: present,
      sets_observable: observable,
      trend: present.length === observable.length ? "persistent" : "intermittent",
      co_occurred_with_slowing: slowing,
    });
  }
  const topMisses = allReps.filter((r) => hasMiss(r, "top_miss")).length;
  const extensionMisses = allReps.filter((r) => hasMiss(r, "extension_miss")).length;
  return {
    exercise: "pullup",
    call_type: "post_workout",
    session_summary: {
      total_sets: scored.length,
      total_reps_counted: allReps.filter((r) => r.counted).length,
      total_reps_attempted: allReps.length,
      orientations: [...new Set(scored.map((s) => s.orientation))],
      grip: scored[0]?.grip ?? sets[0]?.grip ?? "overhand",
    },
    per_set_debriefs,
    fault_trends,
    cross_set_metrics: {
      // null (not 1) when a set had no measurable velocity — "no data" must not read as "no slowing".
      velocity_degradation_per_set: scored.map((s) => {
        const ratios = s.reps.map((r) => r.velocity?.ratio ?? null).filter((v): v is number => v !== null);
        return ratios.length ? round(Math.min(...ratios), 3) : null;
      }),
      top_consistency: consistency(topMisses, allReps.length),
      extension_consistency: consistency(extensionMisses, allReps.length),
    },
    uncounted_reps: scored.flatMap((s) =>
      s.reps
        .filter((r) => !r.counted)
        .map((r) => ({
          set_number: s.index,
          rep_number: r.index,
          counted: false as const,
          misses: r.misses.map((m) => ({ reason: m.reason, basis: m.basis, measured: roundFor(m.basis, m.measured), target: m.target })),
        })),
    ),
    delivery: DELIVERY,
  };
}
