/**
 * Neuro-Fit — squat, push-up and pull-up coach with orientation-aware, alternating-set coaching.
 * ----------------------------------------------------------------------------
 * Phase 1.5: each set is filmed front- or side-on (alternating); the orientation
 * gate decides which of the full validated metric set can be checked, the live
 * panels show every metric (with not-checked / unavailable visibly distinct),
 * and a post-workout synthesis combines all sets into one report.
 *
 * No accounts/backend/multi-exercise/persistence — out of scope. StakeFit source
 * remains on disk as reference but isn't rendered.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CoachCamera, type CaptureFn } from "./components/CoachCamera";
import { SetBar } from "./components/SetBar";
import { SynthesisReport } from "./components/SynthesisReport";
import { PostSetReview } from "./components/PostSetReview";
import { SettingsView } from "./components/SettingsView";
import { GlassSegmented } from "./components/glass/GlassSegmented";
import { installGlassPointer } from "./components/glass/liquidGlass";
import { useWorkout } from "./hooks/useWorkout";
import {
  useDepthPreset,
  useMode,
  useApiEnabled,
  useApiKey,
  useExercise,
  usePullupCameraPlan,
  usePullupGrip,
  usePullupTopPreset,
  usePushupDepthPreset,
  usePushupVariant,
} from "./hooks/useSettings";
import type { ExerciseId } from "./session/types";
import type { ExposureDecision } from "./vision/exposure";

type Tab = "coach" | "settings";

/** The marketing site — its own origin, so the camera permission stays scoped to this app. */
const SITE_URL = "https://neurofit-training.com";

const EXERCISE_LABEL: Record<ExerciseId, string> = { squat: "Squat", pushup: "Push-ups", pullup: "Pull-ups" };

export default function App() {
  const captureRef = useRef<CaptureFn | null>(null);
  const grabFrame = useMemo<CaptureFn>(() => () => captureRef.current?.() ?? null, []);
  const [depthPreset, setDepthPreset] = useDepthPreset();
  const [mode, setMode] = useMode();
  const [apiEnabled, setApiEnabled] = useApiEnabled();
  const apiKey = useApiKey();
  const [exercise, setExercise] = useExercise();
  const [pushupPreset, setPushupPreset] = usePushupDepthPreset();
  const [pushupVariant, setPushupVariant] = usePushupVariant();
  const [pullupPreset, setPullupPreset] = usePullupTopPreset();
  const [pullupGrip, setPullupGrip] = usePullupGrip();
  const [pullupPlan, setPullupPlan] = usePullupCameraPlan();
  const workout = useWorkout(grabFrame, depthPreset, mode, {
    exercise,
    pushupDepthPreset: pushupPreset,
    pushupVariant,
    pullupTopPreset: pullupPreset,
    pullupGrip,
    pullupCameraPlan: pullupPlan,
  });
  const pushup = exercise === "pushup";
  const pullup = exercise === "pullup";
  const squat = exercise === "squat";

  const [tab, setTab] = useState<Tab>("coach");
  useEffect(() => installGlassPointer(), []);
  // Exposure correction stays on; the EnvPanel that used to toggle/display it is hidden.
  const [corrected] = useState(true);
  const [, setExposure] = useState<ExposureDecision | null>(null);

  const kneeWarn = squat && workout.liveMetrics?.kneeValgus.status === "warn";
  // A pull-up rests at the bottom: an attempt in progress is the PULL, between attempts the HANG.
  const phaseLabel = !workout.readable ? "—" : pullup ? (workout.isDown ? "PULL" : "HANG") : workout.isDown ? "DOWN" : "UP";
  const finished = workout.phase === "finished";
  const depthPct = Math.round(Math.min(1, Math.max(0, workout.depthRatio)) * 100);
  // Switching exercise resets the workout, so only offer it before any set is done (or after finishing).
  const canSwitchExercise =
    workout.phase === "finished" ||
    (workout.phase === "positioning" &&
      workout.completedSets.length === 0 &&
      workout.completedPushupSets.length === 0 &&
      workout.completedPullupSets.length === 0);

  return (
    <div className="nf">
      <header className="nf-head">
        <div className="nf-brand">
          <a className="nf-brand__home" href={SITE_URL} aria-label="Neuro-Fit — about the app">
            <svg className="nf-brand__mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="4.4" r="2.2" fill="currentColor" stroke="none" />
              <path d="M12 7v6.2M12 13.2 8.2 18.8M12 13.2l3.8 5.6M7.6 9.6h8.8" />
            </svg>
            Neuro-Fit
          </a>
        </div>

        <div className="nf-stats" aria-live="off">
          <div className="stat stat--hero">
            <span className="stat__label">Reps</span>
            <span className="stat__value">{workout.reps}</span>
          </div>
          <div className="stat">
            <span className="stat__label">{pullup ? "Height" : "Depth"}</span>
            <span className="stat__value">{!workout.readable ? "--" : depthPct + "%"}</span>
          </div>
          <div className="stat">
            <span className="stat__label">Phase</span>
            <span className={"stat__value stat__value--phase " + (workout.isDown ? "is-down" : "")}>{phaseLabel}</span>
          </div>
        </div>

        <div className="nf-controls">
          <GlassSegmented
            className="nf-exercise"
            label="Exercise"
            value={exercise}
            onChange={setExercise}
            options={(["squat", "pushup", "pullup"] as const).map((id) => ({
              value: id,
              label: EXERCISE_LABEL[id],
              disabled: exercise !== id && !canSwitchExercise,
              title: canSwitchExercise ? undefined : "Finish or reset the workout to switch exercise",
            }))}
          />
          <button type="button" className="lg-btn nf-reset" onClick={workout.reset}>
            Reset
          </button>
        </div>
      </header>

      <nav className="nf-tabs" aria-label="View">
        <GlassSegmented
          className="nf-tabs__seg"
          label="View"
          current
          value={tab}
          onChange={setTab}
          options={(["coach", "settings"] as const).map((id, i) => ({
            value: id,
            label: (
              <>
                <span className="nf-tab__num">{String(i + 1).padStart(2, "0")}</span>
                {id === "coach" ? "Coach" : "Settings"}
              </>
            ),
          }))}
        />
      </nav>

      {tab === "settings" ? (
        <main className="nf-body nf-body--settings">
          <SettingsView
            preset={depthPreset}
            onChange={setDepthPreset}
            mode={mode}
            onModeChange={setMode}
            apiEnabled={apiEnabled}
            onApiEnabledChange={setApiEnabled}
            apiKey={apiKey}
            exercise={exercise}
            pushupPreset={pushupPreset}
            onPushupPresetChange={setPushupPreset}
            pushupVariant={pushupVariant}
            onPushupVariantChange={setPushupVariant}
            pullupPreset={pullupPreset}
            onPullupPresetChange={setPullupPreset}
            pullupGrip={pullupGrip}
            onPullupGripChange={setPullupGrip}
            pullupPlan={pullupPlan}
            onPullupPlanChange={setPullupPlan}
          />
        </main>
      ) : (
        <>
          <SetBar workout={workout} />
          {finished ? (
            <main className="nf-body nf-body--report">
              {workout.devEvalLog && (
                <button className="lg-btn nf-evallog-btn" onClick={workout.downloadEvalLog} title="Export the dev workout evaluation log (JSON + Markdown)">
                  ⬇ Download eval log (JSON + MD)
                </button>
              )}
              <SynthesisReport
                report={workout.report!}
                analysis={workout.analysis}
                postSetReviews={workout.postSetReviews}
                onNewWorkout={workout.reset}
              />
            </main>
          ) : (
        <main className="nf-body">
          <div className="nf-stage">
            <CoachCamera
              onResult={workout.onResult}
              corrected={corrected}
              onExposure={setExposure}
              kneeWarn={kneeWarn}
              debugGap={squat && workout.targetOrientation === "side" ? workout.liveDepthGap : null}
              debugValgus={squat && workout.targetOrientation === "front" ? workout.liveValgusRatio : null}
              debugTags={workout.debugTags}
              captureRef={captureRef}
            >
              {workout.phase === "countdown" && workout.countdown !== null && (
                <div className="countdown-overlay">{workout.countdown}</div>
              )}
              {workout.repositionNeeded && (
                <div className="reposition-overlay">Return to {workout.targetOrientation}-on view</div>
              )}
              {workout.missedDepthFlash && <div className="missed-flash">{workout.missedFlashText}</div>}
              {workout.phase === "set-review" && (
                <PostSetReview
                  stage={workout.reviewStage}
                  setIndex={workout.reviewSetIndex}
                  set={
                    pushup
                      ? workout.completedPushupSets.find((s) => s.index === workout.reviewSetIndex)
                      : pullup
                        ? workout.completedPullupSets.find((s) => s.index === workout.reviewSetIndex)
                        : workout.completedSets.find((s) => s.index === workout.reviewSetIndex)
                  }
                  review={workout.reviewSetIndex != null ? workout.postSetReviews[workout.reviewSetIndex] : undefined}
                  onNextSet={workout.requestPostSet}
                  onEndWorkout={workout.finishWorkout}
                  onStartNextSet={workout.newSet}
                />
              )}
            </CoachCamera>
          </div>
        </main>
          )}
        </>
      )}
    </div>
  );
}
