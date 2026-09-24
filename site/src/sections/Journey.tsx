/**
 * The page's stops, as real sections of real text in reading order — what a
 * search engine and a screen reader get, and what the still page (reduced
 * motion, no WebGL) shows as-is.
 *
 * On the live page each stop is a stretch of scroll (`--span` screens) whose
 * text is fixed over the scene and racked in and out of focus by useJourney.
 * Everything here that follows the scene — the counter and the angles, the line
 * of each list that lights, the labels pinned over figures, the debrief writing
 * itself out — is written from one ticker, straight to the DOM.
 *
 * Copy rules carried over from the app: the only numbers on screen are degrees
 * and rep/set numbers, computed from the pose, never typed; no cause-and-effect
 * claims; a rep that doesn't count is not called a fault.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

import { EXERCISES, type ExerciseId } from "@/lib/exercises";
import { CARD_BLOCKS, POST_SET, cardBlockAmount } from "@/lib/postSet";
import { STOPS, stopIndex, type StopId } from "@/lib/story";
import { store } from "@/stage/store";
import { onTick } from "@/hooks/ticker";
import { Scrambler } from "@/hooks/scramble";
import { Foot } from "./Foot";
import { refract } from "@/lib/liquidGlass";

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

/**
 * One exercise: what counts as a rep, and the list of what it watches for.
 * While the body runs the exercise's set, the line for the rep in progress
 * lights — red for a fault, dark for a clean rep or one that didn't count — and
 * the counter and two angles read off the live pose.
 */
function ExerciseStop({
  id,
  heading,
  counts,
  side,
}: {
  id: ExerciseId;
  heading: string;
  counts: string;
  side: "left" | "right";
}) {
  const spec = EXERCISES[id];
  return (
    <Stop id={id} labelledBy={`h-${id}`}>
      <div className={`copy copy--${side} copy--exercise`}>
        <h2 className="h2" id={`h-${id}`}>
          {heading}
        </h2>
        <p>{counts} On every rep, it watches for:</p>
        <ul className="checks" data-checks={id}>
          {spec.checks.map((c) => (
            <li key={c.id} className="checks__item" data-check={c.id} data-kind={c.kind}>
              {c.label}
              {c.kind === "miss" && <span className="checks__note"> — didn’t count</span>}
            </li>
          ))}
        </ul>
      </div>

      <div className={`readout readout--${side === "left" ? "right" : "left"}`} aria-hidden="true" data-live-only data-readout={id}>
        <div className="readout__label">Reps</div>
        <div className="readout__reps" data-read="reps">
          00
        </div>
        <div>
          {spec.readouts[0].label} <span data-read="a">—</span> · {spec.readouts[1].label} <span data-read="b">—</span>
        </div>
      </div>
    </Stop>
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
    const phoneTag = q(".phone-tag");
    const labels = Array.from(el.querySelectorAll<HTMLElement>(".set-label"));
    const typed = Array.from(el.querySelectorAll<HTMLElement>("[data-typed]"));
    const debriefStop = el.querySelector<HTMLElement>("[data-stop=afterSet]");
    const phoneText = phoneTag ? new Scrambler(phoneTag) : null;
    let readyAt = 0;
    const typedLen = typed.map(() => -1);

    // Each exercise stop's list and readout, and what each last showed — the
    // DOM is only touched when something changes.
    const stops = (Object.keys(EXERCISES) as ExerciseId[]).map((id) => ({
      id,
      items: Array.from(el.querySelectorAll<HTMLElement>(`[data-checks=${id}] [data-check]`)),
      reps: q(`[data-readout=${id}] [data-read=reps]`),
      a: q(`[data-readout=${id}] [data-read=a]`),
      b: q(`[data-readout=${id}] [data-read=b]`),
      lit: "",
      text: ["", "", ""],
    }));
    const put = (node: HTMLElement | null, text: string, last: string[], i: number) => {
      if (node && last[i] !== text) node.textContent = last[i] = text;
    };

    const off = onTick((now) => {
      const s = store;
      if (s.ready && !readyAt) readyAt = now;
      hint?.classList.toggle("is-on", readyAt > 0 && now - readyAt > HINT_AFTER_S * 1000);

      // The exercise stops: only the one whose set is playing is live.
      for (const st of stops) {
        const mine = s.exercise === st.id;
        const lit = mine ? (s.lit ?? "") : "";
        if (lit !== st.lit) {
          st.lit = lit;
          for (const li of st.items) li.classList.toggle("is-on", li.dataset.check === lit);
        }
        if (mine) {
          put(st.reps, String(s.reps).padStart(2, "0"), st.text, 0);
          put(st.a, `${Math.round(s.readA)}°`, st.text, 1);
          put(st.b, `${Math.round(s.readB)}°`, st.text, 2);
        }
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
            Neuro-Fit watches your squats, push-ups and pull-ups through your phone camera and tells you what your
            form actually did. Prop the phone up, do your set, and get a plain read on it — after the set, and again
            at the end of the workout.
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

      <ExerciseStop
        id="squat"
        side="right"
        heading="Squats, rep by rep."
        counts="A rep counts only when you reach the depth you picked."
      />
      <ExerciseStop
        id="pushup"
        side="left"
        heading="Push-ups, rep by rep."
        counts="A rep counts only when you get down to depth and lock your arms out at the top."
      />
      <ExerciseStop
        id="pullup"
        side="right"
        heading="Pull-ups, rep by rep."
        counts="A rep counts from a dead hang until your chin clears the bar."
      />

      <Stop id="afterSet" labelledBy="h-afterSet">
        <div className="copy copy--left copy--narrow">
          <h2 className="h2" id="h-afterSet">
            Find out how that one went.
          </h2>
          <p>
            End the set and ask for a read: a few sentences on what it actually did, measured against your own first
            couple of reps. Only when you ask for it.
          </p>
          <p className="fine">
            Your video stays on your phone. Asking for a read sends a handful of still frames from the set; the
            end-of-workout summary sends none.
          </p>
        </div>

        <article className="debrief" aria-label="An example of a post-set summary, for a set of pull-ups">
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
          <h2 className="h2" id="h-afterWorkout">
            See the pattern across sets.
          </h2>
          <p>
            One read across the whole session: what kept happening, what was a one-off, and what genuinely changed as
            you got tired — judged on how your reps slowed, not assumed because it was the last set.
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
            Everything the camera does is free and runs on your device. The written reads after a set and after a
            workout use your own Gemini API key, pasted into Settings. No account, no card.
          </p>
          <Foot />
        </div>
      </Stop>
    </div>
  );
}
