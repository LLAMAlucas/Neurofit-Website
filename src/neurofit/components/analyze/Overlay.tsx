/**
 * Everything drawn over the clip, as one SVG in VIDEO PIXEL coordinates (viewBox = the clip's
 * own size), so drawings stay exactly on the body under zoom, pan and any screen size.
 * ----------------------------------------------------------------------------
 * `unit` = video pixels per screen pixel. Stroke widths, handle sizes and text are multiplied by
 * it, so a 2 px line is 2 px on screen at any zoom — and a snapshot (snapshot.ts serializes this
 * very element) looks like what was on screen. Mirroring is a CSS flip of the parent; text is
 * counter-flipped here so labels stay readable.
 */
import type { Landmark } from "../../pose/landmarks";
import { angleArc, type Pt } from "../../analyze/geometry";
import { ANGLE_DEFS, SKELETON_LINKS, computeJointAngles, seenPx, type AngleId } from "../../analyze/jointAngles";
import type { Drawing, Measurement } from "../../analyze/annotations";
import type { TrailPoint } from "../../analyze/poseTrack";

export interface DrawnItem {
  d: Drawing;
  pts: Pt[];
  opacity: number;
  m: Measurement;
  tracked: boolean;
}

export interface TrailLine {
  id: string;
  color: string;
  runs: TrailPoint[][];
  /** Where the point is now, if it is seen now. */
  now: Pt | null;
}

export interface OverlayProps {
  width: number;
  height: number;
  unit: number;
  mirrored: boolean;
  pose: readonly Landmark[] | null;
  showSkeleton: boolean;
  showAngles: boolean;
  /** Which of the auto angles to label (empty = all seen). */
  angleIds?: readonly AngleId[];
  trails: TrailLine[];
  items: DrawnItem[];
  selectedId: string | null;
  draft: { d: Drawing; pts: Pt[]; m?: Measurement } | null;
  snapAt: Pt | null;
  svgRef?: React.Ref<SVGSVGElement>;
  className?: string;
}

const FONT = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

function Label({ at, text, unit, mirrored, color = "#fff", anchor = "middle", size = 13 }: { at: Pt; text: string; unit: number; mirrored: boolean; color?: string; anchor?: "start" | "middle" | "end"; size?: number }) {
  if (!text) return null;
  const fs = size * unit;
  const padX = 5 * unit;
  const w = text.length * fs * 0.62 + padX * 2;
  const h = fs * 1.5;
  const x0 = anchor === "middle" ? at[0] - w / 2 : anchor === "end" ? at[0] - w : at[0];
  return (
    <g transform={mirrored ? `translate(${2 * at[0]} 0) scale(-1 1)` : undefined}>
      <rect x={x0} y={at[1] - h / 2} width={w} height={h} rx={h / 2} fill="rgba(21,25,30,0.78)" />
      <text x={x0 + w / 2} y={at[1]} fill={color} fontFamily={FONT} fontSize={fs} textAnchor="middle" dominantBaseline="central">
        {text}
      </text>
    </g>
  );
}

function speedColor(speed: number, max: number): string {
  // Slow = cool blue, fast = hot orange-red (bar-path apps colour by speed the same way).
  const k = max > 0 ? Math.min(1, speed / max) : 0;
  return `hsl(${Math.round(200 - 190 * k)} 95% ${Math.round(62 - 6 * k)}%)`;
}

function Trail({ t, unit }: { t: TrailLine; unit: number }) {
  const max = Math.max(1, ...t.runs.flatMap((r) => r.map((p) => p.speed)));
  return (
    <g>
      {t.runs.map((run, i) =>
        run.slice(1).map((p, j) => (
          <line
            key={`${i}-${j}`}
            x1={run[j].p[0]}
            y1={run[j].p[1]}
            x2={p.p[0]}
            y2={p.p[1]}
            stroke={speedColor(p.speed, max)}
            strokeWidth={3 * unit}
            strokeLinecap="round"
          />
        )),
      )}
      {t.now && <circle cx={t.now[0]} cy={t.now[1]} r={5 * unit} fill={t.color} stroke="#15191e" strokeWidth={1.5 * unit} />}
    </g>
  );
}

function Shape({ item, unit, mirrored, selected, width, height }: { item: DrawnItem; unit: number; mirrored: boolean; selected: boolean; width: number; height: number }) {
  const { d, pts, m } = item;
  const sw = 2.2 * unit;
  const c = d.color;
  const hr = (selected ? 6 : 4) * unit;
  const handles = d.type !== "pen" && d.type !== "text";
  const common = { stroke: c, strokeWidth: sw, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  let body: JSX.Element | null = null;
  let label: JSX.Element | null = null;
  switch (d.type) {
    case "angle": {
      if (pts.length < 3) break;
      const arc = angleArc(pts[0], pts[1], pts[2], 28 * unit);
      body = (
        <>
          <polyline points={pts.map((p) => p.join(",")).join(" ")} {...common} />
          <path d={arc.d} {...common} strokeWidth={sw * 0.8} />
        </>
      );
      label = <Label at={arc.label} text={m.text} unit={unit} mirrored={mirrored} color={c} />;
      break;
    }
    case "line":
    case "ruler":
    case "arrow": {
      if (pts.length < 2) break;
      const [a, b] = pts;
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const tick = 7 * unit;
      const nx = -Math.sin(ang) * tick;
      const ny = Math.cos(ang) * tick;
      const head = 14 * unit;
      body = (
        <>
          <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} {...common} />
          {d.type === "ruler" && (
            <>
              <line x1={a[0] - nx} y1={a[1] - ny} x2={a[0] + nx} y2={a[1] + ny} {...common} />
              <line x1={b[0] - nx} y1={b[1] - ny} x2={b[0] + nx} y2={b[1] + ny} {...common} />
            </>
          )}
          {d.type === "arrow" && (
            <polyline
              points={`${b[0] - head * Math.cos(ang - 0.45)},${b[1] - head * Math.sin(ang - 0.45)} ${b[0]},${b[1]} ${b[0] - head * Math.cos(ang + 0.45)},${b[1] - head * Math.sin(ang + 0.45)}`}
              {...common}
            />
          )}
        </>
      );
      if (m.text) {
        const mid: Pt = [(a[0] + b[0]) / 2 + nx * 2.4, (a[1] + b[1]) / 2 + ny * 2.4];
        label = <Label at={mid} text={d.text ? `${d.text} · ${m.text}` : m.text} unit={unit} mirrored={mirrored} color={c} />;
      }
      break;
    }
    case "plumb": {
      const p = pts[0];
      body =
        d.orientation === "horizontal" ? (
          <line x1={0} y1={p[1]} x2={width} y2={p[1]} {...common} strokeDasharray={`${8 * unit} ${6 * unit}`} />
        ) : (
          <line x1={p[0]} y1={0} x2={p[0]} y2={height} {...common} strokeDasharray={`${8 * unit} ${6 * unit}`} />
        );
      break;
    }
    case "circle": {
      if (pts.length < 2) break;
      const r = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
      body = <circle cx={pts[0][0]} cy={pts[0][1]} r={r} {...common} />;
      break;
    }
    case "pen":
      body = <polyline points={pts.map((p) => p.join(",")).join(" ")} {...common} />;
      break;
    case "text":
      label = <Label at={pts[0]} text={d.text || "Note"} unit={unit} mirrored={mirrored} color={c} size={15} />;
      break;
  }
  return (
    <g opacity={item.opacity} style={selected ? { filter: "drop-shadow(0 0 3px rgba(255,255,255,0.95))" } : undefined}>
      {body}
      {label}
      {handles &&
        pts.map((p, i) => (
          <circle
            key={i}
            cx={p[0]}
            cy={p[1]}
            r={hr}
            fill={d.pts[i]?.kind === "joint" ? c : "#15191e"}
            stroke={c}
            strokeWidth={1.6 * unit}
          />
        ))}
      {!item.tracked && d.pts.some((a) => a.kind === "joint") && <Label at={[pts[0][0], pts[0][1] - 22 * unit]} text="joint not seen" unit={unit} mirrored={mirrored} color="#ffb4a8" size={11} />}
    </g>
  );
}

export function Overlay(p: OverlayProps) {
  const size = { width: p.width, height: p.height };
  const u = p.unit;
  const angles = p.pose && p.showAngles ? computeJointAngles(p.pose, size) : null;
  // Angle labels sit on the OUTER side of each joint (away from the body's midline), so the two
  // hips or shoulders of a front view don't print on top of each other.
  const midX = (() => {
    if (!angles || !p.pose) return null;
    const xs = [11, 12, 23, 24].map((i) => seenPx(p.pose!, i, size, 0.5)).filter((q): q is Pt => q !== null).map((q) => q[0]);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  })();
  return (
    <svg
      ref={p.svgRef}
      className={p.className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${p.width} ${p.height}`}
      width={p.width}
      height={p.height}
      preserveAspectRatio="none"
    >
      {p.pose && p.showSkeleton && (
        <g>
          {SKELETON_LINKS.map(([a, b]) => {
            const pa = seenPx(p.pose!, a, size, 0.5);
            const pb = seenPx(p.pose!, b, size, 0.5);
            return pa && pb ? <line key={`${a}-${b}`} x1={pa[0]} y1={pa[1]} x2={pb[0]} y2={pb[1]} stroke="rgba(230,242,251,0.85)" strokeWidth={2.4 * u} strokeLinecap="round" /> : null;
          })}
          {[0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32].map((i) => {
            const pt = seenPx(p.pose!, i, size, 0.5);
            return pt ? <circle key={i} cx={pt[0]} cy={pt[1]} r={3.6 * u} fill="#e6f2fb" stroke="#15191e" strokeWidth={1 * u} /> : null;
          })}
        </g>
      )}
      {angles &&
        ANGLE_DEFS.filter((d) => d.points && (!p.angleIds || p.angleIds.length === 0 || p.angleIds.includes(d.id))).map((d) => {
          const v = angles[d.id];
          const at = v !== null && d.points ? seenPx(p.pose!, d.points[1], size) : null;
          if (v === null || !at) return null;
          const side = midX !== null && Math.abs(at[0] - midX) > 2 * u ? Math.sign(at[0] - midX) : d.id.startsWith("left") ? 1 : -1;
          return <Label key={d.id} at={[at[0] + side * 30 * u, at[1]]} text={`${Math.round(v)}°`} unit={u} mirrored={p.mirrored} color="#e6f2fb" size={12} />;
        })}
      {p.trails.map((t) => (
        <Trail key={t.id} t={t} unit={u} />
      ))}
      {p.items.map((it) => (
        <Shape key={it.d.id} item={it} unit={u} mirrored={p.mirrored} selected={it.d.id === p.selectedId} width={p.width} height={p.height} />
      ))}
      {p.draft && (
        <Shape
          item={{ d: p.draft.d, pts: p.draft.pts, opacity: 0.9, m: p.draft.m ?? { kind: "none", value: null, text: "" }, tracked: true }}
          unit={u}
          mirrored={p.mirrored}
          selected={false}
          width={p.width}
          height={p.height}
        />
      )}
      {p.snapAt && <circle cx={p.snapAt[0]} cy={p.snapAt[1]} r={11 * u} fill="none" stroke="#ffd23f" strokeWidth={2 * u} />}
    </svg>
  );
}
