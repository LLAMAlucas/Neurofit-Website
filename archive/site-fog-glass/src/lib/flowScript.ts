/**
 * The flow stop — "what happens to what it sees" — as a script the scroll
 * plays on the body. PURE: no three, no DOM. The stage plays it (StageScene,
 * ParticleBody, Landmarks), the chart lights its steps from it (Journey), and
 * `npm run check` walks it.
 *
 * Through the stop's hold (lib/story `holdAt`, 0…1) the reader passes five
 * steps, in the order the app does them:
 *   camera — the phone in front of the body scans its front: a sweep down,
 *            two blinks, gone.
 *   points — it finds 33 points on the body (the pose model's landmarks),
 *            marked one by one, then joined.
 *   view   — the points fade; the body turns 90° to the phone — the phone's
 *            side view, 45° from where the page looks — and the phone scans
 *            it again, side-on.
 *   reps   — a squat, side-on, leaning forward; the trunk keeps flashing red.
 *   ask    — while it flashes, the set's read goes out across the border and
 *            the post-set read comes back, writing itself out as you scroll.
 *
 * Every animation here is SCRUBBED by the scroll: `flowAt(u)` is a pure
 * function of how far through the hold the reader is. Each sweep and blink of
 * the scan, each point popping in, the turn, each rep and each red flash moves
 * only as the reader scrolls; stop scrolling and it freezes, scroll back and it
 * plays backwards. (Two earlier versions played each step on the clock once
 * reached — a fast scroll skipped the scan and the points, and making the
 * scene wait for them instead felt like a bug. Lenis smooths the scroll, so a
 * wheel scrubs without stutter.)
 */

export type FlowStepId = "camera" | "points" | "view" | "reps" | "ask";

/** Where each step starts, as a share of the flow stop's hold. */
export const FLOW_STEPS: readonly { id: FlowStepId; from: number }[] = [
  { id: "camera", from: 0 },
  { id: "points", from: 0.17 },
  { id: "view", from: 0.34 },
  { id: "reps", from: 0.53 },
  { id: "ask", from: 0.7 },
];
export const STEP = Object.fromEntries(FLOW_STEPS.map((s, i) => [s.id, i])) as Record<FlowStepId, number>;

/** The step at `u` through the hold: −1 before the hold starts (on the way in),
 *  the last step after it ends (on the way out). */
export function flowStepAt(u: number): number {
  if (u < 0) return -1;
  let i = 0;
  while (i < FLOW_STEPS.length - 1 && u >= FLOW_STEPS[i + 1].from) i++;
  return i;
}

/** Through the hold, where the post-set read starts and finishes writing
 *  itself out: after the stream has had a moment to go out, done before the
 *  hold ends. Scrubbed, like the debrief it replaced. */
export const READ_FROM = 0.74;
export const READ_TO = 0.97;
export const readAt = (u: number) => Math.min(1, Math.max(0, (u - READ_FROM) / (READ_TO - READ_FROM)));

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/* ── the scan ─────────────────────────────────────────────────────────────── */

/** A line sweeps down the body and lights everything the phone faces… */
export const SCAN_SWEEP_S = 0.8;
/** …which then blinks off and on twice… */
export const SCAN_BLINK_S = 0.15;
export const SCAN_BLINKS = 2;
/** …and fades. */
export const SCAN_FADE_S = 0.35;
export const SCAN_S = SCAN_SWEEP_S + SCAN_BLINKS * 2 * SCAN_BLINK_S + SCAN_FADE_S;
/** How lit the scanned front is while a blink is off. */
const BLINK_OFF = 0.1;

export type Scan = { amount: number; sweep: number };

/** The scan `t` seconds after it started: how lit the front is (0…1), and how
 *  far down the body the sweep has come (0 top → 1 bottom). */
export function scanAt(t: number, out: Scan = { amount: 0, sweep: 0 }): Scan {
  if (t < 0 || t >= SCAN_S) {
    out.amount = 0;
    out.sweep = 1;
    return out;
  }
  if (t < SCAN_SWEEP_S) {
    out.amount = 1;
    out.sweep = smooth(t / SCAN_SWEEP_S);
    return out;
  }
  out.sweep = 1;
  const b = t - SCAN_SWEEP_S;
  const blinks = SCAN_BLINKS * 2 * SCAN_BLINK_S;
  if (b < blinks) {
    out.amount = Math.floor(b / SCAN_BLINK_S) % 2 === 0 ? BLINK_OFF : 1;
    return out;
  }
  out.amount = 1 - smooth((b - blinks) / SCAN_FADE_S);
  return out;
}

/* ── the 33 points ────────────────────────────────────────────────────────── */

/** The pose model's 33 landmarks, in its own order (0 nose … 32 right toe). */
export const LANDMARK_COUNT = 33;

/** Pairs of landmarks joined when they're drawn: the pose model's own
 *  connections — face, arms and hands, trunk, legs and feet. */
export const LANDMARK_LINKS: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [24, 26], [25, 27], [26, 28], [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
];

/** Points are marked one after another, head to toe… */
export const MARK_STAGGER_S = 0.028;
export const MARK_POP_S = 0.16;
/** …then joined, each line drawn out from its first point. */
export const LINE_FROM_S = LANDMARK_COUNT * MARK_STAGGER_S + 0.05;
export const LINE_STAGGER_S = 0.014;
export const LINE_GROW_S = 0.22;
/** How fast the points fade when the reader moves on (or back). */
export const MARKS_FADE_S = 0.35;

/** Landmark `i`, `t` seconds after marking began: 0 unmarked → 1 marked. */
export const markAt = (i: number, t: number) => smooth((t - i * MARK_STAGGER_S) / MARK_POP_S);
/** Link `k`, `t` seconds after marking began: 0 undrawn → 1 drawn. */
export const linkAt = (k: number, t: number) => smooth((t - LINE_FROM_S - k * LINE_STAGGER_S) / LINE_GROW_S);

/* ── the turn to the side ─────────────────────────────────────────────────── */

/** The body turns a quarter to the phone: its side view. The page's camera is
 *  at 45° to both (lib/story, the flow's shot). Negative: it turns to face the
 *  page's camera side, so the page sees its front three-quarter both ways. */
export const TURN = -Math.PI / 2;
/** After the points have faded, the turn takes… */
export const TURN_DELAY_S = 0.3;
export const TURN_S = 1.1;
/** …and the side-on scan starts as it finishes. */
export const SIDE_SCAN_AT_S = TURN_DELAY_S + TURN_S + 0.1;

/** Zero velocity and acceleration at both ends. */
export const smoother = (t: number) => {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/* ── the flagged squat ───────────────────────────────────────────────────── */

/** The rep the body plays over and over, side-on: forward lean, the fault a
 *  side view can see. */
export const FLOW_REP = "lean";
/** Seconds per rep: a touch quicker than the squat stop's 3 s. */
export const FLOW_REP_S = 2.4;
/** The set the post-set read describes (lib/postSet): two clean reps set the
 *  baseline — the app measures against your own first two — then the lean. */
export const FLOW_SET: readonly string[] = ["clean", "clean", "lean", "lean", "lean"];

/** The trunk keeps flashing red while the lean is flagged: on/off, soft-edged,
 *  twice a rep. (Scrubbed by the scroll, the old 1.4 a second came to a flash
 *  every ~40 px — a flicker, not a flash you scroll through.) */
export const FLASH_HZ = 2 / FLOW_REP_S;
export function flashAt(t: number): number {
  const ph = (((t * FLASH_HZ) % 1) + 1) % 1;
  const on = ph < 0.55 ? smooth(ph / 0.08) : 1 - smooth((ph - 0.55) / 0.1);
  return 0.18 + 0.82 * on;
}

/* ── the phone's own readout ─────────────────────────────────────────────── */

/** What the tag over the phone says at each step. */
export const PHONE_SAYS: Record<FlowStepId, string> = {
  camera: "Front view · scanning",
  points: "33 points",
  view: "Side view · locked",
  reps: "Rep flagged · forward lean",
  ask: "Sending a few frames",
};

/* ── the scrub: every animation as a function of the scroll ────────────── */

/**
 * How much animation each step holds, in SCRIPT SECONDS — the natural timings
 * above. A step's share of the hold plays exactly this much, so a step with
 * more going on moves faster per screen of scroll; each is padded a little so
 * its animation has finished before the next step starts.
 */
export const FLOW_DUR: Record<FlowStepId, number> = {
  // The front scan: sweep, blinks, fade.
  camera: SCAN_S + 0.25,
  // Every point marked and every line drawn, then a beat with them joined.
  points: LINE_FROM_S + (LANDMARK_LINKS.length - 1) * LINE_STAGGER_S + LINE_GROW_S + 0.3,
  // The points fade, the turn, then the side-on scan to its end.
  view: SIDE_SCAN_AT_S + SCAN_S + 0.2,
  // Two flagged reps.
  reps: 2 * FLOW_REP_S,
  // (The squat carries on through the ask step at the reps step's pace.)
  ask: 0,
};
/** How far into the reps step the squat has blended in from standing, s. */
const SQUAT_IN_S = 0.6;
/** Dots going out across the border, over the ask step's scroll. */
export const STREAM_CYCLES = 6;

/** Where the scene is at one point of the scroll. */
export type FlowFrame = {
  /** The step, −1 before the hold. */
  step: number;
  /** The phone's scan (scanAt). */
  scan: number;
  sweep: number;
  /** The 33 points: how visible (0…1), and script seconds since marking began. */
  marks: number;
  marksT: number;
  /** 0…1 of the quarter turn to the side view (eased). */
  turn: number;
  /** 0…1 how far the squat has blended in, and script seconds into it. */
  squat: number;
  squatT: number;
  /** 0…1 how lit the flagged trunk is. */
  flash: number;
  /** Cycles of the stream going out across the border (0 before the ask step). */
  stream: number;
};

export const newFlowFrame = (): FlowFrame => ({
  step: -1,
  scan: 0,
  sweep: 1,
  marks: 0,
  marksT: 0,
  turn: 0,
  squat: 0,
  squatT: 0,
  flash: 0,
  stream: 0,
});

const stepLen = (i: number) => (FLOW_STEPS[i + 1]?.from ?? 1) - FLOW_STEPS[i].from;
/** Script seconds into step `i` at `u` (unclamped: before it is negative). */
const stepT = (u: number, i: number) => ((u - FLOW_STEPS[i].from) / stepLen(i)) * FLOW_DUR[FLOW_STEPS[i].id];

const _scan: Scan = { amount: 0, sweep: 1 };

/** The whole scene at `u` through the flow stop's hold (lib/story `holdAt`). */
export function flowAt(u: number, out: FlowFrame = newFlowFrame()): FlowFrame {
  const step = flowStepAt(u);
  out.step = step;
  // The scan: the front one through the camera step, the side one late in the
  // view step, once the body has turned.
  out.scan = 0;
  out.sweep = 1;
  if (step === STEP.camera) scanAt(stepT(u, STEP.camera), _scan);
  else if (step === STEP.view) scanAt(stepT(u, STEP.view) - SIDE_SCAN_AT_S, _scan);
  else _scan.amount = 0;
  if (step === STEP.camera || step === STEP.view) {
    out.scan = _scan.amount;
    out.sweep = _scan.sweep;
  }
  // The points: popped in one by one through their step, faded at the start
  // of the next.
  out.marks = 0;
  out.marksT = 0;
  if (step === STEP.points) {
    out.marks = 1;
    out.marksT = stepT(u, STEP.points);
  } else if (step === STEP.view) {
    out.marks = 1 - smooth(stepT(u, STEP.view) / MARKS_FADE_S);
    out.marksT = FLOW_DUR.points;
  }
  // The quarter turn, once the points have gone; held from then on.
  out.turn = step < STEP.view ? 0 : step > STEP.view ? 1 : smoother((stepT(u, STEP.view) - TURN_DELAY_S) / TURN_S);
  // The flagged squat, from the reps step on at one pace — it carries on
  // through the ask step while the read goes out and comes back.
  const squatT = step >= STEP.reps ? stepT(u, STEP.reps) : 0;
  out.squatT = Math.max(0, squatT);
  out.squat = step >= STEP.reps ? smooth(out.squatT / SQUAT_IN_S) : 0;
  out.flash = step >= STEP.reps ? flashAt(out.squatT) * out.squat : 0;
  out.stream = step >= STEP.ask ? Math.max(0, (u - FLOW_STEPS[STEP.ask].from) / stepLen(STEP.ask)) * STREAM_CYCLES : 0;
  return out;
}
