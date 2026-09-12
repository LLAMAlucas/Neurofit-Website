/**
 * Neuro-Fit — squat thresholds (the single source of tuning for Phase 1).
 * ----------------------------------------------------------------------------
 * PURE module: no React, no DOM. Everything under src/neurofit/squat is written
 * to be portable (browser today, mobile/server later).
 *
 * Every value here is a STARTING POINT to tune against real footage (MediaPipe
 * coordinates are normalized, `z` is relative depth — not metric). Do NOT treat
 * any number as final.
 */
import type { MetricId } from "./metrics";

/**
 * Camera-orientation tolerance zones (degrees). Convention used here:
 *   facingAngleDeg = 90° is FRONT-on (subject square to the camera);
 *   facingAngleDeg = 0° or 180° is SIDE-on (profile, either shoulder nearer).
 * This matches §1 of the spec (FRONT = 90° ± 15°, SIDE = 0°/180° ± 15°).
 *
 * NOTE on a spec inconsistency: §3 describes the side-facing edges as 75°/105°,
 * which would put true side-on at 90° — the opposite of §1. We follow §1 here
 * (the dedicated definition). Because both the convention and the per-check
 * tolerances below are plain constants, flipping to the other reading is a
 * one-line change, not a rewrite.
 */
export const ORIENTATION = {
  FRONT_DEG: 90,
  /** Side reference; 180° is the mirror profile and is treated identically. */
  SIDE_DEG: 0,
  /** Global tolerance used to CLASSIFY a set's orientation (front/side/ambiguous). */
  TOL_DEG: 15,
  /** Hold the correct orientation this long (s) before a set may start. */
  LOCK_SEC: 1.2,
  /** Brief out-of-orientation frames tolerated before the lock hold resets (s). */
  LOCK_GRACE_SEC: 0.4,
  /** Out-of-orientation jitter tolerated mid-set before checks pause (s). */
  AMBIGUOUS_GRACE_SEC: 0.6,
  /**
   * Facing-score anchors mapping shoulder-spread / torso-length → degrees off
   * front. Intentionally LOW: the score is POSTURE-COUPLED — standing upright
   * gives the lowest score and squatting foreshortens the torso, inflating it.
   * The lock happens while the user STANDS, so the anchors must let a standing
   * front-on pose clear the front band — otherwise "front" only locks once you
   * squat (which is the bug this fixes). score ≥ FRONT_FULL = dead front (0°);
   * ≤ SIDE_FULL = dead side (90°); EDGE values bound the ±15° zones. If front
   * won't lock standing, lower FRONT_FULL/FRONT_EDGE; if it locks too eagerly
   * off-axis, raise them. (Watch the live "facing" readout in the set bar.)
   */
  SCORE: { FRONT_FULL: 0.5, FRONT_EDGE: 0.3, SIDE_EDGE: 0.2, SIDE_FULL: 0.1 },
} as const;

export interface SquatConfig {
  // --- Rep state machine (vertical HIP DISPLACEMENT) ----------------------
  // Rep counting keys off how far the hips drop, NOT the 2D knee angle. The
  // knee bends in the SAGITTAL plane, which is mostly along the camera's depth
  // axis in a front-on view — so the projected 2D knee angle barely changes
  // head-on and never crosses an angle gate. Hip height (ankle.y − hip.y),
  // normalized by the standing value, drops in BOTH views, so it's the
  // orientation-agnostic signal the spec calls for.
  /**
   * Depth ratio (0 = standing, 1 = hips at ankle) to ARM a rep. 0.18 ≈ the hips
   * have dropped ~18% of standing leg height — well short of parallel, so even a
   * shallow squat arms; the depth CHECK separately judges whether it was deep
   * enough.
   */
  repDownRatio: number;
  /** Depth ratio to COMPLETE a rep (returned to near standing). The gap to
   *  repDownRatio is the hysteresis that prevents jitter double-counts. */
  repUpRatio: number;
  /** Debounce floor (s): ignore a "rep" shorter than this — bounce/jitter. */
  minRepSec: number;
  /** A real rep moves the hips this far vertically (normalized) — guards a tiny
   *  bob that crosses the depth ratio without an actual squat. */
  minHipTravel: number;
  /** Min depth-past-target (rel = bottom hip-vs-knee gap − preset targetGap) for a rep to
   *  CALIBRATE the per-set baselines. Below this the rep barely reached its target — a
   *  settle/hinge, not a squat — and must not poison lean/descent/shift/vis baselines. Kept
   *  RELATIVE to targetGap so it's preset-robust. Does NOT affect counting (repCounts) or
   *  total_reps_attempted. UNVALIDATED (n=1, parallel). */
  baselineMinDepthRel: number;
  /**
   * Front-view depth COUNTING targets (per depth preset). Front sets have no depth
   * GRADE, but a front rep should still only count once real depth is reached.
   * depthRatio = (hUp − h)/hUp is distance-invariant (normalizes to the user's own
   * standing leg-height within the set), so it's the correct front-view depth basis
   * — it reuses the rep's bottomDepthRatio. A front rep counts when bottomDepthRatio
   * ≥ this target; DEEPER always counts (no upper bound). Only `above`/`parallel`
   * have estimates — `full` is out of scope for a calibrated front estimate and
   * falls back to the `parallel` target at the call site (a full-depth rep exceeds
   * it anyway).
   */
  frontRatioTarget: Record<"above" | "parallel", number>;

  // --- Form: depth -----------------------------------------------------
  // Depth uses hip-Y vs knee-Y (NOT joint angles) and is judged against the
  // user-selected DEPTH_PRESETS target (see below), so there is no single
  // depthMargin here anymore — the target IS the threshold.

  // --- Form: forward lean (trunk vs vertical) -----------------------------
  /** Warn when the trunk leans more than this from vertical (deg) at the
   *  bottom. A squat naturally leans some; this bounds excessive lean. */
  forwardLeanWarnDeg: number;

  // --- Form: knee valgus (knees caving in) --------------------------------
  /** Warn when knee-width / ankle-width drops below this (knees tracking
   *  inside the ankles). Only evaluated from a frontal-ish view where both
   *  knees AND both ankles are visible — valgus is unobservable side-on. */
  valgusRatioWarn: number;

  // --- Velocity-based rep-quality tracking --------------------------------
  /** Reps with a trusted velocity baseline before the velocity trigger can
   *  fire. 2 means reps 1 & 2 never trigger (rep 3 is the first eligible). */
  velocityWarmupReps: number;
  /** Fire the velocity-degradation trigger when a rep's concentric velocity is
   *  more than this fraction below the set's ROLLING-AVERAGE velocity.
   *  0.20 = 20% slower than the running average. */
  velocityDropFraction: number;

  // --- AI critique trigger -------------------------------------------------
  /** Coalescing window (seconds): when the velocity trigger and a fault-severity
   *  spike both fire on the SAME rep within this window, they're merged into one
   *  combined Gemini call instead of two (spec §5). */
  aiDedupWindowSec: number;

  // --- Per-check angle tolerance (deg) ------------------------------------
  /**
   * How far the per-rep facing angle may sit from a check's reference
   * orientation (0° side / 90° front) and STILL be trusted for that check.
   * Tolerance is PER-CHECK, not global: §3 of the spec warns ±15° may not hold
   * for every check. A rep whose angle is outside a check's tolerance yields
   * "unknown" for that check (distinct from a clean pass). Starting points —
   * narrow any that don't hold at their edge against real footage.
   */
  checkToleranceDeg: Record<MetricId, number>;

  // --- Frontal-plane fault thresholds -------------------------------------
  /** Shoulder/hip levelness (front): warn when the shoulder line tilts more
   *  than this (deg) RELATIVE TO the hip line (roll-invariant — see checks.ts). */
  levelnessWarnDeg: number;
}

export const SQUAT: SquatConfig = {
  // Hip-displacement rep gates (orientation-agnostic; work front AND side).
  repDownRatio: 0.18,
  repUpRatio: 0.08,
  // No human squat completes in under ~0.3 s — a real debounce floor.
  minRepSec: 0.3,
  minHipTravel: 0.02,
  // Settling frames (Set 5 reps 1-2: rel ~0.005 past target) fed a 58° lean baseline that
  // killed T1 for the whole set; genuine reps sit at rel ≥ 0.06. 0.03 is the midpoint of that
  // empty band. Gated on gap-past-target, NOT depthRatio — the corrupt reps had NORMAL hip
  // displacement (depthRatio 0.67/0.77) but a near-zero gap. UNVALIDATED (n=1, parallel).
  baselineMinDepthRel: 0.03,
  frontRatioTarget: {
    // UNVALIDATED front-view depth estimate — not calibrated against side-view footage.
    // Doubled 0.20 → 0.40 (user feedback: reps counted on far-too-shallow squats).
    above: 0.4,
    // UNVALIDATED front-view depth estimate — not calibrated against side-view footage.
    // 0.33 → 0.66 (require ~2× the hip drop before a front rep counts), then eased
    // 0.66 → 0.60 (user feedback: 0.66 was very slightly too strict on real parallel reps).
    parallel: 0.6,
  },

  // Trunk lean from image vertical at the bottom. Lowered 45° → 35°: at 45° the
  // check effectively never fired (a deep squat naturally leans ~30°), so genuine
  // good-morning / excessive forward lean went unflagged. 35° warns on clearly
  // excessive lean while a balanced squat (~25–30°) stays clear. Tune on footage.
  forwardLeanWarnDeg: 35,

  // knee-width / ankle-width below this → knees caving in. 0.8 fired on straight
  // legs (user feedback: warns when standing/legs straight), so nudged 0.8 → 0.72
  // to require a bit more cave before warning — still catches mild valgus while a
  // neutral/straight-leg stance stays clear. Tune on footage.
  valgusRatioWarn: 0.72,

  velocityWarmupReps: 2,
  // Spec §2: >20% slower than the set's rolling-average velocity.
  velocityDropFraction: 0.2,

  // Spec §5: combine same-rep triggers that land within 500 ms into one call.
  aiDedupWindowSec: 0.5,

  // Per-check tolerance (deg). Default 15° (the global zone). Depth is the most
  // foreshortening-sensitive off true side-on, so it is narrowed to 10° as a
  // starting point (validate at the edge — see TOLERANCE_VALIDATION.md).
  // `velocity` is agnostic (tracked both views) so its tolerance is unused, but
  // the per-metric Record requires an entry for every MetricId.
  checkToleranceDeg: {
    depth: 10,
    forwardLean: 15,
    // buttWink reads a sagittal vertical relationship like depth — narrow it too.
    buttWink: 10,
    velocity: 15,
    // eccentricControl is agnostic (hip-Y over time); gate unused but Record needs it.
    eccentricControl: 15,
    // Front checks use the full zone (15°): the facing angle is a rough estimate,
    // and once a set is locked "front" we want its checks to actually run rather
    // than drop to "unknown" at the edge.
    kneeValgus: 15,
    shoulderHipLevelness: 15,
    kneeSymmetry: 15,
    hipShift: 15,
    repCount: 15,
    barPath: 15,
  },

  levelnessWarnDeg: 8,
};

/**
 * Squat depth target presets (Settings tab). Depth is hip-Y minus knee-Y in
 * MediaPipe normalized image coords (y grows DOWNWARD), so a LARGER gap = hip
 * lower = deeper. `targetGap` is the gap at/above which a rep counts as having
 * reached depth ("ok"); below it the rep warns. The check stores the SHORTFALL
 * (gap − targetGap) as its value, so the severity band below is a tolerance
 * RELATIVE TO whichever preset is selected — identical zones across presets.
 *
 * Values are derived from the prior single depthMargin (0.10): "above parallel"
 * reproduces it (hip up to 0.10 above the knee still ok); "parallel" requires
 * the hip to reach knee level (gap ≈ 0); "full" requires the hip below the knee.
 * ⚠ Starting points — validate against real footage.
 */
export type DepthPreset = "full" | "parallel" | "above";

export interface DepthPresetSpec {
  id: DepthPreset;
  label: string;
  /** Gap (hipY − kneeY, normalized) the hip must REACH to count as good depth. */
  targetGap: number;
}

export const DEPTH_PRESETS: Record<DepthPreset, DepthPresetSpec> = {
  // Hip well BELOW the knee. +0.05 ≈ hip a twentieth of the frame below the knee.
  full: { id: "full", label: "Full depth", targetGap: 0.05 },
  // Hip REACHES knee level (parallel). gap ≈ 0.
  parallel: { id: "parallel", label: "Parallel", targetGap: 0.0 },
  // Hip may STAY above the knee. −0.10 reproduces the old depthMargin (most lenient).
  above: { id: "above", label: "Above parallel", targetGap: -0.1 },
};

export const DEFAULT_DEPTH_PRESET: DepthPreset = "parallel";

/**
 * Training mode. Bodyweight is the default; loaded flips the *valence* of several
 * signals (v2 Part 2): butt wink becomes a real early-onset trigger, excessive
 * uncontrolled depth can fail a rep, and depth/valgus context is read more
 * cautiously. The app ships without equipment detection, so this is a user toggle.
 */
export type SquatMode = "bodyweight" | "loaded";
export const DEFAULT_MODE: SquatMode = "bodyweight";

/**
 * Gemini two-tier integration config (post-set / post-workout, adapted to the browser).
 * The model + API key are read from env in `ai/gemini.ts`; these are the buffer and
 * thinking-tier knobs. `LOAD_MODE` from the spec is the runtime `SquatMode` toggle
 * (`useMode`), not a constant here. (Mid-set cues + their rate limiter were removed —
 * latency made real-time cues unusable.)
 *
 * Model is now `gemini-3.6-flash` (migrated from 3.5-flash 2026-07-25; the request
 * shape carries over unchanged — same `generateContent`, same 65536-token output
 * ceiling, same `thinkingLevel` vocabulary, inline JPEG parts accepted, temperature
 * still omitted — verified by an A/B replaying a real post-set + post-workout payload
 * against both models: 200/STOP on all four calls). Thinking levels ARE sent
 * (`sendThinking=true`) as `generationConfig.thinkingConfig.thinkingLevel`:
 * post-set "medium" (visual+numeric synthesis), post-workout "low" (text-only synthesis).
 * ⚠️ Gemini 3.x guidance: do NOT send `temperature` (leave it at the 1.0 default —
 * lowering it can cause thinking loops), and thinking consumes the output-token
 * budget, so the per-call `maxOutputTokens` caps are raised accordingly in
 * `ai/gemini.ts`. If a call 400s on an unknown field, the error text names it.
 */
export const GEMINI = {
  // Mid-set cues were removed (latency made them unusable), so there is no mid-set tier.
  // post-set is now the ONLY visual+numeric synthesis tier → keeps "medium". post-workout is
  // text-only (no images, summarizing the per-set debriefs + numeric trends) → dropped to "low".
  thinking: { postSet: "medium", postWorkout: "low" },
  sendThinking: true,
  image: {
    /** Capture one buffered frame at most this often (ms). */
    cadenceMs: 250,
    /** Hard cap on retained frames (ring buffer). */
    maxFrames: 30,
    width: 640,
    height: 480,
    /** JPEG quality for toDataURL (0–1; spec's "75" → 0.75). */
    jpegQuality: 0.75,
  },
  /** Landmark ring-buffer window (ms). */
  landmarkWindowMs: 3000,
} as const;

/**
 * v2 trigger thresholds (neurofit-trigger-logic-v2).
 * ----------------------------------------------------------------------------
 * ⚠️ EVERY value here is an UNCALIBRATED n=1 starting guess (the developer, a
 * long-femur outlier). Multi-body calibration is the gating dependency before any
 * of this is trustworthy — these are centralized and named so that pass is a
 * one-file edit. All persistence/timing is in MILLISECONDS because the frame rate
 * is adaptive (never count frames). Thresholds that compare to a per-set baseline
 * are ratios/deltas, which are body-size invariant.
 */
export const TRIGGERS = {
  /** A mid-set trigger condition must hold this long before it fires (jitter filter). */
  persistMs: 150,
  /** Reps 1–2 establish the per-set baseline; NO trigger fires during them. */
  baselineReps: 2,

  /** T1 forward lean — baseline-relative, judged across the rep (see depthGate). */
  lean: {
    /** Fire when lean exceeds the reps-1–2 baseline by this many degrees… */
    baselineDeltaDeg: 10,
    /**
     * …while past this depth_ratio. Widened 0.5 → 0.3 (2026-07-31 eval run): lifters lean
     * THROUGHOUT the rep, not only in the deep half, and at 0.5 the shallow part of a
     * genuinely leaning rep was discarded. Safe on measured data — normal reps peaked at
     * 19.9–23.5° in the shallow phase (threshold ~34–36°) while the deliberate-lean reps
     * were already at 41.9–66.1° there. The feared "early hip hinge reads as lean" false
     * positive did not appear. `maxLeanDeep` is a MAX over this window and deep lean ≥
     * shallow lean on every normal rep, so the baseline is unchanged by the widening.
     */
    depthGate: 0.3,
  },

  /** T2 eccentric control — uncontrolled descent and/or bottom bounce (one trigger). */
  eccentric: {
    /**
     * 2a: descent velocity > this × the reps-1–2 baseline = uncontrolled drop. Raised
     * 1.5 → 2.0 (2026-07-31 eval run): when warm-up reps are SLOWER than working reps the
     * baseline is depressed and normal reps trip the gate — set 3 fired two false positives
     * (0.34–0.39 vs a 0.342 threshold off a 0.228 baseline). Real users warm up slowly, so
     * this generalises. At 2.0× the genuine fast drop still fires (0.59 vs a 0.312 threshold)
     * and all 30 measured reps produce zero false positives. Stays baseline-relative, so it
     * remains body-size invariant.
     */
    descentSpikeMult: 2.0,
    /** 2a: spike must hold over this fraction of the descent (not one frame). */
    descentSpikeFraction: 0.5,
    /**
     * 2b: time from peak-down to peak-up velocity at the turnaround; below = bounce. Raised
     * 150 → 300 (2026-07-31 eval run): measured reversal across all 30 reps was
     * 268.7–1301.5 ms, so 150 ms was PROVABLY unreachable — it had never fired and never
     * could. ⚠️ Still uncalibrated: the protocol contained no deliberate bounce rep, so there
     * is no true positive behind this number. The only sub-300 ms rep was a deliberate
     * quarter squat, which is why the bounce term is now gated on the rep reaching depth
     * (see `evalEccentric`) — otherwise raising this just converts a dead signal into a
     * shallow-rep false positive.
     */
    bounceMaxMs: 300,
  },

  /** T6 velocity collapse (fatigue) — CONTEXT ONLY, never its own cue. */
  velocityCollapse: {
    /** Below this fraction of the rolling baseline = a fatigue signal for context. */
    ofBaseline: 0.6,
  },

  /**
   * T7 valgus — judged across the rep from early descent through the ascent.
   *
   * depthGate widened 0.30 → 0.15 (2026-07-31 eval run). T7 produced ZERO fires in 30 reps
   * including two deliberate max caves, and the cause was this gate, NOT the threshold:
   * reconstructing the rep from the landmark buffer showed the cave was WORST DURING THE
   * ASCENT (ratio 0.63→0.59 at depth 0.37→0.30, continuing to 0.52 at depth 0.11). At 0.30
   * only 3 frames (~77 ms) qualified, against the 150 ms PersistenceGate — it missed by
   * ~73 ms. At 0.15 the same rep yields 6 frames (~275 ms) and fires.
   *
   * Safe on measured data: minimum ratio at depth ≥ 0.15 was 0.996 (normal rep), 0.867 (big
   * hip shift) and 1.078 (quarter squat) — ZERO frames below the 0.72 threshold on any
   * non-cave rep, vs 6 on the cave rep. Do NOT widen further without re-checking: near
   * lockout the knee/ankle ratio degenerates (this is the old "warns on straight legs"
   * failure that pushed valgusRatioWarn 0.8 → 0.72).
   */
  valgus: { depthGate: 0.15 },

  /** T11 lateral trunk shift — context unless clearly severe over several reps. */
  lateralShift: {
    /** (hip_mid_x − base_x)/hip_width above this = a shift worth context (absolute
     *  metric warn; kept for display + Gemini context, no longer the fire decision). */
    warn: 0.08,
    /** Escalate to its own (post-set) trigger only at this × warn… */
    severeMult: 2,
    /** …sustained across at least this many reps. */
    severeReps: 3,
    /** UNVALIDATED n=2 PLACEHOLDER, revisit with more bodies. Baseline-relative FIRING
     *  delta: fire only when this rep's lateral shift exceeds the per-set (reps 1–2)
     *  baseline by this much — mirrors forward-lean's baselineDeltaDeg so a naturally
     *  slightly-shifted stance doesn't trip the absolute `warn`. Behaved sanely on n=2. */
    baselineDeltaRatio: 0.04,
    /**
     * Only judge lateral shift past this depth_ratio. Added 2026-07-31 when hipShift joined
     * AGGREGATED_METRICS: it was previously read from the BOTTOM FRAME ONLY, which misses a
     * shift performed on the way up (the likely cause of the set-4 rep-4 miss — 0.04 at the
     * bottom on a rep with a deliberate shift). But unlike valgus its shallow readings are
     * NOT physical: measured across-rep peaks hit 1.44 hip-widths at depth 0.19, against a
     * PLAUSIBLE.hipShiftMax of 1.5 (i.e. "falling over"). Aggregating ungated would
     * manufacture false positives on an already-noisy metric, so the window is restricted to
     * the depth range where the reading means something.
     */
    depthGate: 0.3,
  },

  /** T10 knee symmetry — |left_dev − right_dev|/hip_width above this = asymmetric. */
  symmetry: {
    /** Absolute metric warn — kept for display + Gemini context ONLY. DEMOTED as a trigger:
     *  the n=2 body test showed this metric is anti-correlated with knee cave (it read LOWER
     *  on genuine caves and fired on reps where valgus showed knees tracking wide), so it's
     *  structurally broken, not miscalibrated — no baseline gate can fix a metric that points
     *  the wrong way. T7 valgus (`valgusRatioWarn`) is the real cave detector. */
    warn: 0.1,
  },

  /** Butt wink. */
  buttWink: {
    /** Bodyweight CONTEXT note only: lean concentrated near full depth. */
    peakLeanDepth: 0.7,
    /** Loaded TRIGGER: rounding onset BEFORE parallel = depth_ratio below this. */
    loadedEarlyOnsetDepth: 0.5,
  },

  /** T3 loaded-only: uncontrolled excessive depth can fail a rep under load. */
  excessiveDepth: { loadedMaxRatio: 0.95 },
} as const;

/**
 * How far BELOW the selected preset's target (normalized) before depth is
 * CRITICAL rather than just WARNING. 0.10 mirrors the spread the old depthMargin
 * used between ok and the prior critical cutoff (−0.10 → −0.20). Because the
 * depth check reports its value relative to the target, this single tolerance
 * applies consistently to every preset.
 */
export const DEPTH_CRITICAL_TOLERANCE = 0.1;

/**
 * How far short of the depth target counts as a MARGINAL / MODERATE / LARGE miss.
 * ----------------------------------------------------------------------------
 * Purpose is PRESENTATION HONESTY, not detection: the counting decision is unchanged
 * (any shortfall fails the rep). These bands exist so the debrief can say "a hair above
 * parallel" instead of quoting `-0.0023`, which is a normalized image coordinate no
 * lifter can act on and which reads like a rounding error. The model is given the BAND,
 * never the raw number, so it still cannot invent a magnitude — it can only use one we
 * computed (see POSTSET_SYSTEM rule 6).
 *
 * Keyed by BASIS because the two units are not comparable: side sets decide on the
 * hip-vs-knee gap, front sets on depthRatio (fraction of standing leg height). A single
 * threshold across both would call a 0.02 gap miss and a 0.02 ratio miss the same thing.
 *
 * ⚠ UNVALIDATED (n=1). Anchored on the 2026-08-02 run: the two side misses measured
 * 0.0023 and 0.0060 short (both genuinely a hair — the lifter reached parallel and lost
 * it to a hard lean), while the deliberate quarter squat was 0.205 short on the ratio.
 * Bands must separate those, and do. Values below `marginal` = "marginal", below
 * `moderate` = "moderate", at/above = "large".
 */
export const DEPTH_SHORTFALL_BANDS = {
  hip_knee_gap: { marginal: 0.02, moderate: 0.06 },
  depth_ratio: { marginal: 0.05, moderate: 0.15 },
} as const;

export type DepthBasis = keyof typeof DEPTH_SHORTFALL_BANDS;
export type ShortfallBand = "marginal" | "moderate" | "large";

/** Plain-language slowdown bands for a velocity ratio (vs the rolling baseline). */
export type VelocityBand = "none" | "slight" | "moderate" | "marked";

/**
 * Severity bands (spec §1). Each gradeable check, once it is WARN, is split into
 * WARNING vs CRITICAL by comparing its measured `value` (the same number the
 * check already returns — the check logic is NOT modified) against `critical`.
 * `worseWhen` says which direction is worse:
 *   - "below": smaller value = worse (depth gap, valgus ratio, velocity ratio)
 *   - "above": larger value  = worse (lean deg, heel lift, levelness deg)
 * A value at/beyond `critical` → "critical" (surface + trigger AI); a warn that
 * hasn't reached `critical` → "warning" (surface only); anything not warned →
 * "good". Metrics absent here (repCount, barPath) are never graded → "good".
 *
 * ⚠ These are reasonable BIOMECHANICAL DEFAULTS only — they require physical
 * testing against real footage to validate (MediaPipe coords are normalized, not
 * metric; `value` units differ per check). Tune here without touching logic.
 */
export interface SeverityBand {
  /** Value at/beyond which a warned check is CRITICAL. */
  critical: number;
  worseWhen: "below" | "above";
}

export const SEVERITY: Partial<Record<MetricId, SeverityBand>> = {
  // Depth value is the SHORTFALL vs the selected preset target (gap − target):
  // ≥0 is good, <0 warns, and >DEPTH_CRITICAL_TOLERANCE short of target is critical.
  // This is a tolerance relative to whichever preset is active (spec task 2).
  depth: { critical: -DEPTH_CRITICAL_TOLERANCE, worseWhen: "below" },
  // Trunk lean from vertical (deg). warn > 35; critical past 50 (lowered with the
  // warn threshold so a severe forward lean still escalates to the AI coach).
  forwardLean: { critical: 50, worseWhen: "above" },
  // Velocity ratio vs rolling average. warn < 0.80; critical at a ~35% loss.
  velocity: { critical: 0.65, worseWhen: "below" },
  // Knee/ankle width ratio. warn < 0.80; critical when knees cave hard (raised
  // from 0.45 alongside the more-sensitive warn threshold).
  kneeValgus: { critical: 0.6, worseWhen: "below" },
  // Shoulder-vs-hip line tilt (deg). warn > 8; critical past 16.
  shoulderHipLevelness: { critical: 16, worseWhen: "above" },
  // Eccentric control: value = number of sub-signals (descent spike + bounce).
  // Both firing (2) = critical; one (1) = warning.
  eccentricControl: { critical: 2, worseWhen: "above" },
  // Lateral trunk shift ratio. Severe = warn × severeMult (escalates to a trigger).
  hipShift: { critical: TRIGGERS.lateralShift.warn * TRIGGERS.lateralShift.severeMult, worseWhen: "above" },
  // Knee-symmetry asymmetry ratio. Critical at 2× the warn threshold.
  kneeSymmetry: { critical: TRIGGERS.symmetry.warn * 2, worseWhen: "above" },
};
