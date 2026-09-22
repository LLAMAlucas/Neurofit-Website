/**
 * The page's six stops, as real sections of real text in reading order — what
 * a search engine and a screen reader get, and what the still page (reduced
 * motion, no WebGL) shows as-is.
 *
 * On the live page each stop is a stretch of scroll (`--span` screens) whose
 * text is fixed over the scene and racked in and out of focus by useJourney.
 * Everything here that follows the scene — readouts, the fault tag, the labels
 * pinned over figures, the debrief writing itself out — is written from one
 * ticker, straight to the DOM.
 *
 * Copy rules carried over from the app: the only numbers on screen are degrees
 * and rep/set numbers, computed from the pose, never typed; no cause-and-effect
 * claims; shoulder tilt is never shown as a fault.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

import { FAULTS, FAULT_ORDER, planeVisibility, viewLabel, type FaultId } from "@/lib/faultDemo";
import { CARD_BLOCKS, POST_SET, cardBlockAmount } from "@/lib/postSet";
import { STOPS, stopIndex, type StopId } from "@/lib/story";
import { store } from "@/stage/store";
import { onTick } from "@/hooks/ticker";
import { Scrambler } from "@/hooks/scramble";
import { Foot } from "./Foot";
import { GlassSegment, refract } from "@/lib/liquidGlass";

const TRY_URL = "https://try.neurofit-training.com";
/** The hint to touch the body shows once it has formed. */
const HINT_AFTER_S = 2.6;
/** Where the fault tag sits relative to the point it labels, CSS px. */
const TAG_OFFSET = { x: 110, y: -84 };

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

/** The debrief's blocks: the label, each paragraph, then the cues as one. */
const DEBRIEF_BLOCKS: string[] = [POST_SET.label, ...POST_SET.paras, POST_SET.cues.join(" ")];

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
    const view = q("[data-read=view]");
    const judge = q("[data-read=judge]");
    const reps = q("[data-read=reps]");
    const knee = q("[data-read=knee]");
    const trunk = q("[data-read=trunk]");
    const tag = q(".tag");
    const leader = el.querySelector<SVGSVGElement>(".leader");
    const line = leader?.querySelector("line") ?? null;
    const dot = leader?.querySelector("circle") ?? null;
    const phoneTag = q(".phone-tag");
    const labels = Array.from(el.querySelectorAll<HTMLElement>(".set-label"));
    const typed = Array.from(el.querySelectorAll<HTMLElement>("[data-typed]"));
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>("[data-fault]"));
    // One glass droplet for the picker: it forms on the rep being played and melts
    // away when the demo is free again. Picking is by tap only (no drag): the row is
    // locked while a rep plays, which is exactly when the droplet exists.
    const row = q(".picker__row");
    const glass = row ? new GlassSegment(row) : null;
    let pressed: HTMLElement | null = null;
    const debriefStop = el.querySelector<HTMLElement>("[data-stop=afterSet]");
    const tagText = tag ? new Scrambler(tag) : null;
    const viewText = view ? new Scrambler(view) : null;
    const phoneText = phoneTag ? new Scrambler(phoneTag) : null;
    let readyAt = 0;
    const typedLen = typed.map(() => -1);

    const off = onTick((now) => {
      const s = store;
      if (s.ready && !readyAt) readyAt = now;
      hint?.classList.toggle("is-on", readyAt > 0 && now - readyAt > HINT_AFTER_S * 1000);

      // Squat: what the lens can judge from here, and the rep in hand.
      viewText?.set(viewLabel(s.viewAzimuth), now);
      if (judge) {
        const can: string[] = [];
        if (planeVisibility("frontal", s.viewAzimuth) > 0.5) can.push("knee cave");
        if (planeVisibility("sagittal", s.viewAzimuth) > 0.5) can.push("forward lean");
        const text = can.length ? `Can judge: ${can.join(", ")}` : "Can judge: neither fault";
        if (judge.textContent !== text) judge.textContent = text;
      }
      if (reps) reps.textContent = String(s.reps).padStart(2, "0");
      if (knee) knee.textContent = `${Math.round(s.knee)}°`;
      if (trunk) trunk.textContent = `${Math.round(s.trunk)}°`;

      // The tag: what the lens concluded about the rep in progress (or the one
      // that just ended). A fault it can't see from here is UNKNOWN, never
      // clean — silence from a check that couldn't run is not a pass.
      const squatLive = document.body.dataset.stop === "squat";
      const f = FAULTS[s.fault];
      const repNo = s.phase === "rep" ? s.reps + 1 : s.reps;
      let desired = "";
      let kind = "";
      if (squatLive && f.plane) {
        if ((s.phase === "rep" && s.envelope > 0.05) || s.tagHold > 0) {
          const seen = s.visibility > 0.5;
          desired = seen ? `${f.tag} · rep ${repNo}` : "Not visible from this angle · unknown";
          kind = seen ? "is-fault" : "is-unknown";
        }
      } else if (squatLive && s.tagHold > 0) {
        desired = `Rep ${repNo} · nothing flagged`;
        kind = "is-clean";
      }
      if (tag && line && dot && leader) {
        if (desired) {
          tagText?.set(desired, now);
          tag.className = `tag is-on ${kind}`;
          // Off to the right of the fault — or its left, where the right edge
          // of a narrow screen would cut the tag off.
          const w = tag.offsetWidth;
          const right = s.anchor.x + TAG_OFFSET.x + w <= window.innerWidth - 8;
          const tx = right ? s.anchor.x + TAG_OFFSET.x : Math.max(8, s.anchor.x - TAG_OFFSET.x - w);
          const ty = s.anchor.y + TAG_OFFSET.y;
          tag.style.transform = `translate(${tx}px, ${ty}px)`;
          line.setAttribute("x1", String(s.anchor.x));
          line.setAttribute("y1", String(s.anchor.y));
          line.setAttribute("x2", String(right ? tx - 6 : tx + w + 6));
          line.setAttribute("y2", String(ty + 8));
          dot.setAttribute("cx", String(s.anchor.x));
          dot.setAttribute("cy", String(s.anchor.y));
          leader.classList.add("is-on");
        } else {
          tag.className = "tag";
          leader.classList.remove("is-on");
        }
      }
      const busy = s.phase !== "idle" || s.request !== null;
      let on: HTMLElement | null = null;
      for (const b of buttons) {
        const isOn = busy && s.fault === b.dataset.fault;
        b.setAttribute("aria-disabled", String(busy));
        b.setAttribute("aria-pressed", String(isOn));
        if (isOn) on = b;
      }
      if (on !== pressed) {
        pressed = on;
        glass?.setActive(on);
      }

      // In frame: the phone's own readout, over the phone. It faces the body
      // head-on, and the app settles its view while the lifter stands still.
      if (phoneTag) {
        phoneText?.set("Front view · locked", now);
        phoneTag.style.transform = `translate(${s.phone.x}px, ${s.phone.y}px)`;
      }

      // After the workout: which set each figure is.
      labels.forEach((lab, i) => {
        const p = s.labels[i];
        if (p) lab.style.transform = `translate(${p.x}px, ${p.y}px)`;
      });

      // After the set: the debrief writes itself out as the reader scrolls
      // through the stop, and un-writes on the way back up.
      const local = debriefStop ? parseFloat(debriefStop.style.getPropertyValue("--local")) || 0 : 0;
      const cardT = Math.min(1, Math.max(0, (local - 0.24) / 0.46));
      typed.forEach((span, i) => {
        const full = DEBRIEF_BLOCKS[i];
        const n = Math.round(full.length * cardBlockAmount(cardT, i));
        if (n !== typedLen[i]) {
          typedLen[i] = n;
          span.textContent = full.slice(0, n);
          span.classList.toggle("is-typing", n > 0 && n < full.length);
        }
      });
    });
    return () => {
      off();
      glass?.destroy();
    };
  }, [live]);

  const pick = (id: FaultId) => {
    if (store.phase !== "idle" || store.request) return;
    store.request = id;
  };

  return (
    <div className="journey__stops" ref={root}>
      <Stop id="form" labelledBy="h-form">
        <div className="copy copy--left copy--hero">
          {/* HEADLINE: a placeholder — the final line is being written. */}
          <h1 className="h1" id="h-form">
            You can’t see your own squat.
          </h1>
          <p className="lede">
            Neuro-Fit watches you through your phone camera and tells you what your form actually did.
            Prop the phone against something, do your set, and get a plain read on it — after the set,
            and again at the end of the workout.
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
          <span className="eyebrow">01 — Before</span>
          <h2 className="h2" id="h-frame">
            Get yourself in frame.
          </h2>
          <p>
            No wearable, nothing to strap on: a phone, a wall to lean it against, and room to squat.
            Stand back until all of you fits on screen. It works out whether it’s looking at you from the
            side or head-on, settles on that while you’re standing still, and tells you when it’s ready.
          </p>
        </div>
        <div className="phone-tag" aria-hidden="true" data-live-only />
      </Stop>

      <Stop id="squat" labelledBy="h-squat">
        <div className="copy copy--right">
          <span className="eyebrow">02 — During</span>
          <h2 className="h2" id="h-squat">
            Squat. Watch the count.
          </h2>
          <p>A rep only counts when you reach the depth you asked for.</p>
          <p>
            From the side, it can see how deep you got and how far you tipped forward. Head-on, it can see
            a knee falling inward. It can’t see both at once — so whatever it can’t see, it marks as
            unknown rather than passed.
          </p>
        </div>

        <div className="readout" aria-hidden="true" data-live-only>
          <div className="readout__label">////// View</div>
          <div className="readout__big" data-read="view">
            —
          </div>
          <div data-read="judge" />
          <div className="readout__label readout__gap">Reps</div>
          <div className="readout__reps" data-read="reps">
            00
          </div>
          <div>
            Knee <span data-read="knee">—</span> · Trunk <span data-read="trunk">—</span>
          </div>
        </div>

        <svg className="leader" aria-hidden="true" data-live-only>
          <line />
          <circle r="3" />
        </svg>
        <div className="tag" role="status" aria-live="polite" data-live-only />

        <div className="picker" data-live-only>
          <p className="picker__prompt" id="picker-prompt">
            Pick a rep for it to catch
          </p>
          <div className="lg-seg picker__row" role="group" aria-labelledby="picker-prompt">
            <span className="lg-seg__thumb" aria-hidden="true" />
            {FAULT_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                className="lg-seg__item"
                data-lg-item=""
                data-fault={id}
                onClick={() => pick(id)}
              >
                {FAULTS[id].label}
              </button>
            ))}
            <span className="lg-seg__lens" aria-hidden="true" />
          </div>
          <p className="picker__hint" aria-hidden="true">
            <span className="hint__mouse">Drag the body to look around · ← →</span>
            <span className="hint__touch">Pick a rep and the view turns to see it</span>
          </p>
        </div>
      </Stop>

      <Stop id="afterSet" labelledBy="h-afterSet">
        <div className="copy copy--left copy--narrow">
          <span className="eyebrow">03 — After the set</span>
          <h2 className="h2" id="h-afterSet">
            Find out how that one went.
          </h2>
          <p>
            End the set and ask for a read: a few sentences on what it actually did, measured against your
            own first couple of reps. Only when you ask for it.
          </p>
          <p className="fine">
            Your video stays on your phone. Asking for a read sends a handful of still frames from the set;
            the end-of-workout summary sends none.
          </p>
        </div>

        <article className="debrief" aria-label="An example of a post-set summary">
          <span className="debrief__kind">Example</span>
          {DEBRIEF_BLOCKS.map((text, i) => {
            const cls = i === 0 ? "debrief__label" : i === CARD_BLOCKS - 1 ? "debrief__cues" : "debrief__p";
            return (
              <p key={i} className={cls}>
                <span className="sr-only">{text}</span>
                <span aria-hidden="true" data-typed>
                  {live ? "" : text}
                </span>
              </p>
            );
          })}
        </article>
      </Stop>

      <Stop id="afterWorkout" labelledBy="h-afterWorkout">
        <div className="copy copy--left copy--top">
          <span className="eyebrow">04 — After the workout</span>
          <h2 className="h2" id="h-afterWorkout">
            See the pattern across sets.
          </h2>
          <p>
            One read across the whole session: what kept happening, what was a one-off, and what genuinely
            changed as you got tired — judged on how your reps slowed, not assumed because it was the last
            set.
          </p>
        </div>
        {[1, 2, 3].map((n) => (
          <span key={n} className="set-label" aria-hidden="true" data-live-only>
            Set {n}
          </span>
        ))}
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
            Everything the camera does is free, for good — it runs on your phone. Your first{" "}
            <span className="tbd">[N]</span> coached sessions are free; after that, your own Gemini key or a
            small flat fee. No subscription, no card to start.
          </p>
          <Foot />
        </div>
      </Stop>
    </div>
  );
}
