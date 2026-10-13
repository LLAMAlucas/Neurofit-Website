/**
 * Small, allocation-free helpers for building a pose joint by joint: the push-up
 * and the pull-up are built this way (forward kinematics from a few angles, and
 * the arms solved onto hands that don't move) rather than lerped between
 * keyframes like the squat.
 *
 * PURE — no three, no DOM.
 */
import { BONES, J, type JointName } from "./pose";
import { REST, STAND, type Pose } from "./poseFrames";

/** Rest length of the bone between two joints, from the standing keyframe. */
export function boneLen(a: JointName, b: JointName): number {
  const i = BONES.findIndex(([x, y]) => (x === a && y === b) || (x === b && y === a));
  if (i < 0) throw new Error(`no bone ${a}-${b}`);
  return REST[i];
}

/** A joint's X in the standing keyframe: how wide each joint sits. The push-up
 *  and pull-up keep every joint at its standing width, which is what lets them
 *  work in the sagittal plane alone and still hold 3D bone lengths. */
export const standX = (j: JointName) => STAND[J[j] * 3];

/** Length of a bone once its two ends' fixed X offset is taken out: what is left
 *  to spend in the sagittal (Y–Z) plane. */
export function inPlane(a: JointName, b: JointName): number {
  const dx = standX(a) - standX(b);
  const l = boneLen(a, b);
  return Math.sqrt(Math.max(0, l * l - dx * dx));
}

export function setJoint(p: Pose, j: JointName, x: number, y: number, z: number): void {
  const i = J[j] * 3;
  p[i] = x;
  p[i + 1] = y;
  p[i + 2] = z;
}

export const jx = (p: Pose, j: JointName) => p[J[j] * 3];
export const jy = (p: Pose, j: JointName) => p[J[j] * 3 + 1];
export const jz = (p: Pose, j: JointName) => p[J[j] * 3 + 2];

/**
 * Place the middle joint of a two-bone chain (shoulder → elbow → wrist) whose two
 * ends are already placed, bending toward `pole`. The ends stay exactly where
 * they are: if they are further apart than the chain can reach, the chain comes
 * out straight along the line between them rather than breaking.
 */
export function solveMiddle(
  p: Pose,
  root: JointName,
  mid: JointName,
  end: JointName,
  px: number,
  py: number,
  pz: number,
): void {
  const la = boneLen(root, mid);
  const lb = boneLen(mid, end);
  const ax = jx(p, root), ay = jy(p, root), az = jz(p, root);
  let ux = jx(p, end) - ax, uy = jy(p, end) - ay, uz = jz(p, end) - az;
  const d = Math.hypot(ux, uy, uz) || 1e-6;
  ux /= d;
  uy /= d;
  uz /= d;
  const dd = Math.min(d, (la + lb) * 0.9999);
  const along = (la * la - lb * lb + dd * dd) / (2 * dd);
  const h = Math.sqrt(Math.max(0, la * la - along * along));
  // The pole, with its component along the chain taken out.
  const k = px * ux + py * uy + pz * uz;
  let nx = px - ux * k, ny = py - uy * k, nz = pz - uz * k;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl;
  ny /= nl;
  nz /= nl;
  setJoint(p, mid, ax + ux * along + nx * h, ay + uy * along + ny * h, az + uz * along + nz * h);
}

/**
 * Rotate the listed joints by `theta` about an axis through (c0, c1): along X
 * (plane "yz": +Y turns toward +Z) or along Z (plane "xy": +X turns toward +Y).
 */
export function rotateJoints(
  p: Pose,
  joints: readonly JointName[],
  plane: "yz" | "xy",
  c0: number,
  c1: number,
  theta: number,
): void {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const [i0, i1] = plane === "yz" ? [1, 2] : [0, 1];
  for (const j of joints) {
    const i = J[j] * 3;
    const a = p[i + i0] - c0;
    const b = p[i + i1] - c1;
    p[i + i0] = c0 + a * cos - b * sin;
    p[i + i1] = c1 + a * sin + b * cos;
  }
}

/**
 * Interior angle at `b` of a–b–c in the SIDE view, degrees: each point the
 * midpoint of its left and right joints, projected onto the Y–Z plane. What a
 * side-on camera reads for a body line or a hip fold — and, unlike the 3D angle,
 * 180° when the body really is straight, since the hips sit narrower than the
 * shoulders and the ankles.
 */
export function sideAngle(
  p: Pose,
  a: readonly [JointName, JointName],
  b: readonly [JointName, JointName],
  c: readonly [JointName, JointName],
): number {
  const my = (k: readonly [JointName, JointName]) => (jy(p, k[0]) + jy(p, k[1])) / 2;
  const mz = (k: readonly [JointName, JointName]) => (jz(p, k[0]) + jz(p, k[1])) / 2;
  const uy = my(a) - my(b), uz = mz(a) - mz(b);
  const vy = my(c) - my(b), vz = mz(c) - mz(b);
  const cos = (uy * vy + uz * vz) / (Math.hypot(uy, uz) * Math.hypot(vy, vz) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

export const SHOULDERS = ["shoulderL", "shoulderR"] as const;
export const HIPS = ["hipL", "hipR"] as const;
export const KNEES = ["kneeL", "kneeR"] as const;
export const ANKLES = ["ankleL", "ankleR"] as const;

/** Interior angle at `b` of the path a–b–c, degrees. */
export function angleAt(p: Pose, a: JointName, b: JointName, c: JointName): number {
  const ux = jx(p, a) - jx(p, b), uy = jy(p, a) - jy(p, b), uz = jz(p, a) - jz(p, b);
  const vx = jx(p, c) - jx(p, b), vy = jy(p, c) - jy(p, b), vz = jz(p, c) - jz(p, b);
  const cos = (ux * vx + uy * vy + uz * vz) / (Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}
