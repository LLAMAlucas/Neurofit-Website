/**
 * Lab 01 — the particle-body look test.
 *
 * A dev-only page (site/lab/index.html, served at /lab/ by `npm run dev`). Vite's
 * production build only takes the root index.html, so nothing here — including
 * the two body models — ever ships. It exists to judge one thing before the
 * real site is built around it: whether a human body made of particles, with
 * faults glowing red, looks good.
 */
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Canvas, advance } from "@react-three/fiber";

import { EagerResizeObserver } from "@/stage/eagerResizeObserver";
import { LabHud } from "./LabHud";
import { LabScene } from "./LabScene";
import { DEFAULTS, store } from "@/stage/store";
import { createTuningPanel, rebuildOf, type Rebuild } from "@/stage/tuningPanel";

/** `?manual`: frames only advance when asked, through `__labStep(frames, dt)`.
 *  A browser in a hidden window throttles requestAnimationFrame to about once a
 *  second, so an automated look at motion has to step the clock itself. */
const MANUAL = import.meta.env.DEV && new URLSearchParams(location.search).has("manual");

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function Lab() {
  const [rebuild, setRebuild] = useState<Rebuild>(() => rebuildOf(DEFAULTS));
  // Hidden until asked for: `?tune`, or P.
  useEffect(() => createTuningPanel(setRebuild), []);

  // Arrow keys step the orbit 15° — the tracker's view tolerance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if ((e.target as HTMLElement | null)?.closest?.(".lil-gui")) return;
      e.preventDefault();
      store.azimuth += (e.key === "ArrowLeft" ? -15 : 15) * DEG;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const gl = useRef<WebGLRenderingContext | null>(null);
  useEffect(() => {
    if (!MANUAL) return;
    let t = 0;
    (window as unknown as { __labStep: unknown }).__labStep = (frames = 1, dt = 1 / 60) => {
      for (let i = 0; i < frames; i++) {
        advance((t += dt), true);
        // Flushed frame by frame: without it a batch of frames went to the GPU
        // as one command list long enough to trip the driver's timeout, and
        // Chrome blocked WebGL on the page after the resets.
        gl.current?.flush();
      }
      return t;
    };
  }, []);

  const stage = useRef<HTMLDivElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button, .lil-gui")) return;
    last.current = { x: e.clientX, y: e.clientY };
    store.dragging = true;
    stage.current?.setPointerCapture(e.pointerId);
    stage.current?.classList.add("is-dragging");
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    store.pointerInside = true;
    const r = e.currentTarget.getBoundingClientRect();
    store.pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    store.pointer.y = 1 - ((e.clientY - r.top) / r.height) * 2;
    if (!last.current) return;
    store.azimuth -= (e.clientX - last.current.x) * 0.007;
    store.elevation = clamp(store.elevation + (e.clientY - last.current.y) * 0.004, -0.04, 0.55);
    last.current = { x: e.clientX, y: e.clientY };
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!last.current) return;
    last.current = null;
    store.dragging = false;
    stage.current?.releasePointerCapture(e.pointerId);
    stage.current?.classList.remove("is-dragging");
  };

  return (
    <div
      className="lab"
      ref={stage}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => (store.pointerInside = false)}
    >
      <Canvas
        frameloop={MANUAL ? "never" : "always"}
        flat
        dpr={[1, 1.5]}
        gl={{ antialias: false, powerPreference: "high-performance" }}
        camera={{ fov: 30, near: 0.1, far: 200, position: [0, 1.2, 4.3] }}
        resize={{ polyfill: EagerResizeObserver }}
        onCreated={(s) => (gl.current = s.gl.getContext())}
      >
        <LabScene {...rebuild} />
      </Canvas>
      <LabHud />
    </div>
  );
}
