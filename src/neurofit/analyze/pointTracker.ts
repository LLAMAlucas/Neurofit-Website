/**
 * "Track a point": follow something the pose model doesn't know about — the end of a barbell,
 * a kettlebell, a club head — from frame to frame. PURE module (typed arrays in, points out).
 * ----------------------------------------------------------------------------
 * Normalized cross-correlation of a small patch around the point, searched in a window around
 * where it was last seen (the same idea as Kinovea's trajectory tool). The template re-anchors
 * on every confident match so slow changes (rotation, lighting) are followed. When the best match
 * falls under `minScore` the track STOPS rather than guessing — a bar path that jumps to a
 * plate edge two metres away is worse than a path that ends early.
 * ⚠️ minScore / searchRadius are UNVALIDATED (n=0).
 */
import { ANALYZE } from "./config";

export interface Gray {
  width: number;
  height: number;
  /** Luminance, row-major, one value per pixel. */
  data: Float32Array;
}

/** RGBA bytes (canvas ImageData) → luminance. */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Gray {
  const data = new Float32Array(width * height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  return { width, height, data };
}

interface Template {
  half: number;
  /** Mean-subtracted patch values. */
  v: Float32Array;
  /** sqrt(Σ v²). */
  norm: number;
}

function cut(g: Gray, cx: number, cy: number, half: number): Template | null {
  const x0 = Math.round(cx) - half;
  const y0 = Math.round(cy) - half;
  if (x0 < 0 || y0 < 0 || x0 + 2 * half >= g.width || y0 + 2 * half >= g.height) return null;
  const n = (2 * half + 1) ** 2;
  const v = new Float32Array(n);
  let sum = 0;
  let k = 0;
  for (let y = 0; y <= 2 * half; y++) {
    const row = (y0 + y) * g.width + x0;
    for (let x = 0; x <= 2 * half; x++) {
      v[k] = g.data[row + x];
      sum += v[k++];
    }
  }
  const mean = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    v[i] -= mean;
    ss += v[i] * v[i];
  }
  // A flat patch (sky, a blank wall) has nothing to lock onto.
  if (ss < n * 4) return null;
  return { half, v, norm: Math.sqrt(ss) };
}

/** NCC of the template against the patch centred at (cx, cy); −1…1, or null off-image. */
function nccAt(g: Gray, t: Template, cx: number, cy: number): number | null {
  const h = t.half;
  const x0 = cx - h;
  const y0 = cy - h;
  if (x0 < 0 || y0 < 0 || x0 + 2 * h >= g.width || y0 + 2 * h >= g.height) return null;
  const side = 2 * h + 1;
  const n = side * side;
  let sum = 0;
  for (let y = 0; y < side; y++) {
    const row = (y0 + y) * g.width + x0;
    for (let x = 0; x < side; x++) sum += g.data[row + x];
  }
  const mean = sum / n;
  let dot = 0;
  let ss = 0;
  let k = 0;
  for (let y = 0; y < side; y++) {
    const row = (y0 + y) * g.width + x0;
    for (let x = 0; x < side; x++) {
      const d = g.data[row + x] - mean;
      dot += d * t.v[k++];
      ss += d * d;
    }
  }
  if (ss <= 1e-6) return 0;
  return dot / (Math.sqrt(ss) * t.norm);
}

export interface TrackHit {
  x: number;
  y: number;
  score: number;
}

/** Best NCC match within `radius` of (cx, cy), with a parabolic sub-pixel refinement. */
export function matchNear(g: Gray, t: Template, cx: number, cy: number, radius: number): TrackHit | null {
  const rx = Math.round(cx);
  const ry = Math.round(cy);
  let best: TrackHit | null = null;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const s = nccAt(g, t, rx + dx, ry + dy);
      if (s !== null && (best === null || s > best.score)) best = { x: rx + dx, y: ry + dy, score: s };
    }
  }
  if (!best) return null;
  const sub = (a: number | null, b: number, c: number | null) => {
    if (a === null || c === null) return 0;
    const den = a - 2 * b + c;
    return den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  };
  const ox = sub(nccAt(g, t, best.x - 1, best.y), best.score, nccAt(g, t, best.x + 1, best.y));
  const oy = sub(nccAt(g, t, best.x, best.y - 1), best.score, nccAt(g, t, best.x, best.y + 1));
  return { x: best.x + ox, y: best.y + oy, score: best.score };
}

export class PointTracker {
  /** The patch as first picked — matched first every frame, so rounding never accumulates. */
  private readonly base: Template;
  /** The patch at the last confident match — the fallback once the object has changed look. */
  private recent: Template;
  private x: number;
  private y: number;
  lost = false;

  /** Returns null if the point has nothing to track (flat patch, too near the edge). */
  static start(first: Gray, x: number, y: number, cfg = ANALYZE.tracker): PointTracker | null {
    const t = cut(first, x, y, cfg.halfPatch);
    return t ? new PointTracker(t, x, y, cfg) : null;
  }

  private constructor(t: Template, x: number, y: number, private readonly cfg: typeof ANALYZE.tracker) {
    this.base = t;
    this.recent = t;
    this.x = x;
    this.y = y;
  }

  /** Follow the point into the next frame. null once lost (and forever after). */
  step(g: Gray): TrackHit | null {
    if (this.lost) return null;
    const r = this.cfg.searchRadius;
    // Re-anchoring on every frame drifts (each new patch is cut at a rounded centre), so the
    // original patch wins whenever it still matches well; the recent one only covers the
    // stretches where the object looks different (rotated, lit differently).
    let hit = matchNear(g, this.base, this.x, this.y, r);
    if (!hit || hit.score < 0.75) {
      const alt = this.recent === this.base ? null : matchNear(g, this.recent, this.x, this.y, r);
      if (alt && (!hit || alt.score > hit.score)) hit = alt;
    }
    if (!hit || hit.score < this.cfg.minScore) {
      this.lost = true;
      return null;
    }
    this.x = hit.x;
    this.y = hit.y;
    if (hit.score >= 0.8) {
      const t = cut(g, hit.x, hit.y, this.cfg.halfPatch);
      if (t) this.recent = t;
    }
    return hit;
  }
}
