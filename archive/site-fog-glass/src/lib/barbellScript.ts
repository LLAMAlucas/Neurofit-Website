/**
 * The barbell stop — "Load the bar." — as a script the scroll plays on the
 * body. PURE: no three, no DOM. The stage plays it (StageScene, Barbell), the
 * panel lights its steps from it (Journey), and `npm run check` walks it.
 *
 * Built like the flow (lib/flowScript): through the stop's hold (lib/story
 * `holdAt`, 0…1) the reader passes four steps, and every animation is a pure
 * function of how far through the hold they are — it moves only while they
 * scroll, freezes when they stop, and runs backwards on the way up.
 *   find  — a ring of light closes onto the near plate, blinks, and holds on.
 *   path  — reps 1 and 2: the plate's centre leaves a trail.
 *   speed — reps 3 and 4: each rep's bar speed, in m/s, as it locks out.
 *   drift — rep 5, the slow one: the bar drifts forward of mid-foot and
 *           stalls on the way up; then the read after the set writes itself.
 *
 * The squat is the page's own (lib/poseFrames), with a bar on its back: the
 * body balances it over mid-foot from the ankles, and the arms are solved onto
 * the bar. Every number the stop shows — speeds, how much the set slowed — is
 * MEASURED off the bar's path here, never typed.
 */
import type { JointName } from "./pose";
import { poseAt, type Pose } from "./poseFrames";
import { jy, jz, rotateJoints, setJoint, solveMiddle } from "./kinematics";

export type BarStepId = "find" | "path" | "speed" | "drift";

/** Where each step starts, as a share of the stop's hold. */
export const BAR_STEPS: readonly { id: BarStepId; from: number }[] = [
  { id: "find", from: 0 },
  { id: "path", from: 0.19 },
  { id: "speed", from: 0.43 },
  { id: "drift", from: 0.66 },
];
export const BSTEP = Object.fromEntries(BAR_STEPS.map((s, i) => [s.id, i])) as Record<BarStepId, number>;

/** The step at `u` through the hold: −1 before it, the last step after it. */
export function barStepAt(u: number): number {
  if (u < 0) return -1;
  let i = 0;
  while (i < BAR_STEPS.length - 1 && u >= BAR_STEPS[i + 1].from) i++;
  return i;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/* ── the barbell ──────────────────────────────────────────────────────────── */

/** A 20 kg bar: 2.2 m long, the plates on from 0.66 m out. */
export const BAR_HALF = 1.1;
export const COLLAR_X = 0.66;
export const BAR_R = 0.014;
export const SLEEVE_R = 0.025;
/** Two 450 mm plates a side, 5 cm thick each. */
export const PLATE_R = 0.225;
export const PLATE_W = 0.05;
export const PLATES = 2;
/** The near plates' outer face: where the trail, the ring and the mid-foot
 *  line are drawn — in the plane the phone sees the plate's centre move. */
export const PLATE_FACE_X = COLLAR_X + PLATES * PLATE_W;

/** Where the bar rests: on the upper back, a little above the shoulder joints
 *  and behind them, along and across the trunk (metres). */
const BAR_UP = 0.04;
const BAR_BACK = 0.07;
/** The hands: a little wider than the shoulders, below the bar and a touch
 *  behind it, so the upright hand presses its palm to the bar and the fingers
 *  wrap over it — the pull-up's grip (retarget's grip), turned to a back squat. */
export const GRIP_X = 0.42;
export const WRIST_BELOW = 0.08;
export const WRIST_BEHIND = 0.03;

/** Mid-foot, the way the app finds it: halfway from heel to toe tip. The
 *  ankle sits at z = 0 and the heel ~6 cm behind it; the toe tip ~4 cm past
 *  the ball (the pose's toe joint, at 0.16). */
export const MIDFOOT_Z = 0.07;
/** A clean rep keeps the bar this close over it: a touch behind, as a real
 *  lifter carries it. */
const BALANCE_Z = MIDFOOT_Z - 0.01;
/** Past this far forward of mid-foot, the bar has drifted (the page lights
 *  that part of the path red). */
export const DRIFT_FLAG_M = 0.05;

/** The ankles, about which the body leans to balance the bar. */
const ANKLE_Y = 0.07;
const ANKLE_Z = 0;
const ABOVE_ANKLES: readonly JointName[] = [
  "head",
  "neck",
  "shoulderL",
  "shoulderR",
  "elbowL",
  "elbowR",
  "wristL",
  "wristR",
  "hipL",
  "hipR",
  "kneeL",
  "kneeR",
];

export type BarPoint = { y: number; z: number };

/** The bar's centre on the back of `p` (the sagittal plane; it lies along X). */
export function barOnBack(p: Pose, out: BarPoint = { y: 0, z: 0 }): BarPoint {
  const sy = (jy(p, "shoulderL") + jy(p, "shoulderR")) / 2;
  const sz = (jz(p, "shoulderL") + jz(p, "shoulderR")) / 2;
  const hy = (jy(p, "hipL") + jy(p, "hipR")) / 2;
  const hz = (jz(p, "hipL") + jz(p, "hipR")) / 2;
  const l = Math.hypot(sy - hy, sz - hz) || 1;
  const ty = (sy - hy) / l;
  const tz = (sz - hz) / l;
  // Up the trunk, then straight back off it (away from the chest).
  out.y = sy + ty * BAR_UP + tz * BAR_BACK;
  out.z = sz + tz * BAR_UP - ty * BAR_BACK;
  return out;
}

/** Put the hands on the bar and solve the elbows down and back onto them. */
function armsOnBar(p: Pose, bar: BarPoint): void {
  for (const [side, s] of [
    ["L", -1],
    ["R", 1],
  ] as const) {
    setJoint(p, `wrist${side}`, s * GRIP_X, bar.y - WRIST_BELOW, bar.z - WRIST_BEHIND);
    solveMiddle(p, `shoulder${side}`, `elbow${side}`, `wrist${side}`, s * 0.35, -1, -0.55);
  }
}

/** How far forward the body leans from the ankles to put the bar over
 *  mid-foot, for a clean pose at `depth`: one rigid turn of everything above
 *  the ankles, so no bone changes length and the feet don't move. */
function balanceLean(depth: number): number {
  const p = new Float32Array(16 * 3);
  poseAt(depth, null, 0, p);
  const b = barOnBack(p);
  // Turning (y, z) about the ankle by φ moves z to A·sinφ + B·cosφ.
  const A = b.y - ANKLE_Y;
  const B = b.z - ANKLE_Z;
  return Math.asin((BALANCE_Z - ANKLE_Z) / Math.hypot(A, B)) - Math.atan2(B, A);
}
const LEAN_STAND = balanceLean(0);
const LEAN_BOTTOM = balanceLean(1);

/**
 * The loaded squat at `depth`, `lean` (0…1) of the way into a forward lean,
 * into `out`; the bar's centre into `bar`. The balance lean is the clean one
 * at this depth, so a lean rep carries the bar forward of mid-foot.
 */
export function loadedPose(depth: number, lean: number, out: Pose, bar: BarPoint): void {
  poseAt(depth, lean > 0 ? "lean" : null, lean, out);
  rotateJoints(out, ABOVE_ANKLES, "yz", ANKLE_Y, ANKLE_Z, LEAN_STAND + (LEAN_BOTTOM - LEAN_STAND) * depth);
  barOnBack(out, bar);
  armsOnBar(out, bar);
}

/* ── the set ──────────────────────────────────────────────────────────────── */

/** One rep, seconds: a breath standing, down, a beat at the bottom, up, and a
 *  moment locked out. Only the way up changes from rep to rep: it slows. */
const LEAD_S = 0.3;
const DOWN_S = 1.0;
const HOLD_S = 0.15;
const TOP_S = 0.35;
/** The way up, rep by rep: two warm-ups at the same pace, then slower and
 *  slower — the slowdown the speeds show. */
const UP_S = [0.72, 0.73, 0.81, 0.91, 1.2];
export const SET_REPS = UP_S.length;
/** The rep that drifts and stalls (0-based): the last. */
export const DRIFT_REP = SET_REPS - 1;
/** How far into its lean the drifting rep goes (0…1 of the page's lean). */
const DRIFT_LEAN = 0.85;
/** The stall: where in the way up the bar slows (share of the ascent), how
 *  wide, and how nearly to a stop. */
const STALL_AT = 0.34;
const STALL_W = 0.075;
const STALL_DIP = 0.88;

export const REP_S = UP_S.map((up) => LEAD_S + DOWN_S + HOLD_S + up + TOP_S);
export const REP_START = REP_S.map((_, k) => REP_S.slice(0, k).reduce((a, b) => a + b, 0));
export const REP_END = REP_START.map((s, k) => s + REP_S[k]);
/** When each rep locks out: the top of its way up. */
export const LOCKOUT_T = REP_START.map((s, k) => s + LEAD_S + DOWN_S + HOLD_S + UP_S[k]);
export const SET_S = REP_END[SET_REPS - 1];

/** The way up as a share of the way down (0 bottom → 1 top) over its time: a
 *  smooth start and finish, and for the stalling rep a dip in speed partway. */
const ASCENT_N = 256;
function ascentTable(dip: number): Float32Array {
  const x = new Float32Array(ASCENT_N + 1);
  const v = (t: number) => 6 * t * (1 - t) * (1 - dip * Math.exp(-(((t - STALL_AT) / STALL_W) ** 2)));
  for (let i = 1; i <= ASCENT_N; i++) {
    const a = (i - 1) / ASCENT_N;
    const b = i / ASCENT_N;
    x[i] = x[i - 1] + ((v(a) + v(b)) / 2) * (b - a);
  }
  const total = x[ASCENT_N];
  for (let i = 0; i <= ASCENT_N; i++) x[i] /= total;
  return x;
}
const CLEAN_UP = ascentTable(0);
const STALL_UP = ascentTable(STALL_DIP);
const tableAt = (x: Float32Array, t: number) => {
  const f = clamp01(t) * ASCENT_N;
  const i = Math.min(ASCENT_N - 1, Math.floor(f));
  return x[i] + (x[i + 1] - x[i]) * (f - i);
};

/** Rep `k`, `t` seconds in: how deep, and how far into its lean. */
function repAt(k: number, t: number): { depth: number; lean: number } {
  const drift = k === DRIFT_REP;
  let s = t - LEAD_S;
  if (s < 0) return { depth: 0, lean: 0 };
  if (s < DOWN_S) {
    const d = s / DOWN_S;
    return { depth: smooth(d), lean: drift ? DRIFT_LEAN * smooth((d - 0.35) / 0.65) : 0 };
  }
  s -= DOWN_S;
  if (s < HOLD_S) return { depth: 1, lean: drift ? DRIFT_LEAN : 0 };
  s -= HOLD_S;
  if (s < UP_S[k]) {
    const a = s / UP_S[k];
    return {
      depth: 1 - tableAt(drift ? STALL_UP : CLEAN_UP, a),
      lean: drift ? DRIFT_LEAN * (1 - smooth((a - 0.5) / 0.5)) : 0,
    };
  }
  return { depth: 0, lean: 0 };
}

/** The rep at `setT` seconds into the set, and how far into it. */
export function repOf(setT: number): { rep: number; t: number } {
  const t = Math.min(SET_S, Math.max(0, setT));
  let k = 0;
  while (k < SET_REPS - 1 && t >= REP_END[k]) k++;
  return { rep: k, t: t - REP_START[k] };
}

/** The body, and the bar on it, `setT` seconds into the set. */
export function barbellPose(setT: number, out: Pose, bar: BarPoint): void {
  const { rep, t } = repOf(setT);
  const { depth, lean } = repAt(rep, t);
  loadedPose(depth, lean, out, bar);
}

/* ── the bar's path, and what is measured off it ──────────────────────────── */

/** Samples a second along each rep's path. */
const PATH_HZ = 240;

export type RepPath = {
  /** Seconds into the rep, and the bar's centre (y up, z forward), metres. */
  t: Float32Array;
  y: Float32Array;
  z: Float32Array;
};

export type RepStats = {
  /** Bottom to lockout, metres. */
  rom: number;
  /** Mean speed on the way up, m/s: bottom to lockout over the time it took. */
  mcv: number;
  /** Furthest the bar got forward of mid-foot, metres (negative = behind). */
  forward: number;
  /** Seconds into the rep: leaving the bottom, and locked out. */
  bottomT: number;
  lockT: number;
  /** Where the bar stalled on the way up — the speed dipping after its first
   *  peak — or null when it went up in one push. */
  stick: { t: number; y: number; z: number } | null;
};

function tracePath(k: number): RepPath {
  const n = Math.round(REP_S[k] * PATH_HZ) + 1;
  const path: RepPath = { t: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n) };
  const p = new Float32Array(16 * 3);
  const bar: BarPoint = { y: 0, z: 0 };
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * REP_S[k];
    const { depth, lean } = repAt(k, t);
    loadedPose(depth, lean, p, bar);
    path.t[i] = t;
    path.y[i] = bar.y;
    path.z[i] = bar.z;
  }
  return path;
}

/** Measure one rep off its path, the way a tracker would: no peeking at the
 *  script's timings. */
export function measureRep(path: RepPath): RepStats {
  const n = path.t.length;
  let lo = 0;
  for (let i = 1; i < n; i++) if (path.y[i] <= path.y[lo] + 1e-6) lo = i; // the LAST frame at the bottom
  const top = path.y[n - 1];
  let hi = n - 1;
  for (let i = lo; i < n; i++)
    if (path.y[i] >= top - 0.002) {
      hi = i;
      break;
    }
  const rom = top - path.y[lo];
  const mcv = rom / (path.t[hi] - path.t[lo]);
  let forward = -Infinity;
  for (let i = 0; i < n; i++) forward = Math.max(forward, path.z[i] - MIDFOOT_Z);
  // Vertical speed on the way up; a stall is a dip below 80% of the first
  // peak before the bar gets going again.
  let stick: RepStats["stick"] = null;
  const vy = (i: number) => (path.y[i + 1] - path.y[i - 1]) / (path.t[i + 1] - path.t[i - 1]);
  let peak = 0;
  let falling = false;
  for (let i = lo + 1; i < hi - 1; i++) {
    const v = vy(i);
    if (!falling) {
      if (v > peak) peak = v;
      else if (v < peak * 0.8) falling = true;
    }
    if (falling && v <= vy(i - 1) && v <= vy(i + 1)) {
      stick = { t: path.t[i], y: path.y[i], z: path.z[i] };
      break;
    }
  }
  return { rom, mcv, forward, bottomT: path.t[lo], lockT: path.t[hi], stick };
}

export const BAR_PATHS: readonly RepPath[] = UP_S.map((_, k) => tracePath(k));
export const BAR_REPS: readonly RepStats[] = BAR_PATHS.map(measureRep);

/** The speeds as the page shows them: m/s, to the hundredth. */
export const speedText = (k: number) => BAR_REPS[k].mcv.toFixed(2);
/** How much slower the slowest rep was than the fastest, whole percent. */
export const SLOWDOWN_PCT = (() => {
  const v = BAR_REPS.map((r) => r.mcv);
  return Math.round((1 - Math.min(...v) / Math.max(...v)) * 100);
})();

/* ── the read after the set ───────────────────────────────────────────────── */

/**
 * The example read that comes back at the end of the stop. Its numbers are
 * the ones measured above; it follows the flow's read's rules (lib/postSet):
 * no markdown, no cause-and-effect, the reps it's about named.
 */
export const BAR_READ = {
  label: "Post-set summary",
  para:
    `Five reps, five counted. Rep 5 was your slowest, at about ${speedText(DRIFT_REP)}\u00a0m/s, ` +
    `${SLOWDOWN_PCT}% slower than your fastest. On rep 5 the bar drifted forward of mid-foot ` +
    `out of the bottom, and stalled on the way up.`,
  cue: "Keep the bar over mid-foot as you drive up, and end the set when the speed drops this far.",
} as const;
export const BAR_READ_BLOCKS: readonly string[] = [BAR_READ.label, BAR_READ.para, BAR_READ.cue];

/** Through the hold, where the read writes itself out: after rep 5 locks out,
 *  done before the hold ends. */
export const BAR_READ_FROM = 0.85;
export const BAR_READ_TO = 0.99;
export const barReadAt = (u: number) => clamp01((u - BAR_READ_FROM) / (BAR_READ_TO - BAR_READ_FROM));

/* ── the scrub ────────────────────────────────────────────────────────────── */

/** The lock-on: the ring closes in from wide onto the plate, blinks twice,
 *  and holds on — then follows the plate, dimmer, for the rest of the set. */
const RING_DELAY_S = 0.2;
const RING_CLOSE_S = 0.7;
const RING_BLINK_S = 0.15;
const RING_BLINKS = 2;
export const FIND_S = RING_DELAY_S + RING_CLOSE_S + RING_BLINKS * 2 * RING_BLINK_S + 0.5;
/** How wide the ring starts, as a multiple of the plate. */
const RING_FROM = 2.4;
/** How bright the ring stays while it follows the plate. */
export const RING_TRACK = 0.55;
/** The drifting rep plays over this share of the drift step; then the read. */
const DRIFT_REP_SHARE = 0.55;
/** The mid-foot line rises over this share of the drift step. */
const MIDFOOT_RISE = 0.12;

export type BarFrame = {
  /** The step, −1 before the hold. */
  step: number;
  /** Seconds into the set, and which rep (0-based) and how far into it. */
  setT: number;
  rep: number;
  repT: number;
  /** The lock-on ring: how bright (0…1), and how wide (1 = the plate). */
  ring: number;
  ringScale: number;
  /** 0…1: the trail. */
  trail: number;
  /** Reps locked out so far. */
  done: number;
  /** 0…1: the mid-foot line, and the dot where rep 5 stalled. */
  midfoot: number;
  stick: number;
  /** The bar is past the drift line right now. */
  drifting: boolean;
  /** 0…1: the read writing itself out. */
  read: number;
};

export const newBarFrame = (): BarFrame => ({
  step: -1,
  setT: 0,
  rep: 0,
  repT: 0,
  ring: 0,
  ringScale: RING_FROM,
  trail: 0,
  done: 0,
  midfoot: 0,
  stick: 0,
  drifting: false,
  read: 0,
});

const stepLen = (i: number) => (BAR_STEPS[i + 1]?.from ?? 1) - BAR_STEPS[i].from;
const stepF = (u: number, i: number) => (u - BAR_STEPS[i].from) / stepLen(i);
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp01(t);

/** Seconds into the set at `u`: the path step plays reps 1–2, the speed step
 *  reps 3–4, the drift step rep 5. */
export function setClockAt(u: number): number {
  const step = barStepAt(u);
  if (step < BSTEP.path) return 0;
  if (step === BSTEP.path) return lerp(0, REP_END[1], stepF(u, step));
  if (step === BSTEP.speed) return lerp(REP_END[1], REP_END[3], stepF(u, step));
  return lerp(REP_END[3], SET_S, stepF(u, step) / DRIFT_REP_SHARE);
}

/** The ring `t` seconds into the find step. */
function ringAt(t: number, out: BarFrame): void {
  const c = (t - RING_DELAY_S) / RING_CLOSE_S;
  if (c <= 0) {
    out.ring = 0;
    out.ringScale = RING_FROM;
    return;
  }
  out.ringScale = RING_FROM + (1 - RING_FROM) * smooth(c);
  if (c < 1) {
    out.ring = smooth(c * 1.6);
    return;
  }
  const b = t - RING_DELAY_S - RING_CLOSE_S;
  const blinks = RING_BLINKS * 2 * RING_BLINK_S;
  out.ring = b < blinks ? (Math.floor(b / RING_BLINK_S) % 2 === 0 ? 0.15 : 1) : 1 - (1 - RING_TRACK) * smooth((b - blinks) / 0.4);
}

/** The whole stop at `u` through its hold (lib/story `holdAt`). */
export function barbellAt(u: number, out: BarFrame = newBarFrame()): BarFrame {
  const step = barStepAt(u);
  out.step = step;
  out.setT = setClockAt(u);
  const { rep, t } = repOf(out.setT);
  out.rep = rep;
  out.repT = t;
  if (step < 0) {
    out.ring = 0;
    out.ringScale = RING_FROM;
  } else if (step === BSTEP.find) ringAt(stepF(u, step) * FIND_S, out);
  else {
    out.ring = RING_TRACK;
    out.ringScale = 1;
  }
  out.trail = step >= BSTEP.path ? 1 : 0;
  out.done = LOCKOUT_T.filter((l) => out.setT >= l - 1e-9).length;
  out.midfoot = step >= BSTEP.drift ? smooth(stepF(u, BSTEP.drift) / MIDFOOT_RISE) : 0;
  const stick = BAR_REPS[DRIFT_REP].stick;
  out.stick = stick && rep === DRIFT_REP ? smooth((t - stick.t) / 0.12) : 0;
  out.drifting = rep === DRIFT_REP && t < BAR_REPS[DRIFT_REP].lockT && barZAt(rep, t) - MIDFOOT_Z > DRIFT_FLAG_M;
  out.read = barReadAt(u);
  return out;
}

/** The bar's z on rep `k`, `t` seconds in, read off its traced path. */
function barZAt(k: number, t: number): number {
  const path = BAR_PATHS[k];
  const i = Math.min(path.t.length - 1, Math.max(0, Math.round(t * PATH_HZ)));
  return path.z[i];
}

/** What the tag over the bar says. */
export function barTagAt(f: BarFrame): string {
  if (f.step < 0) return "Finding the bar";
  if (f.step === BSTEP.find) return f.ringScale > 1.02 ? "Finding the bar" : "Bar found";
  if (f.step === BSTEP.path) return "Bar path";
  if (f.drifting) return "Forward of mid-foot";
  if (f.step === BSTEP.drift && f.done < SET_REPS) return "Rep 5";
  return f.done > 0 ? `Rep ${f.done} · ${speedText(f.done - 1)} m/s` : "Bar speed";
}
