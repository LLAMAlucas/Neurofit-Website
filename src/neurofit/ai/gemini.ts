/**
 * Gemini coaching client (browser-direct).
 * ----------------------------------------------------------------------------
 * TWO LIVE TIERS, both defined in the v2 section further down, and both fired
 * ONLY by an explicit user click (never on a timer):
 *   1. callPostSet     — the per-set debrief ("Next set"). Structured numeric
 *                        payload + a curated frame archive (baseline reps 1-2 plus
 *                        one peak-severity frame per error type).
 *   2. callPostWorkout — the end-of-session summary ("End workout"). TEXT-ONLY:
 *                        it synthesizes over the per-set debrief texts and never
 *                        receives images.
 *
 * LEGACY, NOT WIRED UP: `requestCoaching` below is the old real-time per-rep cue.
 * The mid-set tier was removed (12-34s latency on ~40s sets made cues useless), so
 * nothing calls it. It also still sends `temperature: 0.4`, which contradicts the
 * Gemini 3.x guidance in config.ts — do not use it as a template. The manual
 * `deepAnalysis` post-workout narrative was DELETED: its weaker prompt overwrote
 * the good `callPostWorkout` summary, so the report is now read-only.
 *
 * Every call attempt passes through `emitObs`, which records it to the usage
 * ledger (usage/usageStore) and gates on the rolling quota — see `quotaBlock`.
 *
 * The API key is the user's own, entered in Settings and held in localStorage on
 * their device (`getApiKey`); if absent we skip Gemini gracefully — the
 * rules-based checks keep running. The call is browser-direct (a key-holding
 * proxy is the production path) and the raw frame is sent (pose-landmarks-only
 * is a planned privacy improvement).
 */
import { METRICS, metricsForOrientation, type MetricId, type Orientation, type Severity } from "../squat/metrics";
import type { CheckStatus } from "../squat/metrics";
import type { TriggerKind } from "../session/types";
import type { RepContextV2 } from "../session/context";
import { GEMINI, SEVERITY, type ShortfallBand, type VelocityBand } from "../squat/config";
import type { ImageFrame } from "./frameBuffer";
import type { PushupPostSetData, PushupPostWorkoutData } from "../pushup/payload";
import type { PullupPostSetData, PullupPostWorkoutData } from "../pullup/payload";
import { quota, recordCall } from "../usage/usageStore";
import {
  POSTSET_SYSTEM,
  POSTWORKOUT_SYSTEM,
  PULLUP_POSTSET_SYSTEM,
  PULLUP_POSTWORKOUT_SYSTEM,
  PUSHUP_POSTSET_SYSTEM,
  PUSHUP_POSTWORKOUT_SYSTEM,
} from "./prompts";

const MODEL = import.meta.env.GEMINI_MODEL ?? import.meta.env.VITE_GEMINI_MODEL ?? "gemini-3.6-flash";
const ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// The key is the USER'S, entered in Settings and kept in localStorage on their
// own device. It is deliberately NOT read from the environment in a production
// build: the app is served from a public URL, and anything `import.meta.env`
// resolves at build time is inlined verbatim into the shipped bundle, so a key
// baked in that way is readable by every visitor. Build-time reads are fenced
// behind `import.meta.env.DEV` so the developer's own .env.local keeps working
// under `npm run dev` while being physically absent from `npm run build`
// output — Vite statically replaces DEV with false there and the branch is
// dropped by the minifier.
const API_KEY_STORAGE = "neurofit.apiKey";

const DEV_ENV_KEY: string | undefined = import.meta.env.DEV
  ? (import.meta.env.GEMINI_API_KEY ?? import.meta.env.VITE_GEMINI_API_KEY)
  : undefined;

/** The key in force right now: what the user saved, else the dev-only env key.
 *  Read fresh at every call site — a key saved in Settings must take effect
 *  without a reload, which a module-level const could never do. */
export function getApiKey(): string {
  try {
    const stored = localStorage.getItem(API_KEY_STORAGE);
    if (stored !== null && stored.trim().length > 0) return stored.trim();
  } catch {
    /* private mode / storage disabled — fall through to the dev key */
  }
  return typeof DEV_ENV_KEY === "string" ? DEV_ENV_KEY.trim() : "";
}

/** Save (or, with an empty string, clear) the user's key. */
export function setApiKey(key: string): void {
  const trimmed = key.trim();
  try {
    if (trimmed.length > 0) localStorage.setItem(API_KEY_STORAGE, trimmed);
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    /* private mode / storage disabled — the key simply won't persist */
  }
}

/** True when a key is stored rather than inherited from the dev environment.
 *  Lets Settings show "saved" state without ever echoing the key back. */
export function apiKeyIsUserSupplied(): boolean {
  try {
    const stored = localStorage.getItem(API_KEY_STORAGE);
    return stored !== null && stored.trim().length > 0;
  } catch {
    return false;
  }
}

// Runtime kill-switch (Settings toggle) so you can exercise the UI and tune the
// raw number tracking without firing any Gemini call. Persisted in localStorage
// and read fresh on every check, so flipping it takes effect immediately. This
// is the single choke point — because all three call tiers guard on
// geminiEnabled(), forcing it false here guarantees zero API calls.
const API_DISABLED_KEY = "neurofit.apiDisabled";

export function apiCallsDisabled(): boolean {
  try {
    return localStorage.getItem(API_DISABLED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setApiCallsDisabled(disabled: boolean): void {
  try {
    localStorage.setItem(API_DISABLED_KEY, disabled ? "1" : "0");
  } catch {
    /* private mode / storage disabled — the in-memory hook state still gates the UI */
  }
}

/** True only when a key exists AND the user hasn't flipped the API kill-switch. */
export function geminiEnabled(): boolean {
  return getApiKey().length > 0 && !apiCallsDisabled();
}

/** True when a key is present, regardless of the kill-switch — lets the UI say
 *  "you turned this off" instead of "no key". */
export function geminiKeyPresent(): boolean {
  return getApiKey().length > 0;
}

/** fault_type values for the structured output (full metric set + none). */
export const FAULT_TYPES = [
  "knee_valgus",
  "insufficient_depth",
  "forward_lean",
  "eccentric_control",
  "butt_wink",
  "shoulder_hip_levelness",
  "knee_symmetry",
  "lateral_shift",
  "tempo_loss",
  "none",
] as const;
export type FaultType = (typeof FAULT_TYPES)[number];

/** Map an internal MetricId to its fault_type label for prompts. */
const METRIC_TO_FAULT: Partial<Record<MetricId, FaultType>> = {
  kneeValgus: "knee_valgus",
  depth: "insufficient_depth",
  forwardLean: "forward_lean",
  eccentricControl: "eccentric_control",
  buttWink: "butt_wink",
  shoulderHipLevelness: "shoulder_hip_levelness",
  kneeSymmetry: "knee_symmetry",
  hipShift: "lateral_shift",
  velocity: "tempo_loss",
};

const METRIC_DESC: Record<MetricId, string> = {
  depth: "squat depth (hip crease reaching knee level / parallel) — a GOAL/preset gate, not a safety fault for bodyweight",
  forwardLean: "torso angle / forward lean (degrees from vertical) — a strategy marker; could be hip-driven (safe) or lumbar-driven (assess from image)",
  buttWink: "posterior pelvic tilt / lower-back rounding at the bottom (contested; matters mainly loaded + early-onset)",
  velocity: "rep tempo / bar speed (fatigue context only)",
  eccentricControl: "control of the descent — dropping under gravity or bouncing out of the bottom vs lowering with tension",
  kneeValgus: "knees caving inward vs tracking over the toes — read as a strength/motor-control signal in a squat, not acute danger",
  shoulderHipLevelness: "shoulders and hips staying level (no side dropping)",
  kneeSymmetry: "left vs right knee tracking symmetry (one side compensating)",
  hipShift: "lateral hip/trunk shift toward one side out of the bottom",
  repCount: "rep counting",
  barPath: "bar path",
};

/** One check's verdict on the triggering rep (part of the AI context). */
export interface CheckSnapshot {
  metric: MetricId;
  severity: Severity;
  status: CheckStatus;
  value: number | null;
}

export interface CoachingInput {
  /** Raw JPEG frame (base64, no data: prefix), or null to go text-only. */
  imageBase64: string | null;
  /** Trigger(s) that fired (combined when they coincide within the dedup window). */
  triggers: TriggerKind[];
  /** Checks whose severity spiked to critical (drives the fault-spike trigger). */
  faultSpikeChecks: MetricId[];
  repIndex: number;
  setIndex: number;
  orientation: Orientation;
  /** Severity + measured value of every check on the triggering rep. */
  checks: CheckSnapshot[];
  /** Velocity / fatigue context (T6 collapse is context only — never a trigger). */
  velocity: { rollingAverage: number | null; current: number | null; pctSlower: number | null; collapsed: boolean } | null;
  /** v2 Part 4 causal/cross-metric context — the "companion" layer. */
  context?: RepContextV2 | null;
}

export interface Coaching {
  faultType: FaultType;
  cue: string;
}

export type CoachingResult =
  | { status: "disabled" }
  | { status: "ok"; coaching: Coaching; text: string }
  | { status: "error"; message: string };

function triggerPhrase(triggers: TriggerKind[]): string {
  const parts = triggers.map((t) =>
    t === "velocity" ? "velocity degradation (the rep slowed vs the rolling average)" : "a fault-severity spike (a check crossed into the critical zone)",
  );
  return parts.join(" AND ");
}

function buildCoachingPrompt(input: CoachingInput): string {
  const visible = metricsForOrientation(input.orientation)
    .filter((m) => m !== "velocity" && m !== "repCount")
    .map((m) => METRIC_DESC[m]);
  const hidden = metricsForOrientation(input.orientation === "front" ? "side" : "front")
    .filter((m) => METRICS[m].appliesTo !== "agnostic")
    .map((m) => METRIC_DESC[m]);

  const spike = input.faultSpikeChecks.length
    ? `The check(s) that spiked to CRITICAL: ${input.faultSpikeChecks.map((m) => METRIC_DESC[m]).join("; ")}.`
    : "";

  const checkLines = input.checks
    .filter((c) => c.status === "ok" || c.status === "warn")
    .map((c) => {
      const v = c.value !== null ? ` (value ${c.value.toFixed(2)})` : "";
      return `  - ${METRIC_DESC[c.metric]}: ${c.severity}${v}`;
    })
    .join("\n");

  const vel = input.velocity
    ? `Fatigue context: this rep ${fmt(input.velocity.current)} u/s vs rolling baseline ${fmt(input.velocity.rollingAverage)} u/s` +
      (input.velocity.pctSlower !== null ? ` (~${Math.round(input.velocity.pctSlower * 100)}% slower)` : "") +
      (input.velocity.collapsed ? " — VELOCITY COLLAPSE (likely fatigued)." : ".")
    : "";

  return [
    "You are a real-time squat coaching companion, not a fault detector. Read every signal below as 'a movement worth examining given the whole context,' NOT 'a fault to fix.' Most of these are conditional on load, anatomy and intent — the folklore versions (knees-past-toes, any rounding, deep = bad) are wrong. Use the causal context to give a cause-aware cue, not a label.",
    `Trigger: ${triggerPhrase(input.triggers)}.`,
    spike,
    `This is rep #${input.repIndex} of set #${input.setIndex}, filmed ${input.orientation.toUpperCase()}-ON.`,
    `From this angle you CAN judge: ${visible.join("; ")}. You CANNOT judge (don't comment on): ${hidden.join("; ")}.`,
    checkLines ? `Severity of each check this rep:\n${checkLines}` : "",
    vel,
    contextBlock(input.context, input.faultSpikeChecks),
    "Give ONE specific, actionable cue addressing what triggered this alert, using the causal context (e.g. tie lean/valgus to the ankle or stance hint if present). Maximum 2 sentences, encouraging and specific. Respond as JSON: fault_type (the single fault you're cueing, or 'none') and cue. No medical advice; never mention the camera, background or clothing.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** v2 Part 4 causal/cross-metric context + mode valence — the companion layer. */
function contextBlock(ctx: RepContextV2 | null | undefined, faults: MetricId[]): string {
  if (!ctx) return "";
  const lines: string[] = [];
  lines.push(
    ctx.mode === "loaded"
      ? "MODE: LOADED — depth, valgus and butt wink carry real (if conditional) injury relevance; read more cautiously."
      : "MODE: BODYWEIGHT — depth/valgus/lean are goal & motor-control signals, NOT safety faults. Do not moralize about a shallow bodyweight squat.",
  );
  // Depth framing (goal-adherence, with mobility-boundary suppression).
  if (ctx.depthGap !== null) {
    lines.push(
      `Depth: gap ${ctx.depthGap.toFixed(2)} vs preset "${ctx.depthPreset}", ${ctx.depthMet ? "cleared" : "short of"} target.` +
        (ctx.presetIsMobilityBoundary
          ? " The preset is a DELIBERATE MOBILITY BOUNDARY — do NOT suggest going deeper in any way."
          : ""),
    );
  }
  if (ctx.excessiveDepthLoaded) lines.push("Loaded: uncontrolled EXCESSIVE depth — may have failed the rep.");
  // Upstream/causal — the single highest-leverage fields.
  const causal: string[] = [];
  if (ctx.shinAngleDeg !== null) causal.push(`shin angle ${ctx.shinAngleDeg.toFixed(0)}° (low ≈ possible ankle restriction)`);
  if (ctx.stanceWidthRatio !== null) causal.push(`stance/hip-width ${ctx.stanceWidthRatio.toFixed(2)}`);
  if (ctx.footAngleDeg !== null) causal.push(`foot angle ~${ctx.footAngleDeg.toFixed(0)}°`);
  if (causal.length) lines.push(`Possible upstream cause(s): ${causal.join(", ")}. Prefer ONE coherent cause-based cue over separate labels.`);
  // Asymmetry bundle.
  const asym: string[] = [];
  if (ctx.levelnessDiffDeg !== null) asym.push(`shoulder-hip tilt ${ctx.levelnessDiffDeg.toFixed(0)}°`);
  if (ctx.kneeAsymmetry !== null) asym.push(`knee asymmetry ${ctx.kneeAsymmetry.toFixed(2)}`);
  if (ctx.lateralShiftRatio !== null) asym.push(`lateral hip shift ${ctx.lateralShiftRatio.toFixed(2)}`);
  if (asym.length) lines.push(`Asymmetry: ${asym.join(", ")}.`);
  // Chest cave piggyback: only when forward lean triggered.
  if (faults.includes("forwardLean")) {
    lines.push("Also assess UPPER-BACK / CHEST ROUNDING from the image (not directly measured); mention it only if visibly present.");
    if (ctx.leanConcentratedDeep) lines.push("Lean is concentrated near the bottom (possible butt wink) — frame gently, evidence is contested.");
  }
  if (ctx.earlyLeanOnset && ctx.mode === "loaded") lines.push("Lean onsets BEFORE parallel (loaded early-onset) — the one butt-wink variant worth flagging.");
  if (!ctx.baselineReady) lines.push("NOTE: per-set baseline not yet established (reps 1–2) — treat magnitudes cautiously.");
  return lines.join(" ");
}

const COACHING_SCHEMA = {
  type: "OBJECT",
  properties: {
    fault_type: { type: "STRING", enum: FAULT_TYPES as unknown as string[] },
    cue: { type: "STRING" },
  },
  required: ["fault_type", "cue"],
};

/** Real-time triggered coaching cue (spec §4). */
export async function requestCoaching(input: CoachingInput): Promise<CoachingResult> {
  if (!geminiEnabled()) return { status: "disabled" };
  try {
    const parts: Record<string, unknown>[] = [{ text: buildCoachingPrompt(input) }];
    if (input.imageBase64) parts.push({ inline_data: { mime_type: "image/jpeg", data: input.imageBase64 } });

    const res = await fetch(ENDPOINT(MODEL), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": getApiKey() },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 200,
          responseMimeType: "application/json",
          responseSchema: COACHING_SCHEMA,
        },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { status: "error", message: `Gemini ${res.status}: ${truncate(detail)}` };
    }
    const { text: raw } = extractText(await res.json());
    const coaching = raw ? parseCoaching(raw) : null;
    if (!coaching) return { status: "error", message: "Gemini returned no usable cue" };
    return { status: "ok", coaching, text: coaching.cue };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "network error" };
  }
}

export { METRIC_TO_FAULT };

// ============================================================================
// v2 two-tier Gemini calls — post-set / post-workout. (Mid-set real-time cues were
// removed: latency 12-34s on ~40s sets made them useless.) Post-set is sent a per-set frame
// ARCHIVE built with no time limit — the two baseline key frames (reps 1-2 bottom) plus one
// peak-severity frame per error type — because the ~7.5s ring evicts both baseline and early
// faults 5-12s before post-set fires (verified). Post-workout is TEXT-ONLY (no frames).
// Browser-direct, reusing the fetch plumbing above.
// ============================================================================

export interface PostSetData {
  call_type: "post_set";
  set_summary: { set_number: number; orientation: string; total_reps_attempted: number; total_reps_counted: number; depth_misses: number };
  /** How many baseline key frames (reps 1-2 bottom) were actually sent — 0, 1 or 2. Drives
   *  POSTSET_SYSTEM rule 1: 0 ⇒ the model must say "no baseline available", never fabricate.
   *  The baseline frames, when present, are the EARLIEST images in the sent list. */
  baseline_frames_included: number;
  baseline: {
    trunk_angle_deg: number | null;
    descent_velocity: number | null;
    /** Did reps 1-2 actually CALIBRATE? Distinct from baseline_frames_included, which is only
     *  about photos. When a warm-up rep misses the depth-hygiene gate the baseline never
     *  resolves and every baseline-relative check stays disarmed for the whole set. */
    valid: boolean;
    /** Human-readable names of the checks that could not run, so the model can say what was
     *  NOT evaluated instead of reading an empty triggers_fired as a clean set. Restricted to
     *  checks this view could have run. */
    checks_disarmed: string[];
  };
  /** `trend` was REMOVED: it was `length === 1 ? "single_occurrence" : "stable"`, so 4-of-6 caves
   *  and 2-of-10 both read "stable" — a label that understated frequency, on the field a model
   *  reaches for when judging consistency. rep_numbers (every rep the fault fired on) plus
   *  set_summary.total_reps_attempted give the exact frequency, and deciding whether that
   *  constitutes a "trend" is the model's judgment to make, not the local layer's. */
  triggers_fired: {
    type: string;
    sub_signal: string | null;
    rep_numbers: number[];
    peak_severity_ratio: number;
    /** Severity band for the peak (config SEVERITY). The SAYABLE magnitude — the raw ratio is
     *  a normalized number the prompt forbids quoting. */
    severity: Severity;
    /** Peak ÷ this set's own baseline, where the fault has one (null for valgus, which is an
     *  absolute knee/ankle ratio). Needed because `severity` alone is flat: a 0.32 and a 0.66
     *  hip shift are both "critical", and the debrief called the 2.6× one "slightly off-center". */
    baseline_multiple: number | null;
  }[];
  /** Context — informs synthesis but is NOT a finding (see POSTSET_SYSTEM rule 3). Only real,
   *  kept signals: lateral_trunk_shift (T11's raw number; the fire is in triggers_fired) and
   *  velocity_collapse (T6, deliberately silent). levelness + knee_symmetry were removed as
   *  structurally-unreliable noise, not context. */
  context: {
    lateral_trunk_shift_normalized: number | null;
    velocity_collapse_ratio: number | null;
    /** Per-rep concentric velocity vs the rolling baseline. Present so a fatigue claim can be
     *  tied to the rep that actually slowed — `velocity_collapse_ratio` is a session minimum
     *  with no rep identity, and the model was localising fatigue to reps that had sped up. */
    velocity_ratios_by_rep: { rep_number: number; ratio: number }[];
    /** `velocity_collapse_ratio` in words. The ratio is kept because rule 3a's fatigue gate is
     *  defined on it, but only this band may be spoken. */
    velocity_band: VelocityBand | null;
  };
  depth_context: {
    preset: string;
    preset_reason: string;
    miss_count: number;
    /** Which quantity decides counting in THIS view — the units of depth_target /
     *  achieved_depth / uncounted_reps[].measured. */
    depth_basis: "hip_knee_gap" | "depth_ratio";
    depth_target: number;
    /** Per-rep achieved depth in the basis above (was `achieved_depth_ratios`, which sent the
     *  orientation-agnostic ratio even on side sets, where the GAP is what gates counting). */
    achieved_depth: number[];
  };
  /** Reps that did NOT count — side: below the depth target; front: below the front
   *  movement floor. Surfaced so the coach can address a cut-short rep. `measured`/`target`
   *  are in depth_context.depth_basis units. The depth gate, rep counting, and the on-screen
   *  "not counted" flash are all unchanged. */
  uncounted_reps: {
    rep_number: number;
    counted: false;
    reason: "depth_miss";
    measured: number | null;
    target: number;
    /** How far short, in words. The only form the model may speak — see POSTSET_SYSTEM rule 6. */
    band: ShortfallBand | null;
  }[];
  load_mode: string;
  delivery: { tone: string; verbosity: string; user_name: string };
}

export interface PostWorkoutData {
  call_type: "post_workout";
  session_summary: { total_sets: number; total_reps_counted: number; total_reps_attempted: number; orientations: string[] };
  /** Each set's post-set debrief text, in order — the primary input now that post-workout is
   *  text-only. Each is already view-constrained by its own tier, so post-workout synthesizes
   *  over them without re-observing. The LAST set has no post-set (ends via End Workout), so it
   *  is absent here and covered only by the numeric trends below. */
  per_set_debriefs: { set_number: number; orientation: string; text: string }[];
  /** Built by session/faultTrends.ts. `sets_observable` = the sets whose view could see the
   *  fault; `co_occurred_with_slowing` = it fired on a rep whose OWN velocity ratio was < 1.0
   *  (co-occurrence, never cause). It replaced `worsened_with_fatigue`, which was true for any
   *  fault present in the last set — velocity was never consulted. */
  fault_trends: {
    type: string;
    sets_present: number[];
    sets_observable: number[];
    trend: "persistent" | "intermittent";
    co_occurred_with_slowing: boolean;
  }[];
  /** Per-set slowest velocity ratio; null when the set had none measured (was 1 = "no slowing"). */
  cross_set_metrics: { velocity_degradation_per_set: (number | null)[]; depth_consistency: string };
  /** Every rep across the session that did NOT count (see PostSetData.uncounted_reps).
   *  Lets the summary address cut-short reps instead of reporting "zero misses". `basis` is
   *  per-entry here because a session mixes side and front sets, and the two use different
   *  deciding measures — never compare a `measured` across differing bases. */
  uncounted_reps: {
    set_number: number;
    rep_number: number;
    counted: false;
    reason: "depth_miss";
    measured: number | null;
    target: number;
    basis: "hip_knee_gap" | "depth_ratio";
  }[];
  load_mode: string;
  delivery: { tone: string; verbosity: string; user_name: string };
}

// --- dev-only call observer (workout eval logger) ---------------------------
// A single optional sink that sees EVERY three-tier call attempt — including the
// exact payload sent, which frames went with it, the verbatim response (incl.
// "NO_CUE"), and rate-limit skips. This is the audit hook `debug/evalLog.ts`
// subscribes to; when nothing is subscribed it's a single null-check, zero cost.
export interface GeminiCallObservation {
  tier: "mid_set" | "post_set" | "post_workout" | "deep_analysis";
  timestampMs: number;
  /** The exact JSON payload object sent (measured / causal_flags separate, as sent). */
  payload: unknown;
  /** Frames that accompanied the call (0 on a rate-limit skip — none selected). */
  frames: { count: number; timestamps: number[] };
  /** `skipped_quota` = blocked locally by the usage cap; nothing was sent. */
  outcome: "response" | "no_cue" | "skipped_rate_limit" | "skipped_quota" | "error";
  /** Raw model text verbatim, including "NO_CUE"; null on skip/error. */
  responseText: string | null;
  /** Wall-clock ms from the request going out to the response landing (latency is
   *  its own quality axis — a correct cue that arrives late is still a failure).
   *  null on a skip (no request was made). */
  latencyMs?: number | null;
  errorMessage?: string;
  /** candidates[0].finishReason: "STOP" on a clean finish; "MAX_TOKENS" (or any
   *  non-STOP value) means the text was truncated and was NOT surfaced as normal. */
  finishReason?: string | null;
  /** Token accounting from usageMetadata (thoughtsTokenCount = thinking tokens). */
  usage?: GeminiUsage | null;
}
let callObserver: ((o: GeminiCallObservation) => void) | null = null;
/** Register (or clear with null) the dev-only call observer. */
export function setGeminiCallObserver(fn: ((o: GeminiCallObservation) => void) | null): void {
  callObserver = fn;
}
function emitObs(o: GeminiCallObservation): void {
  // PERSISTENT USAGE ACCOUNTING. Deliberately inside emitObs rather than at each
  // call site: every tier already emits an observation on every path (success,
  // no_cue, skip, error), so hanging accounting off this one function makes it
  // structurally impossible to add a tier that spends money without being counted.
  // Unlike the observer below it is NOT dev-gated — it must run in production.
  recordCall({
    tier: o.tier,
    outcome: o.outcome,
    model: MODEL,
    timestampMs: o.timestampMs,
    latencyMs: o.latencyMs ?? null,
    imageCount: o.frames.count,
    promptTokens: o.usage?.promptTokenCount ?? null,
    outputTokens: o.usage?.candidatesTokenCount ?? null,
    thinkingTokens: o.usage?.thoughtsTokenCount ?? null,
  });
  // Logging must never break or slow a real call.
  if (callObserver) try { callObserver(o); } catch { /* ignore */ }
}

/**
 * Quota gate. Returns an error message when the call must NOT go out, else null.
 * Records the refusal as a `skipped_quota` observation so a blocked call is still
 * visible in the ledger and the eval log — a silent no-op would look like a bug.
 */
function quotaBlock(tier: GeminiCallObservation["tier"], payload: unknown): string | null {
  const verdict = quota(tier);
  if (verdict.allowed) return null;
  const resetsAt = verdict.resetsAtMs ? new Date(verdict.resetsAtMs).toLocaleDateString() : "later";
  const message = `Usage limit reached (${verdict.used}/${verdict.limit} calls). Resets ${resetsAt}.`;
  emitObs({
    tier,
    timestampMs: Date.now(),
    payload,
    frames: { count: 0, timestamps: [] },
    outcome: "skipped_quota",
    responseText: null,
    latencyMs: null,
    errorMessage: message,
  });
  return message;
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// System prompts live in ai/prompts.ts (pure, so the Node checks can read them).

/** Core generate: system + JSON payload + inline images. Throws on HTTP error.
 *  `tier` selects the thinking level from GEMINI.thinking; when GEMINI.sendThinking
 *  is on we send `thinkingConfig.thinkingLevel` and OMIT temperature (Gemini 3.x
 *  guidance — the default 1.0 is recommended; lowering it risks thinking loops). */
async function geminiGenerate(
  system: string,
  payload: unknown,
  images: string[],
  maxTokens: number,
  tier: keyof typeof GEMINI.thinking,
): Promise<GeminiExtract> {
  const parts: Record<string, unknown>[] = [{ text: system }, { text: JSON.stringify(payload) }];
  for (const b64 of images) parts.push({ inline_data: { mime_type: "image/jpeg", data: b64 } });
  const generationConfig: Record<string, unknown> = { maxOutputTokens: maxTokens };
  if (GEMINI.sendThinking) {
    // REST v1beta: thinking is nested under generationConfig.thinkingConfig.
    generationConfig.thinkingConfig = { thinkingLevel: GEMINI.thinking[tier] };
  } else {
    generationConfig.temperature = 0.4;
  }
  // Key travels as a header, never in the query string: a URL-borne key lands in
  // proxy logs, Referer headers and browser history, and this one is the user's.
  const res = await fetch(ENDPOINT(MODEL), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": getApiKey() },
    body: JSON.stringify({ contents: [{ parts }], generationConfig }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${truncate(detail)}`);
  }
  return extractText(await res.json());
}

// --- frame selection --------------------------------------------------------
/**
 * Within ONE trigger type, is severity `a` worse than the current best `b`?
 * Severity carries different units AND directions per type, and we do NOT unify them —
 * selection/archiving is always per-type, so only the direction matters:
 *   - knee_valgus: severity is knee-width/ankle-width, where LOWER = knees caving = worse (INVERSE).
 *   - forward_lean (degrees) / eccentric_control (sub-signal count) / lateral_shift: HIGHER = worse.
 * Exported so the per-set archive (useWorkout) keeps ONE peak frame per type with the same
 * direction rule the selection layer used to apply — single source of truth.
 */
const FAULT_TO_METRIC: Partial<Record<string, MetricId>> = Object.fromEntries(
  Object.entries(METRIC_TO_FAULT).map(([metric, fault]) => [fault, metric as MetricId]),
);

export function tagMoreSevere(triggerType: string, a: number, b: number): boolean {
  // Direction is NOT hardcoded here. It resolves through SEVERITY[metric].worseWhen — the same
  // field aggregateRep (squat/checks.ts) uses to pick a rep's peak frame — so the archived photo
  // and peak_severity_ratio read one source and cannot drift. (Was `triggerType === "knee_valgus"`,
  // a second copy of the per-metric direction rule.) Unknown types keep the higher-is-worse default.
  const metric = FAULT_TO_METRIC[triggerType];
  const worseWhen = metric ? SEVERITY[metric]?.worseWhen : undefined;
  return worseWhen === "below" ? a < b : a > b;
}

/** The most severe value among `values` for ONE fault type. Delegates the direction to
 *  tagMoreSevere so the payload's peak_severity_ratio and the archive's peak FRAME can never
 *  disagree about which way is worse — the inversion this replaces reported the MILDEST cave as
 *  the valgus "peak" (Math.max on a ratio where lower = more caved) while the archived photo
 *  showed the worst one. No magnitude normalization: every value reaching here is non-negative
 *  (checks.ts abs-normalizes hipShift/kneeSymmetry/levelness; torsoLean and the valgus ratio are
 *  positive by construction), so raw values already carry the right ordering. null if empty. */
export function peakSeverity(faultType: string, values: number[]): number | null {
  let peak: number | null = null;
  for (const v of values) if (peak === null || tagMoreSevere(faultType, v, peak)) peak = v;
  return peak;
}

/** Post-set frames = the ENTIRE per-set archive (baseline reps 1-2 bottom + one peak-severity
 *  frame per error type), assembled by the caller with NO ring/time-limit. The ring buffer is
 *  NOT consulted — post-set no longer reads evictable frames, so baseline can never be evicted
 *  (verified: it always was, 5-12s too late). This just normalizes: dedup by timestamp, sort
 *  chronologically (baseline reps 1-2 are earliest → appear first in the sent image list), and
 *  keep the 15 cap as a pure safety valve. Only THREE fault types can tag a frame (forward_lean,
 *  eccentric_control, knee_valgus — T11 lateral_shift never calls fireCoaching, so it is numeric-
 *  only), so the archive is structurally ≤ 2 baseline + 3 peaks = 5: the cap is never reached and
 *  baseline (earliest) is never sliced. */
function selectPostSetFrames(archive: ImageFrame[]): ImageFrame[] {
  const byTs = new Map<number, ImageFrame>();
  for (const f of archive) byTs.set(f.timestampMs, f);
  return [...byTs.values()].sort((a, b) => a.timestampMs - b.timestampMs).slice(0, 15);
}

/** Function 1 — post-set debrief (blocking acceptable, still async). `archive` is the ENTIRE
 *  per-set frame archive (baseline + peak-per-type); the ring is not read here. Frames are
 *  extracted SYNCHRONOUSLY below (into `images`), before the async fetch, so a later per-set
 *  archive reset cannot affect an in-flight call. */
export function callPostSet(
  data: PostSetData | PushupPostSetData | PullupPostSetData,
  archive: ImageFrame[],
  callback: (text: string | null) => void,
): void {
  if (!geminiEnabled()) return callback(null);
  // Usage cap (disabled by default). Post-set is the image-bearing tier and the
  // dominant cost, so it is gated first.
  if (quotaBlock("post_set", data)) return callback(null);
  const firedAt = Date.now();
  const frames = selectPostSetFrames(archive);
  const images = frames.map((f) => f.jpegBase64);
  const framesMeta = { count: frames.length, timestamps: frames.map((f) => f.timestampMs) };
  // Cap raised 2048→8192: "medium" thinking draws from this budget and the detailed
  // debrief needs room — a tight cap truncated the analysis mid-sentence (finishReason
  // MAX_TOKENS), now flagged rather than shown as if complete.
  // The exercise is carried by the payload itself (push-up and pull-up payloads set `exercise`; the
  // squat payload is unchanged and has none), so the prompt can never be paired with the wrong data.
  const exercise = "exercise" in data ? data.exercise : "squat";
  const system = exercise === "pushup" ? PUSHUP_POSTSET_SYSTEM : exercise === "pullup" ? PULLUP_POSTSET_SYSTEM : POSTSET_SYSTEM;
  void geminiGenerate(system, data, images, 8192, "postSet")
    .then(({ text, finishReason, usage }) => {
      const t = (text ?? "").trim();
      if (finishReason && finishReason !== "STOP") {
        // Truncated / abnormal finish — do NOT surface as a normal debrief.
        emitObs({ tier: "post_set", timestampMs: Date.now(), payload: data, frames: framesMeta, outcome: "error", responseText: t || null, latencyMs: Date.now() - firedAt, errorMessage: `truncated (finishReason=${finishReason})`, finishReason, usage });
        return callback(null);
      }
      emitObs({ tier: "post_set", timestampMs: Date.now(), payload: data, frames: framesMeta, outcome: t ? "response" : "no_cue", responseText: t || null, latencyMs: Date.now() - firedAt, finishReason, usage });
      callback(t || null);
    })
    .catch((e) => {
      emitObs({ tier: "post_set", timestampMs: Date.now(), payload: data, frames: framesMeta, outcome: "error", responseText: null, latencyMs: Date.now() - firedAt, errorMessage: errMsg(e) });
      callback(null);
    });
}

/** Function 2 — post-workout summary (blocking acceptable, still async). TEXT-ONLY: it
 *  synthesizes over the per-set debrief texts (already view-constrained) + numeric trends and
 *  receives NO images, so the model can never confabulate from evicted/late frames. */
export function callPostWorkout(
  data: PostWorkoutData | PushupPostWorkoutData | PullupPostWorkoutData,
  callback: (text: string | null) => void,
): void {
  if (!geminiEnabled()) return callback(null);
  if (quotaBlock("post_workout", data)) return callback(null);
  const firedAt = Date.now();
  const framesMeta = { count: 0, timestamps: [] as number[] };
  // Cap 4096: text-only synthesis (no image tokens) with "low" thinking needs less room than
  // the image-bearing tiers; still generous headroom over the summary length so thinking
  // tokens can't truncate it.
  const exercise = "exercise" in data ? data.exercise : "squat";
  const system = exercise === "pushup" ? PUSHUP_POSTWORKOUT_SYSTEM : exercise === "pullup" ? PULLUP_POSTWORKOUT_SYSTEM : POSTWORKOUT_SYSTEM;
  void geminiGenerate(system, data, [], 4096, "postWorkout")
    .then(({ text, finishReason, usage }) => {
      const t = (text ?? "").trim();
      if (finishReason && finishReason !== "STOP") {
        // Truncated / abnormal finish — do NOT surface as a normal summary.
        emitObs({ tier: "post_workout", timestampMs: Date.now(), payload: data, frames: framesMeta, outcome: "error", responseText: t || null, latencyMs: Date.now() - firedAt, errorMessage: `truncated (finishReason=${finishReason})`, finishReason, usage });
        return callback(null);
      }
      emitObs({ tier: "post_workout", timestampMs: Date.now(), payload: data, frames: framesMeta, outcome: t ? "response" : "no_cue", responseText: t || null, latencyMs: Date.now() - firedAt, finishReason, usage });
      callback(t || null);
    })
    .catch((e) => {
      emitObs({ tier: "post_workout", timestampMs: Date.now(), payload: data, frames: framesMeta, outcome: "error", responseText: null, latencyMs: Date.now() - firedAt, errorMessage: errMsg(e) });
      callback(null);
    });
}

// --- response parsing -------------------------------------------------------
interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

/** Token accounting pulled from usageMetadata (thoughtsTokenCount = thinking tokens). */
export interface GeminiUsage {
  promptTokenCount: number | null;
  candidatesTokenCount: number | null;
  thoughtsTokenCount: number | null;
}

/** Parsed generate result: the text plus two observability signals — the
 *  candidate's finishReason (STOP = clean finish; MAX_TOKENS or any other value
 *  means the text is TRUNCATED and must not be treated as a complete result) and
 *  token usage. */
export interface GeminiExtract {
  text: string | null;
  finishReason: string | null;
  usage: GeminiUsage | null;
}

function extractText(json: unknown): GeminiExtract {
  const j = json as GeminiResponse;
  const cand = j?.candidates?.[0];
  const parts = cand?.content?.parts;
  const text = parts ? parts.map((p) => p.text ?? "").join("").trim() || null : null;
  const um = j?.usageMetadata;
  const usage: GeminiUsage | null = um
    ? {
        promptTokenCount: um.promptTokenCount ?? null,
        candidatesTokenCount: um.candidatesTokenCount ?? null,
        thoughtsTokenCount: um.thoughtsTokenCount ?? null,
      }
    : null;
  return { text, finishReason: cand?.finishReason ?? null, usage };
}

function parseCoaching(raw: string): Coaching | null {
  try {
    const obj = JSON.parse(raw) as { fault_type?: string; cue?: string };
    const faultType = (FAULT_TYPES as readonly string[]).includes(obj.fault_type ?? "")
      ? (obj.fault_type as FaultType)
      : "none";
    const cue = (obj.cue ?? "").trim();
    return cue ? { faultType, cue } : null;
  } catch {
    return null;
  }
}

function fmt(n: number | null): string {
  return n !== null ? n.toFixed(3) : "—";
}

function truncate(s: string, n = 160): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export const GEMINI_MODEL = MODEL;
