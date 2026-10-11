/**
 * The page's stops, as real sections of real text in reading order — what a
 * search engine and a screen reader get, and what the still page (reduced
 * motion, no WebGL) shows as-is.
 *
 * On the live page each stop is a stretch of scroll (`--span` screens) whose
 * text is fixed over the scene and racked in and out of focus by useJourney.
 * Everything here that follows the scene — the phone's readout, the flow's
 * steps, the read writing itself out — is written from one ticker, straight to
 * the DOM.
 *
 * Copy rules carried over from the app: the only numbers on screen are degrees,
 * bar speeds (m/s) and rep/set numbers, computed from the pose, never typed; no
 * cause-and-effect claims; a rep that doesn't count is not called a fault.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

import { cardBlockAmount } from "@/lib/postSet";
import { FLOW_STEPS, PHONE_SAYS, readAt } from "@/lib/flowScript";
import { BAR_READ_BLOCKS, barTagAt } from "@/lib/barbellScript";
import { STOPS, holdAt, stopIndex, type StopId } from "@/lib/story";
import { store } from "@/stage/store";
import { onTick } from "@/hooks/ticker";
import { Scrambler } from "@/hooks/scramble";
import { Compare } from "./Compare";
import { Flow, READ_BLOCKS } from "./Flow";
import { Barbell } from "./Barbell";
import { Foot } from "./Foot";
import { refract } from "@/lib/liquidGlass";

const FLOW = stopIndex("flow");

const TRY_URL = "https://try.neurofit-training.com";
/** The hint to touch the body shows once it has formed. */
const HINT_AFTER_S = 2.6;

function Stop({ id, children, labelledBy }: { id: StopId; children: ReactNode; labelledBy: string }) {
  const stop = STOPS[stopIndex(id)];
  return (
    <section
      id={id === "form" ? "top" : id}
      className={`stop stop--${id}`}
      data-stop={id}
      aria-labelledby={labelledBy}
      style={{ "--span": stop.span } as CSSProperties}
    >
      <div className="stop__frame">{children}</div>
    </section>
  );
}

export function Journey({ live }: { live: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const cta = useRef<HTMLAnchorElement>(null);

  // The finale's button bends the scene through its rim (Chromium; elsewhere frosted).
  useEffect(() => (cta.current ? refract(cta.current, { blur: 6, saturate: 1.8, strength: 1.2 }) : undefined), []);

  useEffect(() => {
    const el = root.current;
    if (!live || !el) return;
    const q = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector<T>(sel);
    const hint = q(".hint");
    // The phone's own readout, over the phone: in the setup stop, and in the
    // flow, where it says what the phone is doing at each step; and over the
    // bar in the barbell stop, where it says what the app reads off the bar.
    const tags = Array.from(el.querySelectorAll<HTMLElement>(".phone-tag")).map((node) => ({
      node,
      tag: node.dataset.tag,
      text: new Scrambler(node),
    }));
    const all = (sel: string) => Array.from(el.querySelectorAll<HTMLElement>(sel));
    // The two scripted stops: their steps, lit from the scene's step, and the
    // read each ends on, written out by the scroll.
    const scripts = [
      { parts: all("[data-flow] [data-step]"), shown: -2, typed: all("[data-flow] [data-typed]"), blocks: READ_BLOCKS },
      { parts: all("[data-barbell] [data-step]"), shown: -2, typed: all("[data-barbell] [data-typed]"), blocks: BAR_READ_BLOCKS },
    ].map((x) => ({ ...x, typedLen: x.typed.map(() => -1) }));
    const [flow, bar] = scripts;
    const barReps = all(".barset__rep");
    const barRead = q("[data-barbell] [data-read]");
    let barDone = -1;
    const streamDots = all(".flow__stream i");
    let streamShown = -1;
    let readyAt = 0;

    const off = onTick((now) => {
      const s = store;
      if (s.ready && !readyAt) readyAt = now;
      hint?.classList.toggle("is-on", readyAt > 0 && now - readyAt > HINT_AFTER_S * 1000);

      // The phone's readout. In the setup it faces the body head-on, and the
      // app settles its view while the lifter stands still; in the flow it
      // says what the scene's step has the phone doing.
      const flowSays = s.flowStep >= 0 ? PHONE_SAYS[FLOW_STEPS[s.flowStep].id] : PHONE_SAYS.camera;
      for (const tag of tags) {
        tag.text.set(tag.tag === "flow" ? flowSays : tag.tag === "bar" ? barTagAt(s.barFrame) : "Front view · locked", now);
        // Centred over its point, but kept on screen: near an edge — the flow
        // puts the phone close to a phone's right edge — it slides in.
        const at = tag.tag === "bar" ? s.barTag : s.phone;
        const w = tag.node.offsetWidth;
        // The bar's tag starts at its point and runs right; the others centre.
        const x = tag.tag === "bar" ? Math.min(window.innerWidth - w - 8, at.x) : Math.min(window.innerWidth - w / 2 - 8, Math.max(w / 2 + 8, at.x));
        tag.node.style.transform = `translate(${x}px, ${at.y}px)`;
      }

      // The scripted stops: the step the scene is on is open, the ones before
      // it done — forward and back as the reader scrolls.
      for (const [sc, step] of [
        [flow, s.flowStep],
        [bar, s.barFrame.step],
      ] as const) {
        if (step === sc.shown) continue;
        sc.shown = step;
        for (const part of sc.parts) {
          const k = Number(part.dataset.step);
          part.classList.toggle("is-on", k === step || (part.tagName !== "LI" && k <= step));
          part.classList.toggle("is-done", part.tagName === "LI" && k < step);
        }
      }
      // Each rep's speed shows as it locks out.
      if (s.barFrame.done !== barDone) {
        barDone = s.barFrame.done;
        barReps.forEach((rep, k) => rep.classList.toggle("is-on", k < barDone));
      }

      // The dots going out across the border, scrubbed by the scroll like the
      // rest of the flow: each falls through the border and fades, staggered.
      if (s.flowStream !== streamShown) {
        streamShown = s.flowStream;
        streamDots.forEach((dot, i) => {
          const ph = (((s.flowStream + i / streamDots.length) % 1) + 1) % 1;
          dot.style.transform = `translateY(${(ph * 75).toFixed(1)}px)`;
          dot.style.opacity = String(Math.min(1, ph / 0.2, (1 - ph) / 0.2));
        });
      }

      // The reads coming back write themselves out as the reader scrolls
      // through the end of each stop, and un-write on the way back up.
      barRead?.classList.toggle("is-on", s.barFrame.read > 0);
      for (const [sc, cardT] of [
        [flow, readAt(holdAt(s.progress, FLOW))],
        [bar, s.barFrame.read],
      ] as const) {
        sc.typed.forEach((span, i) => {
          const full = sc.blocks[i];
          const n = Math.round(full.length * cardBlockAmount(cardT, i));
          if (n !== sc.typedLen[i]) {
            sc.typedLen[i] = n;
            span.textContent = full.slice(0, n);
            span.classList.toggle("is-typing", n > 0 && n < full.length);
          }
        });
      }
    });
    return off;
  }, [live]);

  return (
    <div className="journey__stops" ref={root}>
      <Stop id="form" labelledBy="h-form">
        <div className="copy copy--left copy--hero">
          <h1 className="h1" id="h-form">
            Every rep, seen from outside.
          </h1>
          <p className="lede">
            Neuro-Fit watches your squats, push-ups and pull-ups through your phone camera — and the bar, when you
            squat loaded — and tells you what your form actually did. Prop the phone up, do your set, and get a plain
            read on it — after the set, and again at the end of the workout.
          </p>
          <p className="hint" aria-hidden="true" data-live-only>
            <span className="hint__mouse">Drag across the body</span>
            <span className="hint__touch">Swipe across the body</span>
          </p>
        </div>
        {!live && (
          <img
            className="still"
            src="/body-still.webp"
            width="960"
            height="1200"
            alt="A human figure made of thousands of grey particles, standing in pale blue fog."
          />
        )}
      </Stop>

      <Stop id="frame" labelledBy="h-frame">
        <div className="copy copy--left">
          <h2 className="h2" id="h-frame">
            Get yourself in frame.
          </h2>
          <p>
            No wearable, nothing to strap on: a phone, something to lean it against, and room to move. Stand back
            until all of you fits on screen. It works out whether it’s looking at you from the side or head-on,
            settles on that while you hold still, and only judges what that view can actually see — anything it
            can’t see is marked unknown, never passed.
          </p>
        </div>
        <div className="phone-tag" aria-hidden="true" data-live-only />
      </Stop>

      <Stop id="flow" labelledBy="h-flow">
        <Flow live={live} />
        <div className="phone-tag" data-tag="flow" aria-hidden="true" data-live-only />
      </Stop>

      <Stop id="barbell" labelledBy="h-barbell">
        <Barbell live={live} />
        <div className="phone-tag phone-tag--bar" data-tag="bar" aria-hidden="true" data-live-only />
      </Stop>

      <Stop id="compare" labelledBy="h-compare">
        <Compare />
      </Stop>

      <Stop id="finale" labelledBy="h-finale">
        <div className="finale">
          <h2 className="h2" id="h-finale">
            Try it on your next set.
          </h2>
          <a className="lg-btn lg-btn--big" href={TRY_URL} data-focus-only ref={cta}>
            Try it out
          </a>
          <p className="price">
            Everything the camera does is free and runs on your device. The written reads after a set and after a
            workout use your own Gemini API key, pasted into Settings. No account, no card.
          </p>
          <Foot />
        </div>
      </Stop>
    </div>
  );
}
