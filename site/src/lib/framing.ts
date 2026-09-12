/**
 * Aiming a full-viewport canvas at a sub-rectangle of itself.
 *
 * PURE. The rig's canvas is always the whole viewport and never resized (see
 * SquatRig), while the VISIBLE frame starts as the hero lens box and opens out
 * to full screen. A camera that frames the canvas therefore draws the figure in
 * the middle of the screen while the clip is showing a box off to one side —
 * i.e. exactly where the clip discards it.
 */
export type Rect = { x: number; y: number; w: number; h: number };

export type Framing = {
  /** Multiply the camera's distance by this. */
  distanceScale: number;
  /** Add these to the projected NDC (equivalently: an off-axis frustum). */
  shiftX: number;
  shiftY: number;
};

/**
 * Fit is driven by HEIGHT alone. The subject is a standing figure and the frame
 * travels from portrait (3:4) to landscape, so a width fit would swing through
 * the expansion while a height fit is continuous — and `distanceScale` decays to
 * exactly 1 as the clip reaches full screen, so this converges on the plain
 * full-viewport camera rather than having to hand over to it.
 *
 * A degenerate clip (zero before the first measurement) falls back to the whole
 * canvas, which is the identity framing.
 */
export function frameToClip(clip: Rect, canvasW: number, canvasH: number): Framing {
  const w = clip.w > 1 ? clip.w : canvasW;
  const h = clip.h > 1 ? clip.h : canvasH;
  const x = clip.w > 1 ? clip.x : 0;
  const y = clip.h > 1 ? clip.y : 0;
  return {
    distanceScale: canvasH / h,
    shiftX: ((x + w / 2) / canvasW) * 2 - 1,
    shiftY: -(((y + h / 2) / canvasH) * 2 - 1),
  };
}
