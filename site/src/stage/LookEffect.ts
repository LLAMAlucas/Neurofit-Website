/**
 * The page's exposure and film grain, made for black (2026-10).
 *
 * It replaced two stock passes that assumed the old pale fog: BrightnessContrast added to every
 * pixel, so the exposure lift and the fault flash turned black grey; and premultiplied Noise
 * multiplied the grain by the picture, so on black there was none. Here exposure is a GAIN —
 * black stays black, light gets brighter — and the grain is zero-mean, scaled by how bright the
 * pixel is, so it lives in the body and the glow and never lifts the background.
 */
import { Effect } from "postprocessing";
import { Uniform } from "three";

const fragment = /* glsl */ `
uniform float uGain;
uniform float uGrain;
uniform float uTime;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb * uGain;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float n = hash(uv * resolution + fract(uTime * 7.31) * 113.7) - 0.5;
  c += n * uGrain * (0.15 + min(l, 1.0));
  outputColor = vec4(max(c, 0.0), inputColor.a);
}
`;

export class LookEffect extends Effect {
  constructor() {
    super("LookEffect", fragment, {
      uniforms: new Map<string, Uniform<number>>([
        ["uGain", new Uniform(1)],
        ["uGrain", new Uniform(0.035)],
        ["uTime", new Uniform(0)],
      ]),
    });
  }

  set gain(v: number) {
    (this.uniforms.get("uGain") as Uniform<number>).value = v;
  }

  set grain(v: number) {
    (this.uniforms.get("uGrain") as Uniform<number>).value = v;
  }

  override update(_renderer: unknown, _input: unknown, dt?: number): void {
    (this.uniforms.get("uTime") as Uniform<number>).value += dt ?? 0;
  }
}
