/**
 * Save the current frame as a PNG: the video frame (with the brightness/contrast the user set),
 * the overlay exactly as drawn on screen (serialized from the live SVG), and an optional caption
 * band underneath — e.g. the AI's note for this frame. Done entirely on the device.
 */

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\n+/)) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > maxW && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
  }
  return lines;
}

export async function saveSnapshot(args: {
  video: HTMLVideoElement;
  svg: SVGSVGElement | null;
  mirrored: boolean;
  filter?: string;
  caption?: string;
  fileName: string;
}): Promise<void> {
  const { video } = args;
  const W = video.videoWidth;
  const H = video.videoHeight;
  const k = Math.min(1, 1920 / Math.max(W, H));
  const w = Math.round(W * k);
  const h = Math.round(H * k);

  const canvas = document.createElement("canvas");
  const ctx0 = canvas.getContext("2d");
  if (!ctx0) throw new Error("Canvas unavailable");
  const fontPx = Math.max(14, Math.round(w / 60));
  // Canvas text doesn't wait for webfonts — measure and draw with the real face, not a fallback.
  await document.fonts?.load(`${fontPx}px "Inter Tight"`).catch(() => undefined);
  ctx0.font = `${fontPx}px "Inter Tight", system-ui, sans-serif`;
  const lines = args.caption ? wrap(ctx0, args.caption, w - fontPx * 2) : [];
  const band = lines.length ? Math.round(fontPx * 1.45 * lines.length + fontPx * 1.6) : 0;
  canvas.width = w;
  canvas.height = h + band;
  const ctx = canvas.getContext("2d")!;

  ctx.save();
  if (args.mirrored) {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  if (args.filter) ctx.filter = args.filter;
  ctx.drawImage(video, 0, 0, w, h);
  ctx.filter = "none";
  if (args.svg) {
    const clone = args.svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("width", String(W));
    clone.setAttribute("height", String(H));
    const xml = new XMLSerializer().serializeToString(clone);
    const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      img.decoding = "async";
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Couldn't draw the overlay"));
        img.src = url;
      });
      ctx.drawImage(img, 0, 0, w, h);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  ctx.restore();

  if (band) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, h, w, band);
    ctx.fillStyle = "#e6f2fb";
    ctx.font = `${fontPx}px "Inter Tight", system-ui, sans-serif`;
    ctx.textBaseline = "top";
    lines.forEach((l, i) => ctx.fillText(l, fontPx, h + fontPx * 0.8 + i * fontPx * 1.45));
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Couldn't encode the image");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = args.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
