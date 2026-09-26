// Particle body — fragment stage.
//
// Graphite points on pale fog, the way igloo draws its point-cloud penguin: the
// body reads by density and by its silhouette catching the light, not by a
// surface. A thrown particle runs hot — near-white, like igloo's spray — and
// cools back to graphite. Red is the only saturated colour on the page, and it
// is pushed past 1.0 so the bloom pass — thresholded at 1.0 — lights up the
// faults and nothing else.

uniform vec3 uGraphite;
uniform vec3 uRimColor;
uniform float uRim;
uniform vec3 uRed;
uniform float uGlow;
uniform vec3 uHotColor;
uniform float uOpacity;
uniform vec3 uFogColor;
uniform float uFogDensity;
// The finale: the body as a hologram on its pedestal — the hot white-blue,
// lighter, with slow bands of light climbing it.
uniform float uHolo;
uniform float uTime;

varying float vScan;
varying float vRim;
varying float vShade;
varying float vRed;
varying float vSeed;
varying float vDepth;
varying float vInner;
varying float vHeat;
varying float vY;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c);
  if (r2 > 0.25) discard;
  float soft = 1.0 - smoothstep(0.1, 0.25, r2);

  // Wide range on purpose: the shading is what gives a point cloud volume.
  vec3 col = uGraphite * mix(0.35, 1.55, vShade * vShade);
  // The fill sits a shade darker, the way the inside of a form is in shadow.
  col *= 1.0 - 0.25 * vInner;
  col = mix(col, uRimColor, clamp(vRim * uRim, 0.0, 1.0));
  // Hot: just thrown. Eased, so it holds white a moment and then cools. A
  // little past 1.0 so the bloom gives the spray a haze — on pale fog a plain
  // white washed out, where igloo's reads as luminous — but far short of the
  // red, which stays the one thing that really glows.
  float hot = smoothstep(0.0, 0.7, vHeat);
  col = mix(col, uHotColor * (1.0 + 0.3 * hot), hot);

  // Fine scan lines climbing it: at 16 cm apart and ±20% they read as stripes
  // painted on, not as light.
  float band = 0.93 + 0.07 * sin(vY * 160.0 - uTime * 2.4);
  col = mix(col, uHotColor * (0.8 + 0.5 * vRim) * band, uHolo * 0.72);

  // The phone's scan: what it faces lights the same cool white-blue as a
  // thrown grain, a touch past 1.0 for the bloom's haze — the red still the
  // one thing that really glows.
  float scanned = clamp(vScan, 0.0, 1.4);
  col = mix(col, uHotColor * (1.05 + 0.2 * scanned), min(1.0, scanned) * 0.92);

  float red = smoothstep(0.0, 1.0, vRed);
  col = mix(col, uRed * (1.0 + uGlow * red), red);

  float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
  col = mix(col, uFogColor, fog);

  float alpha = soft * uOpacity * (0.6 + 0.4 * vSeed) * mix(1.0 - 0.45 * vInner, 1.0, hot) * (1.0 - 0.3 * uHolo);
  gl_FragColor = vec4(col, min(1.0, alpha + 0.4 * red));
  #include <colorspace_fragment>
}
