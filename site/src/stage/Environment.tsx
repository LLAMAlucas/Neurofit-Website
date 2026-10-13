/**
 * The world the body stands in, on black (2026-10, the dragonfly.xyz theme — it was a pale sky
 * and a fog-blue floor): a dark studio floor whose faint grid fades into the black, a soft glow
 * where the feet touch it, and dust hanging in the air as specks of light. All procedural — no
 * textures, no models. The canvas clears to black (StageScene), so there is no sky.
 *
 * Every material here does its own fog with the same formula as the particles (exp², on view
 * depth), toward the same black, so the floor, the dust and the body fade out together.
 */
import { useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, ShaderMaterial } from "three";
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

function Floor() {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: {
          ...fogUniforms(),
          uBase: { value: new Color("#040404") },
          uLine: { value: new Color("#1c1c1c") },
          uGlow: { value: new Color("#9fb6d2") },
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
          uniform vec3 uGlow;
          varying vec3 vWorld;
          varying float vDepth;
          float grid(vec2 p, float step) {
            vec2 q = p / step;
            vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
            return 1.0 - clamp(min(g.x, g.y), 0.0, 1.0);
          }
          void main() {
            vec2 xz = vWorld.xz;
            float r = length(xz);
            vec3 col = uBase;
            // A capture floor: a fine grid near the body, a coarse one further out, both
            // fading into the black well before the fog would hide them.
            float g = grid(xz, 0.5) * 0.7 + grid(xz, 2.0) * 0.45;
            g *= 1.0 - smoothstep(1.2, 6.0, r);
            col = mix(col, uLine, g);
            // Where the feet touch it, a faint glow instead of a shadow — on black there is
            // nothing for a shadow to darken.
            float glow = 1.0 - smoothstep(0.0, 0.8, length(xz * vec2(1.0, 1.35)));
            col += uGlow * 0.035 * glow * glow;
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
        blending: AdditiveBlending,
        uniforms: { ...fogUniforms(), uTime: { value: 0 }, uColor: { value: new Color("#9aa3ad") } },
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
            gl_FragColor = vec4(applyFog(uColor, vDepth), a * 0.22 * vSeed);
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
      <Floor />
      <Dust />
    </>
  );
}
