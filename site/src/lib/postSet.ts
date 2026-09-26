/**
 * The example post-set read that comes back at the end of the flow stop, and
 * the number in it. The page labels it an EXAMPLE: the reader didn't film this
 * set.
 *
 * It is the squat the flow has just shown, side-on (lib/flowScript FLOW_SET:
 * two clean reps that set the baseline, then three leaning forward — the trunk
 * the phone flagged and kept flashing). This is what the app would hand back.
 * (It was the pull-up stop's set until the "after the set" stop was removed,
 * 2026-09-25.)
 *
 * PURE — no React, no DOM. It is a module and not a string in the component for
 * two reasons: the still page (reduced motion, no WebGL) has to show the SAME
 * debrief — a visitor who asked for no motion is not being sold a different
 * product — and the offscreen check has to be able to read it.
 *
 * ── what this copy is allowed to say ──────────────────────────────────────
 *
 * This is a page about an app that is careful about its claims, so the sample of
 * its output has to obey the app's own rules or the page is lying about the
 * product. Three of them bind every word here, and `check_site` enforces them:
 *
 * 1. NO NORMALISED NUMBERS. The app's payload carries depth ratios, gaps and
 *    velocities as image coordinates, and the model is forbidden from speaking
 *    them. Degrees and rep numbers are the exception — they are real units,
 *    and the squat's trunk lean is read side-on, in the plane it happens in.
 *    So this copy quotes one angle, and rep numbers.
 *
 * 2. THE NUMBER IS MEASURED, NOT WRITTEN. It comes off the same poses the
 *    scene draws (see `LEAN_EXTRA_DEG`), and the check re-derives it from the
 *    geometry. Edit a pose and the check fails rather than the page quietly
 *    quoting a figure the body can no longer produce.
 *
 * 3. NO CAUSATION, between faults or from context to fault. The finding gets
 *    its own sentence, and no sentence says why.
 *
 * And no markdown. The app renders debriefs verbatim into a paragraph with no
 * parser, so an asterisk would reach a real user as an asterisk; a marketing
 * page that formatted the sample would be showing output the product can't
 * produce.
 */

/**
 * How much further forward the trunk leans on the flagged reps than on the
 * two clean ones, degrees: the peak of the trunk's angle from vertical over a
 * lean rep, less the same over a clean rep. Baseline-relative, like the app's
 * own forward-lean check, which measures against your first two reps.
 */
export const LEAN_EXTRA_DEG = 20;

export type PostSet = {
  /** Names the artefact: what the app hands back at the end of a set. */
  label: string;
  paras: readonly string[];
  cues: readonly string[];
};

export const POST_SET: PostSet = {
  label: "Post-set summary",
  paras: [
    /* What went RIGHT, first and unhedged. A debrief that opened on the fault
       would be describing a different set — and a page whose sample output was
       all faults would be selling a nag. */
    "Five reps, five counted. Reps 1 and 2 were clean — down to depth with the chest up, the trunk steady all the way.",
    /* The finding: which reps, how much, against what — in one sentence, with
       no reason given for it (rule 3). */
    `Reps 3, 4 and 5 brought the chest forward at the bottom, about ${LEAN_EXTRA_DEG} degrees more lean than your first two.`,
  ],
  /* Two, and phrased as things to do rather than things to stop doing. The app
     ends every debrief on exactly two. */
  cues: [
    "Sit the hips back and keep the chest up through the bottom.",
    "Hold the trunk angle of your first two reps on every rep after them.",
  ],
};

/**
 * The panel's blocks, staggered.
 *
 * The panel used to arrive as one slab, which read as a card being placed on the
 * page. Written line by line it reads as the app answering — and because the
 * whole sequence is SCRUBBED rather than played, this cannot be a set of
 * transition delays: the reader controls the playhead, and scrolling back up has
 * to un-write it in the opposite order. So it is a pure function of the panel's
 * own progress, and each block gets its own window of it.
 *
 * `SPAN` is deliberately wide relative to `STEP`: the blocks overlap heavily, so
 * this is one gesture with a lead, not four separate entrances. The last block
 * still finishes at 0.94, comfortably before the panel's progress reaches 1, so
 * the debrief is fully written while the reader is still on it rather than
 * completing as it starts to leave.
 */
const STEP = 0.13;
const SPAN = 0.55;

export function cardBlockAmount(cardT: number, i: number): number {
  const a = i * STEP;
  const t = Math.min(1, Math.max(0, (cardT - a) / SPAN));
  return t * t * (3 - 2 * t);
}

/** How many blocks the panel lays out: the label, each paragraph, then the cues
 *  as one. The cues arrive together — they are a pair, and staggering the two
 *  items of a two-item list reads as a stutter rather than as a cascade. */
export const CARD_BLOCKS = 1 + POST_SET.paras.length + 1;
