/**
 * v2 context payload (Part 4 — the "companion" layer). PURE module.
 * ----------------------------------------------------------------------------
 * The payload handed to Gemini with every trigger. The triggers decide WHEN to
 * look; this is the causal, cross-metric WHY that makes coaching feel like a
 * trainer rather than a checklist. Built per rep and attached to the coaching
 * call + the post-set summary.
 *
 * Fields marked ⚠️ are uncalibrated/heuristic proxies (no spine landmarks, weak
 * foot landmarks) — they degrade to null gracefully and are framed to Gemini as
 * "possible", never asserted.
 */
import type { SquatMode } from "../squat/config";

export interface RepContextV2 {
  setIndex: number;
  repIndex: number;
  orientation: "front" | "side";
  mode: SquatMode;
  /** Where in the rep the triggering condition was strongest. */
  phaseOfRep: "descent" | "bottom" | "ascent" | null;

  // --- Depth (ties to T3) ---
  /** Raw depth achieved (hip-vs-knee gap at the bottom, normalized). */
  depthGap: number | null;
  /** Did the rep clear the user's chosen preset (goal-adherence, not danger)? */
  depthMet: boolean;
  /** Selected depth preset id, so Gemini distinguishes goal from limit. */
  depthPreset: string;
  /**
   * ⚠️ Preset-intent flag (NOT YET CAPTURED — open question 6). When true, the
   * preset is a deliberate mobility boundary, not a target being missed, and ALL
   * "go deeper" framing must be suppressed. Inference is unsafe; needs an explicit
   * signal. Always false until a capture mechanism is decided.
   */
  presetIsMobilityBoundary: boolean;

  // --- Upstream / causal ---
  /** ⚠️ Ankle proxy: shin inclination from vertical at depth (deg). Higher ≈ more
   *  dorsiflexion; stuck-vertical hints at restriction (upstream of lean/valgus/wink). */
  shinAngleDeg: number | null;
  /** ⚠️ Stance width at rep 1 (ankle-X separation / hip width) — quasi-static. */
  stanceWidthRatio: number | null;
  /** ⚠️ Coarse foot orientation at rep 1 (deg). Low reliability. */
  footAngleDeg: number | null;

  // --- Asymmetry bundle ---
  /** Shoulder-vs-hip tilt differential (deg, roll-cancelled). */
  levelnessDiffDeg: number | null;
  /** Knee tracking asymmetry (|L−R| dev / hip width). */
  kneeAsymmetry: number | null;
  /** Lateral hip shift ratio (hip-mid vs ankle-mid / hip width). */
  lateralShiftRatio: number | null;

  // --- Fatigue ---
  /** Velocity ratio vs the set rolling baseline (1 = fresh). */
  velocityRatio: number | null;
  /** T6 collapse: below the collapse threshold of baseline (fatigue). */
  velocityCollapsed: boolean;

  // --- Butt wink (mode-dependent) ---
  /** Bodyweight CONTEXT note: lean concentrated near full depth. */
  leanConcentratedDeep: boolean;
  /** Loaded proxy: lean spike onset BEFORE parallel (early-onset). */
  earlyLeanOnset: boolean;

  /** Loaded-only: uncontrolled excessive depth that may have failed the rep. */
  excessiveDepthLoaded: boolean;

  /** Was the reps-1–2 baseline itself established (false until warm-up done)? */
  baselineReady: boolean;
}

/** A blank context with everything null/false — fill in what's known per rep. */
export function emptyContext(
  setIndex: number,
  repIndex: number,
  orientation: "front" | "side",
  mode: SquatMode,
  depthPreset: string,
): RepContextV2 {
  return {
    setIndex,
    repIndex,
    orientation,
    mode,
    phaseOfRep: null,
    depthGap: null,
    depthMet: false,
    depthPreset,
    presetIsMobilityBoundary: false,
    shinAngleDeg: null,
    stanceWidthRatio: null,
    footAngleDeg: null,
    levelnessDiffDeg: null,
    kneeAsymmetry: null,
    lateralShiftRatio: null,
    velocityRatio: null,
    velocityCollapsed: false,
    leanConcentratedDeep: false,
    earlyLeanOnset: false,
    excessiveDepthLoaded: false,
    baselineReady: false,
  };
}
