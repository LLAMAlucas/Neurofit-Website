// Particle sim — step pass. One texel per particle, advanced by uDt seconds.
//
// State: the particle's OFFSET from its home on the body (w: how hot it is) and
// its VELOCITY. At rest both are zero and the particle sits exactly on the skin.
// The behaviour is read off a frame-by-frame recording of igloo.inc's hologram:
//
//  - A swipe drags the particles under it toward the cursor's own velocity, each
//    with its own kick and a random share, so a chunk of body leaves as a
//    spraying stream and keeps flying after the cursor has gone.
//  - A hit particle is HOT for a while: free of its home, falling, swirling,
//    slowing, and glowing (the colour is read in the draw).
//  - It is contained: glass walls and the floor stop it, and it piles up and
//    runs along them like water in a tank.
//  - As it cools, home takes hold — a critically damped pull, so it flows back
//    once and never sloshes (an under-damped spring read as jelly).
//  - And untouched, it is never still: a slow current churns the whole body
//    and loose grains lift off the surface and settle back. In the recording
//    the parts the cursor never reached reshuffle every frame; without this
//    the body read as frozen around the one place being stirred.

uniform sampler2D tOffset;    // xyz offset from home (m), w heat 0…1
uniform sampler2D tVelocity;  // xyz velocity (m/s), w seconds still to wait (forming)
uniform sampler2D tHome;      // xyz home this frame, w seed
uniform sampler2D tHomePrev;  // xyz home last frame
uniform sampler2D tNormal;    // xyz skinned normal this frame, w depth (0 skin → 1 bone axis)

uniform float uDt;
uniform float uTime;
// 1 on a frame's first sub-step only: the frame's cursor stroke and the body's
// movement since last frame are each applied once, not once per sub-step.
uniform float uFirst;

uniform float uHit;          // the cursor is stirring this frame
uniform mat4 uViewProj;      // body space → clip
uniform vec3 uCamPos;        // body space
uniform vec3 uCamRight;      // body space
uniform vec3 uCamUp;
uniform float uTanHalfFov;
uniform float uAspect;
uniform vec2 uFrom;          // this frame's cursor stroke, NDC with x × aspect
uniform vec2 uTo;
uniform vec2 uCursorVel;     // same units, per second
uniform float uBrush;        // radius, screen heights

uniform float uForce;        // share of the swipe's speed a particle picks up
uniform float uSpray;        // random share of the throw
uniform float uHeatLife;     // seconds a fully hot particle stays hot
uniform float uDrag;         // 1/s, in flight
uniform float uGravity;      // m/s², in flight
uniform float uSwirl;        // m/s², in flight
uniform float uPull;         // rad/s, the pull home once cool
uniform float uFlow;         // m, how far the idle current carries a particle from home
uniform float uChurn;        // how fast the idle current changes
uniform float uFizz;         // m, how far a loose surface grain lifts off
uniform float uWalls;        // 1 = the container is there
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
// The body blown apart where it stands (the change from one exercise to the
// next): 1 on that frame only.
uniform float uBurst;
uniform vec3 uBurstCentre;   // body space
uniform float uBurstSpeed;   // m/s outward
uniform float uBurstLift;    // m/s upward, at most
uniform float uBurstHeat;    // how hot every grain comes loose

layout(location = 0) out vec4 outOffset;
layout(location = 1) out vec4 outVelocity;

float hash11(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }
vec3 hash31(float n) {
  return fract(sin(vec3(n * 91.7, n * 37.3 + 1.3, n * 57.1 + 2.7)) * 43758.5453);
}
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

// Value noise and its analytic gradient: returns (n, dn/dx, dn/dy, dn/dz).
// After Inigo Quilez's noised().
vec4 noised(vec3 x) {
  vec3 i = floor(x);
  vec3 w = fract(x);
  vec3 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * w * w * (w * (w - 2.0) + 1.0);
  float a = hash3(i);
  float b = hash3(i + vec3(1.0, 0.0, 0.0));
  float c = hash3(i + vec3(0.0, 1.0, 0.0));
  float d = hash3(i + vec3(1.0, 1.0, 0.0));
  float e = hash3(i + vec3(0.0, 0.0, 1.0));
  float f = hash3(i + vec3(1.0, 0.0, 1.0));
  float g = hash3(i + vec3(0.0, 1.0, 1.0));
  float h = hash3(i + vec3(1.0, 1.0, 1.0));
  float k0 = a;
  float k1 = b - a;
  float k2 = c - a;
  float k3 = e - a;
  float k4 = a - b - c + d;
  float k5 = a - c - e + g;
  float k6 = a - b - e + f;
  float k7 = -a + b + c - d + e - f - g + h;
  return vec4(
    k0 + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z,
    du * vec3(
      k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
      k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
      k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y));
}

// A swirling flow with no sources or sinks: the cross product of two gradients
// is divergence-free, so a cloud stirred by it curls into wisps without
// clumping or thinning out.
vec3 curl(vec3 p) {
  return cross(noised(p).yzw, noised(p + vec3(31.4, 17.7, 5.3)).yzw);
}

float segmentDistance(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-8), 0.0, 1.0);
  return length(p - (a + ab * t));
}

void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 o = texelFetch(tOffset, t, 0);
  vec3 d = o.xyz;
  float heat = o.w;
  vec4 vw = texelFetch(tVelocity, t, 0);
  vec3 v = vw.xyz;
  // Forming: a grain the seed pass told to wait just drifts, slowing, until its
  // turn — then home takes it like any other.
  float wait = vw.w;
  float waiting = smoothstep(0.0, 0.25, wait);
  v *= exp(-1.5 * waiting * uDt);
  vec4 h = texelFetch(tHome, t, 0);
  vec3 home = h.xyz;
  float seed = h.w;
  vec4 nd = texelFetch(tNormal, t, 0);
  float dt = uDt;

  // The burst: every grain comes loose where it is and is thrown out from the
  // body's centre. It is hot, so the line below keeps it in the room while the
  // body's pose changes under it — and as it cools it flows home to the NEW
  // pose: the body re-forms as the next exercise.
  if (uBurst * uFirst > 0.5) {
    vec3 was = texelFetch(tHomePrev, t, 0).xyz + d;
    vec3 away = was - uBurstCentre + (hash31(seed * 1.93) - 0.5) * 0.6;
    v += normalize(away + vec3(0.0, 1e-4, 0.0)) * uBurstSpeed * (0.35 + 0.9 * hash11(seed * 23.1));
    v.y += uBurstLift * hash11(seed * 4.7);
    heat = max(heat, uBurstHeat * (0.75 + 0.25 * hash11(seed * 6.1)));
  }

  // How untethered it is. Stays fully free for most of the heat, then lets go.
  float free = smoothstep(0.0, 0.4, heat);

  // A particle in flight belongs to the room, not the body: when the body moves
  // under it (the squat), it stays where it is.
  d -= (home - texelFetch(tHomePrev, t, 0).xyz) * free * uFirst;
  vec3 p = home + d;

  // The stroke: every particle it passes over is dragged toward the cursor's
  // velocity at the particle's own depth. The stroke is the whole segment the
  // cursor covered this frame, so a fast swipe leaves no gaps.
  if (uHit * uFirst > 0.5) {
    vec4 c = uViewProj * vec4(p, 1.0);
    if (c.w > 0.0) {
      vec2 q = c.xy / c.w;
      q.x *= uAspect;
      float f = 1.0 - smoothstep(0.0, uBrush * 2.0, segmentDistance(q, uFrom, uTo));
      // The stroke bites into the side facing it: the far side of the body is
      // barely touched, so a swipe leaves a hole you see particles through
      // rather than sawing the torso in half. Each particle also gives way a
      // little more or less easily, which tears the hole's edge.
      float facing = dot(nd.xyz, normalize(uCamPos - p));
      f *= mix(0.3, 1.0, smoothstep(-0.3, 0.4, facing));
      f = clamp(f * (0.55 + 0.9 * hash11(seed * 3.71)), 0.0, 1.0);
      if (f > 0.0) {
        vec3 swipe = (uCamRight * uCursorVel.x + uCamUp * uCursorVel.y) * c.w * uTanHalfFov;
        float speed = length(swipe);
        // Most fly a little, a few fly far: the chunk stretches into a stream.
        float kick = 0.5 + 1.0 * hash11(seed * 7.13);
        vec3 spray = (hash31(seed) * 2.0 - 1.0) * speed * uSpray;
        v = mix(v, (swipe * kick + spray) * uForce, f);
        // Only the heart of the stroke comes free; its fringe is nudged and
        // stays tethered, so a swipe tears a soft-edged hole, not a cut-out.
        heat = max(heat, f * smoothstep(0.05, 0.8, speed));
        free = smoothstep(0.0, 0.4, heat);
      }
    }
  }

  // In flight: it falls, swirls and slows.
  v.y -= uGravity * free * dt;
  // Still curling on the way home, so the return reads as a flow, not a rewind.
  float stir = max(free, 0.35 * smoothstep(0.0, 0.12, length(d)));
  v += curl(p * 1.6 + vec3(0.0, uTime * 0.25, 0.0)) * uSwirl * stir * dt;
  v *= exp(-uDrag * free * dt);

  // Home takes hold as it cools. Critically damped: back once, no overshoot.
  float hold = (1.0 - free) * (1.0 - free) * (1.0 - waiting);
  float k = uPull * uPull;
  v += (-d * k - v * 2.0 * uPull) * hold * dt;

  // The idle current. Divergence-free, sampled where the particle IS, so
  // neighbours ride it together and circle their homes: the surface churns,
  // gaps open and close, and nothing clumps or thins. Scaled by the pull's
  // stiffness, so uFlow is the reach in metres whatever the pull is set to.
  // Two octaves: body-sized eddies, and grain-sized ones riding on them.
  vec3 q = p * 4.0 + vec3(0.7, 1.0, -0.5) * uTime * uChurn;
  vec3 current = curl(q) + 0.6 * curl(q * 2.7 + vec3(11.0, 3.0, 7.0));
  // (× 4: the current's typical magnitude is ~¼, measured — a mean offset of
  // 5 mm for a 14 mm setting at × 1.5.)
  v += current * uFlow * k * 4.0 * (0.5 + hash11(seed * 5.3)) * hold * dt;

  // Loose grains: one skin particle in six now and then lifts off along its
  // normal and settles back, each on its own clock — the fizz on igloo's
  // silhouettes.
  float surface = 1.0 - smoothstep(0.0, 0.3, nd.w);
  float loose = step(0.83, hash11(seed * 9.1));
  float lift = pow(max(0.0, sin(uTime * (0.45 + 0.6 * hash11(seed * 2.9)) + seed * 83.0)), 16.0);
  v += nd.xyz * uFizz * k * surface * loose * lift * hold * dt;

  float sp = length(v);
  if (sp > 9.0) v *= 9.0 / sp;
  p += v * dt;

  // The container. Its bounds always include the particle's own home, so the
  // body itself is never clipped — only what is thrown at the glass.
  // (A select, not mix(): blending with ±1e4 rounds the wall by ~1 mm in float.)
  vec3 lo = min(uWalls > 0.5 ? uBoxMin : vec3(-1e4, uBoxMin.y, -1e4), home);
  vec3 hi = max(uWalls > 0.5 ? uBoxMax : vec3(1e4), home);
  // Against a wall a particle stops going through it and bleeds off speed along
  // it — so it piles up, and a hard throw still runs a little way up the glass.
  float slide = exp(-1.5 * dt);
  if (p.x < lo.x) { p.x = lo.x; v.x = abs(v.x) * 0.1; v.yz *= slide; }
  if (p.x > hi.x) { p.x = hi.x; v.x = -abs(v.x) * 0.1; v.yz *= slide; }
  if (p.z < lo.z) { p.z = lo.z; v.z = abs(v.z) * 0.1; v.xy *= slide; }
  if (p.z > hi.z) { p.z = hi.z; v.z = -abs(v.z) * 0.1; v.xy *= slide; }
  if (p.y < lo.y) { p.y = lo.y; v.y = abs(v.y) * 0.1; v.xz *= slide; }
  if (p.y > hi.y) { p.y = hi.y; v.y = -abs(v.y) * 0.1; v.xz *= slide; }

  heat = max(0.0, heat - dt / uHeatLife);
  outOffset = vec4(p - home, heat);
  outVelocity = vec4(v, max(0.0, wait - dt));
}
