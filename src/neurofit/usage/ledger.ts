/**
 * Usage ledger — API-call + workout accounting. PURE module.
 * ----------------------------------------------------------------------------
 * Why this exists: every Gemini call costs money, and there is currently no
 * record that a call ever happened. Before usage can be LIMITED it has to be
 * MEASURED, and before it can be measured it has to survive a page reload. This
 * module owns the data model and every piece of arithmetic; `usage/usageStore.ts`
 * is the thin browser half that persists it.
 *
 * Two record types, deliberately separate:
 *   - UsageCall    — one Gemini request attempt (the thing that costs money).
 *   - UsageWorkout — one workout session (the thing that answers "how long is a
 *                    session / do people finish them", which nothing tracked).
 *
 * Design rules:
 *  - PURE: no localStorage, no Date.now(), no DOM. Every function that needs the
 *    clock takes `nowMs`. That is what makes quota logic unit-testable without
 *    faking timers, and it is why this file (not the store) holds the math.
 *  - APPEND-ONLY + BOUNDED. localStorage is ~5 MB and a corrupt/oversized entry
 *    breaks the whole app, so every append prunes by BOTH age and count.
 *  - COUNT ONLY WHAT WAS SENT. A call blocked by the quota gate or short-circuited
 *    by the kill-switch never reached Google, so it must not consume quota — a
 *    gate that counts its own refusals would permanently lock a user out.
 */

/** Bump when the persisted shape changes incompatibly; the store discards mismatches. */
export const USAGE_SCHEMA_VERSION = 1;

/** Which Gemini tier a call belongs to. Mirrors GeminiCallObservation["tier"].
 *  Two of these are RETIRED and retained only so ledgers written before their
 *  removal still parse (dropping a value would fail `isLedger` and wipe history):
 *    - `mid_set`       — removed; latency made real-time cues unusable.
 *    - `deep_analysis` — removed; the manual "Generate" button used a weaker prompt
 *                        and overwrote the good post-workout summary.
 *  Live tiers are `post_set` and `post_workout`. */
export type CallTier = "mid_set" | "post_set" | "post_workout" | "deep_analysis";

/**
 * Outcome of a call attempt.
 *  - response / no_cue : the request WAS sent and Google answered (billable).
 *  - error             : the request WAS sent (or attempted over the network) and
 *                        failed. Counted as sent: a 500/timeout may still have been
 *                        metered, and more importantly a failing key must not become
 *                        an infinite free retry loop.
 *  - skipped_*         : short-circuited locally. NEVER sent, never billable.
 */
export type CallOutcome = "response" | "no_cue" | "error" | "skipped_quota" | "skipped_rate_limit";

/** True when this outcome represents a request that actually left the browser. */
export function wasSent(outcome: CallOutcome): boolean {
  return outcome === "response" || outcome === "no_cue" || outcome === "error";
}

export interface UsageCall {
  tsMs: number;
  tier: CallTier;
  outcome: CallOutcome;
  /** Model id at call time — usage predates/outlives any single model. */
  model: string;
  /** Workout session this call belonged to (joins calls to workouts). */
  sessionId: string;
  /** Round-trip ms; null when nothing was sent. */
  latencyMs: number | null;
  /** Inline JPEGs attached — the dominant cost driver on the post-set tier. */
  imageCount: number;
  promptTokens: number | null;
  outputTokens: number | null;
  /** Thinking tokens: billed as output and drawn from the same budget. */
  thinkingTokens: number | null;
}

export interface UsageWorkout {
  sessionId: string;
  startedMs: number;
  endedMs: number;
  durationMs: number;
  sets: number;
  repsCounted: number;
  repsAttempted: number;
  /** True when the user ended it via Finish/End workout rather than abandoning it. */
  completed: boolean;
  mode: string;
  depthPreset: string;
}

export interface UsageLedger {
  version: number;
  /** Stable random id for this browser profile. Not an account — the join key a
   *  server-side quota would later attach to. Contains no personal data. */
  installId: string;
  firstSeenMs: number;
  calls: UsageCall[];
  workouts: UsageWorkout[];
}

/** Storage bounds. ~200 bytes/call, so 2000 calls ≈ 400 KB — well inside the
 *  ~5 MB localStorage budget while covering far more history than a quota needs. */
export interface LedgerLimits {
  maxCalls: number;
  maxWorkouts: number;
  retentionDays: number;
}

export const DEFAULT_LIMITS: LedgerLimits = {
  maxCalls: 2000,
  maxWorkouts: 500,
  // Longer than any plausible quota window, so pruning can never delete a record
  // the active policy still needs to count.
  retentionDays: 400,
};

export function emptyLedger(installId: string, nowMs: number): UsageLedger {
  return { version: USAGE_SCHEMA_VERSION, installId, firstSeenMs: nowMs, calls: [], workouts: [] };
}

/**
 * Drop records older than the retention window, then hard-cap by count (oldest
 * first). Age is checked against `nowMs` rather than the newest record so a
 * single clock-skewed future timestamp can't wipe the ledger.
 */
export function pruneLedger(ledger: UsageLedger, nowMs: number, limits: LedgerLimits = DEFAULT_LIMITS): UsageLedger {
  const cutoff = nowMs - limits.retentionDays * 86_400_000;
  const calls = ledger.calls.filter((c) => c.tsMs >= cutoff);
  const workouts = ledger.workouts.filter((w) => w.endedMs >= cutoff);
  return {
    ...ledger,
    calls: calls.length > limits.maxCalls ? calls.slice(calls.length - limits.maxCalls) : calls,
    workouts: workouts.length > limits.maxWorkouts ? workouts.slice(workouts.length - limits.maxWorkouts) : workouts,
  };
}

/** Append one call, pruning to stay inside the bounds. Returns a NEW ledger. */
export function appendCall(ledger: UsageLedger, call: UsageCall, limits: LedgerLimits = DEFAULT_LIMITS): UsageLedger {
  return pruneLedger({ ...ledger, calls: [...ledger.calls, call] }, call.tsMs, limits);
}

/** Append one workout, pruning to stay inside the bounds. Returns a NEW ledger. */
export function appendWorkout(ledger: UsageLedger, w: UsageWorkout, limits: LedgerLimits = DEFAULT_LIMITS): UsageLedger {
  return pruneLedger({ ...ledger, workouts: [...ledger.workouts, w] }, w.endedMs, limits);
}

/**
 * Insert-or-replace a workout by sessionId.
 *
 * This is what makes `completed` meaningful. The row is written as soon as the
 * first set ends (completed: false) and REPLACED on finish (completed: true), so
 * a session abandoned by closing the tab correctly stays incomplete. Recording
 * only on finish would make completionRate a constant 100% — a metric that looks
 * real but measures nothing.
 */
export function upsertWorkout(ledger: UsageLedger, w: UsageWorkout, limits: LedgerLimits = DEFAULT_LIMITS): UsageLedger {
  const i = ledger.workouts.findIndex((x) => x.sessionId === w.sessionId);
  if (i < 0) return appendWorkout(ledger, w, limits);
  const workouts = [...ledger.workouts];
  workouts[i] = w;
  return pruneLedger({ ...ledger, workouts }, w.endedMs, limits);
}

/** Human-readable reason for a blocked verdict (shared by the UI and the API layer). */
export function quotaMessage(v: QuotaVerdict): string {
  const resets = v.resetsAtMs ? new Date(v.resetsAtMs).toLocaleDateString() : "soon";
  return `Usage limit reached — ${v.used} of ${v.limit} calls used. More available ${resets}.`;
}

// --- quota -----------------------------------------------------------------

/**
 * A rolling-window call cap. Rolling (not calendar-month) on purpose: it needs no
 * reset job, no timezone decision, and can't be gamed by waiting for the 1st.
 *
 * `enabled` defaults FALSE — this ships as measurement, not enforcement. Flipping
 * it on is a data decision to make once there are real numbers, and it is a
 * settings change rather than a code change so it can be trialled safely.
 *
 * NOTE this is a CLIENT-SIDE cap over localStorage: it is trivially bypassed by
 * clearing site data, so it is a spend guard for honest users, NOT a security
 * control. Real enforcement requires the key to move server-side.
 */
export interface QuotaPolicy {
  enabled: boolean;
  windowMs: number;
  maxCalls: number;
  /** Tiers the cap applies to. Empty = all tiers. */
  tiers?: CallTier[];
}

export const MONTH_MS = 30 * 86_400_000;

export const DEFAULT_QUOTA_POLICY: QuotaPolicy = {
  enabled: false,
  windowMs: MONTH_MS,
  maxCalls: 200,
};

export interface QuotaVerdict {
  /** False only when the policy is enabled AND the window is full. */
  allowed: boolean;
  enabled: boolean;
  used: number;
  limit: number;
  remaining: number;
  windowStartMs: number;
  /** When the oldest counted call ages out (freeing one slot). null when not blocked. */
  resetsAtMs: number | null;
}

/** Calls that count against a policy: sent, in-window, and in a covered tier. */
function countedCalls(ledger: UsageLedger, policy: QuotaPolicy, nowMs: number): UsageCall[] {
  const from = nowMs - policy.windowMs;
  const tiers = policy.tiers;
  return ledger.calls.filter(
    (c) => c.tsMs > from && c.tsMs <= nowMs && wasSent(c.outcome) && (!tiers || tiers.length === 0 || tiers.includes(c.tier)),
  );
}

/**
 * Evaluate the policy against the ledger. Pure — `nowMs` is injected, so the whole
 * quota lifecycle (fill the window, block, age out, unblock) is testable directly.
 */
export function evaluateQuota(ledger: UsageLedger, policy: QuotaPolicy, nowMs: number): QuotaVerdict {
  const windowStartMs = nowMs - policy.windowMs;
  const counted = countedCalls(ledger, policy, nowMs);
  const used = counted.length;
  const limit = policy.maxCalls;
  const remaining = Math.max(0, limit - used);
  const blocked = policy.enabled && used >= limit;
  // The oldest counted call is the one whose expiry frees the next slot.
  const oldest = counted.reduce<number | null>((m, c) => (m === null || c.tsMs < m ? c.tsMs : m), null);
  return {
    allowed: !blocked,
    enabled: policy.enabled,
    used,
    limit,
    remaining,
    windowStartMs,
    resetsAtMs: blocked && oldest !== null ? oldest + policy.windowMs : null,
  };
}

// --- summary ---------------------------------------------------------------

export interface TierStats {
  sent: number;
  errors: number;
  skipped: number;
}

export interface UsageSummary {
  installId: string;
  firstSeenMs: number;
  /** Requests that actually left the browser (the billable count). */
  totalSent: number;
  /** Locally short-circuited attempts (quota/rate-limit) — never billable. */
  totalSkipped: number;
  totalErrors: number;
  /** Errors as a fraction of sent calls (0 when nothing was sent). */
  errorRate: number;
  byTier: Record<CallTier, TierStats>;
  tokens: { prompt: number; output: number; thinking: number; total: number };
  images: number;
  latencyMs: { p50: number | null; p95: number | null; max: number | null };
  sentLast7d: number;
  sentLast30d: number;
  workouts: {
    count: number;
    completed: number;
    /** Fraction ended via Finish rather than abandoned. 0 when none recorded. */
    completionRate: number;
    medianDurationMs: number | null;
    totalSets: number;
    totalRepsCounted: number;
    totalRepsAttempted: number;
    /** Counted / attempted across all workouts — the real-world depth-gate pass rate. */
    repCountRate: number;
  };
}

const EMPTY_TIER_STATS = (): TierStats => ({ sent: 0, errors: 0, skipped: 0 });

/** Nearest-rank percentile over a numeric array. null when empty. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarize(ledger: UsageLedger, nowMs: number): UsageSummary {
  const byTier: Record<CallTier, TierStats> = {
    mid_set: EMPTY_TIER_STATS(),
    post_set: EMPTY_TIER_STATS(),
    post_workout: EMPTY_TIER_STATS(),
    deep_analysis: EMPTY_TIER_STATS(),
  };

  let totalSent = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let prompt = 0;
  let output = 0;
  let thinking = 0;
  let images = 0;
  let sentLast7d = 0;
  let sentLast30d = 0;
  const latencies: number[] = [];

  for (const c of ledger.calls) {
    // A tier from a future schema shouldn't crash the summary.
    const stats = byTier[c.tier] ?? (byTier[c.tier] = EMPTY_TIER_STATS());
    if (wasSent(c.outcome)) {
      totalSent++;
      stats.sent++;
      // Tokens/images are only meaningful for calls that were actually sent.
      prompt += c.promptTokens ?? 0;
      output += c.outputTokens ?? 0;
      thinking += c.thinkingTokens ?? 0;
      images += c.imageCount;
      if (c.latencyMs !== null) latencies.push(c.latencyMs);
      if (c.tsMs > nowMs - 7 * 86_400_000) sentLast7d++;
      if (c.tsMs > nowMs - 30 * 86_400_000) sentLast30d++;
      if (c.outcome === "error") {
        totalErrors++;
        stats.errors++;
      }
    } else {
      totalSkipped++;
      stats.skipped++;
    }
  }

  const durations = ledger.workouts.map((w) => w.durationMs).filter((d) => d > 0);
  const completed = ledger.workouts.filter((w) => w.completed).length;
  const totalSets = ledger.workouts.reduce((n, w) => n + w.sets, 0);
  const totalRepsCounted = ledger.workouts.reduce((n, w) => n + w.repsCounted, 0);
  const totalRepsAttempted = ledger.workouts.reduce((n, w) => n + w.repsAttempted, 0);

  return {
    installId: ledger.installId,
    firstSeenMs: ledger.firstSeenMs,
    totalSent,
    totalSkipped,
    totalErrors,
    errorRate: totalSent ? totalErrors / totalSent : 0,
    byTier,
    tokens: { prompt, output, thinking, total: prompt + output + thinking },
    images,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: latencies.length ? Math.max(...latencies) : null },
    sentLast7d,
    sentLast30d,
    workouts: {
      count: ledger.workouts.length,
      completed,
      completionRate: ledger.workouts.length ? completed / ledger.workouts.length : 0,
      medianDurationMs: percentile(durations, 50),
      totalSets,
      totalRepsCounted,
      totalRepsAttempted,
      repCountRate: totalRepsAttempted ? totalRepsCounted / totalRepsAttempted : 0,
    },
  };
}
