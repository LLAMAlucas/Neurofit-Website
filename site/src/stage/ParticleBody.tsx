/**
 * The human body, drawn as particles, with faults glowing red where they happen.
 *
 * Load once: the model's skinned mesh is sampled into points — on the skin and
 * through the inside — that each carry the bone weights of where they landed
 * (`sampleSkinned`). The mesh itself is never drawn; it only lends its
 * skeleton, which `Retargeter` poses from our 16-joint squat every frame. The
 * GPU skins every particle from the same bone texture three would use for the
 * mesh, so the body costs one draw call and two small passes of physics.
 *
 * Each particle is also a body in its own right (`ParticleSim`): swipe across
 * the figure and the particles under the cursor are thrown the way it went,
 * glow as they fly, splash against the glass and floor, and flow home as they
 * cool.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  MathUtils,
  Matrix4,
  MeshBasicMaterial,
  ShaderMaterial,
  SkinnedMesh,
  Vector2,
  Vector3,
  type Object3D,
  type PerspectiveCamera,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { Retargeter } from "@/lib/retarget";
import { sampleSkinned } from "@/lib/sampleSkinned";
import { sampleSkeleton } from "@/lib/sampleSkeleton";
import { nearestK } from "@/lib/nearest";
import { grainScale } from "@/lib/quality";
import type { FaultId } from "@/lib/faultDemo";
import { ParticleSim, type Cursor } from "./particleSim";
import { store } from "./store";
import vertexShader from "./shaders/particleBody.vert.glsl?raw";
import fragmentShader from "./shaders/particleBody.frag.glsl?raw";
import skeletonVertex from "./shaders/skeleton.vert.glsl?raw";
import skeletonFragment from "./shaders/skeleton.frag.glsl?raw";

/** A point `t` of the way from one bone's origin to another's. */
type BonePoint = [from: string, to: string, t: number];
type Capsule = { a: BonePoint; b: BonePoint; /** × the radius setting */ r: number };

/**
 * Where each fault glows, in this rig's bones. Knee cave runs from mid-thigh to
 * upper shin on both legs — the cave is the knee travelling in, and the thigh
 * and shin are the segments that visibly angle with it. Forward lean runs up the
 * trunk from the pelvis to the upper back: the fault is the trunk's angle, so it
 * is the trunk that lights.
 */
const CAPSULES: Record<FaultId, Capsule[]> = {
  clean: [],
  valgus: [
    { a: ["thigh_l", "calf_l", 0.45], b: ["calf_l", "foot_l", 0.3], r: 1 },
    { a: ["thigh_r", "calf_r", 0.45], b: ["calf_r", "foot_r", 0.3], r: 1 },
  ],
  lean: [{ a: ["pelvis", "spine_03", 0.2], b: ["spine_03", "neck_01", 0.6], r: 1.35 }],
};

/** What the HUD's leader line points at: the midpoint of two bones. */
const ANCHOR: Record<FaultId, [string, string]> = {
  clean: ["pelvis", "pelvis"],
  valgus: ["calf_l", "calf_r"],
  lean: ["spine_02", "spine_02"],
};

/**
 * How far past its own origin a LEAF bone's axis runs, in metres. A leaf has no
 * child to point at, so its axis continues its parent's line. The head is the
 * one that matters: its bone sits at the base of the skull, and without a long
 * axis the inside of the head would be filled toward the jaw.
 */
const LEAF_AXIS: Record<string, number> = { Head: 0.16 };

const MAX_CAPSULES = 4;

/**
 * Every bone's bind-pose axis, in the mesh's own space: from the bone to the
 * child that continues its chain (the child most in line with the bone's own
 * direction — spine_03 continues to the neck, not to a collarbone). Read from
 * the inverse bind matrices, so it is the bind pose however the skeleton is
 * currently posed.
 */
function boneAxes(mesh: SkinnedMesh): Float32Array {
  const { bones, boneInverses } = mesh.skeleton;
  const toMesh = new Matrix4().copy(mesh.bindMatrix).invert();
  const bind = boneInverses.map((inv) =>
    new Vector3().setFromMatrixPosition(new Matrix4().copy(inv).invert()).applyMatrix4(toMesh),
  );
  const index = new Map<Object3D, number>(bones.map((b, i) => [b, i]));
  const axes = new Float32Array(bones.length * 6);
  const dir = new Vector3();
  bones.forEach((bone, i) => {
    const at = bind[i];
    const parent = bone.parent ? index.get(bone.parent) : undefined;
    const up = parent !== undefined ? at.clone().sub(bind[parent]) : new Vector3(0, 1, 0);
    const upN = up.clone().normalize();
    let end: Vector3 | null = null;
    let best = -Infinity;
    for (const child of bone.children) {
      const c = index.get(child);
      if (c === undefined) continue;
      const score = dir.subVectors(bind[c], at).normalize().dot(upN);
      if (score > best) {
        best = score;
        end = bind[c];
      }
    }
    end ??= at.clone().addScaledVector(upN, LEAF_AXIS[bone.name] ?? Math.max(0.03, up.length() * 0.6));
    axes.set([at.x, at.y, at.z, end.x, end.y, end.z], i * 6);
  });
  return axes;
}

/** Fastest cursor the sim is told about, screen heights per second (NDC is 2
 *  tall). The pointer entering the canvas can report a jump of the whole
 *  screen in one frame; that is not a swipe. */
const MAX_CURSOR_SPEED = 16;

/** Seconds of the cursor's recent motion weighed to judge whether it is going
 *  anywhere. A fast jiggle over the body had the full speed of a swipe and
 *  none of its reach: the grains under it were heated white and sprayed each
 *  its own way, and the brush filled with a glowing ball. Its velocity now
 *  counts only as far as it keeps a heading — a straight swipe, or a circle
 *  slower than ~2 a second, loses nothing. */
const SWEEP_MEMORY = 0.08;

/** The skeleton's shape: a tight column along each bone, a ball at each joint,
 *  and a head-sized ball for the head. Metres. */
const SKELETON_SHAPE = { boneRadius: 0.014, jointRadius: 0.03, headRadius: 0.07, jointShare: 0.25 };

/** How many body particles each skeleton grain watches to know it's exposed. */
const WATCH = 4;

/** The ghosts: earlier sets standing in a row to the body's left, x metres.
 *  Each draws this many of the body's particles — a lighter copy. */
const GHOST_X = [-2.5, -1.25];
const GHOST_PARTICLES = 22000;
/** Where the HUD labels each figure (ghosts, then the body): over its head,
 *  which is held at the bottom of a squat when they are shown. */
const LABEL_Y = 1.62;

export function ParticleBody({
  url,
  count,
  interior,
  skelCount,
}: {
  url: string;
  count: number;
  interior: number;
  skelCount: number;
}) {
  const gltf = useLoader(GLTFLoader, url);
  const gl = useThree((s) => s.gl);
  const group = useRef<Group>(null);

  const rig = useMemo(() => {
    const mesh = gltf.scene.getObjectByProperty("isSkinnedMesh", true) as SkinnedMesh | undefined;
    if (!mesh) throw new Error(`${url} has no skinned mesh`);
    const skeleton = mesh.skeleton;
    if (!skeleton.boneTexture) skeleton.computeBoneTexture();
    // The mesh is only here for its skeleton. A wireframe stands in for it when
    // the "show mesh" toggle is on, for checking the particles against it.
    mesh.material = new MeshBasicMaterial({ color: "#2b3038", wireframe: true, transparent: true, opacity: 0.12 });
    mesh.frustumCulled = false;
    return { mesh, skeleton, axes: boneAxes(mesh), retarget: new Retargeter(skeleton.bones) };
  }, [gltf, url]);

  const body = useMemo(() => {
    const g = rig.mesh.geometry;
    const pos = g.getAttribute("position");
    const nor = g.getAttribute("normal");
    const si = g.getAttribute("skinIndex");
    const sw = g.getAttribute("skinWeight");
    const index = g.getIndex();
    if (!index) throw new Error("expected an indexed mesh");
    // Read through the accessors, not `.array`: glTF weights are often stored
    // as normalised bytes, and getX() is what de-normalises them.
    const n = pos.count;
    const positions = new Float32Array(n * 3);
    const normals = new Float32Array(n * 3);
    const skinIndex = new Float32Array(n * 4);
    const skinWeight = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      positions.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3);
      normals.set([nor.getX(i), nor.getY(i), nor.getZ(i)], i * 3);
      skinIndex.set([si.getX(i), si.getY(i), si.getZ(i), si.getW(i)], i * 4);
      skinWeight.set([sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)], i * 4);
    }
    const s = sampleSkinned({ positions, normals, indices: index.array, skinIndex, skinWeight }, count, 1, {
      axes: rig.axes,
      interior,
    });
    const sim = new ParticleSim(gl, s, {
      boneTexture: rig.skeleton.boneTexture!,
      bindMatrix: rig.mesh.bindMatrix,
      bindMatrixInverse: rig.mesh.bindMatrixInverse,
    });
    // Everything a particle needs lives in the sim's textures; the geometry
    // only says how many points to draw and which texel each one reads.
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(s.position, 3));
    geometry.setAttribute("aSimUv", new BufferAttribute(sim.uvs, 2));

    // The skeleton, and for each of its grains the body particles that cover
    // it: when they have been thrown off, it shows.
    const names = rig.skeleton.bones.map((b) => b.name);
    const sk = sampleSkeleton({ index: (n) => names.indexOf(n), axes: rig.axes }, { count: skelCount, ...SKELETON_SHAPE }, 3);
    const near = nearestK(s.position, sk.position, WATCH);
    const nearA = new Float32Array(sk.count * 4);
    const nearB = new Float32Array(sk.count * 4);
    for (let j = 0; j < sk.count; j++) {
      for (let c = 0; c < WATCH; c++) {
        const i = Math.max(0, near[j * WATCH + c]);
        const into = c < 2 ? nearA : nearB;
        into[j * 4 + (c % 2) * 2] = sim.uvs[i * 2];
        into[j * 4 + (c % 2) * 2 + 1] = sim.uvs[i * 2 + 1];
      }
    }
    // The ghosts share the body's particles and sim state (the same buffers,
    // uploaded once) but draw fewer of them — through their own geometry, since
    // a draw range lives on the geometry and the body's is the quality budget.
    const ghost = new BufferGeometry();
    ghost.setAttribute("position", geometry.getAttribute("position"));
    ghost.setAttribute("aSimUv", geometry.getAttribute("aSimUv"));
    ghost.setDrawRange(0, Math.min(count, GHOST_PARTICLES));

    const skeleton = new BufferGeometry();
    skeleton.setAttribute("position", new BufferAttribute(sk.position, 3));
    skeleton.setAttribute("aSkinIndex", new BufferAttribute(sk.skinIndex, 4));
    skeleton.setAttribute("aSkinWeight", new BufferAttribute(sk.skinWeight, 4));
    skeleton.setAttribute("aNearA", new BufferAttribute(nearA, 4));
    skeleton.setAttribute("aNearB", new BufferAttribute(nearB, 4));
    skeleton.setAttribute("aSeed", new BufferAttribute(sk.seed, 1));
    skeleton.setAttribute("aJoint", new BufferAttribute(sk.joint, 1));
    return { sim, geometry, ghost, skeleton, near };
  }, [rig, count, interior, skelCount, gl]);
  useEffect(() => {
    // Dev: `__labSim.probe()` reads the physics back by number.
    if (import.meta.env.DEV)
      (window as unknown as { __labSim: unknown }).__labSim = {
        probe: () => body.sim.probe(gl, count, store.settings.room),
        // How much of the skeleton is showing, by the same rule the shader uses.
        skeleton: () => {
          const o = body.sim.readOffsets(gl);
          const st = store.settings;
          const lo = st.revealFrom / 100;
          const hi = Math.max(st.revealFrom + 0.1, st.revealTo) / 100;
          const grains = body.near.length / WATCH;
          let shown = 0;
          let most = 0;
          for (let j = 0; j < grains; j++) {
            let moved = Infinity;
            let heat = 0;
            for (let c = 0; c < WATCH; c++) {
              const i = body.near[j * WATCH + c];
              moved = Math.min(moved, Math.hypot(o[i * 4], o[i * 4 + 1], o[i * 4 + 2]));
              heat = Math.max(heat, o[i * 4 + 3]);
            }
            const ease = (x: number) => x * x * (3 - 2 * x);
            const t = Math.min(1, Math.max(0, (moved - lo) / (hi - lo)));
            const reveal = ease(t) * ease(Math.min(1, heat / 0.05));
            if (reveal > 0.05) shown++;
            most = Math.max(most, reveal);
          }
          return { grains, shown, most };
        },
      };
    return () => {
      body.geometry.dispose();
      body.skeleton.dispose();
      body.ghost.dispose();
      body.sim.dispose();
    };
  }, [body, gl, count]);

  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: true,
        uniforms: {
          uHome: { value: null },
          uNormal: { value: null },
          uOffset: { value: null },
          uSize: { value: 0.007 },
          uViewportH: { value: 800 },
          uFaultA: { value: Array.from({ length: MAX_CAPSULES }, () => new Vector3()) },
          uFaultB: { value: Array.from({ length: MAX_CAPSULES }, () => new Vector3()) },
          uFaultR: { value: new Array(MAX_CAPSULES).fill(0.1) },
          uFaultAmt: { value: new Array(MAX_CAPSULES).fill(0) },
          uGraphite: { value: new Color() },
          uRimColor: { value: new Color() },
          uRim: { value: 0.5 },
          uRed: { value: new Color() },
          uGlow: { value: 1 },
          uHotColor: { value: new Color() },
          uOpacity: { value: 0.9 },
          uFogColor: { value: new Color() },
          uFogDensity: { value: 0.07 },
          uOffsetScale: { value: 1 },
          uHolo: { value: 0 },
          uTime: { value: 0 },
        },
      }),
    [],
  );

  // A ghost is the body's material with its particles pinned home and faded:
  // the same uniform objects otherwise, so it poses and lights red with it.
  const ghostMaterial = useMemo(() => {
    const m = material.clone();
    m.uniforms = { ...material.uniforms, uOffsetScale: { value: 0 }, uOpacity: { value: 0 }, uHolo: { value: 0 } };
    m.depthWrite = false;
    return m;
  }, [material]);
  useEffect(() => () => ghostMaterial.dispose(), [ghostMaterial]);
  const ghostRefs = useRef<(Group | null)[]>([]);
  useEffect(() => () => material.dispose(), [material]);

  // The skeleton shares the body's fault capsules and colours — the same
  // uniform objects, so it lights red wherever the body does without being
  // told twice.
  const skeletonMaterial = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: skeletonVertex,
        fragmentShader: skeletonFragment,
        transparent: true,
        depthWrite: false,
        uniforms: {
          uOffset: { value: null },
          uBoneTexture: { value: rig.skeleton.boneTexture },
          uBindMatrix: { value: rig.mesh.bindMatrix },
          uBindMatrixInverse: { value: rig.mesh.bindMatrixInverse },
          uSize: { value: 0.006 },
          uViewportH: material.uniforms.uViewportH,
          uRevealFrom: { value: 0.03 },
          uRevealTo: { value: 0.1 },
          uAlways: { value: 0 },
          uFaultA: material.uniforms.uFaultA,
          uFaultB: material.uniforms.uFaultB,
          uFaultR: material.uniforms.uFaultR,
          uFaultAmt: material.uniforms.uFaultAmt,
          uColor: material.uniforms.uHotColor,
          uGlow: { value: 1.35 },
          uRed: material.uniforms.uRed,
          uRedGlow: material.uniforms.uGlow,
          uFogColor: material.uniforms.uFogColor,
          uFogDensity: material.uniforms.uFogDensity,
        },
      }),
    [material, rig],
  );
  useEffect(() => () => skeletonMaterial.dispose(), [skeletonMaterial]);

  const scratch = useMemo(
    () => ({
      a: new Vector3(),
      b: new Vector3(),
      c: new Vector3(),
      inv: new Matrix4(),
      buf: new Vector2(),
    }),
    [],
  );
  const cursor = useMemo<Cursor>(
    () => ({ from: new Vector2(), to: new Vector2(), vel: new Vector2(), active: false }),
    [],
  );
  // The cursor's recent velocity and recent speed, both averaged over
  // SWEEP_MEMORY. Their ratio is 1 on a straight line and near 0 on a jiggle.
  const sweep = useMemo(() => ({ heading: new Vector2(), speed: 0 }), []);
  const hadPointer = useRef(false);
  const formed = useRef(0);

  useFrame((state, rawDt) => {
    const g = group.current;
    if (!g) return;
    g.position.y = store.lift;
    g.rotation.y = store.spin;
    const dt = Math.min(rawDt, 0.1);
    const s = store;
    const st = s.settings;
    const u = material.uniforms;

    rig.retarget.apply(s.pose);
    rig.skeleton.update();
    rig.mesh.visible = st.showMesh;

    g.updateMatrixWorld();
    scratch.inv.copy(g.matrixWorld).invert();
    const at = ([from, to, t]: BonePoint, out: Vector3) => {
      rig.retarget.get(from).getWorldPosition(scratch.a);
      rig.retarget.get(to).getWorldPosition(scratch.b);
      return out.lerpVectors(scratch.a, scratch.b, t);
    };

    // Faults. A worse fault is brighter AND wider; one the camera can't judge
    // from here isn't drawn at all (visibility is 0 past the check's tolerance).
    const caps = CAPSULES[s.fault];
    const sev = st.severity;
    const amount = s.envelope * s.visibility * (0.55 + 0.45 * sev);
    for (let i = 0; i < MAX_CAPSULES; i++) {
      const c = caps[i];
      if (!c) {
        u.uFaultAmt.value[i] = 0;
        continue;
      }
      at(c.a, u.uFaultA.value[i]).applyMatrix4(scratch.inv);
      at(c.b, u.uFaultB.value[i]).applyMatrix4(scratch.inv);
      u.uFaultR.value[i] = st.radius * c.r * (0.7 + 0.3 * sev);
      u.uFaultAmt.value[i] = amount;
    }

    // The HUD's leader line target, in CSS pixels.
    const [p, q] = ANCHOR[s.fault];
    at([p, q, 0.5], scratch.c).project(state.camera);
    s.anchor.x = (scratch.c.x * 0.5 + 0.5) * state.size.width;
    s.anchor.y = (-scratch.c.y * 0.5 + 0.5) * state.size.height;

    // The cursor's stroke this frame, in NDC with x scaled to match y. Only
    // while it is hovering — a drag is orbiting the camera, not touching the
    // body — and only from its second frame over the stage, so arriving is not
    // mistaken for a swipe across the whole screen.
    const aspect = state.size.width / Math.max(1, state.size.height);
    const stirring = s.pointerInside && !s.dragging;
    cursor.to.set(s.pointer.x * aspect, s.pointer.y);
    if (!stirring || !hadPointer.current) cursor.from.copy(cursor.to);
    cursor.active = stirring && hadPointer.current && dt > 0;
    if (cursor.active) {
      cursor.vel.subVectors(cursor.to, cursor.from).divideScalar(dt).clampLength(0, MAX_CURSOR_SPEED);
      const a = 1 - Math.exp(-dt / SWEEP_MEMORY);
      sweep.heading.lerp(cursor.vel, a);
      sweep.speed += (cursor.vel.length() - sweep.speed) * a;
      const straight = sweep.speed > 1e-6 ? sweep.heading.length() / sweep.speed : 1;
      cursor.vel.multiplyScalar(MathUtils.smoothstep(straight, 0.3, 0.8));
    } else {
      cursor.vel.set(0, 0);
      sweep.heading.set(0, 0);
      sweep.speed = 0;
    }
    hadPointer.current = stirring;

    if (s.formNonce !== formed.current) {
      formed.current = s.formNonce;
      body.sim.seed({
        centre: [0, 1, 0],
        near: st.formNear,
        far: st.formFar,
        heat: st.formHeat,
        spin: st.formSpin,
        stagger: st.formStagger,
        rise: st.formRise,
      });
    }
    body.sim.update(state.gl, dt, state.clock.elapsedTime, state.camera as PerspectiveCamera, g.matrixWorld, aspect, cursor, {
      force: st.force,
      spray: st.spray,
      brush: st.brush,
      heat: st.heat,
      drag: st.drag,
      gravity: st.gravity,
      swirl: st.swirl,
      pull: st.pull,
      flow: st.flow / 1000,
      churn: st.churn,
      fizz: st.fizz / 1000,
      walls: st.walls,
      room: st.room,
    });
    cursor.from.copy(cursor.to);
    u.uHome.value = body.sim.homeTexture;
    u.uNormal.value = body.sim.normalTexture;
    u.uOffset.value = body.sim.offsetTexture;
    const k = skeletonMaterial.uniforms;
    k.uOffset.value = body.sim.offsetTexture;
    k.uSize.value = st.skelSize / 1000;
    k.uGlow.value = st.skelGlow;
    k.uRevealFrom.value = st.revealFrom / 100;
    k.uRevealTo.value = Math.max(st.revealFrom + 0.1, st.revealTo) / 100;
    k.uAlways.value = st.skelAlways ? 1 : 0;
    // Shown whole for tuning, it has to draw over the body to be seen at all.
    skeletonMaterial.depthTest = !st.skelAlways;
    (u.uHotColor.value as Color).set(st.hotColor);

    u.uViewportH.value = state.gl.getDrawingBufferSize(scratch.buf).y;
    const drawn = s.drawCount > 0 ? Math.min(s.drawCount, count) : count;
    u.uSize.value = (st.size / 1000) * grainScale(count, drawn);
    (u.uGraphite.value as Color).set(st.graphite);
    (u.uRimColor.value as Color).set(st.rimColor);
    (u.uRed.value as Color).set(st.red);
    (u.uFogColor.value as Color).set(st.fogColor);
    u.uRim.value = st.rim;
    u.uGlow.value = st.glow;
    u.uOpacity.value = st.opacity;
    u.uHolo.value = s.holo;
    u.uTime.value = state.clock.elapsedTime;
    body.geometry.setDrawRange(0, drawn);

    // Ghosts, and the HUD's labels over each figure.
    ghostMaterial.uniforms.uOpacity.value = st.opacity * 0.55 * s.ghosts;
    GHOST_X.forEach((_, i) => {
      const gh = ghostRefs.current[i];
      if (gh) gh.visible = s.ghosts > 0.004;
    });
    [...GHOST_X, 0].forEach((x, i) => {
      scratch.c.set(x, LABEL_Y, 0).applyMatrix4(g.matrixWorld).project(state.camera);
      s.labels[i].x = (scratch.c.x * 0.5 + 0.5) * state.size.width;
      s.labels[i].y = (-scratch.c.y * 0.5 + 0.5) * state.size.height;
    });
    u.uFogDensity.value = st.fog;

    s.ready = true;
  }, -1);

  return (
    <group ref={group}>
      <primitive object={gltf.scene} />
      <points geometry={body.geometry} material={material} frustumCulled={false} />
      {GHOST_X.map((x, i) => (
        <group key={x} position={[x, 0, 0]} ref={(el) => (ghostRefs.current[i] = el)} visible={false}>
          <points geometry={body.ghost} material={ghostMaterial} frustumCulled={false} />
        </group>
      ))}
      {/* After the body, so the body's depth hides every grain it still covers. */}
      <points geometry={body.skeleton} material={skeletonMaterial} frustumCulled={false} renderOrder={1} />
    </group>
  );
}
