// Particle sim — seed pass. Scatters every particle out into the fog around the
// body, some of them hot, all of them turning slowly about the vertical. Nothing
// else: the step pass's own pull home is what assembles the body, the same
// physics that heals a swipe. So the opening is not a separate animation that
// could disagree with how the body behaves once it's yours.

uniform sampler2D tHome;   // xyz home this frame, w seed
uniform vec3 uCentre;      // body space
uniform float uNear;       // m, the cloud's inner radius
uniform float uFar;        // m, its outer radius
uniform float uHeat;       // hottest a grain starts: how long it drifts before home takes it
uniform float uSpin;       // rad/s about the vertical
uniform vec3 uAway;        // unit, level: from the centre toward the camera
uniform float uStagger;    // s, the spread of when grains are let go
uniform float uRise;       // 0 = let go at random, 1 = from the feet up

layout(location = 0) out vec4 outOffset;
layout(location = 1) out vec4 outVelocity;
layout(location = 2) out vec4 outGrip;

float hash11(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }

void main() {
  vec4 h = texelFetch(tHome, ivec2(gl_FragCoord.xy), 0);
  float seed = h.w;

  // A direction uniform on the sphere, and a radius uniform through the
  // shell's VOLUME (cube root), so the cloud is not a hollow ball.
  float z = hash11(seed * 3.17) * 2.0 - 1.0;
  float a = hash11(seed * 7.91) * 6.2831853;
  float s = sqrt(1.0 - z * z);
  vec3 dir = vec3(s * cos(a), z, s * sin(a));
  float r = pow(mix(uNear * uNear * uNear, uFar * uFar * uFar, hash11(seed * 5.03)), 1.0 / 3.0);
  vec3 p = uCentre + dir * r;
  // Below the floor is folded back above it rather than flattened onto it, so
  // the grains don't start as a carpet.
  p.y = abs(p.y);
  // Nothing starts between the body and the camera: grains there would sweep
  // past the lens. The cloud behind and beside the body comes out of the fog.
  float front = dot(p - uCentre, uAway) - 0.4;
  if (front > 0.0) p -= 2.0 * front * uAway;

  float heat = uHeat * hash11(seed * 11.7);
  vec3 v = cross(vec3(0.0, 1.0, 0.0), p - uCentre) * uSpin;

  // How long this grain waits before home takes it (the step pass counts it
  // down in velocity.w). Weighted toward its height, so the body builds from
  // the floor up instead of a whole cloud shrinking at once.
  float wait = uStagger * mix(hash11(seed * 13.3), clamp(h.y / 1.9, 0.0, 1.0), uRise);

  outOffset = vec4(p - h.xyz, heat);
  outVelocity = vec4(v, wait);
  outGrip = vec4(0.0); // no stroke has held it yet
}
