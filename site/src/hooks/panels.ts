/**
 * Which sheet is open — the FAQ or the privacy note. Opened from the menu (Hud) and from the
 * footer (Foot), drawn once by the Hud.
 */
import { useSyncExternalStore } from "react";

export type SheetId = "faq" | "privacy";

let open: SheetId | null = null;
const listeners = new Set<() => void>();

export function openSheet(id: SheetId | null): void {
  if (open === id) return;
  open = id;
  listeners.forEach((f) => f());
}

export function useSheet(): SheetId | null {
  return useSyncExternalStore(
    (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    () => open,
    () => null,
  );
}
