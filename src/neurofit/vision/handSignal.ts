/**
 * End-of-set hand signal. PURE module (no React, no DOM).
 * ----------------------------------------------------------------------------
 * The lifter raises ONE hand straight overhead, keeps the other arm down, and holds it. That ends
 * the set from wherever they stand, so they don't have to walk to the device mid-set (the walk was
 * being recorded as part of the set, and the post-set debrief only started once they got there).
 *
 * Why this shape: it is the one arm pose none of the three exercises makes during a valid rep —
 * squat arms are both down/forward (an overhead squat has BOTH up), push-up hands are both on the
 * floor, and a pull-up hang has BOTH up. So the shape itself is the gate; the caller does not need
 * "not mid-rep" (which would deadlock push-ups: standing up out of the plank can arm a phantom
 * attempt that never closes). Pull-ups still add `!isDown` at the call site.
 *
 * Geometry is y-only against the arm's own upper-arm length (in aspect space), so it reads the same
 * side-on and head-on. The "other arm down" side uses a LOW visibility floor on purpose: side-on the
 * far arm is occluded, but MediaPipe invents it following the body prior, so a far arm on the bar
 * still reads "up" and a hang can't pass.
 *
 * ⚠️ EVERY threshold below is UNVALIDATED (n=0). All timing is in milliseconds.
 */
import type { Landmark } from "../pose/landmarks";

export const HAND_SIGNAL = {
  /** Wrist must sit this many upper-arm lengths above its shoulder. A straight arm overhead reads
   *  ~2, an arm 45° up ~1.4, a hand resting on top of the head ~0.6-0.9 — 1.2 asks for a deliberate
   *  raise, not a head scratch. UNVALIDATED. */
  raiseArmLens: 1.2,
  /** The other wrist must be at least this many upper-arm lengths BELOW its shoulder (0 = merely
   *  below). Arms down by the sides or hands on hips both pass. UNVALIDATED. */
  otherDownArmLens: 0,
  /** Visibility floor for the "other arm down" landmarks. Low on purpose (see header). UNVALIDATED. */
  otherArmMinVis: 0.1,
  /** Continuous hold that ends the set. Long enough that a stretch or a wave doesn't end a set,
   *  short enough to feel responsive with the on-screen ring. UNVALIDATED. */
  holdMs: 1500,
  /** A gap shorter than this doesn't break the hold (single-frame landmark flicker). UNVALIDATED. */
  graceMs: 200,
} as const;

export type HandSignalConfig = typeof HAND_SIGNAL;

/** MediaPipe indices: [shoulder, elbow, wrist] per side. */
const LEFT = [11, 13, 15] as const;
const RIGHT = [12, 14, 16] as const;

export type SignalSide = "left" | "right";

export interface HandSignalUpdate {
  /** 0..1 — how far through the hold the lifter is (0 when not signalling). */
  progress: number;
  /** True on the single frame the hold completes. */
  fired: boolean;
}

/** Which arm (if exactly one) is raised with the other down, this frame. Exported for tests. */
export function signalShape(
  lm: readonly Landmark[],
  aspect: number,
  minVis: number,
  cfg: HandSignalConfig = HAND_SIGNAL,
): SignalSide | null {
  const raised = (side: readonly number[]): boolean => {
    const [s, e, w] = side.map((i) => lm[i]);
    if (!s || !e || !w || s.visibility < minVis || e.visibility < minVis || w.visibility < minVis) return false;
    const upperArm = Math.hypot((e.x - s.x) * aspect, e.y - s.y);
    if (upperArm < 1e-4) return false;
    // Image y grows downward: "above" = smaller y.
    return e.y < s.y && s.y - w.y >= cfg.raiseArmLens * upperArm;
  };
  const down = (side: readonly number[]): boolean => {
    const [s, e, w] = side.map((i) => lm[i]);
    if (!s || !w || s.visibility < cfg.otherArmMinVis || w.visibility < cfg.otherArmMinVis) return false;
    const upperArm = e ? Math.hypot((e.x - s.x) * aspect, e.y - s.y) : 0;
    return w.y - s.y > cfg.otherDownArmLens * upperArm;
  };
  const l = raised(LEFT) && down(RIGHT);
  const r = raised(RIGHT) && down(LEFT);
  if (l === r) return null; // neither, or (impossible geometry) both
  return l ? "left" : "right";
}

/** Hold tracker for the end-of-set signal. Fires once, then stays latched until reset(). */
export class EndSetSignal {
  private heldSinceMs: number | null = null;
  private lastTrueMs = 0;
  private latched = false;
  /** When the completed hold began (ms), set on fire — attempts that ended after this were
   *  produced while getting into the signal, not by the set. */
  onsetMs: number | null = null;
  side: SignalSide | null = null;

  constructor(private readonly cfg: HandSignalConfig = HAND_SIGNAL) {}

  update(lm: readonly Landmark[], tMs: number, aspect: number, minVis: number, eligible: boolean): HandSignalUpdate {
    if (this.latched) return { progress: 1, fired: false };
    if (!eligible) {
      this.heldSinceMs = null;
      return { progress: 0, fired: false };
    }
    const shape = signalShape(lm, aspect, minVis, this.cfg);
    if (shape) {
      if (this.heldSinceMs === null) this.heldSinceMs = tMs;
      this.lastTrueMs = tMs;
      this.side = shape;
    } else if (this.heldSinceMs !== null && tMs - this.lastTrueMs > this.cfg.graceMs) {
      this.heldSinceMs = null;
    }
    if (this.heldSinceMs === null) return { progress: 0, fired: false };
    const progress = Math.min(1, (tMs - this.heldSinceMs) / this.cfg.holdMs);
    if (progress >= 1 && shape) {
      this.latched = true;
      this.onsetMs = this.heldSinceMs;
      return { progress: 1, fired: true };
    }
    return { progress, fired: false };
  }

  reset(): void {
    this.heldSinceMs = null;
    this.lastTrueMs = 0;
    this.latched = false;
    this.onsetMs = null;
    this.side = null;
  }
}
