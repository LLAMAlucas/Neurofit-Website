/**
 * A small copy of the scene for the menu's ASCII panel. The WebGL canvas's picture is only
 * readable in the same frame it was drawn (no preserveDrawingBuffer — that would cost every
 * frame), so the stage copies it right after the composer renders (stage/AsciiTap, useFrame
 * priority 2), a few times a second while the menu is open; the menu reads this copy whenever.
 *
 * No three.js in here: the HUD imports it, and the HUD must not pull the stage's chunk.
 */
/** The copy's long side, px. Its shape follows the scene's canvas — a fixed 16:9 copy of a
 *  portrait phone squashed the body into a mushroom, since the ASCII fit reads proportions off
 *  the copy. */
const LONG = 256;

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let filled = false;

/** Copy the scene's canvas into the tap (called from inside the render frame). */
export function tapFrom(src: HTMLCanvasElement): void {
  if (!src.width || !src.height) return;
  if (!canvas) {
    canvas = document.createElement("canvas");
    ctx = canvas.getContext("2d");
  }
  if (!ctx) return;
  const k = LONG / Math.max(src.width, src.height);
  const w = Math.max(1, Math.round(src.width * k));
  const h = Math.max(1, Math.round(src.height * k));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.drawImage(src, 0, 0, w, h);
  filled = true;
}

/** The latest copy, or null before the first one. */
export function tapCanvas(): HTMLCanvasElement | null {
  return filled ? canvas : null;
}
