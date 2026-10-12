/**
 * Pose over an uploaded clip — the browser half of analyze/poseTrack.ts.
 * ----------------------------------------------------------------------------
 * Two ways in:
 *  - the PASS: a hidden copy of the clip plays through the in/out range (frameWalker) and every
 *    presented frame goes through a VIDEO-mode landmarker, so the skeleton, trails, reps and the
 *    AI's key frames all have data;
 *  - EXACT frames: when the user pauses, that frame goes through an IMAGE-mode landmarker (VIDEO
 *    mode needs ever-increasing timestamps and tracks from the previous call — wrong for a frame
 *    scrubbed to at random). Exact samples replace the pass's sample of the same frame.
 *
 * The two landmarkers are shared by every clip on the page (compare mode loads two) and use the
 * FULL model: a recorded clip has no live deadline. Passes run one at a time — a VIDEO-mode
 * landmarker fed two interleaved clips would track one body into the other.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import { createPoseLandmarker } from "../pose/poseLandmarker";
import type { Landmark } from "../pose/landmarks";
import { ANALYZE } from "../analyze/config";
import { PoseTrack } from "../analyze/poseTrack";
import { hiddenVideo, seekTo, walkFrames } from "../components/analyze/frameWalker";

let videoLm: Promise<PoseLandmarker> | null = null;
let imageLm: Promise<PoseLandmarker> | null = null;
/** VIDEO-mode timestamps must strictly increase for the landmarker's whole life, across passes. */
let modelClockMs = 0;
let passLock: Promise<unknown> = Promise.resolve();

function getVideoLandmarker(): Promise<PoseLandmarker> {
  if (!videoLm) videoLm = createPoseLandmarker({ runningMode: "VIDEO", model: "full" }).then((r) => r.landmarker);
  videoLm.catch(() => (videoLm = null));
  return videoLm;
}
function getImageLandmarker(): Promise<PoseLandmarker> {
  if (!imageLm) imageLm = createPoseLandmarker({ runningMode: "IMAGE", model: "full" }).then((r) => r.landmarker);
  imageLm.catch(() => (imageLm = null));
  return imageLm;
}

export type PassStatus = "idle" | "loading" | "running" | "done" | "error";

export interface ClipSource {
  url: string;
  width: number;
  height: number;
  durationMs: number;
}

export interface PoseTrackView {
  track: PoseTrack | null;
  /** Bumps whenever the track changes, so memoized readers recompute. */
  version: number;
  status: PassStatus;
  progress: number;
  error: string | null;
  /** Frame rate measured during the pass, or null. */
  fps: number | null;
  /** The range the last completed pass covered. */
  analysed: { fromMs: number; toMs: number } | null;
  /** Share of pass frames that had a body in them (0–1), or null before a pass. */
  foundShare: number | null;
  run: (fromMs: number, toMs: number) => Promise<boolean>;
  cancel: () => void;
  /** Exact detection on the visible player's current frame (call when paused). */
  detectExact: (video: HTMLVideoElement, tMs: number) => Promise<void>;
}

export function usePoseTrack(src: ClipSource | null): PoseTrackView {
  const trackRef = useRef<PoseTrack | null>(null);
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<PassStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState<number | null>(null);
  const [analysed, setAnalysed] = useState<{ fromMs: number; toMs: number } | null>(null);
  const [foundShare, setFoundShare] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const jobRef = useRef<{ fromMs: number; toMs: number; done: Promise<boolean> } | null>(null);
  const triedExact = useRef(new Set<number>());

  useEffect(() => {
    trackRef.current = src ? new PoseTrack({ width: src.width, height: src.height }) : null;
    triedExact.current.clear();
    jobRef.current = null;
    setVersion((v) => v + 1);
    setStatus("idle");
    setProgress(0);
    setError(null);
    setFps(null);
    setAnalysed(null);
    setFoundShare(null);
    return () => abortRef.current?.abort();
  }, [src]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const run = useCallback(
    async (fromMs: number, toMs: number): Promise<boolean> => {
      const track = trackRef.current;
      if (!src || !track) return false;
      // Already reading a range that covers this one: wait for it rather than starting over.
      const running = jobRef.current;
      if (running && running.fromMs <= fromMs + 1 && running.toMs >= toMs - 1) return running.done;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setError(null);
      setStatus("loading");
      setProgress(0);
      const job = passLock.then(async () => {
        if (ac.signal.aborted) return false;
        let video: HTMLVideoElement | null = null;
        try {
          const lm = await getVideoLandmarker();
          video = await hiddenVideo(src.url);
          if (ac.signal.aborted) return false;
          setStatus("running");
          let seen = 0;
          let found = 0;
          let lastBump = 0;
          let lastMedia = -Infinity;
          // A new pass jumps the clock so the landmarker drops its tracking state.
          modelClockMs += 1000;
          // Warm up on the first frame BEFORE playback starts: the first call compiles the model
          // (seconds on a slow GPU), and the hidden video would play on through it — the first
          // ~2 s of a clip came back with no pose at all.
          await seekTo(video, fromMs);
          if (ac.signal.aborted) return false;
          lm.detectForVideo(video, (modelClockMs += 33));
          const measured = await walkFrames(
            video,
            fromMs,
            toMs,
            (mediaMs) => {
              modelClockMs += Math.max(1, Number.isFinite(lastMedia) ? mediaMs - lastMedia : 33);
              lastMedia = mediaMs;
              const res = lm.detectForVideo(video!, modelClockMs);
              seen++;
              const lms = res.landmarks[0] as Landmark[] | undefined;
              if (lms && lms.length >= 33) {
                found++;
                track.add({ tMs: mediaMs, landmarks: lms.map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? 0 })) });
              }
              const now = performance.now();
              if (now - lastBump > 250) {
                lastBump = now;
                setVersion((v) => v + 1);
              }
            },
            {
              rate: ANALYZE.pass.playbackRate,
              startRate: ANALYZE.pass.startRate,
              seekFps: ANALYZE.pass.seekFps,
              signal: ac.signal,
              onProgress: (p) => setProgress(p),
            },
          );
          if (ac.signal.aborted) {
            setStatus("idle");
            return false;
          }
          if (measured) setFps(measured);
          setFoundShare(seen > 0 ? found / seen : null);
          setAnalysed({ fromMs, toMs });
          setProgress(1);
          setStatus("done");
          return true;
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus("error");
          return false;
        } finally {
          video?.remove();
          setVersion((v) => v + 1);
        }
      });
      passLock = job.catch(() => undefined);
      const entry = { fromMs, toMs, done: job };
      jobRef.current = entry;
      void job.finally(() => {
        if (jobRef.current === entry) jobRef.current = null;
      });
      return job;
    },
    [src],
  );

  const detectExact = useCallback(
    async (video: HTMLVideoElement, tMs: number) => {
      const track = trackRef.current;
      if (!track || video.readyState < 2) return;
      const key = Math.round(tMs);
      if (triedExact.current.has(key)) return;
      triedExact.current.add(key);
      try {
        const lm = await getImageLandmarker();
        // The player may have moved on while the model loaded.
        if (Math.abs(video.currentTime * 1000 - tMs) > 2 || !video.paused) {
          triedExact.current.delete(key);
          return;
        }
        const res = lm.detect(video);
        const lms = res.landmarks[0] as Landmark[] | undefined;
        if (lms && lms.length >= 33) {
          track.add({ tMs, landmarks: lms.map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility ?? 0 })), exact: true });
          setVersion((v) => v + 1);
        }
      } catch {
        triedExact.current.delete(key);
      }
    },
    [],
  );

  return { track: trackRef.current, version, status, progress, error, fps, analysed, foundShare, run, cancel, detectExact };
}
