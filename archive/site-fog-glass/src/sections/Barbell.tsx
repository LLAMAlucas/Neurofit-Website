/**
 * Load the bar — the words beside the barbell stop's scene
 * (lib/barbellScript). One step per thing the scene shows: the ring finding
 * the plate, the bar's path, its speed rep by rep, and the rep that drifts and
 * stalls — then the read after the set, writing itself out as the reader
 * scrolls.
 *
 * Built like the flow (Flow.tsx) and styled by its classes: on the live page
 * the step the scene is on is open and the others are just their titles
 * (Journey writes `is-on` / `is-done` from the scene's step); on the still page
 * every step is open, every speed shown and the read written out in full.
 *
 * Every number here is measured off the bar's path in lib/barbellScript —
 * none is typed.
 */
import type { CSSProperties } from "react";

import { BAR_READ_BLOCKS, BAR_REPS, BSTEP, speedText, type BarStepId } from "@/lib/barbellScript";

type Step = { id: BarStepId; title: string; text: string };

export const BAR_STEP_TEXT: readonly Step[] = [
  { id: "find", title: "Finds the bar", text: "It spots the plates and locks onto the bar." },
  { id: "path", title: "Bar path", text: "Every rep’s path, traced as you lift." },
  { id: "speed", title: "Bar speed", text: "Speed in m/s, rep by rep, so you can see the set slowing down." },
  {
    id: "drift",
    title: "Drift and sticking points",
    text: "Reps where the bar drifts off mid-foot or stalls on the way up get a closer look in your read after the set.",
  },
];

const FASTEST = Math.max(...BAR_REPS.map((r) => r.mcv));

export function Barbell({ live }: { live: boolean }) {
  return (
    <div className="panel flow barbell" data-barbell data-focus-only="">
      <h2 className="h2" id="h-barbell">
        Load the bar.
      </h2>
      <p className="barbell__lede">
        On loaded squats it tracks the barbell too — from the same phone, with nothing clipped to the bar.
      </p>

      <ol className="flow__steps">
        {BAR_STEP_TEXT.map((s) => (
          <li key={s.id} className="flow__step" data-step={BSTEP[s.id]}>
            <span className="flow__title">{s.title}</span>
            <span className="flow__text">{s.text}</span>
          </li>
        ))}
      </ol>

      {/* Each rep's speed, filling in as the rep locks out (Journey). */}
      <div className="barset" data-step={BSTEP.speed} role="img" aria-label={`Bar speed, rep by rep: ${BAR_REPS.map((_, k) => speedText(k)).join(", ")} metres a second`}>
        {BAR_REPS.map((r, k) => (
          <span key={k} className={`barset__rep${live ? "" : " is-on"}`} style={{ "--v": r.mcv / FASTEST } as CSSProperties}>
            <i />
            <b>{speedText(k)}</b>
          </span>
        ))}
        <span className="barset__unit">m/s</span>
      </div>

      <article className={`flow__read barbell__read${live ? "" : " is-on"}`} data-read aria-label="An example of a post-set read, for the loaded set above">
        <span className="debrief__kind">Example</span>
        {BAR_READ_BLOCKS.map((text, i) => {
          const cls = i === 0 ? "debrief__label" : i === BAR_READ_BLOCKS.length - 1 ? "debrief__cues" : "debrief__p";
          return (
            <p key={i} className={cls}>
              <span className="sr-only">{text}</span>
              <span aria-hidden="true" data-typed="barbell">
                {live ? "" : text}
              </span>
            </p>
          );
        })}
      </article>
    </div>
  );
}
