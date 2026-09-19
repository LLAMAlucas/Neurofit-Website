/**
 * The approved look of the particle body: every value the lab panel tunes.
 *
 * Shared by the lab (which starts from these and lets them be changed) and the
 * site (which uses them as they are). Change them here, not in either page.
 */

export type Settings = {
  body: "male" | "female";
  /** Particles on the body. */
  count: number;
  /** Share of the particles filling the inside, 0…1. The rest are skin. */
  interior: number;
  /** How far the idle current carries a particle around its home, millimetres. */
  flow: number;
  /** How fast the idle current changes. */
  churn: number;
  /** How far a loose surface grain lifts off now and then, millimetres. */
  fizz: number;
  /** Throw: share of the swipe's speed a particle picks up. */
  force: number;
  /** Throw: random share — how much a thrown stream fans out. */
  spray: number;
  /** Throw: brush radius, in screen heights. */
  brush: number;
  /** Seconds a thrown particle stays hot: glowing, and free of the body. */
  heat: number;
  /** Air drag on a particle in flight, 1/s. */
  drag: number;
  /** Gravity on a particle in flight, m/s². */
  gravity: number;
  /** Turbulence on a particle in flight, m/s². */
  swirl: number;
  /** How hard home pulls a particle back once it cools, rad/s. */
  pull: number;
  /** The invisible glass container thrown particles pile up against. */
  walls: boolean;
  /** Its half-width, metres. */
  room: number;
  /** What a hot particle glows. */
  hotColor: string;
  /** Forming: the cloud the body gathers out of — inner and outer radius, m. */
  formNear: number;
  formFar: number;
  /** Forming: hottest a grain starts, 0…1 (how long it drifts before home takes it). */
  formHeat: number;
  /** Forming: how fast the cloud turns as it gathers, rad/s. */
  formSpin: number;
  /** Forming: seconds between the first grain let go and the last. */
  formStagger: number;
  /** Forming: 0 = grains let go at random, 1 = from the feet up. */
  formRise: number;
  /** Skeleton: grains in the tracked skeleton a torn hole reveals. */
  skelCount: number;
  /** Skeleton: grain diameter, millimetres. */
  skelSize: number;
  /** Skeleton: brightness; past 1 the bloom gives it a halo. */
  skelGlow: number;
  /** Skeleton: how far the flesh around a grain must be thrown before it
   *  starts to show, and by when it shows fully — centimetres. */
  revealFrom: number;
  revealTo: number;
  /** Skeleton: show all of it, always (tuning only). */
  skelAlways: boolean;
  /** Particle diameter in millimetres, before per-particle variation. */
  size: number;
  graphite: string;
  rimColor: string;
  /** How strongly silhouette edges catch the light, 0…1. */
  rim: number;
  red: string;
  /** How far past full red a faulted particle is pushed — what bloom picks up. */
  glow: number;
  /** Fault falloff radius in metres, before severity. */
  radius: number;
  /** 0…1: how bad the picked fault is. Scales the pose AND the red. */
  severity: number;
  opacity: number;
  fogColor: string;
  fog: number;
  bloom: number;
  grain: number;
  /** Repeat the last-picked rep. */
  loop: boolean;
  /** Rep playback rate. 0 freezes a rep mid-way — for studying the peak. */
  speed: number;
  /** Draw the source mesh as a wireframe behind the particles. */
  showMesh: boolean;
};

// The approved look, set by hand in the lab panel on 2026-09-19. How it got
// here: 28k surface-only points at 7 mm read as TV static (the fog showed
// through the gaps), so the body got denser, a filled interior and a
// silhouette-only rim. The physics came from a frame-by-frame recording of
// igloo's hologram: a swipe throws a spraying stream the way it went, it hits
// the glass and the floor, stays white-hot a few seconds, then flows home.
// Untouched, the body still churns, as igloo's does where the cursor never
// went; the first idle motion, a 4 mm wobble, read as frozen.
export const DEFAULTS: Settings = {
  body: "male",
  count: 71000,
  interior: 0.55,
  flow: 20,
  churn: 2,
  fizz: 65,
  force: 0.5,
  spray: 0.25,
  brush: 0.13,
  heat: 3,
  drag: 2.2,
  gravity: 2.5,
  swirl: 4,
  pull: 3.7,
  walls: true,
  room: 0.9,
  hotColor: "#e6f2fb",
  formNear: 1.2,
  formFar: 3.2,
  formHeat: 0.35,
  formSpin: 0.5,
  formStagger: 0.9,
  formRise: 0.7,
  skelCount: 9000,
  skelSize: 6.5,
  skelGlow: 1.35,
  revealFrom: 3,
  revealTo: 10,
  skelAlways: false,
  size: 10.5,
  graphite: "#4e637e",
  rimColor: "#f2f4f6",
  rim: 0.7,
  red: "#ff2b2b",
  glow: 2.7,
  radius: 0.17,
  severity: 1,
  opacity: 0.95,
  fogColor: "#abc0d8",
  fog: 0.07,
  bloom: 0.9,
  grain: 0.06,
  loop: false,
  speed: 1,
  showMesh: false,
};
