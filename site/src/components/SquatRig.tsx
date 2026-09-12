import { useLayoutEffect, useRef, type MutableRefObject } from "react";

import GLBoundary from "@/components/GLBoundary";
import PoseSkeleton3D, { newRigDriver, type RigDriver } from "@/components/PoseSkeleton3D";
import { CARD_BLOCKS, POST_SET, cardBlockAmount } from "@/lib/postSet";
import { PINNED_VH, RIG_VH, tagAmounts, timelineAt, type TagId } from "@/lib/rigTimeline";

/* three is pulled in statically here rather than behind a second `lazy`: this
   whole module is already lazy at the App level and is only ever imported when
   the rig is actually going to run, so splitting again would just cost a second
   round trip. Under reduced motion nothing in this file is ever fetched. */

/** Corner radius of the hero lens, so the frame un-rounds as it opens out. */
const LENS_RADIUS = 18;

/**
 * Screens of scroll per screen of sequence. **This is the speed dial** — raise
 * it to slow the reps down, lower it to speed them up.
 *
 * At 1 a rep passed in a single flick of a trackpad, and reading it meant
 * feathering the scroll a few pixels at a time. Halving the speed is not a
 * cosmetic preference: the whole point of scrubbing rather than playing is that
 * the reader sets the pace, and that only works if the natural pace is already
 * close to a watchable one.
 */
const SCROLL_PER_SCREEN = 1.7;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Files an element into a fixed slot, so the paint loop can address the closing
 *  panel's lines by index rather than by walking its children — the order of the
 *  stagger is then the order of the array and not the order of the DOM. */
const blockRef =
  (store: MutableRefObject<Array<HTMLElement | null>>, i: number) => (el: HTMLElement | null) => {
    store.current[i] = el;
  };

/**
 * What the sequence says, and where it says it.
 *
 * Four tags rather than three, because the fifth rep is two separate findings
 * that happen to overlap: the rep goes unsteady, and then the shoulders drift.
 * They get their own labels, their own anchors and their own leader lines —
 * running them together would assert that one caused the other, which is not
 * something the app claims and not something this animation can show.
 *
 * All four leaders are the same red. They are the app's attention, not a
 * taxonomy — a viewer reading a page does not know that two of these are
 * triggers and two are context, and colouring them differently only made the
 * pair on rep 5 look like a lesser class of finding. The distinction still
 * exists where it can actually be read: the clavicle stays green under the
 * measured angle, and red is reserved for the deviation itself.
 *
 * The two that can appear together sit on opposite sides so neither is ever
 * reading over the other.
 */
const TAGS = {
  // `v` sets the label near the height of the thing it points at, so the leader
  // runs diagonally to it rather than straight across the figure — and so the
  // two on rep 5 sit on opposite corners and can never read as one sentence.
  valgus: { text: "Knee cave detected", side: "right", v: "low" },
  lean: { text: "Forward lean detected", side: "left", v: "high" },
  fatigue: { text: "Fatigue detected", side: "left", v: "low" },
  shoulders: { text: "Uneven shoulders detected", side: "right", v: "high" },
} as const;

const TAG_IDS = Object.keys(TAGS) as TagId[];

/** Radius of the drawn angle arc, and how far past it the degree label sits. */
const ARC_R = 54;
const LABEL_GAP = 20;
const DEG = 180 / Math.PI;
/** How far short of its joint a leader line stops. */
const LEAD_GAP = 9;

export default function SquatRig({ onFail }: { onFail: () => void }) {
  const section = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const countN = useRef<HTMLSpanElement>(null);
  const tags = useRef<Partial<Record<TagId, HTMLElement | null>>>({});
  const leads = useRef<Partial<Record<TagId, SVGLineElement | null>>>({});
  const card = useRef<HTMLElement>(null);
  const cardBlocks = useRef<Array<HTMLElement | null>>([]);
  const angBase = useRef<SVGLineElement>(null);
  const angSeg = useRef<SVGLineElement>(null);
  const angArc = useRef<SVGPathElement>(null);
  const angWedge = useRef<SVGPathElement>(null);
  const angLab = useRef<SVGTextElement>(null);
  const driver = useRef<RigDriver>(newRigDriver());

  // Layout effect, not a passive one: the clip and the driver's frame rect have
  // to be right BEFORE the browser paints this commit. Deferred, the first frame
  // shows the CSS placeholder clip and a figure centred on the canvas.
  useLayoutEffect(() => {
    const el = section.current;
    if (!el) return;

    /* Measured on mount and on resize, never per frame. Reading a rect inside
       the scroll loop forces layout on every tick; the only thing that actually
       changes with scroll is scrollY, and that is free. */
    const geom = {
      pinTop: 0,
      lensTop: 0,
      lensLeft: 0,
      lensW: 0,
      lensH: 0,
      vw: 0,
      vh: 0,
      /* The CLIP's coordinate space, which is not the same as the scroll's.
         `clip-path` is resolved against the host's own border box, and the host
         is `position: fixed` — so its containing block is the viewport MINUS the
         scrollbar. `innerWidth` includes the scrollbar; on a desktop Chrome that
         is 15px of difference, and every right-hand inset came out 15px too
         large. The frame's right edge stopped short of the placeholder's, and
         the strip of placeholder left uncovered — dark, 18px-rounded, with its
         own drop shadow — is the second rectangle that appeared behind the
         opening frame. Anything that defines the RECT reads these two. */
      cw: 0,
      ch: 0,
      unit: 0,
      /** Scroll at which the frame stops following the lens and starts opening. */
      expandStart: 0,
      /** The lens's viewport Y at that moment — the rect the opening starts from. */
      startTop: 0,
      /** How far down the frame's top edge may be and still count as "at the
       *  bar". A whole bar-height of lead, so the fade is finished by contact. */
      barReach: 0,
      /** The wordmark's box, for deciding when the ink has to flip. */
      wmL: 0,
      wmR: 0,
      wmB: 0,
      /** True once the rig has been measured — nothing above is meaningful
       *  before that, and the masthead must not be touched on a stale zero. */
      ready: false,
    };

    const anchorEl = document.querySelector<HTMLElement>("[data-lens-anchor]");
    const copyEl = document.querySelector<HTMLElement>(".hero__copy");
    const mastEl = document.querySelector<HTMLElement>(".masthead");

    /**
     * The masthead hands over in TWO stages, because the two things it has to do
     * become true at different moments.
     *
     * `is-rig` drops the bar's own surface — the tint, the blur, the border and
     * the scroll-edge gradient. That has to happen before the dark frame reaches
     * the bar, not after: a translucent light strip with a soft tail hanging over
     * the top edge of a dark panel is exactly the smear that made the start of
     * the scroll look wrong, and it appeared a good half-second before the old
     * trigger fired.
     *
     * `is-rig-ink` flips the wordmark to the on-lens light, and must NOT happen
     * at the same time. The frame opens from the right-hand side, so for most of
     * the way up the top-left corner is still light paper — flipping the ink
     * there would have turned the wordmark invisible against it. It waits until
     * the frame actually covers the wordmark.
     */
    let rigOpen = false;
    let rigInk = false;
    const setRigOpen = (on: boolean) => {
      if (on === rigOpen) return;
      rigOpen = on;
      mastEl?.classList.toggle("is-rig", on);
    };
    const setRigInk = (on: boolean) => {
      if (on === rigInk) return;
      rigInk = on;
      mastEl?.classList.toggle("is-rig-ink", on);
    };

    const measure = () => {
      const y = window.scrollY;
      geom.vw = window.innerWidth;
      geom.vh = window.innerHeight;
      geom.cw = document.documentElement.clientWidth;
      geom.ch = document.documentElement.clientHeight;
      // The runway shortens on a phone rather than the sequence losing a beat —
      // the reps that go RIGHT are as much of the argument as the ones that
      // don't. Scaled in one place so the pin height and the progress
      // denominator can't drift apart.
      geom.unit = geom.vh * SCROLL_PER_SCREEN * (geom.vw <= 940 ? 0.7 : 1);
      geom.pinTop = el.getBoundingClientRect().top + y;

      // Sized in pixels from the SAME innerHeight the scroll maths uses. Sizing
      // it in `vh` instead desynchronises the pin point on mobile, where CSS vh
      // is the large viewport but innerHeight is the current one.
      el.style.height = `${geom.vh + (RIG_VH - 1) * geom.unit}px`;
      if (stage.current) stage.current.style.height = `${geom.vh}px`;

      const r = anchorEl?.getBoundingClientRect();
      if (r) {
        geom.lensTop = r.top + y;
        geom.lensLeft = r.left;
        geom.lensW = r.width;
        geom.lensH = r.height;
      }

      /* Open from the lens where it is best framed, not from wherever it happens
         to be a fixed distance before the pin. `fit` is the scroll at which the
         lens sits centred in the viewport; before that the frame simply rides
         along with it, and the two agree exactly at the handover. */
      const fit = geom.lensTop + geom.lensH / 2 - geom.ch / 2;
      geom.expandStart = Math.max(0, Math.min(fit, geom.pinTop - geom.vh * 0.4));
      geom.startTop = Math.min(
        Math.max(geom.lensTop - geom.expandStart, 0),
        Math.max(0, geom.ch - geom.lensH),
      );

      const mh = mastEl?.getBoundingClientRect().height ?? 66;
      geom.barReach = mh * 2;
      const wm = mastEl?.querySelector(".wordmark")?.getBoundingClientRect();
      geom.wmL = wm?.left ?? 0;
      geom.wmR = wm?.right ?? 0;
      geom.wmB = wm?.bottom ?? mh;
      geom.ready = true;
    };

    // Only write to the DOM when a value actually changed — once the lens is
    // fully open, `clip` and `frame` are constant for six screens of scroll.
    const last = {
      clip: "",
      frameBox: "",
      opacity: "",
      count: "",
      note: "",
      fade: "",
      ang: "",
    };

    const paint = () => {
      const y = window.scrollY;
      const expandT = clamp01((y - geom.expandStart) / Math.max(1, geom.pinTop - geom.expandStart));
      const seqT = clamp01((y - geom.pinTop) / (geom.unit * PINNED_VH));

      driver.current.expandT = expandT;
      driver.current.seqT = seqT;

      const f = timelineAt(expandT, seqT);
      const t = smooth(expandT);

      /* Until the opening starts the frame rides with the lens, so the two are
         the same object. Once it starts, the anchor HOLDS: the lens keeps
         scrolling away underneath but the frame opens from where it was. They
         agree exactly at the handover, so nothing jumps.

         Chasing the scrolling lens is what cropped the head — every inset was
         lerped from a rect whose top had already gone past the viewport, so the
         frame's centre climbed off screen before it grew. Holding the anchor
         makes all four insets fall monotonically from a fully on-screen rect to
         zero, which is both smoother and impossible to crop. */
      const anchorTop = expandT > 0 ? geom.startTop : geom.lensTop - y;
      const shrinkX = f.outT * geom.cw * 0.16;
      const shrinkY = f.outT * geom.ch * 0.16;
      const top = mix(anchorTop, 0, t) + shrinkY;
      const left = mix(geom.lensLeft, 0, t) + shrinkX;
      const right = mix(geom.cw - (geom.lensLeft + geom.lensW), 0, t) + shrinkX;
      const bottom = mix(geom.ch - (anchorTop + geom.lensH), 0, t) + shrinkY;
      const radius = mix(LENS_RADIUS, 0, t);

      /* The placeholder is CUT, not faded.
         It and the frame are the same rectangle right up to the instant the
         opening begins — the frame is literally drawn over it — so switching it
         off at that instant is invisible. Fading it out over the first sixth of
         the opening was not: the frame holds its anchor while the placeholder
         keeps scrolling, so a second dark panel, with its own shadow, slid up
         out from behind the growing one and was still at two thirds opacity
         fifty pixels clear of it.

         The hero copy still fades, and now earlier, so the growing frame never
         reaches live text before the text has gone. */
      const open = expandT > 0;
      const fade = `${open ? 1 : 0}|${clamp01((expandT - 0.05) / 0.3).toFixed(2)}`;
      if (fade !== last.fade) {
        const [ghost, cover] = fade.split("|");
        if (anchorEl) anchorEl.style.visibility = +ghost ? "hidden" : "visible";
        if (copyEl) copyEl.style.opacity = String(1 - +cover);
        last.fade = fade;
      }

      /* Both stages read the frame's own geometry rather than a point on the
         scroll, so they stay correct at any viewport: the bar clears as the dark
         edge comes up to meet it, and the ink flips exactly when the frame takes
         the corner the wordmark sits in. A class each, so the CSS owns the
         easing — these cross once in each direction, and a transition handles
         that far better than lerping four properties from a scroll handler. */
      const closing = f.outT >= 0.6 || !geom.ready;
      setRigOpen(top < geom.barReach && !closing);
      // Half-covered is the flip point. Either ink is briefly wrong on one half
      // of the word around it, so the crossfade is centred on the moment rather
      // than run from one end of it — at scroll speed that is a few frames.
      setRigInk(!closing && top <= geom.wmB && left <= (geom.wmL + geom.wmR) / 2);

      /* The scene frames this rect rather than the canvas, so the figure is
         inside the lens box from the very first paint instead of appearing only
         once the clip had opened out to where the camera was already pointing.

         The NEAR edges are clamped to the viewport and the far edges are not,
         which is not an oversight. Frame that has gone off the top is content
         the reader has scrolled past — it will never come back, so the camera
         has to compensate or the head is cropped. Frame below the fold is
         content on its way in: on a narrow screen the lens starts under the
         fold, and clamping there would squeeze the figure into the visible
         sliver and then grow it as you scroll, instead of simply revealing it
         the way any other tall element on the page behaves. */
      const visX = Math.max(0, left);
      const visY = Math.max(0, top);
      driver.current.clipX = visX;
      driver.current.clipY = visY;
      driver.current.clipW = geom.cw - right - visX;
      driver.current.clipH = geom.ch - bottom - visY;

      const clip = `inset(${top}px ${right}px ${bottom}px ${left}px round ${radius}px)`;
      if (clip !== last.clip && host.current) {
        host.current.style.clipPath = clip;
        last.clip = clip;
      }

      const opacity = (1 - f.outT).toFixed(3);
      if (opacity !== last.opacity && host.current) {
        host.current.style.opacity = opacity;
        last.opacity = opacity;
      }

      // The chrome tracks the same rect, so the brackets sit on the corners of
      // the frame at every size instead of on the corners of the viewport.
      const frameBox = `${top}px ${right}px ${bottom}px ${left}px`;
      if (frameBox !== last.frameBox && frame.current) {
        frame.current.style.inset = frameBox;
        frame.current.style.opacity = opacity;
        last.frameBox = frameBox;
      }

      const count = String(f.repsCounted);
      if (count !== last.count && countN.current) {
        countN.current.textContent = count;
        last.count = count;
      }

      // Timing lives in the timeline, not here — it is a pure function of the
      // sample, and keeping it there is what lets the offscreen check assert the
      // ORDER these arrive in.
      const amounts = tagAmounts(f);

      const key = TAG_IDS.map((k) => amounts[k].toFixed(2)).join("|") + `:${f.cardT.toFixed(2)}`;
      if (key !== last.note) {
        for (const id of TAG_IDS) {
          const n = tags.current[id];
          if (!n) continue;
          const a = amounts[id];
          n.style.opacity = String(a);
          // A custom property rather than `transform`, so the stylesheet keeps
          // ownership of the tag's own centring — which differs between the
          // desktop side rail and the mobile stack.
          n.style.setProperty("--ny", `${((1 - a) * 10).toFixed(1)}px`);
          n.style.visibility = a > 0.01 ? "visible" : "hidden";
        }
        if (card.current) {
          const on = f.cardT > 0.01;
          /* Written straight onto the element rather than through a custom
             property. A variable set on the panel would be inherited, so every
             one of its children would restyle on every frame of the panel's
             arrival — which was free when the panel held a single empty
             paragraph and is not now that it holds the debrief. */
          card.current.style.opacity = String(f.cardT);
          card.current.style.transform = `translate(-50%, calc(-50% + ${((1 - f.cardT) * 20).toFixed(1)}px))`;
          card.current.style.visibility = on ? "visible" : "hidden";

          // The panel writes itself line by line. Pure, and a function of the
          // panel's own progress rather than of a clock, so scrolling back up
          // un-writes it in the opposite order instead of replaying.
          for (let i = 0; i < CARD_BLOCKS; i++) {
            const b = cardBlocks.current[i];
            if (!b) continue;
            const a = on ? cardBlockAmount(f.cardT, i) : 0;
            b.style.opacity = String(a);
            b.style.transform = `translateY(${((1 - a) * 7).toFixed(1)}px)`;
          }
        }
        last.note = key;
      }

      const d = driver.current;
      for (const id of TAG_IDS) {
        const line = leads.current[id];
        const n = tags.current[id];
        if (!line) continue;
        const a = amounts[id];
        if (!n || a <= 0.01) {
          line.setAttribute("opacity", "0");
          continue;
        }
        const r = n.getBoundingClientRect();
        const right = TAGS[id].side === "right";
        const fromX = right ? r.left : r.right;
        const fromY = r.top + r.height / 2;

        /* Each label points at its OWN pair of joints — fatigue at the hips,
           because it is a whole-rep finding with no joint of its own, the rest
           at the joints their beat is about — and stops at whichever of the pair
           is on the LABEL'S side.

           Aiming at the midpoint is what put a dashed line straight through the
           near shin: from the right of the figure, the point between the two
           knees is on the far side of the right leg, so the leader had to cross
           it to arrive. Ending on the near joint means it never reaches a limb it
           would have to pass through. */
        const [ax, ay, bx, by] =
          id === "fatigue"
            ? [d.hipAX, d.hipAY, d.hipBX, d.hipBY]
            : [d.markAX, d.markAY, d.markBX, d.markBY];
        const nearA = right ? ax >= bx : ax <= bx;
        let toX = nearA ? ax : bx;
        let toY = nearA ? ay : by;

        // Stop just short, so the line reads as pointing at the joint rather
        // than landing on top of it.
        const dx = toX - fromX;
        const dy = toY - fromY;
        const len = Math.hypot(dx, dy);
        if (len > LEAD_GAP) {
          toX -= (dx / len) * LEAD_GAP;
          toY -= (dy / len) * LEAD_GAP;
        }

        line.setAttribute("x1", String(fromX));
        line.setAttribute("y1", String(fromY));
        line.setAttribute("x2", String(toX));
        line.setAttribute("y2", String(toY));
        line.setAttribute("opacity", String(a * 0.6));
      }

      paintAngle(
        f.beat === "unlevel" && f.planeVisible ? clamp01(f.focusAmount * 1.6) : 0,
      );
    };

    /**
     * The shoulder angle, drawn against an imaginary horizontal.
     *
     * The degrees are MEASURED, not scripted: the two shoulder joints come back
     * from the scene already projected, and the number is the tilt of the line
     * between them on screen. That is the same quantity a camera-based system
     * has — image coordinates, not a protractor held against a real body — so it
     * rises on its own as the drift develops rather than counting up to a figure
     * decided in advance. Degrees are also the one unit the app lets itself
     * speak out loud: they are real units, unlike the normalised ratios it keeps
     * to itself.
     */
    const paintAngle = (amount: number) => {
      const base = angBase.current;
      const seg = angSeg.current;
      const arc = angArc.current;
      const wedge = angWedge.current;
      const lab = angLab.current;
      if (!base || !seg || !arc || !wedge || !lab) return;

      if (amount <= 0.01) {
        if (last.ang !== "off") {
          for (const el of [base, seg, arc, wedge, lab]) el.setAttribute("opacity", "0");
          last.ang = "off";
        }
        return;
      }

      const d = driver.current;
      // Left-to-right on SCREEN, not left-to-right on the body: which shoulder
      // is which side of the frame depends on where the camera is, and an arc
      // swept from the wrong end reads as a reflex angle.
      const flip = d.markBX < d.markAX;
      const ax = flip ? d.markBX : d.markAX;
      const ay = flip ? d.markBY : d.markAY;
      const bx = flip ? d.markAX : d.markBX;
      const by = flip ? d.markAY : d.markBY;

      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const ang = Math.atan2(by - ay, bx - ax);
      const half = Math.hypot(bx - ax, by - ay) / 2;
      const r = Math.min(ARC_R, Math.max(20, half * 0.9));

      // The imaginary line extends as the annotation builds, so it reads as
      // being laid down against the body rather than having always been there.
      const reach = half * 1.55 * amount;
      base.setAttribute("x1", (mx - reach * 0.42).toFixed(1));
      base.setAttribute("y1", my.toFixed(1));
      base.setAttribute("x2", (mx + reach).toFixed(1));
      base.setAttribute("y2", my.toFixed(1));
      base.setAttribute("opacity", String(clamp01(amount * 1.4) * 0.9));

      seg.setAttribute("x1", ax.toFixed(1));
      seg.setAttribute("y1", ay.toFixed(1));
      seg.setAttribute("x2", bx.toFixed(1));
      seg.setAttribute("y2", by.toFixed(1));
      seg.setAttribute("opacity", String(clamp01(amount * 1.4)));

      /* The arc is the DEVIATION, so it is the one element in red.
         In the first pass everything here was one colour and the annotation read
         as decoration: a dashed line and a segment, both pale, at a few degrees
         to each other. Colouring the gap between them — rather than either line
         — puts the emphasis on the quantity being reported instead of on the
         things being measured, and it needs exactly one hue to do it. */
      const ex = mx + r * Math.cos(ang);
      const ey = my + r * Math.sin(ang);
      const sweep = ang > 0 ? 1 : 0;
      const arcD = `M${(mx + r).toFixed(1)} ${my.toFixed(1)} A${r} ${r} 0 0 ${sweep} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
      const arcOn = clamp01((amount - 0.25) / 0.45);
      arc.setAttribute("d", arcD);
      arc.setAttribute("opacity", String(arcOn));
      // Filling the wedge as well as stroking the arc: at ten degrees the arc
      // alone is a short scratch, and the filled sector is what makes the size
      // of the angle readable at a glance without drawing anything louder.
      wedge.setAttribute("d", `${arcD} L${mx.toFixed(1)} ${my.toFixed(1)} Z`);
      wedge.setAttribute("opacity", String(arcOn));

      const lx = mx + (r + LABEL_GAP) * Math.cos(ang / 2);
      const ly = my + (r + LABEL_GAP) * Math.sin(ang / 2);
      lab.setAttribute("x", lx.toFixed(1));
      lab.setAttribute("y", ly.toFixed(1));
      lab.textContent = `${(Math.abs(ang) * DEG).toFixed(1)}°`;
      lab.setAttribute("opacity", String(clamp01((amount - 0.4) / 0.4)));
      last.ang = "on";
    };

    let raf = 0;
    const loop = () => {
      paint();
      raf = requestAnimationFrame(loop);
    };

    measure();
    paint();

    /* The frame is now on screen and covering the placeholder exactly, so the
       placeholder gives up its own dark surface and keeps only its shadow (a
       shadow cannot come from the host — `clip-path` would cut it off with the
       box). It is not dropped in the stylesheet because until this line runs
       there is no frame: `SquatRig` is lazy, and during the chunk's download the
       placeholder IS the lens the hero shows. From here on there is exactly one
       dark rectangle in the hero, so a future half-pixel of drift can't put a
       second one behind it. */
    anchorEl?.classList.add("is-rigged");

    // The loop only turns over while the rig is anywhere near the viewport; the
    // same flag stops the WebGL frameloop.
    const io = new IntersectionObserver(
      ([e]) => {
        driver.current.running = e.isIntersecting;
        if (e.isIntersecting && !raf) raf = requestAnimationFrame(loop);
        if (!e.isIntersecting && raf) {
          cancelAnimationFrame(raf);
          raf = 0;
          if (host.current) host.current.style.visibility = "hidden";
          // The loop is what would otherwise put the bar back, and it has just
          // stopped — so hand the masthead over explicitly rather than leaving
          // the page navigation faded out for good.
          setRigOpen(false);
          setRigInk(false);
        } else if (host.current) {
          host.current.style.visibility = "visible";
        }
      },
      { rootMargin: "100% 0px" },
    );
    io.observe(el);

    const onResize = () => {
      measure();
      last.clip = last.frameBox = last.opacity = "";
      paint();
    };
    window.addEventListener("resize", onResize);
    // Fonts settle after first paint and can move the hero lens a few pixels.
    document.fonts?.ready.then(onResize).catch(() => {});

    return () => {
      io.disconnect();
      window.removeEventListener("resize", onResize);
      if (raf) cancelAnimationFrame(raf);
      // Nothing else owns these, so unmounting has to give them back.
      setRigOpen(false);
      if (anchorEl) {
        anchorEl.style.visibility = "";
        anchorEl.classList.remove("is-rigged");
      }
      if (copyEl) copyEl.style.opacity = "";
    };
  }, []);

  return (
    <section className="rig" ref={section} aria-labelledby="rig-h">
      <h2 className="rig__h vh" id="rig-h">
        Five squats, and the three the app would have something to say about
      </h2>

      <div className="rig__stage" ref={stage}>
        <div className="rig__host" ref={host} aria-hidden="true">
          <span className="lens__scan" />
          <div className="rig__gl">
            <GLBoundary onFail={onFail}>
              <PoseSkeleton3D driver={driver} />
            </GLBoundary>
          </div>
        </div>

        <div className="rig__frame" ref={frame} aria-hidden="true">
          <div className="lens__chrome">
            <span className="brk brk--tl" />
            <span className="brk brk--tr" />
            <span className="brk brk--bl" />
            <span className="brk brk--br" />
          </div>
          {/* No HUD. Both chips named things the sequence is already showing —
              the camera angle, and the depth the rep counter is counting — and
              at full screen they sat in the wordmark's corner. */}
          <div className="lens__count">
            <span className="count__n" ref={countN}>
              0
            </span>
            <span className="count__l">REPS</span>
          </div>
        </div>

        <svg className="rig__lead" aria-hidden="true">
          {TAG_IDS.map((id) => (
            <line
              key={id}
              opacity="0"
              ref={(el) => {
                leads.current[id] = el;
              }}
            />
          ))}
        </svg>

        {/* The measurement overlay. Drawn in the DOM rather than in WebGL for
            the same reason the tags are: it is type, and it has to be set in
            the site's own. The wedge is under the lines so the strokes stay
            crisp on top of it. */}
        <svg className="rig__angle" aria-hidden="true">
          <path className="rig__angle-wedge" ref={angWedge} opacity="0" />
          <line className="rig__angle-base" ref={angBase} opacity="0" />
          <line className="rig__angle-seg" ref={angSeg} opacity="0" />
          <path className="rig__angle-arc" ref={angArc} opacity="0" />
          <text className="rig__angle-lab" ref={angLab} opacity="0" />
        </svg>

        {TAG_IDS.map((id) => (
          <p
            key={id}
            className="rig__tag"
            data-side={TAGS[id].side}
            data-v={TAGS[id].v}
            ref={(el) => {
              tags.current[id] = el;
            }}
          >
            {TAGS[id].text}
          </p>
        ))}

        {/* The debrief. Not `aria-hidden`, unlike every other overlay in the
            stage: the tags and the angle annotate a picture, but this is the
            one thing in the sequence that is prose, and it is the thing the
            whole scroll has been building to. A reader who never sees the
            figure should still get the summary. */}
        <aside className="rig__card card-sum" ref={card} aria-labelledby="rig-card-h">
          <h3 className="card-sum__k" id="rig-card-h" ref={blockRef(cardBlocks, 0)}>
            {POST_SET.label}
          </h3>
          {POST_SET.paras.map((text, i) => (
            <p className="card-sum__b" key={i} ref={blockRef(cardBlocks, i + 1)}>
              {text}
            </p>
          ))}
          <ol className="card-sum__cues" ref={blockRef(cardBlocks, CARD_BLOCKS - 1)}>
            {POST_SET.cues.map((cue) => (
              <li key={cue}>{cue}</li>
            ))}
          </ol>
        </aside>
      </div>
    </section>
  );
}
