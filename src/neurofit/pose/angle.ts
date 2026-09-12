/**
 * Joint-angle math. PURE module (see landmarks.ts).
 */
type Vec2 = readonly [number, number];

/**
 * Angle (degrees) at vertex `b` formed by points a–b–c, normalized to [0,180].
 * arctan2-based formula.
 */
export function calculateAngle(a: Vec2, b: Vec2, c: Vec2): number {
  const rad =
    Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(a[1] - b[1], a[0] - b[0]);
  let ang = Math.abs((rad * 180) / Math.PI);
  if (ang > 180) ang = 360 - ang;
  return ang;
}
