/**
 * Live orientation-gated metric panel. Shows every metric with its status, so
 * "not-checked" (wrong view for this set) and "unavailable" (bar path) are
 * visibly distinct from a clean pass — never silently hidden.
 */
import { METRIC_ORDER, METRICS, type CheckStatus } from "../squat/metrics";
import type { RepMetrics } from "../squat/checks";

const ICON: Record<CheckStatus, string> = {
  ok: "✓",
  warn: "!",
  unknown: "?",
  "not-checked": "–",
  unavailable: "∅",
};

export function MetricsPanel({ metrics }: { metrics: RepMetrics | null }) {
  return (
    <section className="panel">
      <p className="panel__title">FORM CHECKS</p>
      {!metrics ? (
        <p className="panel__empty">Lock a set and start squatting to see gated form checks.</p>
      ) : (
        <div className="cue-list">
          {METRIC_ORDER.map((id) => {
            const r = metrics[id];
            // A warned check is colored by its severity zone (warning vs critical);
            // everything else keeps its status styling.
            const sevClass = r.status === "warn" ? " cue--severity-" + r.severity : "";
            const icon = r.status === "warn" && r.severity === "critical" ? "‼" : ICON[r.status];
            return (
              <div className={"cue cue--" + r.status + sevClass} key={id}>
                <span className="cue__icon">{icon}</span>
                <span className="cue__label">{METRICS[id].label}</span>
                <span className="cue__msg">{r.message}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
