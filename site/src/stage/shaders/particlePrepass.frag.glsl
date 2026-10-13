// Particle body — the depth prepass (see particleBody.vert.glsl, PREPASS).
// Depth only: a hard disc, so the shell has no soft edge to leak through.

void main() {
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
  gl_FragColor = vec4(0.0);
}
