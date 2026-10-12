/**
 * A small copy of the scene for the menu's ASCII panel. The WebGL canvas's picture is only
 * readable in the same frame it was drawn (no preserveDrawingBuffer — that would cost every
 * frame), so the stage copies it right after the composer renders (stage/AsciiTap, useFrame
 * priority 2), a few times a second while the menu is open; the menu reads this copy whenever.
 *
 * No three.js in here: the HUD imports it, and the HUD must not pull the stage's chunk.
 */
const W = 256;
const H = 144;

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let filled = false;

/** Copy the scene's canvas into the tap (called from inside the render frame). */
export function tapFrom(src: HTMLCanvasElement): void {
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    ctx = canvas.getContext("2d");
  }
  if (!ctx) return;
  ctx.drawImage(src, 0, 0, W, H);
  filled = true;
}

/** The latest copy, or null before the first one. */
export function tapCanvas(): HTMLCanvasElement | null {
  return filled ? canvas : null;
}
