/**
 * Per-set push-up engine. PURE module (no React, no DOM, no timers).
 * ----------------------------------------------------------------------------
 * Everything the squat keeps inline in hooks/useWorkout.ts — rep tracking, per-frame trigger
 * evaluation behind persistence gates, warm-up baselines, rep finalization, counting and the
 * Tier-2 reliability flag — lives here for push-ups, so the whole path is unit-testable in Node.
 * The hook only feeds frames in and acts on the returned events (coordinator requests, frame
 * archiving, counters, eval log).
 *
 * Invariants carried over from the squat (see CLAUDE.md):
 *   - No trigger fires during warm-up reps 1–2; each trigger fires at most once per rep.
 *   - Every BaselineTracker.record() is gated on `rep.index <= baselineReps` AND the hygiene
 *     gate — the tracker only caps the sample count, and a late rep completing a baseline once
 *     made the trigger layer and the payload describe different sets.
 *   - `triggeredMetrics` is snapshotted from the TRIGGER layer, never from metric warns.
 *   - Frontal geometry is only read on front sets, sagittal only on side sets.
 */
import { BaselineTracker, EccentricTracker, PersistenceGate } from "../squat/dynamics";
import { VelocityTracker, type VelocitySample } from "../squat/velocity";
import {
  aggregatePushupRep,
  bodyLineTrigger,
  evalPushupEccentric,
  evaluatePushupRep,
  flareTriggerActive,
  levelTriggerActive,
  observedVariant,
  pushupLandmarkImplausible,
  pushupRepCounts,
  pushupRepFeedsBaseline,
  pushupSeverityFor,
  type BodyLineSub,
  type PushupMiss,
  type TriggerBasis,
} from "./checks";
import { PUSHUP, PUSHUP_PLAUSIBLE, PUSHUP_TRIGGERS, type PushupDepthPreset, type PushupVariant } from "./config";
import { pushupVisibilityIndices, type PushupFrame } from "./frame";
import type { Orientation, PushupMetricId, PushupRepMetrics } from "./metrics";
import { PushupRepTracker, type PushupRep } from "./repCounter";

/** Archive/payload fault vocabulary (one peak frame per type per set). */
export const PUSHUP_FAULT_TYPES = ["hip_sag", "hip_pike", "eccentric_control", "elbow_flare", "uneven_press"] as const;
export type PushupFaultType = (typeof PUSHUP_FAULT_TYPES)[number];

export interface PushupTriggerFire {
  metric: PushupMetricId;
  faultType: PushupFaultType;
  repIndex: number;
  /** Onset instant (ms, performance clock) — the frame to tag and archive. */
  timestampMs: number;
  /** Severity at onset in the fault's own units. Higher = worse for every push-up fault. */
  severity: number;
}

export interface PushupBaselines {
  bodyLineDeg: number | null;
  descentVelocity: number | null;
  shoulderTiltDiffDeg: number | null;
  visibility: number | null;
}

export interface PushupRepRecord {
  index: number;
  metrics: PushupRepMetrics;
  velocity: VelocitySample | null;
  counted: boolean;
  misses: PushupMiss[];
  lockedOut: boolean;
  /** Bottom shoulder-drop ratio (agnostic). */
  depthRatio: number;
  /** Top-of-attempt ratio (≤ lockoutRatio when locked out). */
  topRatio: number;
  // --- sagittal (null on front sets) ---
  upperArmAngleDeg: number | null;
  bottomElbowAngleDeg: number | null;
  topElbowAngleDeg: number | null;
  /** Signed worst body-line deviation across the rep (+ sag / − pike). */
  bodyLinePeakDeg: number | null;
  /** Median body line across the rep (the warm-up baseline's unit). */
  bodyLineMedianDeg: number | null;
  /** How P1 fired this rep, if it did. */
  bodyLineFire: { sub: BodyLineSub; basis: TriggerBasis } | null;
  headDropDeg: number | null;
  handOffsetDeg: number | null;
  variantObserved: "toes" | "knees" | null;
  // --- frontal (null on side sets) ---
  flarePeak: number | null;
  tiltPeakDeg: number | null;
  handWidthRatio: number | null;
  // --- agnostic ---
  descentSpeed: number | null;
  /** Descent speed ÷ the warm-up baseline in force for this rep. */
  descentMultiple: number | null;
  /** Logged only — no push-up bounce threshold exists yet. */
  reversalMs: number | null;
  /** Every trigger that fired this rep (bodyLine / elbowFlare / eccentricControl / shoulderLevel). */
  triggeredMetrics: PushupMetricId[];
  landmarkUnreliable: boolean;
  minVisibility: number | null;
  /** Passed the hygiene gate (whether or not it was inside the warm-up window). */
  fedBaseline: boolean;
  /** Baselines in effect when this rep was judged (read BEFORE it folded in). */
  baselines: PushupBaselines;
  timing: { startMs: number; bottomMs: number; endMs: number; eccentricMs: number; concentricMs: number };
}

export interface PushupSetRecord {
  exercise: "pushup";
  index: number;
  orientation: Orientation;
  facingAngleDeg: number | null;
  depthPreset: PushupDepthPreset;
  variant: PushupVariant;
  reps: PushupRepRecord[];
  /** Resolved warm-up baselines — the same values every scored rep was checked against. */
  baselines: PushupBaselines;
  /** What the side camera saw during warm-up (context only); null on front sets. */
  variantObserved: "toes" | "knees" | null;
}

export interface PushupFrameEvents {
  /** An attempt armed on this frame. */
  armed: boolean;
  /** Attempts that closed on this frame (a partial-lockout close can re-arm immediately). */
  completed: PushupRepRecord[];
  /** Triggers that fired on this frame — request them from the coordinator. */
  fired: PushupTriggerFire[];
  /** Bottom instants (ms) of warm-up reps closed this frame — archive their key frames. */
  baselineFrameTs: number[];
}

export type LandmarkWindowFn = (startMs: number, endMs: number) => { landmarks: Record<number, { visibility: number }> }[];

export interface PushupSessionOptions {
  setIndex: number;
  orientation: Orientation;
  depthPreset: PushupDepthPreset;
  variant: PushupVariant;
  getLandmarkWindow?: LandmarkWindowFn;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class PushupSetSession {
  readonly tracker: PushupRepTracker;
  readonly velocity: VelocityTracker;

  private readonly records: PushupRepRecord[] = [];
  private readonly bodyLineBase = new BaselineTracker(PUSHUP_TRIGGERS.baselineReps);
  private readonly descentBase = new BaselineTracker(PUSHUP_TRIGGERS.baselineReps);
  private readonly levelBase = new BaselineTracker(PUSHUP_TRIGGERS.baselineReps);
  private readonly visBase = new BaselineTracker(PUSHUP_TRIGGERS.baselineReps);
  private readonly eccentric = new EccentricTracker();
  private readonly sagGate = new PersistenceGate(PUSHUP_TRIGGERS.persistMs);
  private readonly pikeGate = new PersistenceGate(PUSHUP_TRIGGERS.persistMs);
  private readonly flareGate = new PersistenceGate(PUSHUP_TRIGGERS.persistMs);
  private readonly moments = new Map<string, PushupTriggerFire>();
  private readonly variantSeen: ("toes" | "knees")[] = [];

  private facingAngleDeg: number | null = null;
  private pending: PushupFrameEvents | null = null;
  private latest: PushupRepMetrics | null = null;

  // Per-rep accumulators (reset when an attempt arms or closes).
  private repFrames: PushupRepMetrics[] = [];
  private firedThisRep = new Set<PushupMetricId>();
  private bodyLineFire: { sub: BodyLineSub; basis: TriggerBasis } | null = null;
  private bodyLineSamples: number[] = [];
  private bodyLinePeak: number | null = null;
  private headDropSamples: number[] = [];
  private flarePeak: number | null = null;
  private tiltPeak: number | null = null;
  private tiltPeakMs = 0;

  constructor(private readonly opts: PushupSessionOptions) {
    this.tracker = new PushupRepTracker(PUSHUP, (rep) => this.onRepComplete(rep));
    this.velocity = new VelocityTracker(PUSHUP, opts.orientation);
  }

  get orientation(): Orientation {
    return this.opts.orientation;
  }

  /** Feed one active-phase frame. `t` is seconds (performance clock). */
  onFrame(frame: PushupFrame, t: number, facingAngleDeg: number | null): PushupFrameEvents {
    const events: PushupFrameEvents = { armed: false, completed: [], fired: [], baselineFrameTs: [] };
    this.pending = events;
    this.facingAngleDeg = facingAngleDeg;
    const wasDown = this.tracker.isDown;
    if (wasDown) this.observe(frame, this.tracker.reps + 1, t);
    this.tracker.update(frame); // may close an attempt → onRepComplete
    if (this.tracker.isDown && !wasDown) {
      this.resetRep();
      events.armed = true;
      this.observe(frame, this.tracker.reps + 1, t);
    }
    this.pending = null;
    return events;
  }

  /** Records of every closed attempt this set, in order. */
  reps(): PushupRepRecord[] {
    return this.records;
  }

  /** Live FORM CHECKS: the in-progress rep's latest frame, else the last closed rep. */
  liveMetrics(): PushupRepMetrics | null {
    if (this.tracker.isDown && this.latest) return this.latest;
    return this.records.length ? this.records[this.records.length - 1].metrics : this.latest;
  }

  /** The onset moment of a trigger, for tagging + archiving its frame. */
  momentFor(repIndex: number, metric: PushupMetricId): PushupTriggerFire | undefined {
    return this.moments.get(`${repIndex}:${metric}`);
  }

  baselineSnapshot(): PushupBaselines {
    return {
      bodyLineDeg: this.bodyLineBase.baseline(),
      descentVelocity: this.descentBase.baseline(),
      shoulderTiltDiffDeg: this.levelBase.baseline(),
      visibility: this.visBase.baseline(),
    };
  }

  /** Majority of what the side camera saw across warm-up lockouts; null if unseen or split. */
  variantObserved(): "toes" | "knees" | null {
    if (!this.variantSeen.length) return null;
    const knees = this.variantSeen.filter((v) => v === "knees").length;
    const toes = this.variantSeen.length - knees;
    if (knees === toes) return null;
    return knees > toes ? "knees" : "toes";
  }

  toSetRecord(facingAngleDeg: number | null): PushupSetRecord {
    return {
      exercise: "pushup",
      index: this.opts.setIndex,
      orientation: this.opts.orientation,
      facingAngleDeg,
      depthPreset: this.opts.depthPreset,
      variant: this.opts.variant,
      reps: [...this.records],
      baselines: this.baselineSnapshot(),
      variantObserved: this.opts.orientation === "side" ? this.variantObserved() : null,
    };
  }

  private fire(f: PushupTriggerFire): void {
    this.firedThisRep.add(f.metric);
    const key = `${f.repIndex}:${f.metric}`;
    if (!this.moments.has(key)) this.moments.set(key, f);
    this.pending?.fired.push(f);
  }

  private resetRep(): void {
    this.eccentric.reset();
    this.sagGate.reset();
    this.pikeGate.reset();
    this.flareGate.reset();
    this.repFrames = [];
    this.firedThisRep = new Set();
    this.bodyLineFire = null;
    this.bodyLineSamples = [];
    this.bodyLinePeak = null;
    this.headDropSamples = [];
    this.flarePeak = null;
    this.tiltPeak = null;
    this.tiltPeakMs = 0;
  }

  /** Per armed frame: accumulate worst-of metrics, feed the descent tracker, run P1/P7. */
  private observe(frame: PushupFrame, liveRepIndex: number, t: number): void {
    const o = this.opts.orientation;
    const tMs = t * 1000;
    const depthRatio = this.tracker.depthRatio;
    const m = evaluatePushupRep({
      frame,
      orientation: o,
      facingAngleDeg: this.facingAngleDeg,
      depthPreset: this.opts.depthPreset,
      depthRatio,
      velocity: null,
      lockout: null,
    });
    this.repFrames.push(m);
    this.latest = m;
    if (frame.shoulder) this.eccentric.add(tMs, frame.shoulder[1]);
    const warmedUp = liveRepIndex > PUSHUP_TRIGGERS.baselineReps;

    if (o === "side") {
      const dev = frame.bodyLineDeg;
      if (dev !== null && Math.abs(dev) <= PUSHUP_PLAUSIBLE.bodyLineMaxDeg) {
        this.bodyLineSamples.push(dev);
        if (this.bodyLinePeak === null || Math.abs(dev) > Math.abs(this.bodyLinePeak)) this.bodyLinePeak = dev;
      }
      if (frame.headDropDeg !== null) this.headDropSamples.push(frame.headDropDeg);
      // P1 — separate gates per direction so a sag→pike swing isn't counted as persistence.
      const bl = warmedUp ? bodyLineTrigger(dev, this.bodyLineBase.baseline()) : null;
      const sagHeld = this.sagGate.update(bl?.sub === "sag", tMs);
      const pikeHeld = this.pikeGate.update(bl?.sub === "pike", tMs);
      if (bl && dev !== null && (sagHeld || pikeHeld) && !this.firedThisRep.has("bodyLine")) {
        this.bodyLineFire = bl;
        this.fire({
          metric: "bodyLine",
          faultType: bl.sub === "sag" ? "hip_sag" : "hip_pike",
          repIndex: liveRepIndex,
          timestampMs: tMs,
          severity: Math.abs(dev),
        });
      }
      return;
    }

    // Front: track the rep's worst flare / tilt inside their depth gates (descent AND ascent).
    const flare = frame.flareRatio;
    if (depthRatio >= PUSHUP_TRIGGERS.elbowFlare.depthGate && flare !== null && flare >= PUSHUP_PLAUSIBLE.flareRatio.lo && flare <= PUSHUP_PLAUSIBLE.flareRatio.hi) {
      if (this.flarePeak === null || flare > this.flarePeak) this.flarePeak = flare;
    }
    const tilt = frame.shoulderTiltDiffDeg;
    if (depthRatio >= PUSHUP_TRIGGERS.shoulderLevel.depthGate && tilt !== null && tilt <= PUSHUP_PLAUSIBLE.shoulderTiltDiffMaxDeg) {
      if (this.tiltPeak === null || tilt > this.tiltPeak) {
        this.tiltPeak = tilt;
        this.tiltPeakMs = tMs;
      }
    }
    const flareActive = warmedUp && flareTriggerActive(flare, depthRatio);
    if (this.flareGate.update(flareActive, tMs) && flare !== null && !this.firedThisRep.has("elbowFlare")) {
      this.fire({ metric: "elbowFlare", faultType: "elbow_flare", repIndex: liveRepIndex, timestampMs: tMs, severity: flare });
    }
  }

  private onRepComplete(rep: PushupRep): void {
    const o = this.opts.orientation;
    const side = o === "side";
    const sample = this.velocity.add(rep.index, rep.concentricVelocity, {
      concentricSec: rep.concentricSec,
      eccentricSec: rep.eccentricSec,
    });
    const base = evaluatePushupRep({
      frame: rep.bottom,
      orientation: o,
      facingAngleDeg: this.facingAngleDeg,
      depthPreset: this.opts.depthPreset,
      depthRatio: rep.bottomDepthRatio,
      velocity: { measured: sample.velocity > 0, degraded: sample.degraded, ratio: sample.ratio },
      lockout: { lockedOut: rep.lockedOut, topRatio: rep.topRatio },
    });
    const metrics = aggregatePushupRep(base, this.repFrames);

    const warmedUp = rep.index > PUSHUP_TRIGGERS.baselineReps;
    // Baselines IN EFFECT for this rep — read before it folds in.
    const baselines: PushupBaselines = this.baselineSnapshot();

    const bottomUpperArm = side ? rep.bottom.upperArmAngleDeg : null;
    const { counted, misses } = pushupRepCounts(o, bottomUpperArm, rep.bottomDepthRatio, rep.lockedOut, rep.topRatio, this.opts.depthPreset);

    const descentSpeed = this.eccentric.descentSpeed();
    const reversalMs = this.eccentric.reversalMs();
    const descentMultiple =
      descentSpeed !== null && baselines.descentVelocity !== null && baselines.descentVelocity > 0
        ? descentSpeed / baselines.descentVelocity
        : null;
    if (warmedUp) {
      const ecc = evalPushupEccentric(descentSpeed, baselines.descentVelocity);
      metrics.eccentricControl = { ...ecc, severity: pushupSeverityFor("eccentricControl", ecc.status, ecc.value) };
      if (ecc.status === "warn" && ecc.value !== null) {
        // Evaluated at close; its representative instant is the bottom of the descent.
        this.fire({ metric: "eccentricControl", faultType: "eccentric_control", repIndex: rep.index, timestampMs: rep.bottomT * 1000, severity: ecc.value });
      }
    }

    // P11 uneven press — post-set, baseline-relative on the rep's worst tilt past the gate.
    const levelFired = warmedUp && !side && levelTriggerActive(this.tiltPeak, baselines.shoulderTiltDiffDeg);
    if (levelFired && this.tiltPeak !== null) {
      this.fire({ metric: "shoulderLevel", faultType: "uneven_press", repIndex: rep.index, timestampMs: this.tiltPeakMs, severity: this.tiltPeak });
    }

    // Warm-up calibration: hygiene gate AND the warm-up window (see header).
    const fedBaseline = pushupRepFeedsBaseline(rep.lockedOut, rep.bottomDepthRatio);
    const calibrates = fedBaseline && rep.index <= PUSHUP_TRIGGERS.baselineReps;
    const bodyLineMedian = side ? median(this.bodyLineSamples) : null;
    if (calibrates && side && bodyLineMedian !== null) this.bodyLineBase.record(bodyLineMedian);
    if (calibrates && descentSpeed !== null) this.descentBase.record(descentSpeed);
    if (calibrates && !side && this.tiltPeak !== null) this.levelBase.record(this.tiltPeak);

    // Tier-2 reliability: near-chain (side) / arms+shoulders (front) visibility vs the warm-up.
    const window = this.opts.getLandmarkWindow?.(rep.startT * 1000, rep.endT * 1000) ?? [];
    const idx = pushupVisibilityIndices(o, rep.bottom.nearSide);
    let minVisibility: number | null = null;
    for (const s of window) {
      for (const i of idx) {
        const v = s.landmarks[i]?.visibility;
        if (v !== undefined && (minVisibility === null || v < minVisibility)) minVisibility = v;
      }
    }
    const landmarkUnreliable =
      (baselines.visibility !== null && minVisibility !== null && minVisibility < baselines.visibility * PUSHUP_TRIGGERS.visDropRatio) ||
      pushupLandmarkImplausible(rep.bottom, o);
    if (calibrates && minVisibility !== null) this.visBase.record(minVisibility);

    const variantObserved =
      side && rep.index <= PUSHUP_TRIGGERS.baselineReps && rep.lockedOut
        ? observedVariant(rep.top.kneeAngleDeg, rep.top.kneeHeightArms)
        : null;
    if (variantObserved) this.variantSeen.push(variantObserved);

    const record: PushupRepRecord = {
      index: rep.index,
      metrics,
      velocity: sample,
      counted,
      misses,
      lockedOut: rep.lockedOut,
      depthRatio: rep.bottomDepthRatio,
      topRatio: rep.topRatio,
      upperArmAngleDeg: bottomUpperArm,
      bottomElbowAngleDeg: side ? rep.bottom.elbowAngleDeg : null,
      topElbowAngleDeg: side ? rep.top.elbowAngleDeg : null,
      bodyLinePeakDeg: side ? this.bodyLinePeak : null,
      bodyLineMedianDeg: bodyLineMedian,
      bodyLineFire: side ? this.bodyLineFire : null,
      headDropDeg: side ? median(this.headDropSamples) : null,
      handOffsetDeg: side ? rep.top.handOffsetDeg : null,
      variantObserved,
      flarePeak: side ? null : this.flarePeak,
      tiltPeakDeg: side ? null : this.tiltPeak,
      handWidthRatio: side ? null : rep.bottom.handWidthRatio,
      descentSpeed,
      descentMultiple,
      reversalMs,
      triggeredMetrics: [...this.firedThisRep],
      landmarkUnreliable,
      minVisibility,
      fedBaseline,
      baselines,
      timing: {
        startMs: rep.startT * 1000,
        bottomMs: rep.bottomT * 1000,
        endMs: rep.endT * 1000,
        eccentricMs: rep.eccentricSec * 1000,
        concentricMs: rep.concentricSec * 1000,
      },
    };
    this.records.push(record);
    this.pending?.completed.push(record);
    if (rep.index <= PUSHUP_TRIGGERS.baselineReps) this.pending?.baselineFrameTs.push(rep.bottomT * 1000);
    this.resetRep();
  }
}
