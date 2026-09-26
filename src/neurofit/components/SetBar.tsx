/**
 * Set/orientation controller bar: which set, the target orientation, the
 * lock/countdown state, and the live reposition prompt. This is the alternating-
 * set session UI (spec §4). The setup hint ("turn side-on…") and the live
 * detection label live behind a "?" beside the set badge — hover or tap to read.
 * Finish workout lives in the App header, top right.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { Workout } from "../hooks/useWorkout";

const ORIENT_LABEL: Record<"front" | "side", string> = { front: "FRONT view", side: "SIDE view" };
const ORIENT_HINT: Record<"front" | "side", string> = {
  front: "Face the camera square-on, whole body in frame.",
  side: "Turn side-on to the camera, whole body in profile.",
};
const PUSHUP_ORIENT_HINT: Record<"front" | "side", string> = {
  front: "Camera on the floor in front of your head — get into the top of a push-up.",
  side: "Camera on the floor side-on, whole body in profile — get into the top of a push-up.",
};
// Pull-ups lock STANDING under the bar (hanging through the lock + countdown would burn the grip);
// the lifter jumps up once the set goes live.
const PULLUP_ORIENT_HINT: Record<"front" | "side", string> = {
  front: "Stand under the bar facing the camera — bar, hands-up reach and whole body in frame.",
  side: "Stand under the bar side-on to the camera — bar, hands-up reach and whole body in frame.",
};
const HINTS = { squat: ORIENT_HINT, pushup: PUSHUP_ORIENT_HINT, pullup: PULLUP_ORIENT_HINT } as const;

export function SetBar({ workout }: { workout: Workout }) {
  const { phase, setIndex, targetOrientation, aligned, lockProgress, countdown, orientationLabel, repositionNeeded } = workout;
  const facing =
    workout.facingAngleDeg !== null
      ? `${Math.round(workout.facingAngleDeg)}°${workout.facingScore !== null ? ` · ${workout.facingScore.toFixed(2)}` : ""}`
      : "—";
  const status = statusContent();

  return (
    <div className="setbar">
      <div className="setbar__main">
        <div className="setbar__id">
          <span className="setbar__set">SET {setIndex}</span>
          <span className={"setbar__target setbar__target--" + targetOrientation}>{ORIENT_LABEL[targetOrientation]}</span>
          <SetupHelp hint={HINTS[workout.exercise][targetOrientation]} detected={orientationLabel} />
          <span className="setbar__facing" title="detected facing angle · score">{facing}</span>
        </div>
        {status && <div className="setbar__status">{status}</div>}
      </div>

      {phase === "active" && (
        <div className="setbar__controls">
          <button className="lg-btn btn btn--primary" onClick={workout.endSet}>
            End set
          </button>
        </div>
      )}
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
        <span className="setbar__msg setbar__msg--go">
          Set live · {ORIENT_LABEL[targetOrientation]}
          {workout.exercise === "pullup" && !workout.readable ? " — jump up and hang to start" : ""}
        </span>
      );
    }
    // positioning: the how-to is behind the "?"; only the lock itself shows here.
    return (
      <div className="setbar__align">
        {aligned && <span className="setbar__msg setbar__msg--go">Hold it…</span>}
        <div className="setbar__lock">
          <div className="setbar__lock-fill" style={{ width: Math.round(lockProgress * 100) + "%" }} />
        </div>
      </div>
    );
  }
}

/** "?" beside the set badge: hover (pointer) or tap/click (touch, keyboard) shows how to stand for this view. */
function SetupHelp({ hint, detected }: { hint: string; detected: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const tipId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={root} className={"setbar__help" + (open ? " is-open" : "")}>
      <button
        type="button"
        className="setbar__help-btn"
        aria-label="How to set up for this view"
        aria-expanded={open}
        aria-describedby={tipId}
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
      <span id={tipId} role="tooltip" className="setbar__tip">
        {hint}
        <span className="setbar__tip-status">Camera sees: {detected}</span>
      </span>
    </span>
  );
}
