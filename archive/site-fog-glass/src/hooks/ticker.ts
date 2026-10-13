/**
 * One animation-frame loop for everything on the page that follows the scene:
 * the scroll, the text's focus, the HUD's readouts and the labels pinned to
 * things in 3D. Each writes straight to the DOM from here — sixty React renders
 * a second to move a label would cost more than the particles do.
 */
type Tick = (now: number, dt: number) => void;

/** DEV `?manual`: no animation-frame loop — frames run only when a test steps
 *  them (`runTicks`, via `__siteStep`). A browser in a hidden window gives
 *  a page about one animation frame a second, too few to test motion by. */
export const MANUAL = import.meta.env.DEV && new URLSearchParams(location.search).has("manual");

const ticks = new Set<Tick>();
let raf = 0;
let last = 0;

function frame(now: number) {
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
  last = now;
  for (const t of ticks) t(now, dt);
  raf = ticks.size ? requestAnimationFrame(frame) : 0;
}

/** Run every tick once, at `now` ms. For manual stepping only. */
export function runTicks(now: number) {
  const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
  last = now;
  for (const t of ticks) t(now, dt);
}

/** Run `t` every frame until the returned function is called. */
export function onTick(t: Tick): () => void {
  ticks.add(t);
  if (!raf && !MANUAL) {
    last = 0;
    raf = requestAnimationFrame(frame);
  }
  return () => {
    ticks.delete(t);
  };
}
