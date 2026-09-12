/**
 * React binding for the usage ledger.
 * ----------------------------------------------------------------------------
 * Subscribes to the store and re-derives the summary whenever a call or workout
 * is recorded. The store is a module singleton (usage is global to the browser
 * profile, not to a component tree), so this hook holds no data of its own — it
 * only mirrors the store into React state.
 */
import { useCallback, useEffect, useState } from "react";
import {
  clearUsage,
  downloadUsageJson,
  getQuotaPolicy,
  getUsageSummary,
  quota,
  setQuotaPolicy,
  subscribeUsage,
} from "../usage/usageStore";
import type { QuotaPolicy, QuotaVerdict, UsageSummary } from "../usage/ledger";

export interface UsageView {
  summary: UsageSummary;
  policy: QuotaPolicy;
  /** Live verdict for the post-set tier — the one users hit first and most often. */
  verdict: QuotaVerdict;
  setPolicy: (p: QuotaPolicy) => void;
  clear: () => void;
  download: () => void;
}

export function useUsage(): UsageView {
  const read = () => ({ summary: getUsageSummary(), policy: getQuotaPolicy(), verdict: quota("post_set") });
  const [state, setState] = useState(read);

  useEffect(() => {
    // Re-read once on mount: a call can land between the initial useState and the
    // subscription being wired up.
    setState(read());
    return subscribeUsage(() => setState(read()));
  }, []);

  const setPolicy = useCallback((p: QuotaPolicy) => setQuotaPolicy(p), []);
  const clear = useCallback(() => clearUsage(), []);
  const download = useCallback(() => downloadUsageJson(), []);

  return { ...state, setPolicy, clear, download };
}
