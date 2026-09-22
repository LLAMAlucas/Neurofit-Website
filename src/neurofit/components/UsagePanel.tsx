/**
 * Usage & limits panel (Settings tab).
 * ----------------------------------------------------------------------------
 * Surfaces what the ledger has recorded — API calls, tokens, latency, and the
 * session stats nothing previously tracked (length, completion, counted-vs-
 * attempted reps) — plus the rolling call cap.
 *
 * The cap ships DISABLED. It exists so the limit can be trialled from settings
 * once there are real numbers, without a code change. It is a client-side spend
 * guard over localStorage, not a security control — the copy says so, because
 * anyone can clear site data to reset it.
 */
import { useUsage } from "../hooks/useUsage";
import { MONTH_MS, type CallTier } from "../usage/ledger";

const TIER_LABEL: Record<CallTier, string> = {
  post_set: "Post-set debrief",
  post_workout: "Post-workout summary",
  deep_analysis: "Deep analysis (removed)",
  mid_set: "Mid-set (removed)",
};

const WINDOWS: { label: string; ms: number }[] = [
  { label: "7 days", ms: 7 * 86_400_000 },
  { label: "30 days", ms: MONTH_MS },
  { label: "90 days", ms: 90 * 86_400_000 },
];

function fmtDuration(ms: number | null): string {
  if (ms === null || ms <= 0) return "—";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtPct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}

export function UsagePanel() {
  const { summary, policy, verdict, setPolicy, clear, download } = useUsage();
  const w = summary.workouts;
  const hasData = summary.totalSent > 0 || w.count > 0;

  return (
    <>
      <div className="panel settings-block">
        <p className="panel__title">API USAGE</p>
        <p className="settings-block__hint">
          Recorded locally on this device for every Gemini call. Nothing is uploaded. This is the
          data a usage limit would later be based on.
        </p>

        {!hasData ? (
          <p className="panel__empty">No usage recorded yet — finish a set with the AI coach on.</p>
        ) : (
          <>
            <div className="usage-grid">
              <Stat label="Calls sent" value={fmtNum(summary.totalSent)} />
              <Stat label="Last 30 days" value={fmtNum(summary.sentLast30d)} />
              <Stat label="Last 7 days" value={fmtNum(summary.sentLast7d)} />
              <Stat label="Blocked / skipped" value={fmtNum(summary.totalSkipped)} />
              <Stat label="Errors" value={`${fmtNum(summary.totalErrors)} (${fmtPct(summary.errorRate)})`} />
              <Stat label="Images sent" value={fmtNum(summary.images)} />
              <Stat label="Tokens total" value={fmtNum(summary.tokens.total)} />
              <Stat label="— of which thinking" value={fmtNum(summary.tokens.thinking)} />
              <Stat label="Latency p50 / p95" value={`${fmtDuration(summary.latencyMs.p50)} / ${fmtDuration(summary.latencyMs.p95)}`} />
            </div>

            <p className="usage-sub">By tier</p>
            <ul className="usage-tiers">
              {(Object.keys(TIER_LABEL) as CallTier[])
                .filter((t) => summary.byTier[t] && (summary.byTier[t].sent > 0 || summary.byTier[t].skipped > 0))
                .map((t) => (
                  <li key={t}>
                    <span className="usage-tiers__name">{TIER_LABEL[t]}</span>
                    <span className="usage-tiers__val">
                      {summary.byTier[t].sent} sent
                      {summary.byTier[t].errors > 0 ? ` · ${summary.byTier[t].errors} err` : ""}
                      {summary.byTier[t].skipped > 0 ? ` · ${summary.byTier[t].skipped} skipped` : ""}
                    </span>
                  </li>
                ))}
            </ul>
          </>
        )}
      </div>

      <div className="panel settings-block">
        <p className="panel__title">SESSIONS</p>
        <p className="settings-block__hint">
          Recorded when you finish a workout — the session-length and completion data the app
          previously had no record of.
        </p>
        {w.count === 0 ? (
          <p className="panel__empty">No finished workouts recorded yet.</p>
        ) : (
          <div className="usage-grid">
            <Stat label="Workouts" value={fmtNum(w.count)} />
            <Stat label="Median length" value={fmtDuration(w.medianDurationMs)} />
            <Stat label="Sets" value={fmtNum(w.totalSets)} />
            <Stat label="Reps counted" value={fmtNum(w.totalRepsCounted)} />
            <Stat label="Reps attempted" value={fmtNum(w.totalRepsAttempted)} />
            <Stat label="Depth-gate pass rate" value={fmtPct(w.repCountRate)} />
          </div>
        )}
      </div>

      <div className="panel settings-block">
        <p className="panel__title">USAGE LIMIT</p>
        <p className="settings-block__hint">
          A rolling cap on API calls. Off by default. Client-side only — clearing site data resets
          it, so treat it as a spend guard rather than enforcement.
        </p>

        <button
          type="button"
          className={"api-toggle" + (policy.enabled ? " api-toggle--on" : "")}
          role="switch"
          aria-checked={policy.enabled}
          onClick={() => setPolicy({ ...policy, enabled: !policy.enabled })}
        >
          <span className="api-toggle__track">
            <span className="api-toggle__thumb" />
          </span>
          <span className="api-toggle__label">Limit {policy.enabled ? "ON" : "OFF"}</span>
        </button>

        <div className="usage-policy">
          <label className="usage-policy__field">
            <span>Max calls</span>
            <input
              type="number"
              min={0}
              step={10}
              value={policy.maxCalls}
              onChange={(e) => setPolicy({ ...policy, maxCalls: Math.max(0, Number(e.target.value) || 0) })}
            />
          </label>
          <label className="usage-policy__field">
            <span>Per</span>
            <select value={policy.windowMs} onChange={(e) => setPolicy({ ...policy, windowMs: Number(e.target.value) })}>
              {WINDOWS.map((x) => (
                <option key={x.ms} value={x.ms}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className={"usage-verdict" + (verdict.enabled && !verdict.allowed ? " usage-verdict--blocked" : "")}>
          {verdict.enabled
            ? verdict.allowed
              ? `${verdict.used} of ${verdict.limit} used · ${verdict.remaining} remaining in the current window.`
              : `Limit reached (${verdict.used}/${verdict.limit}). Calls are blocked until ${
                  verdict.resetsAtMs ? new Date(verdict.resetsAtMs).toLocaleString() : "the window rolls over"
                }.`
            : `Not enforced. ${verdict.used} call${verdict.used === 1 ? "" : "s"} in the last ${
                WINDOWS.find((x) => x.ms === policy.windowMs)?.label ?? "window"
              }.`}
        </p>

        <div className="usage-actions">
          <button className="lg-btn btn btn--sm" onClick={download}>
            Export usage JSON
          </button>
          <button
            className="lg-btn btn btn--sm"
            onClick={() => {
              if (confirm("Delete all recorded usage history? This cannot be undone.")) clear();
            }}
          >
            Clear history
          </button>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="usage-stat">
      <span className="usage-stat__value">{value}</span>
      <span className="usage-stat__label">{label}</span>
    </div>
  );
}
