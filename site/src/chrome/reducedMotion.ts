/**
 * Whether the reader asked the system for less motion — live, so flipping the setting mid-visit
 * takes effect without a reload.
 *
 * ⚠️ Mirrored byte-for-byte at src/neurofit/chrome/ and site/src/chrome/ (npm run check:mirror).
 */
import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

export function prefersReducedMotion(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia(QUERY).matches;
}

export function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mq = matchMedia(QUERY);
    const on = () => setReduce(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduce;
}
