/**
 * The debrief the closing panel shows, and the numbers in it.
 *
 * PURE — no React, no DOM. It is a module and not a string in the component for
 * two reasons: the reduced-motion path has to show the SAME debrief (a visitor
 * who asked for no motion is not being sold a different product), and the
 * offscreen check has to be able to read it.
 *
 * ── what this copy is allowed to say ──────────────────────────────────────
 *
 * This is a page about an app that is careful about its claims, so the sample of
 * its output has to obey the app's own rules or the page is lying about the
 * product. Four of them bind every word here, and `check_rig` enforces all four:
 *
 * 1. NO NORMALISED NUMBERS. The app's payload carries gap, depth-ratio, velocity
 *    and valgus as image coordinates, and the model is forbidden from speaking
 *    them: "-0.0023" reads as a rounding error, not as "a hair above parallel".
 *    Degrees and rep numbers are the exception — they are real units. So this
 *    copy quotes degrees and rep numbers, and nothing else.
 *
 * 2. THE NUMBERS ARE MEASURED, NOT WRITTEN. Both come off the same poses the
 *    scene draws (see `LEAN_DELTA_DEG`, `SHOULDER_PEAK_DEG`), and the check
 *    re-derives them from the geometry. Edit a keyframe and the check fails
 *    rather than the page quietly quoting a figure the animation stopped
 *    producing — which matters most for the shoulder angle, because the reader
 *    watches that exact number count up on screen a moment earlier.
 *
 * 3. NO CAUSATION, between faults or from context to fault. Rep 5 does two
 *    things — it slows, and the shoulders come off level — and the app does not
 *    claim either caused the other. They get separate sentences here for the
 *    same reason they get separate labels and opposite sides of the frame in
 *    `SquatRig`: a sentence joining them would assert a finding the app has
 *    never made.
 *
 * 4. THE SHOULDER READING IS NOT A FAULT. `shoulderHipLevelness` is demoted to
 *    context in the app — computed, reported, but asserting nothing — so it is
 *    reported here as a measurement and never given a verdict. Same word the
 *    reduced-motion caption uses: measured, not flagged.
 *
 * And no markdown. The app renders debriefs verbatim into a paragraph with no
 * parser, so an asterisk would reach a real user as an asterisk; a marketing
 * page that formatted the sample would be showing output the product can't
 * produce.
 */

/**
 * How much further forward the trunk pitches on rep 4 than on the reps around
 * it, in degrees.
 *
 * Baseline-RELATIVE, which is how the app's lean trigger works: it fires on the
 * delta from the set's own opening reps, not on an absolute angle, because a
 * long-femured lifter squats with more forward pitch than a short-femured one
 * and neither is a fault. Quoting the delta is therefore quoting the quantity
 * that actually decided the finding.
 */
export const LEAN_DELTA_DEG = 20;

/**
 * The peak of the shoulder angle the page draws on rep 5, in degrees.
 *
 * This is the SCREEN angle — measured off the two shoulder joints after
 * projection, the same image-coordinate quantity a camera has — so it is the
 * number the reader has just watched climb on the overlay. It is aspect-
 * independent: the projection divides x by the aspect ratio and the pixel
 * conversion multiplies it straight back, so the tilt reads the same on any
 * window and this can safely be a constant.
 */
export const SHOULDER_PEAK_DEG = 12.8;

export type PostSet = {
  /** Names the artefact. The reader has just watched a set; this is what the
   *  app hands back at the end of one. */
  label: string;
  paras: readonly string[];
  cues: readonly string[];
};

export const POST_SET: PostSet = {
  label: "Post-set summary",
  paras: [
    /* What went RIGHT, first and unhedged. Two of the five reps are clean and
       the sequence spends as long on them as on the others; a debrief that
       opened on the faults would be describing a different set — and a page
       whose sample output was all faults would be selling a nag. */
    "Five reps, all five counted to parallel. Reps 1 and 3 were clean — knees tracking over the toes, trunk holding its angle out of the bottom.",
    /* The findings, in rep order, each with the rep it happened on and the
       phase of the rep it happened in. Rep 5's two findings are two sentences:
       see rule 3 above. */
    `Rep 2 caved at the knees on the way up. Rep 4 pitched forward at the bottom, about ${LEAN_DELTA_DEG} degrees past where the reps around it were holding. Rep 5 slowed and stalled coming out of the hole. On that same rep the shoulders came up ${SHOULDER_PEAK_DEG} degrees off level — measured, not flagged.`,
  ],
  /* Two, and phrased as things to do rather than things to stop doing. The app
     ends every debrief on exactly two: one is thin for a set that had three
     findings, and a list long enough to be complete is a list nobody carries to
     the next set. */
  cues: [
    "Screw your feet into the floor and push the knees out through the whole ascent.",
    "Chest up and braced late in the set, so the trunk doesn't fold forward out of the bottom.",
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
