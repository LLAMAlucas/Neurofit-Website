/**
 * AI coaching trigger coordinator. PURE module (no timers, no DOM).
 * ----------------------------------------------------------------------------
 * v2: mid-set cues come from explicit TRIGGER REQUESTS, not a severity scan. The
 * hook evaluates the v2 trigger conditions (baseline-relative lean, depth-gated
 * valgus, eccentric control) behind 150ms persistence gates and calls
 * `requestTrigger` when one fires. Only MID-SET-tier metrics ever reach here —
 * post-set signals (levelness, symmetry, hip shift, butt wink) and context-only
 * signals (velocity collapse — the deliberate silent-fatigue exception) never do.
 *
 *   Dedup (§5): triggers for the SAME rep within `dedupWindowSec` merge into one
 *   batch. The hook drives time: it calls flushDue(now) each tick and fires the
 *   batch that comes due. A trigger for a different rep supersedes (flushes) the
 *   pending one. Time is injected (seconds) so this stays pure and testable.
 */
import type { MetricId, Orientation } from "../squat/metrics";
import type { TriggerKind } from "../session/types";

export interface RepContext {
  setIndex: number;
  repIndex: number;
  orientation: Orientation;
}

export interface VelocitySignal {
  rollingAverage: number | null;
  current: number | null;
  /** Fraction slower than the rolling average (1 − ratio), if known. */
  pctSlower: number | null;
  /** v2 T6: fatigue collapse (< collapse threshold of baseline) — context only. */
  collapsed: boolean;
}

/** Generic over the metric vocabulary (squat MetricId by default; push-ups use PushupMetricId). */
export interface CoachingBatch<Id extends string = MetricId> {
  setIndex: number;
  repIndex: number;
  orientation: Orientation;
  triggers: TriggerKind[];
  faultChecks: Id[];
  velocity: VelocitySignal | null;
}

interface PendingBatch<Id extends string> {
  setIndex: number;
  repIndex: number;
  orientation: Orientation;
  triggers: Set<TriggerKind>;
  faultChecks: Set<Id>;
  velocity: VelocitySignal | null;
  deadline: number;
}

export class CoachingCoordinator<Id extends string = MetricId> {
  private pending: PendingBatch<Id> | null = null;

  constructor(private readonly dedupWindowSec: number) {}

  /**
   * A MID-SET trigger fired for `faultCheck` (forward lean / valgus / eccentric).
   * Merges with same-rep triggers inside the dedup window. Returns a batch that
   * must be flushed immediately because a different rep superseded the pending one
   * (usually null).
   */
  requestTrigger(ctx: RepContext, faultCheck: Id, now: number): CoachingBatch<Id> | null {
    return this.enqueue(ctx, now, (b) => {
      b.triggers.add("fault_spike");
      b.faultChecks.add(faultCheck);
    });
  }

  /** Attach fatigue context (velocity collapse) to the pending batch, if any. */
  attachVelocity(velocity: VelocitySignal): void {
    if (this.pending) this.pending.velocity = velocity;
  }

  /** Flush the pending batch if its dedup window has elapsed. */
  flushDue(now: number): CoachingBatch<Id> | null {
    if (this.pending && now >= this.pending.deadline) {
      const out = toBatch(this.pending);
      this.pending = null;
      return out;
    }
    return null;
  }

  /** Flush any pending batch unconditionally (e.g. at set end). */
  forceFlush(): CoachingBatch<Id> | null {
    if (!this.pending) return null;
    const out = toBatch(this.pending);
    this.pending = null;
    return out;
  }

  /** New set: drop any pending batch. */
  resetSet(): void {
    this.pending = null;
  }

  private enqueue(ctx: RepContext, now: number, mutate: (b: PendingBatch<Id>) => void): CoachingBatch<Id> | null {
    let flushed: CoachingBatch<Id> | null = null;
    // A trigger for a different rep supersedes the pending one — flush it now.
    if (this.pending && (this.pending.repIndex !== ctx.repIndex || this.pending.setIndex !== ctx.setIndex)) {
      flushed = toBatch(this.pending);
      this.pending = null;
    }
    if (!this.pending) {
      this.pending = {
        setIndex: ctx.setIndex,
        repIndex: ctx.repIndex,
        orientation: ctx.orientation,
        triggers: new Set(),
        faultChecks: new Set(),
        velocity: null,
        deadline: now + this.dedupWindowSec, // window runs from the FIRST trigger
      };
    }
    mutate(this.pending);
    return flushed;
  }
}

function toBatch<Id extends string>(p: PendingBatch<Id>): CoachingBatch<Id> {
  return {
    setIndex: p.setIndex,
    repIndex: p.repIndex,
    orientation: p.orientation,
    triggers: [...p.triggers],
    faultChecks: [...p.faultChecks],
    velocity: p.velocity,
  };
}
