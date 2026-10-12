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
import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CoachCamera, type CaptureFn } from "./components/CoachCamera";
import { SetBar } from "./components/SetBar";
import { SynthesisReport } from "./components/SynthesisReport";
import { PostSetReview } from "./components/PostSetReview";
import { SettingsView } from "./components/SettingsView";
import { Segmented } from "./components/Segmented";
import { cameraFeed } from "./components/cameraFeed";
import { useAiBusy } from "./components/aiActivity";
import { TopBar } from "./chrome/TopBar";
import { Menu, type MenuRow } from "./chrome/Menu";
import { Sheet } from "./chrome/Sheet";
import { PrivacyNote } from "./chrome/privacy";
import { canvasSource } from "./chrome/AsciiField";
import { useWorkout } from "./hooks/useWorkout";
import {
  useDepthPreset,
  useMode,
  useApiEnabled,
  useApiKey,
  useExercise,
  useHandSignal,
  usePullupCameraPlan,
  usePullupGrip,
  usePullupTopPreset,
  usePushupDepthPreset,
  usePushupVariant,
} from "./hooks/useSettings";
import type { ExerciseId } from "./session/types";
import { exerciseFromSearch, withoutExerciseParam } from "./session/exerciseParam";
import type { ExposureDecision } from "./vision/exposure";

// Analyze is its own product; the live coach never downloads it.
const AnalyzeView = lazy(() => import("./components/analyze/AnalyzeView").then((m) => ({ default: m.AnalyzeView })));

type Tab = "coach" | "settings" | "analyze";

/** Analyze is linkable (the marketing site points at try.neurofit-training.com/#analyze). */
const ANALYZE_HASH = "#analyze";
const tabFromHash = (): Tab => (typeof location !== "undefined" && location.hash === ANALYZE_HASH ? "analyze" : "coach");

/** The marketing site — its own origin, so the camera permission stays scoped to this app. */
const SITE_URL = "https://neurofit-training.com";

const EXERCISE_LABEL: Record<ExerciseId, string> = { squat: "Squat", pushup: "Push-ups", pullup: "Pull-ups" };
/** The menu's three blocks (one per exercise), in the reference's single-word style. */
const BLOCK_LABEL: Record<ExerciseId, string> = { squat: "Squat", pushup: "Push-up", pullup: "Pull-up" };
const EXERCISES = ["squat", "pushup", "pullup"] as const;

/** Best-effort "set ended" cue for a lifter standing metres from the screen: a short two-note
 *  chime + a buzz on phones. Silently does nothing where audio is locked or unsupported. */
let chimeCtx: AudioContext | null = null;
function setEndedCue(): void {
  try {
    navigator.vibrate?.(120);
  } catch {
    /* no vibration API */
  }
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    chimeCtx ??= new Ctx();
    const ctx = chimeCtx;
    if (ctx.state === "suspended") void ctx.resume();
    [880, 1320].forEach((hz, i) => {
      const t0 = ctx.currentTime + i * 0.14;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.24);
    });
  } catch {
    /* audio blocked (no user gesture yet) — the on-screen card is the cue */
  }
}

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
  const [handSignal, setHandSignal] = useHandSignal();
  const workout = useWorkout(grabFrame, depthPreset, mode, {
    exercise,
    pushupDepthPreset: pushupPreset,
    pushupVariant,
    pullupTopPreset: pullupPreset,
    pullupGrip,
    pullupCameraPlan: pullupPlan,
    handSignal,
  });
  const pushup = exercise === "pushup";
  const pullup = exercise === "pullup";
  const squat = exercise === "squat";

  const [tab, setTab] = useState<Tab>(tabFromHash);
  // Settings opens from the coach or from Analyze, and its X goes back to whichever it came from.
  const [settingsFrom, setSettingsFrom] = useState<Exclude<Tab, "settings">>("coach");
  const openSettings = (from: Exclude<Tab, "settings">) => {
    setSettingsFrom(from);
    setTab("settings");
  };
  // The top bar's menu (Settings, Analyze and the site link live there) and the privacy sheet.
  const [menuOpen, setMenuOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  // Bumped by the menu's USAGE button: Settings scrolls to usage & limits.
  const [usageNonce, setUsageNonce] = useState(0);
  useEffect(() => setMenuOpen(false), [tab]);
  // Esc closes Settings, same as its X — unless the menu or a sheet is what Esc is closing.
  useEffect(() => {
    if (tab !== "settings" || menuOpen || privacyOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTab(settingsFrom);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab, settingsFrom, menuOpen, privacyOpen]);
  // A ?exercise= link from the marketing site already chose the exercise (useExercise); drop it from
  // the address bar so a reload doesn't keep overriding what the lifter picks next.
  useEffect(() => {
    if (!exerciseFromSearch(location.search)) return;
    history.replaceState(history.state, "", location.pathname + withoutExerciseParam(location.search) + location.hash);
  }, []);
  // Keep #analyze in the address bar while on Analyze (so it can be bookmarked and shared), and
  // follow the hash when it changes (back button, a pasted link).
  useEffect(() => {
    if (tab === "settings") return;
    const want = tab === "analyze" ? ANALYZE_HASH : "";
    if (location.hash !== want) history.replaceState(null, "", want || location.pathname + location.search);
  }, [tab]);
  // The hand signal ended a set: chime so the lifter, metres away, knows it registered.
  const cuedRef = useRef(false);
  useEffect(() => {
    if (workout.phase !== "set-review") {
      cuedRef.current = false;
      return;
    }
    if (cuedRef.current || workout.lastSetEndedBy !== "hand_signal") return;
    cuedRef.current = true;
    setEndedCue();
  }, [workout.phase, workout.lastSetEndedBy]);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // Exposure correction stays on; the EnvPanel that used to toggle/display it is hidden.
  const [corrected] = useState(true);
  const [, setExposure] = useState<ExposureDecision | null>(null);

  const kneeWarn = squat && workout.liveMetrics?.kneeValgus.status === "warn";
  const finished = workout.phase === "finished";
  // Leaving for Analyze unmounts the camera (like Settings), so not in the middle of a set.
  const midSet = workout.phase === "countdown" || workout.phase === "active";
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

  // The five pixels run as a loader while any AI read is being written: a set's debrief, the
  // workout synthesis, or Analyze's clip / frame questions.
  const analyzeBusy = useAiBusy();
  const aiBusy =
    analyzeBusy ||
    workout.analysis.status === "loading" ||
    Object.values(workout.postSetReviews).some((r) => r.status === "loading");
  // The menu's ASCII panel mirrors the lifter from the live feed (drifting noise off the coach tab).
  const cameraAscii = useMemo(() => canvasSource(cameraFeed, { mirror: true, gain: 1.2 }), []);

  const menuRows: MenuRow[] = [
    { id: "coach", title: "Coach" },
    {
      id: "analyze",
      title: "Analyze a video",
      disabled: tab === "coach" && midSet,
      hint: tab === "coach" && midSet ? "Finish the set first" : undefined,
    },
    { id: "settings", title: "Settings" },
    { id: "site", title: "Neuro-Fit.com", href: SITE_URL, external: true },
  ];
  const onMenuRow = (row: MenuRow) => {
    if (row.id === "coach") setTab("coach");
    else if (row.id === "analyze") setTab("analyze");
    else if (row.id === "settings" && tab !== "settings") openSettings(tab);
  };
  const bar = (
    <TopBar
      home={{ label: "Neuro-Fit — back to coaching", onClick: () => setTab("coach") }}
      pixels={{ mode: aiBusy ? "loader" : "static" }}
      menuOpen={menuOpen}
      onToggleMenu={() => setMenuOpen((o) => !o)}
      menuId="nf-menu"
      status={aiBusy ? "Writing your AI read" : undefined}
    >
      {menuOpen && (
        <Menu
          id="nf-menu"
          label="Neuro-Fit"
          rows={menuRows}
          activeId={tab}
          onRow={onMenuRow}
          ascii={cameraAscii}
          footer={[
            { id: "privacy", label: "Privacy", onClick: () => setPrivacyOpen(true) },
            {
              id: "usage",
              label: "Usage",
              onClick: () => {
                setUsageNonce((n) => n + 1);
                if (tab !== "settings") openSettings(tab);
              },
            },
          ]}
          blocks={EXERCISES.map((id) => ({
            id,
            label: BLOCK_LABEL[id],
            current: exercise === id,
            disabled: exercise !== id && !canSwitchExercise,
            title: exercise !== id && !canSwitchExercise ? "Finish or reset the workout to switch exercise" : undefined,
            onPick: () => {
              setExercise(id);
              setTab("coach");
            },
          }))}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </TopBar>
  );

  return (
    <div ref={shellRef} className={"nf" + (live ? " nf--live" : "")}>
      {tab !== "coach" && <div className="nf-barslot">{bar}</div>}
      {privacyOpen && (
        <Sheet id="nf-privacy" title="Privacy" onClose={() => setPrivacyOpen(false)}>
          <PrivacyNote />
        </Sheet>
      )}
      {tab === "analyze" ? (
        <Suspense fallback={<p className="ai-msg ai-msg--loading">Opening Analyze</p>}>
          <AnalyzeView onClose={() => setTab("coach")} onOpenSettings={() => openSettings("analyze")} />
        </Suspense>
      ) : tab === "settings" ? (
        <>
          <header className="nf-settings-head">
            <h1 className="nf-settings-head__title">Settings</h1>
            <button type="button" className="btn btn--icon" onClick={() => setTab(settingsFrom)} aria-label="Close settings" title={settingsFrom === "analyze" ? "Back to Analyze (Esc)" : "Back to coaching (Esc)"}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" aria-hidden="true">
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
              handSignal={handSignal}
              onHandSignalChange={setHandSignal}
              focusUsage={usageNonce}
            />
          </main>
        </>
      ) : (
        <>
          <div ref={hudTopRef} className="nf-hud nf-hud--top">
            <header className="nf-head">
              <div className="nf-stats" aria-live="off">
                <div className="stat stat--hero">
                  <span className="stat__label">Reps</span>
                  <span className="stat__value">{workout.reps}</span>
                </div>
              </div>

              <div className="nf-barslot">{bar}</div>

              <div className="nf-controls">
                <Segmented
                  className="nf-exercise"
                  label="Exercise"
                  value={exercise}
                  onChange={setExercise}
                  options={EXERCISES.map((id) => ({
                    value: id,
                    label: EXERCISE_LABEL[id],
                    disabled: exercise !== id && !canSwitchExercise,
                    title: canSwitchExercise ? undefined : "Finish or reset the workout to switch exercise",
                  }))}
                />
                <button type="button" className="btn nf-reset" onClick={workout.reset}>
                  Reset
                </button>
                <button type="button" className="btn nf-finish" onClick={workout.finishWorkout} disabled={finished}>
                  Finish workout
                </button>
              </div>
            </header>
          </div>

          <div ref={hudBottomRef} className="nf-hud nf-hud--bottom">
            <SetBar workout={workout} handSignal={handSignal} />
          </div>
          {finished ? (
            <main className="nf-body nf-body--report">
              {workout.devEvalLog && (
                <button className="btn nf-evallog-btn" onClick={workout.downloadEvalLog} title="Export the dev workout evaluation log (JSON + Markdown)">
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
              {workout.endSignalProgress > 0 && (
                <div className="signal-hold" role="status" aria-live="polite">
                  <span className="signal-hold__ring" style={{ "--signal-p": workout.endSignalProgress } as CSSProperties} aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 20V5M7.5 9.5 12 5l4.5 4.5" />
                    </svg>
                  </span>
                  <span className="signal-hold__label">Hold to end set</span>
                </div>
              )}
              {workout.phase === "set-review" && (
                <PostSetReview
                  setIndex={workout.reviewSetIndex}
                  set={
                    pushup
                      ? workout.completedPushupSets.find((s) => s.index === workout.reviewSetIndex)
                      : pullup
                        ? workout.completedPullupSets.find((s) => s.index === workout.reviewSetIndex)
                        : workout.completedSets.find((s) => s.index === workout.reviewSetIndex)
                  }
                  review={workout.reviewSetIndex != null ? workout.postSetReviews[workout.reviewSetIndex] : undefined}
                  restElapsedSec={workout.restElapsedSec}
                  endedBy={workout.lastSetEndedBy}
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
