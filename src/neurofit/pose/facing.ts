/**
 * Facing detection — how the body is oriented to the camera. PURE module.
 * ----------------------------------------------------------------------------
 * A single scale-invariant "facing score":
 *   score = shoulder x-separation / torso length (shoulder-mid → hip-mid)
 *     - head-on : shoulders wide vs torso  -> HIGH score
 *     - side-on : shoulders nearly stacked -> LOW score
 *     - angled  : in between
 *
 * z-difference is only relative depth in MediaPipe, so classification keys off
 * the score. The orientation layer (vision/orientation.ts) maps the score to a
 * facing angle and applies the tunable bands in config.ORIENTATION.
 *
 * ASPECT SPACE: MediaPipe normalizes x by the frame WIDTH and y by the HEIGHT, so a
 * horizontal distance over a mostly-vertical one is scaled by H/W — 0.56× on the 16:9
 * camera the anchors were tuned on, 1.78× on a portrait phone. The score is computed on
 * [x·W/H, y] so the same body gives the same score on every camera.
 */
import { getLandmark, type Landmark } from "./landmarks";

export interface FacingMetrics {
  /** Shoulder-width / torso-length ratio in aspect space. ~0 side-on, large head-on. */
  score: number;
}

/**
 * Compute the facing score, or null if the shoulders/hips aren't confidently
 * visible (can't trust an orientation read without them). `aspect` = frame W/H.
 */
export function computeFacing(
  landmarks: readonly Landmark[],
  minVisibility: number,
  aspect: number,
): FacingMetrics | null {
  const ls = getLandmark(landmarks, "LEFT_SHOULDER");
  const rs = getLandmark(landmarks, "RIGHT_SHOULDER");
  const lh = getLandmark(landmarks, "LEFT_HIP");
  const rh = getLandmark(landmarks, "RIGHT_HIP");
  if (!ls || !rs || !lh || !rh) return null;
  if (
    Math.min(ls.visibility, rs.visibility) < minVisibility ||
    Math.min(lh.visibility, rh.visibility) < minVisibility
  ) {
    return null;
  }

  const shoulderXSep = Math.abs(ls.x - rs.x) * aspect;
  const smx = (ls.x + rs.x) / 2;
  const smy = (ls.y + rs.y) / 2;
  const hmx = (lh.x + rh.x) / 2;
  const hmy = (lh.y + rh.y) / 2;
  const torsoLen = Math.hypot((smx - hmx) * aspect, smy - hmy);
  if (torsoLen < 1e-6) return null;

  return { score: shoulderXSep / torsoLen };
}
