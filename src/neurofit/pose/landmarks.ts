/**
 * Pose landmark primitives. PURE module (no React, no DOM, no MediaPipe import).
 * ----------------------------------------------------------------------------
 * Neuro-Fit owns this outright — the only landmark vocabulary the squat, push-up
 * and pull-up coaches need. MediaPipe's NormalizedLandmark is structurally assignable to `Landmark`,
 * so detection results pass straight in without adapting them.
 */

/** MediaPipe Pose landmark names Neuro-Fit references. */
export type LandmarkName =
  | "NOSE"
  | "LEFT_EAR" | "RIGHT_EAR"
  | "MOUTH_LEFT" | "MOUTH_RIGHT"
  | "LEFT_SHOULDER" | "RIGHT_SHOULDER"
  | "LEFT_ELBOW" | "RIGHT_ELBOW"
  | "LEFT_WRIST" | "RIGHT_WRIST"
  | "LEFT_PINKY" | "RIGHT_PINKY"
  | "LEFT_INDEX" | "RIGHT_INDEX"
  | "LEFT_HIP" | "RIGHT_HIP"
  | "LEFT_KNEE" | "RIGHT_KNEE"
  | "LEFT_ANKLE" | "RIGHT_ANKLE"
  | "LEFT_FOOT_INDEX" | "RIGHT_FOOT_INDEX";

/** A single pose landmark in normalized [0,1] image coordinates. */
export interface Landmark {
  x: number;
  y: number;
  /** Relative depth vs the hips (NOT metric). */
  z: number;
  /** Detector confidence for this point, [0,1]. */
  visibility: number;
}

/**
 * MediaPipe Pose's 33-landmark index for each name we reference.
 * Full enum: https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
 */
export const POSE_LANDMARK_INDEX: Record<LandmarkName, number> = {
  // Head + arms were added for push-ups (head drop, elbow/upper-arm geometry, wrist line).
  NOSE: 0,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  // Mouth corners + hand knuckles were added for pull-ups: the chin estimate and the bar line
  // (the grip sits on the bar, so the knuckles mark it).
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  // Re-added for the v2 ankle/foot proxies (shin angle, foot orientation). These
  // are chronically LOW-visibility (shoes, ground, blur) — always gate on ≥0.6.
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
};

/** Resolve a landmark by name from a single person's landmark array. */
export function getLandmark(
  landmarks: readonly Landmark[],
  name: LandmarkName,
): Landmark | undefined {
  return landmarks[POSE_LANDMARK_INDEX[name]];
}

/** Confidence floor for a landmark to count toward a measurement. */
export const MIN_VISIBILITY = 0.6;
