/**
 * Getting frames out of a user's clip — browser side of Analyze.
 * ----------------------------------------------------------------------------
 * The visible player is the user's: nothing here seeks it. Background work (the pose pass, point
 * tracking, grabbing JPEGs for the AI) runs on its own hidden <video> over the same object URL,
 * so the user can keep scrubbing while it runs. The clip never leaves the device — only the JPEGs
 * `grabJpegs` returns are ever sent anywhere, and only when the user presses an AI button.
 */

type RVFC = (cb: (now: number, meta: { mediaTime: number; presentedFrames: number }) => void) => number;
type WithRVFC = HTMLVideoElement & { requestVideoFrameCallback?: RVFC; cancelVideoFrameCallback?: (h: number) => void };

export function supportsFrameCallback(v: HTMLVideoElement): boolean {
  return typeof (v as WithRVFC).requestVideoFrameCallback === "function";
}

/** A hidden, muted video on `url`, in the document (some browsers won't decode or call
 *  requestVideoFrameCallback for a detached element), ready to draw. Call `.remove()` when done. */
export async function hiddenVideo(url: string): Promise<HTMLVideoElement> {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  v.setAttribute("aria-hidden", "true");
  Object.assign(v.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "2px",
    height: "2px",
    opacity: "0.01",
    pointerEvents: "none",
    zIndex: "-1",
  });
  document.body.appendChild(v);
  v.src = url;
  try {
    await waitFor(v, "loadeddata", 15000);
  } catch (e) {
    v.remove();
    throw e;
  }
  return v;
}

function waitFor(v: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      v.removeEventListener(event, done);
      v.removeEventListener("error", fail);
      resolve();
    };
    const fail = () => {
      clearTimeout(timer);
      v.removeEventListener(event, done);
      v.removeEventListener("error", fail);
      reject(new Error("This video can't be decoded by your browser."));
    };
    const timer = setTimeout(() => {
      v.removeEventListener(event, done);
      v.removeEventListener("error", fail);
      reject(new Error(`Timed out waiting for the video (${event}).`));
    }, timeoutMs);
    v.addEventListener(event, done);
    v.addEventListener("error", fail);
  });
}

/** Seek and wait until that frame is decoded. */
export async function seekTo(v: HTMLVideoElement, tMs: number): Promise<void> {
  const t = Math.max(0, Math.min(v.duration || 0, tMs / 1000));
  if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) return;
  const p = waitFor(v, "seeked", 5000);
  v.currentTime = t;
  await p;
}

/** Draw the current frame scaled so its long side is `longSide` (never upscaled). */
export function drawFrame(v: HTMLVideoElement, longSide: number, canvas = document.createElement("canvas"), filter?: string): HTMLCanvasElement {
  const w = v.videoWidth;
  const h = v.videoHeight;
  const k = Math.min(1, longSide / Math.max(w, h));
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx) {
    if (filter) ctx.filter = filter;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

/** Base64 JPEGs (no data: prefix) of the clip at each time, aspect ratio kept. */
export async function grabJpegs(url: string, timesMs: readonly number[], longSide: number, quality: number, filter?: string): Promise<string[]> {
  const v = await hiddenVideo(url);
  try {
    const canvas = document.createElement("canvas");
    const out: string[] = [];
    for (const t of timesMs) {
      await seekTo(v, t);
      drawFrame(v, longSide, canvas, filter);
      out.push(canvas.toDataURL("image/jpeg", quality).split(",")[1] ?? "");
    }
    return out;
  } finally {
    v.remove();
  }
}

export interface WalkOptions {
  /** Playback rate for the play-through walk — the fastest it will go. When `onFrame` is slower
   *  than one frame's worth of playback the rate drops (to 1/16 at the least) so frames aren't
   *  skipped on a slow device. */
  rate: number;
  /** Rate to start at before the speed of `onFrame` is known (default: `rate`). */
  startRate?: number;
  /** Frames per second for the seek walk (no requestVideoFrameCallback, or `forceSeek`). */
  seekFps: number;
  forceSeek?: boolean;
  signal?: AbortSignal;
  onProgress?: (share: number) => void;
}

/**
 * Visit the clip's frames from `fromMs` to `toMs`, calling `onFrame` with each frame's media time
 * while the hidden video shows it. Plays through with requestVideoFrameCallback where the browser
 * has it (every presented frame, at `rate`), else seeks at `seekFps`. Returns the clip's frame
 * rate measured on the way (null when it couldn't be measured).
 */
export async function walkFrames(
  v: HTMLVideoElement,
  fromMs: number,
  toMs: number,
  onFrame: (mediaMs: number) => void,
  opts: WalkOptions,
): Promise<number | null> {
  const span = Math.max(1, toMs - fromMs);
  const aborted = () => opts.signal?.aborted === true;
  const vr = v as WithRVFC;

  if (!opts.forceSeek && supportsFrameCallback(v)) {
    await seekTo(v, fromMs);
    const frameDurs: number[] = [];
    let spentEma = 0;
    await new Promise<void>((resolve, reject) => {
      let last: { media: number; frames: number } | null = null;
      let handle = 0;
      const finish = () => {
        v.pause();
        v.removeEventListener("ended", finish);
        if (handle && vr.cancelVideoFrameCallback) vr.cancelVideoFrameCallback(handle);
        resolve();
      };
      const onVf = (_now: number, meta: { mediaTime: number; presentedFrames: number }) => {
        if (aborted()) return finish();
        const ms = meta.mediaTime * 1000;
        if (last && meta.presentedFrames > last.frames && ms > last.media) {
          frameDurs.push((ms - last.media) / (meta.presentedFrames - last.frames));
        }
        last = { media: ms, frames: meta.presentedFrames };
        if (ms > toMs) return finish();
        const t0 = performance.now();
        try {
          onFrame(ms);
        } catch (e) {
          v.pause();
          reject(e);
          return;
        }
        // Keep up: play no faster than onFrame can handle one frame (with a little headroom).
        const spent = performance.now() - t0;
        spentEma = spentEma ? spentEma * 0.8 + spent * 0.2 : spent;
        const frameMs = frameDurs.length >= 3 ? [...frameDurs].sort((a, b) => a - b)[frameDurs.length >> 1] : 1000 / 30;
        const want = Math.max(0.0625, Math.min(opts.rate, (0.8 * frameMs) / Math.max(1, spentEma)));
        if (Math.abs(want - v.playbackRate) / v.playbackRate > 0.15) v.playbackRate = want;
        opts.onProgress?.(Math.min(1, (ms - fromMs) / span));
        handle = vr.requestVideoFrameCallback!(onVf);
      };
      v.addEventListener("ended", finish);
      handle = vr.requestVideoFrameCallback!(onVf);
      v.playbackRate = opts.startRate ?? opts.rate;
      v.play().catch((e) => {
        v.removeEventListener("ended", finish);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
    return frameRateFrom(frameDurs);
  }

  const step = 1000 / opts.seekFps;
  for (let t = fromMs; t <= toMs; t += step) {
    if (aborted()) break;
    await seekTo(v, t);
    onFrame(v.currentTime * 1000);
    opts.onProgress?.(Math.min(1, (t - fromMs) / span));
  }
  return null;
}

/** Median frame duration → fps, snapped to a common rate when within 3%. */
export function frameRateFrom(frameDursMs: readonly number[]): number | null {
  const d = frameDursMs.filter((x) => x > 1 && x < 200);
  if (d.length < 5) return null;
  const med = [...d].sort((a, b) => a - b)[Math.floor(d.length / 2)];
  const fps = 1000 / med;
  for (const c of [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 120, 240]) if (Math.abs(fps - c) / c < 0.03) return c;
  return Math.round(fps * 100) / 100;
}
