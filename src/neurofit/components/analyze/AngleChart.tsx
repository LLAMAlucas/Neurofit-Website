/**
 * An angle over time — any auto joint angle, or an angle the user drew with its points snapped
 * to joints (which then reads on every frame). Reps shaded, the playhead marked; tap to seek.
 * Degrees on the axis are real units; the values are 2D image angles (the note says so).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ANGLE_DEFS, ANGLE_LABEL, computeJointAngles, type AngleId } from "../../analyze/jointAngles";
import { measure, resolvePoints } from "../../analyze/annotations";
import { smoothSeries, type SeriesPoint } from "../../analyze/poseTrack";
import type { ClipSession } from "../../hooks/useClipSession";
import { fmtTime } from "./Timeline";

export type ChartSeries = { kind: "auto"; id: AngleId } | { kind: "drawn"; id: string };

export function chartOptions(session: ClipSession): { value: string; label: string }[] {
  const drawn = session.rec.record.drawings
    .filter((d) => d.type === "angle" && d.pts.every((a) => a.kind === "joint"))
    .map((d, i) => ({ value: `drawn:${d.id}`, label: d.text ? `Your angle: ${d.text}` : `Your angle ${i + 1}` }));
  return [...ANGLE_DEFS.map((d) => ({ value: `auto:${d.id}`, label: d.label })), ...drawn];
}

export function AngleChart({ session, series }: { session: ClipSession; series: string }) {
  const { pose, range, finding, player, rec } = session;
  const track = pose.track;
  const svgRef = useRef<SVGSVGElement>(null);
  const figRef = useRef<HTMLElement>(null);
  const [W, setW] = useState(600);
  useEffect(() => {
    const el = figRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(200, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const data: SeriesPoint[] = useMemo(() => {
    if (!track) return [];
    const [kind, id] = series.split(":") as ["auto" | "drawn", string];
    if (kind === "auto") {
      return smoothSeries(track.series((s) => computeJointAngles(s.landmarks, track.size)[id as AngleId], range.inMs, range.outMs), 60);
    }
    const d = rec.record.drawings.find((x) => x.id === id);
    if (!d) return [];
    return smoothSeries(
      track.series((s) => {
        const r = resolvePoints(d, s.landmarks, track.size);
        return r.tracked ? measure(d, r.pts, null).value : null;
      }, range.inMs, range.outMs),
      60,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track, pose.version, series, range, rec.record.drawings]);

  const H = 120;
  const PAD = { l: 34, r: 8, t: 8, b: 16 };
  const span = Math.max(1, range.outMs - range.inMs);
  const vals = data.map((p) => p.v);
  const lo = vals.length ? Math.floor(Math.min(...vals) / 10) * 10 : 0;
  const hi = vals.length ? Math.ceil(Math.max(...vals) / 10) * 10 : 180;
  const yr = Math.max(10, hi - lo);
  const x = (t: number) => PAD.l + ((t - range.inMs) / span) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / yr) * (H - PAD.t - PAD.b);

  // Break the line where samples are far apart (the joint wasn't seen).
  const paths: string[] = [];
  let cur = "";
  for (let i = 0; i < data.length; i++) {
    const gap = i > 0 && data[i].tMs - data[i - 1].tMs > 250;
    cur += `${cur && !gap ? "L" : "M"}${x(data[i].tMs).toFixed(1)},${y(data[i].v).toFixed(1)}`;
    if (gap) {
      paths.push(cur);
      cur = `M${x(data[i].tMs).toFixed(1)},${y(data[i].v).toFixed(1)}`;
    }
  }
  if (cur) paths.push(cur);

  const nowV = (() => {
    let best: SeriesPoint | null = null;
    for (const p of data) if (!best || Math.abs(p.tMs - player.tMs) < Math.abs(best.tMs - player.tMs)) best = p;
    return best && Math.abs(best.tMs - player.tMs) < 150 ? best.v : null;
  })();

  const label = series.startsWith("auto:") ? ANGLE_LABEL[series.slice(5) as AngleId] : "Your angle";
  return (
    <figure className="az-chart" ref={figRef}>
      <figcaption className="az-chart__cap">
        <span>{label}</span>
        <span className="az-chart__now">{nowV !== null ? `${Math.round(nowV)}° at ${fmtTime(player.tMs)}` : "not seen here"}</span>
      </figcaption>
      {data.length < 3 ? (
        <p className="panel__empty">{pose.status === "running" ? "Reading the movement…" : "No readings for this angle in the range yet."}</p>
      ) : (
        <svg
          ref={svgRef}
          className="az-chart__svg"
          viewBox={`0 0 ${W} ${H}`}
          width={W}
          height={H}
          role="img"
          aria-label={`${label} over time, ${Math.round(Math.min(...vals))} to ${Math.round(Math.max(...vals))} degrees`}
          onPointerDown={(e) => {
            const r = svgRef.current?.getBoundingClientRect();
            if (!r) return;
            const fx = ((e.clientX - r.left) / r.width) * W;
            player.pause();
            player.seek(range.inMs + ((fx - PAD.l) / (W - PAD.l - PAD.r)) * span);
          }}
        >
          {finding?.reps.map((r) => (
            <rect key={r.index} x={x(r.startMs)} y={PAD.t} width={Math.max(1, x(r.endMs) - x(r.startMs))} height={H - PAD.t - PAD.b} className="az-chart__rep" />
          ))}
          {[lo, (lo + hi) / 2, hi].map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="az-chart__grid" />
              <text x={PAD.l - 5} y={y(v)} className="az-chart__tick" textAnchor="end" dominantBaseline="central">
                {Math.round(v)}°
              </text>
            </g>
          ))}
          {paths.map((d, i) => (
            <path key={i} d={d} className="az-chart__line" />
          ))}
          <line x1={x(player.tMs)} x2={x(player.tMs)} y1={PAD.t} y2={H - PAD.b} className="az-chart__head" />
        </svg>
      )}
    </figure>
  );
}
