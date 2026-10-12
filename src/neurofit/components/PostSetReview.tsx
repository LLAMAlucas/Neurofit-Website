/**
 * Between-set review overlay (phase "set-review"). Rendered OVER the still-mounted camera
 * stage so the MediaPipe model stays loaded for the next set.
 *
 * One stage. The set was ended by the hand signal or End set, and both already fired the post-set
 * analysis — so by the time the lifter walks over, the debrief is loading or done. The card shows
 * the running REST timer (it started when the set ended and stops on "Start set N"; that number is
 * the rest the coach sees for the next set), the debrief, and the two ways forward.
 *
 * It never triggers a Gemini call itself — the body only renders the persisted result.
 */
import type { PostSetReview as PostSetReviewState } from "../hooks/useWorkout";
import { formatRest, type SetEndedBy } from "../session/rest";
/** The only fields the overlay reads — satisfied by the squat, push-up and pull-up set records. */
interface ReviewedSet {
  orientation: string;
  reps: { counted: boolean }[];
}

export function PostSetReview({
  setIndex,
  set,
  review,
  restElapsedSec,
  endedBy,
  onEndWorkout,
  onStartNextSet,
}: {
  setIndex: number | null;
  set: ReviewedSet | undefined;
  review: PostSetReviewState | undefined;
  restElapsedSec: number | null;
  endedBy: SetEndedBy | null;
  onEndWorkout: () => void;
  onStartNextSet: () => void;
}) {
  const counted = set ? set.reps.filter((r) => r.counted).length : 0;
  const attempts = set ? set.reps.length : 0;

  return (
    <div className="postset-review">
      <div className="postset-review__card">
        <div className="postset-review__head">
          <div>
            <p className="postset-review__eyebrow">
              SET {setIndex ?? "—"} COMPLETE{set ? ` · ${set.orientation.toUpperCase()} VIEW` : ""}
              {endedBy === "hand_signal" ? " · HAND SIGNAL" : ""}
            </p>
            <p className="postset-review__tally">
              {counted}/{attempts} rep{attempts === 1 ? "" : "s"} counted
            </p>
          </div>
          {restElapsedSec !== null && (
            <div className="postset-review__rest" aria-label={`Resting ${formatRest(restElapsedSec)}`}>
              <span className="postset-review__rest-label">REST</span>
              <span className="postset-review__rest-time">{formatRest(restElapsedSec)}</span>
            </div>
          )}
        </div>

        <p className="postset-review__title">Coach debrief</p>
        <div className="postset-review__body">{body(review)}</div>
        <div className="postset-review__actions">
          <button className="lg-btn btn btn--primary" onClick={onStartNextSet}>
            Start set {setIndex != null ? setIndex + 1 : ""} →
          </button>
          <button className="lg-btn btn" onClick={onEndWorkout}>
            End workout
          </button>
        </div>
        <p className="postset-review__hint">The rest timer stops when you start the next set — the coach sees how long you rested.</p>
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
