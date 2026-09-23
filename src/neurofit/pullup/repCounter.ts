/**
 * Pull-up rep counter — vertical SHOULDER RISE toward the hands. PURE module.
 * ----------------------------------------------------------------------------
 *   h = shoulder.y − wrist.y        (how far the shoulders hang below the hands; the bar is fixed)
 *   hDown = hang reference          (running max of h, updated only between attempts, on the bar)
 *   pullRatio = (hDown − h) / hDown (0 at the lifter's own dead hang → ≈1 with the chin at the bar)
 *
 * The squat and push-up counters rest at the TOP and descend first. A pull-up rests at the
 * BOTTOM: an attempt arms when the shoulders rise past `repUpRatio`, peaks, and closes when they
 * come back to the hang. Three consequences, all driven by the standards (see pullup/config.ts):
 *   1. EXTENSION IS JUDGED ON THE START. [USMC]/[CFG] require every rep to start from a dead hang,
 *      so each attempt carries the frame it started from — the deepest hang frame since the
 *      previous attempt closed — and the caller judges the arms there. A last rep dropped from the
 *      top is therefore still a complete record (its start was judged; nothing is owed at the end).
 *   2. PARTIAL-HANG SEGMENTATION. Lowering part way and pulling again closes the attempt at its
 *      partial bottom and arms the next one there, so the next rep is judged as starting bent.
 *   3. THE BAR IS FIXED, so the wrists are too. Wrists falling away from their hang position means
 *      the lifter let go: an open attempt closes as a dismount, and idle frames are ignored — so
 *      dropping off and lowering the arms (which shrinks h exactly like a pull does) never arms.
 * A median over the last `spikeFilterMs` of h and wrist y rejects single-frame landmark jumps.
 */
import type { PullupConfig } from "./config";
import type { PullupFrame } from "./frame";

export type PullupEnd = "return" | "partial" | "dismount";

export interface PullupRep {
  /** 1-based attempt number. */
  index: number;
  /** Left the hang (last frame near the start bottom). */
  startT: number;
  topT: number;
  endT: number;
  concentricSec: number;
  eccentricSec: number;
  /** Pull ratio of the frame the attempt started from (0 = the deepest hang seen this set). */
  startRatio: number;
  /** Highest pull ratio reached. */
  peakRatio: number;
  /** Pull ratio where the attempt closed. */
  endRatio: number;
  endedBy: PullupEnd;
  /** The hang frame the attempt started from — extension is judged here. */
  start: PullupFrame;
  /** The highest frame. */
  top: PullupFrame;
  /** The hang reference in force for this attempt. */
  hDown: number;
  /** Shoulder rise from the start to the top (normalized image y). */
  travel: number;
  /** Mean concentric shoulder velocity (normalized units / s), or null. */
  concentricVelocity: number | null;
}

export type PullupRepListener = (rep: PullupRep) => void;

interface Sample {
  t: number;
  v: number;
}

/** Wrist rise above the lagging grip reference (× hang height) that means a NEW grip rather than
 *  jitter — the median-filtered wrist moves a few thousandths on a fixed bar, while a jump to the
 *  bar outruns the reference by far more than 0.05 within a few frames. */
const GRIP_MOVE_RATIO = 0.05;
/** Lag of the grip reference: follows a settling grip upward in ~0.3 s, downward in ~1.7 s. */
const GRIP_TAU_UP_SEC = 0.3;
const GRIP_TAU_DOWN_SEC = 1.7;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class PullupRepTracker {
  /** Attempts emitted (counted or not). */
  reps = 0;
  /** True while an attempt is in progress (the name matches the other trackers the UI reads). */
  isDown = false;
  /** Latest pull ratio, for live UI + frame gating. */
  pullRatio = 0;
  /** The last frame was accepted as hanging from the bar (idle) or part of an attempt. */
  onBar = false;
  /**
   * Bumped when the grip moves UP to a new height between attempts — reaching overhead while
   * standing, then jumping to a higher bar. Anything sampled at the old height (the bar line, the
   * hang reference) belongs to a grip that no longer exists; the session clears its bar samples.
   */
  gripEpoch = 0;

  private hDown: number | null = null;
  private wristRef: number | null = null;
  private lastT: number | null = null;
  private hWin: Sample[] = [];
  private wWin: Sample[] = [];

  // Idle: the deepest hang frame since the last attempt closed = the next attempt's start.
  private candH = -Infinity;
  private candFrame: PullupFrame | null = null;
  private lastLowT = 0;

  // Attempt in progress.
  private startH = 0;
  private startT = 0;
  private startRatio = 0;
  private startFrame: PullupFrame | null = null;
  private peakH = Infinity;
  private peakT = 0;
  private peakFrame: PullupFrame | null = null;
  private falling = false;
  private lowH = -Infinity;
  private lowT = 0;
  private lowFrame: PullupFrame | null = null;

  constructor(
    private readonly cfg: PullupConfig,
    private readonly onRep: PullupRepListener = () => {},
  ) {}

  /** The set's hang reference (null until the lifter has hung on the bar). */
  get hangHeight(): number | null {
    return this.hDown;
  }

  update(f: PullupFrame): void {
    if (!f.shoulder || !f.wrist) return; // can't measure the hang → pause counting
    const now = f.t;
    const dt = this.lastT === null ? 0 : Math.max(0, now - this.lastT);
    this.lastT = now;
    const h = this.filtered(this.hWin, now, f.shoulder[1] - f.wrist[1]);
    const wristY = this.filtered(this.wWin, now, f.wrist[1]);
    if (this.isDown) this.inAttempt(f, now, h, wristY);
    else this.idle(f, now, h, wristY, dt);
  }

  reset(): void {
    this.reps = 0;
    this.isDown = false;
    this.pullRatio = 0;
    this.onBar = false;
    this.gripEpoch = 0;
    this.hDown = null;
    this.wristRef = null;
    this.lastT = null;
    this.hWin = [];
    this.wWin = [];
    this.toIdle(null, 0, 0);
  }

  private filtered(win: Sample[], now: number, v: number): number {
    win.push({ t: now, v });
    const cutoff = now - this.cfg.spikeFilterMs / 1000;
    while (win.length > 1 && win[0].t < cutoff) win.shift();
    return median(win.map((s) => s.v));
  }

  private offBar(wristY: number): boolean {
    return this.wristRef !== null && this.hDown !== null && wristY - this.wristRef > this.cfg.dismountDropRatio * this.hDown;
  }

  private idle(f: PullupFrame, now: number, h: number, wristY: number, dt: number): void {
    if (!f.armsOverhead || h <= 1e-4 || this.offBar(wristY)) {
      this.onBar = false; // not hanging from the bar
      return;
    }
    this.onBar = true;
    if (this.wristRef === null) {
      this.wristRef = wristY;
    } else if (this.hDown !== null && wristY < this.wristRef - GRIP_MOVE_RATIO * this.hDown) {
      // The hands went up to a new, higher grip (standing reach → jump to the bar). The old hang
      // reference and start candidate were measured below this bar, not hanging from it.
      this.gripEpoch += 1;
      this.wristRef = wristY;
      this.hDown = h;
      this.candH = -Infinity;
      this.candFrame = null;
    } else {
      // A LAGGING reference: rising fast enough opens the gap above (a new grip), and it follows
      // downward only very slowly — the bar never moves down, so lowering the arms has to open
      // the off-bar gap rather than drag the reference along with it. Time constants, not a
      // per-frame factor (the frame rate is adaptive).
      const tau = wristY < this.wristRef ? GRIP_TAU_UP_SEC : GRIP_TAU_DOWN_SEC;
      this.wristRef += (1 - Math.exp(-dt / tau)) * (wristY - this.wristRef);
    }
    this.hDown = this.hDown === null ? h : Math.max(this.hDown, h);
    const ratio = (this.hDown - h) / this.hDown;
    this.pullRatio = ratio;
    if (h > this.candH) {
      this.candH = h;
      this.candFrame = f;
    }
    const candRatio = (this.hDown - this.candH) / this.hDown;
    if (ratio <= candRatio + 0.05) this.lastLowT = now;
    if (ratio >= this.cfg.repUpRatio && this.candFrame) {
      this.beginAttempt(this.candFrame, this.candH, this.lastLowT, candRatio, f, h, now);
    }
  }

  private inAttempt(f: PullupFrame, now: number, h: number, wristY: number): void {
    const hDown = this.hDown as number;
    const ratio = (hDown - h) / hDown;
    this.pullRatio = ratio;
    this.onBar = !this.offBar(wristY);

    if (!this.onBar) {
      this.emit("dismount", now, ratio);
      this.toIdle(null, 0, now);
      return;
    }

    if (this.falling) {
      if (h > this.lowH) {
        this.lowH = h;
        this.lowT = now;
        this.lowFrame = f;
      }
      if (ratio <= this.cfg.returnRatio) {
        this.emit("return", now, ratio);
        this.toIdle(f, h, now);
        return;
      }
      const lowRatio = (hDown - this.lowH) / hDown;
      if (ratio >= lowRatio + this.cfg.reriseRatio && this.lowFrame) {
        // Pulled again from a partial hang: close at the partial bottom, arm the next attempt there.
        const lowFrame = this.lowFrame;
        const lowH = this.lowH;
        const lowT = this.lowT;
        if (this.emit("partial", lowT, lowRatio)) this.beginAttempt(lowFrame, lowH, lowT, lowRatio, f, h, now);
        else this.falling = false; // a sub-minRepSec dip is jitter — keep the attempt, forget the dip
      }
      return;
    }

    if (h < this.peakH) {
      this.peakH = h;
      this.peakT = now;
      this.peakFrame = f;
    }
    if (ratio <= this.cfg.returnRatio) {
      this.emit("return", now, ratio);
      this.toIdle(f, h, now);
      return;
    }
    const peakRatio = (hDown - this.peakH) / hDown;
    if (ratio <= peakRatio - this.cfg.partialDropRatio) {
      this.falling = true;
      this.lowH = h;
      this.lowT = now;
      this.lowFrame = f;
    }
  }

  private beginAttempt(start: PullupFrame, startH: number, startT: number, startRatio: number, f: PullupFrame, h: number, now: number): void {
    this.isDown = true;
    this.startFrame = start;
    this.startH = startH;
    this.startT = startT;
    this.startRatio = Math.max(0, startRatio);
    this.peakH = h;
    this.peakT = now;
    this.peakFrame = f;
    this.falling = false;
    this.lowH = -Infinity;
    this.lowFrame = null;
  }

  /** Back to idle. `f` seeds the next start candidate (null after a dismount: a new hang is needed). */
  private toIdle(f: PullupFrame | null, h: number, now: number): void {
    this.isDown = false;
    this.candFrame = f;
    this.candH = f ? h : -Infinity;
    this.lastLowT = now;
    this.startFrame = null;
    this.peakFrame = null;
    this.peakH = Infinity;
    this.falling = false;
    this.lowH = -Infinity;
    this.lowFrame = null;
  }

  /** Validate + emit an attempt. Returns false when debounced (too short to be a real rep). */
  private emit(endedBy: PullupEnd, endT: number, endRatio: number): boolean {
    const start = this.startFrame;
    const top = this.peakFrame;
    const hDown = this.hDown;
    if (!start || !top || hDown === null || endT - this.startT < this.cfg.minRepSec) return false;
    this.reps += 1;
    const concentricSec = Math.max(0, this.peakT - this.startT);
    const travel = this.startH - this.peakH;
    this.onRep({
      index: this.reps,
      startT: this.startT,
      topT: this.peakT,
      endT,
      concentricSec,
      eccentricSec: Math.max(0, endT - this.peakT),
      startRatio: this.startRatio,
      peakRatio: (hDown - this.peakH) / hDown,
      endRatio,
      endedBy,
      start,
      top,
      hDown,
      travel,
      concentricVelocity: concentricSec > 1e-3 && travel > 0 ? travel / concentricSec : null,
    });
    return true;
  }
}
