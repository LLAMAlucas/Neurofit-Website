/**
 * Offscreen checks for the particle body: the surface sampler, the retargeter
 * (standing, in a plank, and hanging) and the HUD's readouts. Same contract as
 * check_site.ts — pure modules only, run in Node, no renderer.
 *
 * The retargeter is exercised on a SYNTHETIC rig with the Unreal-mannequin bone
 * names and the Quaternius male's bind positions, with every bone given a random
 * rest rotation. Real rigs don't have identity bone frames, and a retargeter that
 * only works when they do would pass here and fail on the model.
 */
import { Object3D, Quaternion, Vector3 } from "three";
import { mulberry32, sampleSkinned } from "../src/lib/sampleSkinned";
import {
  PELVIS_SHARE,
  PULLUP_ANCHOR,
  PUSHUP_ANCHOR,
  Retargeter,
  UE_RIG,
  poseDir,
  poseOut,
  worldDir,
  type Anchor,
} from "../src/lib/retarget";
import { BOTTOM, STAND, newPose } from "../src/lib/poseFrames";
import { JOINT_BONE, SKELETON_LINES, TRUNK_CHAIN, sampleSkeleton } from "../src/lib/sampleSkeleton";
import { nearestK } from "../src/lib/nearest";
import { EXERCISES, kneeAngleDeg, trunkLeanDeg, type ExerciseId } from "../src/lib/exercises";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? "  — " + detail : ""}`);
};
const DEG = Math.PI / 180;

/* ── 1. sampleSkinned ─────────────────────────────────────────────────────── */
console.log("\n1. surface sampler");
{
  // A 1×2 triangle (area 1) and a 0.5×1 triangle (area 0.25), far apart.
  const positions = [0, 0, 0, 1, 0, 0, 0, 2, 0, 10, 0, 0, 10.5, 0, 0, 10, 1, 0];
  const normals = Array.from({ length: 6 }, () => [0, 0, 1]).flat();
  const indices = [0, 1, 2, 3, 4, 5];
  // Vertex 0 has four influences, vertex 1 another four, vertex 2 another four:
  // twelve distinct bones meet in the big triangle.
  const skinIndex = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0];
  const skinWeight = [
    0.4, 0.3, 0.2, 0.1, 0.4, 0.3, 0.2, 0.1, 0.4, 0.3, 0.2, 0.1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
  ];
  const surface = { positions, normals, indices, skinIndex, skinWeight };
  const N = 20000;
  const a = sampleSkinned(surface, N, 7);
  const b = sampleSkinned(surface, N, 7);
  const c = sampleSkinned(surface, N, 8);

  let worstSum = 0, badIndex = 0, inSmall = 0, outside = 0;
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let k = 0; k < 4; k++) {
      s += a.skinWeight[i * 4 + k];
      const bi = a.skinIndex[i * 4 + k];
      if (!Number.isInteger(bi) || bi < 0 || bi > 11) badIndex++;
    }
    worstSum = Math.max(worstSum, Math.abs(s - 1));
    const x = a.position[i * 3], y = a.position[i * 3 + 1];
    if (x >= 9.999) {
      inSmall++;
      if (x > 10.5 + 1e-6 || y < -1e-6 || y > 1 - 2 * (x - 10) + 1e-6) outside++;
    } else if (x < -1e-6 || y < -1e-6 || y > 2 - 2 * x + 1e-6) outside++;
  }
  ok("weights sum to 1 on every point", worstSum < 1e-5, `worst error ${worstSum.toExponential(1)}`);
  ok("every bone index is one the surface used", badIndex === 0, `${badIndex} bad`);
  ok("every point lies on its triangle", outside === 0, `${outside} outside`);
  ok(
    "density follows area (small triangle holds a fifth)",
    Math.abs(inSmall / N - 0.2) < 0.015,
    `${((inSmall / N) * 100).toFixed(1)}%`,
  );
  ok(
    "same seed, same body",
    a.position.every((v, i) => v === b.position[i]) && a.skinIndex.every((v, i) => v === b.skinIndex[i]),
  );
  ok("different seed, different scatter", a.position.some((v, i) => v !== c.position[i]));

  // Heaviest four of twelve. Each vertex has one dominant bone (0, 4, 8) listed
  // LAST, behind three near-zero ones — so "the first four found" would be the
  // three small influences of vertex 0 plus its dominant one, and would drop the
  // other two vertices' dominant bones entirely.
  const heavy = sampleSkinned(
    {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      normals: normals.slice(0, 9),
      indices: [0, 1, 2],
      skinIndex: [1, 2, 3, 0, 5, 6, 7, 4, 9, 10, 11, 8],
      skinWeight: [0.01, 0.01, 0.01, 0.97, 0.01, 0.01, 0.01, 0.97, 0.01, 0.01, 0.01, 0.97],
    },
    2000,
    3,
  );
  // On this unit right triangle a point's barycentrics are just (1−x−y, x, y),
  // so the true top four can be recomputed independently for every point. (A
  // dominant bone legitimately drops out near the far edge, where its vertex's
  // barycentric is tiny — "always keep 0, 4 and 8" would be the wrong test.)
  let mismatched = 0;
  for (let i = 0; i < 2000; i++) {
    const x = heavy.position[i * 3], y = heavy.position[i * 3 + 1];
    const bary = [1 - x - y, x, y];
    const w = new Map<number, number>();
    [[1, 2, 3, 0], [5, 6, 7, 4], [9, 10, 11, 8]].forEach((ids, k) =>
      ids.forEach((id, c) => w.set(id, (w.get(id) ?? 0) + (c === 3 ? 0.97 : 0.01) * bary[k])),
    );
    const top = [...w.entries()].sort((a, b) => b[1] - a[1]);
    // Skip exact ties at the 4th/5th boundary — either answer is right there.
    if (Math.abs(top[3][1] - top[4][1]) < 1e-9) continue;
    const truth = new Set(top.slice(0, 4).map(([id]) => id));
    const kept = Array.from(heavy.skinIndex.subarray(i * 4, i * 4 + 4));
    if (!kept.every((id) => truth.has(id))) mismatched++;
  }
  ok("keeps the heaviest influences, not the first four found", mismatched === 0, `${mismatched}/2000 wrong`);
  const unitNormals = Array.from({ length: N }, (_, i) =>
    Math.hypot(a.normal[i * 3], a.normal[i * 3 + 1], a.normal[i * 3 + 2]),
  ).every((l) => Math.abs(l - 1) < 1e-5);
  ok("normals are unit length", unitNormals);
  const r = mulberry32(1);
  ok("the PRNG stays in [0,1)", Array.from({ length: 1000 }, r).every((v) => v >= 0 && v < 1));

  // Volume: a closed-sided cylinder of radius 0.1 around bone 0's axis (the Y
  // axis, 0…1). Interior points must stay inside it and fill its cross-section
  // evenly — not bunch on the axis, which is what a plain lerp toward it does.
  const SEG = 48, R = 0.1;
  const cp: number[] = [], cn: number[] = [], ci: number[] = [], cs: number[] = [], cw: number[] = [];
  for (let k = 0; k <= SEG; k++) {
    const a = (k / SEG) * Math.PI * 2;
    for (const y of [0, 1]) {
      cp.push(Math.cos(a) * R, y, Math.sin(a) * R);
      cn.push(Math.cos(a), 0, Math.sin(a));
      cs.push(0, 0, 0, 0);
      cw.push(1, 0, 0, 0);
    }
  }
  for (let k = 0; k < SEG; k++) {
    const v0 = k * 2;
    ci.push(v0, v0 + 1, v0 + 2, v0 + 1, v0 + 3, v0 + 2);
  }
  const vol = sampleSkinned(
    { positions: cp, normals: cn, indices: ci, skinIndex: cs, skinWeight: cw },
    20000,
    4,
    { axes: [0, 0, 0, 0, 1, 0], interior: 0.4 },
  );
  let inner = 0, outsideCyl = 0, nearAxis = 0, badDepth = 0;
  const facet = R * Math.cos(Math.PI / SEG); // flat facets sit slightly inside R
  for (let i = 0; i < vol.count; i++) {
    const rr = Math.hypot(vol.position[i * 3], vol.position[i * 3 + 2]);
    const d = vol.depth[i];
    if (d < 0 || d > 1) badDepth++;
    if (rr > R + 1e-6) outsideCyl++;
    if (d > 0) {
      inner++;
      if (rr < R * 0.5) nearAxis++;
    } else if (rr < facet - 1e-6) badDepth++; // a surface point must be ON the surface
  }
  ok("the requested share of points goes inside", Math.abs(inner / vol.count - 0.4) < 0.01, `${((inner / vol.count) * 100).toFixed(1)}%`);
  ok("no point leaves the body", outsideCyl === 0, `${outsideCyl} outside`);
  ok("surface points stay on the skin, depths stay in 0…1", badDepth === 0, `${badDepth} bad`);
  ok(
    "the inside fills evenly (a quarter within half the radius)",
    Math.abs(nearAxis / inner - 0.25) < 0.03,
    `${((nearAxis / inner) * 100).toFixed(1)}%`,
  );
  // A slower device draws a PREFIX of the points, so every prefix has to be
  // the same body, not a hollow shell of skin with the fill still to come.
  const prefixes = [500, 3000, 12345].map((m) => {
    let fill = 0;
    for (let i = 0; i < m; i++) if (vol.depth[i] > 0) fill++;
    return fill / m;
  });
  ok(
    "any prefix has the whole body's skin-to-fill mix",
    prefixes.every((r) => Math.abs(r - 0.4) < 0.02),
    prefixes.map((r) => `${(r * 100).toFixed(1)}%`).join(" / "),
  );
  const noVol = sampleSkinned({ positions: cp, normals: cn, indices: ci, skinIndex: cs, skinWeight: cw }, 500, 4);
  ok("without volume options everything stays on the surface", noVol.depth.every((d) => d === 0));
}

/* ── 2. retarget ─────────────────────────────────────────────────────────── */
console.log("\n2. retarget");
{
  // Bind positions in WORLD space (Quaternius male, T-pose, metres). Right side
  // mirrors left in X.
  const W: Record<string, [number, number, number]> = {
    root: [0, 0, 0],
    pelvis: [0, 0.949, -0.043],
    spine_01: [0, 1.05, -0.035],
    spine_02: [0, 1.17, -0.01],
    spine_03: [0, 1.311, 0.007],
    neck_01: [0, 1.52, -0.041],
    Head: [0, 1.6, -0.017],
    clavicle_l: [0.03, 1.44, -0.03],
    upperarm_l: [0.212, 1.455, -0.065],
    lowerarm_l: [0.463, 1.455, -0.073],
    hand_l: [0.706, 1.455, -0.065],
    thigh_l: [0.114, 0.971, -0.036],
    calf_l: [0.114, 0.542, -0.036],
    foot_l: [0.114, 0.086, -0.088],
    ball_l: [0.114, 0.015, 0.055],
  };
  for (const k of Object.keys(W)) if (k.endsWith("_l")) W[k.replace(/_l$/, "_r")] = [-W[k][0], W[k][1], W[k][2]];
  const PARENT: Record<string, string> = {
    pelvis: "root", spine_01: "pelvis", spine_02: "spine_01", spine_03: "spine_02", neck_01: "spine_03",
    Head: "neck_01", clavicle_l: "spine_03", upperarm_l: "clavicle_l", lowerarm_l: "upperarm_l",
    hand_l: "lowerarm_l", thigh_l: "pelvis", calf_l: "thigh_l", foot_l: "calf_l", ball_l: "foot_l",
  };
  for (const k of Object.keys(PARENT)) if (k.endsWith("_l")) PARENT[k.replace(/_l$/, "_r")] = PARENT[k].replace(/_l$/, "_r");

  const scene = new Object3D();
  const bones: Record<string, Object3D> = {};
  const rnd = mulberry32(11);
  const order = ["root", ...Object.keys(PARENT)]; // parents are listed before children
  for (const name of order) {
    const b = new Object3D();
    b.name = name;
    b.position.set(...W[name]);
    // Arbitrary rest frame per bone, as a real rig has.
    b.quaternion
      .setFromAxisAngle(new Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize(), rnd() * Math.PI)
      .normalize();
    scene.add(b);
    scene.updateMatrixWorld(true);
    if (name !== "root") bones[PARENT[name]].attach(b);
    bones[name] = b;
  }
  scene.updateMatrixWorld(true);

  const rt = new Retargeter(Object.values(bones), UE_RIG);
  const FEET = ["foot_l", "foot_r"];
  const midFeet = (out: Vector3) =>
    out.addVectors(bones.foot_l.getWorldPosition(new Vector3()), bones.foot_r.getWorldPosition(new Vector3())).multiplyScalar(0.5);
  const bindMid = midFeet(new Vector3());
  const bindFootQ = FEET.map((n) => bones[n].getWorldQuaternion(new Quaternion()));

  /** The pose at the worst of a check's fault (or the bottom, for a clean rep). */
  const peak = (ex: ExerciseId, check: string) => {
    let best = -1, bestPh = 0.55;
    const p = newPose();
    for (let ph = 0; ph <= 1; ph += 0.005) {
      const s = EXERCISES[ex].rep(check, ph, 1, p);
      if (s.envelope > best && s.envelope > 0) (best = s.envelope), (bestPh = ph);
    }
    EXERCISES[ex].rep(check, bestPh, 1, p);
    return p;
  };
  const poses: [string, Float32Array][] = [
    ["standing", STAND],
    ["parallel", BOTTOM],
    ["knee cave peak", peak("squat", "valgus")],
    ["forward lean peak", peak("squat", "lean")],
    ["hip shift peak", peak("squat", "shift")],
  ];

  const u = new Vector3(), v = new Vector3();
  for (const [label, pose] of poses) {
    rt.apply(pose);
    let worst = 0, worstBone = "";
    for (const a of UE_RIG.aims) {
      const err = worldDir(bones[a.bone], bones[a.tip], u).angleTo(poseDir(pose, a.from, a.to, v)) / DEG;
      if (err > worst) (worst = err), (worstBone = a.bone);
    }
    ok(`${label}: every limb points where ours does`, worst < 1, `worst ${worst.toFixed(2)}° (${worstBone})`);

    const trunkErr =
      worldDir(bones.pelvis, bones.neck_01, u).angleTo(poseDir(pose, "hipMid", "shoulderMid", v)) / DEG;
    ok(`${label}: the trunk line matches ours`, trunkErr < 1, `${trunkErr.toFixed(2)}°`);

    const drift = midFeet(u).distanceTo(bindMid);
    ok(`${label}: the stance is planted where the model stands`, drift < 1e-3, `${(drift * 1000).toFixed(2)} mm`);
    const turn = Math.max(
      ...FEET.map((n, i) => bones[n].getWorldQuaternion(new Quaternion()).angleTo(bindFootQ[i]) / DEG),
    );
    ok(`${label}: feet stay flat`, turn < 0.5, `${turn.toFixed(2)}°`);
  }

  /* The model's legs are not our legs' lengths, so planting the MIDPOINT can't
     pin each foot exactly — our stance is wider than the model's bind stance,
     and each foot settles ~4 cm out from where the model's bind put it. That is
     a stance, not a fault. What must not happen is a foot SLIDING while the rep
     runs: that reads as skating, and the whole premise of the squat is that the
     feet don't move. So each foot is measured against itself across every rep. */
  for (const c of EXERCISES.squat.checks) {
    const p = newPose();
    const start = FEET.map(() => new Vector3());
    let slide = 0;
    for (let ph = 0; ph <= 1.0001; ph += 0.01) {
      EXERCISES.squat.rep(c.id, ph, 1, p);
      rt.apply(p);
      FEET.forEach((n, i) => {
        const w = bones[n].getWorldPosition(u);
        if (ph === 0) start[i].copy(w);
        else slide = Math.max(slide, w.distanceTo(start[i]));
      });
    }
    ok(`squat, ${c.label}: no foot slides more than 1.5 cm through the rep`, slide < 0.015, `${(slide * 1000).toFixed(1)} mm`);
  }

  // The pelvis takes a real share of the bend, not all of it and not none.
  rt.apply(peak("squat", "lean"));
  const pelvisTilt = bones.pelvis.getWorldQuaternion(new Quaternion());
  rt.reset();
  const pelvisRest = bones.pelvis.getWorldQuaternion(new Quaternion());
  const tilt = pelvisTilt.angleTo(pelvisRest) / DEG;
  const lean = trunkLeanDeg(peak("squat", "lean"));
  ok(
    "the hips hinge with the lean rather than the spine bending alone",
    tilt > lean * PELVIS_SHARE * 0.5 && tilt < lean * 1.2,
    `pelvis ${tilt.toFixed(1)}° for a ${lean.toFixed(1)}° trunk`,
  );

  rt.reset();
  const back = Math.max(...order.map((n) => bones[n].getWorldPosition(u).distanceTo(new Vector3(...W[n]))));
  ok("reset returns every bone to bind", back < 1e-6, `${back.toExponential(1)} m`);

  /* The plank and the hang. Nothing is planted flat now: the feet are aimed at
     our toes, the model is slid so its hands (and the balls of its feet) land
     on ours, and for a push-up the hands lie flat on the floor, fingers toward
     the head, rather than running on down the forearm into it. */
  const handBindQ = ["hand_r", "hand_l"].map((n) => bones[n].getWorldQuaternion(new Quaternion()));
  const cases: [string, ExerciseId, string, Anchor][] = [
    ["push-up, top", "pushup", "clean", PUSHUP_ANCHOR],
    ["push-up, sag peak", "pushup", "sag", PUSHUP_ANCHOR],
    ["push-up, flare peak", "pushup", "flare", PUSHUP_ANCHOR],
    ["pull-up, top", "pullup", "clean", PULLUP_ANCHOR],
    ["pull-up, kip peak", "pullup", "kip", PULLUP_ANCHOR],
    ["pull-up, leg drive peak", "pullup", "legDrive", PULLUP_ANCHOR],
  ];
  for (const [label, ex, check, anchor] of cases) {
    const pose = check === "clean" ? (() => {
      const p = newPose();
      EXERCISES[ex].rep("clean", 0.55, 1, p);
      return p;
    })() : peak(ex, check);
    rt.apply(pose, anchor);
    let worst = 0, worstBone = "";
    for (const a of [...UE_RIG.aims, ...UE_RIG.footAims]) {
      const err = worldDir(bones[a.bone], bones[a.tip], u).angleTo(poseDir(pose, a.from, a.to, v)) / DEG;
      if (err > worst) (worst = err), (worstBone = a.bone);
    }
    ok(`${label}: every limb, feet too, points where ours does`, worst < 1, `worst ${worst.toFixed(2)}° (${worstBone})`);
    const trunkErr = worldDir(bones.pelvis, bones.neck_01, u).angleTo(poseDir(pose, "hipMid", "shoulderMid", v)) / DEG;
    ok(`${label}: the trunk line matches ours`, trunkErr < 1, `${trunkErr.toFixed(2)}°`);
    if (anchor.kind === "joints") {
      const a = new Vector3();
      const b = new Vector3();
      for (const n of anchor.bones) a.add(bones[n].getWorldPosition(u));
      for (const j of anchor.joints) b.add(poseOut(pose, j, v));
      const off = a.divideScalar(anchor.bones.length).distanceTo(b.divideScalar(anchor.joints.length));
      ok(`${label}: its contacts land on ours`, off < 1e-3, `${(off * 1000).toFixed(2)} mm`);
      if (anchor.handsFlat) {
        // The bind hands run out along ±X (ours-L is the model's right, −X):
        // flat, fingers forward, that axis now points along +Z.
        const flat = ["hand_r", "hand_l"].every((n, i) => {
          const q = bones[n].getWorldQuaternion(new Quaternion()).multiply(handBindQ[i].clone().invert());
          return new Vector3(i === 0 ? -1 : 1, 0, 0).applyQuaternion(q).angleTo(new Vector3(0, 0, 1)) / DEG < 0.5;
        });
        ok(`${label}: the hands lie flat, fingers toward the head`, flat);
      }
    }
  }
}

/* ── 3. the readouts ─────────────────────────────────────────────────────── */
console.log("\n3. the HUD's readouts");
{
  // Not 180: the standing keyframe's knees sit a little wider than its hips and
  // ankles, which is 170° of interior angle by construction.
  ok("standing knees read near straight", kneeAngleDeg(STAND) > 165, `${kneeAngleDeg(STAND).toFixed(0)}°`);
  ok("parallel knees read deeply bent", kneeAngleDeg(BOTTOM) < 75, `${kneeAngleDeg(BOTTOM).toFixed(0)}°`);

  const p = newPose();
  const read = (ex: ExerciseId, check: string, phase: number, k: 0 | 1) => {
    EXERCISES[ex].rep(check, phase, 1, p);
    return EXERCISES[ex].readouts[k].read(p);
  };
  ok("a clean squat's trunk leans a little, a leaning one much more", read("squat", "lean", 0.55, 1) - read("squat", "clean", 0.55, 1) > 15);
  // The tracker's own gates: push-up lockout 150°, pull-up dead hang 150°.
  ok("a push-up starts locked out", read("pushup", "clean", 0, 0) > 150, `${read("pushup", "clean", 0, 0).toFixed(0)}°`);
  ok("a push-up's elbows bend deep at the bottom", read("pushup", "clean", 0.55, 0) < 90, `${read("pushup", "clean", 0.55, 0).toFixed(0)}°`);
  ok("a pull-up starts from a dead hang", read("pullup", "clean", 0, 0) > 150, `${read("pullup", "clean", 0, 0).toFixed(0)}°`);
  ok(
    "the kip reads on the swing readout, a strict rep barely",
    read("pullup", "kip", 0.3, 1) > 8 && read("pullup", "clean", 0.3, 1) < 4,
    `${read("pullup", "clean", 0.3, 1).toFixed(1)}° vs ${read("pullup", "kip", 0.3, 1).toFixed(1)}°`,
  );

  const severity = (s: number) => {
    EXERCISES.squat.rep("lean", 0.55, s, p);
    return trunkLeanDeg(p);
  };
  ok("severity scales the fault", severity(0.5) > severity(0) + 3 && severity(0.5) < severity(1) - 3);
  ok(
    "no demoted check is offered as a fault",
    Object.values(EXERCISES).every((e) => e.checks.every((c) => !/level|symmetry/i.test(c.label))),
  );
}

/* ── 4. the tracked skeleton ─────────────────────────────────────────────── */
console.log("\n4. tracked skeleton");
{
  // Bind origins of the model bones the skeleton uses (Quaternius male, m).
  const O: Record<string, [number, number, number]> = {
    pelvis: [0, 0.949, -0.043], spine_01: [0, 1.05, -0.035], spine_02: [0, 1.17, -0.01],
    spine_03: [0, 1.311, 0.007], neck_01: [0, 1.52, -0.041], Head: [0, 1.6, -0.017],
    upperarm_l: [0.212, 1.455, -0.065], lowerarm_l: [0.463, 1.455, -0.073], hand_l: [0.706, 1.455, -0.065],
    thigh_l: [0.114, 0.971, -0.036], calf_l: [0.114, 0.542, -0.036], foot_l: [0.114, 0.086, -0.088],
    ball_l: [0.114, 0.015, 0.055],
  };
  for (const k of Object.keys(O)) if (k.endsWith("_l")) O[k.replace(/_l$/, "_r")] = [-O[k][0], O[k][1], O[k][2]];
  const names = Object.keys(O);
  const axes = new Float32Array(names.length * 6);
  names.forEach((n, i) => axes.set([...O[n], O[n][0], O[n][1] + (n === "Head" ? 0.16 : 0.1), O[n][2]], i * 6));
  const rig = { index: (n: string) => names.indexOf(n), axes };
  const opts = { count: 6000, boneRadius: 0.006, jointRadius: 0.022, headRadius: 0.06, jointShare: 0.2 };
  const sk = sampleSkeleton(rig, opts, 3);
  const sk2 = sampleSkeleton(rig, opts, 3);

  let badW = 0, badI = 0, joints = 0;
  for (let i = 0; i < sk.count; i++) {
    let s = 0;
    for (let c = 0; c < 4; c++) {
      s += sk.skinWeight[i * 4 + c];
      const b = sk.skinIndex[i * 4 + c];
      if (sk.skinWeight[i * 4 + c] > 0 && (b < 0 || b >= names.length)) badI++;
    }
    if (Math.abs(s - 1) > 1e-5) badW++;
    joints += sk.joint[i];
  }
  ok("exactly the grains asked for", sk.count === 6000 && sk.position.length === 18000);
  ok("every grain's weights sum to 1, on real bones", badW === 0 && badI === 0, `${badW} bad sums, ${badI} bad bones`);
  ok("the joints get their share", Math.abs(joints / sk.count - 0.2) < 0.02, `${((joints / sk.count) * 100).toFixed(1)}%`);
  ok("same seed, same skeleton", sk.position.every((v, i) => v === sk2.position[i]));

  // Every grain lies on our skeleton: within a bone's column or a joint's ball.
  const J: Record<string, [number, number, number]> = {};
  for (const [j, b] of Object.entries(JOINT_BONE)) J[j] = O[b];
  J.head = [O.Head[0], O.Head[1] + 0.16 * 0.55, O.Head[2]];
  const mid = (a: string, b: string) => J[a].map((v, i) => (v + J[b][i]) / 2) as [number, number, number];
  J.hipMid = mid("hipL", "hipR");
  J.shoulderMid = mid("shoulderL", "shoulderR");
  const segDist = (p: number[], a: number[], b: number[]) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)));
    return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t, p[2] - a[2] - ab[2] * t);
  };
  let stray = 0;
  for (let i = 0; i < sk.count; i++) {
    const p = Array.from(sk.position.subarray(i * 3, i * 3 + 3));
    const onBone = SKELETON_LINES.some(([a, b]) => segDist(p, J[a], J[b]) <= opts.boneRadius + 1e-6);
    const inBall = Object.keys(JOINT_BONE).some((j) => {
      const c = J[j];
      return Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) <= (j === "head" ? opts.headRadius : opts.jointRadius) + 1e-6;
    });
    if (!onBone && !inBall) stray++;
  }
  ok("every grain lies on one of our bones or joints", stray === 0, `${stray} stray`);

  // Limbs ride one bone; the trunk's sides blend along the spine.
  const iCalf = names.indexOf("calf_r");
  let calfRigid = true, trunkBlended = 0, trunkOffChain = 0;
  const chain = new Set(TRUNK_CHAIN.map((n) => names.indexOf(n)));
  for (let i = 0; i < sk.count; i++) {
    if (sk.joint[i]) continue;
    const p = Array.from(sk.position.subarray(i * 3, i * 3 + 3));
    if (segDist(p, J.kneeL, J.ankleL) < 1e-3 + opts.boneRadius && p[1] < 0.5 && p[1] > 0.1) {
      calfRigid &&= sk.skinIndex[i * 4] === iCalf && sk.skinWeight[i * 4] === 1;
    }
    if (segDist(p, J.shoulderL, J.hipL) <= opts.boneRadius + 1e-6 && p[1] > 1.06 && p[1] < 1.3) {
      if (sk.skinWeight[i * 4 + 1] > 0) trunkBlended++;
      if (!chain.has(sk.skinIndex[i * 4]) || !chain.has(sk.skinIndex[i * 4 + 1])) trunkOffChain++;
    }
  }
  ok("a shin rides the calf alone", calfRigid);
  ok("the trunk's sides blend along the spine", trunkBlended > 50 && trunkOffChain === 0, `${trunkBlended} blended, ${trunkOffChain} off the chain`);
}

/* ── 5. nearest neighbours ───────────────────────────────────────────────── */
console.log("\n5. nearest neighbours");
{
  const r = mulberry32(21);
  const pts = new Float32Array(3 * 6000).map(() => r() * 0.6);
  const qs = new Float32Array(3 * 400).map(() => r() * 0.7 - 0.05);
  const K = 4;
  const got = nearestK(pts, qs, K, 0.03);
  let wrong = 0;
  for (let j = 0; j < 400; j++) {
    const d = Array.from({ length: 6000 }, (_, i) => [
      (pts[i * 3] - qs[j * 3]) ** 2 + (pts[i * 3 + 1] - qs[j * 3 + 1]) ** 2 + (pts[i * 3 + 2] - qs[j * 3 + 2]) ** 2,
      i,
    ]).sort((a, b) => a[0] - b[0]);
    const truth = new Set(d.slice(0, K).map(([, i]) => i));
    if (!Array.from(got.subarray(j * K, j * K + K)).every((i) => truth.has(i))) wrong++;
  }
  ok("the grid finds the same k nearest as brute force", wrong === 0, `${wrong}/400 wrong`);
  ok("queries outside the cloud still get k", !got.includes(-1));
}

console.log(failures === 0 ? "\nALL PASSED\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
