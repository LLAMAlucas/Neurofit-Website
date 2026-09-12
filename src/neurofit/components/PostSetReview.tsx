/**
 * Between-set review overlay (phase "set-review"). Rendered OVER the still-mounted camera
 * stage so the MediaPipe model stays loaded for the next set. Two stages:
 *
 *   "choice"   — the end-of-set screen: [Next set] and [End workout]. NO analysis is fired
 *                yet. Post-set analysis fires ONLY when the user clicks "Next set".
 *   "post-set" — the user clicked "Next set", so the post-set analysis was requested; this
 *                shows its state (loading → text / none / disabled) and a control to actually
 *                begin the next set.
 *
 * It never triggers a Gemini call itself — onNextSet asks the hook to fire the post-set call;
 * the body only renders the persisted result. The last set is ended via [End workout] (which
 * fires the post-WORKOUT call instead), so it never generates a post-set.
 */
import type { PostSetReview as PostSetReviewState, SetReviewStage } from "../hooks/useWorkout";
import type { SetRecord } from "../session/types";

export function PostSetReview({
  stage,
  setIndex,
  set,
  review,
  onNextSet,
  onEndWorkout,
  onStartNextSet,
}: {
  stage: SetReviewStage;
  setIndex: number | null;
  set: SetRecord | undefined;
  review: PostSetReviewState | undefined;
  onNextSet: () => void;
  onEndWorkout: () => void;
  onStartNextSet: () => void;
}) {
  const counted = set ? set.reps.filter((r) => r.counted).length : 0;
  const attempts = set ? set.reps.length : 0;

  return (
    <div className="postset-review">
      <div className="postset-review__card">
        <p className="postset-review__eyebrow">
          SET {setIndex ?? "—"} COMPLETE{set ? ` · ${set.orientation.toUpperCase()} VIEW` : ""}
        </p>
        <p className="postset-review__tally">
          {counted}/{attempts} rep{attempts === 1 ? "" : "s"} counted
        </p>

        {stage === "choice" ? (
          <>
            <p className="postset-review__prompt">Review this set, or wrap up the workout?</p>
            <div className="postset-review__actions">
              <button className="btn btn--primary" onClick={onNextSet}>
                Next set →
              </button>
              <button className="btn" onClick={onEndWorkout}>
                End workout
              </button>
            </div>
            <p className="postset-review__hint">
              “Next set” pulls up this set’s AI debrief first. “End workout” goes straight to your session summary.
            </p>
          </>
        ) : (
          <>
            <p className="postset-review__title">Coach debrief</p>
            <div className="postset-review__body">{body(review)}</div>
            <button className="btn btn--primary postset-review__next" onClick={onStartNextSet}>
              Start set {setIndex != null ? setIndex + 1 : ""} →
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function body(review: PostSetReviewState | undefined) {
  if (!review || review.status === "none") {
    return <p className="ai-msg ai-msg--muted">No analysis for this set.</p>;
  }
  if (review.status === "loading") {
    return <p className="ai-msg ai-msg--loading">Analyzing the set…</p>;
  }
  if (review.status === "blocked") {
    return <p className="ai-msg ai-msg--error">{review.message}</p>;
  }
  if (review.status === "disabled") {
    return (
      <p className="panel__empty">
        AI coaching off — add your Gemini API key in Settings for set-by-set analysis.
      </p>
    );
  }
  return <p className="ai-msg ai-msg--ok">{review.text}</p>; // status === "ok"
}
