/**
 * The tracked skeleton, as grains: what shows through a hole torn in the body.
 *
 * PURE — no three, no DOM. Takes the model's bind-pose bone axes and returns
 * flat typed arrays ready to become buffer attributes.
 *
 * It is OUR skeleton — the sixteen joints and seventeen bones of `pose.ts`,
 * the landmarks the tracker works in — not the model's art rig with its
 * clavicles and three spine bones. The point of revealing it is "this is what
 * the camera actually measures", so it has to be the thing the camera measures.
 * Plus one line the tracker doesn't draw but does measure: the trunk, hip
 * centre to shoulder centre, which is what the forward-lean check reads. Without
 * it a swipe across the chest opened onto nothing.
 * Drawn as the body's own material condensed: a tight column of grains along
 * each bone and a dense ball at each joint.
 *
 * Every grain is skinned to the model bone that carries it, so the skeleton
 * squats inside the body instead of floating in bind pose:
 *  - a limb bone rides the model bone that runs along it (knee→ankle: calf);
 *  - the shoulder line and the neck ride the upper spine, which is what the
 *    shoulders hang from (the retargeter never turns the clavicles);
 *  - each side of the trunk runs from hip to shoulder through all four spine
 *    bones, so it is blended along that chain by height and bends with it.
 */
import { BONES, JOINT_NAMES, type JointName } from "./pose";
import { mulberry32 } from "./sampleSkinned";

export type SkeletonRig = {
  /** Bone index by model bone name, as the skin indices use them. */
  index: (name: string) => number;
  /** Six floats per bone: bind origin xyz, then axis end xyz, in mesh space. */
  axes: ArrayLike<number>;
};

export type SkeletonOptions = {
  count: number;
  /** Radius of the column of grains along a bone, metres. */
  boneRadius: number;
  /** Radius of the ball at a joint, metres. */
  jointRadius: number;
  /** Radius of the head's ball — the head is a joint the size of a head. */
  headRadius: number;
  /** Share of the grains in the joints' balls, 0…1. The rest line the bones. */
  jointShare: number;
};

export type SkeletonGrains = {
  count: number;
  position: Float32Array;
  skinIndex: Float32Array;
  skinWeight: Float32Array;
  /** One per grain in [0, 1). */
  seed: Float32Array;
  /** 1 for a grain in a joint's ball, 0 on a bone. */
  joint: Float32Array;
};

/**
 * The model bone each of our joints sits at the origin of. Our L joints are the
 * model's RIGHT: the model faces +Z like our figure, and the retargeter pairs
 * by position, not by name (see UE_RIG).
 */
export const JOINT_BONE: Record<JointName, string> = {
  head: "Head",
  neck: "neck_01",
  shoulderL: "upperarm_r",
  shoulderR: "upperarm_l",
  elbowL: "lowerarm_r",
  elbowR: "lowerarm_l",
  wristL: "hand_r",
  wristR: "hand_l",
  hipL: "thigh_r",
  hipR: "thigh_l",
  kneeL: "calf_r",
  kneeR: "calf_l",
  ankleL: "foot_r",
  ankleR: "foot_l",
  toeL: "ball_r",
  toeR: "ball_l",
};

/** The spine, pelvis first: what each side of the trunk is blended along. */
export const TRUNK_CHAIN = ["pelvis", "spine_01", "spine_02", "spine_03"];

type Point = JointName | "hipMid" | "shoulderMid";

/** Our bones, and the trunk line the lean check measures. */
export const SKELETON_LINES: ReadonlyArray<readonly [Point, Point]> = [...BONES, ["hipMid", "shoulderMid"]];

/** How far up the head bone's axis the head's ball is centred: its bone sits
 *  at the base of the skull, and a ball there would read as a chin. */
const HEAD_CENTRE = 0.55;

type Skin = { bone: string } | { chain: string[] };

function segmentSkin(a: Point, b: Point): Skin {
  if (a === "hipMid") return { chain: TRUNK_CHAIN };
  if (a === "shoulderMid") return { bone: "spine_03" };
  if (a === "head") return { bone: "neck_01" };
  if (a === "neck" || (a === "shoulderL" && b === "shoulderR")) return { bone: "spine_03" };
  if (a.startsWith("shoulder") && b.startsWith("hip")) return { chain: TRUNK_CHAIN };
  if (a === "hipL" && b === "hipR") return { bone: "pelvis" };
  // A limb: the model bone that starts at `a` runs along the bone to `b`.
  return { bone: JOINT_BONE[a as JointName] };
}

export function sampleSkeleton(rig: SkeletonRig, o: SkeletonOptions, seed = 1): SkeletonGrains {
  const rand = mulberry32(seed);
  const at = (bone: string, t = 0): [number, number, number] => {
    const i = rig.index(bone);
    if (i < 0) throw new Error(`the model has no bone ${bone}`);
    const a = rig.axes;
    return [
      a[i * 6] + (a[i * 6 + 3] - a[i * 6]) * t,
      a[i * 6 + 1] + (a[i * 6 + 4] - a[i * 6 + 1]) * t,
      a[i * 6 + 2] + (a[i * 6 + 5] - a[i * 6 + 2]) * t,
    ];
  };
  const jointAt = (j: Point): [number, number, number] => {
    if (j === "hipMid" || j === "shoulderMid") {
      const [l, r] = j === "hipMid" ? (["hipL", "hipR"] as const) : (["shoulderL", "shoulderR"] as const);
      const p = jointAt(l);
      const q = jointAt(r);
      return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    }
    return j === "head" ? at("Head", HEAD_CENTRE) : at(JOINT_BONE[j]);
  };
  const chainY = TRUNK_CHAIN.map((b) => at(b)[1]);
  const chainIndex = TRUNK_CHAIN.map((b) => rig.index(b));

  const count = Math.max(0, Math.floor(o.count));
  const out: SkeletonGrains = {
    count,
    position: new Float32Array(count * 3),
    skinIndex: new Float32Array(count * 4),
    skinWeight: new Float32Array(count * 4),
    seed: new Float32Array(count),
    joint: new Float32Array(count),
  };

  let n = 0;
  const put = (x: number, y: number, z: number, skin: Skin, isJoint: boolean) => {
    if (n >= count) return;
    out.position.set([x, y, z], n * 3);
    if ("bone" in skin) {
      out.skinIndex[n * 4] = rig.index(skin.bone);
      out.skinWeight[n * 4] = 1;
    } else {
      // Blend the two chain bones whose origins bracket this height.
      let k = 0;
      while (k < chainY.length - 2 && y > chainY[k + 1]) k++;
      const t = Math.min(1, Math.max(0, (y - chainY[k]) / (chainY[k + 1] - chainY[k] || 1)));
      out.skinIndex[n * 4] = chainIndex[k];
      out.skinIndex[n * 4 + 1] = chainIndex[k + 1];
      out.skinWeight[n * 4] = 1 - t;
      out.skinWeight[n * 4 + 1] = t;
    }
    out.seed[n] = rand();
    out.joint[n] = isJoint ? 1 : 0;
    n++;
  };

  // Joints: a ball each, the head's bigger — and so given more grains, in
  // proportion to its size, capped so it can't swallow the budget.
  const headWeight = Math.min(6, (o.headRadius / Math.max(1e-4, o.jointRadius)) ** 2);
  const perJoint = (count * o.jointShare) / (JOINT_NAMES.length - 1 + headWeight);
  for (const j of JOINT_NAMES) {
    const [cx, cy, cz] = jointAt(j);
    const r = j === "head" ? o.headRadius : o.jointRadius;
    const m = Math.round(perJoint * (j === "head" ? headWeight : 1));
    for (let i = 0; i < m; i++) {
      // Uniform in the ball: a direction, and a radius by the cube root.
      const z = rand() * 2 - 1;
      const a = rand() * Math.PI * 2;
      const s = Math.sqrt(1 - z * z);
      const rr = r * Math.cbrt(rand());
      put(cx + s * Math.cos(a) * rr, cy + z * rr, cz + s * Math.sin(a) * rr, { bone: JOINT_BONE[j] }, true);
    }
  }

  // Bones: the rest of the budget, shared by length.
  const segs = SKELETON_LINES.map(([a, b]) => {
    const p = jointAt(a);
    const q = jointAt(b);
    return { a, b, p, q, len: Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) };
  });
  const total = segs.reduce((s, g) => s + g.len, 0) || 1;
  const left = count - n;
  segs.forEach((g, gi) => {
    const m = gi === segs.length - 1 ? count - n : Math.round((left * g.len) / total);
    const skin = segmentSkin(g.a, g.b);
    // Two directions across the bone, for scattering the column's grains.
    const dx = (g.q[0] - g.p[0]) / (g.len || 1);
    const dy = (g.q[1] - g.p[1]) / (g.len || 1);
    const dz = (g.q[2] - g.p[2]) / (g.len || 1);
    const [ux, uy, uz] = Math.abs(dy) < 0.9 ? cross(dx, dy, dz, 0, 1, 0) : cross(dx, dy, dz, 1, 0, 0);
    const [vx, vy, vz] = cross(dx, dy, dz, ux, uy, uz);
    for (let i = 0; i < m; i++) {
      const t = rand();
      const a = rand() * Math.PI * 2;
      const rr = o.boneRadius * Math.sqrt(rand());
      const cu = Math.cos(a) * rr;
      const cv = Math.sin(a) * rr;
      put(
        g.p[0] + (g.q[0] - g.p[0]) * t + ux * cu + vx * cv,
        g.p[1] + (g.q[1] - g.p[1]) * t + uy * cu + vy * cv,
        g.p[2] + (g.q[2] - g.p[2]) * t + uz * cu + vz * cv,
        skin,
        false,
      );
    }
  });

  return out;
}

/** Unit cross product. */
function cross(ax: number, ay: number, az: number, bx: number, by: number, bz: number): [number, number, number] {
  const x = ay * bz - az * by;
  const y = az * bx - ax * bz;
  const z = ax * by - ay * bx;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}
