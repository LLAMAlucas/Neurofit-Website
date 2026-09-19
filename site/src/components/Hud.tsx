/**
 * The viewfinder's frame, on every stop: the brand and the way out to the app
 * at the top, where-am-I and the sound at the bottom. Mono, bracketed, igloo's
 * HUD language — and every control in it is a real link or button.
 *
 * `live` is false for the still page (reduced motion, no WebGL): no stop index
 * to follow, no scene to load, no sound — just the brand and the way out.
 */
import { useEffect, useRef, useState } from "react";

import { STOPS } from "@/lib/story";
import { store } from "@/stage/store";
import { onTick } from "@/hooks/ticker";
import { Scrambler } from "@/hooks/scramble";
import type { Sfx } from "@/audio/sfx";

const TRY_URL = "https://try.neurofit-training.com";

export function Hud({ live, sfx }: { live: boolean; sfx?: Sfx }) {
  const index = useRef<HTMLSpanElement>(null);
  const boot = useRef<HTMLDivElement>(null);
  const [sound, setSound] = useState(false);

  useEffect(() => {
    if (!live) return;
    const label = index.current ? new Scrambler(index.current) : null;
    const off = onTick((now) => {
      const i = STOPS.findIndex((s) => s.id === document.body.dataset.stop);
      const at = Math.max(0, i);
      label?.set(`${String(at + 1).padStart(2, "0")} / ${String(STOPS.length).padStart(2, "0")}  ${STOPS[at].label}`, now);
      if (boot.current && store.ready) boot.current.classList.add("is-done");
    });
    return off;
  }, [live]);

  const toggle = () => {
    if (!sfx) return;
    if (sfx.on) sfx.disable();
    else sfx.enable();
    setSound(sfx.on);
  };

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
      <a className="bracket hud__try" href={TRY_URL}>
        Try it out
      </a>

      {live && (
        <>
          <div className="hud__index" aria-hidden="true">
            <span ref={index}>01 / 06  FORM</span>
          </div>
          <button type="button" className="hud__sound" aria-pressed={sound} onClick={toggle}>
            Sound: {sound ? "On" : "Off"}
          </button>
          <div className="hud__boot" ref={boot} aria-hidden="true">
            <span>Lens init</span>
          </div>
        </>
      )}
    </div>
  );
}
