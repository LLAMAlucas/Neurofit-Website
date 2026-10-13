/**
 * The scroll: inertial, feeding the scene and racking each stop's text in and
 * out of focus. The reader's scroll is theirs — the page never moves itself to
 * a stop (it used to ease into the nearer one after 180 ms of stillness; the
 * user had that removed, 2026-09-25).
 *
 * Off under reduced motion and without WebGL: those readers get the page as
 * plain, still, normal-flow sections, and the browser's own scroll.
 */
import { useEffect } from "react";
import Lenis from "lenis";

import { STOPS, STOP_COUNT, newSample, storyAt } from "@/lib/story";
import { store } from "@/stage/store";
import { onTick } from "./ticker";

export function useJourney(live: boolean) {
  useEffect(() => {
    if (!live) return;
    const root = document.documentElement;

    // One screen of scroll, in px. Held steady through a phone's toolbar
    // showing and hiding (a height-only change under ~160 px), or every stop
    // would jump as the reader scrolled.
    let vh = window.innerHeight;
    let width = window.innerWidth;
    root.style.setProperty("--vh", `${vh}px`);
    const onResize = () => {
      if (window.innerWidth !== width || Math.abs(window.innerHeight - vh) > 160) {
        width = window.innerWidth;
        vh = window.innerHeight;
        root.style.setProperty("--vh", `${vh}px`);
      }
    };
    window.addEventListener("resize", onResize);

    const lenis = new Lenis({ autoRaf: false, lerp: 0.1, smoothWheel: true });

    const sample = newSample();
    // `section`, not just [data-stop]: the page also marks <body> with the stop
    // it is at.
    const sections = Array.from(document.querySelectorAll<HTMLElement>("section[data-stop]"));
    const shown = new Array<number>(STOP_COUNT).fill(-1);
    // Unknown until the first frame, so every stop's controls are set either
    // way on it — a stop never in focus would otherwise never be made inert.
    const wasLive = new Array<boolean | null>(STOP_COUNT).fill(null);

    const off = onTick((now) => {
      lenis.raf(now);
      const p = window.scrollY / vh;
      store.progress = p;

      storyAt(p, sample);
      for (let i = 0; i < sections.length; i++) {
        const el = sections[i];
        const f = sample.focus[i];
        if (Math.abs(f - shown[i]) > 0.002 || (f === 0) !== (shown[i] === 0)) {
          shown[i] = f;
          el.style.setProperty("--focus", f.toFixed(3));
          // Fully out of focus: no blur to composite for a layer nobody sees.
          el.toggleAttribute("data-off", f === 0);
        }
        // Fully sharp: drop the focus filter too, so the liquid-glass controls in the
        // stop can see — and bend — the scene behind them (site.css). Outside the
        // change threshold above, which could otherwise stall it at 0.998.
        const sharp = f >= 0.999;
        if (sharp !== el.hasAttribute("data-sharp")) el.toggleAttribute("data-sharp", sharp);
        el.style.setProperty("--local", sample.local[i].toFixed(4));
        // Controls in a stop that is out of focus can't be reached — the text
        // stays readable to a screen reader, but a hidden button can't be
        // tabbed to.
        const isLive = f > 0.5;
        if (isLive !== wasLive[i]) {
          wasLive[i] = isLive;
          el.toggleAttribute("data-live", isLive);
          // [data-live-only]: exists only on the live page. [data-focus-only]:
          // on the still page too, but here only reachable while it can be seen.
          for (const c of el.querySelectorAll<HTMLElement>("[data-live-only], [data-focus-only]")) c.inert = !isLive;
        }
      }
      if (document.body.dataset.stop !== STOPS[sample.stop].id) document.body.dataset.stop = STOPS[sample.stop].id;
    });

    return () => {
      off();
      lenis.destroy();
      window.removeEventListener("resize", onResize);
      delete document.body.dataset.stop;
      root.style.removeProperty("--vh");
    };
  }, [live]);
}
