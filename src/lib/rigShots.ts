/**
 * The sequence reduced to still frames, for `prefers-reduced-motion` and for a
 * browser with no WebGL.
 *
 * PURE, and in `lib/` rather than beside the component, so the offscreen check
 * can assert these frames actually fit in their box. That mattered once already:
 * the first version of the fallback borrowed camera positions from the 3D scene
 * and put a figure's feet 35px below the bottom of the viewBox, which nothing
 * caught until the frames were rendered.
 */
import { JOINT_COUNT } from "./pose";
import { newPose, poseAt, type BeatKind, type Pose } from "./poseFrames";

export type Shot = {
  key: string;
  depth: number;
  beat: BeatKind | null;
  amount: number;
  /** Instability, and the rep phase it is sampled at. */
  grind: number;
  phase: number;
  rotY: number;
  caption: string;
};

/**
 * No camera positions here. The moving sequence pushes in on each beat, but a
 * still frame has no motion to explain the crop — so all four show the whole
 * body at a distance solved at render time, and let the SEGMENTS do the
 * pointing. Each is turned to the view that can actually read its plane, which
 * is the same rule the moving version follows.
 */
export const SHOTS: Shot[] = [
  {
    key: "clean",
    depth: 1,
    beat: null,
    amount: 0,
    grind: 0,
    phase: 0,
    rotY: 0,
    caption: "Two of the five reps look like this. Nothing is flagged.",
  },
  {
    key: "valgus",
    depth: 0.55,
    beat: "valgus",
    amount: 1,
    grind: 0,
    phase: 0.78,
    rotY: 0,
    caption: "On the second rep the knees fall inward on the way up.",
  },
  {
    key: "lean",
    depth: 1,
    beat: "lean",
    amount: 1,
    grind: 0,
    phase: 0.57,
    rotY: Math.PI / 2,
    caption: "On the fourth the trunk tips forward at the bottom.",
  },
  {
    key: "unlevel",
    depth: 0.42,
    beat: "unlevel",
    amount: 1,
    grind: 1,
    phase: 0.87,
    rotY: 0,
    caption:
      "The fifth grinds on the way up and the shoulders drift off level. That one is measured, not flagged.",
  },
];

/* ── framing a still ─────────────────────────────────────────────────────── */

/** Frame size the stills are drawn into, and how much of it the figure may use. */
export const SHOT_W = 300;
export const SHOT_H = 400;
const FOV = 32;
const TAN = Math.tan((FOV * Math.PI) / 360);
const ASPECT = SHOT_W / SHOT_H;
const FIT = 0.86;

/** Pinhole projection to NDC. The camera sits level with what it is looking at,
 *  so there is no pitch and the basis is the identity — the 3D scene tilts, a
 *  still frame has no reason to. */
const ndc = (x: number, y: number, z: number, camY: number, camZ: number): [number, number] => {
  const d = camZ - z; // distance along the view axis, positive in front
  return [x / (d * TAN * ASPECT), (y - camY) / (d * TAN)];
};

export type ShotFrame = {
  pose: Pose;
  /** The figure turned and centred on its own depth, in world space. */
  world: Array<[number, number, number]>;
  camY: number;
  camZ: number;
  /** World point → pixel in a SHOT_W × SHOT_H box. */
  px: (x: number, y: number, z: number) => [number, number];
  /** Joint index → pixel. */
  at: (i: number) => [number, number];
};

/**
 * Solve the distance at which the figure just fills `FIT` of the frame.
 *
 * A binary search rather than a hand-written camera position, because a hand
 * written one goes stale silently: the first version of these stills reused the
 * moving scene's cameras and put a figure's feet below the bottom of the box.
 * Solved from the actual joints, a frame cannot fall out of shot however the
 * poses are edited — and it is only four frames, once, at render time.
 */
export function frameShot(shot: Shot): ShotFrame {
  const pose = newPose();
  poseAt(shot.depth, shot.beat, shot.amount, pose, shot.grind, shot.phase);

  const cos = Math.cos(shot.rotY);
  const sin = Math.sin(shot.rotY);
  let cz = 0;
  for (let i = 0; i < JOINT_COUNT; i++) cz += pose[i * 3 + 2];
  cz /= JOINT_COUNT;

  const world: Array<[number, number, number]> = [];
  let loY = Infinity;
  let hiY = -Infinity;
  for (let i = 0; i < JOINT_COUNT; i++) {
    const x = pose[i * 3];
    const y = pose[i * 3 + 1];
    const z = pose[i * 3 + 2] - cz;
    world.push([x * cos + z * sin, y, -x * sin + z * cos]);
    loY = Math.min(loY, y);
    hiY = Math.max(hiY, y);
  }

  const camY = (loY + hiY) / 2;
  let lo = 0.8;
  let hi = 12;
  for (let it = 0; it < 40; it++) {
    const mid = (lo + hi) / 2;
    let worst = 0;
    for (const [x, y, z] of world) {
      const [nx, ny] = ndc(x, y, z, camY, mid);
      worst = Math.max(worst, Math.abs(nx), Math.abs(ny));
    }
    if (worst > FIT) lo = mid;
    else hi = mid;
  }
  const camZ = hi;

  const px = (x: number, y: number, z: number): [number, number] => {
    const [nx, ny] = ndc(x, y, z, camY, camZ);
    return [(nx * 0.5 + 0.5) * SHOT_W, (0.5 - ny * 0.5) * SHOT_H];
  };

  return {
    pose,
    world,
    camY,
    camZ,
    px,
    at: (i) => px(world[i][0], world[i][1], world[i][2]),
  };
}
