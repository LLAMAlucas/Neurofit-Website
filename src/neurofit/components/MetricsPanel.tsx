/**
 * Live orientation-gated metric panel. Shows every metric with its status, so
 * "not-checked" (wrong view for this set) and "unavailable" (bar path) are
 * visibly distinct from a clean pass — never silently hidden.
 */
import type { CheckStatus, Severity } from "../squat/metrics";

/** One live check, in whichever exercise's vocabulary (the caller orders + labels them). */
export interface MetricRow {
  id: string;
  label: string;
  status: CheckStatus;
  severity: Severity;
  message: string;
}

const ICON: Record<CheckStatus, string> = {
  ok: "✓",
  warn: "!",
  unknown: "?",
  "not-checked": "–",
  unavailable: "∅",
};

export function MetricsPanel({ rows, emptyText }: { rows: MetricRow[] | null; emptyText: string }) {
  return (
    <section className="panel">
      <p className="panel__title">FORM CHECKS</p>
      {!rows ? (
        <p className="panel__empty">{emptyText}</p>
      ) : (
        <div className="cue-list">
          {rows.map((r) => {
            // A warned check is colored by its severity zone (warning vs critical);
            // everything else keeps its status styling.
            const sevClass = r.status === "warn" ? " cue--severity-" + r.severity : "";
            const icon = r.status === "warn" && r.severity === "critical" ? "‼" : ICON[r.status];
            return (
              <div className={"cue cue--" + r.status + sevClass} key={r.id}>
                <span className="cue__icon">{icon}</span>
                <span className="cue__label">{r.label}</span>
                <span className="cue__msg">{r.message}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
