/**
 * The stage's shared state — the lab's and the site's, whichever page is
 * running. The scene writes it every frame and the HUD reads it every frame, so
 * it deliberately lives OUTSIDE React: sixty re-renders a second to move a
 * label would cost more than the particles do.
 */
import { newPose, type Pose } from "@/lib/poseFrames";
import type { ExerciseId } from "@/lib/exercises";
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
  /** 0…1: the body as a hologram (the finale). */
  holo: number;
  /** Metres the body is raised (onto the pedestal). */
  lift: number;
  /** Radians the body is turned about the vertical (the finale's slow turn). */
  spin: number;
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
  holo: 0,
  lift: 0,
  spin: 0,
  box: { x: 0, y: 0, w: 0, h: 0 },
  labels: [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ],
  labelY: 1.62,
  phone: { x: 0, y: 0 },
  faultFlash: 0,
};
