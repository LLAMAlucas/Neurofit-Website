/**
 * Geometry for the JPEGs sent to Gemini: where to crop and what size to encode.
 * PURE module — no DOM. CoachCamera owns the canvas and calls these.
 *
 * Two rules, both about the model judging angles from a photo:
 *  - The shape is kept. Width and height always scale by the same factor, so an angle in the
 *    photo is the angle the camera saw. (A fixed 640×480 target squashed a 16:9 feed 25%.)
 *  - The crop is a rectangle cut from the source, then scaled uniformly — a crop moves and
 *    scales the picture, it never bends it.
 */

/** A rectangle in SOURCE pixels. */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The fields the crop reads; MediaPipe's NormalizedLandmark (x, y in [0,1]) fits it. */
export interface CropPoint {
  x: number;
  y: number;
  visibility?: number;
}

export interface CropOptions {
  minVisibility: number;
  minPoints: number;
  padFrac: number;
}

/** Output size for a `w`×`h` source: long side ≤ `maxEdge`, same scale on both axes, never
 *  upscaled (a small crop gains no detail from extra pixels). */
export function fitWithin(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * Box around the lifter in source pixels, or null to send the full frame. Uses every visible
 * landmark (not one exercise's list), so the knuckles keep the pull-up bar in shot and the
 * hands and feet keep the floor. The margin is the same number of PIXELS on x and y —
 * landmarks are normalized per axis, so a margin taken in normalized units would be 16:9-uneven.
 */
export function bodyCropRect(
  landmarks: readonly CropPoint[] | null | undefined,
  frameW: number,
  frameH: number,
  opts: CropOptions,
): PixelRect | null {
  if (!landmarks || frameW <= 0 || frameH <= 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let n = 0;
  for (const p of landmarks) {
    if ((p.visibility ?? 0) < opts.minVisibility || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const px = p.x * frameW;
    const py = p.y * frameH;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
    n++;
  }
  if (n < opts.minPoints) return null;
  const pad = opts.padFrac * Math.max(maxX - minX, maxY - minY);
  const x0 = Math.max(0, Math.floor(minX - pad));
  const y0 = Math.max(0, Math.floor(minY - pad));
  const x1 = Math.min(frameW, Math.ceil(maxX + pad));
  const y1 = Math.min(frameH, Math.ceil(maxY + pad));
  // A body entirely off-frame (all visible points clamped away) leaves nothing to crop.
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
