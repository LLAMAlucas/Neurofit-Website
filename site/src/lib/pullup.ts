/**
 * The pull-up: the same sixteen joints, hanging face-on (+Z) from a bar that
 * runs along X over the body's head.
 *
 * PURE — no React, no three, no DOM.
 *
 * Built like the push-up: the hands never move, the shoulders are put where the
 * rep says they are, the trunk and legs hang off them at their own angles, and
 * the elbows are solved onto the hands. The faults are then things the whole
 * hanging body does — it swings about the bar (a kip), the legs fold up and
 * drive (leg drive), or it tips so one shoulder leads (uneven pull).
 *
 * Tempo is the squat's (`depthAt`), with depth meaning HEIGHT here: 0 is a dead
 * hang, 1 is chin over the bar. The rest position is the bottom — the reverse of
 * the other two, and the tracker counts it that way too.
 */
import type { JointName } from "./pose";
import { bump, depthAt, type Pose } from "./poseFrames";
import {
  HIPS,
  KNEES,
  SHOULDERS,
  angleAt,
  boneLen,
  inPlane,
  jx,
  jy,
  jz,
  rotateJoints,
  setJoint,
  sideAngle,
  solveMiddle,
  standX,
} from "./kinematics";

export type PullupBeat = "kip" | "legDrive" | "uneven";

/** The bar: along X, this high, at z = 0. */
export const BAR_Y = 2.2;
/** Its half-length over one body. */
export const BAR_HALF = 0.72;
/** Where the wrists hang: below the bar and a touch to the body's side of it,
 *  so the upright hand presses its palm against the bar and the fingers wrap
 *  over the top (retarget's `handsGrip`). A little wider than the shoulders:
 *  an ordinary overhand grip, not a wide one. */
export const WRIST_Y = BAR_Y - 0.08;
export const WRIST_Z = -0.03;
const GRIP_X = 0.3;

const ARM_REACH = 0.995 * (boneLen("shoulderL", "elbowL") + boneLen("elbowL", "wristL"));
/** Shoulders in a dead hang (arms straight, a hair short of locked), and at the
 *  top: just under the hands, and pulled back behind the bar so the face
 *  clears it. */
const SZ_HANG = -0.02;
const SY_HANG = WRIST_Y - Math.sqrt(ARM_REACH ** 2 - (GRIP_X - standX("shoulderR")) ** 2 - SZ_HANG ** 2);
const SY_TOP = WRIST_Y - 0.04;
const SZ_TOP = -0.14;
/** At the top the trunk leans back and the head tips back, chest to the bar. */
const LEAN_TOP = (12 * Math.PI) / 180;
const HEAD_BACK = (25 * Math.PI) / 180;
/** Feet hang pointed, a little in front of the body at the top (hollow). */
const FOOT_POINT = (38 * Math.PI) / 180;

/** Kip: how far the body swings about the bar each way at full fault. */
const KIP_RAD = (14 * Math.PI) / 180;
/** Kip: the hips' snap as the swing comes forward. */
const KIP_HIP = (18 * Math.PI) / 180;
/** Leg drive: hips and knees folding to throw the body up. */
const DRIVE_HIP = (50 * Math.PI) / 180;
const DRIVE_KNEE = (70 * Math.PI) / 180;
/** Uneven: how far the body tips, the left shoulder trailing. */
const UNEVEN_RAD = (12 * Math.PI) / 180;

const TRUNK = inPlane("shoulderL", "hipL");
const THIGH = inPlane("hipL", "kneeL");
const SHIN = inPlane("kneeL", "ankleL");
const FOOT = inPlane("ankleL", "toeL");
const NECK = inPlane("neck", "shoulderL");

/** Everything that hangs from the hands: the whole body but the wrists. */
const HANGING: JointName[] = [
  "head", "neck", "shoulderL", "shoulderR", "elbowL", "elbowR",
  "hipL", "hipR", "kneeL", "kneeR", "ankleL", "ankleR", "toeL", "toeR",
];
const BELOW_SHOULDERS: JointName[] = ["hipL", "hipR", "kneeL", "kneeR", "ankleL", "ankleR", "toeL", "toeR"];

/** Kip timing: a back-swing while still hanging, then the forward drive that
 *  throws the pull. Signed: + is feet back (arched), − feet forward. */
export const kipSwing = (phase: number) =>
  bump(phase, 0, 0.09, 0.12, 0.22) - bump(phase, 0.14, 0.3, 0.42, 0.72);

const ENVELOPES: Record<PullupBeat, (phase: number) => number> = {
  // The swing starts in the hang, before the arms bend: the tracker reads it
  // over the rep plus a second before it, for that reason.
  kip: (ph) => bump(ph, 0, 0.06, 0.62, 0.8),
  // The legs fold as the pull starts and hang again by the top.
  legDrive: (ph) => bump(ph, 0.1, 0.24, 0.46, 0.68),
  // One side leads through the middle of the pull.
  uneven: (ph) => bump(ph, 0.2, 0.34, 0.52, 0.7),
};

export const pullupEnvelope = (beat: PullupBeat, phase: number) => ENVELOPES[beat](phase);

/**
 * The pull-up at `height` (0 dead hang → 1 chin over the bar), with `beat` at
 * `amount`. `phase` times the kip's swing within the rep.
 */
export function pullupPose(height: number, beat: PullupBeat | null, amount: number, phase: number, out: Pose): void {
  const a = beat ? amount : 0;
  const h = Math.max(0, Math.min(1, height));
  const sy = SY_HANG + (SY_TOP - SY_HANG) * h;
  const sz = SZ_HANG + (SZ_TOP - SZ_HANG) * h;
  const lean = LEAN_TOP * h;

  // Hip and knee fold: leg drive, or the kip's hip snap as it swings forward.
  const swing = beat === "kip" ? kipSwing(phase) : 0;
  const hipFlex = beat === "legDrive" ? DRIVE_HIP * a : beat === "kip" ? KIP_HIP * a * Math.max(0, -swing) : 0;
  const kneeFlex = beat === "legDrive" ? DRIVE_KNEE * a : 0;

  // Down from each shoulder: trunk (leaning back, hips forward), thigh, shin, foot.
  // Angles are measured from straight down, + toward the front (+Z).
  const legAngle = lean * 1.25 + hipFlex;
  const shinAngle = legAngle - kneeFlex;
  for (const s of ["L", "R"] as const) {
    const j = (n: string) => `${n}${s}` as JointName;
    const hy = sy - TRUNK * Math.cos(lean), hz = sz + TRUNK * Math.sin(lean);
    const ky = hy - THIGH * Math.cos(legAngle), kz = hz + THIGH * Math.sin(legAngle);
    const ay = ky - SHIN * Math.cos(shinAngle), az = kz + SHIN * Math.sin(shinAngle);
    const toe = shinAngle + FOOT_POINT;
    setJoint(out, j("shoulder"), standX(j("shoulder")), sy, sz);
    setJoint(out, j("hip"), standX(j("hip")), hy, hz);
    setJoint(out, j("knee"), standX(j("knee")), ky, kz);
    setJoint(out, j("ankle"), standX(j("ankle")), ay, az);
    setJoint(out, j("toe"), standX(j("toe")), ay - FOOT * Math.cos(toe), az + FOOT * Math.sin(toe));
  }

  // Neck up the trunk line; the head tips back toward the top.
  const uy = Math.cos(lean), uz = -Math.sin(lean);
  const ny = sy + NECK * uy, nz = sz + NECK * uz;
  const tilt = HEAD_BACK * h;
  const hy2 = Math.cos(lean + tilt), hz2 = -Math.sin(lean + tilt);
  setJoint(out, "neck", 0, ny, nz);
  setJoint(out, "head", 0, ny + 0.16 * hy2 - 0.02 * hz2, nz + 0.16 * hz2 + 0.02 * hy2);

  // Uneven: the body tips about the middle of the shoulders, left side low.
  if (beat === "uneven" && a > 0) {
    rotateJoints(out, [...BELOW_SHOULDERS, "shoulderL", "shoulderR", "neck", "head"], "xy", 0, sy, UNEVEN_RAD * a);
  }

  // Hands on the bar; elbows out to the sides and a little forward.
  setJoint(out, "wristL", -GRIP_X, WRIST_Y, WRIST_Z);
  setJoint(out, "wristR", GRIP_X, WRIST_Y, WRIST_Z);
  solveMiddle(out, "shoulderL", "elbowL", "wristL", -0.85, -0.35, 0.4);
  solveMiddle(out, "shoulderR", "elbowR", "wristR", 0.85, -0.35, 0.4);

  // Kip: the whole hanging body swings about the grip.
  if (swing !== 0 && a > 0) rotateJoints(out, HANGING, "yz", WRIST_Y, WRIST_Z, KIP_RAD * a * swing);
}

/* ── readouts, degrees, off the live pose ─────────────────────────────── */

export const pullupElbowDeg = (p: Pose) =>
  (angleAt(p, "shoulderL", "elbowL", "wristL") + angleAt(p, "shoulderR", "elbowR", "wristR")) / 2;

/** Hands → hips from straight down, side-on: what the app's swing check reads.
 *  Signed, + with the hips in front of the bar. */
export function swingDeg(p: Pose): number {
  const wy = (jy(p, "wristL") + jy(p, "wristR")) / 2, wz = (jz(p, "wristL") + jz(p, "wristR")) / 2;
  const hy = (jy(p, "hipL") + jy(p, "hipR")) / 2, hz = (jz(p, "hipL") + jz(p, "hipR")) / 2;
  return (Math.atan2(hz - wz, wy - hy) * 180) / Math.PI;
}

/** How far the thighs are lifted off the trunk line, side-on, degrees. */
export const kneeLiftDeg = (p: Pose) => 180 - sideAngle(p, SHOULDERS, HIPS, KNEES);

/** The shoulder line's tilt, degrees: the hands are level on the bar, so this
 *  is the whole of the app's uneven-pull reading. */
export const shoulderTiltDeg = (p: Pose) =>
  (Math.atan2(jy(p, "shoulderR") - jy(p, "shoulderL"), jx(p, "shoulderR") - jx(p, "shoulderL")) * 180) / Math.PI;

/** Where the chin is, height: a third of the way up the head from the neck,
 *  and forward of that toward the face. */
export function chinY(p: Pose): number {
  const ny = jy(p, "neck"), nz = jz(p, "neck");
  const hy = jy(p, "head"), hz = jz(p, "head");
  const l = Math.hypot(hy - ny, hz - nz) || 1;
  // The face is forward of the head's own axis; its height component is −uz.
  const fy = -(hz - nz) / l;
  return ny + (hy - ny) * 0.3 + 0.08 * fy;
}

/** One rep of `beat`, `phase` of the way through, into `out`. `reach` caps how
 *  high the rep gets — a rep that stops short of the bar. */
export function pullupRep(beat: PullupBeat | null, phase: number, severity: number, out: Pose, reach = 1) {
  const depth = depthAt(phase) * reach;
  const envelope = beat ? pullupEnvelope(beat, phase) : 0;
  pullupPose(depth, beat, envelope * severity, phase, out);
  return { depth, envelope };
}
