/**
 * Generic rep finder for any exercise. PURE module.
 * ----------------------------------------------------------------------------
 * The live coach counts reps with exercise-specific geometry (hip drop, shoulder drop, chin over
 * bar). A clip can be ANY exercise, so this finds cycles in whichever joint angle swings the most:
 * knee for a squat or lunge, hip for a deadlift or swing, elbow for a press, curl, push-up or
 * pull-up. All four drive joints are in degrees, so their ranges compare directly.
 *
 * It only says WHERE the cycles are, so the AI gets the right frames and the timeline gets
 * markers. It is not a counted rep and never a fault — no depth gate, no lockout gate.
 * ⚠️ Thresholds in ANALYZE.reps are UNVALIDATED (n=0).
 */
import { ANALYZE } from "./config";
import { DRIVE_JOINTS, computeJointAngles, pairedAngle, type DriveJoint } from "./jointAngles";
import { percentile, smoothSeries, type PoseTrack, type SeriesPoint } from "./poseTrack";

export interface FoundRep {
  /** 1-based. */
  index: number;
  /** Left the rest position. */
  startMs: number;
  /** Halfway out. */
  midOutMs: number;
  /** The far end of the movement (bottom of a squat, top of a curl). */
  turnMs: number;
  /** Halfway back. */
  midBackMs: number;
  /** Back at rest. */
  endMs: number;
  /** Drive-angle value at rest and at the turnaround (degrees). */
  restDeg: number;
  turnDeg: number;
}

export interface RepFinding {
  /** null when no joint swung far enough to call it reps. */
  joint: DriveJoint | null;
  /** p90 − p10 of each drive joint's angle over the range (degrees), null if never seen. */
  ranges: Record<DriveJoint, number | null>;
  reps: FoundRep[];
}

type Cfg = typeof ANALYZE.reps;

/**
 * Cycles in one series. The rest side is the extreme the clip STARTS nearer (a squat starts
 * standing — knee open; a deadlift starts at the floor — hip closed). A rep leaves the rest band,
 * must commit past the midpoint, turns, and comes back into the band.
 */
export function findCycles(raw: readonly SeriesPoint[], cfg: Cfg = ANALYZE.reps): Omit<FoundRep, "index">[] {
  if (raw.length < 5) return [];
  const s = smoothSeries(raw, cfg.smoothMs);
  const values = s.map((p) => p.v);
  const hi = percentile(values, 90);
  const lo = percentile(values, 10);
  const range = hi - lo;
  if (!(range >= cfg.minRangeDeg)) return [];

  const t0 = s[0].tMs;
  const probe = s.filter((p) => p.tMs <= t0 + cfg.restProbeMs).map((p) => p.v);
  const startV = percentile(probe, 50);
  const restHigh = Math.abs(startV - hi) <= Math.abs(startV - lo);
  const rest = restHigh ? hi : lo;
  // Signed distance from rest toward the far side, as a share of the range.
  const away = (v: number) => (restHigh ? hi - v : v - lo) / range;

  const out: Omit<FoundRep, "index">[] = [];
  let i = 0;
  while (i < s.length) {
    // Wait at rest.
    while (i < s.length && away(s[i].v) > cfg.leaveFrac) i++;
    while (i < s.length && away(s[i].v) <= cfg.leaveFrac) i++;
    if (i >= s.length) break;
    const start = i - 1 >= 0 ? i - 1 : i;
    // Out, past commit, to the turnaround, and back into the rest band.
    let turn = i;
    let committed = false;
    let j = i;
    while (j < s.length && away(s[j].v) > cfg.leaveFrac) {
      if (away(s[j].v) >= cfg.commitFrac) committed = true;
      if (away(s[j].v) > away(s[turn].v)) turn = j;
      j++;
    }
    if (j >= s.length) break; // never came back: an unfinished rep at the end of the clip
    const end = j;
    i = j;
    if (!committed) continue;
    const dur = s[end].tMs - s[start].tMs;
    if (dur < cfg.minCycleMs || dur > cfg.maxCycleMs) continue;
    const half = away(s[turn].v) / 2;
    let mo = start;
    while (mo < turn && away(s[mo].v) < half) mo++;
    let mb = turn;
    while (mb < end && away(s[mb].v) > half) mb++;
    out.push({
      startMs: s[start].tMs,
      midOutMs: s[mo].tMs,
      turnMs: s[turn].tMs,
      midBackMs: s[mb].tMs,
      endMs: s[end].tMs,
      restDeg: rest,
      turnDeg: s[turn].v,
    });
  }
  return out;
}

/** Pick the drive joint with the largest swing over [fromMs, toMs] and find its cycles. */
export function findReps(track: PoseTrack, fromMs: number, toMs: number, cfg: Cfg = ANALYZE.reps): RepFinding {
  const angles = track.between(fromMs, toMs).map((s) => ({ tMs: s.tMs, a: computeJointAngles(s.landmarks, track.size) }));
  const ranges = {} as Record<DriveJoint, number | null>;
  const series = {} as Record<DriveJoint, SeriesPoint[]>;
  for (const j of DRIVE_JOINTS) {
    const pts: SeriesPoint[] = [];
    for (const x of angles) {
      const v = pairedAngle(x.a, j);
      if (v !== null) pts.push({ tMs: x.tMs, v });
    }
    series[j] = pts;
    // A joint seen in under a third of the samples can't drive: its gaps would read as reps.
    ranges[j] = pts.length >= Math.max(5, angles.length / 3)
      ? percentile(pts.map((p) => p.v), 90) - percentile(pts.map((p) => p.v), 10)
      : null;
  }
  let best: DriveJoint | null = null;
  for (const j of DRIVE_JOINTS) {
    const r = ranges[j];
    if (r !== null && r >= cfg.minRangeDeg && (best === null || r > (ranges[best] ?? -1))) best = j;
  }
  if (!best) return { joint: null, ranges, reps: [] };
  const reps = findCycles(series[best], cfg).map((r, k) => ({ ...r, index: k + 1 }));
  return { joint: best, ranges, reps };
}
