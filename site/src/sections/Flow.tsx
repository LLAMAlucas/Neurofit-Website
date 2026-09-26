/**
 * What happens to what the camera sees — the words beside the flow stop's
 * scene (lib/flowScript). One step per thing the scene shows: the phone's scan,
 * the 33 points, the turn to the side, the flagged squat, and the read going
 * out across the border — then the post-set read coming back, writing itself
 * out as the reader scrolls.
 *
 * On the live page the step the scene is on is open and the others are just
 * their titles (Journey writes `is-on` / `is-done` from the scene's step); on
 * the still page every step is open and the read is written out in full.
 *
 * Every step is what the app does today (see the tracker's CLAUDE.md): the
 * local layer only FLAGS a rep worth a closer look — Gemini is what judges it.
 */
import { CARD_BLOCKS, POST_SET } from "@/lib/postSet";
import { STEP, type FlowStepId } from "@/lib/flowScript";

type Step = { id: FlowStepId; title: string; text: string };

export const DEVICE_STEPS: readonly Step[] = [
  { id: "camera", title: "Camera", text: "Read frame by frame in your browser. The video stays on your device." },
  { id: "points", title: "33 points on your body", text: "A pose model finds your joints in every frame." },
  {
    id: "view",
    title: "Which view",
    text: "Side-on or head-on. It only judges what that view can see; the rest is marked unknown.",
  },
  {
    id: "reps",
    title: "Reps and flags",
    text: "Each rep is counted against the standard you picked, and reps worth a closer look are flagged.",
  },
];

export const ASK_STEP: Step = {
  id: "ask",
  title: "After the set",
  text: "The set's numbers and a few still frames go to Gemini under your own key. It judges what the flagged reps really did.",
};

/** The read's blocks: the label, each paragraph, then the cues as one. */
export const READ_BLOCKS: string[] = [POST_SET.label, ...POST_SET.paras, POST_SET.cues.join(" ")];

/** Dots in the stream going out across the border. */
const STREAM_DOTS = 7;

function Row({ step }: { step: Step }) {
  return (
    <li className="flow__step" data-step={STEP[step.id]}>
      <span className="flow__title">{step.title}</span>
      <span className="flow__text">{step.text}</span>
    </li>
  );
}

export function Flow({ live }: { live: boolean }) {
  return (
    <div className="panel flow" data-flow data-focus-only="">
      <h2 className="h2" id="h-flow">
        What happens to what it sees.
      </h2>

      <p className="flow__zone-label">On your device, every frame</p>
      <ol className="flow__steps">
        {DEVICE_STEPS.map((s) => (
          <Row key={s.id} step={s} />
        ))}
      </ol>

      <div className="flow__border" data-step={STEP.ask}>
        <span className="flow__stream" aria-hidden="true">
          {/* Placed by the scroll (Journey), like the rest of the flow. */}
          {Array.from({ length: STREAM_DOTS }, (_, i) => (
            <i key={i} />
          ))}
        </span>
        <span className="flow__border-label">Leaves your device only when you ask</span>
      </div>

      <ol className="flow__steps flow__steps--ask">
        <Row step={ASK_STEP} />
      </ol>

      <article className="flow__read" data-step={STEP.ask} aria-label="An example of a post-set read, for the set of squats above">
        <span className="debrief__kind">Example</span>
        {READ_BLOCKS.map((text, i) => {
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
    </div>
  );
}
