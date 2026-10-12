/**
 * Drawings on a clip: types, what each one measures, hit-testing, undo, and (de)serialization.
 * PURE module — the SVG layer draws what this computes.
 * ----------------------------------------------------------------------------
 * Every point is an ANCHOR: either a free point in video pixels, or a pose joint. A joint anchor
 * follows the body from frame to frame — that is what turns a drawn angle into a goniometer that
 * reads the knee on every frame. When the joint isn't seen on a frame the anchor falls back to
 * where it was drawn, and the measurement says so (`tracked: false`).
 */
import type { Landmark } from "../pose/landmarks";
import { ANALYZE } from "./config";
import {
  angleAt,
  dist,
  distToSegment,
  formatLength,
  leanFromVerticalDeg,
  tiltFromHorizontalDeg,
  type Calibration,
  type FrameSize,
  type Pt,
} from "./geometry";
import { seenPx } from "./jointAngles";

export type DrawingType = "angle" | "line" | "ruler" | "plumb" | "circle" | "arrow" | "pen" | "text";

/** How many points each tool takes. Pen is open-ended. */
export const POINTS_FOR: Record<DrawingType, number> = {
  angle: 3,
  line: 2,
  ruler: 2,
  plumb: 1,
  circle: 2,
  arrow: 2,
  pen: Infinity,
  text: 1,
};

export type Anchor = { kind: "free"; p: Pt } | { kind: "joint"; index: number; p: Pt };

export interface Drawing {
  id: string;
  type: DrawingType;
  pts: Anchor[];
  color: string;
  /** "frame" = belongs to the frame it was drawn on (fades out either side); "clip" = always shown. */
  scope: "frame" | "clip";
  /** Clip time it was drawn at (ms). */
  tMs: number;
  /** Text tool content, or an optional name for a measurement. */
  text?: string;
  /** Plumb line direction. */
  orientation?: "vertical" | "horizontal";
}

export const COLORS = ["#ffd23f", "#3fd0ff", "#ff5c8a", "#7dff6a", "#ffffff", "#ff8a3d"] as const;

let seq = 0;
export function newDrawingId(): string {
  seq += 1;
  return `d${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Where an anchor sits on a frame. `landmarks` is that frame's pose (or null). */
export function resolveAnchor(a: Anchor, landmarks: readonly Landmark[] | null, size: FrameSize): { p: Pt; tracked: boolean } {
  if (a.kind === "joint" && landmarks) {
    const p = seenPx(landmarks, a.index, size, 0.5);
    if (p) return { p, tracked: true };
  }
  return { p: a.p, tracked: a.kind === "free" };
}

export function resolvePoints(d: Drawing, landmarks: readonly Landmark[] | null, size: FrameSize): { pts: Pt[]; tracked: boolean } {
  let tracked = true;
  const pts = d.pts.map((a) => {
    const r = resolveAnchor(a, landmarks, size);
    if (!r.tracked) tracked = false;
    return r.p;
  });
  return { pts, tracked };
}

/** 0–1 opacity of a drawing at clip time `tMs`. */
export function drawingOpacity(d: Drawing, tMs: number, fadeMs: number = ANALYZE.annotation.frameFadeMs): number {
  if (d.scope === "clip") return 1;
  const off = Math.abs(tMs - d.tMs);
  if (off <= 1) return 1;
  if (off >= fadeMs) return 0;
  return 1 - off / fadeMs;
}

export interface Measurement {
  kind: "angle" | "tilt" | "lean" | "length" | "none";
  /** Degrees, or pixels for a length. */
  value: number | null;
  /** What the label on screen says. */
  text: string;
}

export function measure(d: Drawing, pts: readonly Pt[], cal: Calibration | null): Measurement {
  switch (d.type) {
    case "angle": {
      if (pts.length < 3) return { kind: "none", value: null, text: "" };
      const v = angleAt(pts[0], pts[1], pts[2]);
      return { kind: "angle", value: v, text: `${Math.round(v)}°` };
    }
    case "line": {
      if (pts.length < 2) return { kind: "none", value: null, text: "" };
      // Read it against whichever reference it is nearer: a bar path against vertical, a hip line
      // against level.
      const tilt = tiltFromHorizontalDeg(pts[0], pts[1]);
      if (tilt <= 45) return { kind: "tilt", value: tilt, text: `${Math.round(tilt)}° off level` };
      const lean = leanFromVerticalDeg(pts[0], pts[1]);
      return { kind: "lean", value: lean, text: `${Math.round(lean)}° off vertical` };
    }
    case "ruler": {
      if (pts.length < 2) return { kind: "none", value: null, text: "" };
      const px = dist(pts[0], pts[1]);
      return { kind: "length", value: px, text: formatLength(px, cal) };
    }
    default:
      return { kind: "none", value: null, text: d.type === "text" ? (d.text ?? "") : "" };
  }
}

export interface Hit {
  id: string;
  /** Index into pts for a handle, or -1 for the drawing's body (move it whole). */
  handle: number;
}

/**
 * Topmost drawing under `p` (video px). Handles beat bodies. `resolved` maps drawing id → its
 * points on the current frame; drawings absent from it (faded out) can't be hit.
 */
export function hitTest(drawings: readonly Drawing[], resolved: ReadonlyMap<string, readonly Pt[]>, p: Pt, tolPx: number): Hit | null {
  for (let k = drawings.length - 1; k >= 0; k--) {
    const d = drawings[k];
    const pts = resolved.get(d.id);
    if (!pts) continue;
    if (d.type !== "pen") {
      for (let i = 0; i < pts.length; i++) if (dist(p, pts[i]) <= tolPx) return { id: d.id, handle: i };
    }
  }
  for (let k = drawings.length - 1; k >= 0; k--) {
    const d = drawings[k];
    const pts = resolved.get(d.id);
    if (!pts || pts.length === 0) continue;
    if (bodyHit(d, pts, p, tolPx)) return { id: d.id, handle: -1 };
  }
  return null;
}

function bodyHit(d: Drawing, pts: readonly Pt[], p: Pt, tol: number): boolean {
  switch (d.type) {
    case "circle":
      return pts.length >= 2 && Math.abs(dist(p, pts[0]) - dist(pts[0], pts[1])) <= tol;
    case "plumb":
      return d.orientation === "horizontal" ? Math.abs(p[1] - pts[0][1]) <= tol : Math.abs(p[0] - pts[0][0]) <= tol;
    case "text":
      return dist(p, pts[0]) <= tol * 3;
    default:
      for (let i = 1; i < pts.length; i++) if (distToSegment(p, pts[i - 1], pts[i]) <= tol) return true;
      return false;
  }
}

/** Move every FREE anchor by (dx, dy). Joint anchors stay on their joint. */
export function translate(d: Drawing, dx: number, dy: number): Drawing {
  return {
    ...d,
    pts: d.pts.map((a) => (a.kind === "free" ? { kind: "free", p: [a.p[0] + dx, a.p[1] + dy] as Pt } : a)),
  };
}

// --- undo ------------------------------------------------------------------------------

/** Linear undo/redo over immutable snapshots. */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  constructor(private current: T, private readonly cap = 100) {}

  get value(): T {
    return this.current;
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  push(next: T): T {
    this.past.push(this.current);
    if (this.past.length > this.cap) this.past.shift();
    this.future = [];
    this.current = next;
    return next;
  }
  /** Replace the current value without an undo step (e.g. live dragging). */
  replace(next: T): T {
    this.current = next;
    return next;
  }
  undo(): T {
    const prev = this.past.pop();
    if (prev !== undefined) {
      this.future.push(this.current);
      this.current = prev;
    }
    return this.current;
  }
  redo(): T {
    const next = this.future.pop();
    if (next !== undefined) {
      this.past.push(this.current);
      this.current = next;
    }
    return this.current;
  }
  reset(value: T): void {
    this.past = [];
    this.future = [];
    this.current = value;
  }
}

// --- validation (for anything read back from storage) ---------------------------------

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPt = (v: unknown): v is Pt => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);

function validAnchor(v: unknown): Anchor | null {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  if (!isPt(a.p)) return null;
  if (a.kind === "free") return { kind: "free", p: [a.p[0], a.p[1]] };
  if (a.kind === "joint" && isNum(a.index) && a.index >= 0 && a.index < 33) return { kind: "joint", index: a.index, p: [a.p[0], a.p[1]] };
  return null;
}

/** A stored drawing, or null if it doesn't hold together. Never throws. */
export function validDrawing(v: unknown): Drawing | null {
  if (!v || typeof v !== "object") return null;
  const d = v as Record<string, unknown>;
  if (typeof d.id !== "string" || typeof d.type !== "string" || !(d.type in POINTS_FOR)) return null;
  const type = d.type as DrawingType;
  if (!Array.isArray(d.pts)) return null;
  const pts = d.pts.map(validAnchor);
  if (pts.some((p) => p === null)) return null;
  const need = POINTS_FOR[type];
  if (type === "pen" ? pts.length < 2 : pts.length !== need) return null;
  if (typeof d.color !== "string" || !isNum(d.tMs)) return null;
  const out: Drawing = {
    id: d.id,
    type,
    pts: pts as Anchor[],
    color: d.color,
    scope: d.scope === "clip" ? "clip" : "frame",
    tMs: d.tMs,
  };
  if (typeof d.text === "string") out.text = d.text.slice(0, 200);
  if (type === "plumb") out.orientation = d.orientation === "horizontal" ? "horizontal" : "vertical";
  return out;
}
