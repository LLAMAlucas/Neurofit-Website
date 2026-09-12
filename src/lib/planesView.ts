/**
 * The jump-turn between the two camera positions, as a pure function of time.
 *
 * PURE — no React, no three, no DOM, so the offscreen check can assert the two
 * things that make it read as a body rather than as a tween: that the flight is
 * ballistic, and that nothing torques itself in mid-air.
 *
 * ── why the FIGURE turns, and not the camera ──────────────────────────────
 *
 * The section's claim is that one camera cannot read both planes. Orbiting the
 * camera says that, but it says it about a phone nobody moves — in practice the
 * lifter turns and the phone stays on the floor where they left it, which is
 * exactly what "your sets alternate between them" asks of them. So the body
 * turns, and it turns the way a body actually changes which way it faces: it
 * jumps.
 *
 * ── the physics, and which parts of it are real ───────────────────────────
 *
 * Real, and asserted in `check_rig`:
 *   · Flight is a parabola. Vertical acceleration is exactly -G from takeoff to
 *     landing, and the height and the hang time are not independent numbers —
 *     pick one and the other follows.
 *   · Angular velocity is CONSTANT in the air. There is nothing to push against
 *     once the feet leave, so the turn cannot ease out at the top the way a
 *     scripted rotation wants to; it arrives at square exactly on landing and
 *     stops because the floor stops it.
 *   · The rotation is therefore initiated on the GROUND, during the drive, and
 *     the ground twist is not a tuned number — it is whatever makes the angular
 *     velocity continuous at the instant of takeoff (see `GROUND_TWIST`).
 *   · The body counter-moves before it goes up and absorbs after it comes down.
 *     A jump that starts from a held position and lands rigid is the single
 *     clearest tell of animation that was never watched against a real one.
 *
 * Not real, deliberately: there is no arm swing. `poseAt` is shared with the
 * hero rig and its keyframes are the app's, not this section's — reaching in to
 * counter-rotate the arms here would fork the skeleton for one animation.
 */
import { VIEW_TOLERANCE_RAD } from "./rigTimeline";

const HALF_PI = Math.PI / 2;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/* ── the body ─────────────────────────────────────────────────────────────── */

/** Which way the figure faces: 0 presents its front to the camera, 1 its side. */
export const TURN_FOR: Record<"front" | "side", 0 | 1> = { front: 0, side: 1 };

export const rotOf = (facing: number) => facing * HALF_PI;

/**
 * How deep the figure is held between jumps.
 *
 * Not the bottom, and not standing. Standing, there is no squat to have an
 * opinion about; at the bottom the hips and knees are level and the cave is at
 * its least legible. Held partway down is where a knee falling in actually
 * shows, which is the only thing this figure is here to be looked at for.
 */
export const HOLD_DEPTH = 0.72;

/** The countermovement, the tuck at the apex, and the landing compression. */
export const DIP_DEPTH = 0.93;
export const TUCK_DEPTH = 0.5;
export const ABSORB_DEPTH = 0.9;

/**
 * The knees are caved at BOTH resting facings, at full amount.
 *
 * This is the load-bearing decision in the file and it survives the rewrite: the
 * fault is a property of the body, not of the camera, and a reader who jumps the
 * figure back to side-on is meant to be looking at a genuinely caved squat and
 * be unable to see it. What scales through the jump is only how much the knees
 * are bent — a cave is a thing that happens under flexion, so it eases off as
 * the legs straighten in the air and comes back as they load on landing. At both
 * ends of the jump `depth` is `HOLD_DEPTH` and this is 1.
 */
export const valgusFor = (depth: number) => clamp01(depth / HOLD_DEPTH);

/* ── the jump ─────────────────────────────────────────────────────────────── */

/** Metres per second squared. The figure's units are roughly metres, so this is
 *  the real number and not a scaled stand-in. */
export const G = 9.81;

/**
 * Apex height, in metres. A quarter of a metre is a turn-in-place hop, not a
 * jump for height — this is somebody changing which way they face between sets.
 *
 * Hang time is DERIVED from it. They are one fact, not two: a body that leaves
 * the ground at v is back on it after 2v/G whether the animation has time for
 * that or not, and picking both independently is what makes a jump read as
 * floaty or as weightless.
 */
export const JUMP_H = 0.18;
export const FLIGHT_S = Math.sqrt((8 * JUMP_H) / G);
/** Take-off velocity, likewise derived. */
export const V0 = (G * FLIGHT_S) / 2;

export const DIP_S = 0.26;
export const DRIVE_S = 0.17;
export const LAND_S = 0.18;
export const SETTLE_S = 0.26;

export const TAKEOFF_S = DIP_S + DRIVE_S;
export const LANDING_S = TAKEOFF_S + FLIGHT_S;
export const JUMP_S = LANDING_S + LAND_S + SETTLE_S;

/**
 * How much of the 90° is already done when the feet leave the floor.
 *
 * NOT a tuned number. In the air there is no torque, so angular velocity is
 * whatever it was at takeoff and stays there; on the ground the feet can twist
 * against the floor and it can build. For the two to meet without a kink, the
 * rate at the end of the drive has to equal the rate through the whole flight.
 *
 * With the drive's turn going as (s/D)² — angular velocity ramping linearly from
 * nothing, which is what a torque applied against the floor produces — that is
 *
 *     2·GT/D = (1 − GT)/T   ⟹   GT = D / (2T + D)
 *
 * Change either duration and this follows them. It is checked as a continuity
 * assertion rather than as a magnitude, because the magnitude is a consequence.
 */
export const GROUND_TWIST = DRIVE_S / (2 * FLIGHT_S + DRIVE_S);

export type JumpSample = {
  /** Height of the whole body above the floor, metres. Zero unless airborne. */
  y: number;
  /** Squat depth, 0 = standing tall, 1 = bottom. */
  depth: number;
  /** 0…1 through the 90°. */
  turn: number;
  airborne: boolean;
};

/** Standing between jumps, facing wherever it last landed. */
export const REST: JumpSample = { y: 0, depth: HOLD_DEPTH, turn: 0, airborne: false };

/** @param t seconds since the jump began. */
export function jumpAt(t: number): JumpSample {
  if (t <= 0) return REST;

  // Countermovement. Nothing turns yet — the twist needs the floor, and the
  // floor is busy being pushed away from.
  if (t < DIP_S) {
    return {
      y: 0,
      depth: mix(HOLD_DEPTH, DIP_DEPTH, smoothstep(0, 1, t / DIP_S)),
      turn: 0,
      airborne: false,
    };
  }

  // The drive. Legs extend fastest at the very end, which is what puts the body
  // at its greatest upward speed at the exact instant the feet leave.
  if (t < TAKEOFF_S) {
    const u = (t - DIP_S) / DRIVE_S;
    return {
      y: 0,
      depth: DIP_DEPTH * (1 - u * u),
      turn: GROUND_TWIST * u * u,
      airborne: false,
    };
  }

  // Flight. A parabola and a constant rate of turn, and nothing else is
  // available: there is nothing to push against.
  if (t < LANDING_S) {
    const tau = t - TAKEOFF_S;
    const y = V0 * tau - 0.5 * G * tau * tau;
    return {
      y,
      // Legs tuck toward the apex and reach again for the floor — zero at both
      // ends, so the landing is met with a straight leg rather than a folded one.
      depth: TUCK_DEPTH * Math.sin((Math.PI * tau) / FLIGHT_S),
      turn: GROUND_TWIST + (1 - GROUND_TWIST) * (tau / FLIGHT_S),
      /* Derived from the height itself, not from a second condition that ought
         to agree with it. At the instant of takeoff the feet are still touching,
         and one float-width either side of that instant `tau > 0` and `y > 0`
         are not the same predicate — the height comes out at 1e-16 while the
         branch has already committed to the air. One source, no seam. */
      airborne: y > 0,
    };
  }

  // Landing. Square already, and compressing — the turn is over because the
  // floor is what ends it.
  if (t < LANDING_S + LAND_S) {
    const u = (t - LANDING_S) / LAND_S;
    return { y: 0, depth: ABSORB_DEPTH * (1 - (1 - u) * (1 - u)), turn: 1, airborne: false };
  }

  // Back up to the held position.
  if (t < JUMP_S) {
    const u = (t - LANDING_S - LAND_S) / SETTLE_S;
    return {
      y: 0,
      depth: mix(ABSORB_DEPTH, HOLD_DEPTH, smoothstep(0, 1, u)),
      turn: 1,
      airborne: false,
    };
  }

  return { ...REST, turn: 1 };
}

/* ── what the camera can resolve ──────────────────────────────────────────── */

/**
 * The frontal reading is GATED on the camera being square to it, not faded
 * through the turn.
 *
 * The app returns "unknown" for any check whose plane it is more than its view
 * tolerance off square to, because frontal geometry viewed edge-on is UNDEFINED
 * rather than merely noisy — the same arithmetic that reports a real 12°
 * shoulder tilt reports 87° about a level pair of shoulders from the side. So
 * for almost the whole jump the figure carries no reading at all, which is what
 * "it says which of the two it's looking at" looks like when you draw it.
 *
 * The fade inside the gate exists only so the reading does not pop on; it is
 * finished well before the body is far enough round to misread anything.
 */
export const frontalFor = (rotY: number) =>
  1 - smoothstep(VIEW_TOLERANCE_RAD * 0.35, VIEW_TOLERANCE_RAD, Math.abs(rotY));

/* ── the camera ───────────────────────────────────────────────────────────── */

/**
 * Fixed. It does not orbit, push in, or follow the body up — it is a phone
 * propped against a wall, which is the premise of the entire product.
 *
 * Lives here rather than in the component so the offscreen framing check frames
 * the same shot the scene does: a square lens has no aspect to hide behind, and
 * the silhouette is at its widest partway through the turn rather than at either
 * end, which is not something you can eyeball at two tab positions.
 */
export const PLANES_FOV = 32;
export const PLANES_CAM_Y = 0.86;
export const PLANES_CAM_Z = 3.35;
/**
 * Aimed ABOVE the held squat's mid-height, so the figure sits low in the lens
 * with the top quarter of the frame empty.
 *
 * That empty quarter is not slack composition, it is the jump's room. Framed on
 * the resting figure the way a still portrait would be, the head leaves the top
 * of the lens at the apex; framed on the union of resting and airborne, the
 * resting figure — which is what the reader looks at for all the time in
 * between — sits marooned in the middle of a box with air on both sides. This
 * is the shot that composes the pose it holds and lends the rest to the pose it
 * passes through.
 */
export const PLANES_TARGET_Y = 0.8;
