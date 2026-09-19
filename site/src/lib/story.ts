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
 * left reading two stops at once, and the page settles into a hold whenever
 * they stop scrolling between two.
 */

export type StopId = "form" | "frame" | "squat" | "afterSet" | "afterWorkout" | "finale";

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
  /** The reader orbits the camera themselves here. */
  orbit?: boolean;
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
    shot: shot({ azimuth: 0.35, distance: 3.9, shift: [0.2, 0] }),
  },
  {
    id: "frame",
    label: "IN FRAME",
    span: 1.4,
    hold: [0.3, 0.7],
    // Pulled back and round to the side, so the phone on the floor, its cone
    // and the body it's looking at all fit.
    shot: shot({ azimuth: 1.05, elevation: 0.22, distance: 6.4, target: [0, 0.75, 1.1], shift: [0.16, 0] }),
  },
  {
    id: "squat",
    label: "SQUAT",
    span: 2,
    hold: [0.25, 0.8],
    // On a phone the words sit at the top here and the picker at the bottom,
    // so the body goes a little LOWER than on the other stops, not higher.
    shot: shot({
      azimuth: 0.35,
      elevation: 0.08,
      distance: 3.9,
      target: [0, 0.85, 0],
      shift: [-0.17, 0],
      narrowShift: [0, -0.03],
    }),
    orbit: true,
  },
  {
    id: "afterSet",
    label: "AFTER THE SET",
    span: 1.8,
    hold: [0.25, 0.8],
    // The body in the gap between the words on the left and the debrief
    // writing itself out on the right.
    shot: shot({ azimuth: 0.7, distance: 4.3, shift: [-0.04, 0] }),
  },
  {
    id: "afterWorkout",
    label: "AFTER THE WORKOUT",
    span: 1.6,
    hold: [0.3, 0.75],
    // Wide, nearly square-on — the knee cave is a front-view fault, and the
    // three sets have to show it — across the row of sets.
    shot: shot({
      azimuth: 0.08,
      elevation: 0.16,
      distance: 7.4,
      target: [-1.25, 0.85, 0],
      shift: [0.19, 0.02],
      narrowShift: [0, 0.16],
      // Three bodies side by side don't fit a phone held upright at 30°;
      // pulling back far enough instead would bury them in the fog.
      narrowFov: 46,
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

/**
 * Where to ease to when the reader stops scrolling: the nearer end of the
 * nearer hold, or null if they are already in one. Aiming at the hold's EDGE
 * (just inside it) rather than its middle moves the page as little as it can.
 */
export function settleTarget(pRaw: number): number | null {
  const p = Math.min(END, Math.max(0, pRaw));
  let best: number | null = null;
  for (const [a, b] of HOLDS) {
    if (p >= a && p <= b) return null;
    const edge = p < a ? a + 0.02 : b - 0.02;
    if (best === null || Math.abs(edge - p) < Math.abs(best - p)) best = edge;
  }
  return best;
}
