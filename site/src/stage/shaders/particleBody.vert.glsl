// Particle body — vertex stage.
//
// Every particle is one texel of the simulation (particleSim.ts). Its skin pass
// gives the particle's home on the posed body and its normal; its step pass
// gives the offset from that home and how hot the particle is. At rest the
// offset is zero and the particle sits exactly on the skin; a swipe throws it
// off, and it glows while it is out.

uniform highp sampler2D uHome;    // xyz home, w seed
uniform highp sampler2D uNormal;  // xyz normal, w depth (0 skin → 1 bone axis)
uniform highp sampler2D uOffset;  // xyz offset from home, w heat

uniform float uSize;        // particle diameter, metres
// 1 for the body; 0 for a ghost, which redraws the same particles pinned to
// their homes — a still copy of the pose, with no swipe holes in it.
uniform float uOffsetScale;
uniform float uViewportH;   // drawing-buffer height, px

// Fault capsules: segment a→b, falloff radius, how red (0…1).
uniform vec3 uFaultA[4];
uniform vec3 uFaultB[4];
uniform float uFaultR[4];
uniform float uFaultAmt[4];

// The phone's scan (the flow stop): how lit the front it faces is, the sweep
// line's height and whether it's still sweeping, and where the lens is — all
// in world space, so it follows the body as it turns side-on.
uniform float uScan;
uniform float uScanY;
uniform float uScanBand;
uniform vec3 uScanFrom;

attribute vec2 aSimUv;

varying float vScan;        // 0…1+: how lit by the phone's scan
varying float vRim;
varying float vShade;
varying float vRed;
varying float vSeed;
varying float vDepth;       // view depth, for fog
varying float vInner;       // depth into the body, passed on
varying float vHeat;        // 0 at rest → 1 just thrown
varying float vY;           // height, for the hologram's bands

float segmentDistance(vec3 p, vec3 a, vec3 b) {
  vec3 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(p - (a + ab * t));
}

void main() {
  vec4 h = texture(uHome, aSimUv);
  vec4 nd = texture(uNormal, aSimUv);
  vec4 o = texture(uOffset, aSimUv);
  vec3 home = h.xyz;
  float seed = h.w;
  vec3 n = nd.xyz;
  float inner = nd.w;
  float heat = o.w * uOffsetScale;

  // Red: the strongest of the fault capsules this particle's HOME sits near, so
  // a particle thrown out of a fault carries its red with it. The falloff is
  // soft on purpose — a hard edge reads as a body part being highlighted, a
  // soft one as the fault radiating from where it happens.
  float red = 0.0;
  for (int i = 0; i < 4; i++) {
    float d = segmentDistance(home, uFaultA[i], uFaultB[i]);
    float r = max(uFaultR[i], 1e-4);
    red = max(red, uFaultAmt[i] * (1.0 - smoothstep(r * 0.2, r, d)));
  }

  // Home plus the sim's offset — which, even untouched, the idle current keeps
  // moving.
  vec3 p = home + o.xyz * uOffsetScale;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  vec3 vn = normalize(normalMatrix * n);
  vec3 vd = normalize(-mv.xyz);
  // A high power keeps the rim on true silhouette edges: at 2.2 it lit half the
  // front-facing points and the body read as salt-and-pepper static. A thrown
  // particle is off the silhouette, so it loses its rim.
  vRim = pow(1.0 - abs(dot(vn, vd)), 4.0) * (1.0 - inner) * (1.0 - heat);
  // Key light from above, in WORLD space so the shading stays put as the camera
  // orbits — lit shoulders and thighs, shadowed undersides.
  vec3 wn = normalize(mat3(modelMatrix) * n);
  vShade = clamp(dot(wn, normalize(vec3(0.2, 1.0, 0.35))) * 0.5 + 0.5, 0.0, 1.0);
  // Only what faces the lens is scanned — the front, then side-on the side —
  // from the top down to the sweep line, which itself is a brighter band.
  vScan = 0.0;
  if (uScan > 0.001) {
    vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;
    float facing = smoothstep(0.05, 0.45, dot(wn, normalize(uScanFrom - wp))) * (1.0 - inner);
    float swept = smoothstep(uScanY - 0.015, uScanY + 0.015, wp.y);
    float line = (1.0 - smoothstep(0.0, 0.035, abs(wp.y - uScanY))) * uScanBand;
    vScan = uScan * facing * (swept + 0.8 * line);
  }
  vRed = red;
  vSeed = seed;
  vDepth = -mv.z;
  vInner = inner;
  vHeat = heat;
  vY = p.y;

  // Inner points are smaller, so the fill reads as depth behind the skin
  // rather than as a second skin.
  float size = uSize * (0.7 + seed * 0.6) * (1.0 - 0.35 * inner) * (1.0 + red * 0.45);
  float px = size * projectionMatrix[1][1] * uViewportH * 0.5 / max(-mv.z, 0.05);
  // Capped, and shrunk away right at the lens. A grain drifting past the camera
  // was drawn tens of pixels wide, and a forming cloud or a hard throw puts
  // thousands there at once: enough overdraw to drop the frame rate to single
  // figures, which slows the physics with it. A body particle at the camera's
  // usual distance is ~14 px, far under the cap.
  gl_PointSize = min(px, uViewportH * 0.03) * smoothstep(0.35, 1.0, -mv.z);
}
