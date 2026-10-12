/**
 * Paragraphs that brighten as the reader scrolls into their stop, after dragonfly.xyz: every word
 * starts dim, and the stop's lines light one after another, each left to right with a soft edge a
 * few words wide. Scrubbed by the scroll like the rest of the page — scrolling back dims them
 * again — and done by a quarter of the way through the stop's hold, so a menu jump (which lands at
 * the hold's start) finds the words half-lit and a short scroll finishes them. The opening stop
 * also lights by itself once the body has formed, since nobody has scrolled yet.
 *
 * Marked paragraphs: `[data-reveal]`, their words split by sections/Words. Live page only; the
 * still page shows plain text. Coexists with the rack-focus blur (useJourney), which is on the frame.
 */
import { useEffect } from "react";

import { holdAt, stopIndex, type StopId } from "@/lib/story";
import { store } from "@/stage/store";
import { onTick } from "./ticker";

/** Words in the brightening edge. */
const SOFT = 3;
/** Hold fraction (−) before the hold starts, and length, of the reveal. */
const FROM = -0.25;
const SPAN = 0.5;
/** The opening stop: lights over this long, this long after the body's first frame. */
const OPEN_DELAY_MS = 500;
const OPEN_MS = 1800;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

type Group = { stop: number; words: HTMLElement[]; lines: HTMLElement[][]; shown: Float32Array };

export function useLineReveal(live: boolean) {
  useEffect(() => {
    if (!live) return;
    const groups = new Map<number, Group>();
    for (const p of document.querySelectorAll<HTMLElement>("[data-reveal]")) {
      const sec = p.closest<HTMLElement>("section[data-stop]");
      if (!sec) continue;
      const stop = stopIndex(sec.dataset.stop as StopId);
      const g = groups.get(stop) ?? { stop, words: [], lines: [], shown: new Float32Array(0) };
      g.words.push(...p.querySelectorAll<HTMLElement>(".w"));
      groups.set(stop, g);
    }

    // Words into lines, by where they actually wrapped.
    const layout = () => {
      for (const g of groups.values()) {
        g.lines = [];
        let line: HTMLElement[] = [];
        let top = NaN;
        let para: Element | null = null;
        for (const w of g.words) {
          if (line.length && (w.offsetTop !== top || w.parentElement !== para)) {
            g.lines.push(line);
            line = [];
          }
          top = w.offsetTop;
          para = w.parentElement;
          line.push(w);
        }
        if (line.length) g.lines.push(line);
        g.shown = new Float32Array(g.words.length).fill(-1);
      }
    };
    layout();
    window.addEventListener("resize", layout);
    void document.fonts?.ready.then(layout);

    let readyAt = 0;
    const off = onTick((now) => {
      if (store.ready && !readyAt) readyAt = now;
      for (const g of groups.values()) {
        let r = clamp01((holdAt(store.progress, g.stop) - FROM) / SPAN);
        if (g.stop === 0) r = Math.max(r, readyAt ? clamp01((now - readyAt - OPEN_DELAY_MS) / OPEN_MS) : 0);
        const L = g.lines.length;
        let k = 0;
        for (let li = 0; li < L; li++) {
          const line = g.lines[li];
          const lp = clamp01(r * L - li);
          const n = line.length;
          for (let j = 0; j < n; j++, k++) {
            const v = clamp01((lp * (n + SOFT) - j) / SOFT);
            const was = g.shown[k];
            if (Math.abs(v - was) > 0.02 || ((v === 0 || v === 1) && v !== was)) {
              g.shown[k] = v;
              line[j].style.setProperty("--b", v.toFixed(3));
            }
          }
        }
      }
    });
    return () => {
      off();
      window.removeEventListener("resize", layout);
    };
  }, [live]);
}
