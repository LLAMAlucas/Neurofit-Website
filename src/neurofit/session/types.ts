/**
 * Session data model for alternating-orientation workouts. PURE module.
 * ----------------------------------------------------------------------------
 * A workout is an ordered list of SETS, each filmed in one orientation. Every
 * rep's fault data is scoped to its set's orientation and never merged or
 * averaged across orientations (per spec §4). The post-workout synthesis
 * (synthesis.ts) reads this structure.
 */
import type { MetricId, Orientation } from "../squat/metrics";
import type { RepMetrics } from "../squat/checks";
import type { VelocitySample } from "../squat/velocity";

/** The exercise a workout session is for. Squat records use the types below; push-up and pull-up
 *  records live in pushup/session.ts (PushupSetRecord) and pullup/session.ts (PullupSetRecord). */
export type ExerciseId = "squat" | "pushup" | "pullup";

/** Which trigger requested an AI coaching call for a rep (spec §2 & §3). */
export type TriggerKind = "velocity" | "fault_spike";

/** The AI coaching response stored against the rep that triggered it (spec §4). */
export interface RepCoaching {
  /** Trigger(s) that fired for this rep — both when combined within the dedup window. */
  triggers: TriggerKind[];
  /** Metric ids whose severity spiked to critical and drove the call (if any). */
  faultChecks: MetricId[];
  /** The AI's single, specific, actionable cue (≤2 sentences). */
  cue: string;
}

export interface RepRecord {
  /** Rep number within its set (1-based). */
  index: number;
  /** Full orientation-gated metric verdicts for this rep. */
  metrics: RepMetrics;
  velocity: VelocitySample | null;
  bottomKneeAngle: number;
  /**
   * Did this attempt COUNT as a rep? Side sets: reached the depth target. Front
   * sets: passed the front movement floor. Attempts that don't count are still
   * recorded (for the per-set depth ratio in the report) with counted = false.
   */
  counted: boolean;
  /**
   * Bottom-of-rep hip-displacement depth ratio (0..~1). Persisted so an uncounted
   * (depth-failed) rep can carry its measured depth into the post-set / post-workout
   * coaching payload. Purely descriptive — does not affect counting (`counted`),
   * the depth gate, or the on-screen "not counted" flash.
   */
  depthRatio: number | null;
  /**
   * Bottom-of-rep hip-vs-knee GAP (hipY − kneeY) — the number that actually decides counting
   * on SIDE sets, against the preset's targetGap. Persisted because `depthRatio` above is the
   * orientation-agnostic hip-displacement ratio, which on a side set is NOT the deciding
   * measure: set 3 rep 5 was uncounted at gap −0.022 while its depthRatio (0.688) was HIGHER
   * than a counted rep's (0.658). Sending the ratio as the reason a side rep failed told the
   * model its own gate was inconsistent, so the payload now sends this.
   */
  depthGap: number | null;
  /**
   * Metrics whose MID-SET TRIGGER actually fired on this rep (T1 forward lean, T7 valgus) —
   * i.e. the gated predicate held past its depth gate for the full 150 ms persistence window.
   *
   * This is deliberately NOT the same as `metrics[id].status === "warn"`, which is a worst-of
   * all-frames absolute comparison with no persistence or depth gate. The two diverge: on set
   * 2 rep 6 the metric warned at 0.523 while T7 correctly did not fire, and the post-set
   * payload — which read the metric — told Gemini a trigger had fired that the trigger layer
   * had rejected, with no archived frame behind it. Fault reporting reads THIS field.
   */
  triggeredMetrics: MetricId[];
  /**
   * T11 lateral-shift trigger flag — baseline-relative (per-set reps 1–2) and scored-only,
   * mirroring the forward-lean trigger. The absolute `hipShift` metric warn stays for the
   * metrics panel + Gemini context value; this flag is what the FAULT consumers (report
   * notes, post-workout fault_trends, eval log) read, so neutral baseline reps aren't
   * flagged off the absolute threshold. (T10 knee-symmetry has no such flag — it's demoted
   * to context-only; the metric is anti-correlated with knee cave, so it can't be a trigger.)
   */
  shiftTriggered: boolean;
  /**
   * Tier-2 landmark-reliability flag: true when this rep's tracking is untrustworthy —
   * either near-side visibility collapsed vs the per-set baseline OR a geometric field was
   * physically impossible (checks.landmarkImplausible). Flagged reps KEEP counting (a garbage
   * rep may still be a real depth miss) but have their CONTEXT metrics nulled out of the
   * post-set / post-workout payload, so a tracking failure isn't narrated as a form finding.
   */
  landmarkUnreliable: boolean;
  /** AI coaching cue triggered on this rep, if any (spec §4). */
  coaching: RepCoaching | null;
}

export interface SetRecord {
  /** Set number within the workout (1-based). */
  index: number;
  orientation: Orientation;
  /** Facing angle measured when the set locked, for the record. */
  facingAngleDeg: number | null;
  reps: RepRecord[];
}

export interface WorkoutSession {
  sets: SetRecord[];
}
