/**
 * The pose model's 33 landmarks on the particle body — what the phone finds in
 * the flow stop's "33 points" step: each point marked, one after another head
 * to toe, then joined the way the pose model joins them (lib/flowScript).
 *
 * `writeLandmarks` places them from the posed rig every frame (ParticleBody
 * calls it, in the body's own space, so they turn with the body); `Landmarks`
 * draws them, inside the body's group, over everything — they're the phone's
 * readout, not part of the body.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Object3D,
  ShaderMaterial,
  Vector2,
  Vector3,
} from "three";

import { LANDMARK_COUNT, LANDMARK_LINKS, linkAt, markAt } from "@/lib/flowScript";
import { store } from "./store";

/**
 * Where each landmark sits on this rig, in the pose model's order. Where a
 * landmark is a joint it's that bone's origin — the pose model's "left" is the
 * body's own left, which is this rig's `_l`. The face, heels and toes have no
 * bone of their own; `writeLandmarks` places them from the head and the feet.
 */
const JOINT_BONES: Record<number, string> = {
  11: "upperarm_l",
  12: "upperarm_r",
  13: "lowerarm_l",
  14: "lowerarm_r",
  15: "hand_l",
  16: "hand_r",
  17: "pinky_01_l",
  18: "pinky_01_r",
  19: "index_01_l",
  20: "index_01_r",
  21: "thumb_03_l",
  22: "thumb_03_r",
  23: "thigh_l",
  24: "thigh_r",
  25: "calf_l",
  26: "calf_r",
  27: "foot_l",
  28: "foot_r",
  31: "ball_leaf_l",
  32: "ball_leaf_r",
};

/** The face, in a frame at the head's centre: [forward, up, toward the body's
 *  left], metres. A head about 15 cm wide. */
const FACE: Record<number, [number, number, number]> = {
  0: [0.105, -0.005, 0], // nose
  1: [0.085, 0.035, 0.018], // left eye, inner
  2: [0.083, 0.036, 0.032], // left eye
  3: [0.075, 0.035, 0.046], // left eye, outer
  4: [0.085, 0.035, -0.018],
  5: [0.083, 0.036, -0.032],
  6: [0.075, 0.035, -0.046],
  7: [-0.005, 0.01, 0.075], // left ear
  8: [-0.005, 0.01, -0.075],
  9: [0.09, -0.045, 0.024], // mouth, left
  10: [0.09, -0.045, -0.024],
};
/** The head's centre, up from the Head bone at the base of the skull. */
const HEAD_CENTRE = 0.09;
/** A heel: back from the ankle, away from the toes, and down toward the floor. */
const HEEL_BACK = 0.45;
const HEEL_DOWN = 0.055;

const v = {
  up: new Vector3(),
  side: new Vector3(),
  fwd: new Vector3(),
  c: new Vector3(),
  a: new Vector3(),
  b: new Vector3(),
  p: new Vector3(),
};

/**
 * The 33 landmarks from the posed rig, xyz into `out`, in the space `inv`
 * takes world positions to (the body group's). Call after the skeleton is
 * posed and the group's world matrix is current.
 */
export function writeLandmarks(node: (name: string) => Object3D, inv: Matrix4, out: Float32Array): void {
  const at = (name: string, into: Vector3) => node(name).getWorldPosition(into).applyMatrix4(inv);
  const put = (i: number, p: Vector3) => out.set([p.x, p.y, p.z], i * 3);

  for (const [i, name] of Object.entries(JOINT_BONES)) put(Number(i), at(name, v.p));

  // The face: a frame from the neck (up), the shoulders (the body's left) and
  // the two together (forward).
  at("Head", v.c);
  at("neck_01", v.a);
  v.up.subVectors(v.c, v.a).normalize();
  at("upperarm_l", v.a);
  at("upperarm_r", v.b);
  v.side.subVectors(v.a, v.b).normalize();
  v.fwd.crossVectors(v.side, v.up).normalize();
  v.side.crossVectors(v.up, v.fwd).normalize();
  v.c.addScaledVector(v.up, HEAD_CENTRE);
  for (const [i, [f, u, s]] of Object.entries(FACE)) {
    v.p.copy(v.c).addScaledVector(v.fwd, f).addScaledVector(v.up, u).addScaledVector(v.side, s);
    put(Number(i), v.p);
  }

  // The heels: behind each ankle, on the far side from its toes.
  for (const [i, foot, ball] of [
    [29, "foot_l", "ball_l"],
    [30, "foot_r", "ball_r"],
  ] as const) {
    at(foot, v.a);
    at(ball, v.b);
    v.p.subVectors(v.a, v.b).multiplyScalar(HEEL_BACK).add(v.a);
    v.p.y = v.a.y - HEEL_DOWN;
    put(i, v.p);
  }
}

/* ── drawing them ────────────────────────────────────────────────────────── */

/** A marked point, px at a 900 px-tall canvas: a white dot ringed in ink. */
const POINT_PX = 10;

export function Landmarks() {
  const group = useRef<Group>(null);
  const points = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(LANDMARK_COUNT * 3), 3));
    g.setAttribute("aMark", new BufferAttribute(new Float32Array(LANDMARK_COUNT), 1));
    return g;
  }, []);
  const pointMat = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          uSize: { value: POINT_PX },
          uScale: { value: 1 },
          uOpacity: { value: 1 },
          uFill: { value: new Color("#ffffff") },
          uRing: { value: new Color("#15191e") },
        },
        vertexShader: /* glsl */ `
          attribute float aMark;
          uniform float uSize;
          uniform float uScale;
          varying float vMark;
          void main() {
            vMark = aMark;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            // Pops in a little larger than it settles.
            float pop = 1.0 + 0.6 * sin(3.14159 * aMark) * step(aMark, 0.999);
            gl_PointSize = uSize * uScale * aMark * pop;
          }`,
        fragmentShader: /* glsl */ `
          uniform float uOpacity;
          uniform vec3 uFill;
          uniform vec3 uRing;
          varying float vMark;
          void main() {
            float r = length(gl_PointCoord - 0.5);
            if (r > 0.5) discard;
            float ring = smoothstep(0.26, 0.3, r);
            vec3 col = mix(uFill, uRing, ring);
            float edge = 1.0 - smoothstep(0.44, 0.5, r);
            gl_FragColor = vec4(col, edge * uOpacity * min(1.0, vMark * 1.5));
            #include <colorspace_fragment>
          }`,
      }),
    [],
  );
  const lines = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(LANDMARK_LINKS.length * 6), 3));
    return g;
  }, []);
  const lineMat = useMemo(
    () => new LineBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }),
    [],
  );
  const lineObj = useMemo(() => new LineSegments(lines, lineMat), [lines, lineMat]);
  useEffect(
    () => () => {
      for (const d of [points, pointMat, lines, lineMat]) d.dispose();
    },
    [points, pointMat, lines, lineMat],
  );

  const buf = useMemo(() => new Vector2(), []);
  useFrame((state) => {
    const s = store;
    const g = group.current;
    if (!g) return;
    g.visible = s.marks > 0.004;
    if (!g.visible) return;

    const L = s.landmarks;
    const t = s.marksClock;
    const pos = points.getAttribute("position") as BufferAttribute;
    const mark = points.getAttribute("aMark") as BufferAttribute;
    (pos.array as Float32Array).set(L);
    for (let i = 0; i < LANDMARK_COUNT; i++) mark.setX(i, markAt(i, t));
    pos.needsUpdate = true;
    mark.needsUpdate = true;

    // Each line drawn out from its first point toward its second.
    const lp = lines.getAttribute("position") as BufferAttribute;
    const arr = lp.array as Float32Array;
    LANDMARK_LINKS.forEach(([a, b], k) => {
      const grow = linkAt(k, t);
      for (let d = 0; d < 3; d++) {
        const from = L[a * 3 + d];
        arr[k * 6 + d] = from;
        arr[k * 6 + 3 + d] = from + (L[b * 3 + d] - from) * grow;
      }
    });
    lp.needsUpdate = true;

    pointMat.uniforms.uOpacity.value = s.marks;
    pointMat.uniforms.uScale.value = state.gl.getDrawingBufferSize(buf).y / 900;
    lineMat.opacity = 0.9 * s.marks;
  });

  return (
    <group ref={group} visible={false}>
      <primitive object={lineObj} renderOrder={5} frustumCulled={false} />
      <points geometry={points} material={pointMat} renderOrder={6} frustumCulled={false} />
    </group>
  );
}
