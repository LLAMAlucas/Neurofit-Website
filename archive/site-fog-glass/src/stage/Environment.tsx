/**
 * The world the body stands in: a pale sky, a capture floor that dissolves into
 * fog, and dust hanging in the air. All procedural — no textures, no models.
 *
 * Every material here does its own fog with the same formula as the particles
 * (exp², on view depth), so the floor, the dust and the body fade into the same
 * colour at the same rate and the horizon has no seam.
 */
import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { BackSide, BufferAttribute, BufferGeometry, Color, ShaderMaterial } from "three";
import { mulberry32 } from "@/lib/sampleSkinned";
import { store } from "./store";

const FOG_GLSL = /* glsl */ `
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  vec3 applyFog(vec3 col, float depth) {
    float f = 1.0 - exp(-uFogDensity * uFogDensity * depth * depth);
    return mix(col, uFogColor, f);
  }
`;

const fogUniforms = () => ({ uFogColor: { value: new Color() }, uFogDensity: { value: 0.07 } });

function syncFog(m: ShaderMaterial) {
  (m.uniforms.uFogColor.value as Color).set(store.settings.fogColor);
  m.uniforms.uFogDensity.value = store.settings.fog;
}

function Sky() {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        side: BackSide,
        depthWrite: false,
        uniforms: { uHorizon: { value: new Color() }, uTop: { value: new Color("#eef0f2") } },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uHorizon;
          uniform vec3 uTop;
          varying vec3 vDir;
          float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
          void main() {
            vec3 col = mix(uHorizon, uTop, smoothstep(0.02, 0.7, vDir.y));
            // Dither: a gradient this gentle bands in 8-bit without it.
            col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
            gl_FragColor = vec4(col, 1.0);
            #include <colorspace_fragment>
          }`,
      }),
    [],
  );
  useFrame(() => (material.uniforms.uHorizon.value as Color).set(store.settings.fogColor));
  return (
    <mesh material={material} scale={80} renderOrder={-10} frustumCulled={false}>
      <sphereGeometry args={[1, 32, 16]} />
    </mesh>
  );
}

function Floor() {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          ...fogUniforms(),
          uBase: { value: new Color("#c9ced4") },
          uLine: { value: new Color("#9aa1a9") },
        },
        vertexShader: /* glsl */ `
          varying vec3 vWorld;
          varying float vDepth;
          void main() {
            vec4 w = modelMatrix * vec4(position, 1.0);
            vWorld = w.xyz;
            vec4 mv = viewMatrix * w;
            vDepth = -mv.z;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          ${FOG_GLSL}
          uniform vec3 uBase;
          uniform vec3 uLine;
          varying vec3 vWorld;
          varying float vDepth;
          float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float noise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            vec2 u = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
          }
          float grid(vec2 p, float step) {
            vec2 q = p / step;
            vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
            return 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);
          }
          void main() {
            vec2 xz = vWorld.xz;
            float r = length(xz);
            vec3 col = uBase * (0.965 + 0.05 * noise(xz * 2.5) + 0.03 * noise(xz * 11.0));
            // A capture floor: fine grid near the body, coarse grid further out,
            // both fading long before the fog would hide them.
            float g = grid(xz, 0.5) * 0.45 + grid(xz, 2.0) * 0.3;
            g *= 1.0 - smoothstep(1.2, 7.0, r);
            col = mix(col, uLine, g);
            // Contact shadow under the feet.
            float sh = 1.0 - smoothstep(0.0, 0.75, length(xz * vec2(1.0, 1.35)));
            col *= 1.0 - 0.2 * sh * sh;
            gl_FragColor = vec4(applyFog(col, vDepth), 1.0);
            #include <colorspace_fragment>
          }`,
      }),
    [],
  );
  useFrame(() => syncFog(material));
  return (
    <mesh material={material} rotation-x={-Math.PI / 2} frustumCulled={false}>
      <planeGeometry args={[120, 120]} />
    </mesh>
  );
}

const DUST = 1600;

function Dust() {
  const geometry = useMemo(() => {
    const rand = mulberry32(5);
    const pos = new Float32Array(DUST * 3);
    const seed = new Float32Array(DUST);
    for (let i = 0; i < DUST; i++) {
      pos[i * 3] = (rand() - 0.5) * 14;
      pos[i * 3 + 1] = rand() * 4;
      pos[i * 3 + 2] = (rand() - 0.5) * 14;
      seed[i] = rand();
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new BufferAttribute(seed, 1));
    return g;
  }, []);
  const material = useMemo(
    () =>
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { ...fogUniforms(), uTime: { value: 0 }, uColor: { value: new Color("#5b626b") } },
        vertexShader: /* glsl */ `
          uniform float uTime;
          attribute float aSeed;
          varying float vDepth;
          varying float vSeed;
          void main() {
            vec3 p = position;
            // Slow drift across the stage, wrapped so the volume never empties.
            p.x = mod(p.x + uTime * (0.03 + aSeed * 0.05) + 7.0, 14.0) - 7.0;
            p.y += sin(uTime * 0.3 + aSeed * 40.0) * 0.08;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            vDepth = -mv.z;
            vSeed = aSeed;
            // Capped: a mote drifting past the lens would otherwise be drawn as
            // a blob tens of pixels wide.
            gl_PointSize = min((1.0 + aSeed * 2.2) * (4.0 / max(vDepth, 0.5)), 3.5);
            // And fade out near the camera instead of popping through it.
            vSeed *= smoothstep(1.0, 2.5, vDepth);
          }`,
        fragmentShader: /* glsl */ `
          ${FOG_GLSL}
          uniform vec3 uColor;
          varying float vDepth;
          varying float vSeed;
          void main() {
            vec2 c = gl_PointCoord - 0.5;
            float a = 1.0 - smoothstep(0.1, 0.25, dot(c, c));
            gl_FragColor = vec4(applyFog(uColor, vDepth), a * 0.4 * vSeed);
            #include <colorspace_fragment>
          }`,
      }),
    [],
  );
  useFrame((state) => {
    material.uniforms.uTime.value = state.clock.elapsedTime;
    syncFog(material);
  });
  return <points geometry={geometry} material={material} frustumCulled={false} />;
}

export function Environment() {
  return (
    <>
      <Sky />
      <Floor />
      <Dust />
    </>
  );
}
