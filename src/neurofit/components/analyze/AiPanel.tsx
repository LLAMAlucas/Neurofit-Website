/**
 * The AI coach for a clip: "Find my form errors" over the whole clip, and "Ask about this frame".
 * ----------------------------------------------------------------------------
 * Nothing is sent until a button is pressed, and each button says roughly what it costs first
 * (the user's own Gemini key pays). Answers render field by field as plain text — no markdown
 * parser, same as the live coach — and every issue can jump the player to the frame it is about.
 */
import { useState } from "react";
import { ANALYZE } from "../../analyze/config";
import type { FormIssue, FormResult } from "../../analyze/aiResult";
import type { AiStatus, ClipSession } from "../../hooks/useClipSession";
import { fmtTime } from "./Timeline";

const SEVERITY_LABEL: Record<FormIssue["severity"], string> = { high: "Fix first", medium: "Fix", low: "Polish" };

function StatusLine({ status, onOpenSettings, progress }: { status: AiStatus; onOpenSettings: () => void; progress?: number | null }) {
  switch (status.kind) {
    case "working":
      return <p className="ai-msg ai-msg--loading">{status.step}{progress != null ? ` · ${Math.round(progress * 100)}%` : ""}</p>;
    case "error":
      return <p className="ai-msg ai-msg--error">{status.message}</p>;
    case "blocked":
      return <p className="ai-msg ai-msg--error">{status.message}</p>;
    case "disabled":
      return (
        <p className="panel__empty">
          {status.reason === "no_key" ? "The AI coach needs your Gemini API key. " : "AI calls are switched off. "}
          <button type="button" className="az-link" onClick={onOpenSettings}>
            Open Settings
          </button>
        </p>
      );
    default:
      return null;
  }
}

export function FormResultCard({ result, frameTimesMs, onJump, compact = false }: { result: FormResult; frameTimesMs: number[]; onJump: (tMs: number) => void; compact?: boolean }) {
  const tFor = (frame: number | null) => (frame !== null && frameTimesMs[frame - 1] !== undefined ? frameTimesMs[frame - 1] : null);
  return (
    <div className="az-result">
      {result.exercise && (
        <p className="az-result__exercise">
          {result.exercise}
          {result.exerciseConfidence === "unsure" ? " (not sure)" : result.exerciseConfidence === "likely" ? " (likely)" : ""}
        </p>
      )}
      {result.summary && <p className="ai-msg ai-msg--ok">{result.summary}</p>}
      {result.issues.length > 0 && (
        <ol className="az-issues">
          {result.issues.map((i, k) => {
            const t = tFor(i.frame);
            return (
              <li key={k} className={`az-issue az-issue--${i.severity}`}>
                <div className="az-issue__head">
                  <span className={`az-sev az-sev--${i.severity}`}>{SEVERITY_LABEL[i.severity]}</span>
                  <span className="az-issue__title">{i.title}</span>
                  {t !== null && (
                    <button type="button" className="lg-btn btn--sm az-issue__jump" onClick={() => onJump(t)} title="Show this frame">
                      {fmtTime(t)}
                    </button>
                  )}
                </div>
                {i.reps.length > 0 && <p className="az-issue__reps">Rep{i.reps.length > 1 ? "s" : ""} {i.reps.join(", ")}</p>}
                {i.whatWeSee && <p className="az-issue__see">{i.whatWeSee}</p>}
                {i.howToFix && (
                  <p className="az-issue__fix">
                    <span className="az-issue__tag">Fix</span>
                    {i.howToFix}
                  </p>
                )}
                {i.cue && (
                  <p className="az-issue__cue">
                    <span className="az-issue__tag">Think</span>“{i.cue}”
                  </p>
                )}
                {i.drill && !compact && (
                  <p className="az-issue__drill">
                    <span className="az-issue__tag">Try</span>
                    {i.drill}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {result.looksGood.length > 0 && (
        <div className="az-result__list">
          <p className="panel__title">Looks good</p>
          <ul>
            {result.looksGood.map((s, k) => (
              <li key={k}>{s}</li>
            ))}
          </ul>
        </div>
      )}
      {result.cannotJudge.length > 0 && (
        <div className="az-result__list az-result__list--muted">
          <p className="panel__title">Can’t judge from this view</p>
          <ul>
            {result.cannotJudge.map((s, k) => (
              <li key={k}>{s}</li>
            ))}
          </ul>
        </div>
      )}
      {result.refilmTip && (
        <p className="az-result__tip">
          <span className="az-issue__tag">Filming tip</span>
          {result.refilmTip}
        </p>
      )}
    </div>
  );
}

export function AiPanel({ session, filter, onOpenSettings }: { session: ClipSession; filter?: string; onOpenSettings: () => void }) {
  const { rec, player } = session;
  const [question, setQuestion] = useState("");
  const clipAi = rec.record.clipAi;
  const busyClip = session.clipAi.kind === "working";
  const busyFrame = session.frameAi.kind === "working";
  const jump = (t: number) => {
    player.pause();
    player.seek(t);
  };
  const here = rec.record.frameAi.filter((f) => Math.abs(f.tMs - player.tMs) < 500 / player.fps);
  const elsewhere = rec.record.frameAi.filter((f) => !here.includes(f)).sort((a, b) => a.tMs - b.tMs);

  return (
    <div className="az-ai">
      <label className="az-field">
        <span className="panel__title">Exercise (optional)</span>
        <input
          className="az-input"
          type="text"
          maxLength={ANALYZE.ai.maxExerciseChars}
          placeholder="e.g. back squat, deadlift, kettlebell swing"
          value={rec.record.exerciseHint}
          onChange={(e) => rec.set((r) => ({ ...r, exerciseHint: e.target.value }))}
        />
      </label>

      <section className="az-ai__block" aria-labelledby="az-ai-clip">
        <h3 className="panel__title" id="az-ai-clip">
          Whole clip
        </h3>
        <p className="panel__empty">
          Finds the form errors worth fixing and how to fix each one. Sends up to {ANALYZE.ai.clip.maxFrames} still frames (first, middle and last rep) — never the video.
        </p>
        <button type="button" className="lg-btn lg-btn--tint az-ai__go" onClick={() => void session.runClip(filter)} disabled={busyClip || session.tooLong || !player.meta}>
          {clipAi ? "Analyze again" : "Find my form errors"} · {session.clipCost}
        </button>
        {session.tooLong && <p className="panel__empty">This clip is long: set in and out marks around the set first.</p>}
        <StatusLine status={session.clipAi} onOpenSettings={onOpenSettings} progress={session.pose.status === "running" ? session.pose.progress : null} />
        {clipAi && !busyClip && (
          <>
            <p className="az-ai__meta">
              Answer from {new Date(clipAi.createdAtMs).toLocaleString()} · saved with this clip
            </p>
            <FormResultCard result={clipAi.result} frameTimesMs={clipAi.frameTimesMs} onJump={jump} />
          </>
        )}
      </section>

      <section className="az-ai__block" aria-labelledby="az-ai-frame">
        <h3 className="panel__title" id="az-ai-frame">
          This frame · {fmtTime(player.tMs)}
        </h3>
        <label className="az-field">
          <span className="sr-only">Your question about this frame</span>
          <textarea
            className="az-input az-input--area"
            rows={2}
            maxLength={ANALYZE.ai.frame.maxQuestionChars}
            placeholder="Ask something specific (optional) — e.g. “Is my back rounding here?”"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>
        <button type="button" className="lg-btn lg-btn--tint az-ai__go" onClick={() => void session.askFrame(question, filter)} disabled={busyFrame || !player.meta}>
          Ask about this frame · {session.frameCost}
        </button>
        <StatusLine status={session.frameAi} onOpenSettings={onOpenSettings} />
        {here
          .slice()
          .reverse()
          .map((f) => (
            <div key={`${f.tMs}-${f.createdAtMs}`} className="az-ai__answer">
              {f.question && <p className="az-ai__q">“{f.question}”</p>}
              <FormResultCard result={f.result} frameTimesMs={f.frameTimesMs} onJump={jump} />
            </div>
          ))}
        {elsewhere.length > 0 && (
          <div className="az-ai__others">
            <p className="panel__title">Other frames you asked about</p>
            <div className="az-chips">
              {elsewhere.map((f) => (
                <button key={`${f.tMs}-${f.createdAtMs}`} type="button" className="lg-btn btn--sm" onClick={() => jump(f.tMs)} title={f.question || f.result.summary}>
                  {fmtTime(f.tMs)}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>
      <p className="panel__foot">
        Uses your own Gemini key. Costs are estimates — the Usage section in Settings shows real token counts. Pose angles are 2D estimates from the picture.
      </p>
    </div>
  );
}
