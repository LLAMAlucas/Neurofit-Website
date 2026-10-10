/**
 * Measurement geometry for the Analyze tools. PURE module.
 * ----------------------------------------------------------------------------
 * Everything here works in VIDEO PIXEL space ([x·W, y·H]) — the clip's own pixels. That is the
 * same space as the live coach's aspect space ([x·W/H, y], scaled by H), so an angle measured
 * here is the real image angle on any clip shape: portrait phone, 16:9 laptop or 4:3. MediaPipe's
 * normalized coordinates must go through `toPx` first — an angle on raw normalized x/y bends
 * with the aspect ratio (see CLAUDE.md "Every angle is in aspect space").
 */
import { calculateAngle } from "../pose/angle";

export type Pt = readonly [number, number];

export interface FrameSize {
  width: number;
  height: number;
}

/** Normalized [0,1] point → video pixels. */
export function toPx(x: number, y: number, size: FrameSize): Pt {
  return [x * size.width, y * size.height];
}

/** Angle at `b` of a–b–c, degrees in [0,180]. */
export function angleAt(a: Pt, b: Pt, c: Pt): number {
  return calculateAngle(a, b, c);
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Tilt of the a→b line off horizontal, degrees in [0,90] (direction-free). */
export function tiltFromHorizontalDeg(a: Pt, b: Pt): number {
  const dx = Math.abs(b[0] - a[0]);
  const dy = Math.abs(b[1] - a[1]);
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/** Lean of the a→b line off vertical, degrees in [0,90] (direction-free). */
export function leanFromVerticalDeg(a: Pt, b: Pt): number {
  return 90 - tiltFromHorizontalDeg(a, b);
}

/**
 * Distance calibration: the user draws a line over something of known size (a 45 cm plate, a
 * 2 m doorway) and every ruler then reads in that unit. Only true in the plane of the reference
 * object — anything nearer or farther from the camera reads wrong, and the UI says so.
 */
export interface Calibration {
  /** Pixels per unit, from the reference line. */
  pxPerUnit: number;
  unit: "cm" | "in" | "m";
}

export function makeCalibration(refLengthPx: number, realLength: number, unit: Calibration["unit"]): Calibration | null {
  if (!(refLengthPx > 0) || !(realLength > 0) || !Number.isFinite(refLengthPx) || !Number.isFinite(realLength)) return null;
  return { pxPerUnit: refLengthPx / realLength, unit };
}

/** A length for display: calibrated units when there is a calibration, else pixels. */
export function formatLength(px: number, cal: Calibration | null): string {
  if (!cal) return `${Math.round(px)} px`;
  const v = px / cal.pxPerUnit;
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${cal.unit}`;
}

/** Distance from point p to the segment a–b (px). Used for hit-testing drawn lines. */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return dist(p, a);
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, [a[0] + t * vx, a[1] + t * vy]);
}

/**
 * The SVG arc for an angle marker at `b` between rays b→a and b→c, radius r. Returns the path
 * `d` plus where to put the label (on the bisector, just outside the arc). Always the INNER
 * (≤180°) angle, matching `angleAt`.
 */
export function angleArc(a: Pt, b: Pt, c: Pt, r: number): { d: string; label: Pt } {
  const a1 = Math.atan2(a[1] - b[1], a[0] - b[0]);
  const a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let delta = a2 - a1;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const p1: Pt = [b[0] + r * Math.cos(a1), b[1] + r * Math.sin(a1)];
  const p2: Pt = [b[0] + r * Math.cos(a1 + delta), b[1] + r * Math.sin(a1 + delta)];
  const sweep = delta > 0 ? 1 : 0;
  const mid = a1 + delta / 2;
  const lr = r + Math.max(10, r * 0.45);
  return {
    d: `M ${p1[0].toFixed(1)} ${p1[1].toFixed(1)} A ${r} ${r} 0 0 ${sweep} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`,
    label: [b[0] + lr * Math.cos(mid), b[1] + lr * Math.sin(mid)],
  };
}
