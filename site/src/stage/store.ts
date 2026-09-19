/**
 * The stage's shared state — the lab's and the site's, whichever page is
 * running. The scene writes it every frame and the HUD reads it every frame, so
 * it deliberately lives OUTSIDE React: sixty re-renders a second to move a
 * label would cost more than the particles do.
 */
import { newPose, type Pose } from "@/lib/poseFrames";
import type { FaultId } from "@/lib/faultDemo";
import { DEFAULTS, type Settings } from "./look";

export { DEFAULTS, type Settings };

export type Phase = "idle" | "aligning" | "rep";

export type StageStore = {
  settings: Settings;
  phase: Phase;
  /** The fault of the rep in progress, or of the last one. */
  fault: FaultId;
  /** Seconds into the rep in progress. */
  repClock: number;
  reps: number;
  /** Picker → scene: a rep has been asked for. */
  request: FaultId | null;
  /** Seconds the last rep's tag lingers after it ends. */
  tagHold: number;
  /** Seconds until a looping rep restarts. */
  loopWait: number;

  /** First frame of the body has rendered. */
  ready: boolean;
  /** Bump to scatter the body into the fog and have it form again. Starts at
   *  1, so a page's first frame forms it. */
  formNonce: number;

  /** Camera around the body, radians. 0 = in front, π/2 = at its side. */
  azimuth: number;
  elevation: number;
  /** Where the camera actually is this frame: the orbit plus the cursor's
   *  parallax. This, not `azimuth`, is what decides whether a fault is visible —
   *  the red must answer to the view on screen, not the one being aimed for. */
  viewAzimuth: number;
  /** Where a picked fault is gliding the camera to. Null once the user drags. */
  targetAzimuth: number | null;
  dragging: boolean;
  /** Is the pointer over the stage (for the cursor push). */
  pointerInside: boolean;
  /** Where it is, in NDC (−1…1, y up). Written by whichever page owns the
   *  input — the canvas sits BEHIND the site's text, so it can't be the one
   *  listening. */
  pointer: { x: number; y: number };

  pose: Pose;
  /** 0…1 how present the current fault is in the pose. */
  envelope: number;
  /** 0…1 whether the camera can judge the current fault's plane. */
  visibility: number;
  knee: number;
  trunk: number;
  /** Screen position (CSS px) of the fault's centre, for the HUD's leader line. */
  anchor: { x: number; y: number };

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
   *  of the phone, for the HUD. */
  labels: { x: number; y: number }[];
  phone: { x: number; y: number };
  /** Bumped each time a fault first lights up in view (for the sound). */
  faultFlash: number;
};

export const store: StageStore = {
  settings: { ...DEFAULTS },
  phase: "idle",
  fault: "clean",
  repClock: 0,
  reps: 0,
  request: null,
  tagHold: 0,
  loopWait: 0,
  ready: false,
  formNonce: 1,
  azimuth: 0.35,
  elevation: 0.1,
  viewAzimuth: 0.35,
  targetAzimuth: null,
  dragging: false,
  pointerInside: false,
  pointer: { x: 0, y: 0 },
  pose: newPose(),
  envelope: 0,
  visibility: 0,
  knee: 180,
  trunk: 0,
  anchor: { x: 0, y: 0 },
  progress: 0,
  drawCount: 0,
  ghosts: 0,
  cone: 0,
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
  phone: { x: 0, y: 0 },
  faultFlash: 0,
};
