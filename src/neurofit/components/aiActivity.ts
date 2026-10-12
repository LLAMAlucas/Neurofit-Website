/**
 * Who is waiting on Gemini right now, kept outside React's tree — Analyze's AI panel lives in a
 * lazy chunk the App can't see into — so the top bar's five pixels can run as a loader while any
 * AI read is being written. The live coach's own calls are read straight from the workout state.
 */
import { useSyncExternalStore } from "react";

const busy = new Set<string>();
const listeners = new Set<() => void>();

export function setAiBusy(id: string, on: boolean): void {
  if (busy.has(id) === on) return;
  if (on) busy.add(id);
  else busy.delete(id);
  listeners.forEach((f) => f());
}

function subscribe(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function useAiBusy(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => busy.size > 0,
    () => false,
  );
}
