/**
 * Neuro-Fit — squat + push-up coach with orientation-aware, alternating-set coaching.
 * ----------------------------------------------------------------------------
 * Phase 1.5: each set is filmed front- or side-on (alternating); the orientation
 * gate decides which of the full validated metric set can be checked, the live
 * panels show every metric (with not-checked / unavailable visibly distinct),
 * and a post-workout synthesis combines all sets into one report.
 *
 * No accounts/backend/multi-exercise/persistence — out of scope. StakeFit source
 * remains on disk as reference but isn't rendered.
 */
import { useMemo, useRef, useState } from "react";
import { CoachCamera, type CaptureFn } from "./components/CoachCamera";
import { SetBar } from "./components/SetBar";
import { MetricsPanel, type MetricRow } from "./components/MetricsPanel";
import { VelocityPanel } from "./components/VelocityPanel";
import { EnvPanel } from "./components/EnvPanel";
import { SynthesisReport } from "./components/SynthesisReport";
import { PostSetReview } from "./components/PostSetReview";
import { SettingsView } from "./components/SettingsView";
import { useWorkout } from "./hooks/useWorkout";
import {
  useDepthPreset,
  useMode,
  useApiEnabled,
  useApiKey,
  useExercise,
  usePushupDepthPreset,
  usePushupVariant,
} from "./hooks/useSettings";
import { METRIC_ORDER, METRICS } from "./squat/metrics";
import { PUSHUP_METRIC_ORDER, PUSHUP_METRICS } from "./pushup/metrics";
import type { ExposureDecision } from "./vision/exposure";

type Tab = "coach" | "settings";

/** The marketing site — its own origin, so the camera permission stays scoped to this app. */
const SITE_URL = "https://neurofit-training.com";

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
  const workout = useWorkout(grabFrame, depthPreset, mode, {
    exercise,
    pushupDepthPreset: pushupPreset,
    pushupVariant,
  });
  const pushup = exercise === "pushup";

  const [tab, setTab] = useState<Tab>("coach");
  const [corrected, setCorrected] = useState(true);
  const [exposure, setExposure] = useState<ExposureDecision | null>(null);

  const kneeWarn = !pushup && workout.liveMetrics?.kneeValgus.status === "warn";
  const phaseLabel = !workout.readable ? "—" : workout.isDown ? "DOWN" : "UP";
  const finished = workout.phase === "finished";
  const depthPct = Math.round(Math.min(1, Math.max(0, workout.depthRatio)) * 100);
  // Switching exercise resets the workout, so only offer it before any set is done (or after finishing).
  const canSwitchExercise =
    workout.phase === "finished" ||
    (workout.phase === "positioning" && workout.completedSets.length === 0 && workout.completedPushupSets.length === 0);
  const squatMetrics = workout.liveMetrics;
  const pushupMetrics = workout.pushupLiveMetrics;
  const metricRows: MetricRow[] | null = pushup
    ? pushupMetrics && PUSHUP_METRIC_ORDER.map((id) => ({ ...pushupMetrics[id], id, label: PUSHUP_METRICS[id].label }))
    : squatMetrics && METRIC_ORDER.map((id) => ({ ...squatMetrics[id], id, label: METRICS[id].label }));

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
          <p className="nf-brand__sub">{pushup ? "Push-up" : "Squat"} coach · orientation-aware · early build</p>
        </div>

        <div className="nf-stats" aria-live="off">
          <div className="stat stat--hero">
            <span className="stat__label">Reps</span>
            <span className="stat__value">{workout.reps}</span>
          </div>
          <div className="stat">
            <span className="stat__label">Depth</span>
            <span className="stat__value">{!workout.readable ? "--" : depthPct + "%"}</span>
          </div>
          <div className="stat">
            <span className="stat__label">Phase</span>
            <span className={"stat__value stat__value--phase " + (workout.isDown ? "is-down" : "")}>{phaseLabel}</span>
          </div>
        </div>

        <div className="nf-controls">
          <div className="nf-exercise" role="group" aria-label="Exercise">
            {(["squat", "pushup"] as const).map((id) => (
              <button
                key={id}
                type="button"
                className={"nf-exercise__opt" + (exercise === id ? " nf-exercise__opt--active" : "")}
                aria-pressed={exercise === id}
                disabled={exercise !== id && !canSwitchExercise}
                title={canSwitchExercise ? undefined : "Finish or reset the workout to switch exercise"}
                onClick={() => setExercise(id)}
              >
                {id === "squat" ? "Squat" : "Push-ups"}
              </button>
            ))}
          </div>
          <button type="button" className="nf-reset" onClick={workout.reset}>
            Reset
          </button>
        </div>
      </header>

      <nav className="nf-tabs" aria-label="View">
        {(["coach", "settings"] as const).map((id, i) => (
          <button
            key={id}
            type="button"
            className={"nf-tab" + (tab === id ? " nf-tab--active" : "")}
            aria-current={tab === id ? "page" : undefined}
            onClick={() => setTab(id)}
          >
            <span className="nf-tab__num">{String(i + 1).padStart(2, "0")}</span>
            {id === "coach" ? "Coach" : "Settings"}
          </button>
        ))}
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
          />
        </main>
      ) : (
        <>
          <SetBar workout={workout} />
          {finished ? (
            <main className="nf-body nf-body--report">
              {workout.devEvalLog && (
                <button className="nf-evallog-btn" onClick={workout.downloadEvalLog} title="Export the dev workout evaluation log (JSON + Markdown)">
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
              debugGap={!pushup && workout.targetOrientation === "side" ? workout.liveDepthGap : null}
              debugValgus={!pushup && workout.targetOrientation === "front" ? workout.liveValgusRatio : null}
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
                      : workout.completedSets.find((s) => s.index === workout.reviewSetIndex)
                  }
                  review={workout.reviewSetIndex != null ? workout.postSetReviews[workout.reviewSetIndex] : undefined}
                  onNextSet={workout.requestPostSet}
                  onEndWorkout={workout.finishWorkout}
                  onStartNextSet={workout.newSet}
                />
              )}
            </CoachCamera>
            <p className="nf-stage__hint">
              {pushup
                ? workout.targetOrientation === "side"
                  ? "Side sets check depth, lockout, body line (hip sag / pike) and tempo."
                  : "Head-on sets check depth, lockout, elbow flare, left/right evenness and tempo."
                : workout.targetOrientation === "side"
                  ? "Side sets check depth, forward lean and tempo."
                  : "Front sets check knee valgus and shoulder/hip levelness."}{" "}
              {pushup
                ? "Phone on the floor about 2 m away. Start kneeling, facing the camera so it finds you, then move into the top of a push-up."
                : "Tempo is tracked from both views. Whole body in frame."}
            </p>
          </div>

          <aside className="nf-rail">
            <MetricsPanel
              rows={metricRows}
              emptyText={pushup ? "Lock a set and start your push-ups to see gated form checks." : "Lock a set and start squatting to see gated form checks."}
            />
            <EnvPanel
              exposure={exposure}
              camera={workout.camera}
              corrected={corrected}
              onToggleCorrected={setCorrected}
              exercise={exercise}
            />
            <VelocityPanel samples={workout.velocity} best={workout.bestVelocity} />
          </aside>
        </main>
          )}
        </>
      )}

      <footer className="nf-foot">
        <span>Sets alternate side / front so each plane's faults are checked from the angle that can see them.</span>
        <span>The AI coach runs only when you ask — after a set, or at the end of the workout.</span>
        <span>Early build · every threshold is a starting point, tuned on very few bodies.</span>
      </footer>
    </div>
  );
}
