// Particle body — fragment stage.
//
// Points of light on black (2026-10; it was graphite on pale fog). Drawn
// additively, so where the skin's grains overlap the body reads as a lit
// surface and where it curves away they thin to separate points; the depth
// prepass (vertex stage) keeps the far side from adding in. Near is bright,
// far is dim, silhouette edges catch the light. A thrown particle runs hot —
// toward the page's blue — and cools back. Red is still the only colour that
// really glows: it is pushed past 1.0 so the bloom pass — thresholded at 1.0 —
// lights the faults and almost nothing else.

uniform vec3 uGraphite;     // the points' colour at rest (name kept from the fog look)
uniform vec3 uRimColor;
uniform float uRim;
uniform vec3 uRed;
uniform float uGlow;
uniform vec3 uHotColor;
uniform float uOpacity;
uniform float uIntensity;   // how much light one grain adds
uniform float uFarDim;      // the far side's brightness, × the near side's
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
varying float vNear;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c);
  if (r2 > 0.25) discard;
  float soft = 1.0 - smoothstep(0.06, 0.25, r2);

  vec3 col = uGraphite * mix(0.55, 1.0, vShade) * mix(uFarDim, 1.0, vNear);
  col = mix(col, uRimColor * 1.1, clamp(vRim * uRim, 0.0, 1.0));
  // Hot: just thrown. Eased, so it holds a moment and then cools.
  float hot = smoothstep(0.0, 0.7, vHeat);
  col = mix(col, uHotColor * (1.0 + 0.6 * hot), hot);

  // Fine scan lines climbing it: at 16 cm apart they read as stripes of light.
  float band = 0.93 + 0.07 * sin(vY * 160.0 - uTime * 2.4);
  col = mix(col, uHotColor * (0.8 + 0.5 * vRim) * band, uHolo * 0.72);

  // The phone's scan: what it faces lights the same cool blue-white as a
  // thrown grain — the red still the one thing that really glows.
  float scanned = clamp(vScan, 0.0, 1.4);
  col = mix(col, uHotColor * (1.05 + 0.2 * scanned), min(1.0, scanned) * 0.92);

  float red = smoothstep(0.0, 1.0, vRed);
  col = mix(col, uRed * (1.0 + uGlow * red), red);

  // Into the black with distance.
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
  col *= 1.0 - fog;

  float alpha = soft * uOpacity * (0.85 + 0.15 * vSeed) * (1.0 - 0.3 * uHolo);
  gl_FragColor = vec4(col * uIntensity * (1.0 + 0.6 * red), alpha);
  #include <colorspace_fragment>
}
