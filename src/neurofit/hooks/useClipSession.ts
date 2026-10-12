/**
 * Everything about ONE clip on the Analyze page: the player, its pose track, its saved record,
 * the reps found in it, and the two AI actions. Compare mode runs two of these side by side.
 * ----------------------------------------------------------------------------
 * The AI actions only ever fire on a click (same product rule as the live coach), and they send
 * stills, never the video:
 *  - runClip: pose pass over the in/out range (if not done yet) → reps → ≤12 key frames
 *    (analyze/keyFrames.ts) → JPEGs at LOW resolution + a payload → callFormClip.
 *  - askFrame: the paused frame + one frame either side → callFormFrame.
 * Answers are saved with the clip record, so reopening the file shows them again for free.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ANALYZE } from "../analyze/config";
import { computeJointAngles, facingScore, guessView, JOINT_LABEL, type ViewGuess } from "../analyze/jointAngles";
import { findReps, type RepFinding } from "../analyze/reps";
import { selectKeyFrames } from "../analyze/keyFrames";
import { buildClipPayload, buildFramePayload, type UserMeasurement } from "../analyze/payload";
import { drawingOpacity, measure, newDrawingId, resolvePoints } from "../analyze/annotations";
import { estimateCost, formatCost } from "../analyze/cost";
import { PointTracker, toGray } from "../analyze/pointTracker";
import type { PoseSample } from "../analyze/poseTrack";
import { callFormClip, callFormFrame, geminiEnabled, geminiKeyPresent } from "../ai/gemini";
import { FORM_CLIP_SYSTEM, FORM_FRAME_SYSTEM } from "../ai/prompts";
import { drawFrame, grabJpegs, hiddenVideo, seekTo, walkFrames } from "../components/analyze/frameWalker";
import { useClip, type ClipPlayer } from "./useClip";
import { usePoseTrack, type PoseTrackView } from "./usePoseTrack";
import { useClipRecord, type ClipRecordView } from "./useClipRecord";

export type AiStatus =
  | { kind: "idle" }
  | { kind: "working"; step: string }
  | { kind: "error"; message: string }
  | { kind: "blocked"; message: string }
  | { kind: "disabled"; reason: "no_key" | "switched_off" };

export interface ClipSession {
  player: ClipPlayer;
  pose: PoseTrackView;
  rec: ClipRecordView;
  /** The in/out range in effect (whole clip when unset). */
  range: { inMs: number; outMs: number };
  finding: RepFinding | null;
  view: ViewGuess;
  /** The pose shown now: the exact sample when paused on it, else the pass's nearest. */
  poseNow: PoseSample | null;
  poseAt: (tMs: number) => PoseSample | null;
  clipAi: AiStatus;
  frameAi: AiStatus;
  clipCost: string;
  frameCost: string;
  runClip: (filter?: string) => Promise<void>;
  askFrame: (question: string, filter?: string) => Promise<void>;
  tracking: { status: "idle" | "working" | "error"; message?: string; progress: number };
  trackPoint: (x: number, y: number, color: string) => Promise<void>;
  /** The clip is too long to analyse whole; the user must set in/out first. */
  tooLong: boolean;
}

const s1 = (ms: number) => (ms / 1000).toFixed(2);

export function useClipSession(): ClipSession {
  const player = useClip();
  const meta = player.meta;
  const src = useMemo(() => (meta ? { url: meta.url, width: meta.width, height: meta.height, durationMs: meta.durationMs } : null), [meta]);
  const pose = usePoseTrack(src);
  const rec = useClipRecord(meta?.key ?? null, meta?.name ?? "");
  const [clipAi, setClipAi] = useState<AiStatus>({ kind: "idle" });
  const [frameAi, setFrameAi] = useState<AiStatus>({ kind: "idle" });
  const [tracking, setTracking] = useState<ClipSession["tracking"]>({ status: "idle", progress: 0 });

  const range = useMemo(() => {
    const dur = meta?.durationMs ?? 0;
    const inMs = Math.max(0, Math.min(dur, rec.record.inMs ?? 0));
    const outMs = Math.max(inMs, Math.min(dur, rec.record.outMs ?? dur));
    return { inMs, outMs };
  }, [meta, rec.record.inMs, rec.record.outMs]);
  const tooLong = range.outMs - range.inMs > ANALYZE.pass.maxSeconds * 1000;

  const { setLoop, setMeasuredFps } = player;
  useEffect(() => {
    setLoop(rec.record.inMs !== null || rec.record.outMs !== null ? range : null);
  }, [setLoop, range, rec.record.inMs, rec.record.outMs]);

  // A fresh clip: read the movement straight away (short clips only) so the skeleton, trails and
  // rep markers are there without another click. No AI call is made here. Keyed on `src` alone:
  // `pose.status` still holds the PREVIOUS clip's value in this commit, so gating on it skipped
  // the pass for a second clip opened with "Change clip".
  const { run: runPass } = pose;
  useEffect(() => {
    if (!src || src.durationMs > ANALYZE.pass.maxSeconds * 1000) return;
    void runPass(0, src.durationMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    if (pose.fps) setMeasuredFps(pose.fps);
  }, [pose.fps, setMeasuredFps]);

  // Paused on a frame: run the exact (IMAGE-mode) detection on it.
  const { playing, tMs, videoRef } = player;
  const { detectExact } = pose;
  useEffect(() => {
    if (playing || !meta) return;
    const id = setTimeout(() => {
      const v = videoRef.current;
      if (v) void detectExact(v, v.currentTime * 1000);
    }, 140);
    return () => clearTimeout(id);
  }, [playing, tMs, meta, videoRef, detectExact]);

  const track = pose.track;
  const poseAt = useCallback((t: number) => track?.nearest(t, ANALYZE.pass.maxGapMs) ?? null, [track]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const poseNow = useMemo(() => poseAt(tMs), [poseAt, tMs, pose.version]);

  const finding = useMemo(() => {
    if (!track || track.length < 5) return null;
    return findReps(track, range.inMs, range.outMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, range, pose.status === "done", pose.version]);

  const view = useMemo<ViewGuess>(() => {
    if (!track) return "unknown";
    const samples = track.between(range.inMs, range.outMs);
    const stride = Math.max(1, Math.floor(samples.length / 300));
    const scores: number[] = [];
    for (let i = 0; i < samples.length; i += stride) {
      const s = facingScore(samples[i].landmarks, track.size);
      if (s !== null) scores.push(s);
    }
    return guessView(scores);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, range, pose.status === "done"]);

  // Cost estimates for the buttons (text = system prompt + a typical payload).
  const clipCost = useMemo(() => {
    const n = finding && finding.reps.length > 0 ? Math.min(ANALYZE.ai.clip.maxFrames, Math.min(3, finding.reps.length) * 4) : ANALYZE.ai.clip.evenFrames;
    const est = estimateCost({ images: n, resolution: ANALYZE.ai.clip.mediaResolution, textChars: FORM_CLIP_SYSTEM.length + 600 + n * 380, expectedOutputTokens: ANALYZE.tokens.expectedOutput.clip });
    return formatCost(est.usd);
  }, [finding]);
  const frameCost = useMemo(() => {
    const est = estimateCost({ images: 3, resolution: ANALYZE.ai.frame.mediaResolution, textChars: FORM_FRAME_SYSTEM.length + 900, expectedOutputTokens: ANALYZE.tokens.expectedOutput.frame });
    return formatCost(est.usd);
  }, []);

  const gate = (set: (s: AiStatus) => void): boolean => {
    if (geminiEnabled()) return true;
    set({ kind: "disabled", reason: geminiKeyPresent() ? "switched_off" : "no_key" });
    return false;
  };

  const runClip = useCallback(
    async (filter?: string) => {
      if (!meta || !track) return;
      if (!gate(setClipAi)) return;
      if (tooLong) {
        setClipAi({ kind: "error", message: `Set in and out marks around the part to analyse (at most ${ANALYZE.pass.maxSeconds / 60} minutes).` });
        return;
      }
      try {
        const covered = pose.analysed && pose.analysed.fromMs <= range.inMs + 1 && pose.analysed.toMs >= range.outMs - 1;
        if (!covered) {
          setClipAi({ kind: "working", step: "Reading your movement" });
          const ok = await pose.run(range.inMs, range.outMs);
          if (!ok) {
            setClipAi({ kind: "error", message: "Couldn't read the movement in this clip." });
            return;
          }
        }
        setClipAi({ kind: "working", step: "Picking the key frames" });
        const f = findReps(track, range.inMs, range.outMs);
        const keys = selectKeyFrames(f.reps, range.inMs, range.outMs);
        const frames = keys.map((key) => {
          const s = track.nearest(key.tMs, ANALYZE.pass.maxGapMs);
          return { key, angles: s ? computeJointAngles(s.landmarks, track.size) : null };
        });
        const times = keys.map((k) => k.tMs);
        const images = await grabJpegs(meta.url, times, ANALYZE.ai.jpeg.longSide, ANALYZE.ai.jpeg.quality, filter);
        const inRange = track.between(range.inMs, range.outMs);
        const payload = buildClipPayload({
          clip: { durationMs: meta.durationMs, width: meta.width, height: meta.height },
          fromMs: range.inMs,
          toMs: range.outMs,
          exerciseHint: rec.record.exerciseHint,
          userNote: null,
          view,
          poseFoundShare: pose.foundShare ?? (inRange.length > 0 ? 1 : null),
          finding: f,
          frames,
        });
        setClipAi({ kind: "working", step: `Coach is looking at ${images.length} frames` });
        const out = await callFormClip(payload, images, times);
        if (out.kind === "ok") {
          rec.set((r) => ({ ...r, clipAi: { result: out.result, frameTimesMs: times, createdAtMs: Date.now(), exerciseHint: r.exerciseHint } }));
          setClipAi({ kind: "idle" });
        } else if (out.kind === "disabled") gate(setClipAi);
        else setClipAi(out.kind === "blocked" ? { kind: "blocked", message: out.message } : { kind: "error", message: out.message });
      } catch (e) {
        setClipAi({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meta, track, tooLong, pose, range, rec, view],
  );

  const askFrame = useCallback(
    async (question: string, filter?: string) => {
      const v = videoRef.current;
      if (!meta || !track || !v) return;
      if (!gate(setFrameAi)) return;
      try {
        v.pause();
        const main = v.currentTime * 1000;
        setFrameAi({ kind: "working", step: "Reading this frame" });
        await pose.detectExact(v, main);
        const sample = track.nearest(main, 40);
        const angles = sample ? computeJointAngles(sample.landmarks, track.size) : null;
        const off = ANALYZE.ai.frame.neighbourOffsetMs;
        const times = [Math.max(0, main - off), main, Math.min(meta.durationMs - 1, main + off)].filter((t, i, a) => i === 0 || t > a[i - 1]);
        // The user's own measurements on this frame go along as context.
        const measurements: UserMeasurement[] = [];
        for (const d of rec.record.drawings) {
          if (drawingOpacity(d, main) < 0.5) continue;
          const { pts } = resolvePoints(d, sample?.landmarks ?? null, track.size);
          const m = measure(d, pts, rec.record.calibration);
          if (m.kind === "none") continue;
          const mid = d.pts[1];
          const what =
            m.kind === "angle"
              ? mid?.kind === "joint"
                ? `an angle you drew at the ${JOINT_LABEL[mid.index]?.toLowerCase() ?? "joint"}`
                : "an angle you drew"
              : m.kind === "length"
                ? `a distance you measured${rec.record.calibration ? "" : " (in image pixels)"}`
                : "a line you drew";
          measurements.push({ kind: m.kind === "length" ? "length" : m.kind === "angle" ? "angle" : "line", what: d.text ? `${what} (“${d.text}”)` : what, value: m.text });
        }
        const images = await grabJpegs(meta.url, times, ANALYZE.ai.jpeg.longSide, ANALYZE.ai.jpeg.quality, filter);
        const frameView = sample ? guessView([facingScore(sample.landmarks, track.size) ?? NaN].filter(Number.isFinite)) : "unknown";
        const payload = buildFramePayload({
          clip: { durationMs: meta.durationMs, width: meta.width, height: meta.height },
          mainMs: main,
          imageTimesMs: times,
          exerciseHint: rec.record.exerciseHint,
          question,
          view: view !== "unknown" ? view : frameView,
          angles,
          reps: finding?.reps ?? [],
          measurements,
        });
        setFrameAi({ kind: "working", step: "Coach is looking at the frame" });
        const out = await callFormFrame(payload, images, times);
        if (out.kind === "ok") {
          rec.set((r) => ({
            ...r,
            frameAi: [...r.frameAi.filter((x) => !(Math.abs(x.tMs - main) < 1 && x.question === question.trim())), { tMs: main, question: question.trim(), result: out.result, frameTimesMs: times, createdAtMs: Date.now() }],
          }));
          setFrameAi({ kind: "idle" });
        } else if (out.kind === "disabled") gate(setFrameAi);
        else setFrameAi(out.kind === "blocked" ? { kind: "blocked", message: out.message } : { kind: "error", message: out.message });
      } catch (e) {
        setFrameAi({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meta, track, pose, rec, view, finding, videoRef],
  );

  const trackPoint = useCallback(
    async (x: number, y: number, color: string) => {
      if (!meta) return;
      const start = player.videoRef.current ? player.videoRef.current.currentTime * 1000 : tMs;
      const end = range.outMs > start ? range.outMs : meta.durationMs;
      setTracking({ status: "working", progress: 0 });
      let v: HTMLVideoElement | null = null;
      try {
        v = await hiddenVideo(meta.url);
        const long = ANALYZE.tracker.longSide;
        const k = Math.min(1, long / Math.max(meta.width, meta.height));
        const canvas = document.createElement("canvas");
        const gray = () => {
          drawFrame(v!, long, canvas);
          const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
          return toGray(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
        };
        await seekTo(v, start);
        const tracker = PointTracker.start(gray(), x * k, y * k);
        if (!tracker) {
          setTracking({ status: "error", progress: 0, message: "Nothing distinct to follow there. Pick a spot with clear edges, like the end of the bar or a plate rim." });
          return;
        }
        const points = [{ tMs: start, x, y }];
        const ac = new AbortController();
        await walkFrames(
          v,
          start,
          end,
          (ms) => {
            if (ms <= points[points.length - 1].tMs) return;
            const hit = tracker.step(gray());
            if (!hit) return ac.abort();
            points.push({ tMs: ms, x: Math.round((hit.x / k) * 10) / 10, y: Math.round((hit.y / k) * 10) / 10 });
          },
          { rate: ANALYZE.pass.playbackRate, seekFps: 30, signal: ac.signal, onProgress: (p) => setTracking({ status: "working", progress: p }) },
        );
        if (points.length < 2) {
          setTracking({ status: "error", progress: 0, message: "Lost the point straight away. Try a spot with more contrast." });
          return;
        }
        rec.edit((r) => ({ ...r, tracks: [...r.tracks, { id: newDrawingId(), color, label: `Point ${r.tracks.length + 1}`, points }] }));
        const lostEarly = points[points.length - 1].tMs < end - 200;
        setTracking(
          lostEarly
            ? { status: "error", progress: 1, message: `Followed it to ${s1(points[points.length - 1].tMs)} s, then lost it (blur or something in front). The path stops there.` }
            : { status: "idle", progress: 1 },
        );
      } catch (e) {
        setTracking({ status: "error", progress: 0, message: e instanceof Error ? e.message : String(e) });
      } finally {
        v?.remove();
      }
    },
    [meta, player.videoRef, tMs, range, rec],
  );

  return { player, pose, rec, range, finding, view, poseNow, poseAt, clipAi, frameAi, clipCost, frameCost, runClip, askFrame, tracking, trackPoint, tooLong };
}
