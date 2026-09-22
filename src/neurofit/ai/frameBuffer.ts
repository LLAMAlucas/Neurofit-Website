/**
 * Dual rolling buffers for the Gemini calls (spec Part 2), adapted to the browser.
 * PURE module — no DOM, no threads. MediaPipe delivers results on the main JS
 * thread (the WASM inference runs off-thread but posts back), so there is no data
 * race and no lock is needed — the Python spec's threading.Lock has no analogue
 * here. The JPEG is encoded by the caller (CoachCamera owns the canvas) and passed
 * in as base64, so this file stays DOM-free per the pure/glue separation.
 */

export type RepPhase = "standing" | "descent" | "bottom" | "ascent";

/** The 8 landmark indices the squat metrics use. */
export const BUFFER_LANDMARK_INDICES = [11, 12, 23, 24, 25, 26, 27, 28] as const;

/** Push-up buffer: head (nose, ears), both arm chains, hips and legs. A SEPARATE list rather than
 *  extending the squat's — the squat's front-view visibility check reads every buffered key, so
 *  adding arms there would silently change its reliability flag. */
export const PUSHUP_BUFFER_LANDMARK_INDICES = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28] as const;

export interface LandmarkPoint {
  x: number;
  y: number;
  visibility: number;
}

export interface LandmarkSample {
  timestampMs: number;
  landmarks: Record<number, LandmarkPoint>;
  depthRatio: number;
  repPhase: RepPhase;
  repNumber: number;
  setNumber: number;
}

/** Full-rate landmark ring buffer, evicting entries older than `windowMs`. */
export class LandmarkBuffer {
  private samples: LandmarkSample[] = [];
  constructor(private readonly windowMs: number) {}

  add(entry: LandmarkSample): void {
    this.samples.push(entry);
    const cutoff = entry.timestampMs - this.windowMs;
    while (this.samples.length && this.samples[0].timestampMs < cutoff) this.samples.shift();
  }

  /** Samples with timestamp in [startMs, endMs], in order. */
  getWindow(startMs: number, endMs: number): LandmarkSample[] {
    return this.samples.filter((s) => s.timestampMs >= startMs && s.timestampMs <= endMs);
  }

  getLatest(): LandmarkSample | null {
    return this.samples.length ? this.samples[this.samples.length - 1] : null;
  }

  reset(): void {
    this.samples = [];
  }
}

export interface TriggerTag {
  triggerType: string;
  severityRatio: number;
}

export interface ImageFrame {
  timestampMs: number;
  /** Downscaled JPEG as base64 (no data: prefix). Encoded by the caller. */
  jpegBase64: string;
  repNumber: number;
  repPhase: RepPhase;
  /** Populated retroactively when a trigger fires near this frame. */
  triggerTags: TriggerTag[];
}

/** JPEG ring buffer capped at `maxFrames` entries (drops the oldest). */
export class ImageBuffer {
  private frames: ImageFrame[] = [];
  constructor(private readonly maxFrames: number) {}

  add(jpegBase64: string, timestampMs: number, repNumber: number, repPhase: RepPhase): void {
    this.frames.push({ timestampMs, jpegBase64, repNumber, repPhase, triggerTags: [] });
    if (this.frames.length > this.maxFrames) this.frames.shift();
  }

  /** Frames near a timestamp, sorted by time (spec: before/after window). */
  getFramesAround(timestampMs: number, beforeMs = 500, afterMs = 200): ImageFrame[] {
    return this.frames
      .filter((f) => f.timestampMs >= timestampMs - beforeMs && f.timestampMs <= timestampMs + afterMs)
      .sort((a, b) => a.timestampMs - b.timestampMs);
  }

  /** Retroactively tag the frames nearest a trigger event. */
  tagFrames(timestampMs: number, triggerType: string, severityRatio: number, windowMs = 300): void {
    for (const f of this.frames) {
      if (Math.abs(f.timestampMs - timestampMs) <= windowMs) {
        f.triggerTags.push({ triggerType, severityRatio });
      }
    }
  }

  getAll(): ImageFrame[] {
    return [...this.frames];
  }

  reset(): void {
    this.frames = [];
  }
}
