/**
 * Set/orientation controller bar: which set, the target orientation, the
 * lock/countdown state, and the live reposition prompt. This is the alternating-
 * set session UI (spec §4).
 */
import type { Workout } from "../hooks/useWorkout";

const ORIENT_LABEL: Record<"front" | "side", string> = { front: "FRONT view", side: "SIDE view" };
const ORIENT_HINT: Record<"front" | "side", string> = {
  front: "Face the camera square-on, whole body in frame.",
  side: "Turn side-on to the camera, whole body in profile.",
};

export function SetBar({ workout }: { workout: Workout }) {
  const { phase, setIndex, targetOrientation, aligned, lockProgress, countdown, orientationLabel, repositionNeeded } = workout;
  const facing =
    workout.facingAngleDeg !== null
      ? `${Math.round(workout.facingAngleDeg)}°${workout.facingScore !== null ? ` · ${workout.facingScore.toFixed(2)}` : ""}`
      : "—";

  return (
    <div className="setbar">
      <div className="setbar__id">
        <span className="setbar__set">SET {setIndex}</span>
        <span className={"setbar__target setbar__target--" + targetOrientation}>{ORIENT_LABEL[targetOrientation]}</span>
        <span className="setbar__facing" title="detected facing angle · score">{facing}</span>
      </div>

      <div className="setbar__status">{statusContent()}</div>

      <div className="setbar__controls">
        {phase === "active" && (
          <button className="btn btn--primary" onClick={workout.endSet}>
            End set
          </button>
        )}
        <button className="btn" onClick={workout.finishWorkout} disabled={phase === "finished"}>
          Finish workout
        </button>
      </div>
    </div>
  );

  function statusContent() {
    if (phase === "finished") return <span className="setbar__msg">Workout complete — see report below.</span>;
    if (phase === "set-review") return <span className="setbar__msg">Set {setIndex} complete — pick Next set or End workout.</span>;
    if (phase === "countdown") return <span className="setbar__msg setbar__msg--go">Locked · starting in {countdown}…</span>;
    if (phase === "active") {
      return repositionNeeded ? (
        <span className="setbar__msg setbar__msg--warn">
          Off {targetOrientation}-on — checks paused. Return to {ORIENT_LABEL[targetOrientation]}.
        </span>
      ) : (
        <span className="setbar__msg setbar__msg--go">Set live · {ORIENT_LABEL[targetOrientation]}</span>
      );
    }
    // positioning
    return (
      <div className="setbar__align">
        <span className={"setbar__msg" + (aligned ? " setbar__msg--go" : "")}>
          {aligned ? "Hold it…" : `${ORIENT_HINT[targetOrientation]} (${orientationLabel})`}
        </span>
        <div className="setbar__lock">
          <div className="setbar__lock-fill" style={{ width: Math.round(lockProgress * 100) + "%" }} />
        </div>
      </div>
    );
  }
}
