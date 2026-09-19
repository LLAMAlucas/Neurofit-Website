// Skeleton — vertex stage.
//
// The tracked skeleton, as condensed grains inside the body (lib/sampleSkeleton).
// Skinned here from the same bone texture as the body, so it squats with it.
//
// Hidden until the flesh around a grain is thrown off: each grain knows the four
// body particles nearest its bind position, and shows once ALL of them have been
// moved from home — the least moved of the four decides (their mean let a single
// fizzing grain light the bone under it) — AND at least one of them is hot.
// Only a swipe heats a particle; the idle current carries neighbours together
// and now and then several centimetres, which distance alone mistook for a hole.

uniform highp sampler2D uOffset;      // the body sim: xyz offset from home, w heat
uniform highp sampler2D uBoneTexture;
uniform mat4 uBindMatrix;
uniform mat4 uBindMatrixInverse;

uniform float uSize;          // grain diameter, metres
uniform float uViewportH;     // drawing-buffer height, px
uniform float uRevealFrom;    // m: flesh moved less than this hides the grain
uniform float uRevealTo;      // m: moved this far shows it fully
uniform float uAlways;        // 1 = show the whole skeleton (tuning)

uniform vec3 uFaultA[4];
uniform vec3 uFaultB[4];
uniform float uFaultR[4];
uniform float uFaultAmt[4];

attribute vec4 aSkinIndex;
attribute vec4 aSkinWeight;
attribute vec4 aNearA;        // the uvs of two of the four nearest body particles
attribute vec4 aNearB;        // … and the other two
attribute float aSeed;
attribute float aJoint;

varying float vReveal;
varying float vRed;
varying float vDepth;
varying float vSeed;
varying float vJoint;

mat4 getBoneMatrix(const in float i) {
  int size = textureSize(uBoneTexture, 0).x;
  int j = int(i) * 4;
  int x = j % size;
  int y = j / size;
  return mat4(
    texelFetch(uBoneTexture, ivec2(x, y), 0),
    texelFetch(uBoneTexture, ivec2(x + 1, y), 0),
    texelFetch(uBoneTexture, ivec2(x + 2, y), 0),
    texelFetch(uBoneTexture, ivec2(x + 3, y), 0));
}

float segmentDistance(vec3 p, vec3 a, vec3 b) {
  vec3 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(p - (a + ab * t));
}

void main() {
  vec4 n0 = texture(uOffset, aNearA.xy);
  vec4 n1 = texture(uOffset, aNearA.zw);
  vec4 n2 = texture(uOffset, aNearB.xy);
  vec4 n3 = texture(uOffset, aNearB.zw);
  float moved = min(min(length(n0.xyz), length(n1.xyz)), min(length(n2.xyz), length(n3.xyz)));
  float struck = smoothstep(0.0, 0.05, max(max(n0.w, n1.w), max(n2.w, n3.w)));
  float reveal = max(uAlways, smoothstep(uRevealFrom, uRevealTo, moved) * struck);

  mat4 skin = aSkinWeight.x * getBoneMatrix(aSkinIndex.x) + aSkinWeight.y * getBoneMatrix(aSkinIndex.y) +
              aSkinWeight.z * getBoneMatrix(aSkinIndex.z) + aSkinWeight.w * getBoneMatrix(aSkinIndex.w);
  vec3 p = (uBindMatrixInverse * skin * uBindMatrix * vec4(position, 1.0)).xyz;

  // The same fault capsules as the body: a caved knee is red to the bone.
  float red = 0.0;
  for (int i = 0; i < 4; i++) {
    float d = segmentDistance(p, uFaultA[i], uFaultB[i]);
    float r = max(uFaultR[i], 1e-4);
    red = max(red, uFaultAmt[i] * (1.0 - smoothstep(r * 0.2, r, d)));
  }

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  vReveal = reveal;
  vRed = red;
  vDepth = -mv.z;
  vSeed = aSeed;
  vJoint = aJoint;

  float size = uSize * (0.75 + aSeed * 0.5) * (1.0 + 0.25 * aJoint);
  float px = size * projectionMatrix[1][1] * uViewportH * 0.5 / max(-mv.z, 0.05);
  // A hidden grain is not rasterised at all: the skeleton costs nothing until
  // a hole is torn.
  gl_PointSize = reveal > 0.004 ? min(px, uViewportH * 0.03) * smoothstep(0.35, 1.0, -mv.z) : 0.0;
}
