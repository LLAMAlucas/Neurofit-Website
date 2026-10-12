/**
 * A <pre> of characters that redraws itself a few times a second: from a picture source (the
 * site's WebGL body, the tracker's camera) when there is one, else from drifting noise — the
 * loading screens. Text goes straight into the element, never through React state, so a 10 fps
 * field costs one string per tick and no re-renders.
 *
 * ⚠️ Mirrored byte-for-byte at src/neurofit/chrome/ and site/src/chrome/ (npm run check:mirror).
 */
import { useEffect, useRef } from "react";
import { fitGrid, lumaGrid, noiseGrid, shade, toGlyphs } from "./ascii";
import { prefersReducedMotion } from "./reducedMotion";

/** Returns a cols×rows luminance grid (0..1), or null to fall back to noise. `cellAspect` is one
 *  character cell's width ÷ height, so a source can keep the picture's proportions. */
export type AsciiSource = (cols: number, rows: number, cellAspect: number) => Float32Array | null;

/** JetBrains Mono's advance is 600/1000 em; the fallbacks are within a few percent. */
const ADVANCE = 0.6;

export function AsciiField({
  source,
  fps = 10,
  className,
  label,
  relief = 1.5,
}: {
  source?: AsciiSource | null;
  fps?: number;
  className?: string;
  /** Read aloud instead of the characters; without it the field is decorative. */
  label?: string;
  relief?: number;
}) {
  const pre = useRef<HTMLPreElement>(null);
  const src = useRef(source);
  src.current = source;

  useEffect(() => {
    const el = pre.current;
    if (!el) return;
    let cols = 1;
    let rows = 1;
    let aspect = ADVANCE;
    const measure = () => {
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize) || 9;
      const line = parseFloat(cs.lineHeight) || size * 1.1;
      aspect = (size * ADVANCE) / line;
      ({ cols, rows } = fitGrid(el.clientWidth, el.clientHeight, size * ADVANCE, line));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);

    const still = prefersReducedMotion();
    const t0 = performance.now();
    let noise: Float32Array | undefined;
    let last = -Infinity;
    let raf = 0;
    const draw = (now: number) => {
      if (now - last >= 1000 / fps) {
        last = now;
        let grid = src.current ? src.current(cols, rows, aspect) : null;
        if (!grid || grid.length !== cols * rows) {
          noise = noiseGrid(cols, rows, (now - t0) / 1000, 7, noise);
          grid = noise;
        }
        el.textContent = toGlyphs(shade(grid, cols, rows, { relief }), cols, rows);
      }
      if (!still) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [fps, relief]);

  return (
    <pre
      ref={pre}
      className={"ascii" + (className ? " " + className : "")}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

type Img = HTMLVideoElement | HTMLCanvasElement | HTMLImageElement;

function sizeOf(img: Img): [number, number] {
  if (img instanceof HTMLVideoElement) return [img.videoWidth, img.videoHeight];
  if (img instanceof HTMLImageElement) return [img.naturalWidth, img.naturalHeight];
  return [img.width, img.height];
}

/**
 * An AsciiSource that samples a video / canvas / image: cropped to `crop` (fractions of the
 * picture) if given, then cover-fitted to the field's shape, optionally mirrored (a selfie camera).
 * Sampling happens at 2 px per cell into a small canvas made once.
 */
export function canvasSource(
  get: () => Img | null,
  opts: { mirror?: boolean; crop?: () => { x: number; y: number; w: number; h: number } | null; gain?: number } = {},
): AsciiSource {
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let grid: Float32Array | undefined;
  return (cols, rows, cellAspect) => {
    const img = get();
    if (!img) return null;
    const [iw, ih] = sizeOf(img);
    if (!iw || !ih) return null;
    const w = cols * 2;
    const h = rows * 2;
    if (!canvas) {
      canvas = document.createElement("canvas");
      ctx = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!ctx) return null;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const c = opts.crop?.() ?? { x: 0, y: 0, w: 1, h: 1 };
    let sx = c.x * iw;
    let sy = c.y * ih;
    let sw = c.w * iw;
    let sh = c.h * ih;
    // Cover: the field is (cols·cellAspect) : rows in picture terms.
    const want = (cols * cellAspect) / rows;
    if (sw / sh > want) {
      const nw = sh * want;
      sx += (sw - nw) / 2;
      sw = nw;
    } else {
      const nh = sw / want;
      sy += (sh - nh) / 2;
      sh = nh;
    }
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    if (opts.mirror) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    try {
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    } catch {
      ctx.restore();
      return null;
    }
    ctx.restore();
    const data = ctx.getImageData(0, 0, w, h).data;
    grid = lumaGrid(data, w, h, cols, rows, grid);
    const gain = opts.gain ?? 1;
    if (gain !== 1) for (let i = 0; i < grid.length; i++) grid[i] = Math.min(1, grid[i] * gain);
    return grid;
  };
}
