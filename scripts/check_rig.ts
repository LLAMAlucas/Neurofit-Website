/**
 * Offscreen checks for the squat rig. The browser pane cannot size a WebGL
 * canvas (its ResizeObserver never fires), so the geometry, the fault timing and
 * the camera framing are verified here against the same pure modules the scene
 * uses, with the projection reimplemented independently.
 */
import { BONES, J, JOINT_COUNT } from "../src/lib/pose";
import {
  BOTTOM,
  BEAT_SPEC,
  STAND,
  newPose,
  poseAt,
  valgusEnvelope,
  leanEnvelope,
  unlevelEnvelope,
  grindEnvelope,
  depthAt,
} from "../src/lib/poseFrames";
import {
  CARD_START,
  PINNED_VH,
  REPS,
  SETTLE_VH,
  tagAmounts,
  timelineAt,
  type TagId,
} from "../src/lib/rigTimeline";
import {
  DIP_S,
  DRIVE_S,
  FLIGHT_S,
  G,
  GROUND_TWIST,
  HOLD_DEPTH,
  JUMP_H,
  JUMP_S,
  LANDING_S,
  PLANES_CAM_Y,
  PLANES_CAM_Z,
  PLANES_FOV,
  PLANES_TARGET_Y,
  TAKEOFF_S,
  frontalFor,
  jumpAt,
  rotOf,
  valgusFor,
} from "../src/lib/planesView";
import {
  CARD_BLOCKS,
  LEAN_DELTA_DEG,
  POST_SET,
  SHOULDER_PEAK_DEG,
  cardBlockAmount,
} from "../src/lib/postSet";
import { SHOTS, SHOT_H, SHOT_W, frameShot } from "../src/lib/rigShots";
import { frameToClip } from "../src/lib/framing";

let failures = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}${detail ? "  — " + detail : ""}`);
};

const len = (p: Float32Array, a: number, b: number) =>
  Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);

/* ── 1. bone lengths survive the lerp ─────────────────────────────────────
   The in-between poses are a straight interpolation with no IK, so if the two
   keyframes disagree on a bone length the limb telescopes through the rep. */
console.log("\n1. bone lengths through the rep");
{
  const p = newPose();
  let worst = 0;
  let worstBone = "";
  for (const [kind, amt, grind] of [
    [null, 0, 0],
    ["valgus", 1, 0],
    ["lean", 1, 0],
    ["unlevel", 1, 0],
    // The tremor is the case that could break this: it displaces joints
    // independently, and only the relaxation pass puts the skeleton back
    // together. If the pass were ever dropped this is what would catch it.
    ["unlevel", 1, 1],
    [null, 0, 1],
  ] as const) {
    for (let d = 0; d <= 1.0001; d += 0.05) {
      poseAt(d, kind, amt, p, grind, d * 0.9 + 0.05);
      for (const [a, b] of BONES) {
        const at0 = len(STAND, J[a], J[b]);
        const now = len(p, J[a], J[b]);
        const drift = Math.abs(now - at0) / at0;
        if (drift > worst) {
          worst = drift;
          worstBone = `${a}->${b} @depth ${d.toFixed(2)} ${kind ?? "clean"}${grind ? " +grind" : ""}`;
        }
      }
    }
  }
  ok("no bone drifts more than 8%", worst < 0.08, `worst ${(worst * 100).toFixed(1)}% (${worstBone})`);
}

/* ── 2. feet stay planted ────────────────────────────────────────────────── */
console.log("\n2. contact points");
{
  const p = newPose();
  let moved = 0;
  for (let d = 0; d <= 1.0001; d += 0.05) {
    poseAt(d, null, 0, p);
    for (const n of ["ankleL", "ankleR", "toeL", "toeR"] as const) {
      const i = J[n] * 3;
      moved = Math.max(
        moved,
        Math.hypot(p[i] - STAND[i], p[i + 1] - STAND[i + 1], p[i + 2] - STAND[i + 2]),
      );
    }
  }
  ok("ankles and toes never move", moved < 1e-6, `max ${moved.toExponential(1)}`);
  ok(
    "hip drops further than the knee",
    STAND[J.hipL * 3 + 1] - BOTTOM[J.hipL * 3 + 1] >
      4 * (STAND[J.kneeL * 3 + 1] - BOTTOM[J.kneeL * 3 + 1]),
    `hip ${(STAND[J.hipL * 3 + 1] - BOTTOM[J.hipL * 3 + 1]).toFixed(3)} vs knee ${(
      STAND[J.kneeL * 3 + 1] - BOTTOM[J.kneeL * 3 + 1]
    ).toFixed(3)}`,
  );
  ok(
    "hip reaches knee level at the bottom (parallel)",
    Math.abs(BOTTOM[J.hipL * 3 + 1] - BOTTOM[J.kneeL * 3 + 1]) < 0.02,
  );
}

/* ── 3. the cave is on the ASCENT, the lean is at the BOTTOM ─────────────── */
console.log("\n3. fault timing within a rep");
{
  let descentValgus = 0;
  let ascentValgus = 0;
  for (let ph = 0; ph <= 1.0001; ph += 0.01) {
    const v = valgusEnvelope(ph);
    // depth rising = descending
    if (depthAt(ph + 0.005) > depthAt(ph)) descentValgus = Math.max(descentValgus, v);
    else if (depthAt(ph + 0.005) < depthAt(ph)) ascentValgus = Math.max(ascentValgus, v);
  }
  ok("valgus never fires on the descent", descentValgus < 0.02, `peak ${descentValgus.toFixed(3)}`);
  ok("valgus reaches full on the ascent", ascentValgus > 0.98, `peak ${ascentValgus.toFixed(3)}`);

  let best = 0;
  let bestPh = 0;
  for (let ph = 0; ph <= 1.0001; ph += 0.005) {
    if (leanEnvelope(ph) > best) {
      best = leanEnvelope(ph);
      bestPh = ph;
    }
  }
  ok("lean peaks while at depth", depthAt(bestPh) > 0.95, `peak at phase ${bestPh.toFixed(2)}, depth ${depthAt(bestPh).toFixed(2)}`);

  // knees actually move inward, trunk actually pitches forward
  const clean = newPose();
  const caved = newPose();
  poseAt(0.5, null, 0, clean);
  poseAt(0.5, "valgus", 1, caved);
  const cleanW = Math.abs(clean[J.kneeL * 3] - clean[J.kneeR * 3]);
  const cavedW = Math.abs(caved[J.kneeL * 3] - caved[J.kneeR * 3]);
  const ankleW = Math.abs(clean[J.ankleL * 3] - clean[J.ankleR * 3]);
  ok(
    "clean knees track outside the ankles, caved knees well inside",
    cleanW / ankleW > 1.05 && cavedW / ankleW < 0.6,
    `knee/ankle ${(cleanW / ankleW).toFixed(2)} clean, ${(cavedW / ankleW).toFixed(2)} caved`,
  );

  const upright = newPose();
  const tipped = newPose();
  poseAt(1, null, 0, upright);
  poseAt(1, "lean", 1, tipped);
  const trunkDeg = (p: Float32Array) => {
    const hy = (p[J.hipL * 3 + 1] + p[J.hipR * 3 + 1]) / 2;
    const hz = (p[J.hipL * 3 + 2] + p[J.hipR * 3 + 2]) / 2;
    return (Math.atan2(p[J.neck * 3 + 2] - hz, p[J.neck * 3 + 1] - hy) * 180) / Math.PI;
  };
  ok(
    "lean adds roughly 20 degrees of trunk pitch",
    trunkDeg(tipped) - trunkDeg(upright) > 18 && trunkDeg(tipped) - trunkDeg(upright) < 23,
    `${trunkDeg(upright).toFixed(1)}deg -> ${trunkDeg(tipped).toFixed(1)}deg`,
  );

  /* The grind has to be established BEFORE the shoulders drift, or the rep reads
     as two unrelated things happening at once instead of one turning into the
     other. It also has to cover the descent, which is where the user sees the
     rep stop being smooth. */
  let grindOnDescent = 0;
  for (let ph = 0; ph <= 0.52; ph += 0.01) grindOnDescent = Math.max(grindOnDescent, grindEnvelope(ph));
  ok("the grind sets in on the way down", grindOnDescent > 0.95, `peak ${grindOnDescent.toFixed(2)}`);

  const firstOver = (f: (p: number) => number) => {
    for (let ph = 0; ph <= 1.0001; ph += 0.005) if (f(ph) > 0.5) return ph;
    return 2;
  };
  ok(
    "the shoulders drift only after the grind is under way",
    firstOver(unlevelEnvelope) > firstOver(grindEnvelope) + 0.3,
    `grind at ${firstOver(grindEnvelope).toFixed(2)}, shoulders at ${firstOver(unlevelEnvelope).toFixed(2)}`,
  );
  ok(
    "the shoulders drift on the ASCENT",
    depthAt(firstOver(unlevelEnvelope)) < depthAt(firstOver(unlevelEnvelope) - 0.05),
    `phase ${firstOver(unlevelEnvelope).toFixed(2)}`,
  );

  /* The drawn number is measured off the pose, so the pose has to actually
     produce a tilt in a range worth annotating — a degree reads as noise, thirty
     reads as falling over. This is the assertion that pins UNLEVEL_RAD, since
     the relaxation pass takes some of the rotation back. */
  const levelP = newPose();
  const tiltP = newPose();
  poseAt(0.4, null, 0, levelP);
  poseAt(0.4, "unlevel", 1, tiltP);
  const shoulderDeg = (p: Float32Array) =>
    Math.abs(
      (Math.atan2(
        p[J.shoulderR * 3 + 1] - p[J.shoulderL * 3 + 1],
        p[J.shoulderR * 3] - p[J.shoulderL * 3],
      ) *
        180) /
        Math.PI,
    );
  ok("clean shoulders are level", shoulderDeg(levelP) < 0.5, `${shoulderDeg(levelP).toFixed(2)}deg`);
  ok(
    "shoulder drift lands between 6 and 16 degrees",
    shoulderDeg(tiltP) > 6 && shoulderDeg(tiltP) < 16,
    `${shoulderDeg(tiltP).toFixed(1)}deg`,
  );
  ok(
    "the shoulder tilt is FRONTAL — it barely shows from the side",
    Math.abs(tiltP[J.shoulderL * 3 + 2] - tiltP[J.shoulderR * 3 + 2]) < 0.02,
    `fore-aft split ${Math.abs(tiltP[J.shoulderL * 3 + 2] - tiltP[J.shoulderR * 3 + 2]).toFixed(3)}`,
  );
}

/* ── 3b. the sequence is SCRUBBED, not played ─────────────────────────────
   Everything here is a pure function of scroll. A tremor driven by a clock or by
   Math.random would keep moving while the page sat still and would differ on the
   way back up, which is precisely the bug this catches. */
console.log("\n3b. the same scroll always gives the same pose");
{
  const a = newPose();
  const b = newPose();
  let worst = 0;
  for (let i = 0; i <= 600; i++) {
    const t = i / 600;
    const s = timelineAt(1, t);
    poseAt(s.depth, s.beat, s.beatAmount, a, s.grind, s.phase);
    const s2 = timelineAt(1, t);
    poseAt(s2.depth, s2.beat, s2.beatAmount, b, s2.grind, s2.phase);
    for (let k = 0; k < a.length; k++) worst = Math.max(worst, Math.abs(a[k] - b[k]));
  }
  ok("re-sampling a scroll position reproduces it exactly", worst === 0, `max delta ${worst}`);

  // And the grind has to actually MOVE something, or the assertion above is
  // passing on a no-op.
  const still = newPose();
  const shaken = newPose();
  poseAt(0.5, null, 0, still, 0, 0.5);
  poseAt(0.5, null, 0, shaken, 1, 0.5);
  let moved = 0;
  for (let k = 0; k < still.length; k++) moved = Math.max(moved, Math.abs(still[k] - shaken[k]));
  ok("the grind visibly displaces the figure", moved > 0.004, `max ${moved.toFixed(4)}`);
  ok(
    "the grind never moves the feet",
    ["ankleL", "ankleR", "toeL", "toeR"].every((n) => {
      const i = J[n as keyof typeof J] * 3;
      return Math.hypot(
        shaken[i] - still[i],
        shaken[i + 1] - still[i + 1],
        shaken[i + 2] - still[i + 2],
      ) < 1e-6;
    }),
  );
}

/* ── 4. which reps go wrong ──────────────────────────────────────────────── */
console.log("\n4. the sequence");
{
  const seen = new Map<number, Set<string>>();
  const maxAmountByRep = new Map<number, number>();
  const maxGrindByRep = new Map<number, number>();
  for (let i = 0; i <= 4000; i++) {
    const s = timelineAt(1, i / 4000);
    if (s.repIndex === 0) continue;
    if (!seen.has(s.repIndex)) seen.set(s.repIndex, new Set());
    seen.get(s.repIndex)!.add(String(s.beat));
    maxAmountByRep.set(s.repIndex, Math.max(maxAmountByRep.get(s.repIndex) ?? 0, s.beatAmount));
    maxGrindByRep.set(s.repIndex, Math.max(maxGrindByRep.get(s.repIndex) ?? 0, s.grind));
  }
  for (const rep of [1, 3]) {
    ok(
      `rep ${rep} is clean`,
      [...(seen.get(rep) ?? [])].every((f) => f === "null"),
      [...(seen.get(rep) ?? [])].join(","),
    );
    ok(`rep ${rep} highlights nothing`, (maxAmountByRep.get(rep) ?? 0) === 0);
  }
  ok("rep 2 is the knee cave", [...(seen.get(2) ?? [])].join(",") === "valgus");
  ok("rep 4 is the forward lean", [...(seen.get(4) ?? [])].join(",") === "lean");
  ok("rep 5 is the shoulder reading", [...(seen.get(5) ?? [])].join(",") === "unlevel");
  ok("rep 2 reaches full cave", (maxAmountByRep.get(2) ?? 0) > 0.98);
  ok("rep 4 reaches full lean", (maxAmountByRep.get(4) ?? 0) > 0.98);
  ok("rep 5 reaches full shoulder drift", (maxAmountByRep.get(5) ?? 0) > 0.98);
  ok("all five reps happen", [...seen.keys()].sort((a, b) => a - b).join(",") === "1,2,3,4,5");

  // Only rep 5 grinds, and it does so fully. A grind leaking into a rep that is
  // supposed to read as clean would undercut the whole point of the clean reps.
  ok("only rep 5 is unsteady", [1, 2, 3, 4].every((r) => (maxGrindByRep.get(r) ?? 0) === 0));
  ok("rep 5 reaches full instability", (maxGrindByRep.get(5) ?? 0) > 0.98);

  /* Only two of the five get a written note. The third is the shoulder reading,
     which the app measures and reports but has demoted from asserting a fault —
     so it is drawn as an angle and never given a verdict in prose. If a `marked`
     beat ever grows red bones, this is what says so. */
  ok(
    "the shoulder reading is drawn as a measurement, never as a fault",
    BEAT_SPEC.unlevel.bones.length === 0 && BEAT_SPEC.unlevel.marked.length > 0,
  );
  ok(
    "the two real triggers are drawn as faults",
    BEAT_SPEC.valgus.bones.length > 0 &&
      BEAT_SPEC.lean.bones.length > 0 &&
      BEAT_SPEC.valgus.marked.length === 0 &&
      BEAT_SPEC.lean.marked.length === 0,
  );
}

/* ── 4b. the closing panel ───────────────────────────────────────────────── */
console.log("\n4b. the closing panel");
{
  let cardDuringReps = 0;
  let cardPeak = 0;
  let cardAtEnd = 0;
  for (let i = 0; i <= 4000; i++) {
    const s = timelineAt(1, i / 4000);
    if (s.repIndex > 0) cardDuringReps = Math.max(cardDuringReps, s.cardT);
    cardPeak = Math.max(cardPeak, s.cardT);
    if (s.outT > 0.95) cardAtEnd = Math.max(cardAtEnd, s.cardT);
  }
  ok("the panel never covers a rep", cardDuringReps < 0.01, cardDuringReps.toFixed(3));
  ok("the panel fully arrives", cardPeak > 0.99, cardPeak.toFixed(3));
  ok("the panel is gone before the frame closes", cardAtEnd < 0.06, cardAtEnd.toFixed(3));

  const card = timelineAt(1, (CARD_START + 0.8) / PINNED_VH);
  ok("the camera has pulled back behind the panel", card.camZ > 5, `z ${card.camZ.toFixed(2)}`);
  ok("the figure is standing behind the panel", card.depth === 0);

  /* The panel writes itself line by line, and the stagger is a function of the
     panel's own progress rather than of a clock — so it can be checked, and so
     scrolling back up un-writes it instead of replaying. */
  const amounts = (t: number) =>
    Array.from({ length: CARD_BLOCKS }, (_, i) => cardBlockAmount(t, i));
  let outOfOrder = 0;
  for (let i = 0; i <= 200; i++) {
    const a = amounts(i / 200);
    for (let k = 1; k < a.length; k++) if (a[k] > a[k - 1] + 1e-9) outOfOrder++;
  }
  ok("no line of the debrief ever arrives before the one above it", outOfOrder === 0);
  ok("the debrief starts unwritten", amounts(0).every((a) => a === 0));
  ok(
    "the debrief is fully written before the panel finishes arriving",
    amounts(0.95).every((a) => a > 0.999),
    amounts(0.95)
      .map((a) => a.toFixed(2))
      .join(" "),
  );
}

/* ── 4c. what the debrief is allowed to say ───────────────────────────────
   The page is selling an app that is careful about its claims, so the sample of
   its output has to obey the app's own rules — otherwise the page is the one
   overclaiming, about a product whose entire pitch is that it doesn't. Each of
   these is a rule the real system runs on, checked against the copy. */
console.log("\n4c. the post-set summary");
{
  const prose = [...POST_SET.paras, ...POST_SET.cues].join(" ");
  const all = [POST_SET.label, ...POST_SET.paras, ...POST_SET.cues].join(" ");

  /* 1. No markdown. Debriefs are rendered verbatim into a paragraph with no
     parser, so an asterisk reaches a real user as an asterisk — a page that
     showed a bolded sample would be showing output the app cannot produce. */
  ok("no markdown in the debrief", !/[*_`#]|<[a-z]/i.test(all));

  /* 2. No normalised numbers. Gap, depth ratio, velocity and valgus are image
     coordinates the app keeps to itself; degrees and rep numbers are real units
     and are the only quantities it will speak. So every number here is either a
     rep number, a count, or degrees — and the check is on the DECIMALS, since
     that is the form the leak took ("a hip-to-knee gap of -0.0023"). */
  const decimals = prose.match(/-?\d+\.\d+/g) ?? [];
  ok(
    "no normalised coordinate is quoted at the reader",
    decimals.every((d) => prose.includes(`${d} degrees`)),
    decimals.join(", ") || "no decimals",
  );
  ok("no negative number reaches the reader", !/-\d/.test(prose));

  /* 3. The two numbers are MEASURED. Both are re-derived here from the same
     poses the scene draws, so editing a keyframe fails this check rather than
     leaving the page quoting a figure the animation stopped producing. The
     shoulder angle is the one that would show: the reader watches that exact
     number count up on the overlay moments before reading it here. */
  const upright = newPose();
  const tipped = newPose();
  poseAt(1, null, 0, upright);
  poseAt(1, "lean", 1, tipped);
  const trunkDeg = (p: Float32Array) => {
    const hy = (p[J.hipL * 3 + 1] + p[J.hipR * 3 + 1]) / 2;
    const hz = (p[J.hipL * 3 + 2] + p[J.hipR * 3 + 2]) / 2;
    return (Math.atan2(p[J.neck * 3 + 2] - hz, p[J.neck * 3 + 1] - hy) * 180) / Math.PI;
  };
  const measuredLean = trunkDeg(tipped) - trunkDeg(upright);
  ok(
    "the quoted lean matches the trunk pitch the figure actually shows",
    Math.abs(measuredLean - LEAN_DELTA_DEG) < 1,
    `copy says ${LEAN_DELTA_DEG}deg, figure shows ${measuredLean.toFixed(1)}deg`,
  );
  ok(`the copy quotes the lean`, prose.includes(`${LEAN_DELTA_DEG} degrees`));

  // Same projection and the same draw condition SquatRig uses, so this is the
  // number on the overlay and not the pose's own tilt.
  const VW = 1440;
  const VH = 900;
  const TAN = Math.tan((32 * Math.PI) / 360);
  const p = newPose();
  const shoulderScreenDeg = (s: ReturnType<typeof timelineAt>) => {
    poseAt(s.depth, s.beat, s.beatAmount, p, s.grind, s.phase);
    const cos = Math.cos(s.rotY);
    const sin = Math.sin(s.rotY);
    let cz = 0;
    for (let k = 0; k < JOINT_COUNT; k++) cz += p[k * 3 + 2];
    cz /= JOINT_COUNT;
    const fy = s.targetY - s.camY;
    const fl = Math.hypot(fy, -s.camZ);
    const px = (k: number): [number, number] => {
      const x0 = p[k * 3];
      const z0 = p[k * 3 + 2] - cz;
      const x = x0 * cos + z0 * sin;
      const z = -x0 * sin + z0 * cos;
      const dy = p[k * 3 + 1] - s.camY;
      const dz = z - s.camZ;
      const vy = dy * (s.camZ / fl) + dz * (fy / fl);
      const vz = -(dy * (fy / fl) + dz * (-s.camZ / fl));
      return [((x / (vz * TAN * (VW / VH))) * 0.5 + 0.5) * VW, (0.5 - (vy / (vz * TAN)) * 0.5) * VH];
    };
    const a = px(J.shoulderL);
    const b = px(J.shoulderR);
    const [lo, hi] = a[0] <= b[0] ? [a, b] : [b, a];
    return (Math.abs(Math.atan2(hi[1] - lo[1], hi[0] - lo[0])) * 180) / Math.PI;
  };
  let drawnPeak = 0;
  for (let ph = 0; ph <= 1.0001; ph += 0.005) {
    const s = timelineAt(1, (SETTLE_VH + 4 + ph) / PINNED_VH);
    if (s.beat !== "unlevel" || !s.planeVisible || s.focusAmount * 1.6 <= 0.01) continue;
    drawnPeak = Math.max(drawnPeak, shoulderScreenDeg(s));
  }
  ok(
    "the quoted shoulder angle is the one the overlay draws",
    Math.abs(drawnPeak - SHOULDER_PEAK_DEG) < 0.1,
    `copy says ${SHOULDER_PEAK_DEG}deg, overlay peaks at ${drawnPeak.toFixed(1)}deg`,
  );

  /* 4. The shoulder reading is CONTEXT, not a verdict. It is demoted in the app
     — computed and reported, asserting nothing — so the copy reports it as a
     measurement, in the same words the reduced-motion caption uses. */
  ok("the shoulder reading is reported as measured, not flagged", /measured, not flagged/.test(prose));

  /* 5. No causation, between faults or from context to fault. Rep 5 slows AND
     the shoulders come off level; the app claims neither caused the other, which
     is why they have separate labels on opposite sides of the frame. A sentence
     joining them would assert a finding the app has never made. */
  /* Split by what the sentence is doing, because the rule is about CLAIMS and a
     cue makes none. "Stay braced so the trunk doesn't fold forward" is an
     instruction and its purpose — it says nothing about what happened in the set
     just watched. "The trunk folded forward because you lost tension" is the
     banned move, and it stays banned in a cue too: the give-away is the
     retrospective connective, not the word "so". */
  const RETROSPECTIVE =
    /\b(caused|causing|because|due to|led to|leading to|result(ed|ing) (in|from)|which is why|hence|therefore)\b/i;
  const DESCRIPTIVE = new RegExp(`${RETROSPECTIVE.source}|\\bso the\\b|\\bmeaning\\b`, "i");
  ok(
    "the description of the set claims no causation",
    POST_SET.paras.every((t) => !DESCRIPTIVE.test(t)),
    POST_SET.paras.find((t) => DESCRIPTIVE.test(t)) ?? "",
  );
  ok(
    "the cues make no retrospective claim either",
    POST_SET.cues.every((t) => !RETROSPECTIVE.test(t)),
    POST_SET.cues.find((t) => RETROSPECTIVE.test(t)) ?? "",
  );
  const shoulderSentence = prose
    .split(/(?<=\.)\s+/)
    .find((s) => s.includes("off level"));
  ok(
    "the two findings on rep 5 are separate sentences",
    !!shoulderSentence && !/slow|stall/i.test(shoulderSentence),
    shoulderSentence ?? "not found",
  );

  /* 6. The clean reps are reported, and reported FIRST. Two of the five go
     right and the sequence spends as long on them as on the others; a debrief
     that opened on the faults would be describing a different set, and a page
     whose sample output was all faults would be selling a nag. */
  ok("the clean reps are named", /reps? 1 and 3 were clean/i.test(POST_SET.paras[0]));
  ok(
    "every rep the sequence flags is accounted for",
    ["Rep 2", "Rep 4", "Rep 5"].every((r) => prose.includes(r)),
  );
  ok("all five reps are reported as counted", /all five counted/i.test(prose));

  /* 7. It says what it is. The label is the whole point of the panel — the
     reader has just watched a set, and this is the artefact the app hands back
     at the end of one. */
  ok("the panel names itself", /post-set summary/i.test(POST_SET.label));
  ok("there are exactly two cues", POST_SET.cues.length === 2, String(POST_SET.cues.length));

  /* 8. It has to FIT. The panel is fixed and centred with no scroll of its own,
     so anything taller than the viewport is lost off both ends rather than
     scrolled to. Measured at the two sizes that bite: the 520px desktop panel,
     and a 375px phone where the same words set to ten more lines. */
  const lines = (text: string, px: number, fontPx: number) =>
    Math.ceil(text.length / Math.max(1, (px / fontPx) * 1.92));
  const height = (textW: number, bodyPx: number, cuePx: number, pad: number) =>
    pad +
    38 +
    POST_SET.paras.reduce((h, t) => h + lines(t, textW, bodyPx) * bodyPx * 1.6 + 13, 0) +
    POST_SET.cues.reduce((h, t) => h + lines(t, textW - 26, cuePx) * cuePx * 1.55 + 9, 0);
  const desktop = height(520 - 64, 16.3, 15.2, 54);
  const phone = height(375 - 44 - 44, 14.9, 14.1, 42);
  ok("the panel fits a 900px-tall window", desktop < 900 - 80, `${desktop.toFixed(0)}px`);
  ok("the panel fits a 375x667 phone", phone < 667 - 40, `${phone.toFixed(0)}px`);
}

/* ── 5. the camera faces the plane the fault lives in ────────────────────── */
console.log("\n5. camera angle against fault plane");
{
  const at = (rep: number, phase: number) =>
    timelineAt(1, (SETTLE_VH + (rep - 1) + phase) / PINNED_VH);
  const deg = (r: number) => (r * 180) / Math.PI;
  const r2 = at(2, 0.75); // mid-ascent, cave at its worst
  const r4 = at(4, 0.55); // bottom, lean at its worst
  const r5 = at(5, 0.85); // late ascent, shoulders at their worst
  ok("rep 2 is viewed head-on (frontal fault)", deg(r2.rotY) < 8, `${deg(r2.rotY).toFixed(1)}deg`);
  ok("rep 4 is viewed side-on (sagittal fault)", deg(r4.rotY) > 82, `${deg(r4.rotY).toFixed(1)}deg`);
  ok(
    "rep 5 is back head-on for the shoulders (frontal)",
    deg(r5.rotY) < 8,
    `${deg(r5.rotY).toFixed(1)}deg`,
  );
  ok("camera has pushed in on rep 2's cave", r2.focusAmount > 0.9 && r2.camZ < 2.4, `z ${r2.camZ.toFixed(2)}`);
  ok("camera has pushed in on rep 4's lean", r4.focusAmount > 0.9 && r4.camZ < 2.6, `z ${r4.camZ.toFixed(2)}`);
  ok("camera has pushed in on rep 5's shoulders", r5.focusAmount > 0.9 && r5.camZ < 2.8, `z ${r5.camZ.toFixed(2)}`);
  ok("camera is wide on clean reps", at(3, 0.15).camZ > 4.1 && at(1, 0.5).camZ > 4.1);

  /* The turns have to land where there is nothing to miss. A camera swinging
     through the exact frame a fault peaks in shows the reader the fault edge-on,
     which is the one thing this whole sequence is arguing against. */
  const settled = (rep: number, phase: number) => {
    const d = deg(at(rep, phase).rotY);
    return d < 6 || d > 84;
  };
  ok("the camera is settled while the cave peaks", settled(2, 0.72) && settled(2, 0.86));
  ok("the camera is settled while the lean peaks", settled(4, 0.5) && settled(4, 0.7));
  ok("the camera is settled while the shoulders drift", settled(5, 0.7) && settled(5, 0.95));
  // ...and the turn into rep 5 finishes during the DESCENT, so nothing about the
  // way up is watched from a moving camera.
  ok(
    "the turn to head-on is done before rep 5 reaches the bottom",
    deg(at(5, 0.5).rotY) < 6,
    `${deg(at(5, 0.5).rotY).toFixed(1)}deg at phase 0.5`,
  );
}

/* ── 6. rep counter ──────────────────────────────────────────────────────── */
console.log("\n6. rep counter");
{
  let prev = 0;
  let monotonic = true;
  for (let i = 0; i <= 4000; i++) {
    const c = timelineAt(1, i / 4000).repsCounted;
    if (c < prev) monotonic = false;
    prev = c;
  }
  ok("counter never goes backwards on a forward scroll", monotonic);
  ok("counter ends on five", prev === REPS, String(prev));
  ok("counter starts at zero", timelineAt(1, 0).repsCounted === 0);
}

/* ── 7. framing: nothing clipped on the wide beats ───────────────────────── */
console.log("\n7. framing at 1440x900");
{
  const ASPECT = 1440 / 900;
  const TAN = Math.tan((32 * Math.PI) / 360);
  const p = newPose();

  const project = (
    x: number,
    y: number,
    z: number,
    camY: number,
    camZ: number,
    targetY: number,
  ) => {
    const fy = targetY - camY;
    const fz = -camZ;
    const fl = Math.hypot(fy, fz);
    const dy = y - camY;
    const dz = z - camZ;
    const vy = dy * (-fz / fl) + dz * (fy / fl);
    const vz = -(dy * (fy / fl) + dz * (fz / fl));
    return [x / (vz * TAN * ASPECT), vy / (vz * TAN)];
  };

  let worstWide = 0;
  let anchorWorst = 0;
  let annotationRoom = Infinity;
  let annotationOff = 0;
  for (let i = 0; i <= 2000; i++) {
    const s = timelineAt(1, i / 2000);
    poseAt(s.depth, s.beat, s.beatAmount, p, s.grind, s.phase);
    const cos = Math.cos(s.rotY);
    const sin = Math.sin(s.rotY);
    let cz = 0;
    for (let k = 0; k < JOINT_COUNT; k++) cz += p[k * 3 + 2];
    cz /= JOINT_COUNT;

    const nd = (k: number) => {
      const x = p[k * 3];
      const z = p[k * 3 + 2] - cz;
      return project(x * cos + z * sin, p[k * 3 + 1], -x * sin + z * cos, s.camY, s.camZ, s.targetY);
    };

    if (s.focusAmount < 0.05) {
      for (let k = 0; k < JOINT_COUNT; k++) {
        const [nx, ny] = nd(k);
        worstWide = Math.max(worstWide, Math.abs(nx), Math.abs(ny));
      }
    }
    if (s.beat && s.focusAmount > 0.9) {
      const [a, b] = BEAT_SPEC[s.beat].anchors;
      const [ax, ay] = nd(J[a]);
      const [bx, by] = nd(J[b]);
      anchorWorst = Math.max(anchorWorst, Math.abs((ax + bx) / 2), Math.abs((ay + by) / 2));

    }

    /* The shoulder annotation is not just a dot on a joint: it runs a horizontal
       out past the wider shoulder and hangs a degree label past that. It is
       measured over the window the annotation is actually DRAWN in — while the
       drift is legible — rather than over the whole camera push, which trails on
       past it into the lockout. */
    if (s.beat === "unlevel" && s.beatAmount > 0.5) {
      const [a, b] = BEAT_SPEC.unlevel.anchors;
      const [ax, ay] = nd(J[a]);
      const [bx, by] = nd(J[b]);
      annotationRoom = Math.min(annotationRoom, 1 - Math.max(Math.abs(ax), Math.abs(bx)));
      annotationOff = Math.max(annotationOff, Math.abs((ay + by) / 2));
    }
  }
  ok(
    "whole figure inside the frame on every wide beat",
    worstWide < 0.94,
    `worst joint at ${(worstWide * 100).toFixed(1)}% of half-frame`,
  );
  ok(
    "beat anchor stays near centre while the camera is pushed in",
    anchorWorst < 0.45,
    `worst ${(anchorWorst * 100).toFixed(1)}% of half-frame`,
  );
  ok(
    "the shoulders keep room for the angle annotation",
    annotationRoom > 0.4,
    `${(annotationRoom * 100).toFixed(0)}% of half-frame spare`,
  );
  ok(
    "the shoulder line stays centred while the angle is drawn",
    annotationOff < 0.3,
    `worst ${(annotationOff * 100).toFixed(0)}% of half-frame`,
  );
}

/* ── 8. the figure lands inside the visible frame, at every clip size ─────
   The canvas is always the whole viewport while the visible frame starts as the
   hero lens box. Framing the canvas instead of the clip draws the figure in the
   middle of the screen, where the clip throws it away — which is exactly what
   happened: nothing was visible until the lens had opened to full screen. */
console.log("\n8. figure inside the clip rect while the lens opens");
{
  const VW = 1440;
  const VH = 900;
  const TAN = Math.tan((32 * Math.PI) / 360);
  const p = newPose();
  /* Measured in the page at 1440x900, and it has to be RE-measured whenever the
     hero's layout moves: this is the one input to this section that the page can
     change without the check noticing. It was carrying 459x612 at (795,171) —
     the box `.hero__lens` had before `max-width` came down to 414px — which is
     11% larger than the lens the rig actually clips itself to, so everything
     below was validating the framing against a lens that is not on the page. */
  const LENS = { x: 816, y: 143, w: 414, h: 552 };

  const pixels = (clip: { x: number; y: number; w: number; h: number }, s: ReturnType<typeof timelineAt>) => {
    const fr = frameToClip(clip, VW, VH);
    const camZ = s.camZ * fr.distanceScale;
    poseAt(s.depth, s.beat, s.beatAmount, p, s.grind, s.phase);
    const cos = Math.cos(s.rotY);
    const sin = Math.sin(s.rotY);
    let cz = 0;
    for (let k = 0; k < JOINT_COUNT; k++) cz += p[k * 3 + 2];
    cz /= JOINT_COUNT;

    const fy = s.targetY - s.camY;
    const fl = Math.hypot(fy, -camZ);
    const out: Array<[number, number]> = [];
    for (let k = 0; k < JOINT_COUNT; k++) {
      const x0 = p[k * 3];
      const z0 = p[k * 3 + 2] - cz;
      const x = x0 * cos + z0 * sin;
      const y = p[k * 3 + 1];
      const z = -x0 * sin + z0 * cos;
      const dy = y - s.camY;
      const dz = z - camZ;
      const vy = dy * (camZ / fl) + dz * (fy / fl);
      const vz = -(dy * (fy / fl) + dz * (-camZ / fl));
      const nx = x / (vz * TAN * (VW / VH)) + fr.shiftX;
      const ny = vy / (vz * TAN) + fr.shiftY;
      out.push([(nx * 0.5 + 0.5) * VW, (0.5 - ny * 0.5) * VH]);
    }
    return out;
  };

  /* The clip exactly as SquatRig builds it: a HELD anchor (the lens's viewport
     position when the opening begins) lerped to the viewport, then intersected
     with the screen. The held anchor is the fix — lerping from the lens's LIVE
     position meant the rect's top had already scrolled past zero, so the frame's
     centre climbed off screen before it grew and the head was cropped. */
  const smoothstep = (v: number) => v * v * (3 - 2 * v);
  const clipAt = (t: number) => {
    const e = smoothstep(t);
    const top = LENS.y * (1 - e);
    const left = LENS.x * (1 - e);
    const right = (VW - LENS.x - LENS.w) * (1 - e);
    const bottom = (VH - LENS.y - LENS.h) * (1 - e);
    // near edges clamped to the viewport, far edges not — see SquatRig
    const x = Math.max(0, left);
    const y = Math.max(0, top);
    return { x, y, w: VW - right - x, h: VH - bottom - y };
  };

  let worstOut = 0;
  let worstAt = "";
  let fillAtStart = 0;
  let prevH = 0;
  let shrank = 0;
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const clip = clipAt(t);
    if (i > 0) shrank = Math.max(shrank, prevH - clip.h);
    prevH = clip.h;
    const s = timelineAt(t, 0);
    const pts = pixels(clip, s);
    let lo = Infinity;
    let hi = -Infinity;
    for (const [px, py] of pts) {
      // signed distance outside the clip rect, in px
      const dx = Math.max(clip.x - px, px - (clip.x + clip.w), 0);
      const dy = Math.max(clip.y - py, py - (clip.y + clip.h), 0);
      const outBy = Math.max(dx, dy);
      if (outBy > worstOut) {
        worstOut = outBy;
        worstAt = `expand ${t.toFixed(2)}`;
      }
      lo = Math.min(lo, py);
      hi = Math.max(hi, py);
    }
    if (i === 0) fillAtStart = (hi - lo) / clip.h;
  }
  ok("figure never leaves the visible frame as the lens opens", worstOut < 1, `worst ${worstOut.toFixed(0)}px out (${worstAt})`);
  ok(
    "figure fills 55-85% of the hero lens box at rest",
    fillAtStart > 0.55 && fillAtStart < 0.85,
    `${(fillAtStart * 100).toFixed(0)}%`,
  );
  // A frame that grows, shrinks and grows again reads as a wobble even when
  // nothing is ever cropped — the old live-anchor lerp did exactly that.
  ok("the frame only ever grows while opening", shrank < 1, `worst shrink ${shrank.toFixed(0)}px`);
}

/* ── 9. the number the reader actually reads ──────────────────────────────
   The degree label is measured off the two shoulder joints AFTER projection, so
   it is a screen-space angle — the same kind of quantity a camera-based system
   has, image coordinates rather than a protractor held against a body. That also
   means it is not the pose's tilt: perspective and the viewport's aspect both
   act on it. This reproduces the projection and the label maths from SquatRig
   and checks what ends up on screen, which is the only version anyone sees. */
console.log("\n9. the drawn shoulder angle");
{
  const VW = 1440;
  const VH = 900;
  const TAN = Math.tan((32 * Math.PI) / 360);
  const p = newPose();

  const shoulderScreenDeg = (s: ReturnType<typeof timelineAt>) => {
    poseAt(s.depth, s.beat, s.beatAmount, p, s.grind, s.phase);
    const cos = Math.cos(s.rotY);
    const sin = Math.sin(s.rotY);
    let cz = 0;
    for (let k = 0; k < JOINT_COUNT; k++) cz += p[k * 3 + 2];
    cz /= JOINT_COUNT;
    const fy = s.targetY - s.camY;
    const fl = Math.hypot(fy, -s.camZ);
    const px = (k: number): [number, number] => {
      const x0 = p[k * 3];
      const z0 = p[k * 3 + 2] - cz;
      const x = x0 * cos + z0 * sin;
      const z = -x0 * sin + z0 * cos;
      const dy = p[k * 3 + 1] - s.camY;
      const dz = z - s.camZ;
      const vy = dy * (s.camZ / fl) + dz * (fy / fl);
      const vz = -(dy * (fy / fl) + dz * (-s.camZ / fl));
      return [((x / (vz * TAN * (VW / VH))) * 0.5 + 0.5) * VW, (0.5 - (vy / (vz * TAN)) * 0.5) * VH];
    };
    const a = px(J.shoulderL);
    const b = px(J.shoulderR);
    // SquatRig orders the pair by screen x before measuring, so the arc is never
    // swept from the wrong end. Same here, or the check would pass on a reflex.
    const [lo, hi] = a[0] <= b[0] ? [a, b] : [b, a];
    return (Math.abs(Math.atan2(hi[1] - lo[1], hi[0] - lo[0])) * 180) / Math.PI;
  };

  /** Exactly the condition SquatRig draws on. */
  const drawn = (s: ReturnType<typeof timelineAt>) =>
    s.beat === "unlevel" && s.planeVisible && s.focusAmount * 1.6 > 0.01;

  const at = (phase: number) => timelineAt(1, (SETTLE_VH + 4 + phase) / PINNED_VH);

  let peak = 0;
  let peakPhase = 0;
  for (let ph = 0; ph <= 1.0001; ph += 0.005) {
    const s = at(ph);
    if (!drawn(s)) continue;
    const d = shoulderScreenDeg(s);
    if (d > peak) {
      peak = d;
      peakPhase = ph;
    }
  }
  ok(
    "the drawn angle peaks in a range worth annotating",
    peak > 5 && peak < 20,
    `${peak.toFixed(1)}deg at phase ${peakPhase.toFixed(2)}`,
  );
  ok("the drawn angle peaks on the ascent", peakPhase > 0.6 && peakPhase < 1, `phase ${peakPhase.toFixed(2)}`);

  // It has to BUILD, not appear. The label counts up because the geometry does.
  const early = shoulderScreenDeg(at(0.62));
  const mid = shoulderScreenDeg(at(0.75));
  const late = shoulderScreenDeg(at(0.86));
  ok(
    "the angle builds through the ascent rather than snapping on",
    early < mid && mid < late,
    `${early.toFixed(1)} -> ${mid.toFixed(1)} -> ${late.toFixed(1)}deg`,
  );

  // A tilt visible only because the figure is shaking would be a number the page
  // made up. The grind alone must read as level.
  const shakeOnly = at(0.45);
  ok(
    "the grind on its own does not fake a tilt",
    shakeOnly.grind > 0.9 && shoulderScreenDeg(shakeOnly) < 2,
    `${shoulderScreenDeg(shakeOnly).toFixed(2)}deg at grind ${shakeOnly.grind.toFixed(2)}`,
  );

  /* The one that matters. Run the SAME arithmetic across the whole sequence and
     look at what it would have said wherever the annotation is NOT drawn — that
     is the number the view gate is there to suppress. Without the gate this
     reports 87° about a level pair of shoulders, from the side-on stretch of rep
     3, and 29° from mid-turn at the top of rep 5. */
  let worstSuppressed = 0;
  let worstAt = "";
  let worstDrawnOffAxis = 0;
  for (let i = 0; i <= 4000; i++) {
    const s = timelineAt(1, i / 4000);
    if (drawn(s)) {
      worstDrawnOffAxis = Math.max(worstDrawnOffAxis, (Math.abs(s.rotY) * 180) / Math.PI);
      continue;
    }
    const d = shoulderScreenDeg(s);
    if (d > worstSuppressed) {
      worstSuppressed = d;
      worstAt = `rep ${s.repIndex} phase ${s.phase.toFixed(2)}, camera ${((s.rotY * 180) / Math.PI).toFixed(0)}deg off`;
    }
  }
  ok(
    "the angle is never drawn from a view that cannot see the frontal plane",
    worstDrawnOffAxis < 10,
    `worst ${worstDrawnOffAxis.toFixed(1)}deg off square while drawn`,
  );
  ok(
    "the gate is suppressing a genuinely wrong number, not a marginal one",
    worstSuppressed > 40,
    `would have read ${worstSuppressed.toFixed(0)}deg at ${worstAt}`,
  );
}

/* ── 9b. what the sequence says, and when ─────────────────────────────────
   Four labels, and the only pair that ever overlaps is rep 5's — deliberately.
   The rep goes unsteady on the way DOWN and the shoulders drift on the way UP;
   a page that raised both at the same instant would be describing one event
   rather than two, and implying a cause the app never claims. */
console.log("\n9b. the labels");
{
  const TAG_REP: Record<TagId, number> = { valgus: 2, lean: 4, fatigue: 5, shoulders: 5 };
  const peak: Record<string, number> = {};
  const strayOnOtherReps: Record<string, number> = {};
  const firstOn: Record<string, number> = {};

  for (let i = 0; i <= 6000; i++) {
    const t = i / 6000;
    const s = timelineAt(1, t);
    const a = tagAmounts(s);
    for (const id of Object.keys(a) as TagId[]) {
      peak[id] = Math.max(peak[id] ?? 0, a[id]);
      if (a[id] > 0.02) {
        if (firstOn[id] === undefined) firstOn[id] = t;
        if (s.repIndex !== TAG_REP[id]) {
          strayOnOtherReps[id] = Math.max(strayOnOtherReps[id] ?? 0, a[id]);
        }
      }
    }
  }

  for (const id of Object.keys(TAG_REP) as TagId[]) {
    ok(`"${id}" reaches the reader`, (peak[id] ?? 0) > 0.98, (peak[id] ?? 0).toFixed(2));
    ok(
      `"${id}" only appears on rep ${TAG_REP[id]}`,
      (strayOnOtherReps[id] ?? 0) === 0,
      `${(strayOnOtherReps[id] ?? 0).toFixed(2)} elsewhere`,
    );
  }
  ok(
    "fatigue is raised before the shoulders are",
    firstOn.fatigue < firstOn.shoulders,
    `${firstOn.fatigue.toFixed(4)} vs ${firstOn.shoulders.toFixed(4)}`,
  );

  /* And it TRAILS the shaking by a real margin. Derived straight from the grind
     it arrived within five percent of a rep of the first wobble, which read as
     the page calling fatigue on a single frame of movement. The word has to land
     on a rep that has visibly been struggling for a while. */
  let grindStarts = 2;
  for (let ph = 0; ph <= 1.0001; ph += 0.005) {
    if (grindEnvelope(ph) > 0.02) {
      grindStarts = ph;
      break;
    }
  }
  const fatiguePhase = timelineAt(1, firstOn.fatigue).phase;
  ok(
    "fatigue waits well after the shaking starts",
    fatiguePhase - grindStarts > 0.1,
    `shaking at ${grindStarts.toFixed(2)}, word at ${fatiguePhase.toFixed(2)} (+${(fatiguePhase - grindStarts).toFixed(2)} of a rep)`,
  );

  // Fatigue starts on the DESCENT and the shoulders on the ASCENT — the order
  // the user watches, not just an ordering of two numbers.
  const phaseOf = (t: number) => timelineAt(1, t);
  const fS = phaseOf(firstOn.fatigue);
  const sS = phaseOf(firstOn.shoulders);
  ok(
    "fatigue is raised on the way down",
    depthAt(fS.phase + 0.01) > depthAt(fS.phase),
    `phase ${fS.phase.toFixed(2)}`,
  );
  ok(
    "the shoulders are raised on the way up",
    depthAt(sS.phase + 0.01) < depthAt(sS.phase),
    `phase ${sS.phase.toFixed(2)}`,
  );
  ok(
    "both are on screen together for a good stretch of the ascent",
    (() => {
      let both = 0;
      for (let ph = 0; ph <= 1; ph += 0.005) {
        const a = tagAmounts(timelineAt(1, (SETTLE_VH + 4 + ph) / PINNED_VH));
        if (a.fatigue > 0.5 && a.shoulders > 0.5) both += 0.005;
      }
      return both > 0.15;
    })(),
  );

  /* Two labels pointing at the same place would look like one label that had
     split in half. They anchor to different parts of the body — fatigue at the
     hips, where the stall in the ascent shows, and the reading at the shoulders
     — so the check is that those are actually far apart on screen. */
  const VH = 900;
  const TAN = Math.tan((32 * Math.PI) / 360);
  const p = newPose();
  let closest = Infinity;
  for (let ph = 0.6; ph <= 1; ph += 0.005) {
    const s = timelineAt(1, (SETTLE_VH + 4 + ph) / PINNED_VH);
    const a = tagAmounts(s);
    if (a.fatigue < 0.5 || a.shoulders < 0.5) continue;
    poseAt(s.depth, s.beat, s.beatAmount, p, s.grind, s.phase);
    const fy = s.targetY - s.camY;
    const fl = Math.hypot(fy, -s.camZ);
    const py = (k: number) => {
      const dy = p[k * 3 + 1] - s.camY;
      const dz = -s.camZ;
      const vy = dy * (s.camZ / fl) + dz * (fy / fl);
      const vz = -(dy * (fy / fl) + dz * (-s.camZ / fl));
      return (0.5 - (vy / (vz * TAN)) * 0.5) * VH;
    };
    closest = Math.min(closest, Math.abs(py(J.hipL) - py(J.shoulderL)));
  }
  ok(
    "the two labels point at clearly different parts of the body",
    closest > 120,
    `hips and shoulders never closer than ${closest.toFixed(0)}px`,
  );
}

/* ── 9c. the leader lines stop on the near joint ──────────────────────────
   A label to the right of the figure aiming at the point BETWEEN the two knees
   has to cross the right leg to get there — which is what it did, a dashed line
   run straight through the shin it was pointing at. It now ends on whichever of
   the pair is on the label's own side. This checks that the choice is real: that
   the pair is meaningfully separated on screen, and that the endpoint picked is
   the one the label can reach without passing anything. */
console.log("\n9c. leader lines");
{
  const VW = 1440;
  const VH = 900;
  const TAN = Math.tan((32 * Math.PI) / 360);
  const p = newPose();

  const screenOf = (s: ReturnType<typeof timelineAt>, joints: [number, number]) => {
    poseAt(s.depth, s.beat, s.beatAmount, p, s.grind, s.phase);
    const cos = Math.cos(s.rotY);
    const sin = Math.sin(s.rotY);
    let cz = 0;
    for (let k = 0; k < JOINT_COUNT; k++) cz += p[k * 3 + 2];
    cz /= JOINT_COUNT;
    const fy = s.targetY - s.camY;
    const fl = Math.hypot(fy, -s.camZ);
    return joints.map((k) => {
      const x0 = p[k * 3];
      const z0 = p[k * 3 + 2] - cz;
      const x = x0 * cos + z0 * sin;
      const z = -x0 * sin + z0 * cos;
      const dy = p[k * 3 + 1] - s.camY;
      const dz = z - s.camZ;
      const vy = dy * (s.camZ / fl) + dz * (fy / fl);
      const vz = -(dy * (fy / fl) + dz * (-s.camZ / fl));
      return [((x / (vz * TAN * (VW / VH))) * 0.5 + 0.5) * VW, (0.5 - (vy / (vz * TAN)) * 0.5) * VH];
    });
  };

  // Exactly SquatRig's rule: the endpoint on the label's own side.
  const near = (a: number[], b: number[], right: boolean) =>
    (right ? a[0] >= b[0] : a[0] <= b[0]) ? a : b;

  const cases: Array<{ id: TagId; joints: [number, number]; right: boolean; rep: number }> = [
    { id: "valgus", joints: [J.kneeL, J.kneeR], right: true, rep: 2 },
    { id: "fatigue", joints: [J.hipL, J.hipR], right: false, rep: 5 },
    { id: "shoulders", joints: [J.shoulderL, J.shoulderR], right: true, rep: 5 },
  ];

  for (const c of cases) {
    let worstGain = Infinity;
    let sampled = 0;
    for (let ph = 0; ph <= 1.0001; ph += 0.005) {
      const s = timelineAt(1, (SETTLE_VH + (c.rep - 1) + ph) / PINNED_VH);
      if (tagAmounts(s)[c.id] < 0.5) continue;
      sampled++;
      const [a, b] = screenOf(s, c.joints);
      const n = near(a, b, c.right);
      const mid = (a[0] + b[0]) / 2;
      // How much closer to the label the endpoint is than the midpoint would be.
      worstGain = Math.min(worstGain, c.right ? n[0] - mid : mid - n[0]);
    }
    ok(
      `"${c.id}" stops short of the midline, never crossing to the far side`,
      sampled > 0 && worstGain > 20,
      `endpoint is ${worstGain.toFixed(0)}px nearer the label than the midpoint (${sampled} samples)`,
    );
  }
}

/* ── 10. the reduced-motion stills ────────────────────────────────────────
   The path a visitor who asked for no motion actually gets. It has to carry the
   same argument, and — the reason this is checked at all — it has to FIT: the
   first version reused the moving scene's cameras and put a figure's feet 35px
   below the bottom of a 400px box, which nothing caught until they were drawn. */
console.log("\n10. the reduced-motion stills");
{
  let worstOut = 0;
  let worstShot = "";
  let smallest = 1;
  for (const shot of SHOTS) {
    const f = frameShot(shot);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < JOINT_COUNT; i++) {
      const [x, y] = f.at(i);
      const out = Math.max(-x, x - SHOT_W, -y, y - SHOT_H, 0);
      if (out > worstOut) {
        worstOut = out;
        worstShot = shot.key;
      }
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    smallest = Math.min(smallest, (hi - lo) / SHOT_H);
  }
  ok(
    "every still frame fits inside its box",
    worstOut < 1,
    worstOut > 0 ? `${worstOut.toFixed(0)}px out on "${worstShot}"` : "0px out",
  );
  ok("no still frame is drawn tiny", smallest > 0.55, `smallest fills ${(smallest * 100).toFixed(0)}%`);

  // Same argument as the moving version, or the reduced-motion visitor is being
  // shown a different product: both faults, the measurement, and a clean rep.
  const keys = SHOTS.map((s) => s.key).join(",");
  ok("the stills cover a clean rep, both faults and the measurement", keys === "clean,valgus,lean,unlevel", keys);
  ok(
    "each still is turned to the view that can read its plane",
    SHOTS.every((s) => (s.beat === "lean" ? s.rotY > 1.5 : s.rotY === 0)),
  );
}

/* ── 11. the jump-turn in the planes section ──────────────────────────────
   A square lens, one body, and the body jumps to change which way it faces. Two
   different things are checked here and they fail for different reasons: the
   FRAMING (it has to fit at both facings, everywhere in between, and with a
   quarter-metre of jump on top of that), and the PHYSICS (a parabola, and
   nothing that torques itself in mid-air). */
console.log("\n11. the planes figure");
{
  const TAN = Math.tan((PLANES_FOV * Math.PI) / 360);
  const p = newPose();

  /**
   * Square box, so aspect is 1 and the vertical and horizontal fits are the same
   * calculation. Returns normalised half-frame units: 1 is the edge, +y is UP.
   *
   * Written out rather than reusing the projection above it: that one negates
   * the view depth, which is invisible to every check that reads it — they all
   * take a magnitude, an extent or an angle, and a global sign flip is a 180°
   * rotation none of those can see. This section compares heights.
   */
  const project = (k: number, rotY: number, lift = 0): [number, number] => {
    let cz = 0;
    for (let i = 0; i < JOINT_COUNT; i++) cz += p[i * 3 + 2];
    cz /= JOINT_COUNT;
    const cos = Math.cos(rotY);
    const sin = Math.sin(rotY);
    const x0 = p[k * 3];
    const z0 = p[k * 3 + 2] - cz;
    const x = x0 * cos + z0 * sin;
    const z = -x0 * sin + z0 * cos;

    // Camera basis: forward toward the target, up perpendicular to it. No roll,
    // so right is world +X. The jump is a translation of the body, so it enters
    // here as a lift on the joint's height and nothing else — the camera does
    // not follow it up.
    const fy = PLANES_TARGET_Y - PLANES_CAM_Y;
    const fl = Math.hypot(fy, -PLANES_CAM_Z);
    const dy = p[k * 3 + 1] + lift - PLANES_CAM_Y;
    const dz = z - PLANES_CAM_Z;
    const up = dy * (PLANES_CAM_Z / fl) + dz * (fy / fl);
    const depth = (dy * fy - dz * PLANES_CAM_Z) / fl;
    return [x / (depth * TAN), up / (depth * TAN)];
  };

  /* ── framing, sampled across the whole jump ─────────────────────────────── */
  let worst = 0;
  let worstAt = "";
  let minFill = 1;
  let worstOffCentre = 0;
  let lowestFoot = Infinity;
  for (let i = 0; i <= 240; i++) {
    const t = (i / 240) * JUMP_S;
    const j = jumpAt(t);
    const rotY = j.turn * (Math.PI / 2);
    poseAt(j.depth, "valgus", valgusFor(j.depth), p);
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < JOINT_COUNT; k++) {
      const [nx, ny] = project(k, rotY, j.y);
      const out = Math.max(Math.abs(nx), Math.abs(ny));
      if (out > worst) {
        worst = out;
        worstAt = `t=${t.toFixed(2)}s`;
      }
      lo = Math.min(lo, ny);
      hi = Math.max(hi, ny);
    }
    minFill = Math.min(minFill, (hi - lo) / 2);
    worstOffCentre = Math.max(worstOffCentre, Math.abs((hi + lo) / 2));
    lowestFoot = Math.min(lowestFoot, p[J.toeL * 3 + 1] + j.y, p[J.ankleL * 3 + 1] + j.y);
  }
  ok(
    "the whole figure stays inside the square lens, jump included",
    worst < 0.96,
    `worst joint at ${(worst * 100).toFixed(1)}% of half-frame (${worstAt})`,
  );
  /* A tucked body at the top of a jump IS smaller, so this is only a floor
     against the shot drifting into a wide — the composition that matters is the
     resting one, checked below. */
  ok(
    "the figure never shrinks out of the lens",
    minFill > 0.45,
    `smallest fill ${(minFill * 100).toFixed(0)}%`,
  );
  /* Centred AT REST, not through the jump — the figure is supposed to be high in
     the frame at the apex, and a shot centred on the union of the two would sit
     the resting figure low for the sake of a pose it holds for a fifth of a
     second. What the reader looks at for all the time in between is the one that
     has to be composed. */
  {
    const rest = jumpAt(0);
    poseAt(rest.depth, "valgus", valgusFor(rest.depth), p);
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < JOINT_COUNT; k++) {
      const ny = project(k, Math.PI / 2)[1];
      lo = Math.min(lo, ny);
      hi = Math.max(hi, ny);
    }
    /* Low in the frame, with the top quarter empty — that empty quarter is the
       jump's room, and it is why this is not centred. The floor under the feet
       stays small: a figure standing in the middle of a box reads as a diagram,
       one standing near the bottom of it reads as standing on something. */
    const off = (hi + lo) / 2;
    ok(
      "the figure sits low, leaving the headroom the jump uses",
      off < -0.05 && off > -0.26,
      `${(off * 100).toFixed(0)}% of half-frame below centre, filling ${(((hi - lo) / 2) * 100).toFixed(0)}%`,
    );
    ok(
      "the resting figure is big enough to read",
      (hi - lo) / 2 > 0.6,
      `fills ${(((hi - lo) / 2) * 100).toFixed(0)}% of the lens height`,
    );
    ok("the feet are near the bottom of the lens, not floating", lo < -0.8, lo.toFixed(2));
  }
  ok(
    "the jump reads as going UP rather than as the shot drifting",
    worstOffCentre > 0.1,
    `figure rises to ${(worstOffCentre * 100).toFixed(0)}% off centre at the apex`,
  );
  ok(
    "nothing ever goes through the floor",
    lowestFoot >= -1e-9,
    `lowest contact point ${lowestFoot.toFixed(4)}`,
  );

  /* ── the flight is ballistic ────────────────────────────────────────────── */
  const yAt = (t: number) => jumpAt(t).y;
  let worstAccel = 0;
  const h = 0.002;
  for (let t = TAKEOFF_S + 0.03; t < LANDING_S - 0.03; t += 0.005) {
    // second difference = vertical acceleration
    const a = (yAt(t + h) - 2 * yAt(t) + yAt(t - h)) / (h * h);
    worstAccel = Math.max(worstAccel, Math.abs(a + G));
  }
  ok(
    "vertical acceleration in flight is exactly -G",
    worstAccel < 0.05,
    `worst deviation ${worstAccel.toFixed(4)} m/s²`,
  );
  let apex = 0;
  for (let t = 0; t <= JUMP_S; t += 0.002) apex = Math.max(apex, yAt(t));
  ok(
    "the apex is the height the hang time implies",
    Math.abs(apex - JUMP_H) < 0.002,
    `${apex.toFixed(3)}m against ${JUMP_H}m`,
  );
  ok(
    "the feet are on the floor except in flight",
    jumpAt(TAKEOFF_S).y < 1e-9 &&
      jumpAt(LANDING_S).y < 1e-9 &&
      jumpAt((TAKEOFF_S + LANDING_S) / 2).y > JUMP_H * 0.99,
    `takeoff ${jumpAt(TAKEOFF_S).y.toFixed(4)}, apex ${jumpAt((TAKEOFF_S + LANDING_S) / 2).y.toFixed(3)}, landing ${jumpAt(LANDING_S).y.toFixed(4)}`,
  );
  // `airborne` is what the sample SAYS about itself; height is what it does.
  // They have to agree, or a reader of the module would be misled about which
  // phase they are in.
  let disagree = 0;
  for (let t = 0; t <= JUMP_S; t += 0.002) {
    const j = jumpAt(t);
    if (j.airborne !== j.y > 0) disagree++;
  }
  ok("the sample's own phase flag matches its height", disagree === 0, `${disagree} samples disagree`);

  /* ── nothing torques itself in mid-air ──────────────────────────────────── */
  const turnAt = (t: number) => jumpAt(t).turn;
  let minW = Infinity;
  let maxW = -Infinity;
  for (let t = TAKEOFF_S + 0.02; t < LANDING_S - 0.02; t += 0.004) {
    const w = (turnAt(t + h) - turnAt(t - h)) / (2 * h);
    minW = Math.min(minW, w);
    maxW = Math.max(maxW, w);
  }
  ok(
    "angular velocity is constant through the flight",
    maxW - minW < 0.02,
    `${minW.toFixed(3)} to ${maxW.toFixed(3)} turns/s`,
  );
  /* The one that pins GROUND_TWIST. The rate the drive hands over at has to be
     the rate the flight carries, or the turn visibly kinks at the instant the
     feet leave — which is the frame a viewer's eye is already on. */
  /* Closed form on both sides, not a finite difference: the drive's rate is
     rising right up to the instant of takeoff, so sampling it a few milliseconds
     early always reads slightly low and the test would be measuring its own step
     size rather than the seam. */
  const wDrive = (2 * GROUND_TWIST) / DRIVE_S;
  const wFlight = (1 - GROUND_TWIST) / FLIGHT_S;
  ok(
    "the turn does not kink at takeoff",
    Math.abs(wDrive - wFlight) < 1e-9,
    `${wDrive.toFixed(4)} into ${wFlight.toFixed(4)} turns/s`,
  );
  ok(
    "the turn is started on the ground and finished in the air",
    GROUND_TWIST > 0.05 && GROUND_TWIST < 0.3 && Math.abs(turnAt(TAKEOFF_S) - GROUND_TWIST) < 1e-9,
    `${(GROUND_TWIST * 100).toFixed(0)}% done at takeoff`,
  );
  ok(
    "the body is square exactly on landing, and stops turning there",
    Math.abs(turnAt(LANDING_S) - 1) < 1e-6 && turnAt(LANDING_S + 0.05) === 1,
    `${turnAt(LANDING_S).toFixed(4)} at touchdown`,
  );
  let backwards = 0;
  for (let t = 0; t < JUMP_S; t += 0.004) if (turnAt(t + 0.004) < turnAt(t) - 1e-9) backwards++;
  ok("the turn never runs backwards", backwards === 0);

  /* ── it counter-moves and it absorbs ────────────────────────────────────── */
  const dAt = (t: number) => jumpAt(t).depth;
  let deepestBefore = 0;
  for (let t = 0; t < TAKEOFF_S; t += 0.004) deepestBefore = Math.max(deepestBefore, dAt(t));
  let deepestAfter = 0;
  for (let t = LANDING_S; t < JUMP_S; t += 0.004) deepestAfter = Math.max(deepestAfter, dAt(t));
  ok(
    "the body dips before it goes up",
    deepestBefore > HOLD_DEPTH + 0.1,
    `${deepestBefore.toFixed(2)} against a held ${HOLD_DEPTH}`,
  );
  ok(
    "the body absorbs on the way down instead of landing rigid",
    deepestAfter > HOLD_DEPTH + 0.1,
    `${deepestAfter.toFixed(2)}`,
  );
  ok(
    "the legs are straight at takeoff and reaching at touchdown",
    dAt(TAKEOFF_S) < 0.02 && dAt(LANDING_S) < 0.02,
    `${dAt(TAKEOFF_S).toFixed(3)} / ${dAt(LANDING_S).toFixed(3)}`,
  );
  ok(
    "it starts and ends at the held depth",
    Math.abs(dAt(0) - HOLD_DEPTH) < 1e-9 && Math.abs(dAt(JUMP_S) - HOLD_DEPTH) < 1e-9,
  );
  // The dip is a countermovement, not a slump: it has to be quick enough to read
  // as loading the legs rather than as the figure sinking.
  ok("the dip is quick", DIP_S < 0.35 && FLIGHT_S > 0.3, `dip ${DIP_S}s, flight ${FLIGHT_S.toFixed(2)}s`);

  /* ── the cave, and what the camera can say about it ─────────────────────── */
  const caveAt = (t: number) => {
    const j = jumpAt(t);
    poseAt(j.depth, "valgus", valgusFor(j.depth), p);
    return Math.abs(p[J.kneeL * 3] - p[J.kneeR * 3]) / Math.abs(p[J.ankleL * 3] - p[J.ankleR * 3]);
  };
  ok(
    "the knees are caved at BOTH facings, to the same degree",
    Math.abs(caveAt(0) - caveAt(JUMP_S)) < 1e-9 && caveAt(0) < 0.6,
    `knee/ankle ${caveAt(0).toFixed(2)} at rest, either way round`,
  );
  ok(
    "the cave eases off as the legs straighten and comes back on landing",
    valgusFor(jumpAt(TAKEOFF_S).depth) < 0.05 && valgusFor(jumpAt(JUMP_S).depth) > 0.99,
  );

  // The reading is GATED, not faded: for almost the whole jump the app would be
  // returning "unknown" rather than a number, and the section has to draw that.
  let unreadable = 0;
  let samples = 0;
  for (let t = 0; t <= JUMP_S; t += 0.004) {
    samples++;
    if (frontalFor(jumpAt(t).turn * (Math.PI / 2)) < 0.001) unreadable++;
  }
  ok(
    "most of the jump shows no frontal reading at all",
    unreadable / samples > 0.6,
    `${((unreadable / samples) * 100).toFixed(0)}% of the jump is unreadable`,
  );
  ok(
    "square-on reads, side-on does not",
    frontalFor(rotOf(0)) > 0.99 && frontalFor(rotOf(1)) === 0,
  );

  /* ── where the stance marks land ────────────────────────────────────────── */
  const j0 = jumpAt(JUMP_S);
  poseAt(j0.depth, "valgus", valgusFor(j0.depth), p);
  const box = (ny: number) => (0.5 - ny * 0.5) * 1000;
  const bx = (nx: number) => (nx * 0.5 + 0.5) * 1000;
  const ankL = bx(project(J.ankleL, 0)[0]);
  const ankR = bx(project(J.ankleR, 0)[0]);
  ok(
    "the stance marks straddle the centre of the lens head-on",
    Math.min(ankL, ankR) > 100 &&
      Math.max(ankL, ankR) < 900 &&
      Math.abs((ankL + ankR) / 2 - 500) < 60,
    `${ankL.toFixed(0)} and ${ankR.toFixed(0)}`,
  );
  const ankY = box(project(J.ankleL, 0)[1]);
  ok(
    "the stance marks span shin to floor, inside the lens",
    ankY - 210 > 40 && ankY + 40 < 990,
    `${(ankY - 210).toFixed(0)} to ${(ankY + 40).toFixed(0)}, ankle at ${ankY.toFixed(0)}`,
  );
}

console.log(
  failures === 0 ? "\nALL PASSED\n" : `\n${failures} FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
