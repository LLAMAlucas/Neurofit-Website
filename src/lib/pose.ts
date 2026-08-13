/**
 * Skeleton TOPOLOGY. No joint positions live here — those are keyframes, and
 * they live in `poseFrames.ts`.
 *
 * The joint set follows the landmarks the tracker actually works in (shoulders,
 * elbows, wrists, hips, knees, ankles) rather than an art-rig skeleton: the
 * point of the figure is that it is the same thing the app draws on your camera
 * feed, in three dimensions.
 *
 * Axes: Y up, X right, +Z is the direction the figure FACES. So a Y-rotation of
 * PI/2 presents its side to the camera and 0 presents its front — which is the
 * whole side-view/head-on argument the page makes, expressed as one rotation.
 * Units are roughly metres.
 */

export const JOINT_NAMES = [
  "head",
  "neck",
  "shoulderL",
  "shoulderR",
  "elbowL",
  "elbowR",
  "wristL",
  "wristR",
  "hipL",
  "hipR",
  "kneeL",
  "kneeR",
  "ankleL",
  "ankleR",
  "toeL",
  "toeR",
] as const;

export type JointName = (typeof JOINT_NAMES)[number];

export const JOINT_COUNT = JOINT_NAMES.length;

/** Index of each joint into a flat `Float32Array(JOINT_COUNT * 3)`. */
export const J = Object.fromEntries(JOINT_NAMES.map((n, i) => [n, i])) as Record<JointName, number>;

/** Drawn in roughly the order a tracker locks on: spine out to the limbs. */
export const BONES: ReadonlyArray<readonly [JointName, JointName]> = [
  ["head", "neck"],
  ["neck", "shoulderL"],
  ["neck", "shoulderR"],
  ["shoulderL", "shoulderR"],
  ["shoulderL", "hipL"],
  ["shoulderR", "hipR"],
  ["hipL", "hipR"],
  ["shoulderL", "elbowL"],
  ["elbowL", "wristL"],
  ["shoulderR", "elbowR"],
  ["elbowR", "wristR"],
  ["hipL", "kneeL"],
  ["kneeL", "ankleL"],
  ["ankleL", "toeL"],
  ["hipR", "kneeR"],
  ["kneeR", "ankleR"],
  ["ankleR", "toeR"],
];

export const BONE_COUNT = BONES.length;

/** Look a bone up by its endpoints, so fault sets can be written in names. */
export function boneIndex(a: JointName, b: JointName): number {
  const i = BONES.findIndex(([x, y]) => x === a && y === b);
  if (i < 0) throw new Error(`no bone ${a}->${b}`);
  return i;
}

/* ── framing ──────────────────────────────────────────────────────────────
   The figure compresses downward through a rep — the feet stay planted and the
   head drops about half a metre — so the camera aims at a FIXED height and the
   squat happens inside the frame, rather than the camera riding the body down. */

/** What the wide camera looks at: mid-height of the standing figure. */
export const FRAME_CENTER_Y = 0.86;

/*
 * The figure must spin about its own centroid, not the world origin: hips sit
 * back and knees/wrists reach forward, so the mass is biased to +Z and spinning
 * about origin swings the whole body sideways (measured: the side view landed
 * 27px right of centre in a 452px frame).
 *
 * That centroid MOVES through a rep — mean joint Z runs 0.021 standing to 0.137
 * at the bottom, as the arms come forward and the hips go back — so it is
 * recomputed per frame in `PoseSkeleton3D` rather than being a constant here.
 * A fixed value would be right at one end of the rep and wrong at the other.
 */

/**
 * Height of the depth guide line. Knee height barely changes through a squat —
 * the hip is what travels — which is exactly why the app measures depth as
 * hip-Y against knee-Y and never as a knee angle. One line at knee height with
 * the hips descending onto it is that rule, drawn.
 */
export const GUIDE_Y = 0.5;
