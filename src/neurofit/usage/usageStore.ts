/**
 * Usage store — the browser half of the usage ledger.
 * ----------------------------------------------------------------------------
 * Owns persistence (localStorage), the current session id, the quota policy, and
 * a tiny subscription so the UI can re-render when usage changes. All arithmetic
 * lives in the PURE `ledger.ts`; this file only does I/O and clock reads.
 *
 * Failure policy: usage tracking is BOOKKEEPING, not a feature the workout depends
 * on. Every storage path is wrapped — private-browsing, disabled storage, a full
 * quota or a corrupt entry must degrade to in-memory counting, never break a set
 * or block a coaching call. The one exception is the quota gate itself, which
 * fails OPEN (see `quota()`): if we cannot read usage we allow the call rather
 * than locking a paying user out over a storage error.
 */
import {
  DEFAULT_LIMITS,
  DEFAULT_QUOTA_POLICY,
  USAGE_SCHEMA_VERSION,
  appendCall,
  emptyLedger,
  evaluateQuota,
  pruneLedger,
  summarize,
  upsertWorkout,
  type CallTier,
  type QuotaPolicy,
  type QuotaVerdict,
  type UsageCall,
  type UsageLedger,
  type UsageSummary,
  type UsageWorkout,
} from "./ledger";

const LEDGER_KEY = "neurofit.usage.v1";
const POLICY_KEY = "neurofit.usage.policy.v1";

/** Random id for this browser profile. Prefers crypto.randomUUID (secure contexts
 *  only — which the app already requires for getUserMedia) with a plain fallback. */
function newId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `nf-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function isLedger(v: unknown): v is UsageLedger {
  if (!v || typeof v !== "object") return false;
  const l = v as Partial<UsageLedger>;
  return (
    l.version === USAGE_SCHEMA_VERSION &&
    typeof l.installId === "string" &&
    typeof l.firstSeenMs === "number" &&
    Array.isArray(l.calls) &&
    Array.isArray(l.workouts)
  );
}

function load(): UsageLedger {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      // A version bump or a hand-edited/corrupt entry starts clean rather than
      // throwing on every subsequent read.
      if (isLedger(parsed)) return parsed;
    }
  } catch {
    /* unreadable / unparseable — start clean */
  }
  return emptyLedger(newId(), Date.now());
}

/** In-memory source of truth; localStorage is the mirror. */
let ledger: UsageLedger = load();
let policy: QuotaPolicy = loadPolicy();

function save(): void {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    // Most likely QuotaExceededError. Halve the history and retry once — losing
    // the oldest records is strictly better than stopping tracking entirely.
    try {
      ledger = {
        ...ledger,
        calls: ledger.calls.slice(Math.floor(ledger.calls.length / 2)),
        workouts: ledger.workouts.slice(Math.floor(ledger.workouts.length / 2)),
      };
      localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
    } catch {
      /* storage unavailable — continue in memory only */
    }
  }
}

function loadPolicy(): QuotaPolicy {
  try {
    const raw = localStorage.getItem(POLICY_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<QuotaPolicy>;
      if (typeof p.enabled === "boolean" && typeof p.windowMs === "number" && typeof p.maxCalls === "number") {
        // Clamp rather than trust: a zero/negative window would make every call
        // out-of-window (silently unlimited), and a negative cap would hard-lock.
        return {
          enabled: p.enabled,
          windowMs: Math.max(60_000, p.windowMs),
          maxCalls: Math.max(0, Math.floor(p.maxCalls)),
          tiers: Array.isArray(p.tiers) ? (p.tiers as CallTier[]) : undefined,
        };
      }
    }
  } catch {
    /* fall through to the default */
  }
  return { ...DEFAULT_QUOTA_POLICY };
}

// --- subscriptions ---------------------------------------------------------
type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe to usage changes. Returns an unsubscribe fn. */
export function subscribeUsage(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* a broken listener must not break accounting */
    }
  }
}

// --- session ---------------------------------------------------------------
let sessionId = newId();
let sessionStartedMs = Date.now();

/** Begin a new workout session (called on mount and on Reset / New workout). */
export function startUsageSession(): string {
  sessionId = newId();
  sessionStartedMs = Date.now();
  return sessionId;
}

export function currentSessionId(): string {
  return sessionId;
}

// --- recording -------------------------------------------------------------

/** What the caller knows about a Gemini call attempt (see gemini.ts `emitObs`). */
export interface CallRecordInput {
  tier: CallTier;
  outcome: UsageCall["outcome"];
  model: string;
  timestampMs: number;
  latencyMs?: number | null;
  imageCount: number;
  promptTokens?: number | null;
  outputTokens?: number | null;
  thinkingTokens?: number | null;
}

/** Record one Gemini call attempt. Never throws. */
export function recordCall(input: CallRecordInput): void {
  try {
    ledger = appendCall(
      ledger,
      {
        tsMs: input.timestampMs,
        tier: input.tier,
        outcome: input.outcome,
        model: input.model,
        sessionId,
        latencyMs: input.latencyMs ?? null,
        imageCount: input.imageCount,
        promptTokens: input.promptTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        thinkingTokens: input.thinkingTokens ?? null,
      },
      DEFAULT_LIMITS,
    );
    save();
    emit();
  } catch {
    /* accounting must never break a coaching call */
  }
}

export interface WorkoutRecordInput {
  sets: number;
  repsCounted: number;
  repsAttempted: number;
  completed: boolean;
  mode: string;
  depthPreset: string;
  /** Omitted for squats so their rows are unchanged; see UsageWorkout.exercise. */
  exercise?: "squat" | "pushup" | "pullup";
}

/**
 * Insert-or-update this session's workout row. Never throws.
 *
 * Called twice per session by design: once when the first set ends
 * (`completed: false`) and again on Finish (`completed: true`). The row is keyed
 * on sessionId and REPLACED, so closing the tab mid-session leaves an honest
 * incomplete record instead of no record at all.
 */
export function recordWorkout(input: WorkoutRecordInput): void {
  try {
    const endedMs = Date.now();
    const w: UsageWorkout = {
      sessionId,
      startedMs: sessionStartedMs,
      endedMs,
      durationMs: Math.max(0, endedMs - sessionStartedMs),
      sets: input.sets,
      repsCounted: input.repsCounted,
      repsAttempted: input.repsAttempted,
      completed: input.completed,
      mode: input.mode,
      depthPreset: input.depthPreset,
      ...(input.exercise ? { exercise: input.exercise } : {}),
    };
    ledger = upsertWorkout(ledger, w, DEFAULT_LIMITS);
    save();
    emit();
  } catch {
    /* ditto */
  }
}

// --- reads -----------------------------------------------------------------

export function getLedger(): UsageLedger {
  return ledger;
}

export function getUsageSummary(): UsageSummary {
  return summarize(ledger, Date.now());
}

export function getQuotaPolicy(): QuotaPolicy {
  return policy;
}

export function setQuotaPolicy(next: QuotaPolicy): void {
  policy = { ...next, windowMs: Math.max(60_000, next.windowMs), maxCalls: Math.max(0, Math.floor(next.maxCalls)) };
  try {
    localStorage.setItem(POLICY_KEY, JSON.stringify(policy));
  } catch {
    /* in-memory only */
  }
  emit();
}

/**
 * Current quota verdict. FAILS OPEN: any unexpected error yields `allowed: true`.
 * Blocking a user's coaching because our own bookkeeping threw would be a worse
 * outcome than one uncounted call.
 */
export function quota(tier: CallTier): QuotaVerdict {
  try {
    const tiers = policy.tiers;
    // A policy scoped to other tiers doesn't apply here — report it as disabled
    // so callers and the UI see an honest "not gated" rather than a fake headroom.
    if (tiers && tiers.length > 0 && !tiers.includes(tier)) {
      return { allowed: true, enabled: false, used: 0, limit: policy.maxCalls, remaining: policy.maxCalls, windowStartMs: Date.now() - policy.windowMs, resetsAtMs: null };
    }
    return evaluateQuota(ledger, policy, Date.now());
  } catch {
    return { allowed: true, enabled: false, used: 0, limit: 0, remaining: 0, windowStartMs: Date.now(), resetsAtMs: null };
  }
}

/** Wipe all usage history (keeps the install id so the profile stays joinable). */
export function clearUsage(): void {
  ledger = emptyLedger(ledger.installId, Date.now());
  save();
  emit();
}

/** Full ledger + summary as pretty JSON — the export that turns this into a dataset. */
export function exportUsageJson(): string {
  const now = Date.now();
  return JSON.stringify(
    { exportedAtMs: now, exportedAt: new Date(now).toISOString(), policy, summary: summarize(ledger, now), ledger: pruneLedger(ledger, now, DEFAULT_LIMITS) },
    null,
    2,
  );
}

/** Trigger a browser download of the usage export. */
export function downloadUsageJson(): void {
  try {
    const blob = new Blob([exportUsageJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `neurofit-usage-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    // Revoke on the next tick — revoking synchronously can cancel the download
    // in some browsers before it has read the blob.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* download unavailable — the panel still shows the numbers */
  }
}
