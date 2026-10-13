/**
 * The barbell stop's things on stage (lib/barbellScript): the bar and its
 * plates on the body's back, and what the phone draws over it — the ring that
 * locks onto the near plate, the plate's path as a trail, the mid-foot line,
 * and the dot where a rep stalls.
 *
 * Drawn inside the body's group, in its own space, so they turn with it like
 * the 33 points (Landmarks). The bar and plates are the page's grain, like the
 * pull-up bar, and gather out of the fog as the stop arrives; the trail, ring
 * and line are the phone's readout, drawn over everything like the points.
 *
 * Everything is placed from our pose plus `store.bodyOffset` — where the feet
 * anchor put the model — so the bar sits where the posed hands hold it
 * (retarget's grip reaches for the same wrists).
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { BufferAttribute, BufferGeometry, Color, Group, Points, ShaderMaterial, Vector2, Vector3 } from "three";

import {
  BAR_HALF,
  BAR_PATHS,
  BAR_R,
  BAR_REPS,
  COLLAR_X,
  DRIFT_FLAG_M,
  DRIFT_REP,
  MIDFOOT_Z,
  PLATES,
  PLATE_FACE_X,
  PLATE_R,
  PLATE_W,
  SLEEVE_R,
} from "@/lib/barbellScript";
import { mulberry32 } from "@/lib/sampleSkinned";
import { FOG_GLSL, fogUniforms, rodGrains, syncFog } from "./Props";
import { store } from "./store";

/* ── the bar and plates ────────────────────────────────────────────────── */

/** A plate's hub, metres. */
const HUB_R = 0.026;
/** How far the grains are scattered into the fog before the bar gathers. */
const SCATTER_M = 0.9;

/** Grains over one plate, `x0`…`x1` along the bar: both faces, a raised lip
 *  near the rim, and the rim itself. */
function plateGrains(x0: number, x1: number, N: number, rand: () => number, pos: number[]): void {
  const faces = Math.PI * (PLATE_R * PLATE_R - HUB_R * HUB_R) * 2;
  const rim = 2 * Math.PI * PLATE_R * (x1 - x0);
  for (let i = 0; i < N; i++) {
    const a = rand() * Math.PI * 2;
    const pick = rand() * (faces + rim) * 1.25;
    let r: number;
    let x: number;
    if (pick < faces) {
      r = Math.sqrt(HUB_R * HUB_R + rand() * (PLATE_R * PLATE_R - HUB_R * HUB_R));
      x = rand() < 0.5 ? x0 : x1;
    } else if (pick < faces + rim) {
      r = PLATE_R;
      x = x0 + rand() * (x1 - x0);
    } else {
      // The lip: a band just inside the rim, where a plate is thickest.
      r = PLATE_R - 0.012 - rand() * 0.016;
      x = rand() < 0.5 ? x0 - 0.004 : x1 + 0.004;
    }
    pos.push(x, Math.cos(a) * r, Math.sin(a) * r);
  }
}

function barbellGeometry(): BufferGeometry {
  const rand = mulberry32(71);
  const pos: number[] = [];
  const add = (g: BufferGeometry) => {
    pos.push(...(g.getAttribute("position").array as Float32Array));
    g.dispose();
  };
  const at = (x: number) => new Vector3(x, 0, 0);
  add(rodGrains(at(-COLLAR_X), at(COLLAR_X), BAR_R, 1700, 73));
  for (const s of [-1, 1]) {
    add(rodGrains(at(s * COLLAR_X), at(s * BAR_HALF), SLEEVE_R, 2600, s < 0 ? 79 : 83));
    for (let j = 0; j < PLATES; j++) {
      const a = COLLAR_X + j * PLATE_W + 0.003;
      const b = a + PLATE_W - 0.006;
      plateGrains(s * a, s * b, 1700, rand, pos);
    }
  }
  const n = pos.length / 3;
  const seed = new Float32Array(n);
  const scatter = new Float32Array(n * 3);
  const d = new Vector3();
  for (let i = 0; i < n; i++) {
    seed[i] = rand();
    d.set(rand() - 0.5, rand() - 0.3, rand() - 0.5)
      .normalize()
      .multiplyScalar(SCATTER_M * (0.3 + 0.7 * rand()));
    scatter.set([d.x, d.y, d.z], i * 3);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("aSeed", new BufferAttribute(seed, 1));
  g.setAttribute("aScatter", new BufferAttribute(scatter, 3));
  return g;
}

/** The page's round grains (Props' grainMaterial), thrown out into the fog
 *  while the bar is arriving or leaving and gathered home as it settles. */
function gatherMaterial(color: string): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      ...fogUniforms(),
      uColor: { value: new Color(color) },
      uAmount: { value: 0 },
      uSize: { value: 0.0068 },
      uViewportH: { value: 800 },
    },
    vertexShader: /* glsl */ `
      uniform float uSize;
      uniform float uViewportH;
      uniform float uAmount;
      attribute float aSeed;
      attribute vec3 aScatter;
      varying float vDepth;
      varying float vSeed;
      void main() {
        // Each grain arrives on its own beat, so the bar condenses rather than fades.
        float home = smoothstep(aSeed * 0.45, aSeed * 0.45 + 0.55, uAmount);
        float off = 1.0 - home;
        vec3 p = position + aScatter * off * off;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        vDepth = -mv.z;
        vSeed = aSeed;
        float px = uSize * (0.7 + aSeed * 0.6) * projectionMatrix[1][1] * uViewportH * 0.5 / max(-mv.z, 0.05);
        gl_PointSize = min(px, uViewportH * 0.03) * smoothstep(0.35, 1.0, -mv.z) * (0.4 + 0.6 * home);
      }`,
    fragmentShader: /* glsl */ `
      ${FOG_GLSL}
      uniform vec3 uColor;
      uniform float uAmount;
      varying float vDepth;
      varying float vSeed;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r2 = dot(c, c);
        if (r2 > 0.25) discard;
        float soft = 1.0 - smoothstep(0.1, 0.25, r2);
        gl_FragColor = vec4(applyFog(uColor, vDepth), soft * min(1.0, uAmount * 1.6) * (0.6 + 0.4 * vSeed));
        #include <colorspace_fragment>
      }`,
  });
}

/* ── the phone's readout: trail, ring, mid-foot line, the stall ────────── */

/** Readout dots, px at a 900 px-tall canvas (like the 33 points). */
const TRAIL_PX = 3.2;
const RING_PX = 3.4;
const LINE_PX = 2.6;
const STICK_PX = 13;
/** Just outside the near plate, so the readout sits in front of it. */
const READOUT_X = PLATE_FACE_X + 0.012;
/** The trail: grains a metre of path, and the earlier rep's brightness. */
const TRAIL_PER_M = 520;
const GHOST = 0.28;
/** The ring: just wider than the plate. */
const RING_R = PLATE_R + 0.035;
/** The mid-foot line's height, metres, and its dashes. */
const LINE_TOP = 1.85;
const DASH_M = 0.03;

/** Every rep's path as grains, evenly along its length, each tagged with its
 *  rep, the seconds into the rep it was there, and whether the bar had
 *  drifted past the line there. In our pose's space. */
function trailGeometry(): BufferGeometry {
  const rand = mulberry32(89);
  const pos: number[] = [];
  const rep: number[] = [];
  const time: number[] = [];
  const red: number[] = [];
  BAR_PATHS.forEach((path, k) => {
    const n = path.t.length;
    const cum = new Float32Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(path.y[i] - path.y[i - 1], path.z[i] - path.z[i - 1]);
    const count = Math.round(cum[n - 1] * TRAIL_PER_M);
    let j = 0;
    for (let c = 0; c < count; c++) {
      const s = (c / (count - 1)) * cum[n - 1];
      while (j < n - 2 && cum[j + 1] < s) j++;
      const f = (s - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]);
      const y = path.y[j] + (path.y[j + 1] - path.y[j]) * f;
      const z = path.z[j] + (path.z[j + 1] - path.z[j]) * f;
      const jit = () => (rand() - 0.5) * 0.004;
      pos.push(READOUT_X + jit(), y + jit(), z + jit());
      rep.push(k);
      time.push(path.t[j] + (path.t[j + 1] - path.t[j]) * f);
      red.push(z - MIDFOOT_Z > DRIFT_FLAG_M ? 1 : 0);
    }
  });
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("aRep", new BufferAttribute(new Float32Array(rep), 1));
  g.setAttribute("aT", new BufferAttribute(new Float32Array(time), 1));
  g.setAttribute("aRed", new BufferAttribute(new Float32Array(red), 1));
  return g;
}

function trailMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uRep: { value: 0 },
      uT: { value: 0 },
      uAmount: { value: 0 },
      uGhost: { value: GHOST },
      uSize: { value: TRAIL_PX },
      uScale: { value: 1 },
      uColor: { value: new Color("#ffffff") },
      uRed: { value: new Color("#ff2b2b") },
      uRedGlow: { value: 2.4 },
    },
    vertexShader: /* glsl */ `
      attribute float aRep;
      attribute float aT;
      attribute float aRed;
      uniform float uRep;
      uniform float uT;
      uniform float uGhost;
      uniform float uSize;
      uniform float uScale;
      varying float vShow;
      varying float vRed;
      void main() {
        float cur = (1.0 - step(0.5, abs(aRep - uRep))) * step(aT, uT);
        float prev = 1.0 - step(0.5, abs(aRep - (uRep - 1.0)));
        vShow = max(cur, prev * uGhost);
        vRed = aRed * cur;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        // The newest stretch of the path a little heavier: the pen.
        float pen = 1.0 + 0.7 * cur * smoothstep(uT - 0.25, uT, aT);
        gl_PointSize = vShow > 0.0 ? uSize * uScale * pen : 0.0;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uAmount;
      uniform vec3 uColor;
      uniform vec3 uRed;
      uniform float uRedGlow;
      varying float vShow;
      varying float vRed;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        if (r > 0.5 || vShow <= 0.0) discard;
        vec3 col = mix(uColor, uRed * uRedGlow, vRed);
        gl_FragColor = vec4(col, (1.0 - smoothstep(0.3, 0.5, r)) * vShow * uAmount);
        #include <colorspace_fragment>
      }`,
  });
}

/** Plain readout dots: the ring, the mid-foot line, the stall. `uGrow` hides
 *  any above that height (the line rising from the floor). */
function dotMaterial(px: number, glow = 1): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uAmount: { value: 0 },
      uSize: { value: px },
      uScale: { value: 1 },
      uGrow: { value: 1e3 },
      uColor: { value: new Color("#ffffff").multiplyScalar(glow) },
    },
    vertexShader: /* glsl */ `
      uniform float uSize;
      uniform float uScale;
      uniform float uGrow;
      varying float vShow;
      void main() {
        vShow = step(position.y, uGrow);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uSize * uScale * vShow;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uAmount;
      uniform vec3 uColor;
      varying float vShow;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        if (r > 0.5 || vShow <= 0.0) discard;
        gl_FragColor = vec4(uColor, (1.0 - smoothstep(0.3, 0.5, r)) * uAmount);
        #include <colorspace_fragment>
      }`,
  });
}

function pointsGeometry(pos: number[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  return g;
}

/** A ring of dots in the plate's plane (Y–Z), centred on the origin. */
function ringGeometry(r: number, n: number): BufferGeometry {
  const pos: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pos.push(0, Math.cos(a) * r, Math.sin(a) * r);
  }
  return pointsGeometry(pos);
}

/** Mid-foot, marked: a dashed line straight up from it in the readout's
 *  plane, and a line across the floor under both feet out to it, so it reads
 *  as the feet's. In our pose's space. */
function midfootGeometry(): BufferGeometry {
  const pos: number[] = [];
  const step = 0.0045;
  for (let y = 0; y <= LINE_TOP; y += step) if (Math.floor(y / DASH_M) % 2 === 0) pos.push(READOUT_X, y, MIDFOOT_Z);
  for (let x = -0.32; x <= READOUT_X; x += step) pos.push(x, 0.005, MIDFOOT_Z);
  return pointsGeometry(pos);
}

/* ── the component ─────────────────────────────────────────────────────── */

export function Barbell() {
  const bar = useRef<Group>(null);
  const readout = useRef<Group>(null);
  const ring = useRef<Points>(null);
  const stick = useRef<Points>(null);

  const geo = useMemo(
    () => ({
      bar: barbellGeometry(),
      trail: trailGeometry(),
      ring: ringGeometry(RING_R, 150),
      midfoot: midfootGeometry(),
      stick: ringGeometry(0.022, 14),
    }),
    [],
  );
  const mat = useMemo(
    () => ({
      bar: gatherMaterial("#7f8b99"),
      trail: trailMaterial(),
      ring: dotMaterial(RING_PX),
      midfoot: dotMaterial(LINE_PX),
      stick: dotMaterial(STICK_PX * 0.4, 1.6),
    }),
    [],
  );
  useEffect(
    () => () => {
      for (const g of Object.values(geo)) g.dispose();
      for (const m of Object.values(mat)) m.dispose();
    },
    [geo, mat],
  );

  const scratch = useMemo(() => ({ buf: new Vector2(), v: new Vector3() }), []);
  useFrame((state) => {
    const s = store;
    const b = bar.current;
    const r = readout.current;
    if (!b || !r) return;
    const on = s.barbell > 0.004;
    b.visible = on;
    r.visible = on;
    if (!on) return;
    const f = s.barFrame;
    const [ox, oy, oz] = s.bodyOffset;
    const scale = state.gl.getDrawingBufferSize(scratch.buf).y / 900;

    // The bar where the hands hold it.
    b.position.set(ox, s.barY + oy, s.barZ + oz);
    mat.bar.uniforms.uAmount.value = s.barbell;
    mat.bar.uniforms.uViewportH.value = scratch.buf.y;
    syncFog(mat.bar);

    // The readout, carried onto the body the same way.
    r.position.set(ox, oy, oz);
    const t = mat.trail.uniforms;
    t.uRep.value = f.rep;
    t.uT.value = f.repT;
    t.uAmount.value = f.trail * s.barbell;
    t.uScale.value = scale;
    (t.uRed.value as Color).set(s.settings.red);

    // The ring sits on the near plate's face and follows it.
    if (ring.current) {
      ring.current.position.set(READOUT_X, s.barY, s.barZ);
      ring.current.scale.setScalar(f.ringScale);
    }
    mat.ring.uniforms.uAmount.value = f.ring * s.barbell;
    mat.ring.uniforms.uScale.value = scale;

    mat.midfoot.uniforms.uAmount.value = 0.75 * f.midfoot * s.barbell;
    mat.midfoot.uniforms.uGrow.value = f.midfoot * LINE_TOP + 0.01;
    mat.midfoot.uniforms.uScale.value = scale;

    const st = BAR_REPS[DRIFT_REP].stick;
    if (stick.current && st) {
      stick.current.position.set(READOUT_X, st.y, st.z);
      // Pops in a little larger than it settles.
      stick.current.scale.setScalar(1 + 0.8 * Math.sin(Math.PI * Math.min(1, f.stick)) * (f.stick < 1 ? 1 : 0));
    }
    mat.stick.uniforms.uAmount.value = f.stick * s.barbell;
    mat.stick.uniforms.uScale.value = scale;

    // The tag beside the plate, on the side the lifter's back is — clear of
    // the path, which runs up and down through the plate's centre.
    scratch.v.set(READOUT_X + ox, s.barY + oy, s.barZ + oz - RING_R - 0.05);
    r.parent?.localToWorld(scratch.v).project(state.camera);
    s.barTag.x = (scratch.v.x * 0.5 + 0.5) * state.size.width;
    s.barTag.y = (-scratch.v.y * 0.5 + 0.5) * state.size.height;
  });

  return (
    <>
      <group ref={bar} visible={false}>
        <points geometry={geo.bar} material={mat.bar} frustumCulled={false} />
      </group>
      <group ref={readout} visible={false}>
        <points geometry={geo.midfoot} material={mat.midfoot} renderOrder={7} frustumCulled={false} />
        <points geometry={geo.trail} material={mat.trail} renderOrder={8} frustumCulled={false} />
        <points ref={ring} geometry={geo.ring} material={mat.ring} renderOrder={9} frustumCulled={false} />
        <points ref={stick} geometry={geo.stick} material={mat.stick} renderOrder={10} frustumCulled={false} />
      </group>
    </>
  );
}
