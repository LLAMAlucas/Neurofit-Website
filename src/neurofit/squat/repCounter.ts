/**
 * Squat rep counter — vertical HIP DISPLACEMENT. PURE module.
 * ----------------------------------------------------------------------------
 * Counts reps from how far the hips drop, not from the 2D knee angle. The knee
 * flexes in the sagittal plane, which projects almost entirely onto the camera's
 * DEPTH axis in a front-on view — so the 2D hip–knee–ankle angle barely moves
 * head-on and an angle gate never fires (the user ends up contorting to make it
 * register). Hip height instead drops in BOTH front and side views, so it's the
 * orientation-agnostic signal (per the build spec's "vertical hip displacement
 * detection").
 *
 *   h = ankle.y − hip.y           (leg-height proxy; large standing, small deep)
 *   hUp = standing reference      (running max of h within the set)
 *   depthRatio = (hUp − h) / hUp  (0 standing → larger as the hips drop)
 *
 * A rep ARMS when depthRatio crosses `repDownRatio` and COMPLETES when it falls
 * back under `repUpRatio`; the gap between them is hysteresis against jitter.
 * Normalizing by hUp makes it distance-invariant — no "get closer" needed.
 *
 * It still emits the rich rep event (bottom snapshot, ascent velocity) the
 * velocity tracker and form checks consume.
 */
import type { SquatConfig } from "./config";
import type { SquatFrame } from "./frame";

export interface SquatRep {
  /** 1-based rep number. */
  index: number;
  startT: number;
  bottomT: number;
  endT: number;
  /** Descent duration (s). */
  eccentricSec: number;
  /** Ascent duration (s) — the phase velocity is measured over. */
  concentricSec: number;
  /** Deepest depth ratio reached (0..1); the orientation-agnostic depth proxy. */
  bottomDepthRatio: number;
  /** Deepest 2D knee angle (deg) — reliable side-on, informational front-on. */
  bottomKneeAngle: number;
  /** Hip-mid Y travel during the ascent (normalized; bottom − top). */
  travel: number;
  /** Mean concentric hip velocity (normalized units / s), or null if unmeasurable. */
  concentricVelocity: number | null;
  /** The frame snapshot at the deepest point — drives the form checks. */
  bottom: SquatFrame;
}

export type RepListener = (rep: SquatRep) => void;

export class SquatRepTracker {
  reps = 0;
  /** True while in the descent/bottom (armed), false while standing. */
  isDown = false;
  /** Latest 2D knee angle (for live UI), null if unreadable. */
  kneeAngle: number | null = null;
  /** Latest depth ratio (0 standing → larger deep), for live UI. */
  depthRatio = 0;

  /** Standing leg-height reference (running max of h within the set). */
  private hUp: number | null = null;
  private startT = 0;
  private bottomT = 0;
  private minH = Infinity; // smallest h (deepest) this rep
  private bottomHipY: number | null = null;
  private bottomFrame: SquatFrame | null = null;
  private bottomKnee = 180;
  private lastKnee = 180;

  constructor(
    private readonly cfg: SquatConfig,
    private readonly onRep: RepListener = () => {},
  ) {}

  update(f: SquatFrame): void {
    if (f.kneeAngle !== null) {
      this.kneeAngle = f.kneeAngle;
      this.lastKnee = f.kneeAngle;
    }

    const hip = f.hipMid;
    const ankle = f.ankleMid;
    if (!hip || !ankle) return; // can't measure hip height -> pause counting

    const h = ankle[1] - hip[1];
    if (h <= 1e-4) return; // degenerate (hips at/below ankle in-frame)
    this.hUp = this.hUp === null ? h : Math.max(this.hUp, h);
    const ratio = this.hUp > 0 ? (this.hUp - h) / this.hUp : 0;
    this.depthRatio = ratio;
    const now = f.t;

    // Track the bottom while armed.
    if (this.isDown && h < this.minH) {
      this.minH = h;
      this.bottomT = now;
      this.bottomHipY = hip[1];
      this.bottomFrame = f;
      this.bottomKnee = this.lastKnee;
    }

    if (!this.isDown && ratio >= this.cfg.repDownRatio) {
      // Arm a rep.
      this.isDown = true;
      this.startT = now;
      this.minH = h;
      this.bottomT = now;
      this.bottomHipY = hip[1];
      this.bottomFrame = f;
      this.bottomKnee = this.lastKnee;
    } else if (this.isDown && ratio <= this.cfg.repUpRatio) {
      // Complete a rep — validate, measure the ascent, emit.
      this.isDown = false;
      const endT = now;
      const longEnough = endT - this.startT >= this.cfg.minRepSec;
      const topHipY = hip[1];
      const travel = this.bottomHipY !== null ? this.bottomHipY - topHipY : 0;
      const movedEnough = travel >= this.cfg.minHipTravel;

      if (longEnough && movedEnough && this.bottomFrame) {
        this.reps += 1;
        const concentricSec = Math.max(0, endT - this.bottomT);
        this.onRep({
          index: this.reps,
          startT: this.startT,
          bottomT: this.bottomT,
          endT,
          eccentricSec: Math.max(0, this.bottomT - this.startT),
          concentricSec,
          bottomDepthRatio: this.hUp && this.hUp > 0 ? (this.hUp - this.minH) / this.hUp : 0,
          bottomKneeAngle: this.bottomKnee,
          travel,
          concentricVelocity: concentricSec > 1e-3 && travel > 0 ? travel / concentricSec : null,
          bottom: this.bottomFrame,
        });
      }
      this.bottomFrame = null;
    }
  }

  reset(): void {
    this.reps = 0;
    this.isDown = false;
    this.kneeAngle = null;
    this.depthRatio = 0;
    this.hUp = null;
    this.startT = 0;
    this.bottomT = 0;
    this.minH = Infinity;
    this.bottomHipY = null;
    this.bottomFrame = null;
    this.bottomKnee = 180;
    this.lastKnee = 180;
  }
}
