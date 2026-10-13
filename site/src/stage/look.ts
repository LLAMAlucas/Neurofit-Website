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
  /** Skeleton: its colour (the bones stay white while the thrown flesh runs blue). */
  skelColor: string;
  /** Particle diameter in millimetres, before per-particle variation. */
  size: number;
  /** The points' colour at rest (the name is from the fog look, when they were dark). */
  graphite: string;
  /** How much light one grain adds — the body is drawn additively on black. */
  intensity: number;
  /** Near = bright, far = dim: half the depth (m) over which the body fades front to back. */
  nearFar: number;
  /** The far side's brightness, × the near side's. */
  farDim: number;
  /** The depth prepass: how far behind the skin it writes, metres — too thin and the far side
   *  shows through, too thick and the body reads solid. */
  shell: number;
  /** The depth prepass on/off — off for an A/B of the see-through body. */
  selfOcclude: boolean;
  rimColor: string;
  /** How strongly silhouette edges catch the light, 0…1. */
  rim: number;
  red: string;
  /** How far past full red a faulted particle is pushed — what bloom picks up. */
  glow: number;
  /** Fault falloff radius in metres, before severity. */
  radius: number;
  /** 0…1: how bad a faulty rep is. Scales the pose AND the red. */
  severity: number;
  opacity: number;
  fogColor: string;
  fog: number;
  bloom: number;
  grain: number;
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
//
// On black (2026-10, the dragonfly.xyz theme) the user picked "cleaner glowing dots": the
// skin is evenly spaced (sampleSkinned EvenOptions) and drawn as light that adds up, the far
// side hidden by a depth prepass; the fill only shows while thrown; the fizz is gone and the
// idle current is a gentle breath (5 mm) instead of 20 mm — on black every stray grain shows.
export const DEFAULTS: Settings = {
  body: "male",
  count: 71000,
  interior: 0.3,
  flow: 5,
  churn: 0.8,
  fizz: 0,
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
  hotColor: "#8fb4e0",
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
  skelColor: "#f2f6fa",
  size: 9,
  graphite: "#cfd8e3",
  intensity: 0.55,
  nearFar: 0.45,
  farDim: 0.3,
  shell: 0.03,
  selfOcclude: true,
  rimColor: "#ffffff",
  rim: 0.8,
  red: "#ff2b2b",
  glow: 3,
  radius: 0.17,
  severity: 1,
  opacity: 1,
  fogColor: "#000000",
  fog: 0.08,
  bloom: 0.55,
  grain: 0.035,
  speed: 1,
  showMesh: false,
};
