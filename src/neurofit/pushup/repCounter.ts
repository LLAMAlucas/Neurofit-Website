/**
 * Push-up rep counter — vertical SHOULDER DROP. PURE module.
 * ----------------------------------------------------------------------------
 *   h = wrist.y − shoulder.y        (the shoulder's height above the hands; the hands don't move)
 *   hUp = lockout reference         (running max of h, updated only between reps)
 *   depthRatio = (hUp − h) / hUp    (0 locked out → larger as the chest lowers)
 *
 * Same reasoning as the squat's hip-displacement counter: the elbow bends along the camera's
 * depth axis in a head-on view, so an elbow-angle gate never fires there, while the shoulders
 * drop in BOTH views. Normalizing by hUp makes it distance-invariant.
 *
 * Differences from the squat counter, both driven by push-up evidence:
 *   1. COMPLETION IS THE LOCKOUT GATE. A rep completes when the shoulders return within
 *      `lockoutRatio` of the lockout height. Incomplete lockout is the most common push-up
 *      rejection (Kellner 2023, 10.2%), so it can't be allowed to pass silently.
 *   2. PARTIAL-LOCKOUT SEGMENTATION. If the lifter rises part way and descends again without
 *      locking out, the attempt closes at its partial top with `lockedOut: false` and the next
 *      attempt arms immediately — otherwise the pulsed reps would merge into one long rep and the
 *      missed lockouts would never be seen.
 * A median over the last `spikeFilterMs` of h rejects single-frame landmark jumps (the Tasks API
 * does no smoothing) without counting frames.
 */
import type { PushupConfig } from "./config";
import type { PushupFrame } from "./frame";

export interface PushupRep {
  /** 1-based attempt number. */
  index: number;
  startT: number;
  bottomT: number;
  endT: number;
  eccentricSec: number;
  concentricSec: number;
  /** Deepest depth ratio reached (0..1). */
  bottomDepthRatio: number;
  /** Depth ratio at the top of the attempt — ≤ lockoutRatio when lockedOut. */
  topRatio: number;
  lockedOut: boolean;
  /** Shoulder rise from the bottom to the top of the attempt (normalized image y). */
  travel: number;
  /** Mean concentric shoulder velocity (normalized units / s), or null. */
  concentricVelocity: number | null;
  bottom: PushupFrame;
  top: PushupFrame;
  /** The lockout reference in force for this attempt. */
  hUp: number;
}

export type PushupRepListener = (rep: PushupRep) => void;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class PushupRepTracker {
  /** Attempts emitted (counted or not). */
  reps = 0;
  /** True from arming until the attempt closes. */
  isDown = false;
  /** Latest depth ratio, for live UI + frame gating. */
  depthRatio = 0;

  private hUp: number | null = null;
  private window: { t: number; h: number }[] = [];
  private startT = 0;
  private bottomT = 0;
  private minH = Infinity;
  private bottomFrame: PushupFrame | null = null;
  private rising = false;
  private topH = -Infinity;
  private topT = 0;
  private topFrame: PushupFrame | null = null;

  constructor(
    private readonly cfg: PushupConfig,
    private readonly onRep: PushupRepListener = () => {},
  ) {}

  update(f: PushupFrame): void {
    if (!f.shoulder || !f.wrist) return; // can't measure shoulder height → pause counting
    const raw = f.wrist[1] - f.shoulder[1];
    if (raw <= 1e-4) return; // degenerate (shoulders at/below the hands in-frame)
    const now = f.t;
    this.window.push({ t: now, h: raw });
    const cutoff = now - this.cfg.spikeFilterMs / 1000;
    while (this.window.length > 1 && this.window[0].t < cutoff) this.window.shift();
    const h = median(this.window.map((s) => s.h));

    if (!this.isDown) this.hUp = this.hUp === null ? h : Math.max(this.hUp, h);
    const hUp = this.hUp ?? h;
    if (hUp <= 0) return;
    const ratio = (hUp - h) / hUp;
    this.depthRatio = ratio;

    if (!this.isDown) {
      if (ratio >= this.cfg.repDownRatio) this.arm(now, h, f);
      return;
    }

    if (ratio <= this.cfg.lockoutRatio) {
      this.emit(now, h, f, true, ratio, hUp);
      this.isDown = false;
      this.clearAttempt();
      return;
    }

    if (!this.rising) {
      if (h < this.minH) {
        this.minH = h;
        this.bottomT = now;
        this.bottomFrame = f;
      } else if (ratio <= (hUp - this.minH) / hUp - this.cfg.partialRiseRatio) {
        this.rising = true;
        this.topH = h;
        this.topT = now;
        this.topFrame = f;
      }
      return;
    }

    if (h > this.topH) {
      this.topH = h;
      this.topT = now;
      this.topFrame = f;
      return;
    }
    const topRatio = (hUp - this.topH) / hUp;
    if (ratio >= topRatio + this.cfg.redescentRatio && this.topFrame) {
      // Re-descended without locking out: close at the partial top, arm the next attempt there.
      const emitted = this.emit(this.topT, this.topH, this.topFrame, false, topRatio, hUp);
      if (emitted) {
        this.startT = this.topT;
        this.minH = h;
        this.bottomT = now;
        this.bottomFrame = f;
      }
      // A sub-minRepSec pulse is jitter, not an attempt — keep the original attempt's bottom.
      this.rising = false;
      this.topFrame = null;
      this.topH = -Infinity;
    }
  }

  reset(): void {
    this.reps = 0;
    this.isDown = false;
    this.depthRatio = 0;
    this.hUp = null;
    this.window = [];
    this.clearAttempt();
  }

  private arm(now: number, h: number, f: PushupFrame): void {
    this.isDown = true;
    this.startT = now;
    this.minH = h;
    this.bottomT = now;
    this.bottomFrame = f;
    this.rising = false;
    this.topH = -Infinity;
    this.topFrame = null;
  }

  private clearAttempt(): void {
    this.startT = 0;
    this.bottomT = 0;
    this.minH = Infinity;
    this.bottomFrame = null;
    this.rising = false;
    this.topH = -Infinity;
    this.topT = 0;
    this.topFrame = null;
  }

  /** Validate + emit an attempt. Returns false when debounced (too short to be a real rep). */
  private emit(endT: number, endH: number, top: PushupFrame, lockedOut: boolean, topRatio: number, hUp: number): boolean {
    if (!this.bottomFrame || endT - this.startT < this.cfg.minRepSec) return false;
    this.reps += 1;
    const concentricSec = Math.max(0, endT - this.bottomT);
    const travel = endH - this.minH;
    this.onRep({
      index: this.reps,
      startT: this.startT,
      bottomT: this.bottomT,
      endT,
      eccentricSec: Math.max(0, this.bottomT - this.startT),
      concentricSec,
      bottomDepthRatio: (hUp - this.minH) / hUp,
      topRatio,
      lockedOut,
      travel,
      concentricVelocity: concentricSec > 1e-3 && travel > 0 ? travel / concentricSec : null,
      bottom: this.bottomFrame,
      top,
      hUp,
    });
    return true;
  }
}
