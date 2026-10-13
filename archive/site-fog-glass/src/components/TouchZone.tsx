/**
 * How the reader touches the body. The canvas sits behind the page's text, so it
 * can't listen for itself; this writes the pointer into the store instead.
 *
 *  - A mouse throws particles just by moving over the body (hover, not drag),
 *    anywhere on the page.
 *  - A finger throws particles ONLY inside the invisible glass box around the
 *    body — this zone, sized to the box's projection every frame. Everywhere
 *    else a drag scrolls the page as usual (`touch-action: none` is on this
 *    element alone).
 *
 * That is the whole of it: the camera is the scroll's, and nothing on the page
 * turns it.
 */
import { useEffect, useRef, type PointerEvent } from "react";

import { store } from "@/stage/store";
import { onTick } from "@/hooks/ticker";

function setPointer(clientX: number, clientY: number) {
  store.pointer.x = (clientX / window.innerWidth) * 2 - 1;
  store.pointer.y = 1 - (clientY / window.innerHeight) * 2;
}

export function TouchZone({ onSwipe }: { onSwipe?: (speed: number) => void }) {
  const zone = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);

  useEffect(() => {
    // Mouse: hover anywhere feeds the stroke.
    let lastX = 0;
    let lastY = 0;
    let lastT = 0;
    const onMove = (e: globalThis.PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      setPointer(e.clientX, e.clientY);
      store.pointerInside = true;
      if (onSwipe) {
        const dt = (e.timeStamp - lastT) / 1000;
        if (dt > 0 && dt < 0.1) {
          const b = store.box;
          const over = e.clientX >= b.x && e.clientX <= b.x + b.w && e.clientY >= b.y && e.clientY <= b.y + b.h;
          if (over) onSwipe(Math.hypot(e.clientX - lastX, e.clientY - lastY) / window.innerHeight / dt);
        }
      }
      lastX = e.clientX;
      lastY = e.clientY;
      lastT = e.timeStamp;
    };
    const onLeave = () => (store.pointerInside = false);
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("mouseleave", onLeave);

    // The zone follows the glass box on screen.
    const off = onTick(() => {
      const el = zone.current;
      if (!el) return;
      const b = store.box;
      el.style.transform = `translate(${b.x}px, ${b.y}px)`;
      el.style.width = `${b.w}px`;
      el.style.height = `${b.h}px`;
    });
    return () => {
      off();
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
    };
  }, [onSwipe]);

  // A finger on the body is a swipe through it. (A mouse needs no zone: it
  // throws by hovering, above.)
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse") return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    setPointer(e.clientX, e.clientY);
    store.pointerInside = true;
    zone.current?.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    setPointer(e.clientX, e.clientY);
    const speed = Math.hypot(e.clientX - d.x, e.clientY - d.y) / window.innerHeight / (1 / 60);
    onSwipe?.(speed);
    d.x = e.clientX;
    d.y = e.clientY;
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.id !== e.pointerId) return;
    drag.current = null;
    store.pointerInside = false;
    zone.current?.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      ref={zone}
      className="touchzone"
      aria-hidden="true"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    />
  );
}
