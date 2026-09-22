/**
 * Camera-angle estimation. PURE module.
 * ----------------------------------------------------------------------------
 * The other half of the environmental-robustness wedge: a phone propped on a
 * bench is rarely square to the body. We estimate two things from the pose
 * itself (no extra model, no reference object — the honest Phase-1 approach the
 * spec allows):
 *
 *   - ROLL  : the shoulder line tilted off horizontal (phone rotated). Joint
 *             ANGLES are rotation-invariant so reps/knee angle are unaffected,
 *             but the trunk-vs-vertical lean check IS — so we surface rollDeg and
 *             the form layer subtracts it.
 *   - YAW / obliqueness : how side-on the body is, from the facing score
 *             (shoulder-width / torso-length). Knee valgus is only observable
 *             from a frontal-ish view, so we flag when it isn't.
 *
 * Thresholds are starting points (MediaPipe `z` is relative depth, not metric).
 */
import { computeFacing } from "../pose/facing";
import { getLandmark, type Landmark } from "../pose/landmarks";

export type CameraView = "frontal" | "oblique" | "side" | "unknown";

export interface CameraAngleEstimate {
  /** Shoulder-line tilt off horizontal (deg, signed). null if not readable. */
  rollDeg: number | null;
  /** 0 = square/frontal, 1 = fully side-on. null if not readable. */
  obliqueness: number | null;
  view: CameraView;
  /** Which leg to trust for the knee angle in oblique/side views. */
  preferredSide: "left" | "right" | "both" | null;
  /** Is knee valgus observable from this view (needs frontal-ish + both legs)? */
  valgusObservable: boolean;
  label: string;
}

// Facing-score bands (frontal vs side cutoffs on the shoulder/torso ratio). The score is in
// aspect space now (pose/facing.ts): these are the old normalized-space 0.6 / 0.3 × 16/9, the
// 1280×720 camera every recorded session used, so the label reads exactly as before there.
const FRONTAL_MIN = 1.07;
const SIDE_MAX = 0.53;
// Real degrees of camera roll. Kept at 8 through the aspect fix: it is a geometric intent, not a
// value tuned on footage — and in normalized space it had meant ~4.5° of real tilt on 16:9.
const ROLL_WARN_DEG = 8;

const UNREADABLE: CameraAngleEstimate = {
  rollDeg: null,
  obliqueness: null,
  view: "unknown",
  preferredSide: null,
  valgusObservable: false,
  label: "Position yourself in frame",
};

function v(landmarks: readonly Landmark[], name: Parameters<typeof getLandmark>[1], minVis: number): Landmark | null {
  const p = getLandmark(landmarks, name);
  return p && p.visibility >= minVis ? p : null;
}

/** `aspect` = frame W/H. A rolled camera rotates the image in PIXEL space, so the roll is only
 *  a true angle on [x·W/H, y]; in normalized space a 4.5° tilt read as 8° on a 16:9 frame. */
export function estimateCameraAngle(
  landmarks: readonly Landmark[],
  minVis: number,
  aspect: number,
): CameraAngleEstimate {
  const facing = computeFacing(landmarks, minVis, aspect);
  if (!facing) return UNREADABLE;

  const ls = v(landmarks, "LEFT_SHOULDER", minVis);
  const rs = v(landmarks, "RIGHT_SHOULDER", minVis);
  let rollDeg: number | null = null;
  if (ls && rs) {
    // Tilt of the shoulder line off horizontal. (Mirrored display doesn't change magnitude.)
    rollDeg = (Math.atan2(rs.y - ls.y, (rs.x - ls.x) * aspect) * 180) / Math.PI;
    if (rollDeg > 90) rollDeg -= 180;
    if (rollDeg < -90) rollDeg += 180;
  }

  const score = facing.score;
  const view: CameraView = score >= FRONTAL_MIN ? "frontal" : score <= SIDE_MAX ? "side" : "oblique";
  // Map score (FRONTAL_MIN..SIDE_MAX) -> obliqueness (0..1).
  const obliqueness = clamp01((FRONTAL_MIN - score) / (FRONTAL_MIN - SIDE_MAX));

  // In oblique/side views trust the more-visible (near) leg for the knee angle.
  const lk = getLandmark(landmarks, "LEFT_KNEE");
  const rk = getLandmark(landmarks, "RIGHT_KNEE");
  let preferredSide: CameraAngleEstimate["preferredSide"] = "both";
  if (view !== "frontal" && lk && rk) {
    preferredSide = lk.visibility >= rk.visibility ? "left" : "right";
  }

  const bothLegs = !!(
    v(landmarks, "LEFT_KNEE", minVis) &&
    v(landmarks, "RIGHT_KNEE", minVis) &&
    v(landmarks, "LEFT_ANKLE", minVis) &&
    v(landmarks, "RIGHT_ANKLE", minVis)
  );
  const valgusObservable = (view === "frontal" || view === "oblique") && bothLegs;

  const rolled = rollDeg !== null && Math.abs(rollDeg) > ROLL_WARN_DEG;
  const label = rolled
    ? `Camera tilted ${Math.round(Math.abs(rollDeg as number))}° — compensating`
    : view === "frontal"
      ? "Camera square-on"
      : view === "side"
        ? "Side-on view — knee tracking limited"
        : "Slight angle — compensating";

  return { rollDeg, obliqueness, view, preferredSide, valgusObservable, label };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
