/**
 * The marketing site's menu opens the tracker on an exercise — try.neurofit-training.com/?exercise=pushup.
 * The link wins over the stored choice for that one visit; App then strips the parameter so a reload
 * (or a bookmark) doesn't keep overriding what the lifter picks afterwards.
 *
 * PURE (URLSearchParams only) — tested by check:squat.
 */
import type { ExerciseId } from "./types";

export const EXERCISE_PARAM = "exercise";

export function exerciseFromSearch(search: string): ExerciseId | null {
  const v = new URLSearchParams(search).get(EXERCISE_PARAM);
  return v === "squat" || v === "pushup" || v === "pullup" ? v : null;
}

/** The same query string without the exercise parameter ("" when nothing else is left). */
export function withoutExerciseParam(search: string): string {
  const p = new URLSearchParams(search);
  p.delete(EXERCISE_PARAM);
  const s = p.toString();
  return s ? `?${s}` : "";
}
