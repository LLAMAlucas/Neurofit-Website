/**
 * Push-up per-rep trigger table for the DEV eval log. PURE module — descriptive only.
 * ----------------------------------------------------------------------------
 * One row per trigger/gate the rep was (or wasn't) eligible for, including the ones that did NOT
 * fire and the near-misses — false negatives only ever surface here. Rows read the runtime truth
 * recorded on the PushupRepRecord (the trigger layer), never recompute a verdict.
 */
import type { TriggerEntry } from "../debug/evalLog";
import { TRIGGERS } from "../squat/config";
import { PUSHUP, PUSHUP_DEPTH_PRESETS, PUSHUP_TRIGGERS, type PushupDepthPreset, type PushupVariant } from "./config";
import type { Orientation } from "./metrics";
import type { PushupRepRecord } from "./session";

const NEAR_MISS_FRAC = 0.15;
type Dir = "above" | "below";

/** Within NEAR_MISS_FRAC of |threshold| on the safe side (sign-safe for negative thresholds). */
function nearMiss(measured: number | null, threshold: number | null, dir: Dir, fired: boolean): boolean {
  if (fired || measured === null || threshold === null) return false;
  const slack = Math.abs(threshold) * NEAR_MISS_FRAC;
  return dir === "above" ? measured >= threshold - slack && measured < threshold : measured <= threshold + slack && measured > threshold;
}

function beyond(measured: number | null, threshold: number | null, dir: Dir): boolean {
  if (measured === null || threshold === null) return false;
  return dir === "above" ? measured >= threshold : measured <= threshold;
}

export interface PushupEvalContext {
  view: Orientation;
  variant: PushupVariant;
  depthPreset: PushupDepthPreset;
}

export function buildPushupTriggerTable(r: PushupRepRecord, ctx: PushupEvalContext): TriggerEntry[] {
  const scored = r.index > PUSHUP_TRIGGERS.baselineReps;
  const side = ctx.view === "side";
  const out: TriggerEntry[] = [];
  const preset = PUSHUP_DEPTH_PRESETS[ctx.depthPreset];

  // P1 body line (mid-set, side) — four sub-signals: sag/pike × relative/absolute.
  {
    const eligible = side && scored;
    const { baselineDeltaDeg, absSagDeg, absPikeDeg } = PUSHUP_TRIGGERS.bodyLine;
    const base = r.baselines.bodyLineDeg;
    const peak = r.bodyLinePeakDeg;
    const fired = r.triggeredMetrics.includes("bodyLine");
    const subs = [
      { name: "sag_relative", threshold: base !== null ? base + baselineDeltaDeg : null, direction: "above" as Dir },
      { name: "pike_relative", threshold: base !== null ? base - baselineDeltaDeg : null, direction: "below" as Dir },
      { name: "sag_absolute", threshold: absSagDeg, direction: "above" as Dir },
      { name: "pike_absolute", threshold: -absPikeDeg, direction: "below" as Dir },
    ];
    out.push({
      id: "P1_body_line",
      tier: "midset",
      eligible,
      measured: peak,
      baseline: base,
      threshold: base !== null ? base + baselineDeltaDeg : absSagDeg,
      direction: "above",
      fired,
      near_miss: eligible && !fired && subs.some((s) => nearMiss(peak, s.threshold, s.direction, false)),
      sub_signals: subs.map((s) => ({ name: s.name, measured: peak, threshold: s.threshold, direction: s.direction, fired: beyond(peak, s.threshold, s.direction) })),
      note: `peak signed deviation (+sag/−pike) vs ${ctx.variant === "knees" ? "shoulder–hip–knee" : "shoulder–hip–ankle"}; runtime fire=${r.bodyLineFire ? `${r.bodyLineFire.sub}/${r.bodyLineFire.basis}` : "none"} (150 ms hold, so a sub-signal can cross without firing)`,
    });
  }

  // P2 descent control (mid-set, agnostic). Bounce is logged, never judged.
  {
    const eligible = scored;
    const base = r.baselines.descentVelocity;
    const threshold = base !== null ? base * PUSHUP_TRIGGERS.eccentric.descentSpikeMult : null;
    const fired = r.triggeredMetrics.includes("eccentricControl");
    out.push({
      id: "P2_eccentric_control",
      tier: "midset",
      eligible,
      measured: r.descentSpeed,
      baseline: base,
      threshold,
      direction: "above",
      fired,
      near_miss: eligible && nearMiss(r.descentSpeed, threshold, "above", fired),
      sub_signals: [
        { name: "descent_spike", measured: r.descentSpeed, threshold, direction: "above", fired },
        { name: "bottom_bounce_reversal_ms", measured: r.reversalMs, threshold: null, direction: "below", fired: false },
      ],
      note: "bounce reversal is LOGGED ONLY — no push-up threshold until a real distribution exists",
    });
  }

  // P7 elbow flare (mid-set, front).
  {
    const eligible = !side && scored;
    const fired = r.triggeredMetrics.includes("elbowFlare");
    out.push({
      id: "P7_elbow_flare",
      tier: "midset",
      eligible,
      measured: r.flarePeak,
      baseline: null,
      threshold: PUSHUP_TRIGGERS.elbowFlare.ratioWarn,
      direction: "above",
      fired,
      near_miss: eligible && nearMiss(r.flarePeak, PUSHUP_TRIGGERS.elbowFlare.ratioWarn, "above", fired),
      note: `peak (elbowSpan − wristSpan)/shoulderWidth past depth_ratio ${PUSHUP_TRIGGERS.elbowFlare.depthGate}`,
    });
  }

  // P11 uneven press (post-set, front, baseline-relative).
  {
    const eligible = !side && scored;
    const base = r.baselines.shoulderTiltDiffDeg;
    const threshold = base !== null ? base + PUSHUP_TRIGGERS.shoulderLevel.baselineDeltaDeg : null;
    const fired = r.triggeredMetrics.includes("shoulderLevel");
    out.push({
      id: "P11_uneven_press",
      tier: "postset",
      eligible,
      measured: r.tiltPeakDeg,
      baseline: base,
      threshold,
      direction: "above",
      fired,
      near_miss: eligible && nearMiss(r.tiltPeakDeg, threshold, "above", fired),
      note: `peak |shoulder tilt − wrist tilt| past depth_ratio ${PUSHUP_TRIGGERS.shoulderLevel.depthGate}`,
    });
  }

  // T6 velocity collapse (context only).
  out.push({
    id: "T6_velocity_collapse",
    tier: "context",
    eligible: scored,
    measured: r.velocity?.ratio ?? null,
    baseline: 1,
    threshold: TRIGGERS.velocityCollapse.ofBaseline,
    direction: "below",
    fired: false,
    near_miss: false,
    note: `context only; collapsed=${r.velocity?.collapsed ?? false}`,
  });

  // Counting gates — "fired" = a MISS.
  const depthMiss = r.misses.some((m) => m.reason === "depth_miss");
  out.push({
    id: "depth_gate",
    tier: "postset",
    eligible: side,
    measured: r.upperArmAngleDeg,
    baseline: null,
    threshold: preset.targetUpperArmDeg,
    direction: "above",
    fired: side && depthMiss,
    near_miss: side && nearMiss(r.upperArmAngleDeg, preset.targetUpperArmDeg, "above", depthMiss),
    note: `side: bottom upper-arm angle (deg, + = shoulder below elbow) >= target; counted=${r.counted}`,
  });
  out.push({
    id: "front_depth_gate",
    tier: "postset",
    eligible: !side,
    measured: r.depthRatio,
    baseline: null,
    threshold: preset.frontRatioTarget,
    direction: "above",
    fired: !side && depthMiss,
    near_miss: !side && nearMiss(r.depthRatio, preset.frontRatioTarget, "above", depthMiss),
    note: `front: bottom shoulder-drop ratio >= target (UNVALIDATED); counted=${r.counted}`,
  });
  out.push({
    id: "lockout_gate",
    tier: "postset",
    eligible: true,
    measured: r.topRatio,
    baseline: null,
    threshold: PUSHUP.lockoutRatio,
    direction: "below",
    fired: !r.lockedOut,
    near_miss: false,
    note: `attempt closes locked out when top ratio <= ${PUSHUP.lockoutRatio}; top elbow ${r.topElbowAngleDeg === null ? "n/a" : r.topElbowAngleDeg.toFixed(0) + "°"}`,
  });

  // Context rows (never eligible to fire).
  const ctxRow = (id: string, measured: number | null, note: string): TriggerEntry => ({
    id,
    tier: "context",
    eligible: false,
    measured,
    baseline: null,
    threshold: null,
    direction: null,
    fired: false,
    near_miss: false,
    note,
  });
  out.push(ctxRow("variant_check", null, side ? `observed=${r.variantObserved ?? "unread"} selected=${ctx.variant}` : "front: legs not visible"));
  out.push(ctxRow("head_drop", r.headDropDeg, "side context: ear vs extended hip→shoulder line (deg, + = dropped)"));
  out.push(ctxRow("hand_offset", r.handOffsetDeg, "side context: shoulder→wrist vs vertical at the top (deg, + = hands ahead)"));
  out.push(ctxRow("hand_width", r.handWidthRatio, "front context: wristSpan/shoulderWidth"));
  return out;
}
