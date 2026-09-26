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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  // Esc closes Settings, same as its X.
  useEffect(() => {
    if (tab !== "settings") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTab("coach");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab]);
  // Exposure correction stays on; the EnvPanel that used to toggle/display it is hidden.
  const [corrected] = useState(true);
  const [, setExposure] = useState<ExposureDecision | null>(null);

  const kneeWarn = squat && workout.liveMetrics?.kneeValgus.status === "warn";
  const finished = workout.phase === "finished";
  // Switching exercise resets the workout, so only offer it before any set is done (or after finishing).
  const canSwitchExercise =
    workout.phase === "finished" ||
    (workout.phase === "positioning" &&
      workout.completedSets.length === 0 &&
      workout.completedPushupSets.length === 0 &&
      workout.completedPullupSets.length === 0);

  // Live coaching: the camera fills the screen and every control floats over it as a HUD.
  // Settings and the finished report stay ordinary pages.
  const live = tab === "coach" && !finished;
  const shellRef = useRef<HTMLDivElement>(null);
  const hudTopRef = useRef<HTMLDivElement>(null);
  const hudBottomRef = useRef<HTMLDivElement>(null);
  // Publish how much of the screen the HUD covers, so the camera's own overlays (fps badge,
  // missed-depth flash, reposition prompt, post-set card) sit in the clear space between.
  useLayoutEffect(() => {
    const shell = shellRef.current;
    const top = hudTopRef.current;
    const bottom = hudBottomRef.current;
    if (!live || !shell || !top || !bottom) return;
    const sync = () => {
      const box = shell.getBoundingClientRect();
      shell.style.setProperty("--hud-top", `${Math.round(top.getBoundingClientRect().bottom - box.top)}px`);
      shell.style.setProperty("--hud-bottom", `${Math.round(box.bottom - bottom.getBoundingClientRect().top)}px`);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(shell);
    ro.observe(top);
    ro.observe(bottom);
    return () => ro.disconnect();
  }, [live]);

  return (
    <div ref={shellRef} className={"nf" + (live ? " nf--live" : "")}>
      {tab === "settings" ? (
        <>
          <header className="nf-settings-head">
            <a className="nf-brand__home" href={SITE_URL} aria-label="Neuro-Fit — about the app">
              <svg className="nf-brand__mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <circle cx="12" cy="4.4" r="2.2" fill="currentColor" stroke="none" />
                <path d="M12 7v6.2M12 13.2 8.2 18.8M12 13.2l3.8 5.6M7.6 9.6h8.8" />
              </svg>
              Neuro-Fit
            </a>
            <h1 className="nf-settings-head__title">Settings</h1>
            <button type="button" className="lg-btn lg-btn--icon" onClick={() => setTab("coach")} aria-label="Close settings" title="Back to coaching (Esc)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </header>
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
        </>
      ) : (
        <>
          <div ref={hudTopRef} className="nf-hud nf-hud--top">
            <header className="nf-head">
              <button type="button" className="lg-btn lg-btn--icon nf-settings-btn" onClick={() => setTab("settings")} aria-label="Settings" title="Settings">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>

              <div className="nf-stats" aria-live="off">
                <div className="stat stat--hero">
                  <span className="stat__label">Reps</span>
                  <span className="stat__value">{workout.reps}</span>
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

              <button type="button" className="lg-btn nf-finish" onClick={workout.finishWorkout} disabled={finished}>
                Finish workout
              </button>
            </header>
          </div>

          <div ref={hudBottomRef} className="nf-hud nf-hud--bottom">
            <SetBar workout={workout} />
          </div>
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
