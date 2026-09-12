/**
 * Per-set time-series helpers for the v2 triggers. PURE module.
 * ----------------------------------------------------------------------------
 * Three small, independently-testable pieces:
 *   - BaselineTracker : the reps-1–2 per-set baseline (no trigger fires during
 *     warm-up). Triggers compare the current rep to this baseline as a RATIO or
 *     DELTA, which is body-size invariant.
 *   - PersistenceGate : time-based hold (a mid-set condition must persist ~150ms
 *     to fire — filters landmark jitter). Time-based, never frame-counted.
 *   - EccentricTracker : descent speed + bottom-bounce timing for T2, from the
 *     hip-Y samples already produced each frame (no new landmark tracking).
 */

/** Mean of the first `warmupReps` rep values; null until warm-up completes. */
export class BaselineTracker {
  private samples: number[] = [];
  constructor(private readonly warmupReps: number) {}

  /**
   * Record a rep's representative value. This class enforces only a SAMPLE CAP — it takes
   * the first `warmupReps` values it is handed, whenever they arrive. It has no rep index,
   * so restricting those samples to the warm-up REPS is the caller's job.
   *
   * That distinction is not academic: it used to read "only the warm-up reps shape the
   * baseline", which was false. On 2026-08-02 set 3, rep 1 failed the depth-hygiene gate and
   * the second qualifying sample arrived on REP 6 — so the baseline resolved on the final rep
   * of the set, after every trigger had already been evaluated against null. The trigger layer
   * saw no baseline all set while the post-set payload reported one. See `useWorkout`, which
   * now gates every call site on `rep.index <= TRIGGERS.baselineReps`.
   */
  record(value: number): void {
    if (Number.isFinite(value) && this.samples.length < this.warmupReps) {
      this.samples.push(value);
    }
  }

  /** The baseline mean once `warmupReps` values are collected, else null. */
  baseline(): number | null {
    if (this.warmupReps <= 0 || this.samples.length < this.warmupReps) return null;
    return this.samples.reduce((s, v) => s + v, 0) / this.samples.length;
  }

  /** True once the per-set baseline is established (reps after warm-up). */
  ready(): boolean {
    return this.baseline() !== null;
  }

  reset(): void {
    this.samples = [];
  }
}

/**
 * Fires true only once `active` has held continuously for `holdMs`. Any inactive
 * frame resets the hold. All times in milliseconds (adaptive frame rate).
 */
export class PersistenceGate {
  private since: number | null = null;
  constructor(private readonly holdMs: number) {}

  update(active: boolean, tMs: number): boolean {
    if (!active) {
      this.since = null;
      return false;
    }
    if (this.since === null) this.since = tMs;
    return tMs - this.since >= this.holdMs;
  }

  reset(): void {
    this.since = null;
  }
}

/**
 * Collects hip-Y (normalized, y grows downward) samples across a rep's descent +
 * bottom and yields the two T2 sub-signals. Reset per rep. Body-size independence
 * comes from comparing descentSpeed to the per-set baseline as a ratio upstream.
 */
export class EccentricTracker {
  private ts: number[] = [];
  private ys: number[] = [];

  add(tMs: number, hipY: number): void {
    this.ts.push(tMs);
    this.ys.push(hipY);
  }

  reset(): void {
    this.ts = [];
    this.ys = [];
  }

  /** Index of the deepest sample (max y). */
  private deepestIdx(): number {
    let idx = 0;
    for (let i = 1; i < this.ys.length; i++) if (this.ys[i] > this.ys[idx]) idx = i;
    return idx;
  }

  /**
   * Mean descent speed (normalized units / second) from the first sample to the
   * deepest point. null if too few samples or zero elapsed time.
   */
  descentSpeed(): number | null {
    if (this.ys.length < 2) return null;
    const d = this.deepestIdx();
    if (d === 0) return null;
    const dy = this.ys[d] - this.ys[0];
    const dt = (this.ts[d] - this.ts[0]) / 1000;
    if (dt <= 0 || dy <= 0) return null;
    return dy / dt;
  }

  /**
   * Time (ms) from the peak descent velocity to the peak ascent velocity around
   * the turnaround. A short reversal = an elastic bounce; longer = controlled.
   * null if a clean descent→ascent reversal isn't present.
   */
  reversalMs(): number | null {
    if (this.ys.length < 3) return null;
    // Per-step vertical velocity (units/s): positive = descending (y up).
    const v: number[] = [];
    const vt: number[] = [];
    for (let i = 1; i < this.ys.length; i++) {
      const dt = (this.ts[i] - this.ts[i - 1]) / 1000;
      if (dt <= 0) continue;
      v.push((this.ys[i] - this.ys[i - 1]) / dt);
      vt.push(this.ts[i]);
    }
    if (v.length < 2) return null;
    let maxI = 0; // peak descent (most positive)
    let minI = 0; // peak ascent (most negative)
    for (let i = 1; i < v.length; i++) {
      if (v[i] > v[maxI]) maxI = i;
      if (v[i] < v[minI]) minI = i;
    }
    if (minI <= maxI) return null; // ascent peak must follow descent peak
    return vt[minI] - vt[maxI];
  }
}
