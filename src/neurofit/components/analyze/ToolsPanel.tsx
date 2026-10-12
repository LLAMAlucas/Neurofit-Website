/**
 * Side-panel sections for drawing/measuring, motion (skeleton, trails, tracked points, the angle
 * chart) and view (mirror, brightness, snapshot). The AI coach has its own panel (AiPanel).
 */
import { useState } from "react";
import { COLORS, measure, resolvePoints, type Drawing } from "../../analyze/annotations";
import { makeCalibration } from "../../analyze/geometry";
import { ANALYZE_JOINTS, ANGLE_LABEL } from "../../analyze/jointAngles";
import type { ClipSession } from "../../hooks/useClipSession";
import { Segmented } from "../Segmented";
import { AngleChart, chartOptions } from "./AngleChart";
import type { ToolId, ToolState, ViewOptions } from "./ClipStage";

const TOOLS: { id: ToolId; label: string; hint: string; icon: string }[] = [
  { id: "move", label: "Move", hint: "Select, drag points, pan when zoomed", icon: "M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" },
  { id: "angle", label: "Angle", hint: "Tap end, corner, end — snaps to joints", icon: "M4 20 L20 20 M4 20 L15 6 M10 20 A6 6 0 0 0 8.2 15" },
  { id: "line", label: "Line", hint: "Drag — shows its tilt", icon: "M4 19 L20 5" },
  { id: "ruler", label: "Ruler", hint: "Drag — shows length", icon: "M4 17 L17 4 L20 7 L7 20 Z M8 13 l2 2 M11 10 l2 2 M14 7 l2 2" },
  { id: "plumb", label: "Plumb", hint: "Tap — a vertical reference line", icon: "M12 3v15 M9 18h6 l-3 3z" },
  { id: "circle", label: "Circle", hint: "Drag from the centre", icon: "M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0 -16 0" },
  { id: "arrow", label: "Arrow", hint: "Drag", icon: "M4 20 L19 5 M11 5h8v8" },
  { id: "pen", label: "Pen", hint: "Draw freehand", icon: "M4 20c4-1 5-6 8-8s6 1 8-4" },
  { id: "text", label: "Text", hint: "Tap to place a note", icon: "M5 5h14M12 5v14" },
  { id: "track", label: "Track", hint: "Tap a spot (e.g. the bar end) to follow it — its path is drawn", icon: "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M4 20c3-8 6-12 16-16" },
];

function Ico({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Toggle({ on, onChange, label, disabled = false }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="env-toggle az-toggle">
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function DrawPanel({
  session,
  tool,
  setTool,
  selectedId,
  setSelectedId,
}: {
  session: ClipSession;
  tool: ToolState;
  setTool: (t: ToolState) => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
}) {
  const { rec, poseNow, player } = session;
  const sel: Drawing | undefined = rec.record.drawings.find((d) => d.id === selectedId);
  const [refLen, setRefLen] = useState("45");
  const [refUnit, setRefUnit] = useState<"cm" | "in" | "m">("cm");
  const cal = rec.record.calibration;
  const editSel = (fn: (d: Drawing) => Drawing) => rec.edit((r) => ({ ...r, drawings: r.drawings.map((d) => (d.id === selectedId ? fn(d) : d)) }));
  const meta = player.meta;
  const selPx = sel && sel.type === "ruler" && meta ? measure(sel, resolvePoints(sel, poseNow?.landmarks ?? null, { width: meta.width, height: meta.height }).pts, null).value : null;

  return (
    <div className="az-draw">
      <div className="az-tools" role="toolbar" aria-label="Drawing tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="btn az-tool"
            aria-pressed={tool.tool === t.id}
            onClick={() => setTool({ ...tool, tool: t.id })}
            title={t.hint}
          >
            <Ico d={t.icon} />
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <p className="panel__foot az-tools__hint">{TOOLS.find((t) => t.id === tool.tool)?.hint}</p>

      <div className="az-row">
        <div className="az-swatches" role="radiogroup" aria-label="Colour">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={tool.color === c}
              className="az-swatch"
              style={{ background: c }}
              onClick={() => {
                setTool({ ...tool, color: c });
                if (sel) editSel((d) => ({ ...d, color: c }));
              }}
              aria-label={`Colour ${c}`}
            />
          ))}
        </div>
      </div>
      <div className="az-row">
        <Segmented
          label="New drawings stay on"
          value={tool.scope}
          onChange={(v) => setTool({ ...tool, scope: v })}
          options={[
            { value: "frame", label: "This frame", title: "Shown on the frame you drew it on, fading out either side" },
            { value: "clip", label: "Whole clip", title: "Shown on every frame" },
          ]}
        />
        <Toggle on={tool.snap} onChange={(v) => setTool({ ...tool, snap: v })} label="Snap to joints" />
      </div>
      <div className="az-row">
        <button type="button" className="btn btn--sm" onClick={rec.undo} disabled={!rec.canUndo} title="Undo (Ctrl/Cmd + Z)">
          Undo
        </button>
        <button type="button" className="btn btn--sm" onClick={rec.redo} disabled={!rec.canRedo} title="Redo (Ctrl/Cmd + Shift + Z)">
          Redo
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={rec.record.drawings.length === 0}
          onClick={() => {
            setSelectedId(null);
            rec.edit((r) => ({ ...r, drawings: [], calibration: null }));
          }}
        >
          Clear all
        </button>
      </div>

      {sel && (
        <div className="az-selected">
          <p className="panel__title">Selected {sel.type}</p>
          <label className="az-field">
            <span className="az-field__label">{sel.type === "text" ? "Text" : "Name (optional)"}</span>
            <input className="az-input" type="text" maxLength={80} value={sel.text ?? ""} placeholder={sel.type === "text" ? "Note" : "e.g. hip line"} onChange={(e) => editSel((d) => ({ ...d, text: e.target.value }))} />
          </label>
          <div className="az-row">
            <Segmented
              label="Shown on"
              value={sel.scope}
              onChange={(v) => editSel((d) => ({ ...d, scope: v }))}
              options={[
                { value: "frame", label: "This frame" },
                { value: "clip", label: "Whole clip" },
              ]}
            />
            {sel.type === "plumb" && (
              <Segmented
                label="Direction"
                value={sel.orientation ?? "vertical"}
                onChange={(v) => editSel((d) => ({ ...d, orientation: v }))}
                options={[
                  { value: "vertical", label: "Vertical" },
                  { value: "horizontal", label: "Level" },
                ]}
              />
            )}
          </div>
          {sel.pts.some((a) => a.kind === "joint") && (
            <p className="panel__foot">
              Snapped to {sel.pts.filter((a) => a.kind === "joint").map((a) => (a.kind === "joint" ? ANALYZE_JOINTS.find((j) => j.index === a.index)?.label.toLowerCase() : "")).join(", ")} — it follows the body frame to frame.
            </p>
          )}
          {sel.type === "ruler" && selPx !== null && (
            <div className="az-calib">
              <p className="panel__foot">Know this length? Set it as the scale and every ruler reads in real units (only true at the same distance from the camera).</p>
              <div className="az-row">
                <input className="az-input az-input--num" type="number" min="0.1" step="0.1" value={refLen} onChange={(e) => setRefLen(e.target.value)} aria-label="Real length" />
                <select className="az-input az-input--unit" value={refUnit} onChange={(e) => setRefUnit(e.target.value as "cm" | "in" | "m")} aria-label="Unit">
                  <option value="cm">cm</option>
                  <option value="in">in</option>
                  <option value="m">m</option>
                </select>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    const c = makeCalibration(selPx, Number(refLen), refUnit);
                    if (c) rec.edit((r) => ({ ...r, calibration: { ...c, refId: sel.id } }));
                  }}
                >
                  Set scale
                </button>
              </div>
            </div>
          )}
          <button
            type="button"
            className="btn btn--sm az-danger"
            onClick={() => {
              setSelectedId(null);
              rec.edit((r) => ({ ...r, drawings: r.drawings.filter((d) => d.id !== sel.id), calibration: r.calibration?.refId === sel.id ? null : r.calibration }));
            }}
            title="Delete (Delete key)"
          >
            Delete
          </button>
        </div>
      )}
      {cal && (
        <p className="panel__foot">
          Scale: {cal.pxPerUnit.toFixed(2)} px per {cal.unit}.{" "}
          <button type="button" className="az-link" onClick={() => rec.edit((r) => ({ ...r, calibration: null }))}>
            Remove
          </button>
        </p>
      )}
      {session.tracking.status === "working" && <p className="ai-msg ai-msg--loading">Following the point · {Math.round(session.tracking.progress * 100)}%</p>}
      {session.tracking.status === "error" && <p className="ai-msg ai-msg--error">{session.tracking.message}</p>}
    </div>
  );
}

const TRAIL_JOINTS = [0, 15, 16, 13, 14, 11, 12, 23, 24, 25, 26, 27, 28];

export function MotionPanel({ session, view, setView, series, setSeries }: { session: ClipSession; view: ViewOptions; setView: (v: ViewOptions) => void; series: string; setSeries: (s: string) => void }) {
  const { pose, finding, rec } = session;
  const opts = chartOptions(session);
  const toggleJoint = (i: number) =>
    setView({ ...view, trailJoints: view.trailJoints.includes(i) ? view.trailJoints.filter((j) => j !== i) : [...view.trailJoints, i] });
  return (
    <div className="az-motion">
      <div className="az-row">
        <Toggle on={view.showSkeleton} onChange={(v) => setView({ ...view, showSkeleton: v })} label="Skeleton" />
        <Toggle on={view.showAngles} onChange={(v) => setView({ ...view, showAngles: v })} label="Joint angles" />
        <Toggle on={view.showTracks} onChange={(v) => setView({ ...view, showTracks: v })} label="Tracked points" />
      </div>
      <p className="panel__foot">
        {pose.status === "running"
          ? `Reading the movement · ${Math.round(pose.progress * 100)}%`
          : pose.status === "error"
            ? `Couldn't read the movement: ${pose.error}`
            : finding
              ? finding.reps.length > 0
                ? `${finding.reps.length} rep${finding.reps.length === 1 ? "" : "s"} found from the ${finding.joint} angle.`
                : "No reps found — the clip may be a hold, or the body is too small in frame."
              : pose.status === "done"
                ? "No body found in this clip."
                : session.tooLong
                  ? "Long clip: set in and out marks, then the movement is read when you ask the AI."
                  : "Waiting to read the movement…"}
      </p>

      <p className="panel__title">Trails</p>
      <div className="az-chips" role="group" aria-label="Joint trails">
        {TRAIL_JOINTS.map((i) => (
          <button key={i} type="button" className="btn btn--sm az-chip" aria-pressed={view.trailJoints.includes(i)} onClick={() => toggleJoint(i)}>
            {ANALYZE_JOINTS.find((j) => j.index === i)?.label}
          </button>
        ))}
      </div>
      <div className="az-row">
        <Segmented
          label="Trail length"
          value={view.trailSpanMs === null ? "all" : String(view.trailSpanMs)}
          onChange={(v) => setView({ ...view, trailSpanMs: v === "all" ? null : Number(v) })}
          options={[
            { value: "1000", label: "Last 1 s" },
            { value: "3000", label: "Last 3 s" },
            { value: "all", label: "Whole range" },
          ]}
        />
      </div>
      {rec.record.tracks.length > 0 && (
        <ul className="az-tracks">
          {rec.record.tracks.map((t) => (
            <li key={t.id}>
              <span className="az-dot" style={{ background: t.color }} />
              {t.label} · {t.points.length} frames
              <button type="button" className="az-link" onClick={() => rec.edit((r) => ({ ...r, tracks: r.tracks.filter((x) => x.id !== t.id) }))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="panel__foot">Trails are coloured by speed: blue is slow, red is fast. Use the Track tool for things the pose model can’t see, like the bar.</p>

      <p className="panel__title">Angle over time</p>
      <select className="az-input" value={series} onChange={(e) => setSeries(e.target.value)} aria-label="Angle to chart">
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <AngleChart session={session} series={opts.some((o) => o.value === series) ? series : "auto:left_knee"} />
      <p className="panel__foot">2D angles from the picture: a joint bending toward or away from the camera reads wrong. {ANGLE_LABEL.trunk_lean} is measured from straight up.</p>
    </div>
  );
}

export function ViewPanel({ view, setView, onSnapshot, snapshotBusy }: { view: ViewOptions; setView: (v: ViewOptions) => void; onSnapshot: () => void; snapshotBusy: boolean }) {
  return (
    <div className="az-viewopts">
      <div className="az-row">
        <Toggle on={view.mirrored} onChange={(v) => setView({ ...view, mirrored: v })} label="Mirror" />
      </div>
      <label className="az-field">
        <span className="az-field__label">Brightness {Math.round(view.brightness * 100)}%</span>
        <input type="range" min="0.5" max="2" step="0.05" value={view.brightness} onChange={(e) => setView({ ...view, brightness: Number(e.target.value) })} />
      </label>
      <label className="az-field">
        <span className="az-field__label">Contrast {Math.round(view.contrast * 100)}%</span>
        <input type="range" min="0.5" max="2" step="0.05" value={view.contrast} onChange={(e) => setView({ ...view, contrast: Number(e.target.value) })} />
      </label>
      <div className="az-row">
        <button type="button" className="btn btn--sm" onClick={() => setView({ ...view, brightness: 1, contrast: 1 })} disabled={view.brightness === 1 && view.contrast === 1}>
          Reset picture
        </button>
        <button type="button" className="btn btn--sm" onClick={onSnapshot} disabled={snapshotBusy} title="Save this frame with your drawings as a PNG">
          Save snapshot
        </button>
      </div>
      <p className="panel__foot">Brightness and contrast also apply to the frames sent to the AI — handy for a dark gym clip.</p>
    </div>
  );
}
