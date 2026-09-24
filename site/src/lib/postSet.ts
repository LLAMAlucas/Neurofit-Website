/**
 * The example debrief the "after the set" stop writes out, and the numbers in it.
 * The page labels it an EXAMPLE: the reader didn't film this set.
 *
 * It is the set of pull-ups the page has just shown — the pull-up stop's scripted
 * loop, rep for rep (lib/exercises: clean, kip, clean, uneven, leg drive, chin
 * short). The reader watched it happen; this is what the app would hand back.
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
 * 1. NO NORMALISED NUMBERS. The app's payload carries pull ratios, clearances
 *    and velocities as image coordinates, and the model is forbidden from
 *    speaking them. Degrees and rep numbers are the exception — they are real
 *    units. And not every degree: the pull-up prompt lets the model quote the
 *    swing and the leg angles (in the image plane side-on) but NOT the elbow
 *    (projection-lenient). So this copy quotes those two, and rep numbers.
 *
 * 2. THE NUMBERS ARE MEASURED, NOT WRITTEN. Both come off the same poses the
 *    scene draws (see `KIP_SWING_DEG`, `LEG_DRIVE_DEG`), and the check
 *    re-derives them from the geometry. Edit a pose and the check fails rather
 *    than the page quietly quoting a figure the body can no longer produce.
 *
 * 3. NO CAUSATION, between faults or from context to fault. Each finding gets
 *    its own sentence, and no sentence says why.
 *
 * And no markdown. The app renders debriefs verbatim into a paragraph with no
 * parser, so an asterisk would reach a real user as an asterisk; a marketing
 * page that formatted the sample would be showing output the product can't
 * produce.
 */

/**
 * How far the body swings on the kipping rep, degrees: the RANGE of the
 * hands-to-hips angle over the rep, which is the quantity the app's swing check
 * reads (a strict rep keeps it to a few degrees).
 */
export const KIP_SWING_DEG = 27;

/**
 * How far the knees come up on the leg-drive rep, degrees: the thighs' lift off
 * the trunk line at its peak, side-on.
 */
export const LEG_DRIVE_DEG = 53;

export type PostSet = {
  /** Names the artefact: what the app hands back at the end of a set. */
  label: string;
  paras: readonly string[];
  cues: readonly string[];
};

export const POST_SET: PostSet = {
  label: "Post-set summary",
  paras: [
    /* What went RIGHT, first and unhedged. A debrief that opened on the faults
       would be describing a different set — and a page whose sample output was
       all faults would be selling a nag. */
    "Six reps, five counted. Reps 1 and 3 were clean — from a dead hang to the chin over the bar, the body quiet under it.",
    /* The findings, in rep order, each with the rep it happened on, each its
       own sentence (rule 3). The last one isn't a fault at all: the rep just
       didn't count, and it says so. */
    `Rep 2 swung, the body travelling through about ${KIP_SWING_DEG} degrees on the way up. Rep 4 came up with the left side trailing the right. Rep 5 drove with the legs, the knees coming up about ${LEG_DRIVE_DEG} degrees. Rep 6 stopped with the chin short of the bar and didn't count.`,
  ],
  /* Two, and phrased as things to do rather than things to stop doing. The app
     ends every debrief on exactly two: one is thin for a set with four
     findings, and a list long enough to be complete is a list nobody carries
     to the next set. */
  cues: [
    "Start every rep from a still, dead hang, legs together and quiet.",
    "Pull the elbows down to your ribs, both sides together, until the chin clears the bar.",
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
