/**
 * Copies the rendered frame for the menu's ASCII panel (stage/asciiTapStore) — after the effect
 * composer (priority 1), so the frame is still in the drawing buffer; ~10 times a second and
 * only while the menu is open.
 */
import { useRef } from "react";
import { useFrame } from "@react-three/fiber";

import { store } from "./store";
import { tapFrom } from "./asciiTapStore";

const EVERY_S = 0.1;

export function AsciiTap() {
  const since = useRef(EVERY_S);
  useFrame((state, dt) => {
    if (!store.menuOpen) {
      since.current = EVERY_S;
      return;
    }
    since.current += dt;
    if (since.current < EVERY_S) return;
    since.current = 0;
    tapFrom(state.gl.domElement);
  }, 2);
  return null;
}
