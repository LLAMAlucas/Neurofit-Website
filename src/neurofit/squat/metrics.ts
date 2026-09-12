/**
 * Squat metric taxonomy. PURE module, no dependencies (so config.ts can import
 * it without a cycle).
 * ----------------------------------------------------------------------------
 * The full validated metric set, each tagged with the plane it's observable in
 * and therefore which camera orientation a SET must use for the check to run.
 * A check only runs when its `appliesTo` matches the set's orientation (or is
 * "agnostic"); otherwise its result is explicitly "not-checked" — which the data
 * model keeps DISTINCT from "checked and passed" (ok).
 *
 * `barPath` is a deliberate stub: the field exists so the data model is stable
 * when load/equipment detection (Phase 3) lands, but it is never computed here —
 * its status is always "unavailable".
 */

/** Camera orientation a set is filmed in. "ambiguous" is a session-level state,
 *  not a value a check is gated on (checks never run while ambiguous). */
export type Orientation = "front" | "side";

export type MetricId =
  // sagittal plane — side-facing sets only
  | "depth"
  | "forwardLean"
  | "buttWink"
  // works from either angle (tracked in both views)
  | "velocity"
  | "eccentricControl"
  // frontal plane — front-facing sets only
  | "kneeValgus"
  | "shoulderHipLevelness"
  | "kneeSymmetry"
  | "hipShift"
  // works from either angle
  | "repCount"
  // stub — needs equipment detection (Phase 3), never computed in this build
  | "barPath";

/**
 * - ok           : checked, within target.
 * - warn         : checked, fault detected.
 * - unknown      : the right orientation, but this rep wasn't readable (joints
 *                  occluded, or the frame's angle fell outside THIS check's
 *                  per-check tolerance). NOT the same as a clean pass.
 * - not-checked  : the set's orientation can't observe this metric — never run.
 * - unavailable  : feature not built (barPath / equipment detection).
 */
export type CheckStatus = "ok" | "warn" | "unknown" | "not-checked" | "unavailable";

/**
 * Severity zone layered on top of CheckStatus (spec: three zones, not a binary
 * flag). Derived from the measured value against the tunable SEVERITY bands in
 * config.ts — the check logic itself is untouched.
 *   - good     : within normal range — no action (status ok / unknown / not-checked / unavailable).
 *   - warning  : outside normal range — surface in UI, do NOT trigger the AI coach.
 *   - critical : significantly outside range — surface AND trigger the AI coach.
 */
export type Severity = "good" | "warning" | "critical";

/**
 * Output tier (v2 Part 5): where a metric's signal surfaces.
 *   - "midset"  : eligible to fire a real-time coaching cue mid-set.
 *   - "postset" : surfaced only in the per-set / post-workout summary.
 *   - "context" : never surfaces on its own — feeds the payload to other triggers
 *                 (velocity collapse, rep gate, bar-path stub).
 */
export type MetricTier = "midset" | "postset" | "context";

export interface MetricSpec {
  id: MetricId;
  label: string;
  plane: "sagittal" | "frontal" | "agnostic" | "none";
  /** Which set orientation can observe this metric. */
  appliesTo: Orientation | "agnostic" | "none";
  /** Where this metric's signal is allowed to surface (v2 output tiers). */
  tier: MetricTier;
}

export const METRICS: Record<MetricId, MetricSpec> = {
  depth: { id: "depth", label: "Depth", plane: "sagittal", appliesTo: "side", tier: "postset" },
  forwardLean: { id: "forwardLean", label: "Forward lean", plane: "sagittal", appliesTo: "side", tier: "midset" },
  buttWink: { id: "buttWink", label: "Butt wink", plane: "sagittal", appliesTo: "side", tier: "postset" },
  velocity: { id: "velocity", label: "Velocity / tempo", plane: "agnostic", appliesTo: "agnostic", tier: "context" },
  eccentricControl: { id: "eccentricControl", label: "Eccentric control", plane: "agnostic", appliesTo: "agnostic", tier: "midset" },
  kneeValgus: { id: "kneeValgus", label: "Knee valgus", plane: "frontal", appliesTo: "front", tier: "midset" },
  shoulderHipLevelness: { id: "shoulderHipLevelness", label: "Shoulder/hip levelness", plane: "frontal", appliesTo: "front", tier: "postset" },
  kneeSymmetry: { id: "kneeSymmetry", label: "Knee symmetry", plane: "frontal", appliesTo: "front", tier: "postset" },
  hipShift: { id: "hipShift", label: "Lateral trunk shift", plane: "frontal", appliesTo: "front", tier: "postset" },
  repCount: { id: "repCount", label: "Rep counting", plane: "agnostic", appliesTo: "agnostic", tier: "context" },
  barPath: { id: "barPath", label: "Bar path / COM drift", plane: "none", appliesTo: "none", tier: "context" },
};

/** Stable display/iteration order. */
export const METRIC_ORDER: MetricId[] = [
  "repCount",
  "depth",
  "forwardLean",
  "eccentricControl",
  "buttWink",
  "velocity",
  "kneeValgus",
  "shoulderHipLevelness",
  "kneeSymmetry",
  "hipShift",
  "barPath",
];

/** Metrics observable from a given set orientation (incl. agnostic). */
export function metricsForOrientation(o: Orientation): MetricId[] {
  return METRIC_ORDER.filter((m) => METRICS[m].appliesTo === o || METRICS[m].appliesTo === "agnostic");
}
