/**
 * The page as one camera path: where the camera is, what is in focus, and what
 * is on stage, as a pure function of how far down the page the reader is.
 *
 * PURE — no three, no DOM. The canvas and the text both read it, so they can't
 * disagree about which stop the reader is at, and `npm run check` can walk the
 * whole path without a browser.
 *
 * Units: scroll position in SCREENS (scrollY / viewport height). The page is
 * TOTAL screens tall and scrolls to END = TOTAL − 1.
 *
 * Each stop has a HOLD — a stretch of scroll where its shot is still and its
 * text is fully in focus — and between two holds the camera moves from one shot
 * to the next while the text racks focus: the old stop blurs out over the first
 * half of the move, the new one sharpens over the second. The reader is never
 * left reading two stops at once. The page does not snap: stop between two
 * holds and it stays there.
 */

import type { ExerciseId } from "./exercises";

export type StopId = "form" | "frame" | "flow" | "compare" | "finale";

/** Where the camera is for one stop. */
export type Shot = {
  /** Around the body, radians. 0 = in front, π/2 = at its side. */
  azimuth: number;
  elevation: number;
  /** From the target, metres. */
  distance: number;
  target: [number, number, number];
  /** Where the target sits on screen, as a share of the viewport from its
   *  centre (+x right, +y up). Moves the body out from under the text without
   *  changing the perspective. Wide screens only — see `narrowShift`. */
  shift: [number, number];
  /** On a portrait screen the text sits below the body instead of beside it. */
  narrowShift: [number, number];
  /** Vertical field of view, degrees. */
  fov: number;
  /** The same on a portrait screen, where a wide shot runs out of width long
   *  before it runs out of height. */
  narrowFov: number;
};

export type Stop = {
  id: StopId;
  /** The HUD's name for it. */
  label: string;
  /** Screens of scroll it takes. */
  span: number;
  /** Where in its span it holds still, as shares of the span. */
  hold: [number, number];
  shot: Shot;
  /** Reached through the iris: the camera cuts while it is closed, so the
   *  move in is a fly-through rather than a pan across the room. */
  throughIris?: boolean;
};

const shot = (s: Partial<Shot> & Pick<Shot, "azimuth" | "distance">): Shot => ({
  elevation: 0.1,
  target: [0, 0.92, 0],
  shift: [0, 0],
  narrowShift: [0, 0.14],
  fov: 30,
  narrowFov: s.fov ?? 30,
  ...s,
});

export const STOPS: readonly Stop[] = [
  {
    id: "form",
    label: "FORM",
    span: 1.2,
    hold: [0, 0.55],
    // Text on the left, the body standing off to the right of it.
    // On a phone the words sit on the bottom ~45% of the screen, so the body is
    // lifted and pulled back a touch to stand whole above them.
    shot: shot({ azimuth: 0.35, distance: 3.9, shift: [0.2, 0], narrowShift: [0, 0.24], narrowFov: 34 }),
  },
  // (The three exercise stops — squat, push-up, pull-up — and "what it watches
  // for" were removed on 2026-09-26; so were the two debrief stops on
  // 2026-09-25 — the post-set read now comes back at the end of the flow.)
  {
    id: "frame",
    label: "IN FRAME",
    span: 1.4,
    hold: [0.3, 0.7],
    // Pulled back and round to the side, so the phone on the floor, its cone
    // and the body it's looking at all fit.
    shot: shot({
      azimuth: 1.05,
      elevation: 0.22,
      distance: 6.4,
      target: [0, 0.75, 1.1],
      shift: [0.16, 0],
      // Above the words on a phone, as in the opening.
      narrowShift: [0, 0.22],
    }),
  },
  {
    id: "flow",
    label: "WHAT HAPPENS TO IT",
    // Its hold is five steps the scene plays one after another as the reader
    // scrolls through it (lib/flowScript) — scan, points, turn to the side and
    // scan again, a flagged squat, the read going out and coming back — every
    // bit of it scrubbed by the scroll. 1.7× the 2.8 screens it had: at ~0.4
    // screens a step the animations ran too fast under a scroll wheel; now
    // ~0.65–0.75 a step.
    span: 4.76,
    hold: [0.1, 0.9],
    // At 45° to the body the whole way: it starts facing the phone on the floor
    // in front of it, and turns 90° to it (the phone's side view) — from here
    // that's 45° either way. From this side the phone sits to the body's right
    // on screen, so the words go on the left and the two of them on the right;
    // on a phone the words fill the bottom, so body and phone go up.
    // Far enough back for both: the phone stands 2.4 m in front of the body,
    // which from 45° is ~1.7 m across the screen.
    shot: shot({
      azimuth: -Math.PI / 4,
      elevation: 0.16,
      distance: 6.2,
      target: [0, 0.8, 1.2],
      shift: [0.2, 0],
      // Closer on a phone than it was (44°): the steps now fit in a shorter
      // sheet, so the body and the phone can fill more of the room above it.
      narrowShift: [0, 0.26],
      narrowFov: 36,
    }),
  },
  {
    id: "compare",
    label: "HOW IT COMPARES",
    span: 1.8,
    hold: [0.25, 0.8],
    // The comparison on the left, the body standing on the right.
    shot: shot({
      azimuth: 0.25,
      elevation: 0.08,
      distance: 5,
      target: [0, 0.95, 0],
      shift: [0.24, 0],
      narrowShift: [0, 0.28],
    }),
  },
  {
    id: "finale",
    label: "TRY IT",
    span: 1.8,
    hold: [0.35, 1],
    // The body on its pedestal to the right, the call to action beside it —
    // centred, the two overlapped on every screen shorter than it was wide.
    shot: shot({ azimuth: 0, elevation: 0.06, distance: 4.8, target: [0, 1.05, 0], shift: [0.2, 0.02], narrowShift: [0, 0.2] }),
    throughIris: true,
  },
];

/**
 * What the body is doing at each stop: squatting, all the way down — it stands
 * for the opening and the setup, squats on cue in the flow, and stands on the
 * pedestal in the finale, reached through the iris.
 */
export const EXERCISE_AT: Record<StopId, ExerciseId> = {
  form: "squat",
  frame: "squat",
  flow: "squat",
  compare: "squat",
  finale: "squat",
};

export const STOP_COUNT = STOPS.length;
export const stopIndex = (id: StopId) => STOPS.findIndex((s) => s.id === id);

/** Screen offset of each stop's start. */
export const STARTS: readonly number[] = STOPS.map((_, i) =>
  STOPS.slice(0, i).reduce((sum, s) => sum + s.span, 0),
);
export const TOTAL = STARTS[STOP_COUNT - 1] + STOPS[STOP_COUNT - 1].span;
/** The furthest the page scrolls, in screens. */
export const END = TOTAL - 1;

/** Absolute hold of each stop, in screens. The last one runs to the end. */
export const HOLDS: readonly [number, number][] = STOPS.map((s, i) => [
  STARTS[i] + s.hold[0] * s.span,
  i === STOP_COUNT - 1 ? END : STARTS[i] + s.hold[1] * s.span,
]);

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Zero velocity AND acceleration at both ends: a camera move eased like this
 *  never jerks as it leaves or arrives at a hold. */
const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export type StorySample = {
  /** The stop the reader is at — in focus, or the nearer of two mid-move. */
  stop: number;
  /** Per stop, 0…1: how sharp its text is. */
  focus: number[];
  /** Per stop, 0…1: how far through its own stretch of the page the reader is
   *  (midpoint of the move in → midpoint of the move out). For content that is
   *  scrubbed rather than played, like the debrief writing itself. */
  local: number[];
  /** Per stop, 0…1: how present its props are on stage. Like focus but eased
   *  over the whole move, so a prop never pops. */
  presence: number[];
  /** The two stops the camera is between, and how far (eased). */
  from: number;
  to: number;
  blend: number;
  /** The iris, 0 open → 1 closed. */
  iris: number;
  /** A brief lift in exposure while the camera is moving between holds. */
  exposure: number;
  /** Extra metres the camera is pushed along its view on a fly-through. */
  dolly: number;
};

export function newSample(): StorySample {
  return {
    stop: 0,
    focus: new Array(STOP_COUNT).fill(0),
    local: new Array(STOP_COUNT).fill(0),
    presence: new Array(STOP_COUNT).fill(0),
    from: 0,
    to: 0,
    blend: 0,
    iris: 0,
    exposure: 0,
    dolly: 0,
  };
}

/** Where the camera is on the way through the iris: pushing in toward it as it
 *  closes, and on the far side, still travelling, as it opens. Metres. */
const IRIS_DOLLY = 2.2;

export function storyAt(pRaw: number, out: StorySample = newSample()): StorySample {
  const p = Math.min(END, Math.max(0, pRaw));
  out.focus.fill(0);
  out.presence.fill(0);
  out.iris = 0;
  out.dolly = 0;

  // Which hold, or which gap between two holds, the reader is in.
  let i = 0;
  while (i < STOP_COUNT - 1 && p > HOLDS[i][1]) i++;
  if (p >= HOLDS[i][0]) {
    // In stop i's hold.
    out.stop = i;
    out.from = out.to = i;
    out.blend = 0;
    out.focus[i] = 1;
    out.presence[i] = 1;
    out.exposure = 0;
  } else {
    // Between the hold of i−1 and the hold of i.
    const a = i - 1;
    const t = (p - HOLDS[a][1]) / (HOLDS[i][0] - HOLDS[a][1]);
    out.stop = t < 0.5 ? a : i;
    out.from = a;
    out.to = i;
    out.blend = smoother(t);
    out.focus[a] = 1 - smooth(0, 0.5, t);
    out.focus[i] = smooth(0.5, 1, t);
    out.presence[a] = 1 - smooth(0.2, 0.8, t);
    out.presence[i] = smooth(0.2, 0.8, t);
    out.exposure = Math.sin(Math.PI * t);
    if (STOPS[i].throughIris) {
      // Closing over the first half, open again by the end; the camera cuts
      // at the middle, behind the closed blades.
      out.iris = 1 - Math.abs(2 * t - 1);
      out.blend = t < 0.5 ? 0 : 1;
      out.dolly = t < 0.5 ? IRIS_DOLLY * smoother(2 * t) : -IRIS_DOLLY * (1 - smoother(2 * t - 1));
    }
  }

  // Each stop's own stretch: from the middle of the move in to the middle of
  // the move out.
  for (let k = 0; k < STOP_COUNT; k++) {
    const lo = k === 0 ? 0 : (HOLDS[k - 1][1] + HOLDS[k][0]) / 2;
    const hi = k === STOP_COUNT - 1 ? END : (HOLDS[k][1] + HOLDS[k + 1][0]) / 2;
    out.local[k] = clamp01((p - lo) / (hi - lo));
  }
  return out;
}

/**
 * How far through stop `i`'s hold the reader is: 0 at its start, 1 at its end,
 * below 0 on the way in and above 1 on the way out. For a stop whose hold is
 * itself a script, played by scroll (the flow).
 */
export function holdAt(pRaw: number, i: number): number {
  const p = Math.min(END, Math.max(0, pRaw));
  const [a, b] = HOLDS[i];
  return (p - a) / (b - a);
}

/** Interpolate two shots. Linear per component; the ease is in `blend`. */
export function mixShot(a: Shot, b: Shot, t: number, out: Shot): Shot {
  const l = (x: number, y: number) => x + (y - x) * t;
  out.azimuth = l(a.azimuth, b.azimuth);
  out.elevation = l(a.elevation, b.elevation);
  out.distance = l(a.distance, b.distance);
  out.target = [l(a.target[0], b.target[0]), l(a.target[1], b.target[1]), l(a.target[2], b.target[2])];
  out.shift = [l(a.shift[0], b.shift[0]), l(a.shift[1], b.shift[1])];
  out.narrowShift = [l(a.narrowShift[0], b.narrowShift[0]), l(a.narrowShift[1], b.narrowShift[1])];
  out.fov = l(a.fov, b.fov);
  out.narrowFov = l(a.narrowFov, b.narrowFov);
  return out;
}
