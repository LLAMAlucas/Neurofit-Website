/**
 * Pull-up metric taxonomy. PURE module, no dependencies beyond shared squat types (so
 * pullup/config.ts can import it without a cycle).
 * ----------------------------------------------------------------------------
 * Mirrors squat/ and pushup/metrics.ts: every metric is tagged with the plane it is observable in,
 * and a check only runs when the set's orientation can see it. "not-checked" (wrong view) stays
 * DISTINCT from "ok" (checked and passed).
 *
 * The two counting gates are AGNOSTIC: chin-vs-bar is a vertical relation and the arms straighten
 * visibly from either view. Swing and leg drive are fore-aft (sagittal) movements — invisible
 * head-on, where they run along the camera's depth axis. Evenness needs both shoulders (frontal).
 * Grip width is context only (never a fault), so it is not a metric here — it travels as raw
 * context in the post-set payload (see pullup/payload.ts).
 */
import type { CheckStatus, MetricTier, Orientation, Severity } from "../squat/metrics";

export type { CheckStatus, MetricTier, Orientation, Severity };

export type PullupMetricId =
  // agnostic — tracked from both views
  | "repCount"
  | "top"
  | "extension"
  // sagittal plane — side-facing sets only
  | "swing"
  | "legDrive"
  // agnostic
  | "eccentricControl"
  | "velocity"
  // frontal plane — front-facing sets only
  | "evenness";

export interface PullupMetricSpec {
  id: PullupMetricId;
  label: string;
  plane: "sagittal" | "frontal" | "agnostic";
  appliesTo: Orientation | "agnostic";
  tier: MetricTier;
}

export const PULLUP_METRICS: Record<PullupMetricId, PullupMetricSpec> = {
  repCount: { id: "repCount", label: "Rep counting", plane: "agnostic", appliesTo: "agnostic", tier: "context" },
  top: { id: "top", label: "Chin over bar", plane: "agnostic", appliesTo: "agnostic", tier: "postset" },
  extension: { id: "extension", label: "Full hang (arms straight)", plane: "agnostic", appliesTo: "agnostic", tier: "postset" },
  swing: { id: "swing", label: "Body swing (kip)", plane: "sagittal", appliesTo: "side", tier: "postset" },
  legDrive: { id: "legDrive", label: "Leg drive (kick)", plane: "sagittal", appliesTo: "side", tier: "postset" },
  eccentricControl: { id: "eccentricControl", label: "Lowering control", plane: "agnostic", appliesTo: "agnostic", tier: "postset" },
  velocity: { id: "velocity", label: "Velocity / tempo", plane: "agnostic", appliesTo: "agnostic", tier: "context" },
  evenness: { id: "evenness", label: "Left/right evenness", plane: "frontal", appliesTo: "front", tier: "postset" },
};

/** Stable display/iteration order. */
export const PULLUP_METRIC_ORDER: PullupMetricId[] = [
  "repCount",
  "top",
  "extension",
  "swing",
  "legDrive",
  "eccentricControl",
  "velocity",
  "evenness",
];

export interface PullupMetricResult {
  metric: PullupMetricId;
  status: CheckStatus;
  severity: Severity;
  message: string;
  value: number | null;
}

export type PullupRepMetrics = Record<PullupMetricId, PullupMetricResult>;
