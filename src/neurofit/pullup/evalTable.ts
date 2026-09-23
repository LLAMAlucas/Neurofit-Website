/**
 * Pull-up per-rep trigger table for the DEV eval log. PURE module — descriptive only.
 * ----------------------------------------------------------------------------
 * One row per trigger/gate the rep was (or wasn't) eligible for, including the ones that did NOT
 * fire and the near-misses — false negatives only ever surface here. Rows read the runtime truth
 * recorded on the PullupRepRecord (the trigger layer), never recompute a verdict.
 */
import type { TriggerEntry } from "../debug/evalLog";
import { TRIGGERS } from "../squat/config";
import { PULLUP, PULLUP_TOP_PRESETS, PULLUP_TRIGGERS, type PullupGrip, type PullupTopPreset } from "./config";
import type { Orientation } from "./metrics";
import type { PullupRepRecord } from "./session";

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

export interface PullupEvalContext {
  view: Orientation;
  grip: PullupGrip;
  topPreset: PullupTopPreset;
}

export function buildPullupTriggerTable(r: PullupRepRecord, ctx: PullupEvalContext): TriggerEntry[] {
  const scored = r.index > PULLUP_TRIGGERS.baselineReps;
  const side = ctx.view === "side";
  const out: TriggerEntry[] = [];

  // U1 body swing (post-set, side) — relative + absolute sub-signals.
  {
    const eligible = side && scored;
    const { baselineDeltaDeg, absRangeDeg } = PULLUP_TRIGGERS.swing;
    const base = r.baselines.swingRangeDeg;
    const relThreshold = base !== null ? base + baselineDeltaDeg : null;
    const fired = r.triggeredMetrics.includes("swing");
    out.push({
      id: "U1_body_swing",
      tier: "postset",
      eligible,
      measured: r.swingRangeDeg,
      baseline: base,
      threshold: relThreshold ?? absRangeDeg,
      direction: "above",
      fired,
      near_miss: eligible && !fired && (nearMiss(r.swingRangeDeg, relThreshold, "above", false) || nearMiss(r.swingRangeDeg, absRangeDeg, "above", false)),
      sub_signals: [
        { name: "swing_relative", measured: r.swingRangeDeg, threshold: relThreshold, direction: "above", fired: beyond(r.swingRangeDeg, relThreshold, "above") },
        { name: "swing_absolute", measured: r.swingRangeDeg, threshold: absRangeDeg, direction: "above", fired: beyond(r.swingRangeDeg, absRangeDeg, "above") },
      ],
      note: `range of the hand→hip angle across the rep + ${PULLUP.preArmWindowMs} ms pre-arm; runtime fire=${r.swingFire ?? "none"}`,
    });
  }

  // U2 lowering control (post-set, agnostic).
  {
    const eligible = scored;
    const base = r.baselines.descentVelocity;
    const threshold = base !== null ? base * PULLUP_TRIGGERS.eccentric.descentSpikeMult : null;
    const fired = r.triggeredMetrics.includes("eccentricControl");
    out.push({
      id: "U2_eccentric_control",
      tier: "postset",
      eligible,
      measured: r.descentSpeed,
      baseline: base,
      threshold,
      direction: "above",
      fired,
      near_miss: eligible && nearMiss(r.descentSpeed, threshold, "above", fired),
      note: "mean shoulder descent speed from the top of the rep to the hang",
    });
  }

  // U3 leg drive (post-set, side).
  {
    const eligible = side && scored;
    const fired = r.triggeredMetrics.includes("legDrive");
    const threshold = PULLUP_TRIGGERS.legDrive.rangeDeg;
    out.push({
      id: "U3_leg_drive",
      tier: "postset",
      eligible,
      measured: r.legRangeDeg,
      baseline: null,
      threshold,
      direction: "above",
      fired,
      near_miss: eligible && nearMiss(r.legRangeDeg, threshold, "above", fired),
      sub_signals: [
        { name: "hip_range", measured: r.hipRangeDeg, threshold, direction: "above", fired: beyond(r.hipRangeDeg, threshold, "above") },
        { name: "knee_range", measured: r.kneeRangeDeg, threshold, direction: "above", fired: beyond(r.kneeRangeDeg, threshold, "above") },
      ],
      note: "larger of the hip / knee flexion ranges across the rep + pre-arm",
    });
  }

  // U4 uneven pull (post-set, front, baseline-relative).
  {
    const eligible = !side && scored;
    const base = r.baselines.shoulderTiltDiffDeg;
    const threshold = base !== null ? base + PULLUP_TRIGGERS.evenness.baselineDeltaDeg : null;
    const fired = r.triggeredMetrics.includes("evenness");
    out.push({
      id: "U4_uneven_pull",
      tier: "postset",
      eligible,
      measured: r.tiltPeakDeg,
      baseline: base,
      threshold,
      direction: "above",
      fired,
      near_miss: eligible && nearMiss(r.tiltPeakDeg, threshold, "above", fired),
      note: `peak |shoulder tilt − hand tilt| past pull ratio ${PULLUP_TRIGGERS.evenness.ratioGate}`,
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

  // Counting gates — "fired" = a MISS. Both run from both views.
  const topMiss = r.misses.some((m) => m.reason === "top_miss");
  const preset = PULLUP_TOP_PRESETS[ctx.topPreset];
  out.push({
    id: "top_gate",
    tier: "postset",
    eligible: true,
    measured: r.top.measured,
    baseline: null,
    threshold: r.top.target,
    direction: "above",
    fired: topMiss,
    near_miss: nearMiss(r.top.measured, r.top.target, "above", topMiss),
    note: `basis=${r.top.basis} (chin target ${preset.chinClearanceTarget}, ratio fallback ${preset.pullRatioTarget}); peak ratio ${r.peakRatio.toFixed(2)}; counted=${r.counted}`,
  });
  const extMiss = r.misses.some((m) => m.reason === "extension_miss");
  out.push({
    id: "extension_gate",
    tier: "postset",
    eligible: true,
    measured: r.extension.measured,
    baseline: null,
    threshold: r.extension.target,
    direction: r.extension.basis === "elbow_angle_deg" ? "above" : "below",
    fired: extMiss,
    near_miss: false,
    note: `basis=${r.extension.basis}; start ratio ${r.startRatio.toFixed(3)}, start elbow ${r.startElbowDeg === null ? "n/a" : r.startElbowDeg.toFixed(0) + "°"}; ended by ${r.endedBy}`,
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
  out.push(ctxRow("grip_width", r.gripWidthRatio, `front context: wristSpan/shoulderWidth (grip selected: ${ctx.grip})`));
  out.push(ctxRow("peak_chin_clearance", r.peakChinClearance, "fraction of hang height, + = chin above the bar line (null = face unreadable)"));
  return out;
}
