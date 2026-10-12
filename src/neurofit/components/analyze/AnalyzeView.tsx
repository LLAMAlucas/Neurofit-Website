/**
 * Analyze — video form analysis. The second Neuro-Fit product, beside the live coach.
 * ----------------------------------------------------------------------------
 * Load a clip you already filmed, study it frame by frame, draw and measure on it, follow joints
 * and objects, compare two clips, and ask the AI coach about the whole clip or one frame.
 * The video stays on the device; only the still frames an AI button sends ever leave it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COLORS } from "../../analyze/annotations";
import { useClipSession, type ClipSession } from "../../hooks/useClipSession";
import { savedClips } from "../../hooks/useClipRecord";
import { Segmented } from "../Segmented";
import { AiPanel } from "./AiPanel";
import { ClipStage, filterCss, type ToolState, type ViewOptions } from "./ClipStage";
import { Timeline, fmtTime, type Marker } from "./Timeline";
import { DrawPanel, MotionPanel, ViewPanel } from "./ToolsPanel";
import { saveSnapshot } from "./snapshot";

type SideTab = "ai" | "draw" | "motion" | "view";

const DEFAULT_VIEW: ViewOptions = {
  mirrored: false,
  brightness: 1,
  contrast: 1,
  showSkeleton: true,
  showAngles: false,
  angleIds: [],
  trailJoints: [],
  trailSpanMs: 1000,
  showTracks: true,
};

function DropZone({ onFile, compact = false, title }: { onFile: (f: File) => void; compact?: boolean; title: string }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`az-drop${over ? " az-drop--over" : ""}${compact ? " az-drop--compact" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <p className="az-drop__title">{title}</p>
      <p className="az-drop__sub">Drop a video here, or</p>
      <button type="button" className="btn btn--primary" onClick={() => input.current?.click()}>
        Choose a video
      </button>
      <input
        ref={input}
        type="file"
        accept="video/*,.mov,.mp4,.m4v,.webm"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      {!compact && <p className="az-drop__privacy">Your video stays on this device. Only the still frames you send to the AI coach leave it.</p>}
    </div>
  );
}

function Intro() {
  const saved = useMemo(() => savedClips(), []);
  return (
    <div className="az-intro">
      <h2 className="az-intro__title">Study a set you already filmed.</h2>
      <ul className="az-intro__list">
        <li>Step frame by frame, slow it down, zoom in.</li>
        <li>Draw angles, lines, rulers and plumb lines — snap them to joints and they follow the body.</li>
        <li>See the skeleton, joint angles over time, and the path of any joint or the bar.</li>
        <li>Put two clips side by side, or one over the other.</li>
        <li>Ask the AI coach to find your form errors and how to fix them — for the whole clip, or one frame.</li>
      </ul>
      <p className="panel__foot">Film from the side for depth, back angle and bar path; from the front for knees caving and side-to-side shifts. Keep the whole body in frame.</p>
      {saved.length > 0 && (
        <p className="panel__foot">
          Notes saved on this device for {saved.length} clip{saved.length === 1 ? "" : "s"} ({saved.slice(0, 3).map((s) => s.name).join(", ")}
          {saved.length > 3 ? "…" : ""}). Open the same file again to see them.
        </p>
      )}
    </div>
  );
}

function PaneHead({ session, label, onReplace, active }: { session: ClipSession; label?: string; onReplace: (f: File) => void; active: boolean }) {
  const m = session.player.meta;
  const input = useRef<HTMLInputElement>(null);
  if (!m) return null;
  return (
    <div className={`az-pane__head${active ? " az-pane__head--active" : ""}`}>
      {label && <span className="az-pane__label">{label}</span>}
      <span className="az-pane__name" title={m.name}>
        {m.name}
      </span>
      <span className="az-pane__meta">
        {m.width}×{m.height} · {fmtTime(m.durationMs)}
      </span>
      {session.rec.restored && <span className="az-pane__meta">notes restored</span>}
      <button type="button" className="az-link" onClick={() => input.current?.click()}>
        Change clip
      </button>
      <input
        ref={input}
        type="file"
        accept="video/*,.mov,.mp4,.m4v,.webm"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onReplace(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

export function AnalyzeView({ onClose, onOpenSettings }: { onClose: () => void; onOpenSettings: () => void }) {
  const a = useClipSession();
  const b = useClipSession();
  const [compare, setCompare] = useState(false);
  const [activeKey, setActiveKey] = useState<"a" | "b">("a");
  const active = compare && activeKey === "b" ? b : a;
  const other = active === a ? b : a;
  const [tool, setTool] = useState<ToolState>({ tool: "move", color: COLORS[0], scope: "frame", snap: true });
  const [views, setViews] = useState<{ a: ViewOptions; b: ViewOptions }>({ a: DEFAULT_VIEW, b: DEFAULT_VIEW });
  const view = active === b ? views.b : views.a;
  const setView = (v: ViewOptions) => setViews((s) => (active === b ? { ...s, b: v } : { ...s, a: v }));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [side, setSide] = useState<SideTab>("ai");
  const [series, setSeries] = useState("auto:left_knee");
  const [linked, setLinked] = useState(true);
  const [offsetMs, setOffsetMs] = useState(0);
  const [overlay, setOverlay] = useState(false);
  const [overlayOpacity, setOverlayOpacity] = useState(0.5);
  const [snapBusy, setSnapBusy] = useState(false);
  const svgA = useRef<SVGSVGElement>(null);
  const svgB = useRef<SVGSVGElement>(null);

  useEffect(() => setSelectedId(null), [activeKey, a.player.meta?.key, b.player.meta?.key]);
  useEffect(() => {
    if (!compare) setActiveKey("a");
  }, [compare]);

  // Linked compare: the other clip follows the one you're driving, offset by the sync point.
  const lead = active.player;
  const follow = other.player;
  useEffect(() => {
    if (!compare || !linked || !follow.meta || !lead.meta) return;
    const off = active === a ? offsetMs : -offsetMs;
    if (lead.playing) {
      if (!follow.playing) follow.play();
    } else {
      if (follow.playing) follow.pause();
      follow.seek(lead.tMs + off);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compare, linked, lead.tMs, lead.playing, offsetMs, active]);
  useEffect(() => {
    if (compare && linked && follow.meta) follow.setRate(lead.rate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compare, linked, lead.rate]);

  const removeSelected = useCallback(() => {
    if (!selectedId) return;
    active.rec.edit((r) => ({ ...r, drawings: r.drawings.filter((d) => d.id !== selectedId), calibration: r.calibration?.refId === selectedId ? null : r.calibration }));
    setSelectedId(null);
  }, [active, selectedId]);

  // Keyboard: the same keys Kinovea and most editors use.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const p = active.player;
      if (!p.meta) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) active.rec.redo();
        else active.rec.undo();
        return;
      }
      if (mod && e.key === "y") {
        e.preventDefault();
        active.rec.redo();
        return;
      }
      if (mod || e.altKey) return;
      const map: Record<string, () => void> = {
        " ": p.toggle,
        ArrowLeft: () => p.step(e.shiftKey ? -10 : -1),
        ArrowRight: () => p.step(e.shiftKey ? 10 : 1),
        Home: () => p.seek(active.range.inMs),
        End: () => p.seek(active.range.outMs - 1),
        "[": () => active.rec.edit((r) => ({ ...r, inMs: Math.min(p.tMs, (r.outMs ?? p.meta!.durationMs) - 50) })),
        "]": () => active.rec.edit((r) => ({ ...r, outMs: Math.max(p.tMs, (r.inMs ?? 0) + 50) })),
        b: () => active.rec.edit((r) => ({ ...r, bookmarks: [...r.bookmarks, { tMs: p.tMs, label: `Mark ${r.bookmarks.length + 1}` }].sort((x, y) => x.tMs - y.tMs) })),
        Delete: removeSelected,
        Backspace: removeSelected,
        Escape: () => (tool.tool !== "move" ? setTool({ ...tool, tool: "move" }) : setSelectedId(null)),
        v: () => setTool({ ...tool, tool: "move" }),
        a: () => setTool({ ...tool, tool: "angle" }),
        l: () => setTool({ ...tool, tool: "line" }),
        r: () => setTool({ ...tool, tool: "ruler" }),
        p: () => setTool({ ...tool, tool: "pen" }),
        t: () => setTool({ ...tool, tool: "text" }),
      };
      const fn = map[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    // Space is play/pause even with a button focused: stop the button's own keyup click too,
    // or the last-clicked button would fire again (and play/pause would toggle twice).
    const onKeyUp = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === " " && t?.tagName === "BUTTON") e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [active, tool, removeSelected]);

  const markers: Marker[] = useMemo(() => {
    const r = active.rec.record;
    const out: Marker[] = r.bookmarks.map((m) => ({ tMs: m.tMs, kind: "bookmark", label: m.label }));
    if (r.clipAi) {
      for (const i of r.clipAi.result.issues) {
        const t = i.frame !== null ? r.clipAi.frameTimesMs[i.frame - 1] : undefined;
        if (t !== undefined) out.push({ tMs: t, kind: i.severity, label: i.title });
      }
    }
    for (const f of r.frameAi) out.push({ tMs: f.tMs, kind: "frame", label: f.question || "You asked about this frame" });
    return out;
  }, [active.rec.record]);

  const snapshot = async () => {
    const v = active.player.videoRef.current;
    const m = active.player.meta;
    if (!v || !m) return;
    setSnapBusy(true);
    try {
      const t = active.player.tMs;
      const r = active.rec.record;
      const frameNote = r.frameAi.filter((f) => Math.abs(f.tMs - t) < 40).pop()?.result;
      const clipIssue = r.clipAi?.result.issues.find((i) => i.frame !== null && Math.abs((r.clipAi!.frameTimesMs[i.frame - 1] ?? -1e9) - t) < 40);
      const note = frameNote ? [frameNote.summary, ...frameNote.issues.map((i) => `${i.title}: ${i.howToFix}`)].join("\n") : clipIssue ? `${clipIssue.title}: ${clipIssue.howToFix}` : "";
      await saveSnapshot({
        video: v,
        svg: (active === b ? svgB : svgA).current,
        mirrored: view.mirrored,
        filter: filterCss(view),
        caption: `${m.name} · ${fmtTime(t)}${note ? `\n${note}` : ""}`,
        fileName: `${m.name.replace(/\.[^.]+$/, "")}-${fmtTime(t).replace(":", "m").replace(".", "s")}.png`,
      });
    } finally {
      setSnapBusy(false);
    }
  };

  const onToolDone = useCallback(() => setTool((t) => (t.tool === "text" || t.tool === "track" ? { ...t, tool: "move" } : t)), []);
  const hasA = !!a.player.videoProps.src;
  const hasB = !!b.player.videoProps.src;

  const stageFor = (s: ClipSession, key: "a" | "b", opts: { opacity?: number; interactive?: boolean; maxVh?: number } = {}) => (
    <ClipStage
      session={s}
      view={key === "a" ? views.a : views.b}
      tool={active === s ? tool : { ...tool, tool: "move" }}
      selectedId={active === s ? selectedId : null}
      onSelect={(id) => {
        if (active !== s) setActiveKey(key);
        setSelectedId(id);
      }}
      onToolDone={onToolDone}
      svgRef={key === "a" ? svgA : svgB}
      opacity={opts.opacity}
      interactive={opts.interactive ?? true}
      maxHeightVh={opts.maxVh ?? (compare ? 52 : 68)}
    />
  );

  return (
    <div className="az">
      <header className="nf-settings-head az-head">
        <button type="button" className="btn btn--sm az-back" onClick={onClose} title="Back to the live coach">
          ← Live coach
        </button>
        <h1 className="nf-settings-head__title">Analyze a video</h1>
        {hasA && (
          <Segmented
            className="az-mode"
            label="Layout"
            value={compare ? "compare" : "single"}
            onChange={(v) => setCompare(v === "compare")}
            options={[
              { value: "single", label: "One clip" },
              { value: "compare", label: "Compare" },
            ]}
          />
        )}
      </header>

      {!hasA ? (
        <main className="az-empty">
          <DropZone onFile={a.player.load} title="Analyze a video" />
          {a.player.error && <p className="ai-msg ai-msg--error">{a.player.error}</p>}
          <Intro />
        </main>
      ) : (
        <main className={`az-body${compare ? " az-body--compare" : ""}`}>
          <section className="az-main" aria-label="Clip">
            {compare && (
              <div className="az-compare-bar">
                <Segmented
                  label="Controls drive"
                  value={activeKey}
                  onChange={(v) => setActiveKey(v)}
                  options={[
                    { value: "a", label: "Clip A" },
                    { value: "b", label: "Clip B", disabled: !hasB },
                  ]}
                />
                <label className="env-toggle az-toggle">
                  <input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} disabled={!hasB} />
                  Link playback
                </label>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={!hasB || !b.player.meta}
                  onClick={() => setOffsetMs(b.player.tMs - a.player.tMs)}
                  title="Line the two clips up: put both on the same moment (e.g. the bottom of a rep), then press this"
                >
                  Sync here
                </button>
                <label className="env-toggle az-toggle">
                  <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} disabled={!b.player.meta} />
                  Overlay B on A
                </label>
                {overlay && (
                  <label className="az-field az-field--inline">
                    <span className="az-field__label">B opacity</span>
                    <input type="range" min="0.1" max="0.9" step="0.05" value={overlayOpacity} onChange={(e) => setOverlayOpacity(Number(e.target.value))} />
                  </label>
                )}
                {offsetMs !== 0 && <span className="az-pane__meta">B is {offsetMs > 0 ? "ahead" : "behind"} by {fmtTime(Math.abs(offsetMs))}</span>}
              </div>
            )}

            <div className={`az-panes${compare ? " az-panes--two" : ""}${compare && overlay ? " az-panes--overlay" : ""}`}>
              <div className={`az-pane${compare && active === a ? " az-pane--active" : ""}`} onPointerDownCapture={() => compare && setActiveKey("a")}>
                <PaneHead session={a} label={compare ? "A" : undefined} onReplace={a.player.load} active={compare && active === a} />
                {stageFor(a, "a")}
              </div>
              {compare && (
                <div className={`az-pane${active === b ? " az-pane--active" : ""}`} onPointerDownCapture={() => hasB && !overlay && setActiveKey("b")}>
                  {hasB ? (
                    <>
                      <PaneHead session={b} label="B" onReplace={b.player.load} active={active === b} />
                      {stageFor(b, "b", overlay ? { opacity: overlayOpacity, interactive: false } : {})}
                    </>
                  ) : (
                    <>
                      <DropZone onFile={b.player.load} compact title="Clip B — to compare" />
                      {b.player.error && <p className="ai-msg ai-msg--error">{b.player.error}</p>}
                    </>
                  )}
                </div>
              )}
            </div>

            {active.pose.status === "running" && (
              <div className="az-progress" role="status">
                <span>Reading the movement · {Math.round(active.pose.progress * 100)}%</span>
                <div className="az-progress__bar">
                  <div style={{ width: `${active.pose.progress * 100}%` }} />
                </div>
              </div>
            )}
            {active.player.meta && <Timeline session={active} markers={markers} />}
          </section>

          <aside className="az-side" aria-label="Tools">
            <Segmented
              className="az-side__tabs"
              label="Panel"
              value={side}
              onChange={setSide}
              options={[
                { value: "ai", label: "AI coach" },
                { value: "draw", label: "Draw" },
                { value: "motion", label: "Motion" },
                { value: "view", label: "View" },
              ]}
            />
            <div className="az-side__body panel">
              {side === "ai" && <AiPanel session={active} filter={filterCss(view)} onOpenSettings={onOpenSettings} />}
              {side === "draw" && <DrawPanel session={active} tool={tool} setTool={setTool} selectedId={selectedId} setSelectedId={setSelectedId} />}
              {side === "motion" && <MotionPanel session={active} view={view} setView={setView} series={series} setSeries={setSeries} />}
              {side === "view" && <ViewPanel view={view} setView={setView} onSnapshot={() => void snapshot()} snapshotBusy={snapBusy} />}
            </div>
          </aside>
        </main>
      )}
    </div>
  );
}
