/**
 * The pose over a whole clip: one sample per analysed frame, kept in time order. PURE module.
 * ----------------------------------------------------------------------------
 * Filled by the pose pass (hooks/usePoseTrack.ts) and by exact single-frame detections when the
 * user pauses. Everything is keyed by clip time in ms, never a frame index — the pass samples
 * whatever frames the browser presents, which is not every frame of a 60 or 240 fps clip.
 */
import type { Landmark } from "../pose/landmarks";
import { MIN_VISIBILITY } from "../pose/landmarks";
import { toPx, type FrameSize, type Pt } from "./geometry";

export interface PoseSample {
  tMs: number;
  /** All 33 MediaPipe points, normalized. */
  landmarks: Landmark[];
  /** True when this came from an exact single-frame detection (IMAGE mode) rather than the pass. */
  exact?: boolean;
}

export interface SeriesPoint {
  tMs: number;
  v: number;
}

/** Index of the first element with tMs >= t (binary search). */
function lowerBound(arr: readonly { tMs: number }[], t: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m].tMs < t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

export class PoseTrack {
  private samples: PoseSample[] = [];

  constructor(public readonly size: FrameSize) {}

  get length(): number {
    return this.samples.length;
  }

  all(): readonly PoseSample[] {
    return this.samples;
  }

  /** Insert in time order. A sample within 1 ms of an existing one replaces it — an exact
   *  detection supersedes the pass's sample of the same frame, never the other way round. */
  add(s: PoseSample): void {
    const i = lowerBound(this.samples, s.tMs - 1);
    const hit = this.samples[i];
    if (hit && Math.abs(hit.tMs - s.tMs) <= 1) {
      if (hit.exact && !s.exact) return;
      this.samples[i] = s;
      return;
    }
    this.samples.splice(i, 0, s);
  }

  clear(): void {
    this.samples = [];
  }

  /** The sample nearest `tMs`, if one lies within `maxGapMs`. */
  nearest(tMs: number, maxGapMs: number): PoseSample | null {
    if (this.samples.length === 0) return null;
    const i = lowerBound(this.samples, tMs);
    let best: PoseSample | null = null;
    for (const j of [i - 1, i]) {
      const s = this.samples[j];
      if (s && (best === null || Math.abs(s.tMs - tMs) < Math.abs(best.tMs - tMs))) best = s;
    }
    return best && Math.abs(best.tMs - tMs) <= maxGapMs ? best : null;
  }

  /** Samples with fromMs ≤ tMs ≤ toMs. */
  between(fromMs: number, toMs: number): PoseSample[] {
    return this.samples.slice(lowerBound(this.samples, fromMs), lowerBound(this.samples, toMs + 0.001));
  }

  /** One value per sample (nulls dropped). */
  series(fn: (s: PoseSample) => number | null, fromMs = -Infinity, toMs = Infinity): SeriesPoint[] {
    const out: SeriesPoint[] = [];
    for (const s of this.between(fromMs, toMs)) {
      const v = fn(s);
      if (v !== null && Number.isFinite(v)) out.push({ tMs: s.tMs, v });
    }
    return out;
  }

  /** A joint's path in video pixels, with speed (px/s) at each point. Unseen frames break the
   *  path into separate runs, so a trail never draws a straight line through a gap. */
  jointPath(index: number, fromMs: number, toMs: number, minVis = MIN_VISIBILITY): TrailPoint[][] {
    const runs: TrailPoint[][] = [];
    let run: TrailPoint[] = [];
    for (const s of this.between(fromMs, toMs)) {
      const l = s.landmarks[index];
      if (!l || !(l.visibility >= minVis)) {
        if (run.length) runs.push(run);
        run = [];
        continue;
      }
      run.push({ tMs: s.tMs, p: toPx(l.x, l.y, this.size), speed: 0 });
    }
    if (run.length) runs.push(run);
    for (const r of runs) withSpeed(r);
    return runs;
  }
}

export interface TrailPoint {
  tMs: number;
  p: Pt;
  /** px per second, from the neighbouring points. */
  speed: number;
}

/** Fill `speed` from the neighbours (central difference; one-sided at the ends). */
export function withSpeed(run: TrailPoint[]): TrailPoint[] {
  for (let i = 0; i < run.length; i++) {
    const a = run[Math.max(0, i - 1)];
    const b = run[Math.min(run.length - 1, i + 1)];
    const dt = (b.tMs - a.tMs) / 1000;
    run[i].speed = dt > 0 ? Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]) / dt : 0;
  }
  return run;
}

/** Centered moving average over a TIME window (not a sample count — the sampling is uneven). */
export function smoothSeries(s: readonly SeriesPoint[], windowMs: number): SeriesPoint[] {
  if (windowMs <= 0 || s.length < 3) return s.slice();
  const half = windowMs / 2;
  const out: SeriesPoint[] = [];
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const t = s[i].tMs;
    while (hi < s.length && s[hi].tMs <= t + half) sum += s[hi++].v;
    while (s[lo].tMs < t - half) sum -= s[lo++].v;
    out.push({ tMs: t, v: sum / (hi - lo) });
  }
  return out;
}

/** p-th percentile (0–100) of the values, by nearest rank. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const k = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[k];
}
