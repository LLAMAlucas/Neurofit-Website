/**
 * Orientation-gated push-up checks, counting policy and trigger predicates. PURE module.
 * ----------------------------------------------------------------------------
 * Mirrors squat/checks.ts and inherits its rules:
 *   - A check only runs from a view that can see it ("not-checked" otherwise), and only inside its
 *     per-check facing tolerance ("unknown" outside it) — never a silent pass.
 *   - Occlusion and physically-impossible geometry are "unknown", never "warn".
 *   - The METRIC layer (per-frame, ungated worst-of) is display/report. The TRIGGER layer
 *     (predicates below, behind a 150 ms PersistenceGate in the session) decides what fired.
 *   - Depth and lockout are COUNTING gates — they never request a trigger.
 */
import type { VelocityVerdict } from "../squat/checks";
import type { ShortfallBand } from "../squat/config";
import { distanceFromOrientation } from "../vision/orientation";
import {
  PUSHUP,
  PUSHUP_DEPTH_PRESETS,
  PUSHUP_PLAUSIBLE,
  PUSHUP_SEVERITY,
  PUSHUP_SHORTFALL_BANDS,
  PUSHUP_TRIGGERS,
  type PushupBasis,
  type PushupDepthPreset,
} from "./config";
import type { PushupFrame } from "./frame";
import {
  PUSHUP_METRICS,
  PUSHUP_METRIC_ORDER,
  type CheckStatus,
  type Orientation,
  type PushupMetricId,
  type PushupMetricResult,
  type PushupRepMetrics,
  type Severity,
} from "./metrics";

export interface PushupEvalInput {
  frame: PushupFrame;
  orientation: Orientation;
  facingAngleDeg: number | null;
  depthPreset: PushupDepthPreset;
  /** Live depth ratio — flare/evenness are undefined near lockout and gate themselves out. */
  depthRatio: number;
  velocity: VelocityVerdict | null;
  /** Only known once the attempt has closed. */
  lockout?: { lockedOut: boolean; topRatio: number } | null;
}

const NOT_CHECKED = "Not visible from this camera angle";
const ANGLE_OUT = "Camera angle outside this check's tolerance";

function res(metric: PushupMetricId, status: CheckStatus, message: string, value: number | null = null): PushupMetricResult {
  return { metric, status, severity: status === "warn" ? "warning" : "good", message, value };
}

/** Evaluate every push-up metric for one frame / rep, gated by orientation + per-check angle. */
export function evaluatePushupRep(input: PushupEvalInput): PushupRepMetrics {
  const out = {} as PushupRepMetrics;
  for (const id of PUSHUP_METRIC_ORDER) {
    const base = computeMetric(id, input);
    out[id] = { ...base, severity: pushupSeverityFor(id, base.status, base.value) };
  }
  return out;
}

function computeMetric(id: PushupMetricId, input: PushupEvalInput): PushupMetricResult {
  const { orientation, facingAngleDeg } = input;
  const spec = PUSHUP_METRICS[id];
  if (id === "repCount") return res(id, "ok", "Rep counted");
  const agnostic = spec.appliesTo === "agnostic";
  if (!agnostic && spec.appliesTo !== orientation) return res(id, "not-checked", NOT_CHECKED);
  if (!agnostic) {
    if (facingAngleDeg === null) return res(id, "unknown", "Body not readable");
    if (distanceFromOrientation(facingAngleDeg, orientation) > PUSHUP.checkToleranceDeg[id]) {
      return res(id, "unknown", ANGLE_OUT);
    }
  }
  switch (id) {
    case "depth":
      return depthCheck(input);
    case "bodyLine":
      return bodyLineCheck(input);
    case "lockout":
      return lockoutCheck(input);
    case "eccentricControl":
      return res(id, "not-checked", "Evaluated per rep from the descent");
    case "velocity":
      return velocityCheck(input);
    case "elbowFlare":
      return flareCheck(input);
    case "shoulderLevel":
      return levelCheck(input);
    default:
      return res(id, "unknown", "Unhandled metric");
  }
}

/** Three-zone severity from PUSHUP_SEVERITY (display/report only). */
export function pushupSeverityFor(id: PushupMetricId, status: CheckStatus, value: number | null): Severity {
  if (status !== "warn") return "good";
  const band = PUSHUP_SEVERITY[id];
  if (!band || value === null) return "warning";
  const beyond =
    band.worseWhen === "below"
      ? value <= band.critical
      : band.worseWhen === "above"
        ? value >= band.critical
        : Math.abs(value) >= band.critical;
  return beyond ? "critical" : "warning";
}

/** Is `a` worse than `b` for this metric? Direction from PUSHUP_SEVERITY (single source). */
export function pushupMoreSevere(id: PushupMetricId, a: number, b: number): boolean {
  const worseWhen = PUSHUP_SEVERITY[id]?.worseWhen ?? "above";
  if (worseWhen === "below") return a < b;
  if (worseWhen === "absAbove") return Math.abs(a) > Math.abs(b);
  return a > b;
}

// --- Side (sagittal) ------------------------------------------------------------

function depthCheck({ frame, depthPreset }: PushupEvalInput): PushupMetricResult {
  const angle = frame.upperArmAngleDeg;
  if (angle === null) return res("depth", "unknown", "Can't see shoulder + elbow");
  const rel = angle - PUSHUP_DEPTH_PRESETS[depthPreset].targetUpperArmDeg;
  return rel >= 0
    ? res("depth", "ok", "Good depth", rel)
    : res("depth", "warn", "Go lower — upper arm above target", rel);
}

function bodyLineCheck({ frame }: PushupEvalInput): PushupMetricResult {
  const dev = frame.bodyLineDeg;
  if (dev === null) return res("bodyLine", "unknown", "Can't see shoulder, hip and legs");
  if (Math.abs(dev) > PUSHUP_PLAUSIBLE.bodyLineMaxDeg) {
    return res("bodyLine", "unknown", "Implausible body line — landmark error");
  }
  const { absSagDeg, absPikeDeg } = PUSHUP_TRIGGERS.bodyLine;
  if (dev >= absSagDeg) return res("bodyLine", "warn", "Hips sagging — brace your trunk", dev);
  if (dev <= -absPikeDeg) return res("bodyLine", "warn", "Hips piking — bring them in line", dev);
  return res("bodyLine", "ok", "Body in a straight line", dev);
}

// --- Agnostic -------------------------------------------------------------------

function lockoutCheck({ lockout }: PushupEvalInput): PushupMetricResult {
  if (!lockout) return res("lockout", "unknown", "Judged at the top of the rep");
  return lockout.lockedOut
    ? res("lockout", "ok", "Locked out", lockout.topRatio)
    : res("lockout", "warn", "Didn't lock out — press to straight arms", lockout.topRatio);
}

function velocityCheck({ velocity }: PushupEvalInput): PushupMetricResult {
  if (!velocity || !velocity.measured) return res("velocity", "unknown", "Velocity not measured this rep");
  if (velocity.degraded) {
    const pct = velocity.ratio !== null ? Math.round((1 - velocity.ratio) * 100) : null;
    return res("velocity", "warn", pct !== null ? `Rep speed down ${pct}%` : "Rep speed dropping", velocity.ratio);
  }
  return res("velocity", "ok", "Tempo steady", velocity.ratio);
}

// --- Front (frontal) ------------------------------------------------------------

function flareCheck({ frame, depthRatio }: PushupEvalInput): PushupMetricResult {
  if (depthRatio < PUSHUP_TRIGGERS.elbowFlare.depthGate) return res("elbowFlare", "unknown", "Not judged near lockout");
  const r = frame.flareRatio;
  if (r === null) return res("elbowFlare", "unknown", "Can't see both elbows + wrists");
  if (r < PUSHUP_PLAUSIBLE.flareRatio.lo || r > PUSHUP_PLAUSIBLE.flareRatio.hi) {
    return res("elbowFlare", "unknown", "Implausible elbow spread — landmark error");
  }
  return r >= PUSHUP_TRIGGERS.elbowFlare.ratioWarn
    ? res("elbowFlare", "warn", "Elbows flaring wide — keep them over the wrists", r)
    : res("elbowFlare", "ok", "Elbows tracking over the wrists", r);
}

function levelCheck({ frame, depthRatio }: PushupEvalInput): PushupMetricResult {
  if (depthRatio < PUSHUP_TRIGGERS.shoulderLevel.depthGate) return res("shoulderLevel", "unknown", "Not judged near lockout");
  const d = frame.shoulderTiltDiffDeg;
  if (d === null) return res("shoulderLevel", "unknown", "Can't see both shoulders + wrists");
  if (d > PUSHUP_PLAUSIBLE.shoulderTiltDiffMaxDeg) {
    return res("shoulderLevel", "unknown", "Implausible shoulder tilt — landmark error");
  }
  return d >= PUSHUP_TRIGGERS.shoulderLevel.warnDeg
    ? res("shoulderLevel", "warn", "One shoulder dropping — press evenly", d)
    : res("shoulderLevel", "ok", "Shoulders level", d);
}

// --- Aggregation ------------------------------------------------------------------

/**
 * Faults that can happen anywhere in the rep, so the verdict is the worst across the rep's
 * frames rather than the bottom snapshot. Depth/lockout are by definition bottom/top values.
 */
export const PUSHUP_AGGREGATED_METRICS: PushupMetricId[] = ["bodyLine", "elbowFlare", "shoulderLevel"];

const SEV_RANK: Record<Severity, number> = { good: 0, warning: 1, critical: 2 };

/** Same policy as squat aggregateRep: a warn must hold on a sustained share of checked frames. */
export function aggregatePushupRep(
  base: PushupRepMetrics,
  frames: PushupRepMetrics[],
  minWarnFrames = 2,
  minWarnFraction = 0.2,
): PushupRepMetrics {
  const out: PushupRepMetrics = { ...base };
  for (const id of PUSHUP_AGGREGATED_METRICS) {
    const results = frames.map((f) => f[id]);
    const checked = results.filter((r) => r.status === "ok" || r.status === "warn");
    const warns = checked.filter((r) => r.status === "warn");
    if (checked.length === 0) {
      out[id] = results.find((r) => r.status === "unknown") ?? base[id];
    } else if (warns.length >= Math.max(minWarnFrames, minWarnFraction * checked.length)) {
      out[id] = warns.reduce((worst, r) => {
        const rank = SEV_RANK[r.severity];
        const bestRank = SEV_RANK[worst.severity];
        if (rank !== bestRank) return rank > bestRank ? r : worst;
        if (r.value === null || worst.value === null) return worst;
        return pushupMoreSevere(id, r.value, worst.value) ? r : worst;
      });
    } else {
      out[id] = checked.find((r) => r.status === "ok") ?? checked[checked.length - 1];
    }
  }
  return out;
}

// --- Counting policy ----------------------------------------------------------------

export type PushupMissReason = "depth_miss" | "lockout_miss";

export interface PushupMiss {
  reason: PushupMissReason;
  /** The unit `measured`/`target` are in — the number that DECIDED this miss. */
  basis: PushupBasis;
  measured: number | null;
  target: number;
  /** How far short, in words — the only form the coach may speak. */
  band: ShortfallBand | null;
}

/** Shortfall (always positive = short of target) as a word; null when not short. */
export function pushupShortfallBand(shortfall: number | null, basis: PushupBasis): ShortfallBand | null {
  if (shortfall === null || !Number.isFinite(shortfall) || shortfall <= 0) return null;
  const band = PUSHUP_SHORTFALL_BANDS[basis];
  if (shortfall < band.marginal) return "marginal";
  if (shortfall < band.moderate) return "moderate";
  return "large";
}

/**
 * Does a closed attempt count? It must reach the depth target AND lock out.
 *  - SIDE depth: bottom upper-arm angle vs the preset (degrees). A null angle (occluded bottom)
 *    counts — a momentarily lost elbow never silently voids a rep (squat side rule).
 *  - FRONT depth: bottomDepthRatio vs the preset's front target. A null ratio never counts.
 *  - LOCKOUT (both views): the tracker's lockedOut flag; the miss carries the top ratio.
 * Both misses can apply to one attempt. Deeper always counts (no upper bound).
 */
export function pushupRepCounts(
  orientation: Orientation,
  bottomUpperArmDeg: number | null,
  bottomDepthRatio: number | null,
  lockedOut: boolean,
  topRatio: number,
  preset: PushupDepthPreset,
): { counted: boolean; misses: PushupMiss[] } {
  const spec = PUSHUP_DEPTH_PRESETS[preset];
  const misses: PushupMiss[] = [];
  if (orientation === "side") {
    if (bottomUpperArmDeg !== null && bottomUpperArmDeg < spec.targetUpperArmDeg) {
      misses.push({
        reason: "depth_miss",
        basis: "upper_arm_angle_deg",
        measured: bottomUpperArmDeg,
        target: spec.targetUpperArmDeg,
        band: pushupShortfallBand(spec.targetUpperArmDeg - bottomUpperArmDeg, "upper_arm_angle_deg"),
      });
    }
  } else if (bottomDepthRatio === null || bottomDepthRatio < spec.frontRatioTarget) {
    misses.push({
      reason: "depth_miss",
      basis: "depth_ratio",
      measured: bottomDepthRatio,
      target: spec.frontRatioTarget,
      band: bottomDepthRatio === null ? null : pushupShortfallBand(spec.frontRatioTarget - bottomDepthRatio, "depth_ratio"),
    });
  }
  if (!lockedOut) {
    misses.push({
      reason: "lockout_miss",
      basis: "depth_ratio",
      measured: topRatio,
      target: PUSHUP.lockoutRatio,
      band: pushupShortfallBand(topRatio - PUSHUP.lockoutRatio, "depth_ratio"),
    });
  }
  return { counted: misses.length === 0, misses };
}

/**
 * Baseline hygiene: may this warm-up attempt CALIBRATE the per-set baselines? Only a full-ish rep
 * (locked out, reasonably deep) — a half rep or a settle during warm-up must not become the
 * reference every later rep is compared against. Never changes whether the rep counts. The
 * caller must ALSO gate on `rep.index <= baselineReps` (BaselineTracker only caps sample count).
 */
export function pushupRepFeedsBaseline(lockedOut: boolean, bottomDepthRatio: number): boolean {
  return lockedOut && bottomDepthRatio >= PUSHUP.baselineMinDepthRatio;
}

// --- Trigger predicates (pair each with a 150 ms PersistenceGate) ------------------

export type BodyLineSub = "sag" | "pike";
export type TriggerBasis = "baseline_relative" | "absolute";

/**
 * P1 body line. Absolute takes precedence when both hold (it is the stronger statement — it is
 * true regardless of how the lifter warmed up). With no baseline (warm-up failed hygiene) only
 * the absolute backstop can fire, which is exactly what `checks_disarmed` tells the coach.
 */
export function bodyLineTrigger(dev: number | null, baseline: number | null): { sub: BodyLineSub; basis: TriggerBasis } | null {
  if (dev === null || !Number.isFinite(dev) || Math.abs(dev) > PUSHUP_PLAUSIBLE.bodyLineMaxDeg) return null;
  const { absSagDeg, absPikeDeg, baselineDeltaDeg } = PUSHUP_TRIGGERS.bodyLine;
  if (dev >= absSagDeg) return { sub: "sag", basis: "absolute" };
  if (dev <= -absPikeDeg) return { sub: "pike", basis: "absolute" };
  if (baseline === null) return null;
  if (dev - baseline >= baselineDeltaDeg) return { sub: "sag", basis: "baseline_relative" };
  if (baseline - dev >= baselineDeltaDeg) return { sub: "pike", basis: "baseline_relative" };
  return null;
}

/** P7 elbow flare: past the depth gate (descent AND ascent) and past the ratio. */
export function flareTriggerActive(ratio: number | null, depthRatio: number): boolean {
  if (ratio === null || ratio < PUSHUP_PLAUSIBLE.flareRatio.lo || ratio > PUSHUP_PLAUSIBLE.flareRatio.hi) return false;
  return depthRatio >= PUSHUP_TRIGGERS.elbowFlare.depthGate && ratio >= PUSHUP_TRIGGERS.elbowFlare.ratioWarn;
}

/** P11 uneven press (post-set): the rep's worst tilt differential past its warm-up baseline. */
export function levelTriggerActive(diffDeg: number | null, baseline: number | null): boolean {
  if (diffDeg === null || baseline === null) return false;
  return diffDeg - baseline >= PUSHUP_TRIGGERS.shoulderLevel.baselineDeltaDeg;
}

/**
 * P2 descent control, evaluated at rep close. value = descent speed ÷ warm-up baseline. With no
 * baseline the check is "unknown" (and listed as disarmed) — never a clean pass.
 */
export function evalPushupEccentric(descentSpeed: number | null, baseline: number | null): PushupMetricResult {
  if (descentSpeed === null) return res("eccentricControl", "unknown", "Descent not measured this rep");
  if (baseline === null || baseline <= 0) return res("eccentricControl", "unknown", "No warm-up descent baseline this set");
  const mult = descentSpeed / baseline;
  return mult >= PUSHUP_TRIGGERS.eccentric.descentSpikeMult
    ? res("eccentricControl", "warn", "Dropping fast — control the way down", mult)
    : res("eccentricControl", "ok", "Controlled descent", mult);
}

/**
 * Physically impossible FRONTAL geometry on this frame = a tracking failure. FRONT-ONLY, for the
 * squat's reason: spans are undefined edge-on (the shoulders stack, the width denominator
 * collapses), and running this on side sets flagged every side rep unreliable.
 */
export function pushupLandmarkImplausible(frame: PushupFrame, orientation: Orientation): boolean {
  if (orientation !== "front") return false;
  const { flareRatio, handWidthRatio, shoulderTiltDiffDeg } = frame;
  if (flareRatio !== null && (flareRatio < PUSHUP_PLAUSIBLE.flareRatio.lo || flareRatio > PUSHUP_PLAUSIBLE.flareRatio.hi)) return true;
  if (handWidthRatio !== null && (handWidthRatio < PUSHUP_PLAUSIBLE.handWidthRatio.lo || handWidthRatio > PUSHUP_PLAUSIBLE.handWidthRatio.hi)) return true;
  if (shoulderTiltDiffDeg !== null && shoulderTiltDiffDeg > PUSHUP_PLAUSIBLE.shoulderTiltDiffMaxDeg) return true;
  return false;
}

export type HandWidthBand = "narrow" | "standard" | "wide";

/** Hand width as a word (context only; the ratio itself is never spoken). */
export function handWidthBand(ratio: number | null): HandWidthBand | null {
  if (ratio === null || !Number.isFinite(ratio)) return null;
  if (ratio < PUSHUP_PLAUSIBLE.handWidthRatio.lo || ratio > PUSHUP_PLAUSIBLE.handWidthRatio.hi) return null;
  if (ratio < PUSHUP_TRIGGERS.handWidth.narrowBelow) return "narrow";
  if (ratio > PUSHUP_TRIGGERS.handWidth.wideAbove) return "wide";
  return "standard";
}

/** What the side camera saw at a lockout frame (context only). null if the legs weren't readable. */
export function observedVariant(kneeAngleDeg: number | null, kneeHeightArms: number | null): "toes" | "knees" | null {
  if (kneeAngleDeg === null || kneeHeightArms === null) return null;
  const { kneeAngleMaxDeg, kneeHeightMaxArms } = PUSHUP_TRIGGERS.variantCheck;
  return kneeAngleDeg < kneeAngleMaxDeg && kneeHeightArms < kneeHeightMaxArms ? "knees" : "toes";
}
