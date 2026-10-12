/**
 * The scrubber under the clip: drag to scrub, the in/out range, found reps as bands, and markers
 * for bookmarks, AI issues (by severity) and frames you asked the AI about — tap one to jump.
 * Under it, the transport: frame stepping, play, speed, in/out marks, bookmark.
 */
import { useRef } from "react";
import type { ClipSession } from "../../hooks/useClipSession";
import { RATES } from "../../hooks/useClip";
import { Segmented } from "../Segmented";

export function fmtTime(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(2)}`;
}

export interface Marker {
  tMs: number;
  kind: "high" | "medium" | "low" | "frame" | "bookmark";
  label: string;
}

export function Timeline({ session, markers }: { session: ClipSession; markers: Marker[] }) {
  const { player, range, finding, rec } = session;
  const meta = player.meta;
  const bar = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);
  if (!meta) return null;
  const dur = meta.durationMs || 1;
  const pct = (ms: number) => `${(Math.max(0, Math.min(dur, ms)) / dur) * 100}%`;

  const seekFromEvent = (clientX: number) => {
    const r = bar.current?.getBoundingClientRect();
    if (!r) return;
    player.seek(((clientX - r.left) / r.width) * dur);
  };

  const hasRange = rec.record.inMs !== null || rec.record.outMs !== null;
  return (
    <div className="az-timeline">
      <div
        ref={bar}
        className="az-timeline__bar"
        role="slider"
        aria-label="Clip position"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(player.tMs)}
        aria-valuetext={fmtTime(player.tMs)}
        tabIndex={0}
        onPointerDown={(e) => {
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          scrubbing.current = true;
          player.pause();
          seekFromEvent(e.clientX);
        }}
        onPointerMove={(e) => scrubbing.current && seekFromEvent(e.clientX)}
        onPointerUp={() => (scrubbing.current = false)}
        onPointerCancel={() => (scrubbing.current = false)}
      >
        {hasRange && <div className="az-timeline__range" style={{ left: pct(range.inMs), width: `${((range.outMs - range.inMs) / dur) * 100}%` }} />}
        {finding?.reps.map((r) => (
          <div key={r.index} className="az-timeline__rep" style={{ left: pct(r.startMs), width: `${((r.endMs - r.startMs) / dur) * 100}%` }} title={`Rep ${r.index}`}>
            <span>{r.index}</span>
          </div>
        ))}
        {session.pose.status === "running" && <div className="az-timeline__pass" style={{ width: `${session.pose.progress * 100}%` }} />}
        <div className="az-timeline__head" style={{ left: pct(player.tMs) }} />
      </div>
      <div className="az-timeline__markers">
        {markers.map((m, i) => (
          <button
            key={`${m.kind}-${m.tMs}-${i}`}
            type="button"
            className={`az-marker az-marker--${m.kind}`}
            style={{ left: pct(m.tMs) }}
            onClick={() => {
              player.pause();
              player.seek(m.tMs);
            }}
            title={`${m.label} · ${fmtTime(m.tMs)}`}
            aria-label={`${m.label} at ${fmtTime(m.tMs)}`}
          />
        ))}
      </div>

      <div className="az-transport">
        <div className="az-transport__time">
          <span className="az-transport__clock">{fmtTime(player.tMs)}</span>
          <span className="az-transport__frame">
            frame {player.frameIndex + 1} · {player.fpsKnown ? `${player.fps} fps` : "fps ~30"}
          </span>
        </div>
        <div className="az-transport__keys" role="group" aria-label="Playback">
          <button type="button" className="btn btn--icon az-key" onClick={() => player.seek(range.inMs)} title="Go to start (Home)" aria-label="Go to start">
            <Icon d="M6 5v14M18 6l-9 6 9 6z" />
          </button>
          <button type="button" className="btn btn--icon az-key" onClick={() => player.step(-10)} title="Back 10 frames (Shift + ←)" aria-label="Back 10 frames">
            <Icon d="M11 6 3 12l8 6zM21 6l-8 6 8 6z" />
          </button>
          <button type="button" className="btn btn--icon az-key" onClick={() => player.step(-1)} title="Back 1 frame (←)" aria-label="Back 1 frame">
            <Icon d="M15 6l-8 6 8 6z" />
          </button>
          <button type="button" className="btn btn--icon btn--primary az-key az-key--play" onClick={player.toggle} title="Play / pause (Space)" aria-label={player.playing ? "Pause" : "Play"}>
            {player.playing ? <Icon d="M8 5h3v14H8zM13 5h3v14h-3z" fill /> : <Icon d="M8 5l11 7-11 7z" fill />}
          </button>
          <button type="button" className="btn btn--icon az-key" onClick={() => player.step(1)} title="Forward 1 frame (→)" aria-label="Forward 1 frame">
            <Icon d="M9 6l8 6-8 6z" />
          </button>
          <button type="button" className="btn btn--icon az-key" onClick={() => player.step(10)} title="Forward 10 frames (Shift + →)" aria-label="Forward 10 frames">
            <Icon d="M3 6l8 6-8 6zM13 6l8 6-8 6z" />
          </button>
          <button type="button" className="btn btn--icon az-key" onClick={() => player.seek(range.outMs - 1)} title="Go to end (End)" aria-label="Go to end">
            <Icon d="M18 5v14M6 6l9 6-9 6z" />
          </button>
        </div>
        <Segmented
          className="az-speed"
          label="Playback speed"
          value={String(player.rate)}
          onChange={(v) => player.setRate(Number(v))}
          options={RATES.map((r) => ({ value: String(r), label: `${r}×` }))}
        />
        <div className="az-transport__marks">
          <button type="button" className="btn btn--sm" onClick={() => rec.edit((r) => ({ ...r, inMs: Math.min(player.tMs, (r.outMs ?? dur) - 50) }))} title="Set the start of the part to analyse ([)">
            Set in
          </button>
          <button type="button" className="btn btn--sm" onClick={() => rec.edit((r) => ({ ...r, outMs: Math.max(player.tMs, (r.inMs ?? 0) + 50) }))} title="Set the end of the part to analyse (])">
            Set out
          </button>
          {hasRange && (
            <button type="button" className="btn btn--sm" onClick={() => rec.edit((r) => ({ ...r, inMs: null, outMs: null }))} title="Use the whole clip">
              Clear
            </button>
          )}
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => rec.edit((r) => ({ ...r, bookmarks: [...r.bookmarks, { tMs: player.tMs, label: `Mark ${r.bookmarks.length + 1}` }].sort((a, b) => a.tMs - b.tMs) }))}
            title="Bookmark this frame (B)"
          >
            Bookmark
          </button>
        </div>
      </div>
    </div>
  );
}

export function Icon({ d, fill = false }: { d: string; fill?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill={fill ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
