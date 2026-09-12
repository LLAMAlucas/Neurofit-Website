import { useEffect } from "react";

/**
 * Document-level motion ported from the original site.js.
 *
 * These deliberately query the DOM rather than threading refs through every
 * section. The reveal system is driven by site.css selectors (`.reveal.is-in`,
 * `.is-lit .rule`), and re-expressing it as per-component state would mean
 * rewriting those rules — the exact churn most likely to silently regress the
 * staggered timing and the reduced-motion behaviour.
 *
 * All of it is opt-out: reduced motion short-circuits every branch.
 */

/** Masthead gets `is-stuck` past 12px, which drives the scroll-edge material fade. */
export function useStickyMasthead() {
  useEffect(() => {
    const head = document.getElementById("masthead");
    if (!head) return;

    let stuck = false;
    const onScroll = () => {
      const next = window.scrollY > 12;
      if (next !== stuck) {
        stuck = next;
        head.classList.toggle("is-stuck", stuck);
      }
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
}

/** Reveal-on-scroll. Under reduced motion (or without IO support) everything is
 *  revealed immediately rather than left hidden. */
export function useScrollReveal(reduced: boolean) {
  useEffect(() => {
    const targets = document.querySelectorAll<HTMLElement>(".reveal, .sec");

    if (reduced || !("IntersectionObserver" in window)) {
      targets.forEach((el) => el.classList.add("is-in", "is-lit"));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          e.target.classList.add("is-in", "is-lit");
          io.unobserve(e.target);
        });
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
    );

    targets.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [reduced]);
}

/** Hero rep counter: ticks 0→3 once, timed to land after the lens has "acquired"
 *  the figure so it reads as a consequence of tracking rather than decoration. */
export function useRepCounter(reduced: boolean) {
  useEffect(() => {
    const counter = document.querySelector<HTMLElement>("[data-count]");
    if (!counter) return;

    const target = parseInt(counter.getAttribute("data-count") ?? "0", 10) || 0;

    if (reduced) {
      counter.textContent = String(target);
      return;
    }

    let n = 0;
    let timer: number;
    const tick = () => {
      n += 1;
      counter.textContent = String(n);
      if (n < target) timer = window.setTimeout(tick, 440);
    };
    timer = window.setTimeout(tick, 1900);

    return () => window.clearTimeout(timer);
  }, [reduced]);
}

/**
 * Hero lens parallax. Decorative, so it runs only on a real pointer and never
 * under reduced motion. Values are smoothed toward their target each frame —
 * untweened mouse tracking reads as artificial because it carries no momentum.
 * The loop idles itself once settled and while the hero is off screen.
 */
export function useLensParallax(reduced: boolean) {
  useEffect(() => {
    const lens = document.querySelector<HTMLElement>(".hero__lens");
    if (!lens || reduced) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

    let tRx = 0,
      tRy = 0,
      tDy = 0;
    let rx = 0,
      ry = 0,
      dy = 0;
    let running = false;
    let onScreen = true;
    let raf = 0;

    const frame = () => {
      // exponential smoothing ≈ critically damped: approaches, never overshoots
      rx += (tRx - rx) * 0.085;
      ry += (tRy - ry) * 0.085;
      dy += (tDy - dy) * 0.085;

      lens.style.setProperty("--rx", `${rx.toFixed(3)}deg`);
      lens.style.setProperty("--ry", `${ry.toFixed(3)}deg`);
      lens.style.setProperty("--dy", `${dy.toFixed(2)}px`);

      const settled =
        Math.abs(tRx - rx) < 0.01 && Math.abs(tRy - ry) < 0.01 && Math.abs(tDy - dy) < 0.05;
      if (settled || !onScreen) {
        running = false;
        return;
      }
      raf = requestAnimationFrame(frame);
    };

    const kick = () => {
      if (running || !onScreen) return;
      running = true;
      raf = requestAnimationFrame(frame);
    };

    const onPointerMove = (e: PointerEvent) => {
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      tRy = ((e.clientX - cx) / cx) * 4.5;
      tRx = -((e.clientY - cy) / cy) * 3.5;
      kick();
    };

    const onScroll = () => {
      tDy = Math.max(-26, window.scrollY * -0.045);
      kick();
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });

    let io: IntersectionObserver | undefined;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(
        (es) => {
          onScreen = es[0].isIntersecting;
          if (onScreen) kick();
        },
        { threshold: 0 },
      );
      io.observe(lens);
    }

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("scroll", onScroll);
      io?.disconnect();
      cancelAnimationFrame(raf);
      lens.style.removeProperty("--rx");
      lens.style.removeProperty("--ry");
      lens.style.removeProperty("--dy");
    };
  }, [reduced]);
}
