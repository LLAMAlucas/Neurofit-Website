/**
 * Push-up metric taxonomy. PURE module, no dependencies beyond shared squat types (so
 * pushup/config.ts can import it without a cycle).
 * ----------------------------------------------------------------------------
 * Mirrors squat/metrics.ts: every metric is tagged with the plane it is observable in, and a
 * check only runs when the set's orientation can see it. "not-checked" (wrong view) stays
 * DISTINCT from "ok" (checked and passed).
 *
 * Context-only signals (head drop, hand offset, hand width, knee-variant check) are NOT
 * metrics here on purpose: they never warn and never assert a fault, so they don't belong in
 * the live FORM CHECKS panel or the report cards. They travel only as raw context in the
 * post-set payload (see pushup/payload.ts).
 */
import type { CheckStatus, MetricTier, Orientation, Severity } from "../squat/metrics";

export type { CheckStatus, MetricTier, Orientation, Severity };

export type PushupMetricId =
  // sagittal plane — side-facing sets only
  | "depth"
  | "bodyLine"
  // agnostic — tracked from both views
  | "lockout"
  | "eccentricControl"
  | "velocity"
  | "repCount"
  // frontal plane — front-facing sets only
  | "elbowFlare"
  | "shoulderLevel";

export interface PushupMetricSpec {
  id: PushupMetricId;
  label: string;
  plane: "sagittal" | "frontal" | "agnostic";
  appliesTo: Orientation | "agnostic";
  tier: MetricTier;
}

export const PUSHUP_METRICS: Record<PushupMetricId, PushupMetricSpec> = {
  depth: { id: "depth", label: "Depth", plane: "sagittal", appliesTo: "side", tier: "postset" },
  bodyLine: { id: "bodyLine", label: "Body line (sag / pike)", plane: "sagittal", appliesTo: "side", tier: "midset" },
  lockout: { id: "lockout", label: "Lockout", plane: "agnostic", appliesTo: "agnostic", tier: "postset" },
  eccentricControl: { id: "eccentricControl", label: "Descent control", plane: "agnostic", appliesTo: "agnostic", tier: "midset" },
  velocity: { id: "velocity", label: "Velocity / tempo", plane: "agnostic", appliesTo: "agnostic", tier: "context" },
  repCount: { id: "repCount", label: "Rep counting", plane: "agnostic", appliesTo: "agnostic", tier: "context" },
  elbowFlare: { id: "elbowFlare", label: "Elbow flare", plane: "frontal", appliesTo: "front", tier: "midset" },
  shoulderLevel: { id: "shoulderLevel", label: "Left/right evenness", plane: "frontal", appliesTo: "front", tier: "postset" },
};

/** Stable display/iteration order. */
export const PUSHUP_METRIC_ORDER: PushupMetricId[] = [
  "repCount",
  "depth",
  "lockout",
  "bodyLine",
  "eccentricControl",
  "velocity",
  "elbowFlare",
  "shoulderLevel",
];

export interface PushupMetricResult {
  metric: PushupMetricId;
  status: CheckStatus;
  severity: Severity;
  message: string;
  value: number | null;
}

export type PushupRepMetrics = Record<PushupMetricId, PushupMetricResult>;
