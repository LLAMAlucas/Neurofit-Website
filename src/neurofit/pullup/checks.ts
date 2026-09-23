/**
 * Orientation-gated pull-up checks, counting policy and trigger predicates. PURE module.
 * ----------------------------------------------------------------------------
 * Mirrors squat/ and pushup/checks.ts and inherits their rules:
 *   - A check only runs from a view that can see it ("not-checked" otherwise), and only inside its
 *     per-check facing tolerance ("unknown" outside it) — never a silent pass.
 *   - Occlusion and physically-impossible geometry are "unknown", never "warn".
 *   - The METRIC layer (display/report) and the TRIGGER layer (predicates below, warm-up-gated in
 *     the session) stay separate; `triggeredMetrics` is the fault truth.
 *   - Top and extension are COUNTING gates — they never request a trigger.
 * Every pull-up quantity is a whole-rep value (a range, a peak, the start frame), so the metrics
 * are evaluated once per attempt rather than per frame.
 */
import type { VelocityVerdict } from "../squat/checks";
import type { ShortfallBand } from "../squat/config";
import { distanceFromOrientation } from "../vision/orientation";
import {
  PULLUP,
  PULLUP_PLAUSIBLE,
  PULLUP_SEVERITY,
  PULLUP_SHORTFALL_BANDS,
  PULLUP_TOP_PRESETS,
  PULLUP_TRIGGERS,
  type PullupBasis,
  type PullupTopPreset,
} from "./config";
import type { PullupFrame } from "./frame";
import {
  PULLUP_METRICS,
  PULLUP_METRIC_ORDER,
  type CheckStatus,
  type Orientation,
  type PullupMetricId,
  type PullupMetricResult,
  type PullupRepMetrics,
  type Severity,
} from "./metrics";

// --- Counting gates -----------------------------------------------------------------

export interface TopVerdict {
  reached: boolean;
  /** The number that DECIDED it: chin clearance where the face was readable, else the pull ratio. */
  basis: "chin_clearance" | "pull_ratio";
  measured: number | null;
  target: number;
}

export interface ExtensionVerdict {
  ok: boolean;
  basis: "elbow_angle_deg" | "pull_ratio";
  measured: number | null;
  target: number;
}

/**
 * Did the attempt reach the top target? The chin basis is used whenever the face was readable near
 * the top; otherwise the peak pull ratio decides (camera behind the lifter, head hidden by an arm).
 * Higher always counts.
 */
export function judgeTop(peakChinClearance: number | null, peakRatio: number, preset: PullupTopPreset): TopVerdict {
  const spec = PULLUP_TOP_PRESETS[preset];
  if (peakChinClearance !== null && Number.isFinite(peakChinClearance)) {
    return { reached: peakChinClearance >= spec.chinClearanceTarget, basis: "chin_clearance", measured: peakChinClearance, target: spec.chinClearanceTarget };
  }
  return { reached: peakRatio >= spec.pullRatioTarget, basis: "pull_ratio", measured: peakRatio, target: spec.pullRatioTarget };
}

/**
 * Did the attempt START from a full hang? Elbow angle first (the literal standard); the gross
 * ratio backstop fails a start no straight-armed hang could have, even if the elbow reads straight
 * (a bend pointing at the camera hides in 2D). With no readable elbow, the ratio alone decides.
 */
export function judgeExtension(startElbowDeg: number | null, startRatio: number): ExtensionVerdict {
  const { elbowMinDeg, ratioMax, grossRatio } = PULLUP.extension;
  if (startElbowDeg !== null && Number.isFinite(startElbowDeg)) {
    if (startElbowDeg < elbowMinDeg) return { ok: false, basis: "elbow_angle_deg", measured: startElbowDeg, target: elbowMinDeg };
    if (startRatio > grossRatio) return { ok: false, basis: "pull_ratio", measured: startRatio, target: grossRatio };
    return { ok: true, basis: "elbow_angle_deg", measured: startElbowDeg, target: elbowMinDeg };
  }
  return { ok: startRatio <= ratioMax, basis: "pull_ratio", measured: startRatio, target: ratioMax };
}

export type PullupMissReason = "extension_miss" | "top_miss";

export interface PullupMiss {
  reason: PullupMissReason;
  /** The unit `measured`/`target` are in — the number that DECIDED this miss. */
  basis: PullupBasis;
  measured: number | null;
  target: number;
  /** How far short, in words — the only form the coach may speak. */
  band: ShortfallBand | null;
}

/** Shortfall (always positive = short of target) as a word; null when not short. */
export function pullupShortfallBand(shortfall: number | null, basis: PullupBasis): ShortfallBand | null {
  if (shortfall === null || !Number.isFinite(shortfall) || shortfall <= 0) return null;
  const band = PULLUP_SHORTFALL_BANDS[basis];
  if (shortfall < band.marginal) return "marginal";
  if (shortfall < band.moderate) return "moderate";
  return "large";
}

/**
 * Does a closed attempt count? It must START from a full hang AND reach the top target. Misses
 * are listed in the order they happened (the start, then the top); one attempt can miss both.
 */
export function pullupRepCounts(ext: ExtensionVerdict, top: TopVerdict): { counted: boolean; misses: PullupMiss[] } {
  const misses: PullupMiss[] = [];
  if (!ext.ok) {
    // Elbow: short = below the target angle. Ratio: short = still that far up from the hang.
    const shortfall = ext.measured === null ? null : ext.basis === "elbow_angle_deg" ? ext.target - ext.measured : ext.measured - ext.target;
    misses.push({ reason: "extension_miss", basis: ext.basis, measured: ext.measured, target: ext.target, band: pullupShortfallBand(shortfall, ext.basis) });
  }
  if (!top.reached) {
    const shortfall = top.measured === null ? null : top.target - top.measured;
    misses.push({ reason: "top_miss", basis: top.basis, measured: top.measured, target: top.target, band: pullupShortfallBand(shortfall, top.basis) });
  }
  return { counted: misses.length === 0, misses };
}

/**
 * Baseline hygiene: may this warm-up attempt CALIBRATE the per-set baselines? Only a real rep —
 * started from a full hang and pulled most of the way. Never changes whether the rep counts. The
 * caller must ALSO gate on `rep.index <= baselineReps` (BaselineTracker only caps sample count).
 */
export function pullupRepFeedsBaseline(ext: ExtensionVerdict, peakRatio: number): boolean {
  return ext.ok && peakRatio >= PULLUP.baselineMinPeakRatio;
}

// --- Whole-rep quantities ---------------------------------------------------------------

/** max − min, or null for fewer than two samples. */
export function sampleRange(xs: number[]): number | null {
  if (xs.length < 2) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of xs) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return hi - lo;
}

/**
 * Mean shoulder descent speed (normalized y / s) from the highest point of the attempt to the
 * lowest point after it. `ys` grow downward. null without a real descent.
 */
export function pullupDescentSpeed(ts: number[], ys: number[]): number | null {
  if (ys.length < 2 || ts.length !== ys.length) return null;
  let top = 0;
  for (let i = 1; i < ys.length; i++) if (ys[i] < ys[top]) top = i;
  let low = top;
  for (let i = top + 1; i < ys.length; i++) if (ys[i] > ys[low]) low = i;
  const dy = ys[low] - ys[top];
  const dt = (ts[low] - ts[top]) / 1000;
  if (low === top || dt <= 0 || dy <= 0) return null;
  return dy / dt;
}

// --- Trigger predicates (evaluated at attempt close; warm-up gating is the session's job) -------

export type TriggerBasis = "baseline_relative" | "absolute";

/**
 * U1 body swing. Absolute takes precedence when both hold (it is true regardless of how the lifter
 * warmed up). With no baseline only the absolute backstop can fire — exactly what
 * `checks_disarmed` tells the coach.
 */
export function swingTrigger(rangeDeg: number | null, baselineDeg: number | null): TriggerBasis | null {
  if (rangeDeg === null || !Number.isFinite(rangeDeg) || rangeDeg > 2 * PULLUP_PLAUSIBLE.swingMaxDeg) return null;
  const { absRangeDeg, baselineDeltaDeg } = PULLUP_TRIGGERS.swing;
  if (rangeDeg >= absRangeDeg) return "absolute";
  if (baselineDeg !== null && rangeDeg - baselineDeg >= baselineDeltaDeg) return "baseline_relative";
  return null;
}

/** U3 leg drive: the rep's larger hip/knee flexion range past the fixed limit. */
export function legDriveTriggerActive(rangeDeg: number | null): boolean {
  return rangeDeg !== null && Number.isFinite(rangeDeg) && rangeDeg < 180 && rangeDeg >= PULLUP_TRIGGERS.legDrive.rangeDeg;
}

/** U4 uneven pull: the rep's worst tilt differential past its warm-up baseline. */
export function evenTriggerActive(tiltPeakDeg: number | null, baselineDeg: number | null): boolean {
  if (tiltPeakDeg === null || baselineDeg === null) return false;
  return tiltPeakDeg - baselineDeg >= PULLUP_TRIGGERS.evenness.baselineDeltaDeg;
}

const NOT_CHECKED = "Not visible from this camera angle";
const ANGLE_OUT = "Camera angle outside this check's tolerance";

function res(metric: PullupMetricId, status: CheckStatus, message: string, value: number | null = null): PullupMetricResult {
  return { metric, status, severity: status === "warn" ? "warning" : "good", message, value };
}

/**
 * U2 lowering control, evaluated at attempt close. value = descent speed ÷ warm-up baseline. With
 * no baseline the check is "unknown" (and listed as disarmed) — never a clean pass.
 */
export function evalPullupEccentric(descentSpeed: number | null, baseline: number | null): PullupMetricResult {
  if (descentSpeed === null) return res("eccentricControl", "unknown", "Lowering not measured this rep");
  if (baseline === null || baseline <= 0) return res("eccentricControl", "unknown", "No warm-up lowering baseline this set");
  const mult = descentSpeed / baseline;
  return mult >= PULLUP_TRIGGERS.eccentric.descentSpikeMult
    ? res("eccentricControl", "warn", "Dropping into the hang — lower under control", mult)
    : res("eccentricControl", "ok", "Controlled lowering", mult);
}

/**
 * Physically impossible FRONTAL geometry = a tracking failure. FRONT-ONLY, for the squat's reason:
 * spans are undefined edge-on (the shoulders stack and the width denominator collapses).
 */
export function pullupLandmarkImplausible(frame: PullupFrame, orientation: Orientation): boolean {
  if (orientation !== "front") return false;
  const { gripWidthRatio, shoulderTiltDiffDeg } = frame;
  const g = PULLUP_PLAUSIBLE.gripWidthRatio;
  if (gripWidthRatio !== null && (gripWidthRatio < g.lo || gripWidthRatio > g.hi)) return true;
  if (shoulderTiltDiffDeg !== null && shoulderTiltDiffDeg > PULLUP_PLAUSIBLE.shoulderTiltDiffMaxDeg) return true;
  return false;
}

export type GripWidthBand = "narrow" | "standard" | "wide";

/** Grip width as a word (context only; the ratio itself is never spoken). */
export function gripWidthBand(ratio: number | null): GripWidthBand | null {
  if (ratio === null || !Number.isFinite(ratio)) return null;
  const g = PULLUP_PLAUSIBLE.gripWidthRatio;
  if (ratio < g.lo || ratio > g.hi) return null;
  if (ratio < PULLUP_TRIGGERS.gripWidth.narrowBelow) return "narrow";
  if (ratio > PULLUP_TRIGGERS.gripWidth.wideAbove) return "wide";
  return "standard";
}

// --- Metric layer ------------------------------------------------------------------------

export interface PullupEvalInput {
  orientation: Orientation;
  facingAngleDeg: number | null;
  /** null while the attempt is still open. */
  top: TopVerdict | null;
  extension: ExtensionVerdict | null;
  swingRangeDeg: number | null;
  legRangeDeg: number | null;
  tiltPeakDeg: number | null;
  velocity: VelocityVerdict | null;
}

/** Three-zone severity from PULLUP_SEVERITY (display/report only). */
export function pullupSeverityFor(id: PullupMetricId, status: CheckStatus, value: number | null): Severity {
  if (status !== "warn") return "good";
  const band = PULLUP_SEVERITY[id];
  if (!band || value === null) return "warning";
  const beyond = band.worseWhen === "below" ? value <= band.critical : value >= band.critical;
  return beyond ? "critical" : "warning";
}

/** Evaluate every pull-up metric for one attempt, gated by orientation + per-check angle. */
export function evaluatePullupRep(input: PullupEvalInput): PullupRepMetrics {
  const out = {} as PullupRepMetrics;
  for (const id of PULLUP_METRIC_ORDER) {
    const base = computeMetric(id, input);
    out[id] = { ...base, severity: pullupSeverityFor(id, base.status, base.value) };
  }
  return out;
}

function computeMetric(id: PullupMetricId, input: PullupEvalInput): PullupMetricResult {
  const { orientation, facingAngleDeg } = input;
  const spec = PULLUP_METRICS[id];
  if (id === "repCount") return res(id, "ok", "Rep counted");
  const agnostic = spec.appliesTo === "agnostic";
  if (!agnostic && spec.appliesTo !== orientation) return res(id, "not-checked", NOT_CHECKED);
  if (!agnostic) {
    if (facingAngleDeg === null) return res(id, "unknown", "Body not readable");
    if (distanceFromOrientation(facingAngleDeg, orientation) > PULLUP.checkToleranceDeg[id]) return res(id, "unknown", ANGLE_OUT);
  }
  switch (id) {
    case "top":
      return topCheck(input.top);
    case "extension":
      return extensionCheck(input.extension);
    case "swing":
      return swingCheck(input.swingRangeDeg);
    case "legDrive":
      return legCheck(input.legRangeDeg);
    case "eccentricControl":
      return res(id, "not-checked", "Evaluated per rep from the lowering");
    case "velocity":
      return velocityCheck(input.velocity);
    case "evenness":
      return evenCheck(input.tiltPeakDeg);
    default:
      return res(id, "unknown", "Unhandled metric");
  }
}

function topCheck(top: TopVerdict | null): PullupMetricResult {
  if (!top) return res("top", "unknown", "Judged at the top of the rep");
  const rel = top.measured === null ? null : top.measured - top.target;
  const how = top.basis === "chin_clearance" ? "" : " (face hidden — judged by shoulder height)";
  return top.reached ? res("top", "ok", `Reached the top${how}`, rel) : res("top", "warn", `Short of the top — pull higher${how}`, rel);
}

function extensionCheck(ext: ExtensionVerdict | null): PullupMetricResult {
  if (!ext) return res("extension", "unknown", "Judged at the start of each rep");
  const elbow = ext.basis === "elbow_angle_deg" ? ext.measured : null;
  return ext.ok
    ? res("extension", "ok", "Started from a full hang", elbow)
    : res("extension", "warn", "Straighten your arms fully before pulling", elbow);
}

function swingCheck(range: number | null): PullupMetricResult {
  if (range === null) return res("swing", "unknown", "Can't see hands and hips");
  if (range > 2 * PULLUP_PLAUSIBLE.swingMaxDeg) return res("swing", "unknown", "Implausible swing — landmark error");
  return range >= PULLUP_TRIGGERS.swing.absRangeDeg
    ? res("swing", "warn", "Body swinging — keep your hips under the bar", range)
    : res("swing", "ok", "Hips stayed under the bar", range);
}

function legCheck(range: number | null): PullupMetricResult {
  if (range === null) return res("legDrive", "unknown", "Can't see hips, knees and ankles");
  return range >= PULLUP_TRIGGERS.legDrive.rangeDeg
    ? res("legDrive", "warn", "Legs driving the rep — keep them still", range)
    : res("legDrive", "ok", "Legs quiet", range);
}

function velocityCheck(velocity: VelocityVerdict | null): PullupMetricResult {
  if (!velocity || !velocity.measured) return res("velocity", "unknown", "Velocity not measured this rep");
  if (velocity.degraded) {
    const pct = velocity.ratio !== null ? Math.round((1 - velocity.ratio) * 100) : null;
    return res("velocity", "warn", pct !== null ? `Rep speed down ${pct}%` : "Rep speed dropping", velocity.ratio);
  }
  return res("velocity", "ok", "Tempo steady", velocity.ratio);
}

function evenCheck(tilt: number | null): PullupMetricResult {
  if (tilt === null) return res("evenness", "unknown", "Can't see both shoulders + hands with the arms bent");
  if (tilt > PULLUP_PLAUSIBLE.shoulderTiltDiffMaxDeg) return res("evenness", "unknown", "Implausible shoulder tilt — landmark error");
  return tilt >= PULLUP_TRIGGERS.evenness.warnDeg
    ? res("evenness", "warn", "One side pulling higher — pull evenly", tilt)
    : res("evenness", "ok", "Shoulders level", tilt);
}
