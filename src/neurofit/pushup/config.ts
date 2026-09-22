/**
 * Neuro-Fit — push-up thresholds (the single source of push-up tuning).
 * ----------------------------------------------------------------------------
 * PURE module: no React, no DOM.
 *
 * ⚠️ EVERY value here is UNVALIDATED (n=0 — no push-up footage has been through this code yet).
 * They are seeded from published biomechanics, test standards and open-source pose projects,
 * plus geometry derived from standard body-segment proportions. Each value says where it came
 * from so the first calibration run (PUSHUP_TEST_PROTOCOL.md) can replace it with evidence.
 * When you change one, comment WHY (observed behaviour), exactly as squat/config.ts does.
 *
 * Source key used below:
 *   [Kellner23] Kellner et al. 2023, JPES — 13,870 expert-rated push-up reps. Rejections: incomplete
 *               lockout 10.2%, not reaching bottom 7.0%, body not rigid 6.3% (sway 2.9 / sag 1.8 /
 *               pike 1.6; sag "usually on the way back up"), hand placement 4%.
 *   [STD]       US Army / USMC / FitnessGram: bottom = upper arm at least parallel to the ground;
 *               body in a generally straight line; top = arms fully extended.
 *   [Suprak13]  Suprak et al. 2013, J Athl Train — 3D humerothoracic elevation in push-ups:
 *               self-selected 53.6°, cued-90° reached only 64.8°.
 *   [UCO]       Lying-down exercise dataset (PMC10648737): MediaPipe 2D joint-angle error 13–14°.
 *   [PushForm]  Open-source push-up spec: elbow <95° down / >155° up; body line ±20° sag/pike.
 *   [Plank]     Open-source plank spec: hip ≤0.05 below / ≤0.15 above the shoulder–ankle line.
 *   [Winter]    Drillis & Contini segment proportions (Winter): upper arm 0.186H, forearm 0.146H,
 *               shoulder width 0.259H.
 *   [DERIVED]   Geometry from [Winter], assuming the forearm stays ~vertical under the elbow:
 *               shoulder height above the wrist h = forearm + upperArm·sin(φ), φ = upper-arm angle
 *               ABOVE horizontal. With the lockout height a+b = 0.332H:
 *                  depthRatio = (a+b−h)/(a+b) ≈ 0.56·(1 + sin(upperArmAngleDeg))
 *               where upperArmAngleDeg is our sign convention (+ = shoulder BELOW elbow = −φ).
 *               Elbow angle θ ≈ 90° + φ, so ratio 0.07 ≈ θ 151°, 0.20 ≈ θ 130°, 0.56 ≈ θ 90°.
 */
import type { PushupMetricId } from "./metrics";

// --- Camera orientation --------------------------------------------------------

/**
 * Push-up facing score = shoulder x-separation ÷ near upper-arm length, both in ASPECT space
 * (x scaled by W/H so x and y share units). The squat's shoulder-spread ÷ torso-length score
 * cannot be reused: the torso is horizontal side-on and points AT the camera head-on, and at the
 * bottom of a push-up its projection changes, so a squat-style score would flip the view
 * mid-rep. The upper arm is visible at full length side-on at every depth (it moves in the
 * sagittal plane), so the SIDE score stays near 0 throughout the rep; head-on it foreshortens
 * at the bottom, which only pushes the score further into "front".
 *
 * Anchors [DERIVED]: dead front-on ≈ shoulder width/upper arm = 0.259/0.186 ≈ 1.39, but BlazePose
 * shoulder landmarks sit at the joint centres (narrower than biacromial), so real front-on reads
 * lower — anchored at 1.0. Side-on ≈ 0 plus far-shoulder jitter. Cosine model (score ≈ 1.1·cos(off
 * front)) puts SIDE_EDGE 0.35 ≈ 18° off side. UNVALIDATED — tune with the live "facing" readout
 * in the set bar, as was done for the squat anchors.
 */
export const PUSHUP_ORIENTATION = {
  SCORE: { FRONT_FULL: 1.0, FRONT_EDGE: 0.75, SIDE_EDGE: 0.35, SIDE_FULL: 0.18 },
  /** Far-side shoulder may be dimmer side-on; accept it for the x-spread at this fraction of minVis. */
  farShoulderVisFrac: 0.5,
  /**
   * PLANK POSTURE gate — the lock only engages when the lifter is actually in a push-up top
   * position, so a person standing (or kneeling upright) in view never starts a set. Only the
   * LOCK uses this; mid-set it is not re-checked (a deep bottom must not read as "left position").
   */
  plank: {
    /** Side: shoulder→hip line within this many degrees of horizontal. Toes ≈19°, knees ≈37° at
     *  lockout [DERIVED]; standing ≈90°. */
    maxTorsoInclineDeg: 45,
    /** Both views: wrists this many upper-arm lengths BELOW the shoulders (arms supporting). */
    minWristDropUpperArms: 0.25,
    /** Front: |hipMidY − shoulderMidY| ≤ this × shoulder width (hips unreadable also passes —
     *  they are usually hidden behind the head/shoulders head-on). Standing reads ≈1.4. */
    frontMaxHipDropShoulderWidths: 0.6,
  },
} as const;

// --- Rep counting, depth, lockout ------------------------------------------------

export interface PushupConfig {
  /**
   * Shoulder-drop ratio to ARM a rep. depthRatio = (hUp − h)/hUp with h = wrist.y − shoulder.y
   * (the shoulder's height above the hands). Like the squat's hip-Y signal it drops in BOTH views,
   * whereas the elbow angle bends along the camera's depth axis head-on and never moves there.
   * 0.20 ≈ elbow 130° [DERIVED] — clearly a descent, well short of any depth target.
   */
  repDownRatio: number;
  /**
   * Ratio the shoulders must return to for the rep to COMPLETE = the LOCKOUT gate. 0.07 ≈ elbow
   * 151° [DERIVED]; [PushForm] uses >155°, other open-source counters 145–160°, [STD] says "fully
   * extended". Incomplete lockout is the #1 rejection in [Kellner23] (10.2%), so it gates counting.
   * Set a touch below 155° because hUp is a running max, so jitter already makes 0 unreachable.
   */
  lockoutRatio: number;
  /**
   * Partial-lockout segmentation. Without it, a lifter who pulses at the bottom (rises part way,
   * never locks out, descends again) produces ONE long rep and the missed lockouts vanish. After
   * rising at least `partialRiseRatio` above the bottom, a re-descent of `redescentRatio` from the
   * partial top closes the attempt as lockedOut=false and arms the next one. UNVALIDATED.
   */
  partialRiseRatio: number;
  redescentRatio: number;
  /** Debounce floor (s): no real push-up completes faster. [Kellner23] 30-s tests run <1 s/rep. */
  minRepSec: number;
  /** Median spike filter window (ms) on h — the Tasks API has no landmark smoothing, and
   *  [PushForm] uses a 5-frame median. Time-based so it doesn't depend on the adaptive frame rate. */
  spikeFilterMs: number;
  /**
   * Baseline hygiene: a warm-up rep may CALIBRATE the per-set baselines only if it locked out and
   * reached at least this depthRatio (≈ elbow 113° [DERIVED]). Mirrors the squat lesson — a
   * settle/half rep during warm-up poisoned the lean baseline and killed T1 for a whole set.
   * Never changes whether the rep counts.
   */
  baselineMinDepthRatio: number;
  /** Reps with a trusted velocity baseline before velocity can degrade (shared VelocityTracker). */
  velocityWarmupReps: number;
  /** Velocity "degraded" fraction vs the rolling average (shared VelocityTracker). */
  velocityDropFraction: number;
  /** Same-rep trigger merge window (s) for the coordinator. */
  aiDedupWindowSec: number;
  /**
   * Per-check facing-angle tolerance (deg). Depth reads a VERTICAL relationship (shoulder vs
   * elbow height), which foreshortens fastest off true side-on — narrowed to 10° like the squat's
   * depth check. Agnostic metrics skip the gate but the Record needs every id.
   */
  checkToleranceDeg: Record<PushupMetricId, number>;
}

export const PUSHUP: PushupConfig = {
  repDownRatio: 0.2,
  lockoutRatio: 0.07,
  partialRiseRatio: 0.25,
  redescentRatio: 0.1,
  minRepSec: 0.3,
  spikeFilterMs: 100,
  baselineMinDepthRatio: 0.35,
  velocityWarmupReps: 2,
  velocityDropFraction: 0.2,
  aiDedupWindowSec: 0.5,
  checkToleranceDeg: {
    depth: 10,
    bodyLine: 15,
    lockout: 15,
    eccentricControl: 15,
    velocity: 15,
    repCount: 15,
    elbowFlare: 15,
    shoulderLevel: 15,
  },
};

/**
 * Push-up depth presets (Settings). Two bases, because the two views decide depth differently —
 * exactly as the squat does (hip-vs-knee gap side, depthRatio front):
 *   - SIDE counts on the bottom UPPER-ARM ANGLE vs horizontal (+ = shoulder below elbow). This is
 *     the literal [STD] rule ("upper arm parallel to the ground"), it is in DEGREES (a real unit
 *     the coach may quote) and it is body-size / distance invariant.
 *   - FRONT counts on bottomDepthRatio (the upper-arm angle is invisible head-on). Targets come
 *     from the [DERIVED] ratio ≈ 0.56·(1+sin(angle)), eased ~10% toward lenient — the squat's
 *     front target needed exactly that ease (0.66 → 0.60) on real reps.
 * Deeper always counts. ⚠ UNVALIDATED.
 */
export type PushupDepthPreset = "chest" | "parallel" | "above";

export interface PushupDepthPresetSpec {
  id: PushupDepthPreset;
  label: string;
  /** Name sent to the coach (matches the prompt's vocabulary). */
  specName: "chest_to_floor" | "parallel" | "above_parallel";
  /** Side: bottom upper-arm angle (deg, + = shoulder below elbow) the rep must reach. */
  targetUpperArmDeg: number;
  /** Front: bottomDepthRatio the rep must reach. */
  frontRatioTarget: number;
}

export const PUSHUP_DEPTH_PRESETS: Record<PushupDepthPreset, PushupDepthPresetSpec> = {
  // Chest near the floor: shoulder ≈0.07H above the hands, elbow ≈0.13H → shoulder ~20° below the
  // elbow [DERIVED]; +15° leaves landmark slack. Ratio 0.56·(1+sin15°) = 0.70.
  chest: { id: "chest", label: "Chest to floor", specName: "chest_to_floor", targetUpperArmDeg: 15, frontRatioTarget: 0.7 },
  // [STD] upper arm parallel = 0°. −5° allows for BlazePose placing shoulder/elbow at joint centres
  // (a couple of degrees of jitter either side of true parallel). Ratio 0.56·(1+sin(−5°)) = 0.51 → 0.50.
  parallel: { id: "parallel", label: "Upper arm parallel", specName: "parallel", targetUpperArmDeg: -5, frontRatioTarget: 0.5 },
  // Partial range for beginners / rehab: shoulder up to 20° above the elbow. Ratio
  // 0.56·(1+sin(−20°)) = 0.37 → 0.36.
  above: { id: "above", label: "Above parallel", specName: "above_parallel", targetUpperArmDeg: -20, frontRatioTarget: 0.36 },
};

export const DEFAULT_PUSHUP_DEPTH_PRESET: PushupDepthPreset = "parallel";

/**
 * Toes (standard) vs knees (modified). The variant changes the body-line reference: the straight
 * line runs shoulder → hip → ANKLE on toes but shoulder → hip → KNEE on knees. Without the switch
 * every knee push-up reads as a large sag/pike. It's a user toggle — no pose heuristic is trusted
 * to decide it — and side sets report what the camera saw as context only.
 */
export type PushupVariant = "toes" | "knees";
export const DEFAULT_PUSHUP_VARIANT: PushupVariant = "toes";

// --- Triggers --------------------------------------------------------------------

/**
 * Push-up trigger thresholds. ⚠️ UNVALIDATED (n=0). Same contract as squat TRIGGERS: all timing
 * in ms, baseline-relative thresholds are deltas, no trigger fires during warm-up reps 1–2, and a
 * trigger only ARCHIVES a frame for the post-set debrief (no mid-set text).
 */
export const PUSHUP_TRIGGERS = {
  persistMs: 150,
  baselineReps: 2,

  /**
   * P1 body line (side) — hip sag (+) / pike (−), judged on every frame of the armed rep. NO depth
   * gate: the line is defined at every depth and [Kellner23] saw sag mostly on the ascent, so
   * narrowing the window would repeat the squat's T7 miss (the cave happened outside the gate).
   */
  bodyLine: {
    /** Relative: this many degrees past the lifter's own warm-up line. Set just above the
     *  13–14° 2D angle error [UCO] so jitter alone can't fire it. */
    baselineDeltaDeg: 15,
    /** Absolute backstop (fires even if the lifter sagged through the warm-up, which would
     *  otherwise make the relative check blind to a constant sag). Sag is judged more strictly
     *  than pike: [Plank] tolerates ~12° below vs ~35° above; [PushForm] uses ±20° on a rep
     *  AVERAGE — our 150 ms peak is noisier, so 25° sag. */
    absSagDeg: 25,
    absPikeDeg: 35,
  },

  /**
   * P2 eccentric control — descent speed of the shoulders vs the warm-up baseline. 2.0× is the
   * squat's hard-won value: slow warm-up reps depress the baseline, and 1.5× fired on normal reps.
   * There is NO bounce threshold: push-up reversal times have never been measured here, and the
   * squat's first bounce number (150 ms) turned out to be physically unreachable. Reversal is
   * logged to the eval log so the first real distribution can set it.
   */
  eccentric: { descentSpikeMult: 2.0 },

  /**
   * P7 elbow flare (front) — (elbowSpan − wristSpan)/shoulderWidth: how far the elbows travel
   * OUTSIDE the wrists. Vertical forearms (the coaching cue) read ≈0.
   * [DERIVED] at the bottom with standard hands: 20° flare ≈0.3, 45° ≈0.8, 90° (T) ≈1.4. 1.0 ≈ 60°,
   * i.e. past the self-selected 54° of [Suprak13]. Only gross flare is separable from noise in 2D.
   * depthGate 0.30: with straight arms the elbows sit on the wrist line and the ratio collapses to
   * ~0 regardless of technique, so near-lockout frames can't show flare. Frames past the gate on
   * the ASCENT count too (squat lesson — T7's worst cave was during the ascent).
   */
  elbowFlare: { ratioWarn: 1.0, depthGate: 0.3 },

  /**
   * P11 uneven press (front) — shoulder-line tilt minus wrist-line tilt (the wrists are on the
   * floor, so the differential cancels camera roll). Post-set, baseline-relative like squat T11,
   * and just as untrustworthy until calibrated. `warnDeg` is the absolute display/context warn.
   */
  shoulderLevel: { warnDeg: 10, baselineDeltaDeg: 8, depthGate: 0.3 },

  /** Hand width (front, context): wristSpan/shoulderSpan bands. Research widths are 100/150/170%
   *  of biacromial; BlazePose joint-centre shoulders read narrower, inflating our ratio. */
  handWidth: { narrowBelow: 0.9, wideAbove: 1.6 },

  /** Knee-variant check (side, context) at the lockout frames of the warm-up reps [DERIVED]:
   *  toes ≈175° knee / knee ≈0.5 arm-lengths above the hands; knees ≈143° / ≈0.02. */
  variantCheck: { kneeAngleMaxDeg: 150, kneeHeightMaxArms: 0.2 },

  /** Tier-2: a rep's tracking is unreliable when min visibility falls below this × the set's
   *  warm-up baseline (same value as the squat — UNVALIDATED for floor poses). */
  visDropRatio: 0.75,
} as const;

/**
 * Physical-possibility bounds: beyond these the landmark is wrong, not the lifter. Occlusion and
 * tracking failure are never faults, so these return "unknown" rather than warn.
 */
export const PUSHUP_PLAUSIBLE = {
  /** |body line deviation| beyond this = a limb landmark jumped (a real extreme sag ≲40°). */
  bodyLineMaxDeg: 75,
  flareRatio: { lo: -1.0, hi: 3.0 },
  handWidthRatio: { lo: 0.3, hi: 4.0 },
  shoulderTiltDiffMaxDeg: 45,
} as const;

// --- Severity + presentation bands ---------------------------------------------

/**
 * Severity bands — display/report ONLY (they never fire anything). "absAbove" compares |value|,
 * for the signed body line (sag + / pike −).
 */
export interface PushupSeverityBand {
  critical: number;
  worseWhen: "below" | "above" | "absAbove";
}

export const PUSHUP_SEVERITY: Partial<Record<PushupMetricId, PushupSeverityBand>> = {
  // Depth value = bottom upper-arm angle − preset target (deg); 15° short = a cut-short rep.
  depth: { critical: -15, worseWhen: "below" },
  // Lockout value = top ratio still below lockout height; 0.2 ≈ elbow stopped near 130°.
  lockout: { critical: 0.2, worseWhen: "above" },
  bodyLine: { critical: 40, worseWhen: "absAbove" },
  // Descent value = speed ÷ warm-up baseline.
  eccentricControl: { critical: 3.0, worseWhen: "above" },
  velocity: { critical: 0.65, worseWhen: "below" },
  elbowFlare: { critical: 1.3, worseWhen: "above" },
  shoulderLevel: { critical: 18, worseWhen: "above" },
};

/**
 * How far short, as a WORD (the coach may never quote a normalized number). Keyed by basis —
 * degrees and ratios are not comparable. The upper-arm bands are in degrees; the ratio bands
 * reuse the squat's depth_ratio bands (same unit: fraction of the lifter's own top height).
 */
export const PUSHUP_SHORTFALL_BANDS = {
  upper_arm_angle_deg: { marginal: 5, moderate: 15 },
  depth_ratio: { marginal: 0.05, moderate: 0.15 },
} as const;

export type PushupBasis = keyof typeof PUSHUP_SHORTFALL_BANDS;
