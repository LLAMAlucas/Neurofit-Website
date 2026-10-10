/**
 * One clip on screen: the <video>, the SVG overlay, and every pointer interaction — drawing,
 * snapping to joints, dragging handles, zoom (wheel / pinch / buttons) and pan, plus a magnifier
 * loupe while a point is being placed (Kinovea's trick for sub-pixel placement).
 * ----------------------------------------------------------------------------
 * Coordinates: the pointer is mapped into VIDEO pixels from the overlay's on-screen box, which
 * already includes zoom and pan; mirroring flips x. Everything stored is in video pixels.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ANALYZE } from "../../analyze/config";
import { ANALYZE_JOINTS, seenPx } from "../../analyze/jointAngles";
import { dist, type Pt } from "../../analyze/geometry";
import {
  POINTS_FOR,
  drawingOpacity,
  hitTest,
  measure,
  newDrawingId,
  resolvePoints,
  translate,
  type Anchor,
  type Drawing,
  type DrawingType,
} from "../../analyze/annotations";
import { withSpeed, type TrailPoint } from "../../analyze/poseTrack";
import type { AngleId } from "../../analyze/jointAngles";
import type { ClipSession } from "../../hooks/useClipSession";
import { Overlay, type DrawnItem, type TrailLine } from "./Overlay";

export type ToolId = "move" | DrawingType | "track";

export interface ToolState {
  tool: ToolId;
  color: string;
  scope: "frame" | "clip";
  snap: boolean;
}

export interface ViewOptions {
  mirrored: boolean;
  brightness: number;
  contrast: number;
  showSkeleton: boolean;
  showAngles: boolean;
  angleIds: AngleId[];
  trailJoints: number[];
  /** Trail length behind the playhead (ms); null = the whole in/out range. */
  trailSpanMs: number | null;
  showTracks: boolean;
}

export function filterCss(v: ViewOptions): string | undefined {
  return v.brightness === 1 && v.contrast === 1 ? undefined : `brightness(${v.brightness}) contrast(${v.contrast})`;
}

type Drag =
  | { kind: "handle"; id: string; handle: number }
  | { kind: "body"; id: string; last: Pt }
  | { kind: "pan"; x: number; y: number; px: number; py: number }
  | { kind: "draw"; d: Drawing; moved: boolean }
  | null;

export function ClipStage({
  session,
  view,
  tool,
  selectedId,
  onSelect,
  onToolDone,
  svgRef,
  opacity = 1,
  interactive = true,
  maxHeightVh = 70,
}: {
  session: ClipSession;
  view: ViewOptions;
  tool: ToolState;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** A one-shot tool finished (text placed, point tracked) — the page may switch back to Move. */
  onToolDone?: (created: Drawing | null) => void;
  svgRef?: React.RefObject<SVGSVGElement>;
  opacity?: number;
  interactive?: boolean;
  maxHeightVh?: number;
}) {
  const { player, rec, poseNow } = session;
  const meta = player.meta;
  const W = meta?.width ?? 16;
  const H = meta?.height ?? 9;
  const size = useMemo(() => ({ width: W, height: H }), [W, H]);
  const boxRef = useRef<HTMLDivElement>(null);
  const localSvg = useRef<SVGSVGElement>(null);
  const overlaySvg = svgRef ?? localSvg;
  const [boxW, setBoxW] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const drag = useRef<Drag>(null);
  const [draft, setDraft] = useState<{ d: Drawing } | null>(null);
  const [hover, setHover] = useState<Pt | null>(null);
  const [snapAt, setSnapAt] = useState<Pt | null>(null);
  const [loupe, setLoupe] = useState<{ cx: number; cy: number; p: Pt } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; zoom: number } | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth || 800));
    ro.observe(el);
    return () => ro.disconnect();
  }, [meta]);

  // New clip → fit.
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setDraft(null);
  }, [meta?.key]);

  // Switching tools drops a half-placed drawing.
  useEffect(() => setDraft(null), [tool.tool]);

  const unit = W / Math.max(1, boxW * zoom);
  const tMs = player.tMs;

  const clampPan = useCallback(
    (x: number, y: number, z: number) => {
      const bw = boxW;
      const bh = (boxW * H) / W;
      return { x: Math.min(0, Math.max(bw - bw * z, x)), y: Math.min(0, Math.max(bh - bh * z, y)) };
    },
    [boxW, H, W],
  );

  const zoomAt = useCallback(
    (nextZoom: number, clientX?: number, clientY?: number) => {
      const z = Math.max(1, Math.min(8, nextZoom));
      const box = boxRef.current?.getBoundingClientRect();
      const cx = box && clientX !== undefined ? clientX - box.left : boxW / 2;
      const cy = box && clientY !== undefined ? clientY - box.top : (boxW * H) / W / 2;
      setPan((p) => {
        const k = z / zoom;
        return clampPan(cx - (cx - p.x) * k, cy - (cy - p.y) * k, z);
      });
      setZoom(z);
    },
    [zoom, boxW, H, W, clampPan],
  );

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !interactive) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(zoom * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, zoomAt, interactive, meta]);

  /** Pointer → video pixels. */
  const toVideo = useCallback(
    (clientX: number, clientY: number): Pt => {
      const r = overlaySvg.current?.getBoundingClientRect();
      if (!r || r.width === 0) return [0, 0];
      let x = ((clientX - r.left) / r.width) * W;
      const y = ((clientY - r.top) / r.height) * H;
      if (view.mirrored) x = W - x;
      return [x, y];
    },
    [overlaySvg, W, H, view.mirrored],
  );

  const anchorAt = useCallback(
    (p: Pt, allowSnap: boolean): Anchor => {
      if (allowSnap && tool.snap && poseNow) {
        let best: { index: number; q: Pt } | null = null;
        let bestD = ANALYZE.annotation.snapPx * unit;
        for (const j of ANALYZE_JOINTS) {
          const q = seenPx(poseNow.landmarks, j.index, size, 0.5);
          if (!q) continue;
          const d = dist(p, q);
          if (d < bestD) {
            bestD = d;
            best = { index: j.index, q };
          }
        }
        if (best) return { kind: "joint", index: best.index, p: best.q };
      }
      return { kind: "free", p };
    },
    [tool.snap, poseNow, unit, size],
  );

  // What's drawn on this frame.
  const items: DrawnItem[] = useMemo(() => {
    const out: DrawnItem[] = [];
    for (const d of rec.record.drawings) {
      const opacity = drawingOpacity(d, tMs);
      if (opacity <= 0.02) continue;
      const { pts, tracked } = resolvePoints(d, poseNow?.landmarks ?? null, size);
      out.push({ d, pts, opacity, m: measure(d, pts, rec.record.calibration), tracked });
    }
    return out;
  }, [rec.record.drawings, rec.record.calibration, tMs, poseNow, size]);
  const resolved = useMemo(() => new Map(items.map((i) => [i.d.id, i.pts])), [items]);

  // Joint trails + tracked points.
  const trails: TrailLine[] = useMemo(() => {
    const track = session.pose.track;
    const from = view.trailSpanMs === null ? session.range.inMs : tMs - view.trailSpanMs;
    const to = view.trailSpanMs === null ? session.range.outMs : tMs;
    const out: TrailLine[] = [];
    if (track) {
      for (const j of view.trailJoints) {
        const runs = track.jointPath(j, from, to);
        const nowS = session.poseAt(tMs);
        const nowP = nowS ? seenPx(nowS.landmarks, j, size, 0.6) : null;
        out.push({ id: `j${j}`, color: "#ffd23f", runs, now: nowP });
      }
    }
    if (view.showTracks) {
      for (const t of rec.record.tracks) {
        const pts = t.points.filter((p) => p.tMs >= from - 1 && p.tMs <= to + 1);
        const run: TrailPoint[] = withSpeed(pts.map((p) => ({ tMs: p.tMs, p: [p.x, p.y] as Pt, speed: 0 })));
        const near = t.points.reduce<{ p: Pt; d: number } | null>((b, p) => {
          const d = Math.abs(p.tMs - tMs);
          return d < 60 && (!b || d < b.d) ? { p: [p.x, p.y], d } : b;
        }, null);
        out.push({ id: t.id, color: t.color, runs: run.length > 1 ? [run] : [], now: near?.p ?? null });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.pose.track, session.pose.version, view.trailJoints, view.trailSpanMs, view.showTracks, rec.record.tracks, tMs, session.range, size]);

  const draftView = useMemo(() => {
    if (!draft) return null;
    const pts = draft.d.pts.map((a) => a.p);
    // Rubber band to the pointer while clicking out an angle (or a two-click line).
    if (hover && pts.length < POINTS_FOR[draft.d.type] && draft.d.type !== "pen") pts.push(hover);
    return { d: draft.d, pts, m: measure(draft.d, pts, rec.record.calibration) };
  }, [draft, hover, rec.record.calibration]);

  const newDrawing = (type: DrawingType, first: Anchor): Drawing => ({
    id: newDrawingId(),
    type,
    pts: [first],
    color: tool.color,
    scope: type === "plumb" ? "clip" : tool.scope,
    tMs,
    ...(type === "plumb" ? { orientation: "vertical" as const } : {}),
    ...(type === "text" ? { text: "Note" } : {}),
  });

  const commit = (d: Drawing) => {
    rec.edit((r) => ({ ...r, drawings: [...r.drawings, d] }));
    setDraft(null);
    onSelect(d.id);
    if (d.type === "text") onToolDone?.(d);
  };

  const showLoupe = (e: React.PointerEvent, p: Pt) => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return;
    setLoupe({ cx: e.clientX - r.left, cy: e.clientY - r.top, p });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!interactive || !meta) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom };
      drag.current = null;
      setDraft(null);
      setLoupe(null);
      return;
    }
    if (player.playing) player.pause();
    const p = toVideo(e.clientX, e.clientY);
    const t = tool.tool;

    if (t === "move") {
      const hit = hitTest(rec.record.drawings.filter((d) => resolved.has(d.id)), resolved, p, 10 * unit);
      if (hit) {
        onSelect(hit.id);
        rec.beginLive();
        drag.current = hit.handle >= 0 ? { kind: "handle", id: hit.id, handle: hit.handle } : { kind: "body", id: hit.id, last: p };
        if (hit.handle >= 0) showLoupe(e, p);
      } else {
        onSelect(null);
        if (zoom > 1) drag.current = { kind: "pan", x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
      }
      return;
    }
    if (t === "track") {
      void session.trackPoint(p[0], p[1], tool.color).then(() => onToolDone?.(null));
      return;
    }
    const a = anchorAt(p, t !== "pen" && t !== "text");
    if (t === "plumb" || t === "text") {
      commit(newDrawing(t, a));
      return;
    }
    if (t === "pen") {
      const d = newDrawing("pen", { kind: "free", p });
      drag.current = { kind: "draw", d, moved: false };
      setDraft({ d });
      return;
    }
    // Multi-point tools: continue a click-placed draft, else start one (drag to place 2-point tools).
    if (draft && draft.d.type === t) {
      const d = { ...draft.d, pts: [...draft.d.pts, a] };
      if (d.pts.length >= POINTS_FOR[t]) commit(d);
      else setDraft({ d });
      showLoupe(e, a.p);
      return;
    }
    const d = newDrawing(t, a);
    if (POINTS_FOR[t] === 2) {
      const dd = { ...d, pts: [a, a] };
      drag.current = { kind: "draw", d: dd, moved: false };
      setDraft({ d: dd });
    } else {
      setDraft({ d });
    }
    showLoupe(e, a.p);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!interactive || !meta) return;
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(pinch.current.zoom * (d / Math.max(1, pinch.current.d)), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    const p = toVideo(e.clientX, e.clientY);
    const g = drag.current;
    const snapping = tool.tool !== "move" || g?.kind === "handle";
    if (tool.tool !== "move" && tool.tool !== "pen" && tool.tool !== "track") {
      const a = anchorAt(p, true);
      setHover(a.p);
      setSnapAt(a.kind === "joint" ? a.p : null);
    } else if (!snapping) {
      setSnapAt(null);
    }
    if (!g) return;
    if (g.kind === "pan") {
      setPan(clampPan(g.px + (e.clientX - g.x), g.py + (e.clientY - g.y), zoom));
      return;
    }
    if (g.kind === "handle") {
      const a = anchorAt(p, true);
      setSnapAt(a.kind === "joint" ? a.p : null);
      showLoupe(e, a.p);
      rec.edit((r) => ({ ...r, drawings: r.drawings.map((d) => (d.id === g.id ? { ...d, pts: d.pts.map((x, i) => (i === g.handle ? a : x)) } : d)) }), { live: true });
      return;
    }
    if (g.kind === "body") {
      const dx = p[0] - g.last[0];
      const dy = p[1] - g.last[1];
      g.last = p;
      rec.edit((r) => ({ ...r, drawings: r.drawings.map((d) => (d.id === g.id ? translate(d, dx, dy) : d)) }), { live: true });
      return;
    }
    if (g.kind === "draw") {
      if (g.d.type === "pen") {
        const last = g.d.pts[g.d.pts.length - 1].p;
        if (dist(last, p) >= 2 * unit) {
          g.d = { ...g.d, pts: [...g.d.pts, { kind: "free", p }] };
          g.moved = true;
          setDraft({ d: g.d });
        }
        return;
      }
      const a = anchorAt(p, true);
      if (dist(g.d.pts[0].p, a.p) > 6 * unit) g.moved = true;
      g.d = { ...g.d, pts: [g.d.pts[0], a] };
      setDraft({ d: g.d });
      showLoupe(e, a.p);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    const g = drag.current;
    drag.current = null;
    setLoupe(null);
    if (!g) return;
    if (g.kind === "handle" || g.kind === "body") rec.endLive();
    if (g.kind === "draw") {
      if (g.d.type === "pen") {
        if (g.d.pts.length >= 2) commit(g.d);
        else setDraft(null);
        return;
      }
      // A drag placed both points; a tap starts click-to-place (the next tap sets point two).
      if (g.moved) commit(g.d);
      else setDraft({ d: { ...g.d, pts: [g.d.pts[0]] } });
    }
  };

  const onPointerLeave = () => {
    setHover(null);
    if (!drag.current) setSnapAt(null);
  };

  const cursor = tool.tool === "move" ? (zoom > 1 ? "grab" : "default") : "crosshair";
  return (
    <div
      ref={boxRef}
      className="az-stage"
      style={{ aspectRatio: `${W} / ${H}`, width: `min(100%, calc(${maxHeightVh}vh * ${(W / H).toFixed(4)}))`, opacity }}
    >
      <div className="az-stage__content" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
        <div className="az-stage__media" style={view.mirrored ? { transform: "scaleX(-1)" } : undefined}>
          {/* One <video> for the clip's whole life: remounting it would reload the file. */}
          <video className="az-stage__video" {...player.videoProps} style={{ filter: filterCss(view) }} />
          {meta && <Overlay
            svgRef={overlaySvg}
            className="az-stage__overlay"
            width={W}
            height={H}
            unit={unit}
            mirrored={view.mirrored}
            pose={poseNow?.landmarks ?? null}
            showSkeleton={view.showSkeleton}
            showAngles={view.showAngles}
            angleIds={view.angleIds}
            trails={trails}
            items={items}
            selectedId={selectedId}
            draft={draftView}
            snapAt={snapAt}
          />}
        </div>
      </div>
      {!meta && <p className="az-stage__msg">{player.error ?? "Opening the clip…"}</p>}
      {interactive && meta && (
        <div
          className="az-stage__hit"
          // Unzoomed with the Move tool, a vertical swipe scrolls the page (phones); anything that
          // draws, drags or pans keeps every touch.
          style={{ cursor, touchAction: tool.tool === "move" && zoom === 1 ? "pan-y" : "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerLeave}
        />
      )}
      {loupe && <Loupe video={player.videoRef.current} at={loupe} unit={unit} mirrored={view.mirrored} width={W} height={H} filter={filterCss(view)} boxW={boxW} />}
      {interactive && meta && (
        <div className="az-zoom" role="group" aria-label="Zoom">
          <button type="button" className="lg-btn lg-btn--icon az-zoom__btn" onClick={() => zoomAt(zoom * 1.5)} aria-label="Zoom in" title="Zoom in (or scroll / pinch)">
            +
          </button>
          <button type="button" className="lg-btn lg-btn--icon az-zoom__btn" onClick={() => zoomAt(zoom / 1.5)} aria-label="Zoom out" disabled={zoom <= 1}>
            −
          </button>
          {zoom > 1 && (
            <button type="button" className="lg-btn btn--sm az-zoom__fit" onClick={() => (setZoom(1), setPan({ x: 0, y: 0 }))} title="Fit the whole frame">
              Fit
            </button>
          )}
        </div>
      )}
      {draft && POINTS_FOR[draft.d.type] > 1 && draft.d.type !== "pen" && (
        <p className="az-stage__hint">
          {draft.d.type === "angle" ? ["Tap the first end", "Tap the corner (the joint)", "Tap the other end"][draft.d.pts.length] : "Tap the second point"} · Esc to cancel
        </p>
      )}
    </div>
  );
}

/** A 3× magnifier of the frame under the pointer, with a crosshair. */
function Loupe({ video, at, unit, mirrored, width, height, filter, boxW }: { video: HTMLVideoElement | null; at: { cx: number; cy: number; p: Pt }; unit: number; mirrored: boolean; width: number; height: number; filter?: string; boxW: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const SIZE = 132;
  useEffect(() => {
    const c = ref.current;
    if (!c || !video) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const src = (SIZE * unit) / 3;
    ctx.save();
    ctx.clearRect(0, 0, SIZE, SIZE);
    if (filter) ctx.filter = filter;
    if (mirrored) {
      ctx.translate(SIZE, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, at.p[0] - src / 2, at.p[1] - src / 2, src, src, 0, 0, SIZE, SIZE);
    ctx.restore();
    ctx.strokeStyle = "rgba(255,210,63,0.95)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(SIZE / 2, 0);
    ctx.lineTo(SIZE / 2, SIZE);
    ctx.moveTo(0, SIZE / 2);
    ctx.lineTo(SIZE, SIZE / 2);
    ctx.stroke();
  }, [video, at, unit, mirrored, width, height, filter]);
  // Sit above-left of the finger, or above-right near the left edge.
  const left = at.cx > SIZE + 30 ? at.cx - SIZE - 24 : Math.min(boxW - SIZE, at.cx + 24);
  const top = Math.max(4, at.cy - SIZE - 24);
  return <canvas ref={ref} className="az-loupe" width={SIZE} height={SIZE} style={{ left, top }} aria-hidden="true" />;
}
