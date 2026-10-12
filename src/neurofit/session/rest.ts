/**
 * Rest between sets — bookkeeping + the Gemini payload fields. PURE module (no React/DOM).
 * ----------------------------------------------------------------------------
 * The rest timer starts when a set ends (hand signal or End set button) and stops when the lifter
 * taps "Start next set". It is recorded against the set that FOLLOWS it: rest before set N is known
 * only once set N starts, so set N's post-set call (fired when set N ends) carries the rest that
 * PRECEDED it — exactly what's needed to read "slowed after a short rest".
 *
 * Seconds are a real unit, so unlike the normalized ratios the model may quote them. Everything is
 * `null` (never 0) for set 1 or an unmeasured rest: 0 would read as "no rest at all".
 */
import { velocityBand } from "../squat/checks";
import type { VelocityBand } from "../squat/config";

export type SetEndedBy = "hand_signal" | "end_set_button";

export interface RestEntry {
  restSec: number;
  /** How the set BEFORE this rest was ended. The button undercounts more: the walk to the device
   *  happened before the click, so it isn't in the timer. */
  measuredFrom: SetEndedBy;
}

/** Rest entries keyed by the set that FOLLOWS the rest (set 1 never has one). */
export type RestLog = ReadonlyMap<number, RestEntry>;

/** The fields every exercise's set record shares that the rest summary reads. */
export interface RestSetLike {
  index: number;
  reps: readonly { counted: boolean; landmarkUnreliable?: boolean; velocity?: { ratio: number | null } | null }[];
}

export interface PostSetRest {
  /** Seconds rested before THIS set (null on set 1 / unmeasured). Quotable. */
  rest_before_this_set_sec: number | null;
  measured_from: SetEndedBy | null;
  /** The set before this one, for a "fewer reps than last set" comparison. null on set 1. */
  previous_set: {
    set_number: number;
    reps_counted: number;
    reps_attempted: number;
    velocity_band: VelocityBand | null;
    /** Seconds rested before the PREVIOUS set (null when unmeasured). */
    rest_before_sec: number | null;
  } | null;
}

export interface RestBySetEntry {
  set_number: number;
  rest_before_sec: number | null;
  measured_from: SetEndedBy | null;
  /** The set's own counted/attempted reps — the post-workout payload has no other per-set rep
   *  count, and rule 5c compares a set against the one before it. */
  reps_counted: number;
  reps_attempted: number;
}

export const NO_REST: PostSetRest = { rest_before_this_set_sec: null, measured_from: null, previous_set: null };

/** Same band the post-set payloads send, over the set's reliable reps' slowest ratio. */
export function setVelocityBand(set: RestSetLike): VelocityBand | null {
  let min: number | null = null;
  for (const r of set.reps) {
    if (r.landmarkUnreliable) continue;
    const v = r.velocity?.ratio ?? null;
    if (v !== null && (min === null || v < min)) min = v;
  }
  return velocityBand(min);
}

function restSec(log: RestLog, setIndex: number): number | null {
  const e = log.get(setIndex);
  return e && Number.isFinite(e.restSec) ? Math.round(e.restSec) : null;
}

/** The post-set `rest` block for `set`, given every set so far (to find the one before it). */
export function buildPostSetRest(set: RestSetLike, allSets: readonly RestSetLike[], log: RestLog): PostSetRest {
  const prev = allSets.find((s) => s.index === set.index - 1) ?? null;
  return {
    rest_before_this_set_sec: restSec(log, set.index),
    measured_from: log.get(set.index)?.measuredFrom ?? null,
    previous_set: prev
      ? {
          set_number: prev.index,
          reps_counted: prev.reps.filter((r) => r.counted).length,
          reps_attempted: prev.reps.length,
          velocity_band: setVelocityBand(prev),
          rest_before_sec: restSec(log, prev.index),
        }
      : null,
  };
}

/** The post-workout `rest_by_set` list (one entry per set sent, set 1 null). */
export function buildRestBySet(sets: readonly RestSetLike[], log: RestLog): RestBySetEntry[] {
  return sets.map((s) => ({
    set_number: s.index,
    rest_before_sec: restSec(log, s.index),
    measured_from: log.get(s.index)?.measuredFrom ?? null,
    reps_counted: s.reps.filter((r) => r.counted).length,
    reps_attempted: s.reps.length,
  }));
}

/** "m:ss" for the on-screen timer. */
export function formatRest(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
