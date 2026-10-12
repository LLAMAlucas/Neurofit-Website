/**
 * Which frames of a clip go to the AI. PURE module.
 * ----------------------------------------------------------------------------
 * The cost lever: the model never sees the video, only these stills (at LOW resolution), so the
 * cap here — not the clip length — bounds what one analysis costs. With reps found, it takes
 * four phases of the first, middle and last rep: start (rest), halfway out, turnaround, halfway
 * back. First vs last rep is where a change across the set shows up; the middle rep is the
 * "typical" one. Without reps it spreads frames evenly over the analysed range.
 */
import { ANALYZE } from "./config";
import type { FoundRep } from "./reps";

export type KeyPhase = "start" | "moving_out" | "turnaround" | "moving_back" | "sample";

export interface KeyFrame {
  tMs: number;
  rep: number | null;
  phase: KeyPhase;
}

/** Up to three reps: first, middle and last (deduped). */
export function pickReps(reps: readonly FoundRep[]): FoundRep[] {
  if (reps.length <= 3) return reps.slice();
  return [reps[0], reps[Math.floor((reps.length - 1) / 2)], reps[reps.length - 1]];
}

export function selectKeyFrames(
  reps: readonly FoundRep[],
  fromMs: number,
  toMs: number,
  opts: { maxFrames?: number; evenFrames?: number; minGapMs?: number } = {},
): KeyFrame[] {
  const maxFrames = opts.maxFrames ?? ANALYZE.ai.clip.maxFrames;
  const evenFrames = Math.min(opts.evenFrames ?? ANALYZE.ai.clip.evenFrames, maxFrames);
  const minGapMs = opts.minGapMs ?? 40;
  let frames: KeyFrame[] = [];

  if (reps.length > 0) {
    for (const r of pickReps(reps)) {
      frames.push(
        { tMs: r.startMs, rep: r.index, phase: "start" },
        { tMs: r.midOutMs, rep: r.index, phase: "moving_out" },
        { tMs: r.turnMs, rep: r.index, phase: "turnaround" },
        { tMs: r.midBackMs, rep: r.index, phase: "moving_back" },
      );
    }
    // A single short rep leaves budget: spend a little of it on even samples for context.
    if (frames.length < 6) frames.push(...even(fromMs, toMs, Math.min(4, maxFrames - frames.length)));
  } else {
    frames = even(fromMs, toMs, evenFrames);
  }

  frames.sort((a, b) => a.tMs - b.tMs);
  const out: KeyFrame[] = [];
  for (const f of frames) {
    const prev = out[out.length - 1];
    if (prev && f.tMs - prev.tMs < minGapMs) {
      // Same moment twice (e.g. one rep's end is the next one's start): keep the rep-labelled one.
      if (prev.phase === "sample" && f.phase !== "sample") out[out.length - 1] = f;
      continue;
    }
    out.push(f);
  }
  return out.slice(0, maxFrames);
}

function even(fromMs: number, toMs: number, n: number): KeyFrame[] {
  if (n <= 0 || !(toMs > fromMs)) return n > 0 ? [{ tMs: fromMs, rep: null, phase: "sample" }] : [];
  const step = (toMs - fromMs) / n;
  return Array.from({ length: n }, (_, i) => ({ tMs: fromMs + step * (i + 0.5), rep: null, phase: "sample" as const }));
}
