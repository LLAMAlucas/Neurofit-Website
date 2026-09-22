/**
 * Push-up Gemini payloads — post-set + post-workout. PURE module.
 * ----------------------------------------------------------------------------
 * Built here (not inline in the hook, as the squat does) so plane-nulling, disarmed-check
 * reporting and the prompt↔payload field contract are unit-tested in Node.
 *
 * Payload honesty rules (CLAUDE.md, all enforced here):
 *   - A field the set's view cannot see is `null` — never 0/false, which read as "checked, absent".
 *   - `checks_disarmed` names only checks THIS view could have run.
 *   - `triggers_fired` reads the TRIGGER layer (`triggeredMetrics`), never metric warns.
 *   - Every uncounted rep says which gate it missed, in the basis that decided it, with a band.
 *   - Raw numbers stay for auditability; the prompt forbids quoting normalized ones.
 */
import type { Severity } from "../squat/metrics";
import type { ShortfallBand, VelocityBand } from "../squat/config";
import { velocityBand } from "../squat/checks";
import { handWidthBand, pushupSeverityFor, type HandWidthBand, type PushupMissReason } from "./checks";
import { PUSHUP, PUSHUP_DEPTH_PRESETS, type PushupBasis, type PushupVariant } from "./config";
import type { PushupMetricId } from "./metrics";
import type { PushupFaultType, PushupRepRecord, PushupSetRecord } from "./session";

export interface PushupPostSetData {
  exercise: "pushup";
  call_type: "post_set";
  set_summary: {
    set_number: number;
    orientation: string;
    variant: PushupVariant;
    total_reps_attempted: number;
    total_reps_counted: number;
    depth_misses: number;
    lockout_misses: number;
  };
  baseline_frames_included: number;
  baseline: {
    /** SAGITTAL — median body-line deviation of the warm-up reps (deg, + sag). */
    body_line_deg: number | null;
    /** FRONTAL — warm-up shoulder-vs-wrist tilt (deg). */
    shoulder_tilt_diff_deg: number | null;
    /** Agnostic — warm-up shoulder descent speed. */
    descent_velocity: number | null;
    valid: boolean;
    checks_disarmed: string[];
  };
  triggers_fired: {
    type: PushupFaultType;
    sub_signal: "sag" | "pike" | "descent_spike" | null;
    /** Body line only: whether the fixed limit or the lifter's own warm-up decided the fire. */
    basis: "absolute" | "baseline_relative" | "both" | null;
    rep_numbers: number[];
    peak_severity_ratio: number;
    severity: Severity;
    /** Degrees past the warm-up baseline (body line, shoulder tilt) — baselines sit near 0, so a
     *  multiple would explode. Never quoted. */
    baseline_delta_deg: number | null;
    /** Descent speed ÷ warm-up baseline. Never quoted. */
    baseline_multiple: number | null;
  }[];
  context: {
    velocity_collapse_ratio: number | null;
    velocity_ratios_by_rep: { rep_number: number; ratio: number }[];
    velocity_band: VelocityBand | null;
    /** SAGITTAL context (deg). */
    head_drop_deg: number | null;
    /** SAGITTAL context (deg, + hands ahead of shoulders). */
    hand_offset_deg: number | null;
    /** SAGITTAL — elbow angle at the top of each rep (deg; quotable). */
    top_elbow_angle_deg_by_rep: { rep_number: number; deg: number }[] | null;
    /** FRONTAL context. */
    hand_width_ratio: number | null;
    hand_width_band: HandWidthBand | null;
    /** SAGITTAL — what the camera saw on the floor during warm-up vs the selected variant. */
    variant_check: { observed: PushupVariant | null; matches_selected: boolean | null } | null;
  };
  depth_context: {
    preset: string;
    preset_reason: "preference";
    miss_count: number;
    depth_basis: "upper_arm_angle_deg" | "depth_ratio";
    depth_target: number;
    achieved_depth: number[];
  };
  lockout_context: {
    basis: "depth_ratio";
    target: number;
    miss_count: number;
  };
  uncounted_reps: {
    rep_number: number;
    counted: false;
    misses: { reason: PushupMissReason; basis: PushupBasis; measured: number | null; target: number; band: ShortfallBand | null }[];
  }[];
  delivery: { tone: string; verbosity: string; user_name: string };
}

export interface PushupPostWorkoutData {
  exercise: "pushup";
  call_type: "post_workout";
  session_summary: {
    total_sets: number;
    total_reps_counted: number;
    total_reps_attempted: number;
    orientations: string[];
    variant: PushupVariant;
  };
  per_set_debriefs: { set_number: number; orientation: string; text: string }[];
  fault_trends: {
    type: PushupFaultType;
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
    depth_consistency: "good" | "variable" | "poor";
    lockout_consistency: "good" | "variable" | "poor";
  };
  uncounted_reps: {
    set_number: number;
    rep_number: number;
    counted: false;
    misses: { reason: PushupMissReason; basis: PushupBasis; measured: number | null; target: number }[];
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

function hasMiss(r: PushupRepRecord, reason: PushupMissReason): boolean {
  return r.misses.some((m) => m.reason === reason);
}

function fired(r: PushupRepRecord, id: PushupMetricId): boolean {
  return r.triggeredMetrics.includes(id);
}

/** Which view can observe each fault (payload honesty + post-workout trend denominators). */
export const PUSHUP_FAULT_VIEW: Record<PushupFaultType, "side" | "front" | "agnostic"> = {
  hip_sag: "side",
  hip_pike: "side",
  eccentric_control: "agnostic",
  elbow_flare: "front",
  uneven_press: "front",
};

/** Reps a fault fired on, per the trigger layer. */
function repsForFault(reps: PushupRepRecord[], type: PushupFaultType): PushupRepRecord[] {
  switch (type) {
    case "hip_sag":
      return reps.filter((r) => fired(r, "bodyLine") && r.bodyLineFire?.sub === "sag");
    case "hip_pike":
      return reps.filter((r) => fired(r, "bodyLine") && r.bodyLineFire?.sub === "pike");
    case "eccentric_control":
      return reps.filter((r) => fired(r, "eccentricControl"));
    case "elbow_flare":
      return reps.filter((r) => fired(r, "elbowFlare"));
    case "uneven_press":
      return reps.filter((r) => fired(r, "shoulderLevel"));
  }
}

const FAULT_METRIC: Record<PushupFaultType, PushupMetricId> = {
  hip_sag: "bodyLine",
  hip_pike: "bodyLine",
  eccentric_control: "eccentricControl",
  elbow_flare: "elbowFlare",
  uneven_press: "shoulderLevel",
};

/** Within ONE fault type, is severity `a` worse than `b`? Every push-up fault is higher = worse. */
export function pushupTagMoreSevere(a: number, b: number): boolean {
  return a > b;
}

export interface PushupPostSetOptions {
  /** Baseline key frames actually attached (0–2). */
  baselineFramesIncluded: number;
}

export function buildPushupPostSetData(set: PushupSetRecord, opts: PushupPostSetOptions): PushupPostSetData {
  const reps = set.reps;
  const onSide = set.orientation === "side";
  const onFront = set.orientation === "front";
  const preset = PUSHUP_DEPTH_PRESETS[set.depthPreset];
  const base = set.baselines;
  const reliable = reps.filter((r) => !r.landmarkUnreliable);

  const triggers_fired: PushupPostSetData["triggers_fired"] = [];
  for (const type of ["hip_sag", "hip_pike", "eccentric_control", "elbow_flare", "uneven_press"] as PushupFaultType[]) {
    // Post-set evenness (like squat T11) only trusts reliable reps; the per-frame triggers read all.
    const hits = repsForFault(type === "uneven_press" ? reliable : reps, type);
    if (!hits.length) continue;
    let values: number[] = [];
    let delta: number | null = null;
    let multiple: number | null = null;
    let basis: PushupPostSetData["triggers_fired"][number]["basis"] = null;
    let sub: PushupPostSetData["triggers_fired"][number]["sub_signal"] = null;
    if (type === "hip_sag" || type === "hip_pike") {
      const sign = type === "hip_sag" ? 1 : -1;
      sub = type === "hip_sag" ? "sag" : "pike";
      values = hits.map((r) => (r.bodyLinePeakDeg !== null ? Math.abs(r.bodyLinePeakDeg) : null)).filter((v): v is number => v !== null);
      const bases = new Set(hits.map((r) => r.bodyLineFire?.basis));
      basis = bases.size > 1 ? "both" : bases.has("absolute") ? "absolute" : "baseline_relative";
      if (base.bodyLineDeg !== null) {
        const bl = base.bodyLineDeg;
        const deltas = hits.map((r) => (r.bodyLinePeakDeg !== null ? sign * (r.bodyLinePeakDeg - bl) : null)).filter((v): v is number => v !== null);
        delta = deltas.length ? Math.max(...deltas) : null;
      }
    } else if (type === "eccentric_control") {
      sub = "descent_spike";
      values = hits.map((r) => r.descentMultiple).filter((v): v is number => v !== null);
      multiple = values.length ? Math.max(...values) : null;
    } else if (type === "elbow_flare") {
      values = hits.map((r) => r.flarePeak).filter((v): v is number => v !== null);
    } else {
      values = hits.map((r) => r.tiltPeakDeg).filter((v): v is number => v !== null);
      if (base.shoulderTiltDiffDeg !== null && values.length) delta = Math.max(...values) - base.shoulderTiltDiffDeg;
    }
    const peak = values.length ? Math.max(...values) : null;
    triggers_fired.push({
      type,
      sub_signal: sub,
      basis,
      rep_numbers: hits.map((r) => r.index),
      peak_severity_ratio: round(peak, 3) ?? 0,
      // bodyLine severity is judged on |deviation| (absAbove); the others on their native value.
      severity: pushupSeverityFor(FAULT_METRIC[type], "warn", peak),
      baseline_delta_deg: round(delta, 1),
      baseline_multiple: round(multiple, 2),
    });
  }

  // Disarmed = the warm-up never calibrated a baseline this view could have used.
  const checks_disarmed: string[] = [];
  if (onSide && base.bodyLineDeg === null) checks_disarmed.push("body line vs warm-up (the fixed sag/pike limits still ran)");
  if (base.descentVelocity === null) checks_disarmed.push("descent control");
  if (onFront && base.shoulderTiltDiffDeg === null) checks_disarmed.push("left/right evenness");

  const velCollapse = reliable.reduce<number | null>((m, r) => {
    const rr = r.velocity?.ratio ?? null;
    return rr === null ? m : m === null ? rr : Math.min(m, rr);
  }, null);

  const handRatio = onFront ? median(reliable.map((r) => r.handWidthRatio)) : null;
  const depthMisses = reps.filter((r) => hasMiss(r, "depth_miss")).length;
  const lockoutMisses = reps.filter((r) => hasMiss(r, "lockout_miss")).length;

  return {
    exercise: "pushup",
    call_type: "post_set",
    set_summary: {
      set_number: set.index,
      orientation: set.orientation,
      variant: set.variant,
      total_reps_attempted: reps.length,
      total_reps_counted: reps.filter((r) => r.counted).length,
      depth_misses: depthMisses,
      lockout_misses: lockoutMisses,
    },
    baseline_frames_included: opts.baselineFramesIncluded,
    baseline: {
      body_line_deg: onFront ? null : round(base.bodyLineDeg, 1),
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
      head_drop_deg: onSide ? round(median(reliable.map((r) => r.headDropDeg)), 1) : null,
      hand_offset_deg: onSide ? round(median(reliable.map((r) => r.handOffsetDeg)), 1) : null,
      top_elbow_angle_deg_by_rep: onSide
        ? reps
            .filter((r) => r.topElbowAngleDeg !== null)
            .map((r) => ({ rep_number: r.index, deg: Math.round(r.topElbowAngleDeg as number) }))
        : null,
      hand_width_ratio: round(handRatio, 2),
      hand_width_band: onFront ? handWidthBand(handRatio) : null,
      variant_check: onSide
        ? { observed: set.variantObserved, matches_selected: set.variantObserved === null ? null : set.variantObserved === set.variant }
        : null,
    },
    depth_context: {
      preset: preset.specName,
      preset_reason: "preference",
      miss_count: depthMisses,
      depth_basis: onSide ? "upper_arm_angle_deg" : "depth_ratio",
      depth_target: onSide ? preset.targetUpperArmDeg : preset.frontRatioTarget,
      achieved_depth: reps
        .map((r) => (onSide ? round(r.upperArmAngleDeg, 1) : round(r.depthRatio, 3)))
        .filter((v): v is number => v !== null),
    },
    lockout_context: { basis: "depth_ratio", target: PUSHUP.lockoutRatio, miss_count: lockoutMisses },
    uncounted_reps: reps
      .filter((r) => !r.counted)
      .map((r) => ({
        rep_number: r.index,
        counted: false as const,
        misses: r.misses.map((m) => ({
          reason: m.reason,
          basis: m.basis,
          measured: round(m.measured, m.basis === "upper_arm_angle_deg" ? 1 : 3),
          target: m.target,
          band: m.band,
        })),
      })),
    delivery: DELIVERY,
  };
}

function consistency(misses: number, attempts: number): "good" | "variable" | "poor" {
  const rate = attempts ? misses / attempts : 0;
  return rate < 0.1 ? "good" : rate < 0.3 ? "variable" : "poor";
}

export function buildPushupPostWorkoutData(
  sets: PushupSetRecord[],
  per_set_debriefs: PushupPostWorkoutData["per_set_debriefs"],
): PushupPostWorkoutData {
  const scored = sets.filter((s) => s.reps.length > 0);
  const allReps = scored.flatMap((s) => s.reps);
  const fault_trends: PushupPostWorkoutData["fault_trends"] = [];
  for (const type of ["hip_sag", "hip_pike", "eccentric_control", "elbow_flare", "uneven_press"] as PushupFaultType[]) {
    const view = PUSHUP_FAULT_VIEW[type];
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
  const depthMisses = allReps.filter((r) => hasMiss(r, "depth_miss")).length;
  const lockoutMisses = allReps.filter((r) => hasMiss(r, "lockout_miss")).length;
  return {
    exercise: "pushup",
    call_type: "post_workout",
    session_summary: {
      total_sets: scored.length,
      total_reps_counted: allReps.filter((r) => r.counted).length,
      total_reps_attempted: allReps.length,
      orientations: [...new Set(scored.map((s) => s.orientation))],
      variant: scored[0]?.variant ?? sets[0]?.variant ?? "toes",
    },
    per_set_debriefs,
    fault_trends,
    cross_set_metrics: {
      // null (not 1) when a set had no measurable velocity — "no data" must not read as "no slowing".
      velocity_degradation_per_set: scored.map((s) => {
        const ratios = s.reps.map((r) => r.velocity?.ratio ?? null).filter((v): v is number => v !== null);
        return ratios.length ? round(Math.min(...ratios), 3) : null;
      }),
      depth_consistency: consistency(depthMisses, allReps.length),
      lockout_consistency: consistency(lockoutMisses, allReps.length),
    },
    uncounted_reps: scored.flatMap((s) =>
      s.reps
        .filter((r) => !r.counted)
        .map((r) => ({
          set_number: s.index,
          rep_number: r.index,
          counted: false as const,
          misses: r.misses.map((m) => ({ reason: m.reason, basis: m.basis, measured: m.measured, target: m.target })),
        })),
    ),
    delivery: DELIVERY,
  };
}
