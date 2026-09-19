/**
 * The things on stage besides the body: the phone and its view, the iris the
 * camera flies through, and the pedestal the body ends on. Each reads how
 * present it is from the store (set from lib/story by the scene's driver) and
 * skips drawing entirely at zero.
 *
 * All of it is made of the page's two materials — the body's round grains and
 * pale frosted light — so nothing on stage reads as an object from another
 * scene.
 */
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
} from "three";

import { mulberry32 } from "@/lib/sampleSkinned";
import { store } from "./store";

const FOG_GLSL = /* glsl */ `
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  vec3 applyFog(vec3 col, float depth) {
    return mix(col, uFogColor, 1.0 - exp(-uFogDensity * uFogDensity * depth * depth));
  }
`;

const fogUniforms = () => ({ uFogColor: { value: new Color() }, uFogDensity: { value: 0.07 } });
function syncFog(m: ShaderMaterial) {
  (m.uniforms.uFogColor.value as Color).set(store.settings.fogColor);
  m.uniforms.uFogDensity.value = store.settings.fog;
}

/** Round grains, sized in metres like the body's, for the props made of them. */
function grainMaterial(color: string, glow: number) {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      ...fogUniforms(),
      uColor: { value: new Color(color) },
      uGlow: { value: glow },
      uAmount: { value: 0 },
      uSize: { value: 0.007 },
      uViewportH: { value: 800 },
    },
    vertexShader: /* glsl */ `
      uniform float uSize;
      uniform float uViewportH;
      attribute float aSeed;
      varying float vDepth;
      varying float vSeed;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        vDepth = -mv.z;
        vSeed = aSeed;
        float px = uSize * (0.7 + aSeed * 0.6) * projectionMatrix[1][1] * uViewportH * 0.5 / max(-mv.z, 0.05);
        gl_PointSize = min(px, uViewportH * 0.03) * smoothstep(0.35, 1.0, -mv.z);
      }`,
    fragmentShader: /* glsl */ `
      ${FOG_GLSL}
      uniform vec3 uColor;
      uniform float uGlow;
      uniform float uAmount;
      varying float vDepth;
      varying float vSeed;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r2 = dot(c, c);
        if (r2 > 0.25) discard;
        float soft = 1.0 - smoothstep(0.1, 0.25, r2);
        gl_FragColor = vec4(applyFog(uColor * uGlow, vDepth), soft * uAmount * (0.6 + 0.4 * vSeed));
        #include <colorspace_fragment>
      }`,
  });
}

function useGrainSync(material: ShaderMaterial, amount: () => number, obj: RefObject<Points | Group | null>) {
  const buf = useMemo(() => new Vector2(), []);
  useFrame((state) => {
    const a = amount();
    if (obj.current) obj.current.visible = a > 0.004;
    material.uniforms.uAmount.value = a;
    material.uniforms.uViewportH.value = state.gl.getDrawingBufferSize(buf).y;
    syncFog(material);
  });
}

/* ── the phone ─────────────────────────────────────────────────────────── */

/** Where the phone stands: on the floor, 2.4 m in front of the body, facing it
 *  — which is to say the body is in its FRONT view. */
export const PHONE_AT = new Vector3(0, 0, 2.4);
/** Leaning back against nothing in particular, the way a propped phone does. */
const PHONE_LEAN = 0.2;
const PHONE_W = 0.075;
const PHONE_H = 0.155;
const PHONE_D = 0.009;
/** The lens, in the phone's own space: near the top, on the body's side. */
const LENS = new Vector3(0, PHONE_H - 0.022, -PHONE_D / 2);
/** What the phone's view covers where the body stands, metres. */
const VIEW_HALF_W = 0.72;
const VIEW_BOTTOM = -0.02;
const VIEW_TOP = 2.12;
/** How far past the body the cone runs before it ends. */
const VIEW_BACK = -0.35;

function phoneGrains(): BufferGeometry {
  const rand = mulberry32(17);
  const N = 2600;
  const pos = new Float32Array(N * 3);
  const seed = new Float32Array(N);
  // Uniform over the box's six faces by area: pick a pair of faces, then a side.
  const faces = [
    { a: PHONE_W * PHONE_H, f: (u: number, v: number, s: number) => [(u - 0.5) * PHONE_W, v * PHONE_H, (s - 0.5) * PHONE_D] },
    { a: PHONE_W * PHONE_D, f: (u: number, v: number, s: number) => [(u - 0.5) * PHONE_W, s * PHONE_H, (v - 0.5) * PHONE_D] },
    { a: PHONE_H * PHONE_D, f: (u: number, v: number, s: number) => [(s - 0.5) * PHONE_W, u * PHONE_H, (v - 0.5) * PHONE_D] },
  ];
  const total = faces.reduce((t, f) => t + f.a, 0);
  for (let i = 0; i < N; i++) {
    let r = rand() * total;
    const face = faces.find((f) => (r -= f.a) <= 0) ?? faces[0];
    const side = rand() < 0.5 ? 0 : 1;
    pos.set(face.f(rand(), rand(), side), i * 3);
    seed[i] = rand();
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("aSeed", new BufferAttribute(seed, 1));
  return g;
}

/** The phone's view as a pyramid of light: four faces from the lens out to a
 *  rectangle behind the body. Barycentrics per vertex, so the shader can light
 *  the pyramid's edges — the frame of the view — and leave its faces faint. */
function coneGeometry(apex: Vector3): BufferGeometry {
  const c = [
    new Vector3(-VIEW_HALF_W, VIEW_BOTTOM, VIEW_BACK),
    new Vector3(VIEW_HALF_W, VIEW_BOTTOM, VIEW_BACK),
    new Vector3(VIEW_HALF_W, VIEW_TOP, VIEW_BACK),
    new Vector3(-VIEW_HALF_W, VIEW_TOP, VIEW_BACK),
  ];
  const pos: number[] = [];
  const bary: number[] = [];
  for (let k = 0; k < 4; k++) {
    const a = c[k];
    const b = c[(k + 1) % 4];
    pos.push(apex.x, apex.y, apex.z, a.x, a.y, a.z, b.x, b.y, b.z);
    bary.push(1, 0, 0, 0, 1, 0, 0, 0, 1);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("aBary", new BufferAttribute(new Float32Array(bary), 3));
  return g;
}

export function Phone() {
  const group = useRef<Group>(null);
  const lensPts = useRef<Points>(null);
  const coneMesh = useRef<Mesh>(null);
  const grains = useMemo(phoneGrains, []);
  const grainMat = useMemo(() => grainMaterial("#3b4c63", 1), []);
  const lensMat = useMemo(() => grainMaterial("#e6f2fb", 1.6), []);
  const lens = useMemo(() => {
    const rand = mulberry32(3);
    const N = 90;
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = rand() * Math.PI * 2;
      const r = 0.006 * Math.sqrt(rand());
      pos.set([LENS.x + Math.cos(a) * r, LENS.y + Math.sin(a) * r, LENS.z - 0.001], i * 3);
      seed[i] = rand();
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new BufferAttribute(seed, 1));
    return g;
  }, []);

  // The lens in the world: the phone stands at PHONE_AT, leaned back.
  const apex = useMemo(() => LENS.clone().applyAxisAngle(new Vector3(1, 0, 0), PHONE_LEAN).add(PHONE_AT), []);
  const cone = useMemo(() => coneGeometry(apex), [apex]);
  const coneMat = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        uniforms: { ...fogUniforms(), uAmount: { value: 0 }, uColor: { value: new Color("#f4f9ff") }, uTime: { value: 0 } },
        vertexShader: /* glsl */ `
          attribute vec3 aBary;
          varying vec3 vB;
          varying float vDepth;
          void main() {
            vB = aBary;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vDepth = -mv.z;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          ${FOG_GLSL}
          uniform float uAmount;
          uniform vec3 uColor;
          uniform float uTime;
          varying vec3 vB;
          varying float vDepth;
          void main() {
            // How far out from the lens (0 at the lens, 1 at the far end), and
            // how close to one of the pyramid's edges at that distance.
            float out_ = vB.y + vB.z;
            float across = min(vB.y, vB.z) / max(out_, 1e-3);
            float edge = 1.0 - smoothstep(0.0, 0.035, across);
            // A pulse of light travelling out along the view, now and then.
            float pulse = smoothstep(0.06, 0.0, abs(out_ - fract(uTime * 0.28)));
            float a = (0.035 + 0.3 * edge + 0.05 * pulse) * smoothstep(0.0, 0.12, out_) * uAmount;
            gl_FragColor = vec4(applyFog(uColor, vDepth), a);
            #include <colorspace_fragment>
          }`,
      }),
    [],
  );
  useEffect(
    () => () => {
      for (const d of [grains, lens, cone, grainMat, lensMat, coneMat]) d.dispose();
    },
    [grains, lens, cone, grainMat, lensMat, coneMat],
  );

  const amount = () => store.cone;
  useGrainSync(grainMat, amount, group);
  useGrainSync(lensMat, amount, lensPts);
  const tag = useMemo(() => new Vector3(), []);
  useFrame((state) => {
    coneMat.uniforms.uAmount.value = store.cone;
    coneMat.uniforms.uTime.value = state.clock.elapsedTime;
    syncFog(coneMat);
    if (coneMesh.current) coneMesh.current.visible = store.cone > 0.004;
    // The phone's tag in the HUD sits just over it.
    tag.copy(apex).setY(apex.y + 0.14).project(state.camera);
    store.phone.x = (tag.x * 0.5 + 0.5) * state.size.width;
    store.phone.y = (-tag.y * 0.5 + 0.5) * state.size.height;
  });

  return (
    <>
      <group ref={group} position={PHONE_AT} rotation-x={PHONE_LEAN} visible={false}>
        <points geometry={grains} material={grainMat} frustumCulled={false} />
        <points ref={lensPts} geometry={lens} material={lensMat} frustumCulled={false} />
      </group>
      <mesh ref={coneMesh} geometry={cone} material={coneMat} frustumCulled={false} renderOrder={2} visible={false} />
    </>
  );
}

/* ── the pedestal ──────────────────────────────────────────────────────── */

/** Radius and height of the pedestal, metres; the body is raised onto it. */
export const PEDESTAL_R = 0.52;
export const PEDESTAL_H = 0.12;

export function Pedestal() {
  const points = useRef<Points>(null);
  const geometry = useMemo(() => {
    const rand = mulberry32(29);
    const N = 5200;
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    const top = Math.PI * PEDESTAL_R * PEDESTAL_R;
    const side = 2 * Math.PI * PEDESTAL_R * PEDESTAL_H;
    for (let i = 0; i < N; i++) {
      const a = rand() * Math.PI * 2;
      if (rand() < top / (top + side)) {
        const r = PEDESTAL_R * Math.sqrt(rand());
        pos.set([Math.cos(a) * r, PEDESTAL_H, Math.sin(a) * r], i * 3);
      } else {
        pos.set([Math.cos(a) * PEDESTAL_R, rand() * PEDESTAL_H, Math.sin(a) * PEDESTAL_R], i * 3);
      }
      seed[i] = rand();
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new BufferAttribute(seed, 1));
    return g;
  }, []);
  const material = useMemo(() => grainMaterial("#dce9f5", 1.15), []);
  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );
  useGrainSync(material, () => store.holo, points);
  useFrame(() => {
    if (points.current) points.current.rotation.y = store.spin * 0.5;
  });
  return <points ref={points} geometry={geometry} material={material} frustumCulled={false} visible={false} />;
}

/* ── the iris ──────────────────────────────────────────────────────────── */

/**
 * A lens aperture closing over the whole view and opening again: drawn straight
 * in screen space, in front of everything, so it frames the camera rather than
 * sitting in the room. Eight frosted blades turn as they close; the opening is
 * the octagon between them.
 *
 * Its own scene, drawn AFTER the post-processing (priority 2, behind the
 * composer's 1): inside it, the depth-of-field pass blurred the body's edges
 * behind the blades by the body's depth, and a bright outline of the figure
 * showed straight through them.
 */
export function Iris() {
  const size = useThree((s) => s.size);
  const scene = useMemo(() => new Scene(), []);
  const geometry = useMemo(() => new PlaneGeometry(2, 2), []);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          uClose: { value: 0 },
          uAspect: { value: 1 },
          uColor: { value: new Color("#edf2f7") },
          uEdge: { value: new Color("#15191e") },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = vec4(position.xy, 0.0, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform float uClose;
          uniform float uAspect;
          uniform vec3 uColor;
          uniform vec3 uEdge;
          varying vec2 vUv;
          float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          void main() {
            vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0) * 2.0;
            float r = length(p);
            float sector = 6.2831853 / 8.0;
            // The blades turn as they close.
            float a = atan(p.y, p.x) + uClose * 1.1;
            float local = mod(a, sector) - sector * 0.5;
            // Distance to the edge of a unit octagon along this direction.
            float poly = cos(sector * 0.5) / cos(local);
            float reach = length(vec2(uAspect, 1.0)) * 1.05;
            float open = mix(reach, 0.0, uClose) * poly;
            float blade = smoothstep(open, open + 0.004, r);
            if (blade <= 0.0) discard;
            // Where one blade overlaps the next: a seam spiralling out from each
            // corner of the opening.
            float seamA = mod(a - 0.9 * log(max(r, 1e-3)), sector);
            float seam = 1.0 - smoothstep(0.0, 0.012, min(seamA, sector - seamA) * r);
            // Frosted: a fine grain, and a darker lip round the opening.
            float frost = 0.94 + 0.06 * hash(floor(vUv * vec2(uAspect, 1.0) * 420.0));
            float rim = 1.0 - smoothstep(0.0, 0.06, r - open);
            vec3 col = mix(uColor * frost, uEdge, 0.28 * seam + 0.55 * rim);
            gl_FragColor = vec4(col, 0.97 * blade);
            #include <colorspace_fragment>
          }`,
      }),
    [],
  );
  useEffect(() => {
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    scene.add(mesh);
    return () => {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    };
  }, [scene, geometry, material]);
  useFrame(({ gl, camera }) => {
    if (store.iris <= 0.001) return;
    material.uniforms.uClose.value = store.iris;
    material.uniforms.uAspect.value = size.width / Math.max(1, size.height);
    const clear = gl.autoClear;
    gl.autoClear = false;
    gl.render(scene, camera);
    gl.autoClear = clear;
  }, 2);
  return null;
}
