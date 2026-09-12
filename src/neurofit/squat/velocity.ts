/**
 * Velocity-based rep-quality tracking. PURE module.
 * ----------------------------------------------------------------------------
 * Concrete, defensible fatigue signal: concentric (rising-phase) hip velocity
 * per rep, compared to the set's ROLLING AVERAGE (spec §2). A rep that comes in
 * more than `velocityDropFraction` below the running average is a velocity loss
 * — the standard velocity-based-training fatigue marker — and is what TRIGGERS
 * the AI form critique (not a fixed every-N-reps timer).
 *
 * We also keep rolling averages of the concentric AND eccentric phase durations
 * (per spec) so the AI call can be given the tempo context.
 *
 * The first `warmupReps` reps never trigger (their baseline isn't trusted yet),
 * so with warmupReps = 2 the earliest a velocity trigger can fire is rep 3.
 */
import { TRIGGERS, type SquatConfig } from "./config";
import type { Orientation } from "./metrics";

export interface VelocitySample {
  index: number;
  /** Concentric velocity for this rep (normalized units / s); 0 if unmeasured. */
  velocity: number;
  /** Rolling-average velocity of the PRIOR reps (the comparison baseline), once
   *  warmed up; null during warm-up. */
  rollingAverage: number | null;
  /** velocity / rollingAverage, once warmed up. */
  ratio: number | null;
  /** True when velocity dropped past the configured loss threshold vs the average. */
  degraded: boolean;
  /** v2 T6 fatigue COLLAPSE: below TRIGGERS.velocityCollapse.ofBaseline of the
   *  rolling baseline. Context only — never fires its own cue (the one deliberate
   *  "MediaPipe judges silently" exception); feeds fatigue context to other triggers. */
  collapsed: boolean;
  /** This rep's concentric / eccentric phase duration (s), if provided. */
  concentricSec: number | null;
  eccentricSec: number | null;
  /** Rolling-average concentric / eccentric duration over prior reps (s). */
  rollingConcentricSec: number | null;
  rollingEccentricSec: number | null;
  /** The set orientation this rep was filmed in. */
  orientation: Orientation;
  /** Front-view velocity is noisier (vertical displacement is foreshortened);
   *  kept for the trigger but flagged so the synthesis prefers side data. */
  noisy: boolean;
}

export interface RepDurations {
  concentricSec: number;
  eccentricSec: number;
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

export class VelocityTracker {
  /** Concentric velocity of every measured rep, in order. */
  private velocities: number[] = [];
  private concentrics: number[] = [];
  private eccentrics: number[] = [];

  constructor(
    private readonly cfg: SquatConfig,
    /** The orientation of the set this tracker scores (reset per set). */
    private readonly orientation: Orientation = "side",
  ) {}

  /**
   * Record a rep's velocity (and optional phase durations) and judge it against
   * the set's ROLLING AVERAGE so far. Baselines reflect only PRIOR reps.
   */
  add(index: number, velocity: number | null, durations?: RepDurations): VelocitySample {
    const warmed = this.velocities.length >= this.cfg.velocityWarmupReps;
    const rollingAverage = warmed ? mean(this.velocities) : null;
    const rollingConcentricSec = this.concentrics.length ? mean(this.concentrics) : null;
    const rollingEccentricSec = this.eccentrics.length ? mean(this.eccentrics) : null;
    const noisy = this.orientation === "front";
    const concentricSec = durations?.concentricSec ?? null;
    const eccentricSec = durations?.eccentricSec ?? null;

    // Durations are recorded for every rep that reports them (after computing the
    // prior-rep rolling averages above).
    if (durations) {
      this.concentrics.push(durations.concentricSec);
      this.eccentrics.push(durations.eccentricSec);
    }

    const common = {
      index,
      rollingAverage,
      concentricSec,
      eccentricSec,
      rollingConcentricSec,
      rollingEccentricSec,
      orientation: this.orientation,
      noisy,
    };

    if (velocity === null || !isFinite(velocity) || velocity <= 0) {
      // Unmeasurable (e.g. hips occluded) — never count it as degradation.
      return { ...common, velocity: 0, ratio: null, degraded: false, collapsed: false };
    }

    const ratio = rollingAverage !== null ? velocity / rollingAverage : null;
    const degraded = ratio !== null && ratio < 1 - this.cfg.velocityDropFraction;
    const collapsed = ratio !== null && ratio < TRIGGERS.velocityCollapse.ofBaseline;

    this.velocities.push(velocity);
    return { ...common, velocity, ratio, degraded, collapsed };
  }

  /** Rolling average velocity of the set (for a live readout). */
  average(): number | null {
    return this.velocities.length ? mean(this.velocities) : null;
  }

  /** Best velocity of the set so far (for the live velocity-bar scale). */
  best(): number | null {
    return this.velocities.length ? Math.max(...this.velocities) : null;
  }

  reset(): void {
    this.velocities = [];
    this.concentrics = [];
    this.eccentrics = [];
  }
}
