/**
 * Neuro-Fit — squat coach with orientation-aware, alternating-set coaching.
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
import { MetricsPanel } from "./components/MetricsPanel";
import { VelocityPanel } from "./components/VelocityPanel";
import { EnvPanel } from "./components/EnvPanel";
import { SynthesisReport } from "./components/SynthesisReport";
import { PostSetReview } from "./components/PostSetReview";
import { SettingsView } from "./components/SettingsView";
import { useWorkout } from "./hooks/useWorkout";
import { useDepthPreset, useMode, useApiEnabled, useApiKey } from "./hooks/useSettings";
import type { ExposureDecision } from "./vision/exposure";

type Tab = "coach" | "settings";

export default function App() {
  const captureRef = useRef<CaptureFn | null>(null);
  const grabFrame = useMemo<CaptureFn>(() => () => captureRef.current?.() ?? null, []);
  const [depthPreset, setDepthPreset] = useDepthPreset();
  const [mode, setMode] = useMode();
  const [apiEnabled, setApiEnabled] = useApiEnabled();
  const apiKey = useApiKey();
  const workout = useWorkout(grabFrame, depthPreset, mode);

  const [tab, setTab] = useState<Tab>("coach");
  const [corrected, setCorrected] = useState(true);
  const [exposure, setExposure] = useState<ExposureDecision | null>(null);

  const kneeWarn = workout.liveMetrics?.kneeValgus.status === "warn";
  const phaseLabel = workout.kneeAngle === null ? "—" : workout.isDown ? "DOWN" : "UP";
  const finished = workout.phase === "finished";
  const depthPct = Math.round(Math.min(1, Math.max(0, workout.depthRatio)) * 100);

  return (
    <div className="nf">
      <header className="nf-head">
        <div className="nf-brand">
          <h1>
            NEURO<span className="nf-brand__dot">·</span>FIT
          </h1>
          <p className="nf-brand__sub">AI squat coach — orientation-aware, works in any room</p>
        </div>

        <div className="nf-stats">
          <div className="stat stat--hero">
            <span className="stat__value">{workout.reps}</span>
            <span className="stat__label">REPS</span>
          </div>
          <div className="stat">
            <span className="stat__value">{workout.kneeAngle === null ? "--" : depthPct + "%"}</span>
            <span className="stat__label">DEPTH</span>
          </div>
          <div className="stat">
            <span className={"stat__value stat__value--phase " + (workout.isDown ? "is-down" : "")}>{phaseLabel}</span>
            <span className="stat__label">PHASE</span>
          </div>
          <button className="nf-reset" onClick={workout.reset}>
            Reset
          </button>
        </div>
      </header>

      <nav className="nf-tabs">
        <button
          className={"nf-tab" + (tab === "coach" ? " nf-tab--active" : "")}
          onClick={() => setTab("coach")}
        >
          Coach
        </button>
        <button
          className={"nf-tab" + (tab === "settings" ? " nf-tab--active" : "")}
          onClick={() => setTab("settings")}
        >
          Settings
        </button>
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
              debugGap={workout.targetOrientation === "side" ? workout.liveDepthGap : null}
              debugValgus={workout.targetOrientation === "front" ? workout.liveValgusRatio : null}
              captureRef={captureRef}
            >
              {workout.phase === "countdown" && workout.countdown !== null && (
                <div className="countdown-overlay">{workout.countdown}</div>
              )}
              {workout.repositionNeeded && (
                <div className="reposition-overlay">Return to {workout.targetOrientation}-on view</div>
              )}
              {workout.missedDepthFlash && <div className="missed-flash">Depth not met — no count</div>}
              {workout.phase === "set-review" && (
                <PostSetReview
                  stage={workout.reviewStage}
                  setIndex={workout.reviewSetIndex}
                  set={workout.completedSets.find((s) => s.index === workout.reviewSetIndex)}
                  review={workout.reviewSetIndex != null ? workout.postSetReviews[workout.reviewSetIndex] : undefined}
                  onNextSet={workout.requestPostSet}
                  onEndWorkout={workout.finishWorkout}
                  onStartNextSet={workout.newSet}
                />
              )}
            </CoachCamera>
            <p className="nf-stage__hint">
              {workout.targetOrientation === "side"
                ? "Side sets check depth, forward lean and tempo."
                : "Front sets check knee valgus and shoulder/hip levelness."}{" "}
              Tempo is tracked from both views. Whole body in frame.
            </p>
          </div>

          <aside className="nf-rail">
            <MetricsPanel metrics={workout.liveMetrics} />
            <EnvPanel
              exposure={exposure}
              camera={workout.camera}
              corrected={corrected}
              onToggleCorrected={setCorrected}
            />
            <VelocityPanel samples={workout.velocity} best={workout.bestVelocity} />
          </aside>
        </main>
          )}
        </>
      )}

      <footer className="nf-foot">
        Sets alternate side/front so each plane's faults are checked from the angle that can see them.
        Local rules give instant cues; the AI coach is consulted only when rep speed drops (fatigue), not
        on a timer. Phase 1 prototype — thresholds are starting points to tune on real footage.
      </footer>
    </div>
  );
}
