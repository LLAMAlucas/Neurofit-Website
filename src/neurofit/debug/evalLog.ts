/**
 * DEV-ONLY workout evaluation logger.
 * ----------------------------------------------------------------------------
 * Captures everything needed to AUDIT a scripted test session after the fact —
 * both the TRIGGER layer (did the right triggers fire given the metrics?) and the
 * GEMINI layer (was the coaching good given its context?). It is DESCRIPTIVE ONLY:
 * it records what happened and what each trigger was checked against; it never
 * judges whether anything was correct. That judgment is the human reviewer's job.
 *
 * Design mirrors debug/shoulderHipLog.ts: a browser app can't stream to disk, so
 * records buffer in memory and export as timestamped downloads (JSON for precise
 * checking + Markdown for reading). Gated by DEV_EVAL_LOG — inert in production and
 * every entry point early-returns, so the call sites can stay in place.
 *
 * Data sources (all pre-existing — this module only READS/formats, never recomputes
 * form geometry): per-rep scalars + fired flags from useWorkout.onRepComplete, and
 * per-call Gemini telemetry from ai/gemini.ts (payload, frames, response, latency,
 * surfaced/suppressed, rate-limit skips).
 */
import { GEMINI, SQUAT, TRIGGERS, DEPTH_PRESETS, type SquatMode } from "../squat/config";
import type { MetricId, Orientation } from "../squat/metrics";
import type { RepMetrics } from "../squat/checks";
import type { LandmarkSample, TriggerTag } from "../ai/frameBuffer";
import type { GeminiCallObservation } from "../ai/gemini";

/** MASTER TOGGLE — on in `vite dev`; force on elsewhere with VITE_EVAL_LOG=1.
 *  Guarded so importing this module under plain Node (the esbuild unit tests, where
 *  `import.meta.env` is undefined) doesn't throw — it just reads as off there. */
const ENV = (import.meta as { env?: Record<string, unknown> }).env;
export const DEV_EVAL_LOG: boolean = ENV?.DEV === true || ENV?.VITE_EVAL_LOG === "1";

/** How close (fraction of threshold) a non-firing eligible trigger must be to
 *  count as a "near miss" — near-miss reps keep their landmarks + frames. */
const NEAR_MISS_FRAC = 0.15;

type Dir = "above" | "below";

// ---------------------------------------------------------------------------
// Record shapes (also the exported JSON shape).
// ---------------------------------------------------------------------------

export interface TriggerEntry {
  /** Stable id, e.g. "T1_forward_lean". */
  id: string;
  tier: "midset" | "postset" | "context";
  /** Was this trigger even applicable this rep (right view + past warm-up)? */
  eligible: boolean;
  measured: number | null;
  baseline: number | null;
  threshold: number | null;
  /** Which side of `threshold` is a fault ("above" = larger is worse). */
  direction: Dir | null;
  /** Did it actually fire (runtime truth where available, else measured-vs-threshold)? */
  fired: boolean;
  /** Eligible + not fired + within NEAR_MISS_FRAC of the threshold. */
  near_miss: boolean;
  /** Sub-signals for compound triggers (T2 eccentric: descent spike + bounce). */
  sub_signals?: { name: string; measured: number | null; threshold: number | null; direction: Dir; fired: boolean }[];
  note?: string;
}

export interface RepEvalRecord {
  set: number;
  rep: number;
  view: Orientation;
  baseline_rep: boolean;
  scored_rep: boolean;
  /** Ground-truth reference, pre-filled from the test script (editable). */
  intended_fault: string;
  counted: boolean;
  phase_timestamps: {
    descent_start_ms: number;
    bottom_ms: number;
    ascent_end_ms: number;
    eccentric_ms: number;
    concentric_ms: number;
  };
  /** Every raw value the trigger layer read this rep — logged even below threshold. */
  measured: Record<string, number | null>;
  /** The per-user baselines in effect for this set (paired into triggers too). */
  baselines: { trunk_angle_deg: number | null; descent_velocity: number | null; lateral_shift: number | null; visibility: number | null };
  /** Did this rep pass the depth-past-target gate to CALIBRATE the baselines? false =
   *  settle/hinge/cut-short, excluded (still counts). Makes baseline poisoning visible. */
  fed_baseline: boolean;
  triggers: TriggerEntry[];
  tracking_quality: { degraded: boolean; min_visibility: number | null; unreliable: boolean };
  flagged: boolean;
  /** Raw landmark window — kept only for flagged reps (else an explicit omit note). */
  landmarks: LandmarkSample[] | { omitted: true; reason: string } | { MISSING: true; reason: string };
  /** Frame refs (base64) — kept only for flagged reps (else an explicit omit note). */
  frames:
    | { timestampMs: number; repPhase: string; triggerTags: TriggerTag[]; jpegBase64: string }[]
    | { omitted: true; reason: string }
    | { MISSING: true; reason: string };
  /** Expected-but-absent fields flagged by the export self-validation pass. */
  missing?: string[];
}

export interface GeminiCallLog {
  tier: "mid_set" | "post_set" | "post_workout" | "deep_analysis";
  timestampMs: number;
  set: number | null;
  rep: number | null;
  /** Exact JSON payload sent (measured + causal_flags are already separate objects). */
  payload: unknown;
  frames_sent: { count: number; timestamps: number[] };
  /** Verbatim model text, including "NO_CUE"; null on error or skip. */
  response_raw: string | null;
  /** Mid-set: was the cue surfaced to the user or suppressed (NO_CUE / skip / error)? */
  surfaced: boolean;
  /** Wall-clock ms from the trigger firing to the cue landing (latency is its own axis). */
  latency_ms: number | null;
  skipped: boolean;
  skip_reason: string | null;
  error: string | null;
  /** Mid-set NO_CUE only: the model judged the fired trigger a FALSE POSITIVE and
   *  vetoed the cue. Observability only — suppression behavior is unchanged; this
   *  mirrors the exact condition callMidSet already uses. null for every other
   *  outcome/tier. Grep to measure veto rate per fault type. `overriding_value` is
   *  the severity_ratio the trigger was overriding when the model rejected it. */
  model_rejected: { trigger_type: string | null; overriding_value: number | null } | null;
  /** candidates[0].finishReason: "STOP" on a clean finish; "MAX_TOKENS" (or any other
   *  value) flags a truncated response the app did NOT surface as complete. null on
   *  skip/HTTP-error (no candidate returned). */
  finish_reason: string | null;
  /** usageMetadata token counts (thoughts_tokens = thinking tokens). null when absent. */
  prompt_tokens: number | null;
  candidates_tokens: number | null;
  thoughts_tokens: number | null;
}

// ---------------------------------------------------------------------------
// Module state (single audit session).
// ---------------------------------------------------------------------------

interface SessionMeta {
  startedAtMs: number;
  mode: SquatMode | null;
  depthPreset: string | null;
  model: string | null;
  geminiEnabled: boolean;
  /** Snapshot of the thresholds in effect, so the log is self-describing. */
  thresholds: Record<string, unknown>;
}

let session: SessionMeta | null = null;
let reps: RepEvalRecord[] = [];
let geminiCalls: GeminiCallLog[] = [];
let sessionStamp = "";
/**
 * Ground truth for the CURRENT scripted eval protocol (v2 — 2026-07-25), keyed `set:rep`.
 * Pre-loaded so a scripted run is self-describing without anyone pasting into a console;
 * `window.__neurofitEval.setScript` still merges on top for ad-hoc runs.
 * DESCRIPTIVE ONLY — like the rest of this module it labels the export and never touches
 * logic. Replace (or set to `{}`) when the protocol changes.
 */
const SCRIPT_PROTOCOL_V2: Record<string, string> = {
  // Faults are performed THROUGHOUT the rep, not only at the bottom — that is what a real
  // lifter does, and it is what the 2026-07-31 run actually captured. The depth gates were
  // widened to match (T1 0.5→0.3, T7 0.3→0.15) after that run showed the worst knee cave
  // occurred during the ASCENT, outside the old window.
  // S1 side — force the fault-frame archive: T1 must fire twice at different severities, plus
  // both T2 sub-signals (rep 4 = descent spike, rep 7 = the bounce that has never once fired).
  "1:1": "baseline deep+slow", "1:2": "baseline deep+slow", "1:3": "normal",
  "1:4": "FAST DROP (T2 spike)", "1:5": "moderate lean THROUGHOUT (T1)", "1:6": "MAX lean THROUGHOUT (T1)",
  "1:7": "BOUNCE hard out of the bottom (T2 bounce — reach full depth)",
  // S2 front — valgus calibration at constant stance.
  "2:1": "baseline clean knees-out", "2:2": "baseline clean knees-out", "2:3": "normal",
  "2:4": "moderate cave THROUGHOUT", "2:5": "normal", "2:6": "MAX cave THROUGHOUT",
  // S3 side — baseline-starvation control. Reps 1-2 must stop VISIBLY ABOVE parallel (gap
  // < 0.03): last run they measured 0.032/0.036, cleared the hygiene gate by thousandths, and
  // the control never executed. Rep 5's hard lean should then NOT fire (no valid baseline).
  "3:1": "baseline ABOVE parallel (hip visibly high)", "3:2": "baseline ABOVE parallel (hip visibly high)",
  "3:3": "normal", "3:4": "normal", "3:5": "hard lean (EXPECT MISSED)", "3:6": "normal",
  // S4 front — T11 shift held through the rep + an uncounted rep.
  "4:1": "baseline clean", "4:2": "baseline clean", "4:3": "normal",
  "4:4": "hip shift THROUGHOUT", "4:5": "BIGGER hip shift THROUGHOUT", "4:6": "deliberately shallow",
  // S5 side — clean set; ends the workout (no post-set by design).
  "5:1": "normal", "5:2": "normal", "5:3": "normal", "5:4": "normal", "5:5": "normal", "5:6": "normal",
};

/** Ground-truth `intended_fault` per rep, pre-filled from the test script. */
const scriptMap: Record<string, string> = { ...SCRIPT_PROTOCOL_V2 };

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function thresholdSnapshot(): Record<string, unknown> {
  return {
    baselineReps: TRIGGERS.baselineReps,
    persistMs: TRIGGERS.persistMs,
    lean_baselineDeltaDeg: TRIGGERS.lean.baselineDeltaDeg,
    lean_depthGate: TRIGGERS.lean.depthGate,
    eccentric_descentSpikeMult: TRIGGERS.eccentric.descentSpikeMult,
    eccentric_bounceMaxMs: TRIGGERS.eccentric.bounceMaxMs,
    valgus_ratioWarn: SQUAT.valgusRatioWarn,
    valgus_depthGate: TRIGGERS.valgus.depthGate,
    symmetry_warn: TRIGGERS.symmetry.warn,
    lateralShift_warn: TRIGGERS.lateralShift.warn,
    levelness_warnDeg: SQUAT.levelnessWarnDeg,
    velocityCollapse_ofBaseline: TRIGGERS.velocityCollapse.ofBaseline,
    depth_presets: Object.fromEntries(Object.values(DEPTH_PRESETS).map((p) => [p.id, p.targetGap])),
    front_ratio_targets: { ...SQUAT.frontRatioTarget }, // UNVALIDATED — front-view depth counting floors
    gemini_thinking: GEMINI.thinking,
  };
}

/** Begin (or restart) an audit session. Clears prior records. */
export function startSession(meta: { mode: SquatMode; depthPreset: string; model: string; geminiEnabled: boolean }): void {
  if (!DEV_EVAL_LOG) return;
  session = { startedAtMs: Date.now(), ...meta, thresholds: thresholdSnapshot() };
  reps = [];
  geminiCalls = [];
  sessionStamp = stamp();
}

/** Pre-fill / correct the ground-truth intended fault for a rep (test script). */
export function setIntendedFault(set: number, rep: number, intended: string): void {
  scriptMap[`${set}:${rep}`] = intended;
}

// ---------------------------------------------------------------------------
// Per-rep capture.
// ---------------------------------------------------------------------------

export interface RepEvalInputs {
  set: number;
  rep: number;
  view: Orientation;
  counted: boolean;
  phase: { descentStartMs: number; bottomMs: number; ascentEndMs: number; eccentricMs: number; concentricMs: number };

  // Raw measured scalars (logged even when below threshold / null).
  peakTrunkAngleDeg: number | null;
  bottomTrunkAngleDeg: number | null;
  leanBaselineDeg: number | null;
  descentSpeed: number | null;
  descentBaseline: number | null;
  reversalMs: number | null;
  ascentVelocity: number | null;
  velocityRatio: number | null;
  velocityCollapsed: boolean;
  depthRatio: number;
  depthGap: number | null;
  targetGap: number;
  /** Per-preset front-view depth COUNTING target (depthRatio basis). The front rep
   *  counts when depthRatio >= this. Logged so the UNVALIDATED estimates can be
   *  correlated against real footage later. */
  frontRatioTarget: number;
  valgusRatio: number | null;
  leftKneeDev: number | null;
  rightKneeDev: number | null;
  kneeSymmetry: number | null;
  hipShift: number | null;
  levelnessDiff: number | null;
  shinAngleDeg: number | null;
  stanceWidthRatio: number | null;
  footAngleDeg: number | null;
  earlyLeanOnset: boolean;
  leanConcentratedDeep: boolean;

  // Runtime fired-truth.
  firedMidSet: MetricId[];
  eccentricFired: boolean;
  eccentricSubCount: number | null;
  mode: SquatMode;
  /** T11 lateral-shift runtime fired-truth + the per-set baseline it was judged against
   *  (baseline-relative + scored, decided in useWorkout — mirrors T1's leanBaselineDeg).
   *  T10 knee-symmetry has none — it's demoted to context-only (anti-correlated metric). */
  shiftTriggered: boolean;
  shiftBaseline: number | null;

  // Tracking + full metrics (for self-validation) + flagged-rep payloads.
  minVisibility: number | null;
  trackingDegraded: boolean;
  /** Tier-2 co-degradation flag (near-side vis collapse OR a physically-impossible field).
   *  Descriptive here — the actual context-nulling happens in useWorkout's payload build. */
  landmarkUnreliable: boolean;
  /** Baseline hygiene: did this rep pass the depth-past-target gate to feed the per-set
   *  baselines? (false = settle/hinge/cut-short — excluded from calibration, still counts.) */
  fedBaseline: boolean;
  /** Near-side visibility baseline in effect for this rep (post-gate). */
  visBaseline: number | null;
  metrics: RepMetrics;
  landmarks: LandmarkSample[];
  frames: { timestampMs: number; repPhase: string; triggerTags: TriggerTag[]; jpegBase64: string }[];
}

/** True on the wrong side of `threshold`, per `direction`. */
function beyond(measured: number | null, threshold: number | null, dir: Dir): boolean {
  if (measured === null || threshold === null) return false;
  return dir === "above" ? measured >= threshold : measured <= threshold;
}

/** Eligible + not fired but within NEAR_MISS_FRAC of the threshold. */
function nearMiss(measured: number | null, threshold: number | null, dir: Dir, fired: boolean): boolean {
  if (fired || measured === null || threshold === null) return false;
  return dir === "above"
    ? measured >= threshold * (1 - NEAR_MISS_FRAC)
    : measured <= threshold * (1 + NEAR_MISS_FRAC);
}

/** Build the per-rep trigger table (pure — exported for unit testing). `scored`
 *  is `rep > TRIGGERS.baselineReps` (warm-up reps have no eligible triggers). */
export function buildTriggerTable(i: RepEvalInputs, scored: boolean): TriggerEntry[] {
  const out: TriggerEntry[] = [];

  // T1 forward lean (mid-set, side) — baseline-relative past the depth gate.
  {
    const eligible = i.view === "side" && scored;
    const threshold = i.leanBaselineDeg !== null ? i.leanBaselineDeg + TRIGGERS.lean.baselineDeltaDeg : null;
    const fired = i.firedMidSet.includes("forwardLean");
    out.push({
      id: "T1_forward_lean",
      tier: "midset",
      eligible,
      measured: i.peakTrunkAngleDeg,
      baseline: i.leanBaselineDeg,
      threshold,
      direction: "above",
      fired,
      near_miss: eligible && nearMiss(i.peakTrunkAngleDeg, threshold, "above", fired),
      note: `checked past depth_ratio ${TRIGGERS.lean.depthGate}; peak deep-lean vs baseline+${TRIGGERS.lean.baselineDeltaDeg}°`,
    });
  }

  // T2 eccentric control (mid-set, agnostic) — descent spike and/or bottom bounce.
  {
    const eligible = scored;
    const spikeThreshold = i.descentBaseline !== null ? i.descentBaseline * TRIGGERS.eccentric.descentSpikeMult : null;
    const spikeFired = beyond(i.descentSpeed, spikeThreshold, "above");
    const bounceFired = beyond(i.reversalMs, TRIGGERS.eccentric.bounceMaxMs, "below");
    out.push({
      id: "T2_eccentric_control",
      tier: "midset",
      eligible,
      measured: i.descentSpeed,
      baseline: i.descentBaseline,
      threshold: spikeThreshold,
      direction: "above",
      fired: i.eccentricFired,
      near_miss: eligible && !i.eccentricFired && (nearMiss(i.descentSpeed, spikeThreshold, "above", false) || nearMiss(i.reversalMs, TRIGGERS.eccentric.bounceMaxMs, "below", false)),
      sub_signals: [
        { name: "descent_spike", measured: i.descentSpeed, threshold: spikeThreshold, direction: "above", fired: spikeFired },
        { name: "bottom_bounce", measured: i.reversalMs, threshold: TRIGGERS.eccentric.bounceMaxMs, direction: "below", fired: bounceFired },
      ],
      note: "sub-signal count (0/1/2) drives severity; fired = descent-baseline established + spike and/or bounce",
    });
  }

  // T7 knee valgus (mid-set, front) — knee/ankle ratio past the depth gate.
  {
    const eligible = i.view === "front" && scored;
    const fired = i.firedMidSet.includes("kneeValgus");
    out.push({
      id: "T7_knee_valgus",
      tier: "midset",
      eligible,
      measured: i.valgusRatio,
      baseline: null,
      threshold: SQUAT.valgusRatioWarn,
      direction: "below",
      fired,
      near_miss: eligible && nearMiss(i.valgusRatio, SQUAT.valgusRatioWarn, "below", fired),
      note: `checked past depth_ratio ${TRIGGERS.valgus.depthGate}; knee_width/ankle_width`,
    });
  }

  // T6 velocity collapse (CONTEXT ONLY — never fires its own cue).
  {
    const eligible = scored;
    out.push({
      id: "T6_velocity_collapse",
      tier: "context",
      eligible,
      measured: i.velocityRatio,
      baseline: 1,
      threshold: TRIGGERS.velocityCollapse.ofBaseline,
      direction: "below",
      fired: false,
      near_miss: false,
      note: `context only; velocity_ratio_vs_baseline; collapsed=${i.velocityCollapsed}`,
    });
  }

  // Depth gate (side counting) — hip-vs-knee gap vs the active preset target.
  {
    const eligible = i.view === "side";
    const miss = eligible && !i.counted;
    out.push({
      id: "depth_gate",
      tier: "postset",
      eligible,
      measured: i.depthGap,
      baseline: null,
      threshold: i.targetGap,
      direction: "above",
      fired: miss, // "fired" here = a depth MISS (side only)
      near_miss: eligible && nearMiss(i.depthGap, i.targetGap, "above", !miss),
      note: `side rep counts when gap >= targetGap; counted=${i.counted}`,
    });
  }

  // Front depth gate (FRONT counting) — distance-invariant depthRatio vs the per-preset
  // front target. Mirrors the side depth_gate row; this is the ONLY validation path for
  // the UNVALIDATED frontRatioTarget estimates. "fired" = a front rep that did NOT count.
  {
    const eligible = i.view === "front";
    const miss = eligible && !i.counted;
    out.push({
      id: "front_depth_gate",
      tier: "postset",
      eligible,
      measured: i.depthRatio,
      baseline: null,
      threshold: i.frontRatioTarget,
      direction: "above",
      fired: miss, // "fired" here = a front depth MISS (front only)
      near_miss: eligible && nearMiss(i.depthRatio, i.frontRatioTarget, "above", !miss),
      note: `front rep counts when depthRatio >= frontRatioTarget (UNVALIDATED); counted=${i.counted}`,
    });
  }

  // T10 knee symmetry — DEMOTED to context-only. The n=2 body test showed this metric is
  // anti-correlated with knee cave (reads LOWER on genuine caves, fired on wide-tracking
  // reps) — structurally broken, not baseline-fixable; T7 valgus is the real cave detector.
  // Non-firing context row: measured value stays visible, never eligible/fired/near-miss.
  {
    out.push({
      id: "T10_knee_symmetry",
      tier: "context",
      eligible: false,
      measured: i.kneeSymmetry,
      baseline: null,
      threshold: TRIGGERS.symmetry.warn,
      direction: "above",
      fired: false,
      near_miss: false,
      note: "context-only (demoted, anti-correlated with knee cave): |left_dev - right_dev|/hip_width",
    });
  }

  // T11 lateral trunk shift (post-set, front) — baseline-relative + scored (mirrors T1 lean).
  {
    const eligible = i.view === "front" && scored;
    const threshold = i.shiftBaseline !== null ? i.shiftBaseline + TRIGGERS.lateralShift.baselineDeltaRatio : null;
    const fired = i.shiftTriggered;
    out.push({
      id: "T11_lateral_shift",
      tier: "postset",
      eligible,
      measured: i.hipShift,
      baseline: i.shiftBaseline,
      threshold,
      direction: "above",
      fired,
      near_miss: eligible && nearMiss(i.hipShift, threshold, "above", fired),
      note: `baseline-relative: |hip_mid_x - ankle_mid_x|/hip_width vs baseline+${TRIGGERS.lateralShift.baselineDeltaRatio}`,
    });
  }

  // Shoulder/hip levelness — DEMOTED to context-only (aspect-distorted normalized-space
  // proxy that fired on jitter against the 8° gate). Kept as a non-firing context row so
  // the measured value stays visible in the audit; never eligible, never fired, never a
  // near-miss/false-negative. Raw value is also in the per-rep metrics dump.
  {
    out.push({
      id: "shoulder_hip_levelness",
      tier: "context",
      eligible: false,
      measured: i.levelnessDiff,
      baseline: null,
      threshold: SQUAT.levelnessWarnDeg,
      direction: "above",
      fired: false,
      near_miss: false,
      note: "context-only (demoted): shoulder-line vs hip-line tilt differential (deg)",
    });
  }

  // Butt wink (post-set, side) — loaded early-onset trigger / bodyweight context.
  {
    const eligible = i.view === "side";
    const fired = i.mode === "loaded" && i.earlyLeanOnset;
    out.push({
      id: "butt_wink",
      tier: "postset",
      eligible,
      measured: null,
      baseline: null,
      threshold: null,
      direction: null,
      fired,
      near_miss: false,
      note: `not directly measured; earlyLeanOnset=${i.earlyLeanOnset}, leanConcentratedDeep=${i.leanConcentratedDeep}, mode=${i.mode}`,
    });
  }

  return out;
}

/** Assemble and store one rep's evaluation record. */
export function logRep(i: RepEvalInputs): void {
  if (!DEV_EVAL_LOG) return;
  const scored = i.rep > TRIGGERS.baselineReps;
  const triggers = buildTriggerTable(i, scored);
  const flagged = triggers.some((t) => t.eligible && (t.fired || t.near_miss));

  const measured: Record<string, number | null> = {
    peak_trunk_angle_deg: i.peakTrunkAngleDeg,
    bottom_trunk_angle_deg: i.bottomTrunkAngleDeg,
    seg_len_ratio: null, // demoted to the shoulderHip debug CSV — not in the live pipeline
    descent_velocity: i.descentSpeed,
    ascent_velocity: i.ascentVelocity,
    reversal_ms: i.reversalMs,
    depth_ratio: i.depthRatio,
    depth_gap: i.depthGap,
    velocity_ratio_vs_baseline: i.velocityRatio,
    valgus_ratio: i.valgusRatio,
    left_knee_x_minus_ankle_x: i.leftKneeDev,
    right_knee_x_minus_ankle_x: i.rightKneeDev,
    knee_symmetry: i.kneeSymmetry,
    hip_lateral_drift: i.hipShift,
    shoulder_hip_tilt_diff_deg: i.levelnessDiff,
    shin_angle_deg: i.shinAngleDeg,
    stance_width_ratio: i.stanceWidthRatio,
    foot_angle_deg: i.footAngleDeg,
  };

  // Landmarks + frames only for flagged reps (fired OR near-miss) to bound file size.
  const landmarks: RepEvalRecord["landmarks"] = flagged
    ? i.landmarks.length
      ? i.landmarks
      : { MISSING: true, reason: "flagged rep but landmark buffer window was empty (evicted / occluded)" }
    : { omitted: true, reason: "clean rep — landmarks omitted to keep file size down" };
  const frames: RepEvalRecord["frames"] = flagged
    ? i.frames.length
      ? i.frames
      : { MISSING: true, reason: "flagged rep but no buffered frames for this rep (ring evicted)" }
    : { omitted: true, reason: "clean rep — frames omitted to keep file size down" };

  reps.push({
    set: i.set,
    rep: i.rep,
    view: i.view,
    baseline_rep: !scored,
    scored_rep: scored,
    intended_fault: scriptMap[`${i.set}:${i.rep}`] ?? "UNSET",
    counted: i.counted,
    phase_timestamps: {
      descent_start_ms: Math.round(i.phase.descentStartMs),
      bottom_ms: Math.round(i.phase.bottomMs),
      ascent_end_ms: Math.round(i.phase.ascentEndMs),
      eccentric_ms: Math.round(i.phase.eccentricMs),
      concentric_ms: Math.round(i.phase.concentricMs),
    },
    measured,
    baselines: { trunk_angle_deg: i.leanBaselineDeg, descent_velocity: i.descentBaseline, lateral_shift: i.shiftBaseline, visibility: i.visBaseline },
    fed_baseline: i.fedBaseline,
    triggers,
    tracking_quality: { degraded: i.trackingDegraded, min_visibility: i.minVisibility, unreliable: i.landmarkUnreliable },
    flagged,
    landmarks,
    frames,
  });
}

/** Map + store one Gemini call observation from ai/gemini's `setGeminiCallObserver`.
 *  set/rep are recovered from the payload (mid-set: rep_context; post-set: set_summary). */
export function logGeminiObservation(obs: GeminiCallObservation): void {
  if (!DEV_EVAL_LOG) return;
  const p = obs.payload as {
    rep_context?: { set_number?: number; rep_number?: number };
    set_summary?: { set_number?: number };
    trigger?: { type?: string; severity_ratio?: number };
  } | null;
  // NO_CUE = the model vetoed this mid-set trigger as a false positive. Detect it
  // with the SAME condition callMidSet uses to suppress (responseText === "NO_CUE"),
  // so this is a pure mirror — not a new decision. Distinct from an empty response
  // (responseText null) and from skip/error.
  const rejected = obs.tier === "mid_set" && obs.responseText === "NO_CUE";
  geminiCalls.push({
    tier: obs.tier,
    timestampMs: obs.timestampMs,
    set: p?.rep_context?.set_number ?? p?.set_summary?.set_number ?? null,
    rep: p?.rep_context?.rep_number ?? null,
    payload: obs.payload,
    frames_sent: obs.frames,
    response_raw: obs.responseText,
    surfaced: obs.outcome === "response",
    latency_ms: obs.latencyMs ?? null,
    // Any locally short-circuited attempt counts as skipped — nothing was sent.
    skipped: obs.outcome === "skipped_rate_limit" || obs.outcome === "skipped_quota",
    skip_reason:
      obs.outcome === "skipped_rate_limit" ? "rate_limit_min_interval" : obs.outcome === "skipped_quota" ? "usage_quota_exhausted" : null,
    error: obs.outcome === "error" ? obs.errorMessage ?? "error" : null,
    model_rejected: rejected ? { trigger_type: p?.trigger?.type ?? null, overriding_value: p?.trigger?.severity_ratio ?? null } : null,
    finish_reason: obs.finishReason ?? null,
    prompt_tokens: obs.usage?.promptTokenCount ?? null,
    candidates_tokens: obs.usage?.candidatesTokenCount ?? null,
    thoughts_tokens: obs.usage?.thoughtsTokenCount ?? null,
  });
}

// ---------------------------------------------------------------------------
// Self-validation: flag expected-but-absent fields inline rather than dropping.
// ---------------------------------------------------------------------------

function validate(): { rep_issues: number; gemini_issues: number } {
  let repIssues = 0;
  let geminiIssues = 0;

  for (const r of reps) {
    const missing: string[] = [];
    // A scored rep should have SOME measured signal for its view.
    if (r.scored_rep) {
      const viewKeys =
        r.view === "side"
          ? ["peak_trunk_angle_deg", "depth_gap", "descent_velocity"]
          : ["valgus_ratio", "knee_symmetry", "hip_lateral_drift"];
      if (viewKeys.every((k) => r.measured[k] === null || r.measured[k] === undefined)) {
        missing.push("measured (all view metrics null — check tracking_quality)");
      }
      // A fired trigger with no measured value is suspicious (may be a real gap).
      for (const t of r.triggers) {
        if (t.fired && t.measured === null && t.id !== "butt_wink") missing.push(`trigger.${t.id}.measured`);
      }
    }
    if (missing.length) {
      r.missing = missing;
      repIssues += missing.length;
    }
  }

  for (const g of geminiCalls) {
    // A call that actually went out (not skipped) must carry its payload + outcome.
    if (!g.skipped) {
      if (g.payload === null || g.payload === undefined) {
        (g as unknown as Record<string, unknown>).payload = { MISSING: true };
        geminiIssues++;
      }
      if (g.response_raw === null && g.error === null) {
        g.error = "MISSING: no response and no error recorded";
        geminiIssues++;
      }
    }
  }

  return { rep_issues: repIssues, gemini_issues: geminiIssues };
}

// ---------------------------------------------------------------------------
// Serialization.
// ---------------------------------------------------------------------------

function toJson(validation: ReturnType<typeof validate>): string {
  return JSON.stringify(
    {
      _note: "Neuro-Fit DEV evaluation log — descriptive only (records what happened; does not judge correctness).",
      session,
      validation,
      reps,
      gemini_calls: geminiCalls,
    },
    null,
    2,
  );
}

function f(v: number | null | undefined, dp = 2): string {
  return v === null || v === undefined ? "null" : v.toFixed(dp);
}

function firedMark(t: TriggerEntry): string {
  if (!t.eligible) return "n/a";
  if (t.fired) return "FIRED";
  return t.near_miss ? "near-miss" : "no";
}

function repMetricsRow(r: RepEvalRecord): string {
  const key =
    r.view === "side"
      ? `trunk ${f(r.measured.peak_trunk_angle_deg, 1)}° / gap ${f(r.measured.depth_gap, 3)}`
      : `valgus ${f(r.measured.valgus_ratio, 2)} / sym ${f(r.measured.knee_symmetry, 3)}`;
  const tqBase = r.tracking_quality.degraded ? `DEGRADED(${f(r.tracking_quality.min_visibility, 2)})` : `ok(${f(r.tracking_quality.min_visibility, 2)})`;
  const tq = r.tracking_quality.unreliable ? `${tqBase} UNRELIABLE` : tqBase;
  const firedIds = r.triggers.filter((t) => t.eligible && t.fired).map((t) => t.id).join(", ") || "—";
  const tqCell = r.fed_baseline ? tq : `${tq} · no-base`;
  return `| ${r.rep} | ${r.baseline_rep ? "base" : "scored"} | ${r.intended_fault} | ${r.counted ? "yes" : "NO"} | ${key} | ${firedIds} | ${tqCell} |`;
}

function triggerDetailLines(r: RepEvalRecord): string[] {
  const lines: string[] = [];
  for (const t of r.triggers) {
    if (!t.eligible) continue;
    const base = t.baseline !== null ? ` (baseline ${f(t.baseline)})` : "";
    const thr = t.threshold !== null ? ` vs ${f(t.threshold)}` : "";
    let line = `    - ${t.id}: ${f(t.measured)}${base}${thr} [${t.direction ?? "flag"}] → ${firedMark(t)}`;
    if (t.sub_signals) {
      const subs = t.sub_signals.map((s) => `${s.name} ${f(s.measured)} vs ${f(s.threshold)} ${s.fired ? "✓" : "✗"}`).join("; ");
      line += `  {${subs}}`;
    }
    lines.push(line);
  }
  return lines;
}

function geminiForSetLines(set: number): string[] {
  const midset = geminiCalls.filter((g) => g.tier === "mid_set" && g.set === set);
  if (!midset.length) return ["  _no mid-set calls_"];
  return midset.map((g) => {
    if (g.skipped) return `  - rep ${g.rep ?? "?"}: SKIPPED (${g.skip_reason})`;
    if (g.error) return `  - rep ${g.rep ?? "?"}: ERROR ${g.error}`;
    const verdict = g.surfaced ? "SURFACED" : g.model_rejected ? `VETO ${g.model_rejected.trigger_type ?? "?"}` : "suppressed";
    const resp = (g.response_raw ?? "(empty)").replace(/\s+/g, " ").trim();
    return `  - rep ${g.rep ?? "?"} [${verdict}, ${f(g.latency_ms, 0)}ms, ${g.frames_sent.count} frames]: "${resp}"`;
  });
}

function toMarkdown(validation: ReturnType<typeof validate>): string {
  const lines: string[] = [];
  lines.push("# Neuro-Fit workout evaluation log");
  lines.push("");
  lines.push("_Descriptive only — records what happened and what each trigger was checked against; does not judge correctness._");
  lines.push("");
  if (session) {
    lines.push(
      `Started ${new Date(session.startedAtMs).toISOString()} · mode **${session.mode}** · depth **${session.depthPreset}** · model **${session.model}** · gemini ${session.geminiEnabled ? "enabled" : "disabled"}`,
    );
    lines.push("");
  }
  lines.push(`Reps logged: **${reps.length}** · Gemini calls: **${geminiCalls.length}** · validation issues: **${validation.rep_issues + validation.gemini_issues}**`);
  lines.push("");

  const setNums = [...new Set(reps.map((r) => r.set))].sort((a, b) => a - b);
  for (const set of setNums) {
    const setReps = reps.filter((r) => r.set === set);
    const view = setReps[0]?.view ?? "?";
    lines.push(`## Set ${set} · ${view}`);
    lines.push("");
    lines.push("### Rep metrics");
    lines.push("| rep | phase | intended_fault | counted | key metrics (measured) | fired triggers | tracking |");
    lines.push("|----:|:------|:---------------|:-------:|:-----------------------|:---------------|:---------|");
    for (const r of setReps) lines.push(repMetricsRow(r));
    // Resolved per-set baselines (as of the last rep) — a garbage value here (e.g. lean 58°)
    // flags baseline poisoning at a glance. "no-base" reps above did NOT feed these.
    const bl = setReps[setReps.length - 1]?.baselines;
    if (bl) lines.push(`_Baselines (resolved): lean ${f(bl.trunk_angle_deg, 1)}° · descent ${f(bl.descent_velocity, 3)} · shift ${f(bl.lateral_shift, 3)} · vis ${f(bl.visibility, 2)}_`);
    lines.push("");
    lines.push("### Triggers checked (eligible; incl. did-NOT-fire)");
    for (const r of setReps) {
      const detail = triggerDetailLines(r);
      if (detail.length) {
        lines.push(`  rep ${r.rep}${r.flagged ? " *(flagged — landmarks+frames kept)*" : ""}:`);
        lines.push(...detail);
      }
    }
    lines.push("");
    lines.push("### Mid-set cues");
    lines.push(...geminiForSetLines(set));
    lines.push("");
    lines.push("### Post-set analysis");
    const postSet = geminiCalls.find((g) => g.tier === "post_set" && g.set === set);
    lines.push(postSet ? `> ${(postSet.response_raw ?? `(${postSet.skipped ? "skipped: " + postSet.skip_reason : postSet.error ?? "no text"})`).replace(/\n/g, "\n> ")}` : "> _no post-set call_");
    lines.push("");
  }

  lines.push("## Post-workout analysis");
  const pw = geminiCalls.filter((g) => g.tier === "post_workout" || g.tier === "deep_analysis");
  if (!pw.length) lines.push("> _no post-workout call_");
  for (const g of pw) {
    lines.push(`### ${g.tier}`);
    lines.push(`> ${(g.response_raw ?? `(${g.skipped ? "skipped: " + g.skip_reason : g.error ?? "no text"})`).replace(/\n/g, "\n> ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Trigger a browser download of a text blob. No-op outside the DOM. */
function download(filename: string, text: string, mime: string): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Export the buffered audit as a JSON + a Markdown file. Does NOT clear the buffer
 * (so it can be re-exported after the async post-workout analysis lands); the next
 * startSession() clears it. No-op when disabled or empty.
 */
export function downloadEvalLog(): void {
  if (!DEV_EVAL_LOG || (reps.length === 0 && geminiCalls.length === 0)) return;
  const validation = validate();
  const base = `neurofit_eval_${sessionStamp || stamp()}`;
  download(`${base}.json`, toJson(validation), "application/json");
  download(`${base}.md`, toMarkdown(validation), "text/markdown");
  // eslint-disable-next-line no-console
  console.info(`[eval] exported ${reps.length} reps + ${geminiCalls.length} Gemini calls (${validation.rep_issues + validation.gemini_issues} validation flags).`);
}

/** True once there's anything worth exporting (drives the dev download button). */
export function hasEvalData(): boolean {
  return DEV_EVAL_LOG && (reps.length > 0 || geminiCalls.length > 0);
}

// Expose manual controls while logging is on (matches shoulderHipLog's pattern).
if (DEV_EVAL_LOG && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__neurofitEval = {
    download: downloadEvalLog,
    setIntended: setIntendedFault,
    /** Bulk pre-fill: { "1:3": "right knee valgus", "2:1": "normal", ... }. */
    setScript: (map: Record<string, string>) => Object.assign(scriptMap, map),
    dump: () => ({ session, reps, geminiCalls }),
  };
  // eslint-disable-next-line no-console
  console.info(
    "[eval] DEV evaluation logging ON — finish a workout then click 'Download eval log' (or call window.__neurofitEval.download()). Pre-fill ground truth with window.__neurofitEval.setScript({'1:3':'fast descent'}).",
  );
}
