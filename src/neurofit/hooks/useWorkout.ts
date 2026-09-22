/**
 * Workout controller — alternating-orientation squat and push-up sets.
 * ----------------------------------------------------------------------------
 * Drives the whole session: detect the camera orientation per set, lock when it
 * matches the set's target (front/side, alternating), run reps with the full
 * orientation-gated metric set, fire the velocity-triggered Gemini critique, and
 * on finish hand the structured session to the synthesis layer.
 *
 * Per-frame math is in the pure modules (squat/, pushup/, vision/, session/); this hook
 * is the only React-aware piece. State is pushed ~10×/sec off a timer.
 *
 * Push-ups run through the pure per-set engine in pushup/session.ts; the squat keeps its original
 * inline path below, untouched. The exercise is fixed for a workout — changing it resets.
 */
import { useEffect, useRef, useState } from "react";
import type { PoseLandmarkerResult } from "@mediapipe/tasks-vision";
import { MIN_VISIBILITY, type Landmark } from "../pose/landmarks";
import { SQUAT, ORIENTATION, DEPTH_PRESETS, TRIGGERS, GEMINI, type DepthPreset, type SquatMode } from "../squat/config";
import { LandmarkBuffer, ImageBuffer, BUFFER_LANDMARK_INDICES, PUSHUP_BUFFER_LANDMARK_INDICES, type RepPhase, type ImageFrame } from "../ai/frameBuffer";
import { computeSquatFrame, type SquatFrame } from "../squat/frame";
import { SquatRepTracker, type SquatRep } from "../squat/repCounter";
import { VelocityTracker, type VelocitySample } from "../squat/velocity";
import {
  aggregateRep,
  depthShortfallBand,
  evaluateRep,
  evalEccentric,
  landmarkImplausible,
  leanTriggerActive,
  repCounts,
  repFeedsBaseline,
  severityFor,
  shiftTriggerActive,
  valgusTriggerActive,
  velocityBand,
  type MetricResult,
  type RepMetrics,
} from "../squat/checks";
import { BaselineTracker, EccentricTracker, PersistenceGate } from "../squat/dynamics";
import { type MetricId, type Orientation } from "../squat/metrics";
import { emptyContext, type RepContextV2 } from "../session/context";
import {
  classify,
  estimateOrientation,
  type OrientationClass,
  type OrientationEstimate,
} from "../vision/orientation";
import { estimateCameraAngle, type CameraAngleEstimate } from "../vision/cameraAngle";
import {
  geminiEnabled,
  callPostSet,
  callPostWorkout,
  setGeminiCallObserver,
  tagMoreSevere,
  peakSeverity,
  GEMINI_MODEL,
  METRIC_TO_FAULT,
  type PostSetData,
  type PostWorkoutData,
} from "../ai/gemini";
import { CoachingCoordinator, type CoachingBatch } from "../ai/coaching";
import type { RepCoaching, RepRecord, SetRecord } from "../session/types";
import { synthesize, type WorkoutReport } from "../session/synthesis";
import { squatFaultTrends, velocityDegradationPerSet } from "../session/faultTrends";
import { logShoulderHipFrame, downloadShoulderHipCsv } from "../debug/shoulderHipLog";
import {
  DEV_EVAL_LOG,
  startSession as startEvalSession,
  logRep as logEvalRep,
  logGeminiObservation,
  logPushupRep,
  downloadEvalLog,
} from "../debug/evalLog";
import { quota, recordWorkout, startUsageSession } from "../usage/usageStore";
import { quotaMessage } from "../usage/ledger";
import type { ExerciseId } from "../session/types";
import { PUSHUP, PUSHUP_DEPTH_PRESETS, type PushupDepthPreset, type PushupVariant } from "../pushup/config";
import { computePushupFrame, NearSideSelector, type PushupFrame } from "../pushup/frame";
import type { PushupMetricId, PushupRepMetrics } from "../pushup/metrics";
import { estimatePushupOrientation } from "../pushup/orientation";
import { PushupSetSession, type PushupFrameEvents, type PushupSetRecord } from "../pushup/session";
import { buildPushupPostSetData, buildPushupPostWorkoutData } from "../pushup/payload";
import { synthesizePushup } from "../pushup/synthesis";

export type WorkoutPhase = "positioning" | "countdown" | "active" | "set-review" | "finished";

/** Sub-stage of phase "set-review". "choice" = the end-of-set screen (Next set / End workout,
 *  no analysis fired yet); "post-set" = Next set was clicked, so the post-set analysis was
 *  requested and is loading/shown. Post-set analysis fires ONLY on that Next-set click. */
export type SetReviewStage = "choice" | "post-set";

/** Per-set post-set analysis state for the between-set review screen + the finish-workout
 *  per-set review. Rendered from the response ALREADY fetched by callPostSet — never a new
 *  call. "none" = the call resolved with no usable analysis (empty/error, or rate-limited
 *  pre-Task-1); "disabled" = no API key. */
export type PostSetReview =
  | { status: "loading" }
  | { status: "ok"; text: string }
  | { status: "none" }
  /** The usage cap refused the call — distinct from a failure, so the UI can say why. */
  | { status: "blocked"; message: string }
  | { status: "disabled" };

export type AnalysisState =
  | { status: "idle" }
  | { status: "disabled" }
  | { status: "loading" }
  | { status: "ok"; text: string }
  | { status: "error"; message: string };

/** The per-set post-set frame archive (time-limit-free; see postSetFrameArchiveRef). */
interface PostSetFrameArchive {
  /** Reps 1-2 bottom key frames, captured by TIME at rep-complete (never evicted). 0-2 entries. */
  baseline: ImageFrame[];
  /** ONE peak-severity frame per error type — worst kept via tagMoreSevere (valgus inverse). */
  faults: Map<string, { frame: ImageFrame; severity: number }>;
}

const COUNTDOWN_SEC = 3;
const FIRST_ORIENTATION: Orientation = "side"; // Set 1 = side, then alternate
const ANGLE_EMA = 0.5;

/** Tier-2: flag a rep's tracking as unreliable when near-side visibility falls below this
 *  fraction of the per-set (reps 1–2) baseline. UNVALIDATED (n=1: set 4 rep 7 read 0.64×
 *  its set baseline while still above the absolute MIN_VISIBILITY floor). */
const TIER2_VIS_DROP_RATIO = 0.75;

/** Min landmark visibility across a rep's window — near-side-only on SIDE view (the far-side
 *  hip/knee/ankle are always occluded edge-on, so a whole-body min is meaningless there; the
 *  near side is the higher-mean-visibility L/R set, as cameraAngle picks preferredSide). FRONT
 *  uses all 8 (both sides visible). Feeds the Tier-2 reliability flag + the dev eval log. */
function repWindowMinVisibility(
  window: { landmarks: Record<number, { visibility: number }> }[],
  orientation: Orientation,
): number | null {
  const L = [11, 23, 25, 27], R = [12, 24, 26, 28];
  let nearOnly: number[] | null = null;
  if (orientation === "side") {
    let ls = 0, ln = 0, rs = 0, rn = 0;
    for (const s of window)
      for (const key of Object.keys(s.landmarks)) {
        const i = Number(key), v = s.landmarks[i].visibility;
        if (L.includes(i)) { ls += v; ln++; } else if (R.includes(i)) { rs += v; rn++; }
      }
    nearOnly = (ln ? ls / ln : 0) >= (rn ? rs / rn : 0) ? L : R;
  }
  let minVis: number | null = null;
  for (const s of window)
    for (const key of Object.keys(s.landmarks)) {
      const i = Number(key);
      if (nearOnly && !nearOnly.includes(i)) continue;
      const v = s.landmarks[i].visibility;
      if (minVis === null || v < minVis) minVis = v;
    }
  return minVis;
}

export interface WorkoutLive {
  phase: WorkoutPhase;
  setIndex: number;
  targetOrientation: Orientation;
  /** Live orientation estimate (smoothed classification). */
  orientation: OrientationClass;
  facingAngleDeg: number | null;
  /** Raw facing score (shoulder-spread / torso-length), for the live readout. */
  facingScore: number | null;
  orientationLabel: string;
  aligned: boolean;
  lockProgress: number;
  countdown: number | null;
  /** True mid-set when the live orientation drifted off target — prompt reposition. */
  repositionNeeded: boolean;

  reps: number;
  kneeAngle: number | null;
  /** Live squat depth (0 standing → ~0.5 at parallel), drives rep counting. */
  depthRatio: number;
  /** Live hip-vs-knee gap (hipY − kneeY); the value the side depth check uses.
   *  For physically calibrating the depth target. Null when hips/knees unseen. */
  liveDepthGap: number | null;
  /** Live knee/ankle width ratio, for calibrating valgus. Null when unseen. */
  liveValgusRatio: number | null;
  /** True briefly after a SIDE attempt was made but didn't reach depth (no count). */
  missedDepthFlash: boolean;
  isDown: boolean;
  /** Latest rep's gated metric verdicts (or live while descending). */
  liveMetrics: RepMetrics | null;
  velocity: VelocitySample[];
  bestVelocity: number | null;
  camera: CameraAngleEstimate | null;

  /** Completed sets so far. */
  completedSets: SetRecord[];
  report: WorkoutReport | null;
  analysis: AnalysisState;
  /** Post-set / post-workout coach text log (spec Part 5), newest last. */
  coachLog: { timestampMs: number; kind: "post_set" | "post_workout"; text: string }[];
  /** Per-set post-set analysis (set index → review), persisted for the between-set review
   *  screen and the finish-workout per-set review. Populated from already-fetched responses. */
  postSetReviews: Record<number, PostSetReview>;
  /** During phase "set-review", the set whose review is showing (else null). */
  reviewSetIndex: number | null;
  /** During phase "set-review", which stage: end-of-set "choice" or requested "post-set". */
  reviewStage: SetReviewStage;

  /** The exercise this workout is for. */
  exercise: ExerciseId;
  /** The counting landmarks are readable (squat: knee angle; push-up: shoulder + wrist). */
  readable: boolean;
  /** Push-up live FORM CHECKS (null on squat workouts, which use liveMetrics). */
  pushupLiveMetrics: PushupRepMetrics | null;
  /** Completed push-up sets (squat sets stay in completedSets). */
  completedPushupSets: PushupSetRecord[];
  /** Why the last attempt didn't count — shown while missedDepthFlash is true. */
  missedFlashText: string;
  /** Push-up live calibration readouts drawn beside a landmark (empty for squats). */
  debugTags: { text: string; landmark: number }[];
}

export interface Workout extends WorkoutLive {
  /** `frameSize` = the image MediaPipe normalized against (push-up geometry is aspect-corrected). */
  onResult: (result: PoseLandmarkerResult, frameSize?: { width: number; height: number }) => void;
  endSet: () => void;
  /** "Next set" from the end-of-set choice: fire the post-set analysis (the ONLY path that
   *  fires it) and move to the post-set stage. Does NOT start the next set — newSet() does. */
  requestPostSet: () => void;
  /** Leave the between-set review and start the next set (phase "set-review" → positioning). */
  newSet: () => void;
  finishWorkout: () => void;
  reset: () => void;
  /** Dev-only: export the workout evaluation log (JSON + Markdown) now. */
  downloadEvalLog: () => void;
  /** True when the dev eval logger is active (gates the download button in the UI). */
  devEvalLog: boolean;
}

function nowSec(): number {
  return performance.now() / 1000;
}

function alternate(o: Orientation): Orientation {
  return o === "side" ? "front" : "side";
}

export interface ExerciseSettings {
  exercise: ExerciseId;
  pushupDepthPreset: PushupDepthPreset;
  pushupVariant: PushupVariant;
}

const DEFAULT_EXERCISE_SETTINGS: ExerciseSettings = { exercise: "squat", pushupDepthPreset: "parallel", pushupVariant: "toes" };

export function useWorkout(
  captureFrame: () => string | null,
  depthPreset: DepthPreset,
  mode: SquatMode,
  exerciseSettings: ExerciseSettings = DEFAULT_EXERCISE_SETTINGS,
): Workout {
  const captureRef = useRef(captureFrame);
  captureRef.current = captureFrame;
  // Live mirror of the selected depth target so the once-created frame closures
  // always read the latest preset (Settings tab) without re-subscribing.
  const depthPresetRef = useRef(depthPreset);
  depthPresetRef.current = depthPreset;
  // Live mirror of the training mode (bodyweight | loaded) for the same reason.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Exercise + push-up settings, mirrored for the same reason. The push-up engine captures the
  // preset and variant when a set's trackers are built, so a Settings change applies from the next
  // set; changing the EXERCISE resets the workout (see the effect below `reset`).
  const exerciseRef = useRef<ExerciseId>(exerciseSettings.exercise);
  exerciseRef.current = exerciseSettings.exercise;
  const pushupPresetRef = useRef<PushupDepthPreset>(exerciseSettings.pushupDepthPreset);
  pushupPresetRef.current = exerciseSettings.pushupDepthPreset;
  const pushupVariantRef = useRef<PushupVariant>(exerciseSettings.pushupVariant);
  pushupVariantRef.current = exerciseSettings.pushupVariant;

  const phaseRef = useRef<WorkoutPhase>("positioning");
  const setIndexRef = useRef(1);
  const targetRef = useRef<Orientation>(FIRST_ORIENTATION);

  const orientRef = useRef<OrientationEstimate | null>(null);
  const angleEmaRef = useRef<number | null>(null);
  const frameRef = useRef<SquatFrame | null>(null);
  const cameraRef = useRef<CameraAngleEstimate | null>(null);

  const alignStartRef = useRef<number | null>(null);
  const lastAlignedRef = useRef(0);
  const countdownStartRef = useRef<number | null>(null);
  const repositionRef = useRef(false);

  const repTrackerRef = useRef<SquatRepTracker | null>(null);
  const velocityRef = useRef<VelocityTracker>(new VelocityTracker(SQUAT, FIRST_ORIENTATION));
  const liveRepsRef = useRef<RepRecord[]>([]);

  // --- v2 trigger state ----------------------------------------------------
  /** Per-set reps-1–2 baselines (no trigger fires during warm-up). */
  const leanBaselineRef = useRef(new BaselineTracker(TRIGGERS.baselineReps));
  const descentBaselineRef = useRef(new BaselineTracker(TRIGGERS.baselineReps));
  /** Per-set reps-1–2 baseline for the T11 lateral-shift post-set trigger (baseline-relative
   *  firing, mirroring the lean baseline above). T10 knee-symmetry has none — it's demoted. */
  const shiftBaselineRef = useRef(new BaselineTracker(TRIGGERS.baselineReps));
  // Tier-2: per-set near-side visibility baseline (reps 1–2). A sharp drop vs this = a
  // tracking degradation even when the absolute value is still above MIN_VISIBILITY.
  const visBaselineRef = useRef(new BaselineTracker(TRIGGERS.baselineReps));
  /** Per-rep eccentric (hip-Y) tracker + 150ms persistence gates for mid-set triggers. */
  const eccentricRef = useRef(new EccentricTracker());
  const leanGateRef = useRef(new PersistenceGate(TRIGGERS.persistMs));
  const valgusGateRef = useRef(new PersistenceGate(TRIGGERS.persistMs));
  /** Mid-set triggers already fired this rep (fire once per rep per metric). */
  const firedThisRepRef = useRef<Set<MetricId>>(new Set());
  /** Per-rep lean tracking for T1 baseline + butt-wink context. */
  const maxLeanDeepRef = useRef<number | null>(null);
  const peakLeanDepthRatioRef = useRef(0);
  const earlyLeanRef = useRef(false);
  /** Stance read once per set at the first armed rep (quasi-static). */
  const stanceWidthRef = useRef<number | null>(null);
  const footAngleRef = useRef<number | null>(null);
  /** v2 context per rep, keyed `${set}:${rep}`, for the Gemini payload + post-set. */
  const contextByRepRef = useRef<Map<string, RepContextV2>>(new Map());
  /**
   * The MOMENT each mid-set trigger actually fired (at depth), keyed `${set}:${rep}`.
   * The Gemini payload is assembled later — when the coordinator's dedup window
   * flushes (~500 ms after onset, often mid-ascent/standing) — so reading live
   * `frameRef`/`depthRatio`/`performance.now()` there attaches a near-standing frame
   * and ~1° trunk to a trigger that fired deep. We snapshot the onset instead so the
   * frame, depth and trunk in the payload are internally consistent with the trigger.
   */
  const triggerMomentRef = useRef<Map<string, { timestampMs: number; depthRatio: number; trunkAngleDeg: number | null; valgusRatio: number | null }>>(new Map());

  // --- Gemini frame buffers (spec Part 2) ----------------------------------
  const landmarkBufferRef = useRef(new LandmarkBuffer(GEMINI.landmarkWindowMs));
  const imageBufferRef = useRef(new ImageBuffer(GEMINI.image.maxFrames));
  /** Per-set frame archive — the EXACT set of frames sent to the post-set call, built with NO
   *  time limit (independent of the ~7.5s ring, which evicts baseline + early faults 5-12s before
   *  post-set fires). Contents: the two baseline key frames (reps 1-2 bottom), ALWAYS; plus ONE
   *  peak-severity frame per error TYPE (not per instance — direction-aware via tagMoreSevere).
   *  Holds REFERENCES to the ring's ImageFrame objects (cheap; captured at rep-complete / tag
   *  time while still fresh in the ring). Reset per set in newSetTrackers, AFTER the post-set
   *  send (see CONFIRM-2 ordering). Structurally bounded to ≤ 2 + (#error types). */
  const postSetFrameArchiveRef = useRef<PostSetFrameArchive>({ baseline: [], faults: new Map() });
  const lastImageCapAtRef = useRef(0);
  const prevDepthRatioRef = useRef(0);
  /** Post-set / post-workout coach text, newest last (Part 5 session log). */
  const coachLogRef = useRef<{ timestampMs: number; kind: "post_set" | "post_workout"; text: string }[]>([]);
  /** Per-set post-set analysis, keyed by set index — persists the response callPostSet
   *  already fetched so the between-set + finish review can render it (never a new call). */
  const postSetBySetRef = useRef<Map<number, PostSetReview>>(new Map());
  /** The set being reviewed during phase "set-review" (the one just ended). */
  const reviewSetIndexRef = useRef<number | null>(null);
  /** Stage within phase "set-review": "choice" = Next set / End workout buttons (no analysis
   *  yet); "post-set" = the user clicked Next set, so the post-set analysis was requested. */
  const setReviewStageRef = useRef<SetReviewStage>("choice");
  /** Counted reps this set (depth-met side / floor-passed front) — drives the
   *  live header counter. The tracker's own count stays the ATTEMPT count. */
  const countedRepsRef = useRef(0);
  /** Timestamp of the last side attempt that didn't reach depth (flash trigger). */
  const missedFlashAtRef = useRef(0);
  const samplesRef = useRef<VelocitySample[]>([]);
  const lockAngleRef = useRef<number | null>(null);
  /** Per-frame metric evaluations of the rep in progress (worst-of at completion). */
  const repFramesRef = useRef<RepMetrics[]>([]);

  // --- Push-up engine state (the squat refs above stay squat-only) -----------------------
  /** Per-set push-up engine; rebuilt in newSetTrackers alongside the squat trackers. */
  const pushupSessionRef = useRef<PushupSetSession | null>(null);
  const pushupFrameRef = useRef<PushupFrame | null>(null);
  const pushupSetsRef = useRef<PushupSetRecord[]>([]);
  const nearSideRef = useRef(new NearSideSelector());
  /** Lifter is in a plank — the push-up lock requires it (standing in view never starts a set). */
  const inPlankRef = useRef(false);
  /** W/H of the frame MediaPipe normalized against; every angle (squat and push-up) is
   *  aspect-corrected with it. 16/9 until the first frame reports its size (the ideal
   *  getUserMedia asks for, and the camera every recorded session used). */
  const aspectRef = useRef(16 / 9);
  const missedFlashTextRef = useRef("Depth not met — no count");
  /** Separate coordinator so squat trigger batches keep their MetricId typing untouched. */
  const pushupCoordinatorRef = useRef(new CoachingCoordinator<PushupMetricId>(PUSHUP.aiDedupWindowSec));

  /** Coordinates the velocity + fault-spike triggers and the 500 ms dedup window. */
  const coordinatorRef = useRef(new CoachingCoordinator(SQUAT.aiDedupWindowSec));
  /** AI cues keyed `${setIndex}:${repIndex}`, attached to the rep record at set end. */
  const coachingByRepRef = useRef<Map<string, RepCoaching>>(new Map());
  /** Most recent fully-evaluated metrics for the in-progress / just-completed rep. */
  const latestMetricsRef = useRef<RepMetrics | null>(null);
  const completedSetsRef = useRef<SetRecord[]>([]);
  const reportRef = useRef<WorkoutReport | null>(null);
  const analysisRef = useRef<AnalysisState>(geminiEnabled() ? { status: "idle" } : { status: "disabled" });
  // Dev-only eval-log auto-export: the post-workout callback fires the one-shot export once its
  // (~15 s) response lands, so the async post-workout analysis is captured; a +30 s interval
  // backstop guarantees an export even if that call never resolves.
  const finishedAtRef = useRef<number | null>(null);
  const evalExportedRef = useRef(false);

  const [live, setLive] = useState<WorkoutLive>(initialLive());

  function initialLive(): WorkoutLive {
    return {
      phase: "positioning",
      setIndex: 1,
      targetOrientation: FIRST_ORIENTATION,
      orientation: "ambiguous",
      facingAngleDeg: null,
      facingScore: null,
      orientationLabel: "Step into frame",
      aligned: false,
      lockProgress: 0,
      countdown: null,
      repositionNeeded: false,
      reps: 0,
      kneeAngle: null,
      depthRatio: 0,
      liveDepthGap: null,
      liveValgusRatio: null,
      missedDepthFlash: false,
      isDown: false,
      liveMetrics: null,
      velocity: [],
      bestVelocity: null,
      camera: null,
      completedSets: [],
      report: null,
      analysis: geminiEnabled() ? { status: "idle" } : { status: "disabled" },
      coachLog: [],
      postSetReviews: {},
      reviewSetIndex: null,
      reviewStage: "choice",
      exercise: exerciseRef.current,
      readable: false,
      pushupLiveMetrics: null,
      completedPushupSets: [],
      missedFlashText: missedFlashTextRef.current,
      debugTags: [],
    };
  }

  function newSetTrackers(orientation: Orientation): void {
    repTrackerRef.current = new SquatRepTracker(SQUAT, onRepComplete);
    velocityRef.current = new VelocityTracker(SQUAT, orientation);
    liveRepsRef.current = [];
    countedRepsRef.current = 0;
    missedFlashAtRef.current = 0;
    samplesRef.current = [];
    repFramesRef.current = [];
    latestMetricsRef.current = null;
    coordinatorRef.current.resetSet();
    lockAngleRef.current = angleEmaRef.current;
    // v2 per-set state.
    leanBaselineRef.current = new BaselineTracker(TRIGGERS.baselineReps);
    descentBaselineRef.current = new BaselineTracker(TRIGGERS.baselineReps);
    shiftBaselineRef.current = new BaselineTracker(TRIGGERS.baselineReps);
    visBaselineRef.current = new BaselineTracker(TRIGGERS.baselineReps);
    stanceWidthRef.current = null;
    footAngleRef.current = null;
    contextByRepRef.current = new Map();
    triggerMomentRef.current = new Map();
    postSetFrameArchiveRef.current = { baseline: [], faults: new Map() };
    resetRepTriggers();
    // Push-up per-set engine (built for every set; only fed frames on push-up workouts).
    pushupSessionRef.current = new PushupSetSession({
      setIndex: setIndexRef.current,
      orientation,
      depthPreset: pushupPresetRef.current,
      variant: pushupVariantRef.current,
      getLandmarkWindow: (startMs, endMs) => landmarkBufferRef.current.getWindow(startMs, endMs),
    });
    pushupCoordinatorRef.current.resetSet();
  }

  /** Reset the per-rep v2 trigger state (called when a rep arms). */
  function resetRepTriggers(): void {
    eccentricRef.current.reset();
    leanGateRef.current.reset();
    valgusGateRef.current.reset();
    firedThisRepRef.current = new Set();
    maxLeanDeepRef.current = null;
    peakLeanDepthRatioRef.current = 0;
    earlyLeanRef.current = false;
  }

  /** Map our depth-preset id to the spec's label ("above" → "above_parallel"). */
  function specPreset(p: DepthPreset): string {
    return p === "above" ? "above_parallel" : p;
  }

  /** The front-view depth-ratio target for the active preset (`full` reuses parallel). */
  function frontTargetForSet(): number {
    return depthPresetRef.current === "above" ? SQUAT.frontRatioTarget.above : SQUAT.frontRatioTarget.parallel;
  }

  /** Record the moment a trigger fired for a rep (first onset wins — the descent
   *  trigger fires before the rep-complete eccentric one, and it's the deeper,
   *  more representative moment). Read back by fireCoaching to tag + archive the fault frame
   *  at the onset instant (not the later flush moment). */
  function captureTriggerMoment(repIndex: number, m: { timestampMs: number; depthRatio: number; trunkAngleDeg: number | null; valgusRatio: number | null }): void {
    const key = `${setIndexRef.current}:${repIndex}`;
    if (!triggerMomentRef.current.has(key)) triggerMomentRef.current.set(key, m);
  }

  /** Pull the ring frame closest to `ts` (within ±300ms, the capture cadence) — the frame that
   *  best represents that instant. null if the ring has nothing near it (e.g. a capture gap). */
  function ringFrameNear(ts: number): ImageFrame | null {
    const near = imageBufferRef.current.getFramesAround(ts, 300, 300);
    if (!near.length) return null;
    return near.reduce((a, b) => (Math.abs(b.timestampMs - ts) < Math.abs(a.timestampMs - ts) ? b : a));
  }

  /** Archive a baseline key frame (rep 1 or 2 bottom) by TIME, at rep-complete, while it is still
   *  fresh in the ring. This is the ONLY baseline-frame source post-set uses — the ring evicts
   *  these 5-12s before post-set fires (verified n=1, all sets). Captured by time, not repNumber,
   *  which sidesteps the ring's completed-count off-by-one. Deduped by timestamp. */
  function archiveBaselineFrame(bottomTs: number): void {
    const frame = ringFrameNear(bottomTs);
    if (!frame) return;
    const base = postSetFrameArchiveRef.current.baseline;
    if (base.some((f) => f.timestampMs === frame.timestampMs)) return;
    base.push(frame);
  }

  /** Archive the peak-severity frame for a fired trigger — ONE per error TYPE (not per instance):
   *  a later, more-severe occurrence of the same type replaces the stored frame; a milder one is
   *  ignored (direction-aware via tagMoreSevere — valgus lower=worse). This keeps the archive to
   *  "one worst valgus frame per set regardless of how many reps caved", so sending the whole
   *  archive can't blow the cap or add confabulation surface. Frame captured by time (closest to
   *  the onset), stored as a REFERENCE. */
  function archiveFaultFrame(triggerTs: number, faultType: string, severity: number): void {
    const faults = postSetFrameArchiveRef.current.faults;
    const existing = faults.get(faultType);
    if (existing && !tagMoreSevere(faultType, severity, existing.severity)) return; // keep the worse one
    const peak = ringFrameNear(triggerTs);
    if (!peak) return; // no frame available — keep any existing entry rather than wiping it
    faults.set(faultType, { frame: peak, severity });
  }

  /** A mid-set trigger fired: tag the onset frames AND archive the peak frame (per error type)
   *  into the per-set archive. No Gemini call — mid-set cues were removed (12–34s latency on ~40s
   *  sets made them useless); the fault now surfaces in the post-set debrief via the archived
   *  frame. Tagging/archiving run regardless of geminiEnabled() so the dev eval log still shows
   *  which frames each trigger tagged when the API kill-switch is on (offline number tuning); the
   *  frames are only ever SENT when callPostSet fires, which is itself geminiEnabled-gated. The
   *  tag/severity values are byte-identical to the old mid-set path — the captured trigger MOMENT
   *  (at depth), not the later flush instant. */
  function fireCoaching(batch: CoachingBatch): void {
    const faultId = batch.faultChecks[0];
    const faultType = (faultId && METRIC_TO_FAULT[faultId]) || "none";
    // Prefer the captured onset moment (depth/trunk/valgus at the instant the trigger fired)
    // over live state, so the tagged frame + its severity describe when the fault actually fired.
    const moment = triggerMomentRef.current.get(`${batch.setIndex}:${batch.repIndex}`);
    const metrics = latestMetricsRef.current;
    let severity = (faultId && metrics ? metrics[faultId].value : null) ?? 1;
    if (moment) {
      if (faultId === "forwardLean" && moment.trunkAngleDeg !== null) severity = moment.trunkAngleDeg;
      else if (faultId === "kneeValgus" && moment.valgusRatio !== null) severity = moment.valgusRatio;
    }
    const triggerTs = Math.round(moment?.timestampMs ?? performance.now());
    imageBufferRef.current.tagFrames(triggerTs, faultType, severity);
    archiveFaultFrame(triggerTs, faultType, severity);
  }

  /** Push-up counterpart of fireCoaching: tag + archive the onset frame of EVERY fault in the batch,
   *  each from the moment the session recorded for it. All push-up severities are higher-is-worse,
   *  which is also tagMoreSevere's rule for fault types outside the squat's metric map. */
  function firePushupCoaching(batch: CoachingBatch<PushupMetricId>): void {
    const session = pushupSessionRef.current;
    if (!session) return;
    for (const metric of batch.faultChecks) {
      const moment = session.momentFor(batch.repIndex, metric);
      if (!moment) continue;
      const ts = Math.round(moment.timestampMs);
      imageBufferRef.current.tagFrames(ts, moment.faultType, moment.severity);
      archiveFaultFrame(ts, moment.faultType, moment.severity);
    }
  }

  /** Worst (max |value|) among the reps where `id` warned, else null. */
  function worstWarn(reps: RepRecord[], id: MetricId): number | null {
    const vals = reps.filter((r) => r.metrics[id].status === "warn").map((r) => r.metrics[id].value).filter((v): v is number => v !== null);
    return vals.length ? Math.max(...vals.map((v) => Math.abs(v))) : null;
  }

  /** Store a post-set response. Shared by both exercises (the handling is identical). */
  function onPostSetText(setIndex: number, text: string | null): void {
    if (text) {
      coachLogRef.current = [...coachLogRef.current, { timestampMs: Date.now(), kind: "post_set", text }];
      postSetBySetRef.current.set(setIndex, { status: "ok", text });
      console.info("[coach] post-set:", text);
    } else {
      // No usable analysis. Distinguish "the usage cap refused it" from a generic
      // failure — a limit the user can't see just looks like the app is broken.
      // The gate lives in gemini.ts (so the refusal is recorded in the ledger);
      // we only re-read the verdict here to pick the right message.
      const v = quota("post_set");
      postSetBySetRef.current.set(
        setIndex,
        v.allowed ? { status: "none" } : { status: "blocked", message: quotaMessage(v) },
      );
    }
  }

  /** Push-up post-set: the payload comes from the pure builder (plane-nulling, disarmed checks and
   *  the prompt↔payload contract are unit-tested in check:pushup). */
  function firePushupPostSet(): void {
    const set = pushupSetsRef.current[pushupSetsRef.current.length - 1];
    if (!set || set.reps.length === 0) return;
    if (!geminiEnabled()) {
      postSetBySetRef.current.set(set.index, { status: "disabled" });
      return;
    }
    const archive = postSetFrameArchiveRef.current;
    const archiveFrames: ImageFrame[] = [...archive.baseline, ...[...archive.faults.values()].map((x) => x.frame)];
    const data = buildPushupPostSetData(set, { baselineFramesIncluded: archive.baseline.length });
    postSetBySetRef.current.set(set.index, { status: "loading" });
    callPostSet(data, archiveFrames, (text) => onPostSetText(set.index, text));
  }

  /** Post-set debrief for the set that just ended (blocking-ok Gemini call). */
  function firePostSet(): void {
    if (exerciseRef.current === "pushup") return firePushupPostSet();
    const set = completedSetsRef.current[completedSetsRef.current.length - 1];
    if (!set || set.reps.length === 0) return; // no reps → no review entry (screen shows "no reps")
    if (!geminiEnabled()) {
      postSetBySetRef.current.set(set.index, { status: "disabled" });
      return;
    }
    const reps = set.reps;
    const counted = reps.filter((r) => r.counted).length;
    // Single source of truth for depth misses. Every uncounted rep is a depth miss — a rep
    // only fails to count by missing the depth gate (side: hip-vs-knee gap; front: depthRatio).
    // depth_misses, depth_context.miss_count, and uncounted_reps below ALL derive from this one
    // list, so they cannot disagree. (Old side-only hardcode reported 0 misses on front sets
    // while uncounted_reps still listed the missed rep — a contradiction to the model.)
    const uncounted = reps.filter((r) => !r.counted);
    const depthMisses = uncounted.length;
    // Tier-2: reps whose landmarks are untrustworthy don't contribute their CONTEXT numbers
    // (a tracking failure must not become a form finding). They still count and still appear in
    // uncounted_reps — only the context metrics are withheld.
    const reliableReps = reps.filter((r) => !r.landmarkUnreliable);

    // Per-set baselines, read AFTER the set. Safe to read here only because recording is now
    // confined to the warm-up window (see onRepComplete): the value below is the SAME one the
    // triggers were checked against, not one a late rep completed afterwards.
    const leanBase = leanBaselineRef.current.baseline();
    const descentBase = descentBaselineRef.current.baseline();
    const shiftBase = shiftBaselineRef.current.baseline();
    /** How many times its own per-set baseline a fault reached — the number that makes severity
     *  language scale. Without it "critical" is flat: set 4's 0.32 and 0.66 shifts were BOTH past
     *  the critical band, and the debrief called the 2.6× one "slightly off-center". Null where a
     *  fault has no baseline (valgus is an absolute knee/ankle ratio). */
    function baselineMultiple(id: MetricId, peak: number | null): number | null {
      const base = id === "forwardLean" ? leanBase : id === "hipShift" ? shiftBase : null;
      if (base === null || peak === null || base <= 0) return null;
      return peak / base;
    }

    const faultIds: MetricId[] = ["forwardLean", "kneeValgus", "eccentricControl"];
    const triggers_fired: PostSetData["triggers_fired"] = [];
    for (const id of faultIds) {
      // Source each fault from the layer that ACTUALLY decided it. T1/T7 are gated per-frame
      // predicates behind a 150ms persistence window, so their truth is `triggeredMetrics` —
      // NOT the metric warn, which is an ungated worst-of-frames comparison. The two diverged
      // on set 2 rep 6 (metric 0.523 warn, T7 correctly silent) and the payload asserted a
      // valgus trigger, with no archived frame, that the trigger layer had rejected.
      // eccentricControl is the exception: `evalEccentric` runs once at rep-complete and IS
      // its own trigger, so its metric status is the right source.
      const warned = reps.filter((r) =>
        id === "eccentricControl" ? r.metrics[id].status === "warn" : r.triggeredMetrics.includes(id),
      );
      if (!warned.length) continue;
      // ONE fault-type string drives both the label and the peak's direction, so they can't drift.
      const type = METRIC_TO_FAULT[id] ?? id;
      const values = warned.map((r) => r.metrics[id].value).filter((v): v is number => v !== null);
      // Direction-aware via peakSeverity → tagMoreSevere (valgus: LOWER ratio = more caved).
      // The old Math.max reported the MILDEST cave as the valgus peak, contradicting the
      // archived peak photo. Dropping Math.abs is a no-op: all these values are non-negative.
      const peak = peakSeverity(type, values);
      triggers_fired.push({
        type,
        sub_signal: null,
        rep_numbers: warned.map((r) => r.index),
        peak_severity_ratio: peak ?? 0,
        // Magnitude the model is allowed to use, so its language scales with the fault.
        severity: severityFor(id, "warn", peak),
        baseline_multiple: baselineMultiple(id, peak),
      });
    }
    // T11 lateral shift fires baseline-relative (RepRecord.shiftTriggered), not the absolute
    // warn — surface it as a FINDING so a genuine shift reaches the coach as a fired trigger,
    // not a bare context number it has to interpret (the latent gap from the eval review).
    // Front-only (shiftTriggered is always false on side). Garbage reps can't reach here: an
    // implausible shift is nulled to "unknown" upstream, so shiftTriggerActive returned false.
    const shiftReps = reliableReps.filter((r) => r.shiftTriggered);
    if (shiftReps.length) {
      // NOTE: lateral_shift never calls fireCoaching, so it is numeric-only — no archived frame.
      const shiftType = METRIC_TO_FAULT.hipShift ?? "lateral_shift";
      const shiftValues = shiftReps.map((r) => r.metrics.hipShift.value).filter((v): v is number => v !== null);
      const shiftPeak = peakSeverity(shiftType, shiftValues);
      triggers_fired.push({
        type: shiftType,
        sub_signal: null,
        rep_numbers: shiftReps.map((r) => r.index),
        peak_severity_ratio: shiftPeak ?? 0,
        severity: severityFor("hipShift", "warn", shiftPeak),
        baseline_multiple: baselineMultiple("hipShift", shiftPeak),
      });
    }
    // Reliable reps only — a garbage rep's velocity ratio (e.g. a bogus 1.5 spike) shouldn't
    // set the set's worst-case collapse.
    const velCollapse = reliableReps.reduce<number | null>((m, r) => {
      const rr = r.velocity?.ratio ?? null;
      return rr === null ? m : m === null ? rr : Math.min(m, rr);
    }, null);

    // Payload honesty: null the plane this set's view can't see (matches the prompt).
    // Explicit gate (not "happens to be null via tolerance") so it stays absent even if a
    // frontal check's tolerance is loosened or a jittery body crosses warn on a side set.
    const onFrontSet = set.orientation === "front";
    const onSideSet = set.orientation === "side";
    // The ENTIRE per-set archive is what post-set sees: baseline (reps 1-2 bottom) + one peak
    // frame per error type. Flatten to a frame list; the ring is NOT consulted (baseline + early
    // faults are long evicted). baseline_frames_included tells the model how many baseline frames
    // it actually got (0 ⇒ rule 1 must say "no baseline available", never fabricate).
    const archive = postSetFrameArchiveRef.current;
    const archiveFrames: ImageFrame[] = [...archive.baseline, ...[...archive.faults.values()].map((x) => x.frame)];
    // Which baseline-relative checks could NOT run this set. A baseline fails to resolve when a
    // warm-up rep misses the depth-hygiene gate, and the affected triggers are then disarmed for
    // the whole set — they do not fire, and their silence means NOTHING. Without this the model
    // reads an empty triggers_fired as "clean": on 2026-08-02 set 3 it called a set containing a
    // 59.3° lean "spinal alignment and balance remained solid, no movement faults triggered".
    // Only checks this VIEW could have run are listed (matches the payload-honesty rule — naming
    // a disarmed frontal check on a side set would imply it was ever in play).
    const checks_disarmed: string[] = [];
    if (onSideSet && leanBase === null) checks_disarmed.push("forward lean");
    if (descentBase === null) checks_disarmed.push("descent control");
    if (onFrontSet && shiftBase === null) checks_disarmed.push("lateral hip shift");
    const data: PostSetData = {
      call_type: "post_set",
      set_summary: { set_number: set.index, orientation: set.orientation, total_reps_attempted: reps.length, total_reps_counted: counted, depth_misses: depthMisses },
      baseline_frames_included: archive.baseline.length,
      baseline: {
        trunk_angle_deg: onFrontSet ? null : leanBase, // SAGITTAL — invisible front-on
        descent_velocity: descentBase, // agnostic (hip-Y)
        // `valid` is about the NUMERIC baseline (did reps 1-2 calibrate?), which is a different
        // question from baseline_frames_included (did we keep their PHOTOS?). A set can have both
        // photos and no usable baseline — that is exactly the case that misled the model.
        valid: checks_disarmed.length === 0,
        checks_disarmed,
      },
      triggers_fired,
      // Context — informs synthesis but is NOT a finding (see POSTSET_SYSTEM). levelness +
      // knee_symmetry were REMOVED entirely: demoted, structurally unreliable — not context,
      // noise (shipping them let the model headline a garbage 19° tilt). The two kept fields
      // are real signals: lateral_trunk_shift (T11's raw worst-warn number; the FIRING is now
      // in triggers_fired) and velocity_collapse (T6, deliberately silent). Reliable reps only;
      // lateral shift is FRONTAL so it's nulled on side sets.
      context: {
        lateral_trunk_shift_normalized: onSideSet ? null : worstWarn(reliableReps, "hipShift"),
        velocity_collapse_ratio: velCollapse, // agnostic (hip-Y)
        // The ratio STAYS (rule 3a's fatigue gate is defined on it), but the prompt forbids
        // quoting it — "a velocity collapse ratio of 0.80" is not something a lifter can act on.
        // This band is the sayable form of the same number.
        velocity_band: velocityBand(velCollapse),
        // Per-rep ratios so a fatigue claim can be ATTRIBUTED rather than guessed. The single
        // session-minimum above carries no rep identity, and the model duly localised fatigue
        // to reps that had sped up (set 2 rep 6 read 1.18). Reliable reps only.
        velocity_ratios_by_rep: reliableReps
          .map((r) => ({ rep_number: r.index, ratio: r.velocity?.ratio ?? null }))
          .filter((x): x is { rep_number: number; ratio: number } => x.ratio !== null),
      },
      depth_context: {
        preset: specPreset(depthPresetRef.current),
        preset_reason: "preference",
        miss_count: depthMisses,
        // The measure that DECIDES counting in this view — gap vs targetGap on side, ratio vs
        // frontRatioTarget on front. Sending the agnostic ratio on side sets made the gate look
        // self-contradictory (set 3 rep 5 failed at ratio 0.688 while rep 1 counted at 0.658).
        depth_basis: onSideSet ? ("hip_knee_gap" as const) : ("depth_ratio" as const),
        depth_target: onSideSet ? DEPTH_PRESETS[depthPresetRef.current].targetGap : frontTargetForSet(),
        achieved_depth: reps
          .map((r) => (onSideSet ? r.depthGap : r.depthRatio))
          .filter((v): v is number => v !== null),
      },
      // Depth-failed (uncounted) reps, flagged so Gemini can coach a cut-short rep that would
      // otherwise vanish behind the counted-only totals. `measured`/`target` are in the basis
      // named by depth_context.depth_basis, so the number shown is the one that failed the rep.
      // `band` is how far short in WORDS. The raw measured/target stay for auditability, but the
      // prompt only lets the model speak the band: "-0.0023 against your target of 0" is a
      // normalized image coordinate that reads to a lifter like a rounding error, when what
      // actually happened is they missed parallel by a hair.
      uncounted_reps: uncounted.map((r) => {
        const measured = onSideSet ? r.depthGap : r.depthRatio;
        const target = onSideSet ? DEPTH_PRESETS[depthPresetRef.current].targetGap : frontTargetForSet();
        return {
          rep_number: r.index,
          counted: false as const,
          reason: "depth_miss" as const,
          measured,
          target,
          band: depthShortfallBand(measured, target, onSideSet ? "hip_knee_gap" : "depth_ratio"),
        };
      }),
      load_mode: modeRef.current,
      delivery: { tone: "encouraging", verbosity: "detailed", user_name: "" },
    };
    // Mark loading BEFORE the async call so an End Set that lands mid-flight shows a spinner.
    postSetBySetRef.current.set(set.index, { status: "loading" });
    // Send the whole archive. callPostSet extracts the JPEGs SYNCHRONOUSLY, so the per-set reset
    // in newSetTrackers (which only runs later, on Next set / next countdown) can't affect it.
    callPostSet(data, archiveFrames, (text) => onPostSetText(set.index, text));
  }

  /** Dev-only: fire the one-shot auto-export exactly once. Called when the async
   *  post-workout Gemini call resolves (so its observation is already logged), or
   *  by the interval backstop. Guarded by evalExportedRef to avoid a double file. */
  function maybeExportEval(): void {
    if (!DEV_EVAL_LOG || evalExportedRef.current) return;
    evalExportedRef.current = true;
    downloadEvalLog();
  }

  /** Store the post-workout response. Shared by both exercises. */
  function onPostWorkoutText(text: string | null): void {
    if (text) {
      coachLogRef.current = [...coachLogRef.current, { timestampMs: Date.now(), kind: "post_workout", text }];
      analysisRef.current = { status: "ok", text };
      console.info("[coach] post-workout:", text);
    } else {
      // No summary came back. Resolve the loading state finishWorkout set — never spin
      // forever. Distinguish "the usage cap refused it" from a generic empty/error, the
      // same way the post-set tier does: a limit the user can't see just looks broken.
      // The gate itself lives in gemini.ts (so the refusal is recorded in the ledger);
      // we only re-read the verdict here to pick the right message.
      const v = quota("post_workout");
      analysisRef.current = v.allowed ? { status: "idle" } : { status: "error", message: quotaMessage(v) };
    }
    // The post-workout observation is now recorded (gemini.ts emits it before this
    // callback on every path — success/no_cue/skip/error). Export NOW so the file
    // includes it; its ~15 s latency previously outran the finish+12 s auto-export.
    maybeExportEval();
  }

  /** Push-up post-workout: pure builder over the push-up set records + stored debriefs. */
  function firePushupPostWorkout(): void {
    const sets = pushupSetsRef.current.filter((s) => s.reps.length > 0);
    if (!sets.length) return;
    const debriefs: { set_number: number; orientation: string; text: string }[] = [];
    for (const s of sets) {
      const review = postSetBySetRef.current.get(s.index);
      if (review?.status === "ok") debriefs.push({ set_number: s.index, orientation: s.orientation, text: review.text });
    }
    const data = buildPushupPostWorkoutData(sets, debriefs);
    analysisRef.current = { status: "loading" };
    callPostWorkout(data, onPostWorkoutText);
  }

  /** Post-workout summary over the whole session (blocking-ok Gemini call). */
  function firePostWorkout(): void {
    if (!geminiEnabled()) return;
    if (exerciseRef.current === "pushup") return firePushupPostWorkout();
    const sets = completedSetsRef.current.filter((s) => s.reps.length > 0);
    if (!sets.length) return;
    const totalCounted = sets.reduce((n, s) => n + s.reps.filter((r) => r.counted).length, 0);
    const totalAttempted = sets.reduce((n, s) => n + s.reps.length, 0);

    // shoulderHipLevelness + kneeSymmetry DEMOTED to context-only, so neither is a fault trend.
    // Pure + unit-tested (session/faultTrends.ts): each fault reads the layer that decided it,
    // `sets_observable` keeps a side-only fault from reading as "gone" in a front set, and
    // `co_occurred_with_slowing` replaced `worsened_with_fatigue`, which only ever meant
    // "present in the last set" while the prompt treated it as the fatigue authority.
    const fault_trends: PostWorkoutData["fault_trends"] = squatFaultTrends(sets).map(({ id, ...trend }) => ({
      type: METRIC_TO_FAULT[id] ?? id,
      ...trend,
    }));
    const missRate = totalAttempted ? (totalAttempted - totalCounted) / totalAttempted : 0;

    // Per-set debrief texts — the primary input now that post-workout is text-only. Pulled from
    // the responses callPostSet ALREADY stored in postSetBySetRef (never a new call); only sets
    // whose debrief resolved "ok" contribute. The last set has no post-set (it ends via End
    // Workout, which goes straight to post-workout), so it is naturally absent here — the numeric
    // trends below still cover it. Each debrief is already view-constrained by its own tier, so
    // the text-only post-workout synthesizes over them without re-observing anything.
    const per_set_debriefs: PostWorkoutData["per_set_debriefs"] = [];
    for (const s of sets) {
      const review = postSetBySetRef.current.get(s.index);
      if (review?.status === "ok") per_set_debriefs.push({ set_number: s.index, orientation: s.orientation, text: review.text });
    }

    const data: PostWorkoutData = {
      call_type: "post_workout",
      session_summary: { total_sets: sets.length, total_reps_counted: totalCounted, total_reps_attempted: totalAttempted, orientations: [...new Set(sets.map((s) => s.orientation))] },
      per_set_debriefs,
      fault_trends,
      cross_set_metrics: {
        // null (not 1) for a set with no measured velocity — "no data" must not read as "no slowing".
        velocity_degradation_per_set: velocityDegradationPerSet(sets),
        depth_consistency: missRate < 0.1 ? "good" : missRate < 0.3 ? "variable" : "poor",
        // asymmetry_trend removed: it was a hardcoded "stable" — a false assertion sent
        // to the model as if measured, worse than an absent field.
      },
      // Per-entry basis: a session mixes side and front sets, and each gates counting on a
      // different measure (hip-vs-knee gap vs depth ratio). Sending one shared unit made the
      // gate look inconsistent across sets.
      uncounted_reps: sets.flatMap((s) => {
        const sideSet = s.orientation === "side";
        return s.reps
          .filter((r) => !r.counted)
          .map((r) => ({
            set_number: s.index,
            rep_number: r.index,
            counted: false as const,
            reason: "depth_miss" as const,
            measured: sideSet ? r.depthGap : r.depthRatio,
            target: sideSet ? DEPTH_PRESETS[depthPresetRef.current].targetGap : frontTargetForSet(),
            basis: sideSet ? ("hip_knee_gap" as const) : ("depth_ratio" as const),
          }));
      }),
      load_mode: modeRef.current,
      delivery: { tone: "encouraging", verbosity: "detailed", user_name: "" },
    };
    // Loading state for the report's summary slot, set only now that the call is actually
    // being made (past the geminiEnabled / has-reps guards), so it can never stick.
    analysisRef.current = { status: "loading" };
    callPostWorkout(data, onPostWorkoutText);
  }

  /** Evaluate one frame's geometry against the locked orientation (no velocity).
   *  `depthRatio` is passed so per-frame frontal metrics can gate themselves out near
   *  lockout, where their geometry degenerates (see hipShiftCheck). */
  function evalFrame(frame: SquatFrame, depthRatio: number): RepMetrics {
    return evaluateRep({
      frame,
      orientation: targetRef.current,
      facingAngleDeg: angleEmaRef.current,
      velocity: null,
      cfg: SQUAT,
      depthPreset: depthPresetRef.current,
      depthRatio,
    });
  }

  function onRepComplete(rep: SquatRep): void {
    const orientation = targetRef.current;
    const angle = angleEmaRef.current;
    const sample = velocityRef.current.add(rep.index, rep.concentricVelocity, {
      concentricSec: rep.concentricSec,
      eccentricSec: rep.eccentricSec,
    });
    samplesRef.current = [...samplesRef.current, sample];

    // Bottom-frame verdict carries velocity / depth / heel rise; worst-of across
    // the rep's frames upgrades the "throughout" faults (valgus, levelness,
    // forward lean) so a fault anywhere in the rep is recorded.
    const base = evaluateRep({
      frame: rep.bottom,
      orientation,
      facingAngleDeg: angle,
      velocity: { measured: sample.velocity > 0, degraded: sample.degraded, ratio: sample.ratio },
      cfg: SQUAT,
      depthPreset: depthPresetRef.current,
    });
    const metrics = aggregateRep(base, repFramesRef.current);

    // --- T2 eccentric control: finalize the descent's two sub-signals ---
    const descentSpeed = eccentricRef.current.descentSpeed();
    const reversalMs = eccentricRef.current.reversalMs();
    const warmedUp = rep.index > TRIGGERS.baselineReps;
    // Baselines IN EFFECT for this rep — captured BEFORE this rep's values fold in,
    // so the eval log pairs each metric with the threshold it was actually checked against.
    const leanBaselineVal = leanBaselineRef.current.baseline();
    const descentBaselineVal = descentBaselineRef.current.baseline();
    const shiftBaselineVal = shiftBaselineRef.current.baseline();
    // Depth geometry is hoisted ABOVE the eccentric block: `evalEccentric` now needs to know
    // whether the rep reached depth (the bounce sub-signal is meaningless on a rep with no
    // bottom), and the baseline-hygiene gate below needs it too.
    // Baseline hygiene: only a rep that reached a real bottom (bottom hip-vs-knee gap
    // meaningfully past the active preset's depth target) may calibrate the per-set baselines.
    // A settle/hinge rep — hips barely to knee level despite a big lean — must not poison them
    // (Set 5 reps 1-2, gap 0.004/0.007, fed a 58° lean baseline that killed T1 for the whole
    // set). The rep STILL counts and STILL advances warm-up (option-4); only calibration is
    // withheld. Gated on gap-past-target, NOT depthRatio (the corrupt reps had NORMAL
    // displacement 0.67/0.77).
    const bottom = rep.bottom;
    const bottomGap = bottom.hipMid && bottom.kneeMid ? bottom.hipMid[1] - bottom.kneeMid[1] : null;
    const targetGap = DEPTH_PRESETS[depthPresetRef.current].targetGap;
    const feedsBaseline = repFeedsBaseline(bottomGap, targetGap, SQUAT.baselineMinDepthRel);
    // Front counting target (distance-invariant depthRatio, per preset). Only above/parallel
    // are calibrated; `full` reuses the parallel target as its floor.
    const frontRatioTarget =
      depthPresetRef.current === "above" ? SQUAT.frontRatioTarget.above : SQUAT.frontRatioTarget.parallel;
    const counted = repCounts(orientation, bottomGap, targetGap, rep.bottomDepthRatio, frontRatioTarget);

    if (warmedUp) {
      const ecc = evalEccentric(descentSpeed, descentBaselineVal, reversalMs, counted);
      metrics.eccentricControl = { ...ecc, severity: severityFor("eccentricControl", ecc.status, ecc.value) };
    }

    // Record the reps-1–2 baselines. TWO gates, both required:
    //   `feedsBaseline` — depth hygiene (a settle/hinge rep must not calibrate anything).
    //   `inBaselineWindow` — the rep must BE a warm-up rep. BaselineTracker only caps the
    //     sample COUNT, so without this a late rep silently completes the baseline: on
    //     2026-08-02 set 3, rep 1 failed hygiene and rep 6 became sample #2, resolving the
    //     baseline on the last rep of the set — after every trigger had already run against
    //     null. The trigger layer reported "no baseline" while the payload reported 26.9°.
    //     Triggers arm at `rep.index > baselineReps`, so the recording window must be its
    //     exact complement or the two layers describe different sets.
    // Consequence, deliberate: if a warm-up rep fails hygiene the baseline never resolves and
    // the dependent checks stay disarmed for the WHOLE set. That is reported to the user via
    // `baseline.valid` / `checks_disarmed` rather than passing as a clean set.
    const inBaselineWindow = rep.index <= TRIGGERS.baselineReps;
    const calibrates = feedsBaseline && inBaselineWindow;
    if (calibrates && maxLeanDeepRef.current !== null) leanBaselineRef.current.record(maxLeanDeepRef.current);
    if (calibrates && descentSpeed !== null) descentBaselineRef.current.record(descentSpeed);

    // --- T11 lateral-shift trigger: baseline-relative + scored (mirrors T1 lean) ---
    // The absolute hipShift metric warn is kept for display + Gemini context; this per-rep
    // flag decides FIRING off the per-set baseline, so neutral baseline reps aren't flagged.
    // `shiftBaselineVal` was captured before this rep folds in (null during warm-up ⇒ the
    // predicate returns false). Front-view only. (T10 knee-symmetry is demoted — no flag.)
    const shiftVal = metrics.hipShift.value;
    if (calibrates && shiftVal !== null) shiftBaselineRef.current.record(shiftVal);
    const shiftTriggered = warmedUp && orientation === "front" && shiftTriggerActive(shiftVal, shiftBaselineVal);

    // --- Butt wink (mode-dependent, not directly measurable) ---
    const leanConcentratedDeep = peakLeanDepthRatioRef.current > TRIGGERS.buttWink.peakLeanDepth && maxLeanDeepRef.current !== null;
    if (modeRef.current === "loaded" && earlyLeanRef.current) {
      // Loaded: early-onset lean is the only butt-wink variant the evidence supports.
      const bw: MetricResult = { metric: "buttWink", status: "warn", severity: "warning", message: "Early-onset lean before parallel (loaded) — watch lower-back rounding", value: 1 };
      metrics.buttWink = bw;
    }

    repFramesRef.current = [];
    latestMetricsRef.current = metrics;

    // Counting policy: side gates on depth (bottom hip-vs-knee gap vs the active preset),
    // front on the movement floor. Attempts that don't count are still recorded so the report
    // can show "depth-met / attempts". The live header counter only ticks for counted reps.
    // (`counted` / `frontRatioTarget` are computed with the depth geometry hoisted above,
    // because the eccentric bounce gate needs them.)
    if (counted) countedRepsRef.current += 1;
    else if (orientation === "side") missedFlashAtRef.current = nowSec();

    const excessiveDepthLoaded = modeRef.current === "loaded" && rep.bottomDepthRatio > TRIGGERS.excessiveDepth.loadedMaxRatio;

    // --- Tier-2 landmark reliability (co-degradation signature) -----------------
    // A single MediaPipe frame can misplace a joint while still reporting above-floor
    // visibility (set 4 reps 7/8: min-vis 0.635/0.654 > MIN_VISIBILITY, yet hip drift read
    // 2.3). Per-field physical bounds (checks.ts) reject the OUT-OF-range blowouts and stop
    // them firing T7/T11; this rep-level flag additionally distrusts the IN-range fields that
    // co-occur with a failure (the 19° tilt on the same garbage rep) by flagging the rep when
    // near-side visibility collapses vs the set baseline OR any field is physically impossible.
    // Flagged reps are NOT dropped (rep 8 was a legit depth miss) — only their context metrics
    // are withheld downstream. `visBaselineVal` is read BEFORE this rep folds in (mirrors the
    // lean/shift baselines) → null during warm-up, so early reps rely on the implausibility arm.
    const repStartMs = rep.startT * 1000;
    const repEndMs = rep.endT * 1000;
    const repWindow = landmarkBufferRef.current.getWindow(repStartMs, repEndMs);
    const repMinVis = repWindowMinVisibility(repWindow, orientation);
    const visBaselineVal = visBaselineRef.current.baseline();
    const landmarkUnreliable =
      (visBaselineVal !== null && repMinVis !== null && repMinVis < visBaselineVal * TIER2_VIS_DROP_RATIO) ||
      landmarkImplausible(rep.bottom, orientation);
    // Same baseline-hygiene gate as lean/descent/shift: a settle/hinge rep must not seed the vis
    // baseline either — otherwise a low garbage min-vis lowers the floor so the drop test can't
    // fire (the Set 5 self-corruption). Gating here means the vis baseline builds from real reps.
    if (calibrates && repMinVis !== null) visBaselineRef.current.record(repMinVis);

    const record: RepRecord = {
      index: rep.index,
      metrics,
      velocity: sample,
      bottomKneeAngle: rep.bottomKneeAngle,
      counted,
      depthRatio: rep.bottomDepthRatio,
      depthGap: bottomGap,
      // Snapshot the MID-SET triggers that actually fired this rep (T1/T7). Still valid here:
      // resetRepTriggers() runs when the NEXT rep arms, not at completion.
      triggeredMetrics: [...firedThisRepRef.current],
      shiftTriggered,
      landmarkUnreliable,
      coaching: null,
    };
    liveRepsRef.current = [...liveRepsRef.current, record];

    // Archive the reps 1-2 bottom key frames for the post-set baseline assessment (rule 1).
    // Done here, at rep-complete, while the bottom frame is still in the ring — post-set fires
    // 30+s later, long after the ~7.5s ring evicted it. These reps fire no trigger, so this is
    // the ONLY thing that captures them. ALWAYS, regardless of counted/clean/reliable — the
    // model assesses the image; a poor/occluded baseline is honest signal, not a reason to skip.
    if (rep.index <= TRIGGERS.baselineReps) archiveBaselineFrame(rep.bottomT * 1000);

    // Build the per-rep v2 context (post-set summary + report). The mid-set cue
    // builds its own live context at fire time (timing differs).
    contextByRepRef.current.set(`${setIndexRef.current}:${rep.index}`, {
      ...emptyContext(setIndexRef.current, rep.index, orientation, modeRef.current, depthPresetRef.current),
      phaseOfRep: "bottom",
      depthGap: bottomGap,
      depthMet: counted,
      shinAngleDeg: bottom.shinAngleDeg,
      stanceWidthRatio: stanceWidthRef.current,
      footAngleDeg: footAngleRef.current,
      levelnessDiffDeg: metrics.shoulderHipLevelness.value,
      kneeAsymmetry: metrics.kneeSymmetry.value,
      lateralShiftRatio: metrics.hipShift.value,
      velocityRatio: sample.ratio,
      velocityCollapsed: sample.collapsed,
      leanConcentratedDeep,
      earlyLeanOnset: earlyLeanRef.current,
      excessiveDepthLoaded,
      baselineReady: leanBaselineRef.current.ready() || descentBaselineRef.current.ready(),
    });

    // T2 eccentric fires a mid-set cue (after warm-up) once the descent is known.
    // It's evaluated at rep-complete (standing), so its representative "at depth"
    // moment is the BOTTOM of the rep — capture that (set-if-absent, so a lean/valgus
    // onset earlier this rep keeps precedence) rather than the standing instant.
    if (warmedUp && metrics.eccentricControl.status === "warn") {
      const bottomValgus =
        rep.bottom.kneeWidth !== null && rep.bottom.ankleWidth !== null && rep.bottom.ankleWidth > 1e-4
          ? rep.bottom.kneeWidth / rep.bottom.ankleWidth
          : null;
      captureTriggerMoment(rep.index, {
        timestampMs: rep.bottomT * 1000,
        depthRatio: rep.bottomDepthRatio,
        trunkAngleDeg: maxLeanDeepRef.current ?? rep.bottom.torsoLean,
        valgusRatio: bottomValgus,
      });
      const imm = coordinatorRef.current.requestTrigger(
        { setIndex: setIndexRef.current, repIndex: rep.index, orientation },
        "eccentricControl",
        nowSec(),
      );
      if (imm) fireCoaching(imm);
    }
    // T6 velocity collapse is CONTEXT ONLY — attach to any pending batch, never fire.
    coordinatorRef.current.attachVelocity({
      rollingAverage: sample.rollingAverage,
      current: sample.velocity,
      pctSlower: sample.ratio !== null ? 1 - sample.ratio : null,
      collapsed: sample.collapsed,
    });

    // --- DEV-ONLY: capture this rep for the workout evaluation log ------------
    // Descriptive snapshot of everything the trigger layer read + which triggers
    // fired. Reads existing values only; never affects rep/metric/trigger logic.
    if (DEV_EVAL_LOG) {
      const b = rep.bottom;
      // Reuse the Tier-2 window + near-side min computed above (same near-side rationale: a
      // whole-body min reads DEGRADED on 100% of side reps because the far side is occluded,
      // so it's restricted to the near side; front uses all 8). Descriptive only.
      // Filter frames by TIME window (start→end of the rep), not repNumber: the image buffer
      // tags in-progress frames with the COMPLETED-rep count (= index−1), so a repNumber match
      // would grab the wrong rep's frames. Time is unambiguous.
      const framesForRep = imageBufferRef.current
        .getAll()
        .filter((f) => f.timestampMs >= repStartMs && f.timestampMs <= repEndMs)
        .map((f) => ({ timestampMs: f.timestampMs, repPhase: f.repPhase, triggerTags: f.triggerTags, jpegBase64: f.jpegBase64 }));
      const valgusRatioBottom =
        b.kneeWidth !== null && b.ankleWidth !== null && b.ankleWidth > 1e-4 ? b.kneeWidth / b.ankleWidth : null;
      logEvalRep({
        set: setIndexRef.current,
        rep: rep.index,
        view: orientation,
        counted,
        phase: {
          descentStartMs: repStartMs,
          bottomMs: rep.bottomT * 1000,
          ascentEndMs: repEndMs,
          eccentricMs: rep.eccentricSec * 1000,
          concentricMs: rep.concentricSec * 1000,
        },
        peakTrunkAngleDeg: maxLeanDeepRef.current,
        bottomTrunkAngleDeg: metrics.forwardLean.value,
        leanBaselineDeg: leanBaselineVal,
        descentSpeed,
        descentBaseline: descentBaselineVal,
        reversalMs,
        ascentVelocity: sample.velocity,
        velocityRatio: sample.ratio,
        velocityCollapsed: sample.collapsed,
        depthRatio: rep.bottomDepthRatio,
        depthGap: bottomGap,
        targetGap,
        frontRatioTarget,
        valgusRatio: valgusRatioBottom,
        leftKneeDev: b.leftKnee && b.leftAnkle ? b.leftKnee[0] - b.leftAnkle[0] : null,
        rightKneeDev: b.rightKnee && b.rightAnkle ? b.rightKnee[0] - b.rightAnkle[0] : null,
        kneeSymmetry: metrics.kneeSymmetry.value,
        hipShift: metrics.hipShift.value,
        levelnessDiff: metrics.shoulderHipLevelness.value,
        shinAngleDeg: b.shinAngleDeg,
        stanceWidthRatio: stanceWidthRef.current,
        footAngleDeg: footAngleRef.current,
        earlyLeanOnset: earlyLeanRef.current,
        leanConcentratedDeep,
        firedMidSet: [...firedThisRepRef.current],
        eccentricFired: metrics.eccentricControl.status === "warn",
        eccentricSubCount: typeof metrics.eccentricControl.value === "number" ? metrics.eccentricControl.value : null,
        mode: modeRef.current,
        shiftTriggered,
        shiftBaseline: shiftBaselineVal,
        minVisibility: repMinVis,
        trackingDegraded: repWindow.length === 0 || (repMinVis !== null && repMinVis < MIN_VISIBILITY),
        landmarkUnreliable,
        fedBaseline: feedsBaseline,
        visBaseline: visBaselineVal,
        metrics,
        landmarks: repWindow,
        frames: framesForRep,
      });
    }
  }

  const onResult = useRef((result: PoseLandmarkerResult, frameSize?: { width: number; height: number }) => {
    if (frameSize && frameSize.width > 0 && frameSize.height > 0) aspectRef.current = frameSize.width / frameSize.height;
    const person = result.landmarks[0] as Landmark[] | undefined;
    if (!person) {
      frameRef.current = null;
      pushupFrameRef.current = null;
      orientRef.current = null;
      return;
    }
    const t = nowSec();
    if (exerciseRef.current === "pushup") {
      onPushupResult(person, t);
      return;
    }
    // Every squat ANGLE (lean, facing score, roll, levelness) is aspect-corrected — see squat/frame.ts.
    const est = estimateOrientation(person, MIN_VISIBILITY, aspectRef.current);
    orientRef.current = est;
    cameraRef.current = estimateCameraAngle(person, MIN_VISIBILITY, aspectRef.current);
    frameRef.current = computeSquatFrame(person, MIN_VISIBILITY, t, aspectRef.current);

    // Smooth the facing angle so a noisy frame can't flip the orientation.
    if (est.facingAngleDeg !== null) {
      angleEmaRef.current =
        angleEmaRef.current === null
          ? est.facingAngleDeg
          : ANGLE_EMA * angleEmaRef.current + (1 - ANGLE_EMA) * est.facingAngleDeg;
    }

    if (phaseRef.current === "active") {
      const tracker = repTrackerRef.current;
      const wasDown = tracker?.isDown ?? false;
      // Accumulate frames during the descent/bottom (worst-of "throughout" faults)
      // and watch each for a fault-severity spike into the critical zone (§3).
      if (wasDown) observeDescentFrame((tracker?.reps ?? 0) + 1, t);
      tracker?.update(frameRef.current); // may complete the rep (consumes repFrames)
      if (tracker && tracker.isDown && !wasDown) {
        // Armed on this frame — reset per-rep trigger state, capture stance once
        // per set (quasi-static), then seed the aggregator with this frame.
        repFramesRef.current = [];
        resetRepTriggers();
        if (stanceWidthRef.current === null && frameRef.current) {
          const f = frameRef.current;
          stanceWidthRef.current =
            f.ankleWidth !== null && f.hipWidth !== null && f.hipWidth > 1e-4 ? f.ankleWidth / f.hipWidth : null;
          footAngleRef.current = f.footAngleDeg;
        }
        observeDescentFrame(tracker.reps + 1, t);
      }
    }

    // Debug-only shoulder–hip calibration log (inert when disabled). Reads
    // existing values; does not affect any metric, rep, or form computation.
    logShoulderHipFrame({
      tMs: t * 1000,
      person,
      depthRatio: repTrackerRef.current?.depthRatio ?? 0,
      trunkAngle: frameRef.current?.torsoLean ?? null,
      phase: phaseRef.current,
      setIndex: setIndexRef.current,
    });

    // --- Gemini frame buffers (spec Part 2): landmarks every frame, an image at
    // most every cadenceMs. Only while a set is live (countdown/active). ---
    if (phaseRef.current === "active" || phaseRef.current === "countdown") {
      feedBuffers(person, t);
    }
  });

  /** Push-up frame path: aspect-corrected geometry → the per-set engine → act on its events. */
  function onPushupResult(person: Landmark[], t: number): void {
    const est = estimatePushupOrientation(person, MIN_VISIBILITY, aspectRef.current);
    orientRef.current = est;
    inPlankRef.current = est.inPlank;
    cameraRef.current = estimateCameraAngle(person, MIN_VISIBILITY, aspectRef.current);
    const nearSide = nearSideRef.current.update(person);
    frameRef.current = null;
    const frame = computePushupFrame(
      person,
      MIN_VISIBILITY,
      t,
      aspectRef.current,
      targetRef.current === "side" ? nearSide : null,
      pushupVariantRef.current,
    );
    pushupFrameRef.current = frame;
    if (est.facingAngleDeg !== null) {
      angleEmaRef.current =
        angleEmaRef.current === null
          ? est.facingAngleDeg
          : ANGLE_EMA * angleEmaRef.current + (1 - ANGLE_EMA) * est.facingAngleDeg;
    }
    const session = pushupSessionRef.current;
    if (phaseRef.current === "active" && session) handlePushupEvents(session.onFrame(frame, t, angleEmaRef.current), t);
    if (phaseRef.current === "active" || phaseRef.current === "countdown") feedBuffers(person, t);
  }

  /** Act on one frame's push-up engine events: trigger requests, baseline frames, counters, eval log. */
  function handlePushupEvents(ev: PushupFrameEvents, t: number): void {
    const orientation = targetRef.current;
    for (const f of ev.fired) {
      const imm = pushupCoordinatorRef.current.requestTrigger({ setIndex: setIndexRef.current, repIndex: f.repIndex, orientation }, f.metric, t);
      if (imm) firePushupCoaching(imm);
    }
    // Warm-up bottom frames, archived while still in the ring (same reason as the squat).
    for (const ts of ev.baselineFrameTs) archiveBaselineFrame(ts);
    for (const rec of ev.completed) {
      if (rec.velocity) {
        samplesRef.current = [...samplesRef.current, rec.velocity];
        // T6 velocity collapse stays context only — attached, never fired.
        pushupCoordinatorRef.current.attachVelocity({
          rollingAverage: rec.velocity.rollingAverage,
          current: rec.velocity.velocity,
          pctSlower: rec.velocity.ratio !== null ? 1 - rec.velocity.ratio : null,
          collapsed: rec.velocity.collapsed,
        });
      }
      if (rec.counted) {
        countedRepsRef.current += 1;
      } else {
        // Both views gate push-up counting (depth AND lockout), so both can flash.
        missedFlashAtRef.current = nowSec();
        missedFlashTextRef.current = rec.misses.some((m) => m.reason === "depth_miss")
          ? "Depth not met — no count"
          : "Lockout not reached — no count";
      }
      if (DEV_EVAL_LOG) {
        const lmWindow = landmarkBufferRef.current.getWindow(rec.timing.startMs, rec.timing.endMs);
        logPushupRep({
          set: setIndexRef.current,
          record: rec,
          ctx: { view: orientation, variant: pushupVariantRef.current, depthPreset: pushupPresetRef.current },
          trackingDegraded: lmWindow.length === 0 || (rec.minVisibility !== null && rec.minVisibility < MIN_VISIBILITY),
          landmarks: lmWindow,
          frames: imageBufferRef.current
            .getAll()
            .filter((fr) => fr.timestampMs >= rec.timing.startMs && fr.timestampMs <= rec.timing.endMs)
            .map((fr) => ({ timestampMs: fr.timestampMs, repPhase: fr.repPhase, triggerTags: fr.triggerTags, jpegBase64: fr.jpegBase64 })),
        });
      }
    }
  }

  /** Derive rep phase from the tracker and push to the landmark + image buffers. */
  function feedBuffers(person: readonly Landmark[], t: number): void {
    const tracker = exerciseRef.current === "pushup" ? pushupSessionRef.current?.tracker ?? null : repTrackerRef.current;
    const dr = tracker?.depthRatio ?? 0;
    const isDown = tracker?.isDown ?? false;
    const prev = prevDepthRatioRef.current;
    let phase: RepPhase = "standing";
    if (isDown) phase = dr > prev + 0.01 ? "descent" : dr < prev - 0.01 ? "ascent" : "bottom";
    prevDepthRatioRef.current = dr;

    const repNumber = tracker?.reps ?? 0;
    const tMs = t * 1000;

    const lm: Record<number, { x: number; y: number; visibility: number }> = {};
    const indices = exerciseRef.current === "pushup" ? PUSHUP_BUFFER_LANDMARK_INDICES : BUFFER_LANDMARK_INDICES;
    for (const i of indices) {
      const p = person[i];
      if (p) lm[i] = { x: p.x, y: p.y, visibility: p.visibility };
    }
    landmarkBufferRef.current.add({ timestampMs: tMs, landmarks: lm, depthRatio: dr, repPhase: phase, repNumber, setNumber: setIndexRef.current });

    if (tMs - lastImageCapAtRef.current >= GEMINI.image.cadenceMs) {
      lastImageCapAtRef.current = tMs;
      const jpeg = captureRef.current();
      if (jpeg) imageBufferRef.current.add(jpeg, tMs, repNumber, phase);
    }
  }

  /**
   * Per descent/bottom frame: accumulate the worst-of frames, feed the eccentric
   * tracker, and evaluate the v2 MID-SET triggers (baseline-relative forward lean,
   * depth-gated valgus) behind 150ms persistence gates. Reps 1–2 (warm-up) never
   * trigger. Each mid-set trigger fires at most once per rep.
   */
  function observeDescentFrame(liveRepIndex: number, t: number): void {
    const frame = frameRef.current;
    if (!frame) return;
    const depthRatio = repTrackerRef.current?.depthRatio ?? 0;
    const m = evalFrame(frame, depthRatio);
    repFramesRef.current.push(m);
    latestMetricsRef.current = m;

    const tMs = t * 1000;
    const orientation = targetRef.current;
    const ctx = { setIndex: setIndexRef.current, repIndex: liveRepIndex, orientation };
    const warmedUp = liveRepIndex > TRIGGERS.baselineReps;
    const baseLean = leanBaselineRef.current.baseline();

    // T2: hip-Y descent samples (used at rep complete for spike + bounce).
    if (frame.hipMid) eccentricRef.current.add(tMs, frame.hipMid[1]);

    // Track deepest lean past the depth gate (for the T1 baseline + butt-wink context).
    const lean = frame.torsoLean;
    if (lean !== null && depthRatio >= TRIGGERS.lean.depthGate && (maxLeanDeepRef.current === null || lean > maxLeanDeepRef.current)) {
      maxLeanDeepRef.current = lean;
      peakLeanDepthRatioRef.current = depthRatio;
    }
    // Loaded butt-wink proxy: a lean spike that onsets BEFORE parallel (early-onset).
    if (
      orientation === "side" && warmedUp && baseLean !== null && lean !== null &&
      lean - baseLean >= TRIGGERS.lean.baselineDeltaDeg &&
      depthRatio > 0.1 && depthRatio < TRIGGERS.buttWink.loadedEarlyOnsetDepth
    ) {
      earlyLeanRef.current = true;
    }

    // T1 forward lean (side, mid-set).
    const leanActive = orientation === "side" && warmedUp && leanTriggerActive(lean, baseLean, depthRatio);
    if (leanGateRef.current.update(leanActive, tMs) && !firedThisRepRef.current.has("forwardLean")) {
      firedThisRepRef.current.add("forwardLean");
      captureTriggerMoment(liveRepIndex, { timestampMs: tMs, depthRatio, trunkAngleDeg: lean, valgusRatio: null });
      const imm = coordinatorRef.current.requestTrigger(ctx, "forwardLean", t);
      if (imm) fireCoaching(imm);
    }

    // T7 valgus (front, mid-set).
    const valgusRatio =
      frame.kneeWidth !== null && frame.ankleWidth !== null && frame.ankleWidth > 1e-4 ? frame.kneeWidth / frame.ankleWidth : null;
    const valgusActive = orientation === "front" && warmedUp && valgusTriggerActive(valgusRatio, depthRatio, SQUAT);
    if (valgusGateRef.current.update(valgusActive, tMs) && !firedThisRepRef.current.has("kneeValgus")) {
      firedThisRepRef.current.add("kneeValgus");
      captureTriggerMoment(liveRepIndex, { timestampMs: tMs, depthRatio, trunkAngleDeg: frame.torsoLean, valgusRatio });
      const imm = coordinatorRef.current.requestTrigger(ctx, "kneeValgus", t);
      if (imm) fireCoaching(imm);
    }
  }

  function finalizeSet(): void {
    if (exerciseRef.current === "pushup") {
      const session = pushupSessionRef.current;
      if (session) pushupSetsRef.current = [...pushupSetsRef.current, session.toSetRecord(lockAngleRef.current)];
      persistWorkoutUsage(false);
      return;
    }
    // Record the set even with zero attempts — the report shows it as a "no reps
    // recorded" advisory, while synthesis excludes empties from the totals.
    const reps = liveRepsRef.current;
    // Attach any AI cues that came back for this set's reps (keyed set:rep).
    const withCoaching = reps.map((r) => ({
      ...r,
      coaching: coachingByRepRef.current.get(`${setIndexRef.current}:${r.index}`) ?? r.coaching,
    }));
    completedSetsRef.current = [
      ...completedSetsRef.current,
      { index: setIndexRef.current, orientation: targetRef.current, facingAngleDeg: lockAngleRef.current, reps: withCoaching },
    ];
    // Write/refresh this session's usage row as INCOMPLETE. Recording only on
    // Finish would make the completion rate a constant 100% — a session abandoned
    // by closing the tab has to leave an honest incomplete record behind.
    persistWorkoutUsage(false);
  }

  /** Upsert this session's usage row. Skips empty sessions so a stray Finish from
   *  the positioning screen can't pollute session length / completion stats. */
  function persistWorkoutUsage(completed: boolean): void {
    if (exerciseRef.current === "pushup") {
      const pushupSets = pushupSetsRef.current.filter((s) => s.reps.length > 0);
      if (!pushupSets.length) return;
      recordWorkout({
        sets: pushupSets.length,
        repsCounted: pushupSets.reduce((n, s) => n + s.reps.filter((r) => r.counted).length, 0),
        repsAttempted: pushupSets.reduce((n, s) => n + s.reps.length, 0),
        completed,
        mode: pushupVariantRef.current,
        depthPreset: PUSHUP_DEPTH_PRESETS[pushupPresetRef.current].specName,
        exercise: "pushup",
      });
      return;
    }
    const sets = completedSetsRef.current.filter((s) => s.reps.length > 0);
    if (!sets.length) return;
    recordWorkout({
      sets: sets.length,
      repsCounted: sets.reduce((n, s) => n + s.reps.filter((r) => r.counted).length, 0),
      repsAttempted: sets.reduce((n, s) => n + s.reps.length, 0),
      completed,
      mode: modeRef.current,
      depthPreset: specPreset(depthPresetRef.current),
    });
  }

  const endSet = useRef(() => {
    if (phaseRef.current !== "active") return;
    const last = coordinatorRef.current.forceFlush();
    if (last) fireCoaching(last);
    const lastPushup = pushupCoordinatorRef.current.forceFlush();
    if (lastPushup) firePushupCoaching(lastPushup);
    finalizeSet();
    reviewSetIndexRef.current = setIndexRef.current; // the set we just finished
    setReviewStageRef.current = "choice"; // end-of-set choice screen; NO analysis fired yet
    // Post-set analysis is deliberately NOT fired here — it fires ONLY when the user clicks
    // "Next set" (requestPostSet). So the last set (ended via "End workout") never generates
    // a post-set. The set stays finalized with baselines/trackers intact for requestPostSet.
    phaseRef.current = "set-review";
  });

  /** "Next set" from the end-of-set choice: request the post-set analysis (the ONLY caller of
   *  firePostSet) and move to the post-set stage. Baselines/trackers are still the ended set's
   *  (newSet hasn't run), so the payload matches the set that just ended. */
  const requestPostSet = useRef(() => {
    if (phaseRef.current !== "set-review" || setReviewStageRef.current !== "choice") return;
    setReviewStageRef.current = "post-set";
    firePostSet();
  });

  /** Leave the between-set review and start the next set. Does the set-advance work that
   *  endSet used to do inline (kept here so the review screen can hold before it runs). */
  const newSet = useRef(() => {
    if (phaseRef.current !== "set-review") return;
    setReviewStageRef.current = "choice";
    setIndexRef.current += 1;
    targetRef.current = alternate(targetRef.current);
    reviewSetIndexRef.current = null;
    phaseRef.current = "positioning";
    alignStartRef.current = null;
    countdownStartRef.current = null;
    repositionRef.current = false;
    // Clear the live counters so the next set starts from zero during positioning.
    newSetTrackers(targetRef.current);
  });

  const finishWorkout = useRef(() => {
    // Idempotence guard: without this a second call (double-click, or any future
    // caller) would re-synthesize AND fire a second post-workout Gemini call for
    // the same session — a duplicate charge and a duplicate usage record.
    if (phaseRef.current === "finished") return;
    if (phaseRef.current === "active") {
      const last = coordinatorRef.current.forceFlush();
      if (last) fireCoaching(last);
      const lastPushup = pushupCoordinatorRef.current.forceFlush();
      if (lastPushup) firePushupCoaching(lastPushup);
      finalizeSet();
    }
    phaseRef.current = "finished";
    reportRef.current =
      exerciseRef.current === "pushup" ? synthesizePushup(pushupSetsRef.current) : synthesize({ sets: completedSetsRef.current });
    // Mark this session's usage row COMPLETE (replaces the incomplete row written
    // when the first set ended).
    persistWorkoutUsage(true);
    // Dev eval log: ARM the auto-export BEFORE firing the post-workout call, so its
    // callback (which resolves ~15 s later, after the post-workout observation is
    // logged) triggers the one export that includes it. The interval acts only as a
    // backstop. Export immediately when no AI call will resolve.
    if (DEV_EVAL_LOG) {
      evalExportedRef.current = false;
      finishedAtRef.current = nowSec();
    }
    firePostWorkout(); // end-of-session summary — fires ONLY here (End workout / Finish click)
    downloadShoulderHipCsv(); // debug-only export, inert when disabled
    if (DEV_EVAL_LOG && !geminiEnabled()) maybeExportEval(); // no post-workout call coming
  });

  /** Dev-only: on-demand snapshot export. Does NOT consume the one-shot auto-export
   *  (evalExportedRef untouched), so the complete file still lands once the async
   *  post-workout call resolves — clicking early just gives an extra early snapshot. */
  const downloadEval = useRef(() => {
    downloadEvalLog();
  });

  /** Eval-log session metadata for the current exercise. */
  function evalSessionMeta() {
    const pushup = exerciseRef.current === "pushup";
    return {
      exercise: exerciseRef.current,
      mode: pushup ? pushupVariantRef.current : modeRef.current,
      depthPreset: pushup ? PUSHUP_DEPTH_PRESETS[pushupPresetRef.current].specName : specPreset(depthPresetRef.current),
      model: GEMINI_MODEL,
      geminiEnabled: geminiEnabled(),
    };
  }

  const reset = useRef(() => {
    // New workout = new usage session, so calls and workout stats attribute to the
    // session they actually belong to.
    startUsageSession();
    if (DEV_EVAL_LOG) {
      // Fresh audit session per workout attempt (clears prior reps + Gemini calls).
      startEvalSession(evalSessionMeta());
      evalExportedRef.current = false;
      finishedAtRef.current = null;
    }
    phaseRef.current = "positioning";
    setIndexRef.current = 1;
    targetRef.current = FIRST_ORIENTATION;
    alignStartRef.current = null;
    countdownStartRef.current = null;
    repositionRef.current = false;
    completedSetsRef.current = [];
    pushupSetsRef.current = [];
    pushupFrameRef.current = null;
    pushupCoordinatorRef.current.resetSet();
    nearSideRef.current.reset();
    reportRef.current = null;
    angleEmaRef.current = null;
    coachingByRepRef.current.clear();
    latestMetricsRef.current = null;
    analysisRef.current = geminiEnabled() ? { status: "idle" } : { status: "disabled" };
    landmarkBufferRef.current.reset();
    imageBufferRef.current.reset();
    postSetFrameArchiveRef.current = { baseline: [], faults: new Map() };
    coachLogRef.current = [];
    postSetBySetRef.current.clear();
    reviewSetIndexRef.current = null;
    setReviewStageRef.current = "choice";
    lastImageCapAtRef.current = 0;
    prevDepthRatioRef.current = 0;
    newSetTrackers(FIRST_ORIENTATION);
    setLive(initialLive());
  });

  // Changing the exercise starts a fresh workout: sets, baselines and the report are per-exercise.
  const prevExerciseRef = useRef(exerciseSettings.exercise);
  useEffect(() => {
    if (prevExerciseRef.current === exerciseSettings.exercise) return;
    prevExerciseRef.current = exerciseSettings.exercise;
    reset.current();
  }, [exerciseSettings.exercise]);

  // Phase progression + snapshot push (~10×/sec).
  useEffect(() => {
    // Open the usage session for this mount (the first workout of the page load).
    startUsageSession();
    // Dev-only: subscribe the eval logger to every Gemini call, and open a session.
    if (DEV_EVAL_LOG) {
      setGeminiCallObserver(logGeminiObservation);
      startEvalSession(evalSessionMeta());
    }
    const id = setInterval(() => {
      const now = nowSec();
      // Dev eval-log auto-export BACKSTOP: the post-workout callback normally fires
      // the export (~15 s), but if it never resolves this guarantees one at +30 s.
      if (DEV_EVAL_LOG && phaseRef.current === "finished" && !evalExportedRef.current && finishedAtRef.current !== null && now - finishedAtRef.current > 30) {
        maybeExportEval();
      }
      // §5: fire any coaching batch whose dedup window has elapsed.
      const due = coordinatorRef.current.flushDue(now);
      if (due) fireCoaching(due);
      const duePushup = pushupCoordinatorRef.current.flushDue(now);
      if (duePushup) firePushupCoaching(duePushup);

      const est = orientRef.current;
      const target = targetRef.current;

      // Smoothed live classification.
      const liveAngle = angleEmaRef.current;
      const liveClass: OrientationClass =
        est && liveAngle !== null && est.readable ? classify(liveAngle) : "ambiguous";
      // Push-ups also need a plank before a set can LOCK (someone standing in view must never start
      // one). The mid-set reposition check below still uses liveClass alone — a deep bottom is not
      // "out of position".
      const postureOk = exerciseRef.current !== "pushup" || inPlankRef.current;
      const aligned = liveClass === target && postureOk;
      if (aligned) lastAlignedRef.current = now;
      // A brief flicker out of the zone (common at the front edge) is tolerated.
      const heldRecently = now - lastAlignedRef.current <= ORIENTATION.LOCK_GRACE_SEC;

      let lockProgress = 0;
      let countdown: number | null = null;
      let reposition = false;

      if (phaseRef.current === "positioning") {
        if (aligned && alignStartRef.current === null) alignStartRef.current = now;
        if (!aligned && !heldRecently) alignStartRef.current = null;
        if (alignStartRef.current !== null) {
          lockProgress = Math.min(1, (now - alignStartRef.current) / ORIENTATION.LOCK_SEC);
          if (aligned && lockProgress >= 1) {
            phaseRef.current = "countdown";
            countdownStartRef.current = now;
            newSetTrackers(target);
          }
        }
      } else if (phaseRef.current === "countdown") {
        const remaining = COUNTDOWN_SEC - (now - (countdownStartRef.current ?? now));
        if (!aligned && !heldRecently) {
          // Sustained loss of position during the countdown — cancel.
          phaseRef.current = "positioning";
          alignStartRef.current = null;
          countdownStartRef.current = null;
        } else if (remaining <= 0) {
          phaseRef.current = "active";
        } else {
          countdown = Math.ceil(remaining);
        }
      } else if (phaseRef.current === "active") {
        // Mid-set policing: drifted off the locked orientation → prompt reposition.
        // (The per-check angle tolerance already marks those reps "unknown".)
        reposition = liveClass !== target;
        repositionRef.current = reposition;
      }

      const tracker = repTrackerRef.current;
      const frame = frameRef.current;
      // Live calibration readouts (same formulas the checks use).
      const liveDepthGap = frame?.hipMid && frame?.kneeMid ? frame.hipMid[1] - frame.kneeMid[1] : null;
      const liveValgusRatio =
        frame && frame.kneeWidth !== null && frame.ankleWidth !== null && frame.ankleWidth > 1e-4
          ? frame.kneeWidth / frame.ankleWidth
          : null;
      const missedDepthFlash = now - missedFlashAtRef.current <= 1.2;
      const liveMetrics =
        phaseRef.current === "active"
          ? tracker && tracker.isDown && frame
            ? evaluateRep({
                frame,
                orientation: target,
                facingAngleDeg: liveAngle,
                velocity: null,
                cfg: SQUAT,
                depthPreset: depthPresetRef.current,
              })
            : liveRepsRef.current[liveRepsRef.current.length - 1]?.metrics ?? null
          : null;

      const pushupMode = exerciseRef.current === "pushup";
      const pSession = pushupSessionRef.current;
      const pFrame = pushupFrameRef.current;
      const debugTags: { text: string; landmark: number }[] = [];
      if (pushupMode && pFrame) {
        const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}°`;
        if (target === "side" && pFrame.upperArmAngleDeg !== null) {
          debugTags.push({ text: `arm ${signed(pFrame.upperArmAngleDeg)}`, landmark: pFrame.nearSide === "right" ? 12 : 11 });
        }
        if (target === "side" && pFrame.bodyLineDeg !== null) {
          debugTags.push({ text: `line ${signed(pFrame.bodyLineDeg)}`, landmark: pFrame.nearSide === "right" ? 24 : 23 });
        }
        if (target === "front" && pFrame.flareRatio !== null) debugTags.push({ text: `flare ${pFrame.flareRatio.toFixed(2)}`, landmark: 13 });
      }

      setLive({
        phase: phaseRef.current,
        setIndex: setIndexRef.current,
        targetOrientation: target,
        orientation: liveClass,
        facingAngleDeg: liveAngle,
        facingScore: est?.score ?? null,
        orientationLabel: est?.label ?? "Step into frame",
        aligned,
        lockProgress,
        countdown,
        repositionNeeded: reposition,
        reps: countedRepsRef.current,
        kneeAngle: tracker?.kneeAngle ?? null,
        depthRatio: pushupMode ? pSession?.tracker.depthRatio ?? 0 : tracker?.depthRatio ?? 0,
        liveDepthGap,
        liveValgusRatio,
        missedDepthFlash,
        isDown: pushupMode ? pSession?.tracker.isDown ?? false : tracker?.isDown ?? false,
        liveMetrics,
        velocity: samplesRef.current,
        bestVelocity: pushupMode ? pSession?.velocity.best() ?? null : velocityRef.current.best(),
        camera: cameraRef.current,
        completedSets: completedSetsRef.current,
        report: reportRef.current,
        analysis: analysisRef.current,
        coachLog: coachLogRef.current,
        postSetReviews: Object.fromEntries(postSetBySetRef.current),
        reviewSetIndex: reviewSetIndexRef.current,
        reviewStage: setReviewStageRef.current,
        exercise: exerciseRef.current,
        readable: pushupMode ? !!(pFrame?.shoulder && pFrame?.wrist) : (tracker?.kneeAngle ?? null) !== null,
        pushupLiveMetrics: pushupMode && phaseRef.current === "active" ? pSession?.liveMetrics() ?? null : null,
        completedPushupSets: pushupSetsRef.current,
        missedFlashText: pushupMode ? missedFlashTextRef.current : "Depth not met — no count",
        debugTags,
      });
    }, 100);
    return () => {
      clearInterval(id);
      if (DEV_EVAL_LOG) setGeminiCallObserver(null);
    };
  }, []);

  return {
    ...live,
    onResult: onResult.current,
    endSet: endSet.current,
    requestPostSet: requestPostSet.current,
    newSet: newSet.current,
    finishWorkout: finishWorkout.current,
    reset: reset.current,
    downloadEvalLog: downloadEval.current,
    devEvalLog: DEV_EVAL_LOG,
  };
}
