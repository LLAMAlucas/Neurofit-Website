/**
 * Orientation-gated squat form checks. PURE module.
 * ----------------------------------------------------------------------------
 * Evaluates the full validated metric set for one rep, gating each check to the
 * orientation that can actually observe it (sagittal = side, frontal = front,
 * plus the agnostic rep count). A metric that the set's orientation can't see is
 * "not-checked" — kept DISTINCT from a clean "ok". Per-check angle tolerance
 * (config.checkToleranceDeg) decides whether a rep whose facing angle drifts to
 * the edge of the zone is still trusted; outside it the result is "unknown".
 *
 * Each geometric check returns "unknown" (not "warn") when its joints aren't
 * visible — occlusion is never read as a fault. Thresholds live in config.ts;
 * all are starting points to tune against real footage.
 */
import {
  DEFAULT_DEPTH_PRESET,
  DEPTH_PRESETS,
  DEPTH_SHORTFALL_BANDS,
  SEVERITY,
  TRIGGERS,
  type DepthBasis,
  type DepthPreset,
  type ShortfallBand,
  type SquatConfig,
  type VelocityBand,
} from "./config";
import type { SquatFrame, Pt } from "./frame";
import {
  METRICS,
  METRIC_ORDER,
  type CheckStatus,
  type MetricId,
  type Orientation,
  type Severity,
} from "./metrics";
import { distanceFromOrientation } from "../vision/orientation";

export interface MetricResult {
  metric: MetricId;
  status: CheckStatus;
  /**
   * Three-zone severity (spec §1), derived from `value` against the SEVERITY
   * bands in config — the check logic that decides ok/warn is left untouched.
   */
  severity: Severity;
  /** Short coaching message (or an explanation for not-checked/unavailable). */
  message: string;
  /** The measured value behind the verdict, for debug/telemetry. */
  value: number | null;
}

export type RepMetrics = Record<MetricId, MetricResult>;

/** Velocity verdict for this rep, computed by the velocity tracker upstream. */
export interface VelocityVerdict {
  measured: boolean;
  degraded: boolean;
  ratio: number | null;
}

export interface RepEvalInput {
  frame: SquatFrame; // the rep's BOTTOM snapshot
  orientation: Orientation; // the SET's locked orientation
  facingAngleDeg: number | null;
  velocity: VelocityVerdict | null;
  cfg: SquatConfig;
  /** Selected depth target (Settings tab). Defaults to PARALLEL. */
  depthPreset?: DepthPreset;
  /**
   * Live depth ratio for THIS frame (0 standing → larger deeper). Gates frontal metrics whose
   * geometry degenerates near lockout. UNDEFINED means "this is the bottom-frame snapshot" —
   * which is at depth by definition, so no gate applies. Only the per-frame evaluations in
   * `observeDescentFrame` pass it.
   */
  depthRatio?: number;
}

const NOT_CHECKED = "Not visible from this view";
const ANGLE_OUT = "Camera angle off — not reliable this rep";

/**
 * Physical-possibility bounds — the EDGE of what a human body can produce, NOT the
 * edge of a realistic squat. A value outside these is a landmark-tracking failure
 * (MediaPipe placing a joint absurdly, e.g. hip drift 2.3 / valgus 0.07 in the
 * 2026-07-16 eval), not a movement, so the metric returns "unknown" — the same
 * treatment occlusion gets (never a fault). These catch gross single-field blowouts;
 * the rep-level co-degradation flag in useWorkout catches in-range values that
 * co-occur with a failure (e.g. a 19° shoulder tilt on the same garbage rep).
 * UNVALIDATED geometric estimates (n=1) — widen if a real body ever trips one.
 */
const PLAUSIBLE = {
  // kneeWidth/ankleWidth. Knees-touching ≈0.25; 0.15 = knees collapsed to a point.
  // Widest real tracking ≈1.8; 3.0 = knees 3× ankle spread. ⚠ FLOOR is the one to watch —
  // an extreme-but-real cave must not dip below 0.15 (a genuine severe cave bottoms ~0.4).
  valgusRatio: { lo: 0.15, hi: 3.0 },
  hipShiftMax: 1.5, // |hipMid−ankleMid|/hipWidth; >1 = falling over, 1.5 unreachable
  kneeSymmetryMax: 2.5, // |L−R dev|/hipWidth; each dev ≲1 hip-width → diff can't exceed ~2
  levelnessDiffMaxDeg: 60, // |shoulderTilt−hipTilt|; real collapse ≲25°, per-field catches only gross flips
} as const;

/** Evaluate every metric for one rep, gated by orientation + per-check angle. */
export function evaluateRep(input: RepEvalInput): RepMetrics {
  const out = {} as RepMetrics;
  for (const id of METRIC_ORDER) out[id] = evaluateMetric(id, input);
  return out;
}

function evaluateMetric(id: MetricId, input: RepEvalInput): MetricResult {
  // Run the (unmodified) check, then layer the severity zone on top of its verdict.
  const base = computeMetric(id, input);
  return { ...base, severity: severityFor(id, base.status, base.value) };
}

function computeMetric(id: MetricId, input: RepEvalInput): MetricResult {
  const { orientation, facingAngleDeg, cfg } = input;
  const spec = METRICS[id];

  if (spec.appliesTo === "none") {
    return res(id, "unavailable", "Requires equipment detection (planned)");
  }
  if (id === "repCount") {
    return res(id, "ok", "Rep counted");
  }
  const agnostic = spec.appliesTo === "agnostic";
  if (!agnostic && spec.appliesTo !== orientation) {
    return res(id, "not-checked", NOT_CHECKED);
  }
  // Orientation-specific checks gate on the per-check angle tolerance; agnostic
  // checks (velocity) are tracked from BOTH views, so they skip that gate.
  if (!agnostic) {
    if (facingAngleDeg === null) return res(id, "unknown", "Body not readable");
    if (distanceFromOrientation(facingAngleDeg, orientation) > cfg.checkToleranceDeg[id]) {
      return res(id, "unknown", ANGLE_OUT);
    }
  }

  switch (id) {
    case "depth":
      return depthCheck(input);
    case "forwardLean":
      return leanCheck(input);
    case "velocity":
      return velocityCheck(input);
    case "kneeValgus":
      return valgusCheck(input);
    case "shoulderHipLevelness":
      return levelnessCheck(input);
    case "kneeSymmetry":
      return symmetryCheck(input);
    case "hipShift":
      return hipShiftCheck(input);
    case "buttWink":
      return buttWinkCheck();
    case "eccentricControl":
      return eccentricPlaceholder();
    default:
      return res(id, "unknown", "Unhandled metric");
  }
}

/**
 * Map a check's (status, value) onto the three-zone severity using the SEVERITY
 * bands. Only a warned check can be warning/critical; everything else is "good"
 * (no action). This reads the SAME value the check already produced — it does
 * not re-run or alter any check logic.
 */
export function severityFor(id: MetricId, status: CheckStatus, value: number | null): Severity {
  if (status !== "warn") return "good";
  const band = SEVERITY[id];
  if (!band || value === null) return "warning";
  const beyond = band.worseWhen === "below" ? value <= band.critical : value >= band.critical;
  return beyond ? "critical" : "warning";
}

/**
 * How badly a rep missed its depth target, as a word rather than a normalized number.
 *
 * `measured` and `target` must BOTH be in the basis named (`hip_knee_gap` for side sets,
 * `depth_ratio` for front) — mixing them is meaningless, which is the whole reason the
 * payload carries `depth_basis`. Returns null when the rep did NOT miss (shortfall ≤ 0),
 * so a caller can't accidentally band a rep that made depth.
 */
export function depthShortfallBand(measured: number | null, target: number, basis: DepthBasis): ShortfallBand | null {
  if (measured === null || !Number.isFinite(measured)) return null;
  const shortfall = target - measured;
  if (shortfall <= 0) return null;
  const band = DEPTH_SHORTFALL_BANDS[basis];
  if (shortfall < band.marginal) return "marginal";
  if (shortfall < band.moderate) return "moderate";
  return "large";
}

/**
 * Slowdown as a word. Anchored on the SAME constants the trigger layer uses so there is
 * one definition of "collapsed": `SEVERITY.velocity.critical` (0.65) is where a warned
 * rep becomes critical, and `TRIGGERS.velocityCollapse.ofBaseline` (0.60) is T6's fatigue
 * threshold — anything at/below the lower of those is "marked". At or above 1.0 the rep
 * was FASTER, which is "none" (never "slight" — see POSTSET_SYSTEM rule 3a, where reading
 * a ≥1.0 rep as slowing was a real failure mode).
 */
export function velocityBand(ratio: number | null): VelocityBand | null {
  if (ratio === null || !Number.isFinite(ratio)) return null;
  if (ratio >= 1) return "none";
  const marked = Math.min(SEVERITY.velocity?.critical ?? 0.65, TRIGGERS.velocityCollapse.ofBaseline);
  if (ratio <= marked) return "marked";
  // Midpoint of the remaining span: slight = a few percent off, moderate = clearly slower.
  return ratio >= 1 - (1 - marked) / 2 ? "slight" : "moderate";
}

// --- Side-facing (sagittal) -------------------------------------------------

function depthCheck({ frame, depthPreset }: RepEvalInput): MetricResult {
  const hipY = frame.hipMid?.[1] ?? null;
  const kneeY = frame.kneeMid?.[1] ?? null;
  if (hipY === null || kneeY === null) return res("depth", "unknown", "Can't see hips/knees");
  const gap = hipY - kneeY; // y grows downward: larger gap = hip lower = deeper
  const target = DEPTH_PRESETS[depthPreset ?? DEFAULT_DEPTH_PRESET].targetGap;
  // Value is the shortfall vs the selected target: ≥0 means depth reached. This
  // makes the severity band a tolerance RELATIVE to whichever preset is active.
  const rel = gap - target;
  return rel >= 0
    ? res("depth", "ok", "Good depth", rel)
    : res("depth", "warn", "Go deeper — hips above target", rel);
}

function leanCheck({ frame, cfg }: RepEvalInput): MetricResult {
  if (frame.torsoLean === null) return res("forwardLean", "unknown", "Can't see torso");
  return frame.torsoLean <= cfg.forwardLeanWarnDeg
    ? res("forwardLean", "ok", "Chest up — good posture", frame.torsoLean)
    : res("forwardLean", "warn", "Too much forward lean — chest up", frame.torsoLean);
}

function velocityCheck({ velocity }: RepEvalInput): MetricResult {
  if (!velocity || !velocity.measured) return res("velocity", "unknown", "Velocity not measured this rep");
  if (velocity.degraded) {
    const pct = velocity.ratio !== null ? Math.round((1 - velocity.ratio) * 100) : null;
    return res("velocity", "warn", pct !== null ? `Rep speed down ${pct}% — fatigue` : "Rep speed dropping", velocity.ratio);
  }
  return res("velocity", "ok", "Tempo steady", velocity.ratio);
}

// --- Front-facing (frontal) -------------------------------------------------

function valgusCheck({ frame, cfg }: RepEvalInput): MetricResult {
  if (!frame.bothLegsVisible || frame.kneeWidth === null || frame.ankleWidth === null || frame.ankleWidth < 1e-4) {
    return res("kneeValgus", "unknown", "Can't see both knees + ankles");
  }
  const ratio = frame.kneeWidth / frame.ankleWidth;
  if (ratio < PLAUSIBLE.valgusRatio.lo || ratio > PLAUSIBLE.valgusRatio.hi) {
    return res("kneeValgus", "unknown", "Implausible knee/ankle ratio — landmark error");
  }
  return ratio >= cfg.valgusRatioWarn
    ? res("kneeValgus", "ok", "Knees tracking well", ratio)
    : res("kneeValgus", "warn", "Knees caving in — push them out", ratio);
}

function levelnessCheck({ frame, cfg }: RepEvalInput): MetricResult {
  if (!frame.leftShoulder || !frame.rightShoulder || !frame.leftHip || !frame.rightHip) {
    return res("shoulderHipLevelness", "unknown", "Can't see both shoulders + hips");
  }
  const shoulderTilt = lineTiltDeg(frame.leftShoulder, frame.rightShoulder);
  const hipTilt = lineTiltDeg(frame.leftHip, frame.rightHip);
  // Differential cancels camera roll (both lines share it) — leaving genuine
  // torso lateral tilt / one side dropping relative to the pelvis.
  const diff = Math.abs(shoulderTilt - hipTilt);
  if (diff > PLAUSIBLE.levelnessDiffMaxDeg) {
    return res("shoulderHipLevelness", "unknown", "Implausible shoulder/hip tilt — landmark error");
  }
  return diff <= cfg.levelnessWarnDeg
    ? res("shoulderHipLevelness", "ok", "Shoulders & hips level", diff)
    : res("shoulderHipLevelness", "warn", "One side dropping — stay square", diff);
}

/**
 * T10 knee symmetry: |left knee-deviation − right knee-deviation| / hip width.
 * Deviation = knee_x − ankle_x per leg; asymmetry means one side is compensating.
 * Body-size invariant (normalized by hip width). CONTEXT / post-set.
 */
function symmetryCheck({ frame }: RepEvalInput): MetricResult {
  if (!frame.leftKnee || !frame.rightKnee || !frame.leftAnkle || !frame.rightAnkle || frame.hipWidth === null || frame.hipWidth < 1e-4) {
    return res("kneeSymmetry", "unknown", "Can't see both knees + ankles");
  }
  const leftDev = frame.leftKnee[0] - frame.leftAnkle[0];
  const rightDev = frame.rightKnee[0] - frame.rightAnkle[0];
  const asym = Math.abs(leftDev - rightDev) / frame.hipWidth;
  if (asym > PLAUSIBLE.kneeSymmetryMax) {
    return res("kneeSymmetry", "unknown", "Implausible knee asymmetry — landmark error");
  }
  return asym <= TRIGGERS.symmetry.warn
    ? res("kneeSymmetry", "ok", "Knees tracking symmetrically", asym)
    : res("kneeSymmetry", "warn", "One knee tracking differently", asym);
}

/**
 * T11 lateral trunk shift: |hip-mid_x − ankle-mid_x| / hip width. CONTEXT / post-set;
 * escalates to its own trigger only when severe over several reps (see useWorkout).
 */
function hipShiftCheck({ frame, depthRatio }: RepEvalInput): MetricResult {
  // Near lockout the hip-vs-ankle offset over a hip width degenerates (measured peaks of 1.44
  // hip-widths at depth 0.19 — physically "falling over"). "unknown" keeps these frames out of
  // BOTH the warn count and the denominator in aggregateRep. Undefined = bottom frame, at depth.
  if (depthRatio !== undefined && depthRatio < TRIGGERS.lateralShift.depthGate) {
    return res("hipShift", "unknown", "Not judged near lockout");
  }
  if (!frame.hipMid || !frame.ankleMid || frame.hipWidth === null || frame.hipWidth < 1e-4) {
    return res("hipShift", "unknown", "Can't see hips + ankles");
  }
  const shift = Math.abs(frame.hipMid[0] - frame.ankleMid[0]) / frame.hipWidth;
  if (shift > PLAUSIBLE.hipShiftMax) {
    return res("hipShift", "unknown", "Implausible hip shift — landmark error");
  }
  return shift <= TRIGGERS.lateralShift.warn
    ? res("hipShift", "ok", "Hips centered over the feet", shift)
    : res("hipShift", "warn", "Hips drifting to one side", shift);
}

/**
 * True if ANY computable geometric quantity on this frame is physically impossible
 * (outside PLAUSIBLE) — a landmark-tracking failure rather than a movement. Used by the
 * rep-level reliability flag (Tier 2) to distrust the WHOLE rep, including its in-range
 * fields, when one field blows out (the 19° tilt co-occurring with the impossible 2.3 drift).
 * Null (occluded) quantities are skipped — occlusion is not implausibility.
 *
 * ORIENTATION-GATED (fixed 2026-07-31). Every check below reads FRONTAL-plane geometry, which
 * is degenerate edge-on: the hips and shoulders stack, so `hipWidth` collapses to ~0.007 and
 * becomes a tiny DENOMINATOR. Measured on the real run, the hipShift arm tripped on ~100% of
 * side-view frames (28–50 per rep) and the knee-symmetry and levelness arms on many more.
 * Result: 18/18 side reps flagged unreliable vs 0/12 front reps, with visibility a healthy
 * 0.80–0.92 throughout — i.e. nothing was actually wrong with the tracking. That emptied
 * `reliableReps` on every side set, which silently nulled `context.velocity_collapse_ratio`,
 * so side sets could never carry fatigue evidence.
 *
 * Sagittal metrics need none of these checks, so they simply do not run off a side view.
 * Widening the bounds would NOT fix this — the quantities are undefined edge-on, not extreme.
 */
export function landmarkImplausible(frame: SquatFrame, orientation: Orientation): boolean {
  if (orientation !== "front") return false;
  if (frame.kneeWidth !== null && frame.ankleWidth !== null && frame.ankleWidth > 1e-4) {
    const r = frame.kneeWidth / frame.ankleWidth;
    if (r < PLAUSIBLE.valgusRatio.lo || r > PLAUSIBLE.valgusRatio.hi) return true;
  }
  if (frame.hipMid && frame.ankleMid && frame.hipWidth !== null && frame.hipWidth > 1e-4) {
    if (Math.abs(frame.hipMid[0] - frame.ankleMid[0]) / frame.hipWidth > PLAUSIBLE.hipShiftMax) return true;
  }
  if (frame.leftKnee && frame.rightKnee && frame.leftAnkle && frame.rightAnkle && frame.hipWidth !== null && frame.hipWidth > 1e-4) {
    const asym = Math.abs((frame.leftKnee[0] - frame.leftAnkle[0]) - (frame.rightKnee[0] - frame.rightAnkle[0])) / frame.hipWidth;
    if (asym > PLAUSIBLE.kneeSymmetryMax) return true;
  }
  if (frame.leftShoulder && frame.rightShoulder && frame.leftHip && frame.rightHip) {
    const diff = Math.abs(lineTiltDeg(frame.leftShoulder, frame.rightShoulder) - lineTiltDeg(frame.leftHip, frame.rightHip));
    if (diff > PLAUSIBLE.levelnessDiffMaxDeg) return true;
  }
  return false;
}

/**
 * Butt wink is NOT directly measurable (no spine landmarks). It's inferred as a
 * bodyweight CONTEXT note (lean concentrated near full depth) or fired as a LOADED
 * early-onset trigger — both decided per rep in useWorkout, not per frame here.
 */
function buttWinkCheck(): MetricResult {
  return res("buttWink", "not-checked", "Inferred from lean + depth — not measured directly");
}

/** Eccentric control is a per-rep time-series signal (descent speed + bounce);
 *  computed in useWorkout and injected, so the per-frame slot is a placeholder. */
function eccentricPlaceholder(): MetricResult {
  return res("eccentricControl", "not-checked", "Evaluated per rep from the descent");
}

/** Tilt of the line from a→b off horizontal, in degrees [-90,90]. */
function lineTiltDeg(a: Pt, b: Pt): number {
  let deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  if (deg > 90) deg -= 180;
  if (deg < -90) deg += 180;
  return deg;
}

function res(metric: MetricId, status: CheckStatus, message: string, value: number | null = null): MetricResult {
  // Default "good"; evaluateMetric overrides with the real severity. Direct
  // callers (live geometry helpers) only need the placeholder.
  return { metric, status, severity: status === "warn" ? "warning" : "good", message, value };
}

/** Metric ids that warned this rep — used to scope the AI prompt. */
export function warnedMetrics(m: RepMetrics): MetricId[] {
  return METRIC_ORDER.filter((id) => m[id].status === "warn");
}

/** Metric ids whose severity is CRITICAL this rep (the AI-trigger zone). */
export function criticalMetrics(m: RepMetrics): MetricId[] {
  return METRIC_ORDER.filter((id) => m[id].severity === "critical");
}

/**
 * Counting policy: does a completed attempt count as a rep?
 *  - SIDE sets gate on DEPTH — the bottom hip-vs-knee gap (hipY − kneeY) must
 *    reach the active preset's `targetGap`. An occluded bottom (null gap) counts,
 *    so a momentarily lost landmark never silently voids a rep. (Unchanged.)
 *  - FRONT sets gate on the distance-invariant depthRatio (`bottomDepthRatio`)
 *    against the per-preset `frontRatioTarget`. This is COUNTING only — front has
 *    no depth GRADE. Deeper always counts (>=, no upper bound). A null bottom ratio
 *    (missing landmarks) must NOT silently pass → it does not count.
 * Attempt DETECTION (the rep state machine) is unchanged and orientation-agnostic;
 * this only decides whether a detected attempt increments the counter.
 */
/**
 * Baseline hygiene gate: may this rep CALIBRATE the per-set baselines (lean/descent/shift/vis)?
 * A rep whose bottom barely passed its own depth target (rel = gap − targetGap ≈ 0) is a
 * settle/hinge, not a squat, and would poison the baselines (Set 5 reps 1-2 fed a 58° lean
 * baseline from 52-63° positioning frames, killing T1 all set). Measured RELATIVE to the active
 * preset's targetGap so it's preset-robust (parallel 0.0, full +0.05, above −0.1) — an above-
 * parallel rep at gap −0.05 still reads rel 0.05. Gated on gap-past-target, NOT depthRatio: the
 * corrupt reps had normal displacement (0.67/0.77) but ~zero gap. A null gap (occluded bottom) is
 * allowed to feed — occlusion isn't a settle. Distinct from repCounts: this NEVER changes whether
 * the rep counts, only whether it calibrates. UNVALIDATED (n=1, parallel).
 */
export function repFeedsBaseline(bottomGap: number | null, targetGap: number, minRel: number): boolean {
  if (bottomGap === null) return true;
  return bottomGap - targetGap >= minRel;
}

export function repCounts(
  orientation: Orientation,
  bottomGap: number | null,
  targetGap: number,
  bottomDepthRatio: number | null,
  frontRatioTarget: number,
): boolean {
  if (orientation === "side") return bottomGap === null ? true : bottomGap >= targetGap;
  // Front: never let a missing depthRatio silently count.
  if (bottomDepthRatio === null) return false;
  return bottomDepthRatio >= frontRatioTarget;
}

/**
 * T2 eccentric-control verdict for a completed rep. Two sub-signals fire as ONE
 * trigger: 2a descent-rate spike (descentSpeed ≥ descentSpikeMult × the reps-1–2
 * baseline) and 2b bottom bounce (reversalMs ≤ bounceMaxMs). value encodes how
 * many sub-signals fired (0 ok, 1 one, 2 both) → SEVERITY escalates 2 to critical.
 */
export function evalEccentric(
  descentSpeed: number | null,
  descentBaseline: number | null,
  reversalMs: number | null,
  /**
   * Did this rep reach the depth target? The BOUNCE term only — a bounce means "rebounded out
   * of the bottom", which is meaningless on a rep that never reached a bottom. Measured
   * 2026-07-31: the only rep in 30 with a sub-300 ms reversal was a deliberate quarter squat
   * (268.7 ms), so without this gate raising `bounceMaxMs` off its unreachable 150 ms just
   * converts a dead signal into a shallow-rep false positive. The descent-SPIKE term is
   * unaffected — dropping fast is a fault at any depth.
   */
  reachedDepth: boolean,
): MetricResult {
  if (descentSpeed === null && reversalMs === null) {
    return res("eccentricControl", "unknown", "Descent not measured this rep");
  }
  const spike =
    descentSpeed !== null && descentBaseline !== null && descentBaseline > 0
      ? descentSpeed / descentBaseline >= TRIGGERS.eccentric.descentSpikeMult
      : false;
  const bounce = reachedDepth && reversalMs !== null && reversalMs <= TRIGGERS.eccentric.bounceMaxMs;
  if (spike && bounce) return res("eccentricControl", "warn", "Dropping fast and bouncing out of the bottom", 2);
  if (spike) return res("eccentricControl", "warn", "Descending too fast — control the way down", 1);
  if (bounce) return res("eccentricControl", "warn", "Bouncing out of the bottom — pause and drive up", 1);
  return res("eccentricControl", "ok", "Controlled descent", 0);
}

/**
 * T1 baseline-relative forward-lean trigger condition (mid-set, gated to the deep
 * part of the rep). True when lean exceeds the per-set baseline by ≥ baselineDeltaDeg
 * while past the depth gate. Pair with a 150ms PersistenceGate before firing.
 */
export function leanTriggerActive(leanDeg: number | null, baseline: number | null, depthRatio: number): boolean {
  if (leanDeg === null || baseline === null) return false;
  return depthRatio >= TRIGGERS.lean.depthGate && leanDeg - baseline >= TRIGGERS.lean.baselineDeltaDeg;
}

/**
 * T7 valgus trigger condition (mid-set), gated to mid-descent and below. True when
 * the knee/ankle width ratio is below the warn threshold past the depth gate. Pair
 * with a 150ms PersistenceGate before firing.
 */
export function valgusTriggerActive(ratio: number | null, depthRatio: number, cfg: SquatConfig): boolean {
  if (ratio === null) return false;
  // Same physical-possibility gate as the metric: a garbage ratio (e.g. 0.07) must not fire
  // T7. This is the upstream-of-the-trigger guard for valgus — T7 reads this raw ratio, NOT
  // the metric status. (T11 needs no equivalent here: its predicate reads the hipShift metric
  // value, which computeMetric already nulls to "unknown" when the shift is implausible.)
  if (ratio < PLAUSIBLE.valgusRatio.lo || ratio > PLAUSIBLE.valgusRatio.hi) return false;
  return depthRatio >= TRIGGERS.valgus.depthGate && ratio < cfg.valgusRatioWarn;
}

/**
 * T11 baseline-relative lateral-shift trigger (post-set, front). True when the rep's hip
 * lateral shift exceeds the per-set (reps 1–2) baseline by ≥ baselineDeltaRatio. Mirrors
 * leanTriggerActive: the absolute `lateralShift.warn` metric is kept for display/context;
 * THIS decides firing so a naturally slightly-shifted stance isn't flagged on neutral reps.
 * Gate the call site on `scored` (rep > baselineReps) + front view. (T10 knee-symmetry has
 * NO such predicate — it's demoted to context-only; the metric is anti-correlated with the
 * fault, so baseline-gating can't help. See TRIGGERS.symmetry.)
 */
export function shiftTriggerActive(shift: number | null, baseline: number | null): boolean {
  if (shift === null || baseline === null) return false;
  return shift - baseline >= TRIGGERS.lateralShift.baselineDeltaRatio;
}

/**
 * Faults that can occur at ANY point in the movement (not just the bottom), so
 * the rep verdict is the WORST across the rep's frames rather than a single
 * bottom snapshot: the frontal-plane faults plus forward lean. Depth is
 * intentionally NOT here — it's judged at the deepest point (the `base`
 * bottom-frame result), which is what "depth" means.
 *
 * `hipShift` joined 2026-07-31: it was bottom-frame only, so a shift performed on the way UP
 * was invisible (the likely cause of the set-4 rep-4 miss). Its per-frame evaluation is depth
 * gated inside `hipShiftCheck` — see TRIGGERS.lateralShift.depthGate for why it cannot be
 * aggregated ungated.
 */
export const AGGREGATED_METRICS: MetricId[] = ["kneeValgus", "shoulderHipLevelness", "forwardLean", "hipShift"];

const SEV_RANK: Record<Severity, number> = { good: 0, warning: 1, critical: 2 };

/**
 * Combine per-frame evaluations of a rep into one verdict. `base` is the
 * bottom-frame result (carries velocity / repCount / depth / barPath);
 * the AGGREGATED_METRICS are replaced with a worst-of across `frames`. A metric
 * warns only if it warned on a sustained share of the frames it was checked on
 * (filters single-frame noise — e.g. a one-frame levelness blip); within a
 * confirmed warn it escalates to the most severe warn frame (critical > warning).
 */
export function aggregateRep(
  base: RepMetrics,
  frames: RepMetrics[],
  minWarnFrames = 2,
  minWarnFraction = 0.2,
): RepMetrics {
  const out: RepMetrics = { ...base };
  for (const id of AGGREGATED_METRICS) {
    const results = frames.map((f) => f[id]);
    const checked = results.filter((r) => r.status === "ok" || r.status === "warn");
    const warns = checked.filter((r) => r.status === "warn");
    if (checked.length === 0) {
      // Never observably checked across the rep → unknown if seen, else keep base
      // (preserves not-checked / unavailable).
      const unknown = results.find((r) => r.status === "unknown");
      out[id] = unknown ?? base[id];
    } else if (warns.length >= Math.max(minWarnFrames, minWarnFraction * checked.length)) {
      // Most severe warn frame, and WITHIN the top severity band the most extreme VALUE —
      // not merely the last one. The old `>=` reduce kept whichever warn frame came last
      // chronologically, so a field named peak_severity_ratio could report a middling value
      // while the archived photo showed the true worst rep (2026-07-27 set 1: reps measured
      // 43.8°/69.8° lean, payload reported 50.7°). Direction comes from SEVERITY[id].worseWhen,
      // the single per-metric direction source — the payload's peakSeverity/tagMoreSevere
      // (ai/gemini.ts) resolves against the same field, so the two cannot drift apart.
      const worseWhen = SEVERITY[id]?.worseWhen;
      out[id] = warns.reduce((worst, r) => {
        const rank = SEV_RANK[r.severity];
        const bestRank = SEV_RANK[worst.severity];
        if (rank !== bestRank) return rank > bestRank ? r : worst;
        if (r.value === null || worst.value === null || !worseWhen) return worst;
        return (worseWhen === "below" ? r.value < worst.value : r.value > worst.value) ? r : worst;
      });
    } else {
      out[id] = checked.find((r) => r.status === "ok") ?? checked[checked.length - 1];
    }
  }
  return out;
}
