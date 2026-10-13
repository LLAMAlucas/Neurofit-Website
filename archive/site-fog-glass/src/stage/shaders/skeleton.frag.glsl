// Skeleton — fragment stage.
//
// The same round grain as the body, in the hot white-blue a thrown particle
// glows, pushed a little past 1.0 so the bloom gives it a faint halo: it reads
// as the body's own material, condensed and lit, not as a diagram laid over it.
// Red at a fault, like the body; fogged at the same rate as everything else.

uniform vec3 uColor;
uniform float uGlow;
uniform vec3 uRed;
uniform float uRedGlow;
uniform vec3 uFogColor;
uniform float uFogDensity;

varying float vReveal;
varying float vRed;
varying float vDepth;
varying float vSeed;
varying float vJoint;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c);
  if (r2 > 0.25) discard;
  float soft = 1.0 - smoothstep(0.08, 0.25, r2);

  // Joints a touch brighter than the bones between them.
  vec3 col = uColor * uGlow * (0.9 + 0.2 * vJoint);
  // Red takes over much sooner than on the body. The body mixes its red into
  // dark graphite, where even a partial share reads as red; mixed into this
  // near-white it read as white — a knee ~11 cm off the fault's centre line,
  // at 0.4 of the way to red, came out pale pink and looked untouched.
  float red = smoothstep(0.0, 0.3, vRed);
  col = mix(col, uRed * (1.0 + uRedGlow), red);

  float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
  col = mix(col, uFogColor, fog);

  gl_FragColor = vec4(col, soft * vReveal * (0.7 + 0.3 * vSeed));
  #include <colorspace_fragment>
}
