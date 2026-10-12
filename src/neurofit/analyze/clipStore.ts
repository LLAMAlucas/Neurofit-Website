/**
 * Saved annotations, one record per clip, in localStorage. The VIDEO is never stored — only what
 * the user added to it (drawings, bookmarks, calibration, in/out marks) and the AI answers, so
 * reopening the same file brings them back and never pays twice for the same answer.
 * ----------------------------------------------------------------------------
 * Storage is injected (`KV`) so the Node check can run it on a Map. Same failure policy as
 * usage/usageStore.ts: bookkeeping must never break the page — every read/write is wrapped, a
 * corrupt entry starts clean, and a full store drops the oldest clips and retries.
 */
import { ANALYZE } from "./config";
import { validDrawing, type Drawing } from "./annotations";
import { validFormResult, type FormResult } from "./aiResult";
import type { Calibration } from "./geometry";

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Bookmark {
  tMs: number;
  label: string;
}

export interface StoredClipAi {
  result: FormResult;
  /** Clip time of each image sent, in order (issue.frame - 1 indexes this). */
  frameTimesMs: number[];
  createdAtMs: number;
  exerciseHint: string;
}

export interface StoredFrameAi {
  tMs: number;
  question: string;
  result: FormResult;
  frameTimesMs: number[];
  createdAtMs: number;
}

/** A followed point ("track a point"): video-pixel positions over time, ended where it was lost. */
export interface PointTrackRecord {
  id: string;
  color: string;
  label: string;
  points: { tMs: number; x: number; y: number }[];
}

export interface ClipRecord {
  key: string;
  name: string;
  savedAtMs: number;
  drawings: Drawing[];
  bookmarks: Bookmark[];
  calibration: (Calibration & { refId: string | null }) | null;
  inMs: number | null;
  outMs: number | null;
  exerciseHint: string;
  clipAi: StoredClipAi | null;
  frameAi: StoredFrameAi[];
  tracks: PointTrackRecord[];
}

/** Same file = same name, size, modified time and duration. A re-export of the same clip is a
 *  new file on purpose: its frames may differ. */
export function clipKey(meta: { name: string; size: number; lastModified: number; durationMs: number }): string {
  return `${meta.name}|${meta.size}|${meta.lastModified}|${Math.round(meta.durationMs)}`;
}

export function emptyRecord(key: string, name: string): ClipRecord {
  return { key, name, savedAtMs: 0, drawings: [], bookmarks: [], calibration: null, inMs: null, outMs: null, exerciseHint: "", clipAi: null, frameAi: [], tracks: [] };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numList = (v: unknown) => (Array.isArray(v) ? v.filter(isNum) : []);

export function validRecord(v: unknown): ClipRecord | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.key !== "string" || typeof r.name !== "string") return null;
  const rec = emptyRecord(r.key, r.name);
  rec.savedAtMs = isNum(r.savedAtMs) ? r.savedAtMs : 0;
  rec.drawings = Array.isArray(r.drawings) ? r.drawings.map(validDrawing).filter((d): d is Drawing => d !== null) : [];
  rec.bookmarks = Array.isArray(r.bookmarks)
    ? r.bookmarks.filter((b): b is Bookmark => !!b && isNum((b as Bookmark).tMs) && typeof (b as Bookmark).label === "string")
    : [];
  const c = r.calibration as Record<string, unknown> | null;
  if (c && isNum(c.pxPerUnit) && c.pxPerUnit > 0 && (c.unit === "cm" || c.unit === "in" || c.unit === "m")) {
    rec.calibration = { pxPerUnit: c.pxPerUnit, unit: c.unit, refId: typeof c.refId === "string" ? c.refId : null };
  }
  rec.inMs = isNum(r.inMs) ? r.inMs : null;
  rec.outMs = isNum(r.outMs) ? r.outMs : null;
  rec.exerciseHint = typeof r.exerciseHint === "string" ? r.exerciseHint.slice(0, ANALYZE.ai.maxExerciseChars) : "";
  const ca = r.clipAi as Record<string, unknown> | null;
  const caResult = ca ? validFormResult(ca.result) : null;
  if (ca && caResult) {
    rec.clipAi = {
      result: caResult,
      frameTimesMs: numList(ca.frameTimesMs),
      createdAtMs: isNum(ca.createdAtMs) ? ca.createdAtMs : 0,
      exerciseHint: typeof ca.exerciseHint === "string" ? ca.exerciseHint : "",
    };
  }
  if (Array.isArray(r.frameAi)) {
    for (const f of r.frameAi) {
      const o = f as Record<string, unknown>;
      const res = o ? validFormResult(o.result) : null;
      if (!res || !isNum(o.tMs)) continue;
      rec.frameAi.push({
        tMs: o.tMs,
        question: typeof o.question === "string" ? o.question : "",
        result: res,
        frameTimesMs: numList(o.frameTimesMs),
        createdAtMs: isNum(o.createdAtMs) ? o.createdAtMs : 0,
      });
    }
  }
  if (Array.isArray(r.tracks)) {
    for (const t of r.tracks) {
      const o = t as Record<string, unknown>;
      if (!o || typeof o.id !== "string" || !Array.isArray(o.points)) continue;
      const points = o.points.filter((p): p is { tMs: number; x: number; y: number } => !!p && isNum(p.tMs) && isNum(p.x) && isNum(p.y));
      if (points.length < 2) continue;
      rec.tracks.push({ id: o.id, color: typeof o.color === "string" ? o.color : "#ffd23f", label: typeof o.label === "string" ? o.label : "Point", points });
    }
  }
  return rec;
}

export class ClipStore {
  constructor(
    private readonly kv: KV | null,
    private readonly cfg: { key: string; maxClips: number } = ANALYZE.store,
  ) {}

  private readAll(): ClipRecord[] {
    try {
      const raw = this.kv?.getItem(this.cfg.key);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as { version?: number; clips?: unknown[] };
      if (parsed?.version !== 1 || !Array.isArray(parsed.clips)) return [];
      return parsed.clips.map(validRecord).filter((c): c is ClipRecord => c !== null);
    } catch {
      return [];
    }
  }

  private writeAll(clips: ClipRecord[]): boolean {
    if (!this.kv) return false;
    let list = clips;
    // Full store: drop the oldest half and try again, down to just the clip being saved.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        this.kv.setItem(this.cfg.key, JSON.stringify({ version: 1, clips: list }));
        return true;
      } catch {
        if (list.length <= 1) return false;
        list = list.slice(0, Math.max(1, Math.ceil(list.length / 2)));
      }
    }
    return false;
  }

  load(key: string): ClipRecord | null {
    return this.readAll().find((c) => c.key === key) ?? null;
  }

  /** Save (most recent first), keeping at most cfg.maxClips clips. */
  save(rec: ClipRecord, nowMs: number): boolean {
    const others = this.readAll().filter((c) => c.key !== rec.key);
    const next = [{ ...rec, savedAtMs: nowMs }, ...others].slice(0, this.cfg.maxClips);
    return this.writeAll(next);
  }

  list(): { key: string; name: string; savedAtMs: number }[] {
    return this.readAll().map((c) => ({ key: c.key, name: c.name, savedAtMs: c.savedAtMs }));
  }

  remove(key: string): void {
    this.writeAll(this.readAll().filter((c) => c.key !== key));
  }
}
