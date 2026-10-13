/**
 * Liquid glass — Apple's control material, for the web.
 *
 * ⚠️ MIRRORED: src/neurofit/components/glass/liquidGlass.ts (tracker) and
 * site/src/lib/liquidGlass.ts (marketing site) are the same file. The two apps build
 * from separate Vercel roots, so they can't share one. Change both, byte for byte.
 *
 * Three pieces:
 *
 *   GlassSegment       the glass droplet that slides between the options of a control.
 *                      Position and size are four independent springs (x, y, w, h), so
 *                      a move never desyncs; the droplet stretches along its direction
 *                      of travel in proportion to speed, lifts when pressed, and — on a
 *                      single-row control — can be dragged and flicked, landing on the
 *                      option its momentum projects to.
 *   installGlassPointer the specular highlight follows the pointer over any glass.
 *   refract            Chromium can run an SVG filter as a backdrop-filter, so there the
 *                      glass bends what's behind it at its rim (a displacement map built
 *                      for each size). WebKit and Gecko parse that and draw nothing, so
 *                      they keep the plain CSS frost.
 *
 * DOM contract: a positioned track holding `[data-lg-item]` children plus one
 * `.lg-seg__thumb` (the glass body, under the labels) and one `.lg-seg__lens` (the rim
 * and refraction, over them). Both are created if the markup doesn't provide them.
 */

// ── springs ────────────────────────────────────────────────────────────────

/**
 * A damped spring in Apple's terms: `response` is roughly the seconds to reach the
 * target, `damping` 1 settles without overshoot, below 1 overshoots. Always steps from
 * the value on screen, so re-targeting mid-flight keeps position AND velocity.
 */
class Spring {
  value: number;
  target: number;
  velocity = 0;

  constructor(value: number) {
    this.value = this.target = value;
  }

  step(dt: number, response: number, damping: number): void {
    const k = (2 * Math.PI / response) ** 2;
    const c = (4 * Math.PI * damping) / response;
    this.velocity += (-k * (this.value - this.target) - c * this.velocity) * dt;
    this.value += this.velocity * dt;
  }

  jump(to: number): void {
    this.value = this.target = to;
    this.velocity = 0;
  }

  settled(eps: number): boolean {
    return Math.abs(this.value - this.target) < eps && Math.abs(this.velocity) < eps * 10;
  }
}

/** Where a flick would come to rest — Apple's projection (Designing Fluid Interfaces). */
function project(velocity: number, rate = 0.99): number {
  return ((velocity / 1000) * rate) / (1 - rate);
}

/** Past a bound, follow less the further you go; real things slow before they stop. */
function rubberband(over: number, size: number, c = 0.55): number {
  return (over * size * c) / (size + c * Math.abs(over));
}

const reducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// Switching settles with a small overshoot (the droplet is liquid); dragging tracks
// tightly, and the lift/appear springs are quick and never wobble.
const SLIDE = { response: 0.42, damping: 0.68 };
const TRACK = { response: 0.13, damping: 0.92 };
const LIFT = { response: 0.26, damping: 0.72 };
const SHOW = { response: 0.3, damping: 1 };
const SUBSTEP = 1 / 240;
const DRAG_SLOP = 6;

// ── GlassSegment ───────────────────────────────────────────────────────────

export interface GlassSegmentOptions {
  /** Single-row controls: press and slide along the row, release to pick. */
  draggable?: boolean;
  /** A drag landed on this item. Taps go through the item's own click instead. */
  onPick?: (item: HTMLElement) => void;
}

interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export class GlassSegment {
  private readonly thumb: HTMLElement;
  private readonly lens: HTMLElement;
  private readonly x = new Spring(0);
  private readonly y = new Spring(0);
  private readonly w = new Spring(0);
  private readonly h = new Spring(0);
  private readonly lift = new Spring(0);
  private readonly show = new Spring(0);
  private active: HTMLElement | null = null;
  private base = { w: 0, h: 0, radius: "" };
  private raf = 0;
  private last = 0;
  private press: {
    id: number;
    x0: number;
    y0: number;
    dragging: boolean;
    offset: number;
    history: { x: number; t: number }[];
  } | null = null;
  private swallowClick = false;
  private readonly ro: ResizeObserver | null;
  private readonly unrefract: Array<() => void> = [];

  constructor(
    private readonly track: HTMLElement,
    private readonly opts: GlassSegmentOptions = {},
  ) {
    this.thumb = this.part("lg-seg__thumb", "prepend");
    this.lens = this.part("lg-seg__lens", "append");
    track.addEventListener("pointerdown", this.onDown);
    track.addEventListener("pointermove", this.onMove);
    track.addEventListener("pointerup", this.onUp);
    track.addEventListener("pointercancel", this.onUp);
    track.addEventListener("click", this.onClick, true);
    this.ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => this.remeasure()) : null;
    this.ro?.observe(track);
    for (const item of this.items()) this.ro?.observe(item);
    // The lens lenses the labels under its rim; blur would smear them, so it has none.
    this.unrefract.push(refract(this.lens, { blur: 0, saturate: 1.15, strength: 1 }));
  }

  /** Move the droplet to `item`, or dissolve it when null. */
  setActive(item: HTMLElement | null, instant = false): void {
    const was = this.active;
    this.active = item;
    if (!item) {
      this.show.target = 0;
      if (instant || reducedMotion()) this.show.jump(0);
      this.kick();
      return;
    }
    const box = this.measure(item);
    this.resize(item, box);
    const appearing = !was || this.show.value < 0.05;
    if (instant || appearing || reducedMotion()) {
      this.x.jump(box.cx);
      this.y.jump(box.cy);
      this.w.jump(box.w);
      this.h.jump(box.h);
    } else {
      this.x.target = box.cx;
      this.y.target = box.cy;
      this.w.target = box.w;
      this.h.target = box.h;
    }
    this.show.target = 1;
    if (instant || reducedMotion()) this.show.jump(1);
    this.kick();
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ro?.disconnect();
    this.track.removeEventListener("pointerdown", this.onDown);
    this.track.removeEventListener("pointermove", this.onMove);
    this.track.removeEventListener("pointerup", this.onUp);
    this.track.removeEventListener("pointercancel", this.onUp);
    this.track.removeEventListener("click", this.onClick, true);
    for (const off of this.unrefract) off();
  }

  // ── geometry ──

  private part(cls: string, where: "prepend" | "append"): HTMLElement {
    const found = this.track.querySelector<HTMLElement>(`:scope > .${cls}`);
    if (found) return found;
    const el = document.createElement("span");
    el.className = cls;
    el.setAttribute("aria-hidden", "true");
    this.track[where](el);
    return el;
  }

  private items(): HTMLElement[] {
    return Array.from(this.track.querySelectorAll<HTMLElement>(":scope > [data-lg-item]"));
  }

  private pickable(item: HTMLElement): boolean {
    return !(item as HTMLButtonElement).disabled && item.getAttribute("aria-disabled") !== "true";
  }

  /** Layout box, not the rendered one — an item mid-press-scale mustn't move the droplet. */
  private measure(item: HTMLElement): Box {
    const w = item.offsetWidth;
    const h = item.offsetHeight;
    return { cx: item.offsetLeft + w / 2, cy: item.offsetTop + h / 2, w, h };
  }

  /**
   * The droplet's layout box is always its TARGET size; the springs reach it through
   * scale. That keeps one displacement map per size (a map rebuilt per frame would be
   * far too slow) and lets the stretch read as the liquid deforming.
   */
  private resize(item: HTMLElement, box: Box): void {
    const radius = getComputedStyle(item).borderRadius;
    if (box.w === this.base.w && box.h === this.base.h && radius === this.base.radius) return;
    this.base = { w: box.w, h: box.h, radius };
    for (const el of [this.thumb, this.lens]) {
      el.style.width = `${box.w}px`;
      el.style.height = `${box.h}px`;
      el.style.borderRadius = radius;
    }
  }

  private remeasure(): void {
    if (!this.active || this.press?.dragging) return;
    const box = this.measure(this.active);
    this.resize(this.active, box);
    this.x.jump(box.cx);
    this.y.jump(box.cy);
    this.w.jump(box.w);
    this.h.jump(box.h);
    this.kick();
  }

  // ── pointer ──

  private itemAt(target: EventTarget | null): HTMLElement | null {
    const el = (target as Element | null)?.closest?.("[data-lg-item]");
    return el && el.parentElement === this.track ? (el as HTMLElement) : null;
  }

  private onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.press) return;
    const item = this.itemAt(e.target);
    if (!item || !this.pickable(item)) return;
    this.press = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dragging: false, offset: 0, history: [] };
    if (!reducedMotion()) this.lift.target = 1;
    this.kick();
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.press;
    if (!p || e.pointerId !== p.id || !this.opts.draggable || !this.active) return;
    const dx = e.clientX - p.x0;
    if (!p.dragging) {
      if (Math.abs(dx) < DRAG_SLOP || Math.abs(dx) < Math.abs(e.clientY - p.y0)) return;
      p.dragging = true;
      this.track.setPointerCapture(e.pointerId);
      // Grab the droplet where the finger is on it; a grab elsewhere pulls it over.
      const local = e.clientX - this.track.getBoundingClientRect().left;
      const half = this.w.value / 2;
      p.offset = Math.abs(local - this.x.value) <= half ? local - this.x.value : 0;
    }
    const items = this.items().filter((i) => this.pickable(i) || i === this.active);
    if (!items.length) return;
    const boxes = items.map((i) => this.measure(i));
    const min = boxes[0].cx;
    const max = boxes[boxes.length - 1].cx;
    const raw = e.clientX - this.track.getBoundingClientRect().left - p.offset;
    const span = this.track.offsetWidth;
    const cx = raw < min ? min - rubberband(min - raw, span) : raw > max ? max + rubberband(raw - max, span) : raw;
    this.x.target = cx;
    this.w.target = widthAt(boxes, cx);
    p.history.push({ x: e.clientX, t: e.timeStamp });
    while (p.history.length > 2 && e.timeStamp - p.history[0].t > 100) p.history.shift();
    this.kick();
  };

  private onUp = (e: PointerEvent): void => {
    const p = this.press;
    if (!p || e.pointerId !== p.id) return;
    this.press = null;
    this.lift.target = 0;
    if (p.dragging) {
      this.swallowClick = true;
      setTimeout(() => (this.swallowClick = false), 0);
      const h = p.history;
      const v = h.length >= 2 ? ((h[h.length - 1].x - h[0].x) / Math.max(1, h[h.length - 1].t - h[0].t)) * 1000 : 0;
      this.x.velocity = v; // hand the finger's speed to the spring: no seam at release
      const landing = this.x.value + (e.type === "pointercancel" ? 0 : project(v));
      const candidates = this.items().filter((i) => this.pickable(i));
      let best = this.active;
      let bestD = Infinity;
      for (const item of candidates) {
        const d = Math.abs(this.measure(item).cx - landing);
        if (d < bestD) {
          bestD = d;
          best = item;
        }
      }
      if (best && best !== this.active) this.opts.onPick?.(best);
      // The pick re-targets through setActive; if it was a no-op (or refused), go home.
      if (this.active) this.retarget(this.active);
    }
    this.kick();
  };

  private onClick = (e: MouseEvent): void => {
    if (!this.swallowClick) return;
    e.stopPropagation();
    e.preventDefault();
  };

  private retarget(item: HTMLElement): void {
    const box = this.measure(item);
    this.resize(item, box);
    this.x.target = box.cx;
    this.y.target = box.cy;
    this.w.target = box.w;
    this.h.target = box.h;
  }

  // ── frame ──

  private kick(): void {
    if (this.raf) return;
    this.last = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    const move = this.press?.dragging ? TRACK : SLIDE;
    for (let t = 0; t < dt - 1e-6; t += SUBSTEP) {
      const s = Math.min(SUBSTEP, dt - t);
      this.x.step(s, move.response, move.damping);
      this.y.step(s, move.response, move.damping);
      this.w.step(s, move.response, 1);
      this.h.step(s, move.response, 1);
      this.lift.step(s, LIFT.response, LIFT.damping);
      this.show.step(s, SHOW.response, SHOW.damping);
    }
    this.render();
    const done =
      !this.press &&
      this.x.settled(0.1) &&
      this.y.settled(0.1) &&
      this.w.settled(0.1) &&
      this.h.settled(0.1) &&
      this.lift.settled(0.002) &&
      this.show.settled(0.002);
    if (done) {
      for (const s of [this.x, this.y, this.w, this.h, this.lift, this.show]) s.jump(s.target);
      this.render();
      this.raf = 0;
      return;
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  private render(): void {
    const { w: bw, h: bh } = this.base;
    if (!bw || !bh) return;
    const still = reducedMotion();
    // Stretch along the direction of travel, thin across it — speed made visible.
    const ex = still ? 1 : 1 + Math.min(0.32, Math.abs(this.x.velocity) / 2600);
    const ey = still ? 1 : 1 + Math.min(0.32, Math.abs(this.y.velocity) / 2600);
    const lift = 1 + 0.14 * this.lift.value;
    const appear = 0.72 + 0.28 * this.show.value;
    const sx = (this.w.value / bw) * (ex / Math.sqrt(ey)) * lift * appear;
    const sy = (this.h.value / bh) * (ey / Math.sqrt(ex)) * lift * appear;
    const transform = `translate3d(${(this.x.value - bw / 2).toFixed(2)}px, ${(this.y.value - bh / 2).toFixed(2)}px, 0) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
    const opacity = Math.max(0, Math.min(1, this.show.value)).toFixed(3);
    for (const el of [this.thumb, this.lens]) {
      el.style.transform = transform;
      el.style.opacity = opacity;
    }
    this.track.style.setProperty("--lg-lift", this.lift.value.toFixed(3));
  }
}

/** Droplet width while dragging: blend between the two items the centre sits between. */
function widthAt(boxes: Box[], cx: number): number {
  if (cx <= boxes[0].cx) return boxes[0].w;
  for (let i = 1; i < boxes.length; i++) {
    const a = boxes[i - 1];
    const b = boxes[i];
    if (cx <= b.cx) return a.w + ((cx - a.cx) / (b.cx - a.cx || 1)) * (b.w - a.w);
  }
  return boxes[boxes.length - 1].w;
}

// ── specular highlight ─────────────────────────────────────────────────────

const GLASS_SELECTOR = ".lg-btn, .lg-seg";

/** Point every glass surface's highlight at the pointer. Once per page; returns an off. */
export function installGlassPointer(root: Document = document): () => void {
  const onMove = (e: PointerEvent): void => {
    const el = (e.target as Element | null)?.closest?.(GLASS_SELECTOR) as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--lg-x", `${(e.clientX - r.left).toFixed(1)}px`);
    el.style.setProperty("--lg-y", `${(e.clientY - r.top).toFixed(1)}px`);
  };
  root.addEventListener("pointermove", onMove, { passive: true });
  root.addEventListener("pointerdown", onMove, { passive: true });
  return () => {
    root.removeEventListener("pointermove", onMove);
    root.removeEventListener("pointerdown", onMove);
  };
}

// ── refraction (Chromium) ──────────────────────────────────────────────────

const canRefract = ((): boolean => {
  if (typeof navigator === "undefined" || typeof CSS === "undefined") return false;
  const ua = navigator.userAgent;
  // iOS browsers all run WebKit whatever their name, and WebKit/Gecko accept
  // `backdrop-filter: url(…)` then draw nothing — so this is a UA test on purpose.
  if (/\b(CriOS|FxiOS|EdgiOS)\b/.test(ua)) return false;
  return /\b(Chrome|Chromium|Edg)\/\d+/.test(ua) && CSS.supports("backdrop-filter", "url(#a)");
})();

let defs: SVGDefsElement | null = null;
const filters = new Map<string, string>();
const SVG_NS = "http://www.w3.org/2000/svg";
const MAX_AREA = 420_000;

export interface RefractOptions {
  /** Frost behind the lens, px. */
  blur?: number;
  saturate?: number;
  /** 0–1.5: how hard the rim bends. */
  strength?: number;
}

/**
 * Bend what's behind `el` at its rim, like the edge of a thick glass pill. Chromium
 * only; elsewhere a no-op and the element keeps its CSS backdrop-filter. Tracks the
 * element's size and corner radius. Returns a cleanup.
 */
export function refract(el: HTMLElement, opts: RefractOptions = {}): () => void {
  if (!canRefract) return () => {};
  const { blur = 6, saturate = 1.7, strength = 1 } = opts;
  const apply = (): void => {
    const w = Math.round(el.offsetWidth);
    const h = Math.round(el.offsetHeight);
    if (w < 4 || h < 4 || w * h > MAX_AREA) {
      el.style.removeProperty("backdrop-filter");
      return;
    }
    const r = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, w / 2, h / 2);
    const id = filterFor(w, h, r, blur, saturate, strength);
    el.style.setProperty("backdrop-filter", `url(#${id})`);
    el.classList.add("is-refracting");
  };
  apply();
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(apply) : null;
  ro?.observe(el);
  return () => {
    ro?.disconnect();
    el.style.removeProperty("backdrop-filter");
    el.classList.remove("is-refracting");
  };
}

function filterFor(w: number, h: number, r: number, blur: number, saturate: number, strength: number): string {
  const key = `${w}x${h}r${Math.round(r)}b${blur}s${saturate}k${strength}`;
  const hit = filters.get(key);
  if (hit) return hit;
  if (!defs) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none";
    defs = document.createElementNS(SVG_NS, "defs");
    svg.append(defs);
    document.body.append(svg);
  }
  const id = `lg-${filters.size}`;
  // A thin rim, not the whole pill: on a 30px capsule a full-radius bevel bent every
  // pixel and ghosted the label into the top edge.
  const bevel = Math.max(3, Math.min((r || h / 2) * 0.6, 14, h / 2, w / 2));
  const f = document.createElementNS(SVG_NS, "filter");
  f.id = id;
  for (const [k, v] of Object.entries({
    x: "0",
    y: "0",
    width: String(w),
    height: String(h),
    filterUnits: "userSpaceOnUse",
    "color-interpolation-filters": "sRGB",
  }))
    f.setAttribute(k, v);
  // stdDeviation 0 means "transparent" to older engines, so a clear lens skips the blur.
  const frost = blur > 0 ? `<feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" edgeMode="duplicate" result="frost"/>` : "";
  f.innerHTML =
    frost +
    `<feImage href="${displacementMap(w, h, r, bevel)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="map"/>` +
    `<feDisplacementMap in="${blur > 0 ? "frost" : "SourceGraphic"}" in2="map" scale="${(bevel * 1.2 * strength).toFixed(1)}" xChannelSelector="R" yChannelSelector="G" result="bent"/>` +
    `<feColorMatrix in="bent" type="saturate" values="${saturate}"/>`;
  defs.append(f);
  filters.set(key, id);
  return id;
}

/**
 * R/G = x/y offset (0.5 = none) for a rounded rect with a convex rim `bevel` px wide:
 * zero across the flat middle, rising to full at the edge along a quarter-circle profile.
 * Each rim pixel samples from further INSIDE the shape, so what's behind the edge is
 * pulled outward — a lens bulge — and never reaches for pixels outside the element,
 * which the backdrop doesn't have.
 */
function displacementMap(w: number, h: number, r: number, bevel: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const hw = w / 2;
  const hh = h / 2;
  const rr = Math.min(r, hw, hh);
  for (let y = 0; y < h; y++) {
    const py = y + 0.5 - hh;
    const qy = Math.abs(py) - (hh - rr);
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - hw;
      const qx = Math.abs(px) - (hw - rr);
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr;
      const inset = -outside; // distance in from the edge
      let dx = 0;
      let dy = 0;
      if (inset >= 0 && inset < bevel) {
        let nx: number;
        let ny: number;
        if (qx > 0 && qy > 0) {
          const l = Math.hypot(qx, qy) || 1;
          nx = (qx / l) * Math.sign(px);
          ny = (qy / l) * Math.sign(py);
        } else if (qx > qy) {
          nx = Math.sign(px);
          ny = 0;
        } else {
          nx = 0;
          ny = Math.sign(py);
        }
        const t = 1 - inset / bevel;
        const m = 1 - Math.sqrt(1 - t * t);
        dx = -nx * m;
        dy = -ny * m;
      }
      const i = (y * w + x) * 4;
      d[i] = 128 + Math.round(dx * 127);
      d[i + 1] = 128 + Math.round(dy * 127);
      d[i + 2] = 128;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
}
