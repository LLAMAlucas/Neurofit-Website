/**
 * The viewfinder's frame, on every stop: the brand and the way out to the app
 * at the top, the lens boot readout at the bottom. Mono, igloo's
 * HUD language — and every control in it is a real link or button.
 *
 * `live` is false for the still page (reduced motion, no WebGL): no scene to
 * load — just the brand and the way out.
 */
import { useEffect, useRef } from "react";

import { store } from "@/stage/store";
import { onTick } from "@/hooks/ticker";
import { installGlassPointer, refract } from "@/lib/liquidGlass";

const TRY_URL = "https://try.neurofit-training.com";

export function Hud({ live }: { live: boolean }) {
  const boot = useRef<HTMLDivElement>(null);
  const tryIt = useRef<HTMLAnchorElement>(null);

  // Liquid glass: the highlight follows the pointer everywhere on the page, and the
  // button's rim bends the scene behind it (Chromium; elsewhere it stays frosted).
  useEffect(() => installGlassPointer(), []);
  useEffect(() => (tryIt.current ? refract(tryIt.current, { blur: 5, saturate: 1.8, strength: 1.1 }) : undefined), []);

  useEffect(() => {
    if (!live) return;
    const off = onTick(() => {
      if (boot.current && store.ready) boot.current.classList.add("is-done");
    });
    return off;
  }, [live]);

  return (
    <div className="hud">
      <a className="hud__brand" href="#top" aria-label="Neuro-Fit, back to the top">
        <span className="hud__mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <circle cx="12" cy="4.4" r="2.2" fill="currentColor" stroke="none" />
            <path d="M12 7v6.2M12 13.2 8.2 18.8M12 13.2l3.8 5.6M7.6 9.6h8.8" />
          </svg>
        </span>
        Neuro-Fit
      </a>

      {/* A separate origin (its own deployment off the same repo), so the
          camera permission the app asks for is scoped to it alone and never to
          this page. */}
      <a className="lg-btn hud__try" href={TRY_URL} ref={tryIt}>
        Try it out
      </a>

      {live && (
        <div className="hud__boot" ref={boot} aria-hidden="true">
          <span>Lens init</span>
        </div>
      )}
    </div>
  );
}
