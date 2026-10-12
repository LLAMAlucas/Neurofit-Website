/**
 * A few dim characters blinking in the empty black around the body — dragonfly.xyz's idle twinkle,
 * which keeps a still page breathing at almost no cost. Each fades in and out on its own loop and,
 * while it's dark, moves somewhere new: never over the body's box. Live page only; decorative.
 */
import { useEffect, useRef } from "react";

import { store } from "@/stage/store";

const GLYPHS = Array.from("./:-o0π");
const COUNT = 14;

export function Twinkle() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const place = (s: HTMLElement) => {
      for (let tries = 0; tries < 10; tries++) {
        const x = 16 + Math.random() * (window.innerWidth - 32);
        const y = 90 + Math.random() * (window.innerHeight - 180);
        const b = store.box;
        if (x > b.x - 40 && x < b.x + b.w + 40 && y > b.y - 40 && y < b.y + b.h + 40) continue;
        s.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
        s.textContent = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
        return;
      }
    };
    const spans = Array.from(el.children) as HTMLElement[];
    const offs = spans.map((s, i) => {
      s.style.animationDelay = `${((i * 0.73) % 4).toFixed(2)}s`;
      s.style.animationDuration = `${(2.2 + (i % 5) * 0.55).toFixed(2)}s`;
      place(s);
      const again = () => place(s);
      s.addEventListener("animationiteration", again);
      return () => s.removeEventListener("animationiteration", again);
    });
    return () => offs.forEach((f) => f());
  }, []);
  return (
    <div className="twinkle" ref={root} aria-hidden="true">
      {Array.from({ length: COUNT }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}
