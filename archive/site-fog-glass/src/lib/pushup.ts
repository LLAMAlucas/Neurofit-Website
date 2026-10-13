/**
 * The push-up: the same sixteen joints as the squat, lying face down along Z
 * (head toward +Z), hands and toes on the floor.
 *
 * PURE — no React, no three, no DOM.
 *
 * Built, not lerped. A push-up is a body that stays nearly straight and rocks
 * about the toes while the arms fold under it, so it is written as exactly that:
 * the leg line pivots on the balls of the feet to put the shoulders at the height
 * the rep calls for, the trunk hangs off the hips at its own angle (which is where
 * a sag or a pike lives), and each elbow is solved onto a hand that never moves.
 * Every bone keeps its standing length by construction, not by relaxation.
 *
 * Tempo is the squat's (`depthAt`): slow down, a beat at the bottom, faster up.
 * Depth 0 is arms locked out at the top, 1 is chest a hand off the floor.
 */
import type { JointName } from "./pose";
import { depthAt, bump, type Pose } from "./poseFrames";
import {
  ANKLES,
  HIPS,
  SHOULDERS,
  angleAt,
  boneLen,
  inPlane,
  jx,
  jy,
  jz,
  setJoint,
  sideAngle,
  solveMiddle,
  standX,
} from "./kinematics";

export type PushupBeat = "sag" | "pike" | "flare" | "uneven";

/** Balls of the feet on the floor, and how far back from the hands they are. */
const TOE_Y = 0.02;
const TOE_Z = -0.8;
/** Wrists just off the floor (the hand lies under the wrist joint). */
export const WRIST_Y = 0.03;
/** Hands a little wider than the shoulders. */
const WRIST_X = 0.22;
/** Shoulder height, metres, at the bottom: the chest a hand's depth off the
 *  floor, the upper arm past parallel — what the app's chest preset asks for. */
const SHOULDER_Y_BOTTOM = 0.2;

/** The foot, in the body's own frame, from the standing keyframe: ankle → toe is
 *  mostly the way the body faces and a little toward the feet. Kept in the
 *  plank, which puts the toes nearly straight under the ankles — on the balls
 *  of the feet. */
const FOOT_UP = -0.05 / Math.hypot(0.05, 0.16);
const FOOT_FACE = 0.16 / Math.hypot(0.05, 0.16);

/** Elbows' angle out from the body, radians: 40° tucked, 85° flared out to the
 *  side (the app's flare check reads elbow span against hand span). */
const TUCK = (40 * Math.PI) / 180;
const FLARE = (85 * Math.PI) / 180;
/** How far the hips bend off the body line at full fault. Sag: the trunk rises
 *  off the legs, the hips a valley (20°). Pike: the hips a peak (30°). */
export const SAG_RAD = (20 * Math.PI) / 180;
export const PIKE_RAD = (30 * Math.PI) / 180;
/** Uneven press: how far behind in the rep the slow side runs, in depth — about
 *  12° of shoulder tilt over level hands, past the app's +8° line. */
const UNEVEN_LAG = 0.25;

const SHIN = inPlane("kneeL", "ankleL");
const THIGH = inPlane("hipL", "kneeL");
const TRUNK = inPlane("shoulderL", "hipL");
const FOOT = inPlane("ankleL", "toeL");
/** Neck above the shoulder line, and the head above and in front of the neck,
 *  as in the standing keyframe. */
const NECK = inPlane("neck", "shoulderL");
const HEAD_UP = 0.16;
const HEAD_FACE = 0.02;
/** Arm fully reached, a hair short of dead straight: the lockout reads ~168°,
 *  past the app's 150° lockout gate, and the elbow's bend never flips. */
const REACH = 0.995 * (boneLen("shoulderL", "elbowL") + boneLen("elbowL", "wristL"));

/** One side's leg line, pivoting on its toe: where the shoulder lands for a leg
 *  angle `theta` (above the floor) and a trunk angle `theta + bend`. Writes the
 *  side's joints into `out` when given. */
function side(
  s: "L" | "R",
  theta: number,
  bend: number,
  out: Pose | null,
): { sy: number; sz: number } {
  const uy = Math.sin(theta), uz = Math.cos(theta);
  const fy = -uz, fz = uy;
  const ay = TOE_Y - FOOT * (FOOT_UP * uy + FOOT_FACE * fy);
  const az = TOE_Z - FOOT * (FOOT_UP * uz + FOOT_FACE * fz);
  const ky = ay + SHIN * uy, kz = az + SHIN * uz;
  const hy = ky + THIGH * uy, hz = kz + THIGH * uz;
  const ty = Math.sin(theta + bend), tz = Math.cos(theta + bend);
  const sy = hy + TRUNK * ty, sz = hz + TRUNK * tz;
  if (out) {
    const j = (n: string) => `${n}${s}` as JointName;
    setJoint(out, j("toe"), standX(j("toe")), TOE_Y, TOE_Z);
    setJoint(out, j("ankle"), standX(j("ankle")), ay, az);
    setJoint(out, j("knee"), standX(j("knee")), ky, kz);
    setJoint(out, j("hip"), standX(j("hip")), hy, hz);
    setJoint(out, j("shoulder"), standX(j("shoulder")), sy, sz);
  }
  return { sy, sz };
}

/** The leg angle that puts the shoulder at height `y`, for a given hip bend. */
function thetaFor(y: number, bend: number): number {
  let lo = -0.4;
  let hi = 0.9;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (side("L", mid, bend, null).sy < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Where the hands are: under the shoulders at lockout, and never moving. */
const SHOULDER_Y_TOP = WRIST_Y + Math.sqrt(REACH * REACH - (WRIST_X - standX("shoulderR")) ** 2);
const THETA_TOP = thetaFor(SHOULDER_Y_TOP, 0);
export const WRIST_Z = side("L", THETA_TOP, 0, null).sz;

/** The deformations' timing within a rep (0…1 phase). */
const ENVELOPES: Record<PushupBeat, (phase: number) => number> = {
  // Sag shows most on the way back up, when the trunk has to be pressed along
  // with the arms — the app's body-line check runs the whole rep for that reason.
  sag: (ph) => bump(ph, 0.12, 0.38, 0.86, 0.97),
  pike: (ph) => bump(ph, 0.1, 0.32, 0.82, 0.95),
  // Only past a real bend: with straight arms the elbows have nowhere to flare.
  flare: (ph) => bump(ph, 0.22, 0.42, 0.7, 0.88),
  // One side falls behind as the press starts, and catches up at lockout.
  uneven: (ph) => bump(ph, 0.56, 0.66, 0.84, 0.94),
};

export const pushupEnvelope = (beat: PushupBeat, phase: number) => ENVELOPES[beat](phase);

/**
 * The push-up at `depth` (0 lockout → 1 bottom), with `beat` at `amount`.
 */
export function pushupPose(depth: number, beat: PushupBeat | null, amount: number, out: Pose): void {
  const a = beat ? amount : 0;
  const bend = beat === "sag" ? SAG_RAD * a : beat === "pike" ? -PIKE_RAD * a : 0;
  const lag = beat === "uneven" ? UNEVEN_LAG * a : 0;
  const yAt = (d: number) => SHOULDER_Y_TOP + (SHOULDER_Y_BOTTOM - SHOULDER_Y_TOP) * Math.min(1, d);

  // The lifter's left (−X) is the slow side of an uneven press.
  side("L", thetaFor(yAt(depth + lag), bend), bend, out);
  side("R", thetaFor(yAt(depth), bend), bend, out);

  // Neck and head ride the trunk, off the middle of the shoulders.
  const sy = (jy(out, "shoulderL") + jy(out, "shoulderR")) / 2;
  const sz = (jz(out, "shoulderL") + jz(out, "shoulderR")) / 2;
  const hy = (jy(out, "hipL") + jy(out, "hipR")) / 2;
  const hz = (jz(out, "hipL") + jz(out, "hipR")) / 2;
  const tl = Math.hypot(sy - hy, sz - hz) || 1;
  const ty = (sy - hy) / tl, tz = (sz - hz) / tl;
  const ny = sy + NECK * ty, nz = sz + NECK * tz;
  setJoint(out, "neck", 0, ny, nz);
  setJoint(out, "head", 0, ny + HEAD_UP * ty - HEAD_FACE * tz, nz + HEAD_UP * tz + HEAD_FACE * ty);

  // Hands planted; elbows solved onto them, back along the body or out wide.
  const b = beat === "flare" ? TUCK + (FLARE - TUCK) * a : TUCK;
  setJoint(out, "wristL", -WRIST_X, WRIST_Y, WRIST_Z);
  setJoint(out, "wristR", WRIST_X, WRIST_Y, WRIST_Z);
  solveMiddle(out, "shoulderL", "elbowL", "wristL", -Math.sin(b), 0.5, -Math.cos(b));
  solveMiddle(out, "shoulderR", "elbowR", "wristR", Math.sin(b), 0.5, -Math.cos(b));
}

/** Readouts, degrees, off the live pose. */
export const pushupElbowDeg = (p: Pose) =>
  (angleAt(p, "shoulderL", "elbowL", "wristL") + angleAt(p, "shoulderR", "elbowR", "wristR")) / 2;
/** The body line at the hips, side-on: 180° is a plank; a sag or a pike takes
 *  it down. */
export const pushupBodyLineDeg = (p: Pose) => sideAngle(p, SHOULDERS, HIPS, ANKLES);

/** The shoulder line's tilt over the (level) hands, head-on, degrees: the app's
 *  uneven-press reading. */
export const pressTiltDeg = (p: Pose) =>
  (Math.atan2(jy(p, "shoulderR") - jy(p, "shoulderL"), jx(p, "shoulderR") - jx(p, "shoulderL")) * 180) / Math.PI;

/** Elbow span past hand span, in shoulder widths: the app's flare reading. */
export function flareRatio(p: Pose): number {
  const elbow = Math.abs(jx(p, "elbowR") - jx(p, "elbowL"));
  const wrist = Math.abs(jx(p, "wristR") - jx(p, "wristL"));
  const shoulder = Math.abs(jx(p, "shoulderR") - jx(p, "shoulderL"));
  return (elbow - wrist) / shoulder;
}

/** One rep of `beat`, `phase` of the way through, into `out`. */
export function pushupRep(beat: PushupBeat | null, phase: number, severity: number, out: Pose) {
  const depth = depthAt(phase);
  const envelope = beat ? pushupEnvelope(beat, phase) : 0;
  pushupPose(depth, beat, envelope * severity, out);
  return { depth, envelope };
}
