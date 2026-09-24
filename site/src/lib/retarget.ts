/**
 * Puts a rigged human model into one of our poses.
 *
 * PURE in the sense that matters for `npm run check`: three's math and scene
 * graph only, no renderer, no DOM — it runs in Node against a synthetic rig.
 *
 * Our poses are 16 joint POSITIONS (`poseFrames.ts`); a rigged model wants bone
 * ROTATIONS. So each model bone is AIMED: swung, with the least rotation that
 * does it, until the line from it to its child points the way the matching
 * segment of our pose points. Only directions cross over — the model keeps its
 * own bone lengths and proportions. That is what lets a stock character squat
 * our squat without us re-authoring anything, and it is the same idea Kalidokit
 * uses to put MediaPipe landmarks onto VRM avatars.
 *
 * Because the lengths differ, aiming alone would leave the feet somewhere new.
 * The last step slides the whole body so its contacts land where they belong:
 * for the squat, the feet back where they stand in the bind pose — the same
 * "feet are planted and never move" rule `poseFrames` builds its relaxation
 * around; for a push-up or a pull-up, the hands (and toes) on our pose's own.
 */
import { Matrix3, Matrix4, Object3D, Quaternion, Vector3 } from "three";
import { J, type JointName } from "./pose";
import type { Pose } from "./poseFrames";

type Point = JointName | "hipMid" | "shoulderMid";

/** Aim `bone` so that the direction bone→`tip` matches our `from`→`to`. */
export type Aim = { bone: string; tip: string; from: Point; to: Point };

export type RigMap = {
  root: string;
  pelvis: string;
  /** Spine bones below the neck, pelvis-side first. They share the trunk's bend. */
  spine: string[];
  /** Where the trunk ends, for measuring the model's own trunk direction. */
  trunkTip: string;
  /** Limbs and neck, in parent-before-child order. */
  aims: Aim[];
  /** Bones held at their bind orientation in the world — the planted feet. */
  lockWorld: string[];
  /** The feet aimed at the toes instead, when they aren't planted flat (on the
   *  balls of the feet in a plank, hanging pointed from a bar). */
  footAims: Aim[];
  /** The hand bones, our L side first — laid flat on the floor for a push-up. */
  hands: [string, string];
};

/**
 * Where the model is put once it is posed.
 *
 * `feet` — the squat's rule: the feet keep their bind orientation and position,
 * flat on the floor where the model stands.
 *
 * `joints` — these model bones land (on average) on these joints of ours: the
 * hands and the balls of the feet on the floor for a push-up, the hands on the
 * bar for a pull-up. The feet are then aimed at our toes, and `handsFlat` lays
 * the hands palm-down on the floor, fingers forward, instead of letting them
 * run on down the forearm's line into it.
 */
export type Anchor =
  | { kind: "feet" }
  | { kind: "joints"; bones: readonly string[]; joints: readonly JointName[]; handsFlat?: boolean };

export const FEET_ANCHOR: Anchor = { kind: "feet" };
/** Push-up: hands and the balls of the feet on the floor (UE names; our L is
 *  the model's right). */
export const PUSHUP_ANCHOR: Anchor = {
  kind: "joints",
  bones: ["hand_r", "hand_l", "ball_r", "ball_l"],
  joints: ["wristL", "wristR", "toeL", "toeR"],
  handsFlat: true,
};
/** Pull-up: hands on the bar. */
export const PULLUP_ANCHOR: Anchor = { kind: "joints", bones: ["hand_r", "hand_l"], joints: ["wristL", "wristR"] };

/**
 * Unreal-mannequin names, as used by the Quaternius Universal Base Characters.
 *
 * Our `L` joints sit at −X. The model faces +Z like our figure does, so −X is
 * its anatomical RIGHT: the mapping below pairs by position, not by name.
 */
export const UE_RIG: RigMap = {
  root: "root",
  pelvis: "pelvis",
  spine: ["spine_01", "spine_02", "spine_03"],
  trunkTip: "neck_01",
  aims: [
    { bone: "neck_01", tip: "Head", from: "neck", to: "head" },
    { bone: "upperarm_r", tip: "lowerarm_r", from: "shoulderL", to: "elbowL" },
    { bone: "lowerarm_r", tip: "hand_r", from: "elbowL", to: "wristL" },
    { bone: "upperarm_l", tip: "lowerarm_l", from: "shoulderR", to: "elbowR" },
    { bone: "lowerarm_l", tip: "hand_l", from: "elbowR", to: "wristR" },
    { bone: "thigh_r", tip: "calf_r", from: "hipL", to: "kneeL" },
    { bone: "calf_r", tip: "foot_r", from: "kneeL", to: "ankleL" },
    { bone: "thigh_l", tip: "calf_l", from: "hipR", to: "kneeR" },
    { bone: "calf_l", tip: "foot_l", from: "kneeR", to: "ankleR" },
  ],
  lockWorld: ["foot_r", "foot_l"],
  footAims: [
    { bone: "foot_r", tip: "ball_r", from: "ankleL", to: "toeL" },
    { bone: "foot_l", tip: "ball_l", from: "ankleR", to: "toeR" },
  ],
  hands: ["hand_r", "hand_l"],
};

/**
 * Hands flat on the floor, fingers toward the head (+Z): the bind pose's hands
 * run straight out along ±X, palm down, so each turns a quarter about the
 * vertical. Ours-L (the model's right, −X) turns +90°; ours-R turns −90°.
 */
const HAND_FLAT: [Quaternion, Quaternion] = [
  new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2),
  new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2),
];

/**
 * How much of the trunk's bend the pelvis takes. The rest is spread evenly up
 * the spine. A squat's forward lean is mostly a hinge at the hips, with the
 * lumbar spine following — all-pelvis reads as a plank on a hinge, all-spine
 * as a hunch.
 */
export const PELVIS_SHARE = 0.5;

const _a = new Vector3();
const _b = new Vector3();
const _d = new Vector3();
const _q = new Quaternion();
const _total = new Quaternion();
const _wq = new Quaternion();
const _pq = new Quaternion();
const _id = new Quaternion();
const _m4 = new Matrix4();
const _m3 = new Matrix3();

/** Read one of our joints (or a midpoint) out of a flat pose. */
export function poseOut(p: Pose, name: Point, out: Vector3): Vector3 {
  if (name === "hipMid" || name === "shoulderMid") {
    const [l, r] = name === "hipMid" ? [J.hipL, J.hipR] : [J.shoulderL, J.shoulderR];
    return out.set(
      (p[l * 3] + p[r * 3]) / 2,
      (p[l * 3 + 1] + p[r * 3 + 1]) / 2,
      (p[l * 3 + 2] + p[r * 3 + 2]) / 2,
    );
  }
  const i = J[name] * 3;
  return out.set(p[i], p[i + 1], p[i + 2]);
}

/** Direction our pose runs from `a` to `b`, normalised. */
export function poseDir(p: Pose, a: Point, b: Point, out: Vector3): Vector3 {
  poseOut(p, a, _a);
  return poseOut(p, b, out).sub(_a).normalize();
}

/** Premultiply a bone's WORLD rotation by `q`, and carry its subtree along. */
function rotateWorld(bone: Object3D, q: Quaternion): void {
  bone.getWorldQuaternion(_wq);
  _wq.premultiply(q);
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_pq);
    _wq.premultiply(_pq.invert());
  }
  bone.quaternion.copy(_wq);
  bone.updateMatrixWorld(true);
}

/** World direction from one bone's origin to another's, normalised. */
export function worldDir(from: Object3D, to: Object3D, out: Vector3): Vector3 {
  from.getWorldPosition(_a);
  return to.getWorldPosition(out).sub(_a).normalize();
}

export class Retargeter {
  private readonly bones = new Map<string, Object3D>();
  private readonly bind = new Map<string, { p: Vector3; q: Quaternion; s: Vector3 }>();
  private readonly bindWorldQ = new Map<string, Quaternion>();
  private readonly bindFeet = new Vector3();

  constructor(
    all: Object3D[],
    private readonly map: RigMap = UE_RIG,
  ) {
    for (const b of all) {
      this.bones.set(b.name, b);
      this.bind.set(b.name, { p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() });
    }
    const need = [map.root, map.pelvis, map.trunkTip, ...map.spine, ...map.lockWorld, ...map.hands];
    for (const a of [...map.aims, ...map.footAims]) need.push(a.bone, a.tip);
    const missing = need.filter((n) => !this.bones.has(n));
    if (missing.length) throw new Error(`rig is missing bones: ${missing.join(", ")}`);

    this.get(map.root).updateMatrixWorld(true);
    for (const n of [...map.lockWorld, ...map.hands])
      this.bindWorldQ.set(n, this.get(n).getWorldQuaternion(new Quaternion()));
    this.feet(this.bindFeet);
  }

  /** Aim one bone at our pose. */
  private aim(a: Aim, pose: Pose): void {
    const bone = this.get(a.bone);
    worldDir(bone, this.get(a.tip), _b);
    poseDir(pose, a.from, a.to, _d);
    rotateWorld(bone, _q.setFromUnitVectors(_b, _d));
  }

  /** Set a bone's orientation in the world, keeping its parent as it is. */
  private setWorld(name: string, q: Quaternion): void {
    const bone = this.get(name);
    _wq.copy(q);
    if (bone.parent) {
      bone.parent.getWorldQuaternion(_pq);
      _wq.premultiply(_pq.invert());
    }
    bone.quaternion.copy(_wq);
    bone.updateMatrixWorld(true);
  }

  /** Slide the whole body by a world-space offset. */
  private shift(by: Vector3): void {
    const root = this.get(this.map.root);
    if (root.parent) {
      _m4.copy(root.parent.matrixWorld).invert();
      by.applyMatrix3(_m3.setFromMatrix4(_m4));
    }
    root.position.add(by);
    root.updateMatrixWorld(true);
  }

  get(name: string): Object3D {
    const b = this.bones.get(name);
    if (!b) throw new Error(`no bone ${name}`);
    return b;
  }

  /** Back to the bind pose. */
  reset(): void {
    for (const [name, t] of this.bind) {
      const b = this.bones.get(name)!;
      b.position.copy(t.p);
      b.quaternion.copy(t.q);
      b.scale.copy(t.s);
    }
    this.get(this.map.root).updateMatrixWorld(true);
  }

  /** Put the model into `pose`, placed by `anchor`. Allocation-free after
   *  construction. */
  apply(pose: Pose, anchor: Anchor = FEET_ANCHOR): void {
    const m = this.map;
    this.reset();

    // Trunk: one swing from the model's own trunk line to ours, shared out.
    const pelvis = this.get(m.pelvis);
    worldDir(pelvis, this.get(m.trunkTip), _b);
    poseDir(pose, "hipMid", "shoulderMid", _d);
    _total.setFromUnitVectors(_b, _d);
    rotateWorld(pelvis, _q.copy(_id).slerp(_total, PELVIS_SHARE));
    const each = (1 - PELVIS_SHARE) / m.spine.length;
    for (const s of m.spine) rotateWorld(this.get(s), _q.copy(_id).slerp(_total, each));
    // Sharing the bend curls the chain, and a curled chain's end-to-end line
    // swings LESS than its top segment does: segments nearer the pelvis only
    // got part of the rotation. Measured, that leaves the trunk several degrees
    // short at the bottom of a leaning rep — exactly the angle the fault is
    // about. So close the gap with one rigid swing at the pelvis, which moves
    // the whole chain about its base and lands the trunk line exactly on ours.
    worldDir(pelvis, this.get(m.trunkTip), _b);
    rotateWorld(pelvis, _q.setFromUnitVectors(_b, _d));

    // Limbs and neck, parent before child.
    for (const a of m.aims) this.aim(a, pose);

    if (anchor.kind === "feet") {
      // Planted feet keep their bind orientation in the world…
      for (const n of m.lockWorld) this.setWorld(n, this.bindWorldQ.get(n)!);
      // …and their bind position: slide the whole body so they land there.
      this.feet(_d);
      this.shift(_d.subVectors(this.bindFeet, _d));
      return;
    }

    for (const a of m.footAims) this.aim(a, pose);
    if (anchor.handsFlat) {
      m.hands.forEach((n, i) => this.setWorld(n, _q.copy(HAND_FLAT[i]).multiply(this.bindWorldQ.get(n)!)));
    }
    // Slide the body so the anchor bones land, on average, on our joints.
    _a.set(0, 0, 0);
    for (const n of anchor.bones) _a.add(this.get(n).getWorldPosition(_b));
    _a.divideScalar(anchor.bones.length);
    _d.set(0, 0, 0);
    for (const j of anchor.joints) _d.add(poseOut(pose, j, _b));
    _d.divideScalar(anchor.joints.length);
    this.shift(_d.sub(_a));
  }

  /** Mean world position of the planted feet. */
  private feet(out: Vector3): Vector3 {
    out.set(0, 0, 0);
    for (const n of this.map.lockWorld) out.add(this.get(n).getWorldPosition(_b));
    return out.divideScalar(this.map.lockWorld.length);
  }
}
