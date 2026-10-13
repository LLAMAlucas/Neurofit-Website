/**
 * The menu's way through the page. useJourney registers its Lenis here; the menu asks for a stop.
 *
 * A neighbouring stop is a short smooth scroll. Anything further goes through the iris: it closes,
 * the page cuts to the stop behind the blades, and it opens there — so a jump never flies the
 * camera past every stop in between (their red flashes, exposure flashes and sounds). Optical
 * only, like every other transition on the page.
 *
 * Each jump lands at the START of the stop's hold (lib/story stopTarget), not the top of its
 * section: the section starts in the middle of the move in, where the words are still blurred.
 *
 * On the still page (reduced motion, no WebGL) there's no Lenis: a plain scrollIntoView.
 */
import type Lenis from "lenis";

import { STOPS, stopTarget } from "@/lib/story";
import { store } from "@/stage/store";

let lenis: Lenis | null = null;
let screen = () => window.innerHeight;
let jumping = false;

const CLOSE_MS = 340;
const HOLD_MS = 90;
const OPEN_MS = 420;

export function registerScroll(l: Lenis, vh: () => number): () => void {
  lenis = l;
  screen = vh;
  if (import.meta.env.DEV) {
    const w = window as unknown as { __siteGo?: (id: string) => void; __siteStore?: typeof store };
    w.__siteGo = (id) => scrollToStop(STOPS.findIndex((s) => s.id === id));
    w.__siteStore = store; // the app's own instance — a re-import from the console can be a copy
  }
  return () => {
    if (lenis === l) lenis = null;
  };
}

/** While the menu or a sheet is open the page underneath holds still. */
export function pauseScroll(): void {
  lenis?.stop();
}
export function resumeScroll(): void {
  lenis?.start();
}

function animate(ms: number, step: (t: number) => void): Promise<void> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      step(t);
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}
const ease = (t: number) => t * t * (3 - 2 * t);

export function scrollToStop(i: number): void {
  const stop = STOPS[i];
  if (!stop) return;
  if (!lenis) {
    document.getElementById(i === 0 ? "top" : stop.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (jumping) return;
  const vh = screen();
  const px = Math.ceil(stopTarget(i) * vh) + 1;
  const here = STOPS.findIndex((s) => s.id === document.body.dataset.stop);
  const l = lenis;
  if (here >= 0 && Math.abs(here - i) <= 1) {
    l.scrollTo(px, { duration: 1.1, lock: true, force: true });
    return;
  }
  jumping = true;
  void (async () => {
    await animate(CLOSE_MS, (t) => (store.jumpIris = ease(t)));
    l.scrollTo(px, { immediate: true, force: true });
    await animate(HOLD_MS, () => (store.jumpIris = 1));
    await animate(OPEN_MS, (t) => (store.jumpIris = 1 - ease(t)));
    store.jumpIris = 0;
    jumping = false;
  })();
}
