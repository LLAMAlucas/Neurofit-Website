/**
 * The visible player for one uploaded clip: load, play, pause, step frame by frame, speed, loop.
 * ----------------------------------------------------------------------------
 * The file stays on the device: it is opened as an object URL and never uploaded.
 *
 * Frame stepping on an HTML <video> is not exact — browsers seek to a time, not a frame, and can
 * land one frame off at a boundary. Two things keep it honest: every step seeks to the CENTRE of
 * the target frame ((n + 0.5) / fps), and fps is measured from the clip (requestVideoFrameCallback
 * during the pose pass or normal playback) rather than assumed — 30 until it is known.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clipKey } from "../analyze/clipStore";
import { frameRateFrom, supportsFrameCallback } from "../components/analyze/frameWalker";

export interface ClipMeta {
  file: File;
  name: string;
  url: string;
  key: string;
  width: number;
  height: number;
  durationMs: number;
}

type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number; presentedFrames: number }) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

export const RATES = [0.1, 0.25, 0.5, 1] as const;

export interface ClipPlayer {
  videoRef: React.RefObject<HTMLVideoElement>;
  /** Spread onto the <video>. */
  videoProps: React.VideoHTMLAttributes<HTMLVideoElement> & { ref: React.RefObject<HTMLVideoElement> };
  meta: ClipMeta | null;
  loading: boolean;
  error: string | null;
  tMs: number;
  playing: boolean;
  rate: number;
  fps: number;
  fpsKnown: boolean;
  load: (file: File) => void;
  unload: () => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (ms: number) => void;
  step: (frames: number) => void;
  setRate: (r: number) => void;
  /** Frame rate measured elsewhere (the pose pass). */
  setMeasuredFps: (fps: number) => void;
  setLoop: (range: { inMs: number; outMs: number } | null) => void;
  /** Index of the frame on screen (0-based) at the current fps. */
  frameIndex: number;
}

export function useClip(): ClipPlayer {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [pending, setPending] = useState<{ file: File; url: string } | null>(null);
  const [meta, setMeta] = useState<ClipMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tMs, setTMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRateState] = useState(1);
  const [fps, setFps] = useState(30);
  const [fpsKnown, setFpsKnown] = useState(false);
  const loopRef = useRef<{ inMs: number; outMs: number } | null>(null);
  const urlRef = useRef<string | null>(null);
  const frameDurs = useRef<number[]>([]);

  const unload = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setPending(null);
    setMeta(null);
    setError(null);
    setTMs(0);
    setPlaying(false);
    setFps(30);
    setFpsKnown(false);
    frameDurs.current = [];
  }, []);

  const load = useCallback(
    (file: File) => {
      unload();
      if (!file.type.startsWith("video/") && !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name)) {
        setError("That file isn't a video.");
        return;
      }
      const url = URL.createObjectURL(file);
      urlRef.current = url;
      setPending({ file, url });
    },
    [unload],
  );

  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  const onLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (!v || !pending) return;
    if (meta && meta.url === pending.url) return;
    if (!v.videoWidth || !v.videoHeight || !Number.isFinite(v.duration)) {
      setError("This video has no picture your browser can read. Try an MP4 (H.264) export.");
      return;
    }
    const durationMs = v.duration * 1000;
    setMeta({
      file: pending.file,
      name: pending.file.name,
      url: pending.url,
      key: clipKey({ name: pending.file.name, size: pending.file.size, lastModified: pending.file.lastModified, durationMs }),
      width: v.videoWidth,
      height: v.videoHeight,
      durationMs,
    });
    setTMs(0);
  }, [pending, meta]);

  const onError = useCallback(() => {
    if (pending) setError("Your browser can't play this video. Try an MP4 (H.264) export — iPhone HEVC clips play in Safari but not everywhere.");
  }, [pending]);

  // Follow the playhead while playing: one update per presented frame.
  useEffect(() => {
    const v = videoRef.current as RVFCVideo | null;
    if (!v || !playing) return;
    let handle = 0;
    let raf = 0;
    let last: { media: number; frames: number } | null = null;
    const tick = (ms: number) => {
      const loop = loopRef.current;
      if (loop && ms >= loop.outMs - 1) {
        v.currentTime = loop.inMs / 1000;
        setTMs(loop.inMs);
        return;
      }
      setTMs(ms);
    };
    if (supportsFrameCallback(v)) {
      const onVf = (_now: number, m: { mediaTime: number; presentedFrames: number }) => {
        const ms = m.mediaTime * 1000;
        if (last && m.presentedFrames === last.frames + 1 && ms > last.media) {
          frameDurs.current.push(ms - last.media);
          if (frameDurs.current.length === 30 || frameDurs.current.length === 120) {
            const f = frameRateFrom(frameDurs.current);
            if (f) {
              setFps(f);
              setFpsKnown(true);
            }
          }
        }
        last = { media: ms, frames: m.presentedFrames };
        tick(ms);
        handle = v.requestVideoFrameCallback!(onVf);
      };
      handle = v.requestVideoFrameCallback!(onVf);
    } else {
      const loopFn = () => {
        tick(v.currentTime * 1000);
        raf = requestAnimationFrame(loopFn);
      };
      raf = requestAnimationFrame(loopFn);
    }
    return () => {
      if (handle && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(handle);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [playing]);

  const seek = useCallback(
    (ms: number) => {
      const v = videoRef.current;
      if (!v || !meta) return;
      const t = Math.max(0, Math.min(meta.durationMs, ms));
      v.currentTime = t / 1000;
      setTMs(t);
    },
    [meta],
  );

  const play = useCallback(() => {
    const v = videoRef.current;
    if (!v || !meta) return;
    const loop = loopRef.current;
    const end = loop ? loop.outMs : meta.durationMs;
    if (v.currentTime * 1000 >= end - 40) v.currentTime = (loop ? loop.inMs : 0) / 1000;
    v.playbackRate = rate;
    void v.play().catch(() => setPlaying(false));
  }, [meta, rate]);

  const pause = useCallback(() => videoRef.current?.pause(), []);
  const toggle = useCallback(() => (videoRef.current?.paused ? play() : pause()), [play, pause]);

  const step = useCallback(
    (frames: number) => {
      const v = videoRef.current;
      if (!v || !meta) return;
      v.pause();
      const dur = 1000 / fps;
      const idx = Math.floor((v.currentTime * 1000) / dur + 1e-6);
      const last = Math.max(0, Math.floor(meta.durationMs / dur) - 1);
      const target = Math.max(0, Math.min(last, idx + frames));
      seek((target + 0.5) * dur);
    },
    [fps, meta, seek],
  );

  const setRate = useCallback((r: number) => {
    setRateState(r);
    if (videoRef.current) videoRef.current.playbackRate = r;
  }, []);

  const setMeasuredFps = useCallback((f: number) => {
    setFps(f);
    setFpsKnown(true);
  }, []);

  const setLoop = useCallback((range: { inMs: number; outMs: number } | null) => {
    loopRef.current = range && range.outMs > range.inMs ? range : null;
  }, []);

  const videoProps = useMemo(
    () => ({
      ref: videoRef,
      src: pending?.url,
      muted: true,
      playsInline: true,
      preload: "auto" as const,
      onLoadedMetadata,
      onError,
      onPlay: () => setPlaying(true),
      onPause: () => {
        setPlaying(false);
        if (videoRef.current) setTMs(videoRef.current.currentTime * 1000);
      },
      onEnded: () => setPlaying(false),
      onSeeked: () => {
        if (videoRef.current && videoRef.current.paused) setTMs(videoRef.current.currentTime * 1000);
      },
    }),
    [pending, onLoadedMetadata, onError],
  );

  return {
    videoRef,
    videoProps,
    meta,
    loading: !!pending && !meta && !error,
    error,
    tMs,
    playing,
    rate,
    fps,
    fpsKnown,
    load,
    unload,
    play,
    pause,
    toggle,
    seek,
    step,
    setRate,
    setMeasuredFps,
    setLoop,
    frameIndex: Math.floor(tMs / (1000 / fps) + 1e-6),
  };
}
