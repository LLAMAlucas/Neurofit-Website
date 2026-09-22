/**
 * Settings tab (Phase 1: squat depth target only).
 * ----------------------------------------------------------------------------
 * Three selectable depth presets, each with a simple side-view stick figure
 * (hip/knee/ankle landmarks connected by segments) posed at the preset's depth,
 * plus a dashed knee-level reference so the hip-vs-knee relationship reads at a
 * glance. The selected card is highlighted; persistence is handled by the parent
 * (localStorage via useDepthPreset). Wired to the depth check's target in config.
 */
import type { DepthPreset, SquatMode } from "../squat/config";
import { PUSHUP_DEPTH_PRESETS, type PushupDepthPreset, type PushupVariant } from "../pushup/config";
import type { ExerciseId } from "../session/types";
import type { ApiKeyControl } from "../hooks/useSettings";
import { UsagePanel } from "./UsagePanel";

interface PresetCard {
  id: DepthPreset;
  title: string;
  desc: string;
  sub: string;
  /** Hip Y in the figure's viewBox; knee-level reference sits at y = 88. */
  hipY: number;
}

// Order per spec: full → parallel → above. hipY < 88 = above knee, > 88 = below.
const PRESETS: PresetCard[] = [
  { id: "full", title: "FULL DEPTH", desc: "Hip drops well below knee", sub: "experienced lifters, good mobility", hipY: 104 },
  { id: "parallel", title: "PARALLEL", desc: "Hip reaches knee level", sub: "most lifters, standard target", hipY: 88 },
  { id: "above", title: "ABOVE PARALLEL", desc: "Hip stays above knee", sub: "athletes, limited mobility, rehabilitation", hipY: 72 },
];

const KNEE_Y = 88;

function DepthFigure({ hipY }: { hipY: number }) {
  const ankle: [number, number] = [42, 122];
  const knee: [number, number] = [62, KNEE_Y];
  const hip: [number, number] = [86, hipY];
  const shoulder: [number, number] = [88, hipY - 46];
  const headCy = shoulder[1] - 11;
  const toe: [number, number] = [66, 126];

  return (
    <svg className="depth-fig" viewBox="0 0 130 140" aria-hidden="true">
      <line className="depth-fig__ground" x1="16" y1="128" x2="106" y2="128" />
      <line className="depth-fig__ref" x1="28" y1={KNEE_Y} x2="120" y2={KNEE_Y} />
      <polyline className="depth-fig__bone" fill="none" points={`${ankle} ${knee} ${hip} ${shoulder}`} />
      <line className="depth-fig__bone" x1={ankle[0]} y1={ankle[1]} x2={toe[0]} y2={toe[1]} />
      <line className="depth-fig__bone" x1={shoulder[0]} y1={shoulder[1]} x2={shoulder[0] + 2} y2={headCy + 6} />
      <circle className="depth-fig__bone" cx={shoulder[0] + 2} cy={headCy} r="7" fill="none" />
      <circle className="depth-fig__joint" cx={ankle[0]} cy={ankle[1]} r="3.2" />
      <circle className="depth-fig__joint" cx={knee[0]} cy={knee[1]} r="3.2" />
      <circle className="depth-fig__hip" cx={hip[0]} cy={hip[1]} r="4.6" />
    </svg>
  );
}

const PUSHUP_PRESETS: { id: PushupDepthPreset; title: string; desc: string; sub: string }[] = [
  { id: "chest", title: "CHEST TO FLOOR", desc: "Shoulders drop below the elbows", sub: "strong pressers, full range" },
  { id: "parallel", title: "UPPER ARM PARALLEL", desc: "Upper arm reaches parallel to the floor (≈90° elbow)", sub: "most people — the military / fitness-test standard" },
  { id: "above", title: "ABOVE PARALLEL", desc: "Shoulders stay a little above the elbows", sub: "beginners, rehab, building up range" },
];

const PUSHUP_VARIANTS: { id: PushupVariant; title: string; desc: string }[] = [
  { id: "toes", title: "TOES", desc: "Standard push-up. The body line is judged shoulder → hip → ankle." },
  { id: "knees", title: "KNEES", desc: "Knees on the floor. The body line is judged shoulder → hip → knee, so a straight knee push-up isn't read as sagging." },
];

/** Side-view push-up stick figure at a preset's bottom upper-arm angle (head left, toes right),
 *  with a dashed elbow-height reference so "parallel" reads at a glance. */
function PushupFigure({ upperArmDeg }: { upperArmDeg: number }) {
  const ELBOW_Y = 96;
  const wrist: [number, number] = [64, 124];
  const elbow: [number, number] = [64, ELBOW_Y];
  const a = (upperArmDeg * Math.PI) / 180;
  const shoulder: [number, number] = [elbow[0] - 30 * Math.cos(a), elbow[1] + 30 * Math.sin(a)];
  const toe: [number, number] = [122, 124];
  const hip: [number, number] = [shoulder[0] + (toe[0] - shoulder[0]) * 0.42, shoulder[1] + (toe[1] - shoulder[1]) * 0.42];
  return (
    <svg className="depth-fig" viewBox="0 0 130 140" aria-hidden="true">
      <line className="depth-fig__ground" x1="8" y1="128" x2="126" y2="128" />
      <line className="depth-fig__ref" x1="8" y1={ELBOW_Y} x2="126" y2={ELBOW_Y} />
      <polyline className="depth-fig__bone" fill="none" points={`${wrist} ${elbow} ${shoulder} ${hip} ${toe}`} />
      <circle className="depth-fig__bone" cx={shoulder[0] - 11} cy={shoulder[1] - 5} r="7" fill="none" />
      <circle className="depth-fig__joint" cx={wrist[0]} cy={wrist[1]} r="3.2" />
      <circle className="depth-fig__joint" cx={elbow[0]} cy={elbow[1]} r="3.2" />
      <circle className="depth-fig__hip" cx={shoulder[0]} cy={shoulder[1]} r="4.6" />
    </svg>
  );
}

const MODES: { id: SquatMode; title: string; desc: string }[] = [
  { id: "bodyweight", title: "BODYWEIGHT", desc: "No external load. Depth, lean and valgus are read as goal / motor-control signals, not safety faults." },
  { id: "loaded", title: "LOADED", desc: "Barbell / weighted. Enables early-onset butt-wink and excessive-depth flags; depth and valgus are read more cautiously." },
];

export function SettingsView({
  preset,
  onChange,
  mode,
  onModeChange,
  apiEnabled,
  onApiEnabledChange,
  apiKey,
  exercise = "squat",
  pushupPreset = "parallel",
  onPushupPresetChange = () => {},
  pushupVariant = "toes",
  onPushupVariantChange = () => {},
}: {
  exercise?: ExerciseId;
  pushupPreset?: PushupDepthPreset;
  onPushupPresetChange?: (p: PushupDepthPreset) => void;
  pushupVariant?: PushupVariant;
  onPushupVariantChange?: (v: PushupVariant) => void;
  preset: DepthPreset;
  onChange: (p: DepthPreset) => void;
  mode: SquatMode;
  onModeChange: (m: SquatMode) => void;
  apiEnabled: boolean;
  onApiEnabledChange: (enabled: boolean) => void;
  apiKey: ApiKeyControl;
}) {
  const apiKeyPresent = apiKey.present;
  return (
    <section className="settings">
      <div className="panel settings-block">
        <p className="panel__title">GEMINI API KEY</p>
        <p className="settings-block__hint">
          The AI debriefs run on your own Google AI Studio key, straight from this browser. It is
          stored on this device only — it is never sent anywhere but Google, and never reaches a
          server of ours. Everything the camera does works without one.
        </p>
        <form
          className="apikey"
          onSubmit={(e) => {
            e.preventDefault();
            apiKey.save();
          }}
        >
          <input
            className="apikey__input"
            type="password"
            value={apiKey.draft}
            onChange={(e) => apiKey.setDraft(e.target.value)}
            placeholder={apiKey.saved ? "Key saved — type a new one to replace it" : "Paste your API key"}
            aria-label="Gemini API key"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="apikey__save" disabled={!apiKey.dirty}>
            Save
          </button>
        </form>
        <p className={"apikey__status" + (apiKeyPresent ? " apikey__status--ok" : "")}>
          {apiKey.saved ? (
            <>
              ✓ Key saved on this device.{" "}
              <button type="button" className="apikey__clear" onClick={apiKey.clear}>
                Remove it
              </button>
            </>
          ) : apiKeyPresent ? (
            "Using the key from .env.local (development build only)."
          ) : (
            "No key set — AI debriefs are off. Local checks, rep counting and triggers all still run."
          )}
        </p>
        <p className="settings-block__hint">
          Get one free at{" "}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer noopener">
            aistudio.google.com/apikey
          </a>
          .
        </p>
      </div>

      <div className="panel settings-block">
        <p className="panel__title">AI COACH (API CALLS)</p>
        <p className="settings-block__hint">
          {apiKeyPresent
            ? "Turn off to exercise the UI and tune the raw number tracking without firing any Gemini call. Mid-set, post-set and post-workout calls are all short-circuited; every local check and trigger still runs."
            : "No API key set, so calls are already disabled. This switch has no effect until you save a key above."}
        </p>
        <button
          type="button"
          className={"api-toggle" + (apiEnabled ? " api-toggle--on" : "")}
          role="switch"
          aria-checked={apiEnabled}
          disabled={!apiKeyPresent}
          onClick={() => onApiEnabledChange(!apiEnabled)}
        >
          <span className="api-toggle__track">
            <span className="api-toggle__thumb" />
          </span>
          <span className="api-toggle__label">
            API calls {apiEnabled ? "ON" : "OFF"}
            {apiEnabled ? "" : " — no Gemini calls will fire"}
          </span>
        </button>
      </div>

      {exercise === "pushup" ? (
        <>
          <div className="panel settings-block">
            <p className="panel__title">PUSH-UP VARIANT</p>
            <p className="settings-block__hint">
              Which push-up you're doing. It changes the straight-line reference the body-line check uses. Switching
              exercise lives in the header.
            </p>
            <div className="mode-toggle">
              {PUSHUP_VARIANTS.map((v) => {
                const selected = v.id === pushupVariant;
                return (
                  <button
                    key={v.id}
                    type="button"
                    className={"mode-card" + (selected ? " mode-card--active" : "")}
                    aria-pressed={selected}
                    onClick={() => onPushupVariantChange(v.id)}
                  >
                    <p className="mode-card__title">
                      {v.title}
                      {selected && <span className="depth-card__check">✓</span>}
                    </p>
                    <p className="mode-card__desc">{v.desc}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="panel settings-block">
            <p className="panel__title">PUSH-UP DEPTH TARGET</p>
            <p className="settings-block__hint">
              How low a rep must go to count. Every rep must also press back up to straight arms. Side sets judge the
              upper-arm angle; head-on sets judge how far the shoulders drop. Changes apply from the next set.
            </p>
            <div className="depth-presets">
              {PUSHUP_PRESETS.map((p) => {
                const selected = p.id === pushupPreset;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={"depth-card" + (selected ? " depth-card--active" : "")}
                    aria-pressed={selected}
                    onClick={() => onPushupPresetChange(p.id)}
                  >
                    <PushupFigure upperArmDeg={PUSHUP_DEPTH_PRESETS[p.id].targetUpperArmDeg} />
                    <p className="depth-card__title">
                      {p.title}
                      {selected && <span className="depth-card__check">✓</span>}
                    </p>
                    <p className="depth-card__desc">{p.desc}</p>
                    <p className="depth-card__sub">for: {p.sub}</p>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      ) : (
        <>
      <div className="panel settings-block">
        <p className="panel__title">TRAINING MODE</p>
        <p className="settings-block__hint">
          Whether you're lifting under load. This changes how cautiously the coach reads depth, butt wink and valgus.
        </p>
        <div className="mode-toggle">
          {MODES.map((m) => {
            const selected = m.id === mode;
            return (
              <button
                key={m.id}
                type="button"
                className={"mode-card" + (selected ? " mode-card--active" : "")}
                aria-pressed={selected}
                onClick={() => onModeChange(m.id)}
              >
                <p className="mode-card__title">
                  {m.title}
                  {selected && <span className="depth-card__check">✓</span>}
                </p>
                <p className="mode-card__desc">{m.desc}</p>
              </button>
            );
          })}
        </div>
      </div>

      <div className="panel settings-block">
        <p className="panel__title">SQUAT DEPTH TARGET</p>
        <p className="settings-block__hint">
          How deep a rep must go to count as good depth. Side-view depth checks score against this target.
        </p>
        <div className="depth-presets">
          {PRESETS.map((p) => {
            const selected = p.id === preset;
            return (
              <button
                key={p.id}
                type="button"
                className={"depth-card" + (selected ? " depth-card--active" : "")}
                aria-pressed={selected}
                onClick={() => onChange(p.id)}
              >
                <DepthFigure hipY={p.hipY} />
                <p className="depth-card__title">
                  {p.title}
                  {selected && <span className="depth-card__check">✓</span>}
                </p>
                <p className="depth-card__desc">{p.desc}</p>
                <p className="depth-card__sub">for: {p.sub}</p>
              </button>
            );
          })}
        </div>
      </div>

        </>
      )}

      <UsagePanel />
    </section>
  );
}
