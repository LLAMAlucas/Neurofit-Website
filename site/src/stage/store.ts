/**
 * The stage's shared state — the lab's and the site's, whichever page is
 * running. The scene writes it every frame and the HUD reads it every frame, so
 * it deliberately lives OUTSIDE React: sixty re-renders a second to move a
 * label would cost more than the particles do.
 */
import { newPose, type Pose } from "@/lib/poseFrames";
import type { ExerciseId } from "@/lib/exercises";
import { newBarFrame, type BarFrame } from "@/lib/barbellScript";
import { DEFAULTS, type Settings } from "./look";

export { DEFAULTS, type Settings };

export type StageStore = {
  settings: Settings;
  /** The exercise the body is doing (or resting in). */
  exercise: ExerciseId;
  /** The check of the rep in progress: which part of the body its red is on. */
  check: string;
  /** The check the stop's list lights, or null. */
  lit: string | null;
  /** Seconds into the exercise's scripted loop. */
  loopClock: number;
  /** Reps counted so far in the loop's set. */
  reps: number;
  /** The exercise's two live angles, degrees. */
  readA: number;
  readB: number;

  /** First frame of the body has rendered. */
  ready: boolean;
  /** Bump to scatter the body into the fog and have it form again. Starts at
   *  1, so a page's first frame forms it. */
  formNonce: number;
  /** Bump to blow the body apart where it stands: every particle is let go,
   *  thrown outward, and flows home to wherever the body is next — the change
   *  from one exercise to the next. */
  burstNonce: number;

  /** Camera around the body, radians. 0 = in front, π/2 = at its side. Only
   *  the lab orbits; the site's camera follows the scroll. */
  azimuth: number;
  elevation: number;
  dragging: boolean;
  /** Is the pointer over the stage (for the cursor push). */
  pointerInside: boolean;
  /** Where it is, in NDC (−1…1, y up). Written by whichever page owns the
   *  input — the canvas sits BEHIND the site's text, so it can't be the one
   *  listening. */
  pointer: { x: number; y: number };

  pose: Pose;
  /** 0…1 how present the current rep's fault is in the pose. */
  envelope: number;

  /* ── the site only; the lab leaves these at rest ─────────────────────── */
  /** How far down the page the reader is, in screens (lib/story). */
  progress: number;
  /** Particles drawn, 0 = all. A slower device draws a prefix — the sampler
   *  spreads skin and fill evenly through the order, so a prefix is the body. */
  drawCount: number;
  /** 0…1: the ghost copies of the body, one per earlier set. */
  ghosts: number;
  /** 0…1: the phone on the floor and its view. */
  cone: number;
  /** 0…1: the pull-up bar. */
  bar: number;
  /** 0 open → 1 closed: the iris the camera flies through into the finale. */
  iris: number;
  /** 0 open → 1 closed: the iris a menu jump goes through (hooks/scrollControl). The scene shows
   *  the more closed of the two. */
  jumpIris: number;
  /** The top bar's menu is open — the stage copies its frame for the menu's ASCII panel. */
  menuOpen: boolean;
  /** 0…1: the body as a hologram (the finale). */
  holo: number;
  /** Metres the body is raised (onto the pedestal). */
  lift: number;
  /** Radians the body is turned about the vertical (the finale's slow turn). */
  spin: number;

  /* ── the flow stop (lib/flowScript) ──────────────────────────────────── */
  /** Which of its steps the reader is on, −1 off the stop. */
  flowStep: number;
  /** Cycles of the dots going out across the border — scrubbed by scroll. */
  flowStream: number;
  /** Radians the body is turned to the phone: its side view. */
  turn: number;
  /** 0…1: the phone on the floor, without its view (the flow shows the phone
   *  and draws the scan itself). */
  phoneShow: number;
  /** The phone's scan: how lit the front it faces is (0…1), and the sweep
   *  line's height, metres (world). */
  scan: number;
  scanY: number;
  /** 0…1: the 33 points and their lines, and seconds since they started being
   *  marked (each point and line pops in on its own clock). */
  marks: number;
  marksClock: number;
  /** The 33 points, xyz in the body's own space — written by the body each
   *  frame from its posed bones, drawn by Landmarks. */
  landmarks: Float32Array;
  /** The glass box around the body on screen, CSS px — the only place a touch
   *  throws particles instead of scrolling the page. */
  box: { x: number; y: number; w: number; h: number };
  /** Screen positions (CSS px) of the labels over the ghosts and the body, and
   *  of the phone, for the HUD; and the height, metres, the labels sit at. */
  labels: { x: number; y: number }[];
  labelY: number;
  phone: { x: number; y: number };
  /** Bumped each time a fault first lights up (for the sound and the flash). */
  faultFlash: number;

  /* ── the barbell stop (lib/barbellScript) ────────────────────────────── */
  /** 0…1: the barbell on the body's back, and the hands on it. */
  barbell: number;
  /** Where the stop's script is: the step, the set's clock, the ring, the
   *  trail, the reps done… — scrubbed by the scroll. */
  barFrame: BarFrame;
  /** The bar's centre, in our pose's space (it lies along X). */
  barY: number;
  barZ: number;
  /** What the feet anchor adds to a point of our pose to put it on the
   *  model — written by the body each frame, so what's drawn from the pose
   *  (the bar, its path) lands on the body as posed. */
  bodyOffset: [number, number, number];
  /** Where the tag over the bar goes, CSS px. */
  barTag: { x: number; y: number };
};

export const store: StageStore = {
  settings: { ...DEFAULTS },
  exercise: "squat",
  check: "clean",
  lit: null,
  loopClock: 0,
  reps: 0,
  readA: 0,
  readB: 0,
  ready: false,
  formNonce: 1,
  burstNonce: 0,
  azimuth: 0.35,
  elevation: 0.1,
  dragging: false,
  pointerInside: false,
  pointer: { x: 0, y: 0 },
  pose: newPose(),
  envelope: 0,
  progress: 0,
  drawCount: 0,
  ghosts: 0,
  cone: 0,
  bar: 0,
  iris: 0,
  jumpIris: 0,
  menuOpen: false,
  holo: 0,
  lift: 0,
  spin: 0,
  flowStep: -1,
  flowStream: 0,
  turn: 0,
  phoneShow: 0,
  scan: 0,
  scanY: 0,
  marks: 0,
  marksClock: 0,
  landmarks: new Float32Array(33 * 3),
  box: { x: 0, y: 0, w: 0, h: 0 },
  labels: [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ],
  labelY: 1.62,
  phone: { x: 0, y: 0 },
  faultFlash: 0,
  barbell: 0,
  barFrame: newBarFrame(),
  barY: 0,
  barZ: 0,
  bodyOffset: [0, 0, 0],
  barTag: { x: 0, y: 0 },
};
