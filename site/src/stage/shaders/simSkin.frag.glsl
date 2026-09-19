// Particle sim — skin pass. One texel per particle.
//
// Where each particle BELONGS this frame: its rest point on the body, skinned
// by the same bone texture three would use for the mesh (the layout of three's
// skinning_pars_vertex), so the body squats and the homes squat with it. The
// step pass pulls particles toward these; the points are drawn at home + offset.

uniform sampler2D uBoneTexture;
uniform mat4 uBindMatrix;
uniform mat4 uBindMatrixInverse;

uniform sampler2D tRest;        // xyz rest position, w seed
uniform sampler2D tRestNormal;  // xyz rest normal, w depth (0 skin → 1 bone axis)
uniform sampler2D tSkinIndex;
uniform sampler2D tSkinWeight;

layout(location = 0) out vec4 outHome;    // xyz home, w seed
layout(location = 1) out vec4 outNormal;  // xyz normal, w depth

mat4 getBoneMatrix(const in float i) {
  int size = textureSize(uBoneTexture, 0).x;
  int j = int(i) * 4;
  int x = j % size;
  int y = j / size;
  vec4 v1 = texelFetch(uBoneTexture, ivec2(x, y), 0);
  vec4 v2 = texelFetch(uBoneTexture, ivec2(x + 1, y), 0);
  vec4 v3 = texelFetch(uBoneTexture, ivec2(x + 2, y), 0);
  vec4 v4 = texelFetch(uBoneTexture, ivec2(x + 3, y), 0);
  return mat4(v1, v2, v3, v4);
}

void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 rest = texelFetch(tRest, t, 0);
  vec4 restN = texelFetch(tRestNormal, t, 0);
  vec4 si = texelFetch(tSkinIndex, t, 0);
  vec4 sw = texelFetch(tSkinWeight, t, 0);

  mat4 skin = sw.x * getBoneMatrix(si.x) + sw.y * getBoneMatrix(si.y) +
              sw.z * getBoneMatrix(si.z) + sw.w * getBoneMatrix(si.w);
  skin = uBindMatrixInverse * skin * uBindMatrix;

  outHome = vec4((skin * vec4(rest.xyz, 1.0)).xyz, rest.w);
  // A texel past the last particle has no normal; keep it finite.
  vec3 n = (skin * vec4(restN.xyz, 0.0)).xyz;
  outNormal = vec4(dot(n, n) > 0.0 ? normalize(n) : vec3(0.0, 1.0, 0.0), restN.w);
}
