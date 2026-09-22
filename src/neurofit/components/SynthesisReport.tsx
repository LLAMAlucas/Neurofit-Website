/**
 * Post-workout synthesis report. Renders the deterministic cross-set summary
 * (always available) and, above it, the `callPostWorkout` narrative READ-ONLY —
 * there is no regenerate affordance (the old "deep analysis" button used a weaker
 * prompt and overwrote this with worse output, so it was removed).
 * Explicit about anything not assessed and about bar path being an intentional
 * gap — nothing is silently omitted.
 */
import { useState } from "react";
import type { AnalysisState, PostSetReview } from "../hooks/useWorkout";
import { compactRanges, type WorkoutReport, type SetSummary, type SynthStatus } from "../session/synthesis";

const DOT: Record<SynthStatus, string> = { ok: "✓", warn: "!", "not-assessed": "–", unavailable: "∅" };

function setSummaryText(s: SetSummary): string {
  if (s.attempts === 0) {
    return `Set ${s.index} · ${s.orientation} — No reps recorded — check camera position and try again`;
  }
  if (s.tallyText) return s.tallyText;
  if (s.orientation === "side") {
    const missed = s.depthMissed.length ? ` — missed: rep ${compactRanges(s.depthMissed)}` : "";
    return `Set ${s.index} · side — ${s.counted}/${s.attempts} reps hit depth${missed}`;
  }
  return `Set ${s.index} · front — ${s.counted} rep${s.counted === 1 ? "" : "s"}`;
}

export function SynthesisReport({
  report,
  analysis,
  postSetReviews,
  onNewWorkout,
}: {
  report: WorkoutReport;
  /** Post-workout summary, fired automatically on finish. Read-only — there is no
   *  regenerate affordance (the legacy "Generate" button used a weaker prompt and
   *  overwrote this text with worse output). */
  analysis: AnalysisState;
  /** Per-set post-set analysis captured during the workout (set index → review). */
  postSetReviews: Record<number, PostSetReview>;
  onNewWorkout: () => void;
}) {
  const [openSet, setOpenSet] = useState<number | null>(null);
  return (
    <div className="report">
      <div className="report__head">
        <h2>Workout report</h2>
        <button className="lg-btn btn" onClick={onNewWorkout}>
          New workout
        </button>
      </div>

      <p className="report__headline">{report.headline}</p>
      <p className="report__meta">
        {report.setCount} sets · {report.totalReps} reps · orientations: {report.orientationsUsed.join(", ") || "none"}
      </p>

      {report.setSummaries.length > 0 && (
        <div className="report__sets">
          {report.setSummaries.map((s) => {
            const open = openSet === s.index;
            const cues = report.coachingCues.filter((c) => c.set === s.index);
            const review = postSetReviews[s.index];
            return (
              <div className={"report-set report-set--" + (s.attempts === 0 ? "empty" : s.orientation)} key={s.index}>
                <button className="report-set__head" onClick={() => setOpenSet(open ? null : s.index)} aria-expanded={open}>
                  <span className="report-set__line">{setSummaryText(s)}</span>
                  <span className="report-set__chevron">{open ? "▾" : "▸"}</span>
                </button>
                {s.postSetNotes.length > 0 && (
                  <ul className="report-set__notes">
                    {s.postSetNotes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}
                {open && (
                  <div className="report-set__review">
                    <p className="report-set__sub">Mid-set cues</p>
                    {cues.length > 0 ? (
                      <ul className="report-set__cues">
                        {cues.map((c, i) => (
                          <li key={i}>
                            <span className="report-set__cue-rep">rep {c.rep}</span> {c.cue}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="report-set__muted">No mid-set cues this set.</p>
                    )}
                    <p className="report-set__sub">Post-set analysis</p>
                    {reviewBody(review)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="report__metrics">
        {report.metrics.map((m) => (
          <div className={"report-row report-row--" + m.status} key={m.metric}>
            <span className="report-row__dot">{DOT[m.status]}</span>
            <div>
              <p className="report-row__label">
                {m.label}
                {m.setsChecked.length > 0 && <span className="report-row__sets"> · set {m.setsChecked.join(", ")}</span>}
              </p>
              <p className="report-row__summary">{m.summary}</p>
            </div>
          </div>
        ))}
      </div>

      <section className="report__ai">
        <div className="report__ai-head">
          <p className="panel__title">AI SESSION SUMMARY</p>
        </div>
        {analysisBody(analysis)}
      </section>
    </div>
  );
}

/** Read-only render of a set's persisted post-set analysis (no fetch). Handles the
 *  last set / skipped sets gracefully — they simply have no analysis. */
function reviewBody(review: PostSetReview | undefined) {
  if (!review || review.status === "none") {
    return <p className="report-set__muted">No post-set analysis for this set.</p>;
  }
  if (review.status === "loading") {
    return <p className="ai-msg ai-msg--loading">Still analyzing…</p>;
  }
  if (review.status === "blocked") {
    return <p className="ai-msg ai-msg--error">{review.message}</p>;
  }
  if (review.status === "disabled") {
    return <p className="report-set__muted">AI coaching was off for this session.</p>;
  }
  return <p className="ai-msg ai-msg--ok">{review.text}</p>; // status === "ok"
}

/** Read-only render of the post-workout summary. The copy is passive throughout —
 *  there is no button, so nothing here may imply the user can trigger a retry. */
function analysisBody(analysis: AnalysisState) {
  switch (analysis.status) {
    case "disabled":
      return (
        <p className="panel__empty">
          The session summary needs a Gemini API key — add one in Settings. The report above is complete without it.
        </p>
      );
    case "idle":
      return <p className="panel__empty">No session summary was generated for this workout.</p>;
    case "loading":
      return <p className="ai-msg ai-msg--loading">Synthesizing the session…</p>;
    case "ok":
      return <p className="ai-msg ai-msg--ok">{analysis.text}</p>;
    case "error":
      return <p className="ai-msg ai-msg--error">{analysis.message}</p>;
  }
}
