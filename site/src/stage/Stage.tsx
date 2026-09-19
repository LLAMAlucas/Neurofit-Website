/**
 * The one canvas on the page: fixed, full-screen, behind all of the text.
 *
 * Lazy-loaded — three.js and everything under it arrive in this chunk, so a
 * reader under reduced motion or without WebGL never downloads any of it. It
 * takes no pointer events of its own: the page listens and writes the pointer
 * into the store (see components/TouchZone), because the text sits on top of it.
 */
import { useEffect, useRef } from "react";
import { Canvas, advance } from "@react-three/fiber";

import GLBoundary from "@/components/GLBoundary";
import type { Tier } from "@/lib/quality";
import { EagerResizeObserver } from "./eagerResizeObserver";
import StageScene from "./StageScene";
import { MANUAL, runTicks } from "@/hooks/ticker";

export default function Stage({ tier, onFail, onSlow }: { tier: Tier; onFail: () => void; onSlow: () => void }) {
  // DEV `?manual`: `__siteStep(frames, dt)` advances the page and the scene
  // together, a frame at a time, flushing the GPU after each so a batch never
  // goes to the driver as one command list long enough to be reset.
  const gl = useRef<WebGLRenderingContext | null>(null);
  useEffect(() => {
    if (!MANUAL) return;
    let t = 0;
    (window as unknown as { __siteStep: unknown }).__siteStep = (frames = 1, dt = 1 / 60) => {
      for (let i = 0; i < frames; i++) {
        t += dt;
        runTicks(t * 1000);
        advance(t, true);
        gl.current?.flush();
      }
      return t;
    };
  }, []);

  return (
    <GLBoundary onFail={onFail}>
      <div className="stage" aria-hidden="true">
        <Canvas
          frameloop={MANUAL ? "never" : "always"}
          flat
          dpr={[1, tier.dpr]}
          gl={{ antialias: false, powerPreference: "high-performance" }}
          camera={{ fov: 30, near: 0.1, far: 200, position: [0, 1.2, 4.3] }}
          resize={{ polyfill: EagerResizeObserver }}
          onCreated={({ gl: renderer }) => {
            gl.current = renderer.getContext();
            // A context lost after the fact — a driver reset, a GPU given to
            // another tab — would leave a dead canvas behind the text. The
            // page goes back to its still version instead.
            renderer.domElement.addEventListener("webglcontextlost", onFail, { once: true });
          }}
        >
          <StageScene tier={tier} onSlow={onSlow} />
        </Canvas>
      </div>
    </GLBoundary>
  );
}
