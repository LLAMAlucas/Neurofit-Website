/**
 * Per-set pull-up engine. PURE module (no React, no DOM, no timers).
 * ----------------------------------------------------------------------------
 * Same shape as pushup/session.ts: rep tracking, warm-up baselines, rep finalization, counting,
 * triggers and the Tier-2 reliability flag all live here so the whole path is unit-testable in
 * Node. The hook only feeds frames in and acts on the returned events.
 *
 * Invariants carried over from the squat (see CLAUDE.md):
 *   - No trigger fires during warm-up reps 1–2; each trigger fires at most once per rep.
 *   - Every BaselineTracker.record() is gated on `rep.index <= baselineReps` AND the hygiene gate.
 *   - `triggeredMetrics` is snapshotted from the TRIGGER layer, never from metric warns.
 *   - Frontal geometry is only read on front sets, sagittal only on side sets.
 * Pull-up specifics:
 *   - The BAR LINE is a per-set median of the grip knuckles while hanging (the bar never moves),
 *     reset whenever the tracker sees the grip move up to a new bar height.
 *   - Swing and leg samples include the last `preArmWindowMs` before the attempt armed: a kip's
 *     back-swing happens in the hang, before the shoulders have risen far enough to arm.
 *   - Every trigger is a whole-rep quantity, evaluated when the attempt closes; its archived frame
 *     is the moment of the peak (widest swing, biggest leg change, worst tilt, mid-drop).
 */
import { BaselineTracker } from "../squat/dynamics";
import { VelocityTracker, type VelocitySample } from "../squat/velocity";
import {
  evalPullupEccentric,
  evaluatePullupRep,
  evenTriggerActive,
  judgeExtension,
  judgeTop,
  legDriveTriggerActive,
  pullupDescentSpeed,
  pullupLandmarkImplausible,
  pullupRepCounts,
  pullupRepFeedsBaseline,
  pullupSeverityFor,
  sampleRange,
  swingTrigger,
  type ExtensionVerdict,
  type PullupMiss,
  type TopVerdict,
  type TriggerBasis,
} from "./checks";
import { PULLUP, PULLUP_FACE, PULLUP_PLAUSIBLE, PULLUP_TRIGGERS, type PullupGrip, type PullupTopPreset } from "./config";
import { barSampleY, pullupVisibilityIndices, type PullupFrame } from "./frame";
import type { Orientation, PullupMetricId, PullupRepMetrics } from "./metrics";
import { PullupRepTracker, type PullupEnd, type PullupRep } from "./repCounter";

/** Archive/payload fault vocabulary (one peak frame per type per set). */
export const PULLUP_FAULT_TYPES = ["body_swing", "leg_drive", "eccentric_control", "uneven_pull"] as const;
export type PullupFaultType = (typeof PULLUP_FAULT_TYPES)[number];

export interface PullupTriggerFire {
  metric: PullupMetricId;
  faultType: PullupFaultType;
  repIndex: number;
  /** Peak instant (ms, performance clock) — the frame to tag and archive. */
  timestampMs: number;
  /** Severity in the fault's own units. Higher = worse for every pull-up fault. */
  severity: number;
}

export interface PullupBaselines {
  /** SAGITTAL — warm-up swing range (deg). */
  swingRangeDeg: number | null;
  descentVelocity: number | null;
  /** FRONTAL — warm-up worst shoulder-vs-hand tilt (deg). */
  shoulderTiltDiffDeg: number | null;
  visibility: number | null;
}

export interface PullupRepRecord {
  index: number;
  metrics: PullupRepMetrics;
  velocity: VelocitySample | null;
  counted: boolean;
  misses: PullupMiss[];
  top: TopVerdict;
  extension: ExtensionVerdict;
  /** Pull ratio of the hang the attempt started from, of its peak, and where it closed. */
  startRatio: number;
  peakRatio: number;
  endRatio: number;
  endedBy: PullupEnd;
  /** Highest filtered chin clearance (fraction of hang height, + = chin above the bar), or null. */
  peakChinClearance: number | null;
  /** 2D elbow angle at the start of the attempt (deg). Agnostic but projection-lenient. */
  startElbowDeg: number | null;
  // --- sagittal (null on front sets) ---
  swingRangeDeg: number | null;
  /** How U1 fired this rep, if it did. */
  swingFire: TriggerBasis | null;
  hipRangeDeg: number | null;
  kneeRangeDeg: number | null;
  /** max(hip, knee) range — the U3 number. */
  legRangeDeg: number | null;
  // --- frontal (null on side sets) ---
  tiltPeakDeg: number | null;
  gripWidthRatio: number | null;
  // --- agnostic ---
  descentSpeed: number | null;
  /** Descent speed ÷ the warm-up baseline in force for this rep. */
  descentMultiple: number | null;
  /** Every trigger that fired this rep (swing / legDrive / eccentricControl / evenness). */
  triggeredMetrics: PullupMetricId[];
  landmarkUnreliable: boolean;
  minVisibility: number | null;
  /** Passed the hygiene gate (whether or not it was inside the warm-up window). */
  fedBaseline: boolean;
  /** Baselines in effect when this rep was judged (read BEFORE it folded in). */
  baselines: PullupBaselines;
  timing: { startMs: number; topMs: number; endMs: number; concentricMs: number; eccentricMs: number };
}

export interface PullupSetRecord {
  exercise: "pullup";
  index: number;
  orientation: Orientation;
  facingAngleDeg: number | null;
  topPreset: PullupTopPreset;
  grip: PullupGrip;
  reps: PullupRepRecord[];
  /** Resolved warm-up baselines — the same values every scored rep was checked against. */
  baselines: PullupBaselines;
}

export interface PullupFrameEvents {
  armed: boolean;
  completed: PullupRepRecord[];
  fired: PullupTriggerFire[];
  /** TOP instants (ms) of warm-up reps closed this frame — archive their key frames. The top is
   *  where a pull-up is judged (chin vs bar, shoulders), so it is the baseline photo. */
  baselineFrameTs: number[];
}

export type LandmarkWindowFn = (startMs: number, endMs: number) => { landmarks: Record<number, { visibility: number }> }[];

export interface PullupSessionOptions {
  setIndex: number;
  orientation: Orientation;
  topPreset: PullupTopPreset;
  grip: PullupGrip;
  getLandmarkWindow?: LandmarkWindowFn;
}

interface TimedValue {
  tMs: number;
  v: number;
}

interface IdleSample {
  tMs: number;
  swing: number | null;
  hip: number | null;
  knee: number | null;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The sample farthest from the samples' median — the moment a range was at its widest. */
function peakMoment(samples: TimedValue[]): number | null {
  const mid = median(samples.map((s) => s.v));
  if (mid === null) return null;
  let best = samples[0];
  for (const s of samples) if (Math.abs(s.v - mid) > Math.abs(best.v - mid)) best = s;
  return best.tMs;
}

export class PullupSetSession {
  readonly tracker: PullupRepTracker;
  readonly velocity: VelocityTracker;

  private readonly records: PullupRepRecord[] = [];
  private readonly swingBase = new BaselineTracker(PULLUP_TRIGGERS.baselineReps);
  private readonly descentBase = new BaselineTracker(PULLUP_TRIGGERS.baselineReps);
  private readonly levelBase = new BaselineTracker(PULLUP_TRIGGERS.baselineReps);
  private readonly visBase = new BaselineTracker(PULLUP_TRIGGERS.baselineReps);
  private readonly moments = new Map<string, PullupTriggerFire>();

  private facingAngleDeg: number | null = null;
  private pending: PullupFrameEvents | null = null;

  // Bar line + idle history.
  private barSamples: number[] = [];
  private gripEpoch = 0;
  private idle: IdleSample[] = [];
  /** Chin clearance of the latest frame (live readout only). */
  private liveClearance: number | null = null;

  // Per-attempt accumulators (reset when an attempt arms or closes).
  private swing: TimedValue[] = [];
  private hip: TimedValue[] = [];
  private knee: TimedValue[] = [];
  private tiltPeak: number | null = null;
  private tiltPeakMs = 0;
  private clearWin: TimedValue[] = [];
  private clearPeak: number | null = null;
  private clearCount = 0;
  private descentTs: number[] = [];
  private descentYs: number[] = [];

  constructor(private readonly opts: PullupSessionOptions) {
    this.tracker = new PullupRepTracker(PULLUP, (rep) => this.onRepComplete(rep));
    this.velocity = new VelocityTracker(PULLUP, opts.orientation);
  }

  get orientation(): Orientation {
    return this.opts.orientation;
  }

  /** Feed one active-phase frame. `t` is seconds (performance clock). */
  onFrame(frame: PullupFrame, t: number, facingAngleDeg: number | null): PullupFrameEvents {
    const events: PullupFrameEvents = { armed: false, completed: [], fired: [], baselineFrameTs: [] };
    this.pending = events;
    this.facingAngleDeg = facingAngleDeg;
    this.liveClearance = this.clearance(frame);
    const wasDown = this.tracker.isDown;
    if (wasDown) this.observe(frame, t);
    this.tracker.update(frame); // may close an attempt → onRepComplete (and re-arm on a partial)
    if (!this.tracker.isDown) this.observeIdle(frame, t);
    if (this.tracker.isDown && !wasDown) {
      this.resetRep();
      this.seedFromIdle(t * 1000);
      events.armed = true;
      this.observe(frame, t);
    }
    this.pending = null;
    return events;
  }

  reps(): PullupRepRecord[] {
    return this.records;
  }

  /** Live FORM CHECKS: the last closed attempt's verdicts (every pull-up check is whole-rep). */
  liveMetrics(): PullupRepMetrics | null {
    return this.records.length ? this.records[this.records.length - 1].metrics : null;
  }

  /** Latest chin clearance vs the bar line (fraction of hang height), for the live readout. */
  liveChinClearance(): number | null {
    return this.liveClearance;
  }

  /** The per-set bar line (image y), or null before the lifter has hung from it. */
  barLineY(): number | null {
    return median(this.barSamples);
  }

  momentFor(repIndex: number, metric: PullupMetricId): PullupTriggerFire | undefined {
    return this.moments.get(`${repIndex}:${metric}`);
  }

  baselineSnapshot(): PullupBaselines {
    return {
      swingRangeDeg: this.swingBase.baseline(),
      descentVelocity: this.descentBase.baseline(),
      shoulderTiltDiffDeg: this.levelBase.baseline(),
      visibility: this.visBase.baseline(),
    };
  }

  toSetRecord(facingAngleDeg: number | null): PullupSetRecord {
    return {
      exercise: "pullup",
      index: this.opts.setIndex,
      orientation: this.opts.orientation,
      facingAngleDeg,
      topPreset: this.opts.topPreset,
      grip: this.opts.grip,
      reps: [...this.records],
      baselines: this.baselineSnapshot(),
    };
  }

  private clearance(frame: PullupFrame): number | null {
    const bar = this.barLineY();
    const hDown = this.tracker.hangHeight;
    if (frame.chinY === null || bar === null || hDown === null || hDown <= 1e-6) return null;
    return (bar - frame.chinY) / hDown;
  }

  private fire(f: PullupTriggerFire): void {
    const key = `${f.repIndex}:${f.metric}`;
    if (!this.moments.has(key)) this.moments.set(key, f);
    this.pending?.fired.push(f);
  }

  private resetRep(): void {
    this.swing = [];
    this.hip = [];
    this.knee = [];
    this.tiltPeak = null;
    this.tiltPeakMs = 0;
    this.clearWin = [];
    this.clearPeak = null;
    this.clearCount = 0;
    this.descentTs = [];
    this.descentYs = [];
  }

  /** Between attempts: sample the bar line while hanging, and keep a short sagittal history. */
  private observeIdle(frame: PullupFrame, t: number): void {
    if (this.tracker.gripEpoch !== this.gripEpoch) {
      this.gripEpoch = this.tracker.gripEpoch;
      this.barSamples = [];
    }
    if (this.tracker.onBar) {
      const y = barSampleY(frame);
      if (y !== null) {
        this.barSamples.push(y);
        if (this.barSamples.length > PULLUP_FACE.barSamples) this.barSamples.shift();
      }
    }
    if (this.opts.orientation !== "side") return;
    const tMs = t * 1000;
    this.idle.push({ tMs, swing: frame.swingDeg, hip: frame.hipAngleDeg, knee: frame.kneeAngleDeg });
    while (this.idle.length && this.idle[0].tMs < tMs - PULLUP.preArmWindowMs) this.idle.shift();
  }

  /** Fold the hang just before the attempt armed into its swing / leg samples. */
  private seedFromIdle(armMs: number): void {
    for (const s of this.idle) {
      if (s.tMs < armMs - PULLUP.preArmWindowMs) continue;
      this.addSagittal(s.tMs, s.swing, s.hip, s.knee);
    }
    this.idle = [];
  }

  private addSagittal(tMs: number, swing: number | null, hip: number | null, knee: number | null): void {
    if (swing !== null && Math.abs(swing) <= PULLUP_PLAUSIBLE.swingMaxDeg) this.swing.push({ tMs, v: swing });
    if (hip !== null) this.hip.push({ tMs, v: hip });
    if (knee !== null) this.knee.push({ tMs, v: knee });
  }

  /** Per attempt frame: sagittal samples (side), worst tilt (front), chin clearance, descent. */
  private observe(frame: PullupFrame, t: number): void {
    const tMs = t * 1000;
    if (this.opts.orientation === "side") {
      this.addSagittal(tMs, frame.swingDeg, frame.hipAngleDeg, frame.kneeAngleDeg);
    } else {
      const tilt = frame.shoulderTiltDiffDeg;
      if (this.tracker.pullRatio >= PULLUP_TRIGGERS.evenness.ratioGate && tilt !== null && tilt <= PULLUP_PLAUSIBLE.shoulderTiltDiffMaxDeg) {
        if (this.tiltPeak === null || tilt > this.tiltPeak) {
          this.tiltPeak = tilt;
          this.tiltPeakMs = tMs;
        }
      }
    }
    const c = this.clearance(frame);
    if (c !== null) {
      // Same spike filter as h: one frame of a jumped mouth landmark must not credit a rep.
      this.clearWin.push({ tMs, v: c });
      while (this.clearWin.length > 1 && this.clearWin[0].tMs < tMs - PULLUP.spikeFilterMs) this.clearWin.shift();
      const filtered = median(this.clearWin.map((s) => s.v)) as number;
      this.clearCount += 1;
      if (this.clearPeak === null || filtered > this.clearPeak) this.clearPeak = filtered;
    }
    if (frame.shoulder) {
      this.descentTs.push(tMs);
      this.descentYs.push(frame.shoulder[1]);
    }
  }

  private onRepComplete(rep: PullupRep): void {
    const o = this.opts.orientation;
    const side = o === "side";
    const sample = this.velocity.add(rep.index, rep.concentricVelocity, {
      concentricSec: rep.concentricSec,
      eccentricSec: rep.eccentricSec,
    });
    const warmedUp = rep.index > PULLUP_TRIGGERS.baselineReps;
    // Baselines IN EFFECT for this rep — read before it folds in.
    const baselines = this.baselineSnapshot();

    const peakChinClearance = this.clearCount >= 2 ? this.clearPeak : null;
    const top = judgeTop(peakChinClearance, rep.peakRatio, this.opts.topPreset);
    const extension = judgeExtension(rep.start.elbowAngleDeg, rep.startRatio);
    const { counted, misses } = pullupRepCounts(extension, top);

    const swingRangeDeg = side ? sampleRange(this.swing.map((s) => s.v)) : null;
    const hipRangeDeg = side ? sampleRange(this.hip.map((s) => s.v)) : null;
    const kneeRangeDeg = side ? sampleRange(this.knee.map((s) => s.v)) : null;
    const legRanges = [hipRangeDeg, kneeRangeDeg].filter((v): v is number => v !== null);
    const legRangeDeg = legRanges.length ? Math.max(...legRanges) : null;
    const tiltPeakDeg = side ? null : this.tiltPeak;

    const descentSpeed = pullupDescentSpeed(this.descentTs, this.descentYs);
    const descentMultiple =
      descentSpeed !== null && baselines.descentVelocity !== null && baselines.descentVelocity > 0 ? descentSpeed / baselines.descentVelocity : null;

    const metrics = evaluatePullupRep({
      orientation: o,
      facingAngleDeg: this.facingAngleDeg,
      top,
      extension,
      swingRangeDeg,
      legRangeDeg,
      tiltPeakDeg,
      velocity: { measured: sample.velocity > 0, degraded: sample.degraded, ratio: sample.ratio },
    });

    const fired = new Set<PullupMetricId>();
    const fire = (metric: PullupMetricId, faultType: PullupFaultType, timestampMs: number, severity: number) => {
      fired.add(metric);
      this.fire({ metric, faultType, repIndex: rep.index, timestampMs, severity });
    };

    if (warmedUp) {
      const ecc = evalPullupEccentric(descentSpeed, baselines.descentVelocity);
      metrics.eccentricControl = { ...ecc, severity: pullupSeverityFor("eccentricControl", ecc.status, ecc.value) };
      // Whole-descent speed; its representative instant is halfway down.
      if (ecc.status === "warn" && ecc.value !== null) fire("eccentricControl", "eccentric_control", (rep.topT + rep.eccentricSec / 2) * 1000, ecc.value);
    }
    const swingFire = side && warmedUp ? swingTrigger(swingRangeDeg, baselines.swingRangeDeg) : null;
    if (swingFire && swingRangeDeg !== null) fire("swing", "body_swing", peakMoment(this.swing) ?? rep.topT * 1000, swingRangeDeg);
    if (side && warmedUp && legDriveTriggerActive(legRangeDeg) && legRangeDeg !== null) {
      const legSamples = (hipRangeDeg ?? -1) >= (kneeRangeDeg ?? -1) ? this.hip : this.knee;
      fire("legDrive", "leg_drive", peakMoment(legSamples) ?? rep.topT * 1000, legRangeDeg);
    }
    if (!side && warmedUp && evenTriggerActive(tiltPeakDeg, baselines.shoulderTiltDiffDeg) && tiltPeakDeg !== null) {
      fire("evenness", "uneven_pull", this.tiltPeakMs, tiltPeakDeg);
    }

    // Warm-up calibration: hygiene gate AND the warm-up window (see header).
    const fedBaseline = pullupRepFeedsBaseline(extension, rep.peakRatio);
    const calibrates = fedBaseline && rep.index <= PULLUP_TRIGGERS.baselineReps;
    if (calibrates && side && swingRangeDeg !== null) this.swingBase.record(swingRangeDeg);
    if (calibrates && descentSpeed !== null) this.descentBase.record(descentSpeed);
    if (calibrates && !side && tiltPeakDeg !== null) this.levelBase.record(tiltPeakDeg);

    // Tier-2 reliability: arm chain visibility vs the warm-up, plus impossible frontal geometry.
    const window = this.opts.getLandmarkWindow?.(rep.startT * 1000, rep.endT * 1000) ?? [];
    const idx = pullupVisibilityIndices(o, rep.top.nearSide);
    let minVisibility: number | null = null;
    for (const s of window) {
      for (const i of idx) {
        const v = s.landmarks[i]?.visibility;
        if (v !== undefined && (minVisibility === null || v < minVisibility)) minVisibility = v;
      }
    }
    const landmarkUnreliable =
      (baselines.visibility !== null && minVisibility !== null && minVisibility < baselines.visibility * PULLUP_TRIGGERS.visDropRatio) ||
      pullupLandmarkImplausible(rep.top, o) ||
      pullupLandmarkImplausible(rep.start, o);
    if (calibrates && minVisibility !== null) this.visBase.record(minVisibility);

    const record: PullupRepRecord = {
      index: rep.index,
      metrics,
      velocity: sample,
      counted,
      misses,
      top,
      extension,
      startRatio: rep.startRatio,
      peakRatio: rep.peakRatio,
      endRatio: rep.endRatio,
      endedBy: rep.endedBy,
      peakChinClearance,
      startElbowDeg: rep.start.elbowAngleDeg,
      swingRangeDeg,
      swingFire,
      hipRangeDeg,
      kneeRangeDeg,
      legRangeDeg,
      tiltPeakDeg,
      gripWidthRatio: side ? null : rep.start.gripWidthRatio,
      descentSpeed,
      descentMultiple,
      triggeredMetrics: [...fired],
      landmarkUnreliable,
      minVisibility,
      fedBaseline,
      baselines,
      timing: {
        startMs: rep.startT * 1000,
        topMs: rep.topT * 1000,
        endMs: rep.endT * 1000,
        concentricMs: rep.concentricSec * 1000,
        eccentricMs: rep.eccentricSec * 1000,
      },
    };
    this.records.push(record);
    this.pending?.completed.push(record);
    if (rep.index <= PULLUP_TRIGGERS.baselineReps) this.pending?.baselineFrameTs.push(rep.topT * 1000);
    this.resetRep();
  }
}
