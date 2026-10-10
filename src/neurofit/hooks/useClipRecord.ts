/**
 * One clip's saved state (analyze/clipStore.ts) with undo/redo, autosaved to localStorage.
 * ----------------------------------------------------------------------------
 * Undo covers what the user EDITS — drawings, bookmarks, calibration, in/out marks and point
 * tracks. AI answers and the exercise name sit outside it: undoing a misplaced line must never
 * throw away an answer that was paid for.
 *
 * Edits compute from a ref rather than inside a setState updater: StrictMode runs updaters twice
 * in development, which would push every undo step twice.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History } from "../analyze/annotations";
import { ClipStore, emptyRecord, type ClipRecord } from "../analyze/clipStore";

type Editable = Pick<ClipRecord, "drawings" | "bookmarks" | "calibration" | "inMs" | "outMs" | "tracks">;
const editable = (r: ClipRecord): Editable => ({
  drawings: r.drawings,
  bookmarks: r.bookmarks,
  calibration: r.calibration,
  inMs: r.inMs,
  outMs: r.outMs,
  tracks: r.tracks,
});

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}
const store = new ClipStore(storage());

export interface ClipRecordView {
  record: ClipRecord;
  /** Was this clip's record found in storage when it was opened? */
  restored: boolean;
  /** Change editable fields as one undo step — or, with `live`, without one (while dragging;
   *  `endLive` then turns the whole drag into one step). */
  edit: (fn: (r: ClipRecord) => ClipRecord, opts?: { live?: boolean }) => void;
  beginLive: () => void;
  endLive: () => void;
  /** Change fields outside undo (AI answers, exercise name). */
  set: (fn: (r: ClipRecord) => ClipRecord) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

export function useClipRecord(key: string | null, name: string): ClipRecordView {
  const [record, setRecord] = useState<ClipRecord>(() => emptyRecord("", ""));
  const recRef = useRef(record);
  const [restored, setRestored] = useState(false);
  const history = useRef(new History<Editable>(editable(record)));
  const liveStart = useRef<Editable | null>(null);
  const dirty = useRef(false);
  const [tick, setTick] = useState(0);

  const commit = useCallback((next: ClipRecord, markDirty = true) => {
    if (markDirty) dirty.current = true;
    recRef.current = next;
    setRecord(next);
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    const rec = key ? (store.load(key) ?? emptyRecord(key, name)) : emptyRecord("", "");
    setRestored(!!key && rec.savedAtMs > 0);
    history.current.reset(editable(rec));
    liveStart.current = null;
    dirty.current = false;
    commit(rec, false);
  }, [key, name, commit]);

  // Autosave, debounced — only once something was actually changed.
  useEffect(() => {
    if (!record.key || !dirty.current) return;
    const id = setTimeout(() => store.save(record, Date.now()), 400);
    return () => clearTimeout(id);
  }, [record]);

  const edit = useCallback(
    (fn: (r: ClipRecord) => ClipRecord, opts?: { live?: boolean }) => {
      const next = fn(recRef.current);
      if (next === recRef.current) return;
      if (opts?.live) history.current.replace(editable(next));
      else history.current.push(editable(next));
      commit(next);
    },
    [commit],
  );

  const beginLive = useCallback(() => {
    liveStart.current = history.current.value;
  }, []);

  const endLive = useCallback(() => {
    const start = liveStart.current;
    liveStart.current = null;
    if (!start) return;
    const cur = history.current.value;
    if (cur === start) return;
    history.current.replace(start);
    history.current.push(cur);
    setTick((t) => t + 1);
  }, []);

  const set = useCallback((fn: (r: ClipRecord) => ClipRecord) => commit(fn(recRef.current)), [commit]);

  const apply = useCallback((e: Editable) => commit({ ...recRef.current, ...e }), [commit]);
  const undo = useCallback(() => apply(history.current.undo()), [apply]);
  const redo = useCallback(() => apply(history.current.redo()), [apply]);

  return useMemo(
    () => ({
      record,
      restored,
      edit,
      beginLive,
      endLive,
      set,
      undo,
      redo,
      canUndo: history.current.canUndo,
      canRedo: history.current.canRedo,
    }),
    // `tick` re-reads canUndo/canRedo, which live on the History object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [record, restored, edit, beginLive, endLive, set, undo, redo, tick],
  );
}

/** Clips with saved notes on this device (newest first) — names only; the videos aren't stored. */
export function savedClips(): { key: string; name: string; savedAtMs: number }[] {
  return store.list();
}
