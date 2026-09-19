/**
 * Offscreen checks for the site: the squat poses and their fault timing, the
 * sample debrief's wording against the app's own rules, and the page's camera
 * path. Pure modules only, run in Node — no renderer, no DOM.
 */
import { BONES, J } from "../src/lib/pose";
import {
  BOTTOM,
  STAND,
  newPose,
  poseAt,
  valgusEnvelope,
  leanEnvelope,
  unlevelEnvelope,
  grindEnvelope,
  depthAt,
} from "../src/lib/poseFrames";
import { LEAN_DELTA_DEG, POST_SET, SHOULDER_PEAK_DEG } from "../src/lib/postSet";
import {
  END,
  HOLDS,
  STARTS,
  STOPS,
  STOP_COUNT,
  TOTAL,
  mixShot,
  newSample,
  settleTarget,
  storyAt,
  type Shot,
} from "../src/lib/story";

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

  /* The shoulder angle is an EXAMPLE figure now — the page no longer plays the
     set it came from — but it still has to be a tilt the figure can actually
     make, or the example quotes a number the body on the page never produces. */
  const levelP = newPose();
  const tiltP = newPose();
  let tiltPeak = 0;
  for (let d = 0; d <= 1.0001; d += 0.02) {
    poseAt(d, "unlevel", 1, tiltP);
    const deg = Math.abs(
      (Math.atan2(tiltP[J.shoulderR * 3 + 1] - tiltP[J.shoulderL * 3 + 1], tiltP[J.shoulderR * 3] - tiltP[J.shoulderL * 3]) * 180) /
        Math.PI,
    );
    tiltPeak = Math.max(tiltPeak, deg);
  }
  poseAt(0.4, null, 0, levelP);
  ok(
    "the quoted shoulder angle is one the figure can make",
    SHOULDER_PEAK_DEG > 6 && SHOULDER_PEAK_DEG <= tiltPeak + 1,
    `copy says ${SHOULDER_PEAK_DEG}deg, the pose reaches ${tiltPeak.toFixed(1)}deg`,
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

  /* 7. It says what it is: the artefact the app hands back at the end of a set
     (the page also marks it as an example — the reader didn't film this set). */
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

/* ── 5. the page's camera path ─────────────────────────────────────────────
   The canvas and the text both read storyAt(); these are the promises they
   rely on. */
console.log("\n5. the camera path");
{
  ok("the stops tile the page", STARTS.every((s, i) => i === 0 || Math.abs(s - (STARTS[i - 1] + STOPS[i - 1].span)) < 1e-9) && TOTAL > 5);
  ok("the first hold starts at the top", HOLDS[0][0] === 0);
  ok("the last hold runs to the end of the scroll", HOLDS[STOP_COUNT - 1][1] === END);
  ok(
    "every hold sits inside its stop, in order, with a move between each",
    HOLDS.every(([a, b], i) => a < b && a >= STARTS[i] - 1e-9 && b <= STARTS[i] + STOPS[i].span + 1e-9 && (i === 0 || HOLDS[i - 1][1] < a)),
  );

  const s = newSample();
  const cam = (smp: ReturnType<typeof storyAt>) => {
    const out: Shot = { ...STOPS[0].shot };
    mixShot(STOPS[smp.from].shot, STOPS[smp.to].shot, smp.blend, out);
    return [out.azimuth, out.elevation, out.distance + smp.dolly, ...out.target, ...out.shift];
  };
  const STEP = 0.0005;
  let prev = cam(storyAt(0, s));
  let worstJump = 0;
  let cuts = 0;
  let twoInFocus = 0;
  let maxSum = 0;
  let presenceJump = 0;
  let prevPresence = [...s.presence];
  const reached = new Array(STOP_COUNT).fill(0);
  const prevLocal = [...s.local];
  let localBack = 0;
  let irisMax = 0;
  let irisElsewhere = 0;
  for (let p = STEP; p <= END + 1e-9; p += STEP) {
    storyAt(p, s);
    const now = cam(s);
    const jump = Math.max(...now.map((v, k) => Math.abs(v - prev[k])));
    // The one allowed discontinuity: the cut behind the closed iris.
    if (jump > 0.02) {
      if (s.iris > 0.95) cuts++;
      else worstJump = Math.max(worstJump, jump);
    } else worstJump = Math.max(worstJump, jump);
    prev = now;
    const sharp = s.focus.filter((f) => f > 0.5).length;
    if (sharp > 1) twoInFocus++;
    maxSum = Math.max(maxSum, s.focus.reduce((a, b) => a + b, 0));
    s.focus.forEach((f, k) => (reached[k] = Math.max(reached[k], f)));
    presenceJump = Math.max(presenceJump, ...s.presence.map((v, k) => Math.abs(v - prevPresence[k])));
    prevPresence = [...s.presence];
    s.local.forEach((v, k) => {
      if (v < prevLocal[k] - 1e-9) localBack++;
      prevLocal[k] = v;
    });
    irisMax = Math.max(irisMax, s.iris);
    if (s.iris > 0 && !STOPS[s.to].throughIris) irisElsewhere++;
  }
  ok("the camera never jumps between frames of scroll", worstJump < 0.02, `worst ${worstJump.toFixed(4)} per ${STEP} screens`);
  ok("the only cut is hidden behind the closed iris", cuts === 1, `${cuts} cut(s)`);
  ok("the iris closes fully, and only on the way into the finale", irisMax > 0.99 && irisElsewhere === 0);
  ok("never two stops sharp at once", twoInFocus === 0 && maxSum <= 1 + 1e-9, `max total focus ${maxSum.toFixed(3)}`);
  ok("every stop comes fully into focus", reached.every((f) => f === 1), reached.map((f) => f.toFixed(2)).join(" "));
  ok("props fade rather than pop", presenceJump < 0.01, `worst ${presenceJump.toFixed(4)} per step`);
  ok("each stop's own progress only runs forward", localBack === 0);

  let settleBad = 0;
  for (let p = 0; p <= END; p += 0.01) {
    const t = settleTarget(p);
    const inHold = HOLDS.some(([a, b]) => p >= a && p <= b);
    if (inHold !== (t === null)) settleBad++;
    if (t !== null && Math.max(...storyAt(t, s).focus) !== 1) settleBad++;
    if (t !== null && Math.abs(t - p) > 0.6) settleBad++;
  }
  ok("stopping between holds settles into the nearer one, sharply", settleBad === 0, `${settleBad} bad`);
}

console.log(failures === 0 ? "\nALL PASSED\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
