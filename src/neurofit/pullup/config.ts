/**
 * Neuro-Fit — pull-up thresholds (the single source of pull-up tuning).
 * ----------------------------------------------------------------------------
 * PURE module: no React, no DOM.
 *
 * ⚠️ EVERY value here is UNVALIDATED (n=0 — no pull-up footage has been through this code yet).
 * They are seeded from test standards, published biomechanics and open-source pose counters, plus
 * geometry derived from standard body-segment proportions. Each value says where it came from so
 * the first calibration run (PULLUP_TEST_PROTOCOL.md) can replace it with evidence. When you
 * change one, comment WHY (observed behaviour), exactly as squat/config.ts does.
 *
 * Source key used below:
 *   [USMC]    Marine Corps PFT pull-up: start from a dead hang, arms extended; chin above the bar;
 *             lower until the arms are fully extended. "Whipping, kicking, kipping of the body or
 *             legs, or any leg movement used to assist" voids the rep; "a certain amount of
 *             inherent body movement will occur … avoid a pendulum-like motion".
 *   [CFG]     CrossFit Games standard: arms fully extended at the bottom with the feet off the
 *             ground; the rep is credited when the chin clearly breaks the plane of the bar.
 *             Kipping is allowed there — which is why a kip is a coaching point here, never a
 *             counting gate.
 *   [NSPHS]   China National Student Physical Health Standard: jump to a straight-arm hang, body
 *             still; pull until the chin passes the upper edge of the bar; lower back to the hang.
 *   [Youdas10] Youdas et al. 2010, JSCR: elbow range of motion 93.4 ± 14.6° (pull-up) and
 *             100.6 ± 14.5° (chin-up) — a full rep spends a lot of range above ~150°.
 *   [Prinold16] Prinold & Bull 2016, JSAMS: wide and reverse-grip pull-ups produce the scapular
 *             kinematics linked to impingement risk (wide ≈ 90° abduction with 45° external
 *             rotation); shoulder-width pronated grip was the lowest-risk variant.
 *   [Dinunzio19] Dinunzio et al. 2019, Sports Biomech: adding a kip raises lower-limb joint angles
 *             and lower-body activation while cutting upper-body activation — the legs do the work.
 *   [SSH23]   "Biomechanical characterisation of the pull-up", Sport Sci Health 2023: as reps get
 *             hard the legs oscillate to add kinetic energy; hip and knee flexion grow rep on rep.
 *   [PoseCV]  Open-source + academic pull-up counters (MediaPipe / YOLO pose): bottom state = elbow
 *             > 160°, top = nose/chin above a bar line; validity from chin-over-bar + elbow angle +
 *             foot state (Discover AI 2026). They place the bar by hand — we infer it from the grip.
 *   [Hang]    Coaching consensus on active vs passive hang: a pull-up starts by depressing the
 *             shoulder blades; a passive hang lets the shoulders ride up to the ears. Qualitative —
 *             nothing here measures it; the coach may only remark on it from a frame.
 *   [Winter]  Drillis & Contini segment proportions (Winter): upper arm 0.186H, forearm 0.146H,
 *             hand 0.108H; chin 0.870H and shoulder 0.818H above the floor standing.
 *   [DERIVED] Geometry from [Winter]. Hang height h = shoulder.y − wrist.y (the shoulders' drop
 *             below the hands). pullRatio = (hDown − h)/hDown, 0 at the lifter's own dead hang.
 *               • Elbow bend with a vertical arm chord (chord² = u² + f² − 2uf·cos θ):
 *                 ratio 0.015 @160°, 0.034 @150°, 0.059 @140°, 0.092 @130°, 0.13 @120°, 0.29 @90°.
 *                 A ratio therefore CANNOT tell a 150° elbow from a straight one — and the shoulder
 *                 blades alone (active vs passive hang, ~3–5 cm) move it by 0.05–0.10. The elbow
 *                 angle is the primary extension test; the ratio is only a backstop.
 *               • Chin level with the bar: the wrist sits ~0.045H below the bar (the bar lies across
 *                 the fingers) and the shoulder 0.052H below the chin, so the shoulder ends ~0.007H
 *                 below the wrist → ratio ≈ 1 − 0.007H/hDown ≈ 0.976 (hDown ≈ 0.29H). The top of
 *                 a pull-up sits at ratio ≈ 1, so the ratio is only the fallback TOP test too.
 */
import type { PullupMetricId } from "./metrics";

// --- Rep counting ------------------------------------------------------------------

export interface PullupConfig {
  /**
   * Pull ratio that ARMS an attempt. 0.25 ≈ elbow 100° [DERIVED] — past anything the shoulder
   * blades alone can do (a scapular pull moves the ratio ≲ 0.16), so scap pulls and settling
   * into the hang never read as reps.
   */
  repUpRatio: number;
  /**
   * The attempt CLOSES when the shoulders come back within this ratio of the hang. Deliberately
   * looser than the extension test: an ACTIVE hang (shoulder blades down — correct technique
   * [Hang]) can sit 0.05–0.10 above a passive hang with the arms dead straight. Whether the arms
   * really straightened is judged on the next rep's START, by the elbow angle.
   */
  returnRatio: number;
  /**
   * Partial-hang segmentation (mirror of the push-up's partial lockout). After dropping at least
   * `partialDropRatio` below the peak without returning to the hang, a re-rise of `reriseRatio`
   * closes the attempt at its partial bottom and arms the next one there — so pulsed half-reps
   * don't merge into one long rep, and the next rep is judged as starting from a bent-arm hang.
   */
  partialDropRatio: number;
  reriseRatio: number;
  /**
   * The bar doesn't move, so the wrists shouldn't either. Wrists this far BELOW their hang
   * position (× hang height) = the lifter let go: an attempt in progress closes as a dismount,
   * and idle frames are ignored (lowering the arms after dropping off must never arm a rep).
   * Must stay below repUpRatio: lowering the arms by X shrinks h by X, i.e. raises the ratio by X.
   */
  dismountDropRatio: number;
  /** Debounce floor (s). A kipping butterfly pull-up cycles in ~0.8 s; nothing real is faster. */
  minRepSec: number;
  /** Median spike filter window (ms) on h, wrist y and chin clearance (Tasks API has no smoothing). */
  spikeFilterMs: number;
  /** Pre-arm window (ms) folded into a rep's swing / leg samples — a kip's back-swing happens at the
   *  bottom, BEFORE the shoulders have risen far enough to arm the attempt. */
  preArmWindowMs: number;
  /**
   * Extension (counting gate, judged on the frame the rep STARTED from — [USMC]/[CFG]: every rep
   * starts from a dead hang):
   *   - elbowMinDeg: 2D elbow angle at the start. [PoseCV] use 160°; 150° leaves room for landmark
   *     jitter and for the carrying angle a supinated grip shows head-on. A straight arm projects
   *     straight from ANY view, so this never falsely fails a straight arm; a bend can hide when it
   *     points at the camera, so it can pass a bent one — a miss here is a real miss.
   *   - ratioMax: used ONLY when no elbow is readable (0.12 = straight arms + an active hang).
   *   - grossRatio: fails the rep even when the elbow READS straight — no straight-armed hang sits
   *     this far up (0.25 ≈ elbow 100° [DERIVED]); catches a bend hidden by the camera angle.
   */
  extension: { elbowMinDeg: number; ratioMax: number; grossRatio: number };
  /**
   * Baseline hygiene: a warm-up rep may CALIBRATE the per-set baselines only if it started from a
   * full hang and pulled at least this far. Never changes whether the rep counts.
   */
  baselineMinPeakRatio: number;
  velocityWarmupReps: number;
  velocityDropFraction: number;
  aiDedupWindowSec: number;
  /**
   * Per-check facing-angle tolerance (deg). Swing is a horizontal (fore-aft) excursion — it
   * foreshortens fastest off true side-on, so it's narrowed to 10° like the squat's depth check.
   */
  checkToleranceDeg: Record<PullupMetricId, number>;
}

export const PULLUP: PullupConfig = {
  repUpRatio: 0.25,
  returnRatio: 0.18,
  partialDropRatio: 0.25,
  reriseRatio: 0.1,
  dismountDropRatio: 0.15,
  minRepSec: 0.5,
  spikeFilterMs: 100,
  preArmWindowMs: 1000,
  extension: { elbowMinDeg: 150, ratioMax: 0.12, grossRatio: 0.25 },
  baselineMinPeakRatio: 0.7,
  velocityWarmupReps: 2,
  velocityDropFraction: 0.2,
  aiDedupWindowSec: 0.5,
  checkToleranceDeg: {
    repCount: 15,
    top: 15,
    extension: 15,
    swing: 10,
    legDrive: 15,
    eccentricControl: 15,
    velocity: 15,
    evenness: 15,
  },
};

/**
 * Face + hand geometry for the chin-over-bar test [DERIVED from Winter + standard face proportions].
 *   chin ≈ mouth + CHIN_BELOW_MOUTH × (mouth − nose), vertically. Nose tip → mouth ≈ 0.014H and
 *   mouth → chin ≈ 0.023H, so ≈ 1.6. The three points are roughly collinear down the face, so a
 *   head tilted back (reaching the chin over) shrinks both terms together and the estimate stays
 *   proportional.
 *   BAR: the grip sits on the bar, and BlazePose's index/pinky points are the #1 knuckles, which
 *   lie on it — the bar line is the median knuckle height across the hang frames (the bar never
 *   moves, so a per-set median beats any per-frame read). Without knuckles it falls back to the
 *   wrist: the bar lies ~0.045H above the wrist joint ≈ 0.24 upper-arm lengths.
 */
export const PULLUP_FACE = {
  chinBelowMouth: 1.6,
  barAboveWristUpperArms: 0.24,
  /** Hang-frame samples kept for the per-set bar-line median. */
  barSamples: 240,
} as const;

/**
 * Top target presets (Settings). ONE basis where the face is visible: chin clearance = how far the
 * estimated chin rose above (+) or stayed below (−) the bar, as a fraction of the lifter's own
 * hang height (body-size and camera-distance invariant). When the face isn't readable (camera
 * behind the lifter, head hidden by an arm) the rep falls back to the peak pull ratio, from the
 * [DERIVED] model ratio ≈ 0.976 + clearance, eased ~0.05 toward lenient (the squat's front target
 * needed exactly that ease on real reps). Higher always counts. ⚠ UNVALIDATED.
 */
export type PullupTopPreset = "chest" | "chin" | "nose";

export interface PullupTopPresetSpec {
  id: PullupTopPreset;
  label: string;
  /** Name sent to the coach (matches the prompt's vocabulary). */
  specName: "chest_to_bar" | "chin_over_bar" | "nose_to_bar";
  /** Peak chin clearance (fraction of hang height) the rep must reach. */
  chinClearanceTarget: number;
  /** Fallback: peak pull ratio when the chin is unreadable. */
  pullRatioTarget: number;
}

export const PULLUP_TOP_PRESETS: Record<PullupTopPreset, PullupTopPresetSpec> = {
  // Collarbone to the bar: the chin ends ~0.06H (≈0.2 hang heights) above it; 0.15 leaves slack.
  chest: { id: "chest", label: "Chest to bar", specName: "chest_to_bar", chinClearanceTarget: 0.15, pullRatioTarget: 1.08 },
  // [USMC]/[CFG]/[NSPHS] chin over the bar. −0.05 (≈2.5 cm on a 1.75 m lifter) is landmark slack for
  // the chin estimate + the knuckle bar line, like the push-up's −5° parallel allowance.
  chin: { id: "chin", label: "Chin over bar", specName: "chin_over_bar", chinClearanceTarget: -0.05, pullRatioTarget: 0.9 },
  // Partial range for beginners: the nose reaches the bar, chin still ~0.04H (≈0.13) below it.
  nose: { id: "nose", label: "Nose to bar", specName: "nose_to_bar", chinClearanceTarget: -0.15, pullRatioTarget: 0.8 },
};

export const DEFAULT_PULLUP_TOP_PRESET: PullupTopPreset = "chin";

/**
 * The grip the lifter selected. It changes no geometry — it names the movement for the coach
 * (overhand pull-up vs underhand chin-up) and tells it which view the elbow bend is visible from.
 * A user toggle: hand landmarks gripping a bar are too unreliable to infer it.
 */
export type PullupGrip = "overhand" | "underhand" | "neutral";
export const DEFAULT_PULLUP_GRIP: PullupGrip = "overhand";

/**
 * Camera plan. Sets alternate head-on / side-on like the other exercises, starting head-on (the
 * view that sees the chin against the bar and both arms). "front-only" exists because a doorway
 * bar makes a side view physically impossible — the camera would have to sit inside the wall.
 * Side-only faults (swing, leg drive) are then reported as not assessed, never as clean.
 */
export type PullupCameraPlan = "alternate" | "front-only";
export const DEFAULT_PULLUP_CAMERA_PLAN: PullupCameraPlan = "alternate";

// --- Triggers ------------------------------------------------------------------------

/**
 * Pull-up trigger thresholds. ⚠️ UNVALIDATED (n=0). Same contract as squat/push-up TRIGGERS: no
 * trigger fires during warm-up reps 1–2, baseline-relative thresholds are deltas, and a trigger
 * only ARCHIVES a frame for the post-set debrief. Every pull-up fault is a whole-rep quantity
 * (a range, a speed, a worst tilt), so all of them are evaluated when the attempt closes.
 */
export const PULLUP_TRIGGERS = {
  baselineReps: 2,

  /**
   * U1 body swing / kip (side). The hand→hip line vs vertical: in a slow pull-up the centre of
   * mass has to stay under the bar, so the hips barely travel; a kip swings them like a pendulum
   * [USMC "pendulum-like motion"]. Measured as the RANGE of that angle across the rep plus the
   * pre-arm window. Strict reps show a few degrees of "inherent movement"; a kip is 30°+.
   * Relative: this many degrees past the warm-up range. Absolute backstop so a lifter who kipped
   * through the warm-up can't make the relative check blind. The angle is taken from the hands,
   * so the same hip travel reads larger near the top (the hips are closer to the pivot).
   */
  swing: { baselineDeltaDeg: 10, absRangeDeg: 20 },

  /**
   * U3 leg drive / kick (side) — the larger of the hip-flexion and knee-flexion RANGE across the
   * rep [USMC "kicking … any leg movement used to assist"; SSH23; Dinunzio19]. A range, not an
   * absolute angle: hanging with crossed, bent knees is a style — changing them mid-pull is the
   * drive. 30° sits well above the ~13–14° 2D joint-angle error. Absolute only (it is already
   * relative to the rep's own start), so it has no warm-up baseline to disarm.
   */
  legDrive: { rangeDeg: 30 },

  /**
   * U2 lowering control (agnostic) — mean shoulder descent speed from the top to the hang vs the
   * warm-up baseline. 2.0× is the squat's hard-won value (1.5× fired on normal reps once a slow
   * warm-up depressed the baseline). Dropping into a dead hang loads the elbows and shoulders.
   */
  eccentric: { descentSpikeMult: 2.0 },

  /**
   * U4 uneven pull (front) — shoulder-line tilt minus hand-line tilt. Both hands hold one level
   * bar, so the difference cancels camera roll. Worst value past `ratioGate` (arms bent — at the
   * hang a lopsided grip and a lopsided pull look alike), baseline-relative like squat T11 and
   * push-up P11, and just as untrustworthy until calibrated. `warnDeg` = display/context warn.
   */
  evenness: { warnDeg: 10, baselineDeltaDeg: 8, ratioGate: 0.3 },

  /** Grip width (front, context): wristSpan/shoulderSpan bands. Width alone is never a fault;
   *  [Prinold16] is why "wide" is worth naming as context. */
  gripWidth: { narrowBelow: 1.0, wideAbove: 1.8 },

  /** Tier-2: a rep's tracking is unreliable when min visibility falls below this × the set's
   *  warm-up baseline (same value as squat/push-up — UNVALIDATED for hanging poses). */
  visDropRatio: 0.75,
} as const;

/** Physical-possibility bounds: beyond these the landmark is wrong, not the lifter. */
export const PULLUP_PLAUSIBLE = {
  /** A kip swings the hips ≲ 60° either side of the bar; beyond that a hip or wrist jumped. */
  swingMaxDeg: 75,
  gripWidthRatio: { lo: 0.5, hi: 4.0 },
  shoulderTiltDiffMaxDeg: 45,
} as const;

// --- Severity + presentation bands ---------------------------------------------------

/** Severity bands — display/report ONLY (they never fire anything). */
export interface PullupSeverityBand {
  critical: number;
  worseWhen: "below" | "above";
}

export const PULLUP_SEVERITY: Partial<Record<PullupMetricId, PullupSeverityBand>> = {
  // Top value = measured − target, in fractions of hang height; 0.15 short = a cut-short rep.
  top: { critical: -0.15, worseWhen: "below" },
  // Extension value = start elbow angle (deg).
  extension: { critical: 125, worseWhen: "below" },
  swing: { critical: 35, worseWhen: "above" },
  legDrive: { critical: 50, worseWhen: "above" },
  eccentricControl: { critical: 3.0, worseWhen: "above" },
  velocity: { critical: 0.65, worseWhen: "below" },
  evenness: { critical: 18, worseWhen: "above" },
};

/**
 * How far short, as a WORD (the coach may never quote a normalized number). Keyed by basis.
 * Chin clearance and pull ratio are both fractions of the lifter's hang height, so they share
 * bands; the elbow bands are degrees.
 */
export const PULLUP_SHORTFALL_BANDS = {
  chin_clearance: { marginal: 0.05, moderate: 0.15 },
  pull_ratio: { marginal: 0.05, moderate: 0.15 },
  elbow_angle_deg: { marginal: 10, moderate: 25 },
} as const;

export type PullupBasis = keyof typeof PULLUP_SHORTFALL_BANDS;
