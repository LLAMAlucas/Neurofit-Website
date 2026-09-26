/**
 * Offscreen checks for the site: the three exercises' poses and their fault
 * timing, the scripted set each exercise stop plays, the sample debrief's
 * wording against the app's own rules, and the page's camera path. Pure modules
 * only, run in Node — no renderer, no DOM.
 */
import { BONES, J, type JointName } from "../src/lib/pose";
import { BOTTOM, REST, STAND, depthAt, leanEnvelope, newPose, shiftEnvelope, valgusEnvelope } from "../src/lib/poseFrames";
import { EXERCISES, EXERCISE_ORDER, checkOf, trunkLeanDeg, type ExerciseId } from "../src/lib/exercises";
import { cycleS, loopAt, newLoopSample } from "../src/lib/loop";
import { WRIST_Y as PUSHUP_WRIST_Y, flareRatio, pressTiltDeg, pushupBodyLineDeg } from "../src/lib/pushup";
import { BAR_Y, chinY, kneeLiftDeg, shoulderTiltDeg, swingDeg } from "../src/lib/pullup";
import { LEAN_EXTRA_DEG, POST_SET } from "../src/lib/postSet";
import {
  FLOW_DUR,
  FLOW_REP,
  FLOW_REP_S,
  FLOW_SET,
  FLOW_STEPS,
  LANDMARK_COUNT,
  LANDMARK_LINKS,
  LINE_FROM_S,
  READ_FROM,
  READ_TO,
  SCAN_S,
  SIDE_SCAN_AT_S,
  STEP,
  flowStepAt,
  flowAt,
  linkAt,
  markAt,
  scanAt,
} from "../src/lib/flowScript";
import { CHECKED, COMPETITORS, FACTS, MOMENTS, US } from "../src/lib/competitors";
import {
  END,
  EXERCISE_AT,
  HOLDS,
  STARTS,
  STOPS,
  STOP_COUNT,
  TOTAL,
  mixShot,
  newSample,
  stopIndex,
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

/** Walk one rep of `check` and hand each frame's pose to `f`. */
function walk(ex: ExerciseId, check: string, f: (p: Float32Array, phase: number) => void, step = 0.005) {
  const p = newPose();
  for (let ph = 0; ph <= 1.0001; ph += step) {
    EXERCISES[ex].rep(check, ph, 1, p);
    f(p, ph);
  }
}
/** The largest and smallest of a reading over one rep. */
function range(ex: ExerciseId, check: string, read: (p: Float32Array) => number) {
  let lo = Infinity;
  let hi = -Infinity;
  walk(ex, check, (p) => {
    const v = read(p);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  });
  return { lo, hi, span: hi - lo };
}

/* ── 1. bone lengths hold through every rep ───────────────────────────────
   The squat interpolates two keyframes and relaxes; the push-up and pull-up
   are built joint by joint. Either way a bone that stretches reads as the body
   melting — and every exercise is the same body, with the same bones. */
console.log("\n1. bone lengths through every rep");
for (const ex of EXERCISE_ORDER) {
  let worst = 0;
  let worstAt = "";
  for (const c of EXERCISES[ex].checks) {
    walk(ex, c.id, (p, ph) => {
      BONES.forEach(([a, b], i) => {
        const drift = Math.abs(len(p, J[a], J[b]) - REST[i]) / REST[i];
        if (drift > worst) {
          worst = drift;
          worstAt = `${a}->${b} on ${c.id} @${ph.toFixed(2)}`;
        }
      });
    }, 0.01);
  }
  ok(`${ex}: no bone drifts more than 8%`, worst < 0.08, `worst ${(worst * 100).toFixed(1)}% (${worstAt})`);
}

/* ── 2. contacts stay put ─────────────────────────────────────────────────
   Feet on the floor for a squat; hands and the balls of the feet for a
   push-up; hands on the bar for a pull-up. A contact that slides reads as
   skating. */
console.log("\n2. contact points");
const CONTACTS: Record<ExerciseId, JointName[]> = {
  squat: ["ankleL", "ankleR", "toeL", "toeR"],
  pushup: ["wristL", "wristR", "toeL", "toeR"],
  pullup: ["wristL", "wristR"],
};
for (const ex of EXERCISE_ORDER) {
  const rest = newPose();
  EXERCISES[ex].rep("clean", 0, 1, rest);
  let moved = 0;
  for (const c of EXERCISES[ex].checks) {
    walk(ex, c.id, (p) => {
      for (const n of CONTACTS[ex]) {
        const i = J[n] * 3;
        moved = Math.max(moved, Math.hypot(p[i] - rest[i], p[i + 1] - rest[i + 1], p[i + 2] - rest[i + 2]));
      }
    }, 0.01);
  }
  ok(`${ex}: its contacts never move`, moved < 1e-6, `max ${moved.toExponential(1)} m`);
}
{
  ok(
    "squat: the hip drops further than the knee",
    STAND[J.hipL * 3 + 1] - BOTTOM[J.hipL * 3 + 1] > 4 * (STAND[J.kneeL * 3 + 1] - BOTTOM[J.kneeL * 3 + 1]),
  );
  ok("squat: the hip reaches knee level at the bottom (parallel)", Math.abs(BOTTOM[J.hipL * 3 + 1] - BOTTOM[J.kneeL * 3 + 1]) < 0.02);

  let under = 0;
  for (const c of EXERCISES.pushup.checks) walk("pushup", c.id, (p) => {
    for (let k = 0; k < 16; k++) under = Math.min(under, p[k * 3 + 1]);
  }, 0.01);
  ok("push-up: nothing goes through the floor", under >= 0, `lowest joint ${under.toFixed(3)} m`);
  ok("push-up: the hands are on the floor", PUSHUP_WRIST_Y < 0.05);

  let feet = Infinity;
  for (const c of EXERCISES.pullup.checks) walk("pullup", c.id, (p) => {
    feet = Math.min(feet, p[J.toeL * 3 + 1], p[J.toeR * 3 + 1]);
  }, 0.01);
  ok("pull-up: the feet hang clear of the floor, every rep", feet > 0.05, `lowest toe ${feet.toFixed(3)} m`);
}

/* ── 3. each fault is the fault, when it should be ────────────────────────
   Every fault the page lights has to be one the pose actually makes — past
   the line the app itself would flag — and a clean rep has to stay inside it.
   Timing matters where the app's evidence says so: the knee caves on the way
   UP, the lean is worst at the bottom. */
console.log("\n3. the faults");
{
  // Squat timing (the 2026-07-31 eval run: the cave was worst on the ascent).
  let descent = 0;
  let ascent = 0;
  for (let ph = 0; ph <= 1.0001; ph += 0.01) {
    const v = valgusEnvelope(ph);
    if (depthAt(ph + 0.005) > depthAt(ph)) descent = Math.max(descent, v);
    else if (depthAt(ph + 0.005) < depthAt(ph)) ascent = Math.max(ascent, v);
  }
  ok("squat: the knee cave never shows on the descent", descent < 0.02, `peak ${descent.toFixed(3)}`);
  ok("squat: the knee cave reaches full on the ascent", ascent > 0.98);
  let best = 0;
  let bestPh = 0;
  for (let ph = 0; ph <= 1.0001; ph += 0.005) if (leanEnvelope(ph) > best) (best = leanEnvelope(ph)), (bestPh = ph);
  ok("squat: the lean peaks at depth", depthAt(bestPh) > 0.95, `phase ${bestPh.toFixed(2)}`);
  let shiftAt = 0;
  for (let ph = 0; ph <= 1.0001; ph += 0.005) if (shiftEnvelope(ph) > 0.99) shiftAt = ph;
  ok("squat: the hip shift is gone by lockout", depthAt(shiftAt) > 0.2 && shiftEnvelope(0.97) < 0.01);

  const kneeW = (p: Float32Array) => Math.abs(p[J.kneeL * 3] - p[J.kneeR * 3]);
  const ankleW = Math.abs(STAND[J.ankleL * 3] - STAND[J.ankleR * 3]);
  const caved = range("squat", "valgus", kneeW).lo / ankleW;
  const cleanKnees = range("squat", "clean", kneeW).lo / ankleW;
  ok("squat: clean knees track outside the ankles, caved ones well inside", cleanKnees > 1 && caved < 0.6, `${cleanKnees.toFixed(2)} → ${caved.toFixed(2)}`);

  const trunk = (p: Float32Array) => {
    const hy = (p[J.hipL * 3 + 1] + p[J.hipR * 3 + 1]) / 2;
    const hz = (p[J.hipL * 3 + 2] + p[J.hipR * 3 + 2]) / 2;
    return (Math.atan2(p[J.neck * 3 + 2] - hz, p[J.neck * 3 + 1] - hy) * 180) / Math.PI;
  };
  const extra = range("squat", "lean", trunk).hi - range("squat", "clean", trunk).hi;
  ok("squat: the lean adds roughly 20 degrees of trunk pitch", extra > 18 && extra < 23, `${extra.toFixed(1)}°`);

  // Hip shift, in hip widths, the unit the app's reading uses (warn 0.3).
  const hipW = Math.abs(STAND[J.hipL * 3] - STAND[J.hipR * 3]);
  const shift = (p: Float32Array) =>
    Math.abs((p[J.hipL * 3] + p[J.hipR * 3]) / 2 - (p[J.ankleL * 3] + p[J.ankleR * 3]) / 2) / hipW;
  ok(
    "squat: the shift goes past 0.3 hip-widths, a clean rep stays at 0",
    range("squat", "shift", shift).hi > 0.3 && range("squat", "clean", shift).hi < 0.01,
    `${range("squat", "shift", shift).hi.toFixed(2)}`,
  );

  // The rep that stops short: nowhere near parallel.
  const hipOverKnee = (p: Float32Array) => p[J.hipL * 3 + 1] - p[J.kneeL * 3 + 1];
  ok(
    "squat: the shallow rep stays well above parallel",
    range("squat", "shallow", hipOverKnee).lo > 0.12,
    `hip ${range("squat", "shallow", hipOverKnee).lo.toFixed(2)} m over the knee`,
  );

  // Push-up: body line (P1 — sag 25° / pike 35° absolute, ±15° relative), flare
  // (P7 — ratio ≥ 1.0), uneven press (P11 — +8° of tilt).
  const lineClean = range("pushup", "clean", pushupBodyLineDeg);
  ok("push-up: a clean rep holds a straight body line", lineClean.lo > 178, `${lineClean.lo.toFixed(1)}°`);
  ok("push-up: the sag bends it past 15°", 180 - range("pushup", "sag", pushupBodyLineDeg).lo > 15);
  ok("push-up: the pike bends it past 25°", 180 - range("pushup", "pike", pushupBodyLineDeg).lo > 25);
  const hipsOverLine = (p: Float32Array) => {
    // Height of the hips over the straight line from the ankles to the shoulders.
    const m = (a: JointName, b: JointName, k: number) => (p[J[a] * 3 + k] + p[J[b] * 3 + k]) / 2;
    const ay = m("ankleL", "ankleR", 1), az = m("ankleL", "ankleR", 2);
    const sy = m("shoulderL", "shoulderR", 1), sz = m("shoulderL", "shoulderR", 2);
    const hy = m("hipL", "hipR", 1), hz = m("hipL", "hipR", 2);
    return hy - (ay + ((sy - ay) * (hz - az)) / (sz - az));
  };
  ok(
    "push-up: a sag drops the hips below the line, a pike lifts them",
    range("pushup", "sag", hipsOverLine).lo < -0.05 && range("pushup", "pike", hipsOverLine).hi > 0.05,
  );
  ok(
    "push-up: flared elbows cross the app's line, tucked ones don't",
    range("pushup", "flare", flareRatio).hi >= 1 && range("pushup", "clean", flareRatio).hi < 0.8,
    `${range("pushup", "clean", flareRatio).hi.toFixed(2)} → ${range("pushup", "flare", flareRatio).hi.toFixed(2)}`,
  );
  const tilt = (p: Float32Array) => Math.abs(pressTiltDeg(p));
  ok(
    "push-up: the uneven press tilts past 8°, a clean one stays level",
    range("pushup", "uneven", tilt).hi > 8 && range("pushup", "clean", tilt).hi < 0.5,
    `${range("pushup", "uneven", tilt).hi.toFixed(1)}°`,
  );

  // Pull-up: swing (U1 — range over the rep, abs 20°), leg drive (U3 — ≥ 30°),
  // uneven (U4 — +8°), and a chin that clears the bar only when it should.
  ok("pull-up: a strict rep swings only a few degrees", range("pullup", "clean", swingDeg).span < 5, `${range("pullup", "clean", swingDeg).span.toFixed(1)}°`);
  ok("pull-up: the kip swings past 20°", range("pullup", "kip", swingDeg).span > 20, `${range("pullup", "kip", swingDeg).span.toFixed(1)}°`);
  ok(
    "pull-up: the leg drive lifts the knees past 30°, a strict rep barely",
    range("pullup", "legDrive", kneeLiftDeg).hi > 30 && range("pullup", "clean", kneeLiftDeg).hi < 10,
  );
  const ptilt = (p: Float32Array) => Math.abs(shoulderTiltDeg(p));
  ok("pull-up: the uneven pull tilts past 8°", range("pullup", "uneven", ptilt).hi > 8 && range("pullup", "clean", ptilt).hi < 0.5);
  for (const c of EXERCISES.pullup.checks) {
    const top = range("pullup", c.id, chinY).hi;
    if (c.id === "chinShort") ok("pull-up: the short rep's chin never reaches the bar", top < BAR_Y - 0.04, `${(top - BAR_Y).toFixed(3)} m`);
    else ok(`pull-up: the ${c.id} rep's chin clears the bar`, top > BAR_Y + 0.02, `${(top - BAR_Y).toFixed(3)} m`);
  }
  // The head passes the bar behind it, never through it.
  let closest = Infinity;
  for (const c of EXERCISES.pullup.checks) walk("pullup", c.id, (p) => {
    closest = Math.min(closest, Math.hypot(p[J.head * 3 + 1] - BAR_Y, p[J.head * 3 + 2]));
  }, 0.01);
  ok("pull-up: the head never passes through the bar", closest > 0.11, `closest ${closest.toFixed(3)} m`);
}

/* ── 4. the scripted set ──────────────────────────────────────────────────
   What each exercise stop plays. It is a set a person could do: it opens clean,
   the faults are unprompted, clean reps are mixed in, every check on the list
   comes up, and the counter only moves for reps that count. */
console.log("\n4. the scripted sets");
for (const ex of EXERCISE_ORDER) {
  const spec = EXERCISES[ex];
  const script = spec.script;
  ok(`${ex}: the set opens on a clean rep`, script[0] === "clean");
  ok(`${ex}: clean reps are mixed in`, script.filter((c) => c === "clean").length >= 2);
  ok(`${ex}: every check on its list comes up`, spec.checks.every((c) => script.includes(c.id)));
  const p = newPose();
  const s = newLoopSample();
  const cycle = cycleS(spec);
  const litOrder: string[] = [];
  let last = 0;
  let redOnClean = 0;
  let back = 0;
  let prev = 0;
  for (let t = 0; t < cycle; t += 0.02) {
    loopAt(spec, t, 1, p, s);
    if (s.counted < prev) back++;
    prev = last = s.counted;
    if (s.lit && litOrder[litOrder.length - 1] !== `${s.index}:${s.lit}`) litOrder.push(`${s.index}:${s.lit}`);
    if (s.kind !== "fault" && s.envelope > 0) redOnClean++;
  }
  const expected = script.filter((c) => checkOf(spec, c).kind !== "miss").length;
  ok(`${ex}: the counter ends the set on ${expected}, never counting back`, last === expected && back === 0, `ends on ${last}`);
  ok(`${ex}: each rep lights its own line, in order`, litOrder.join(" ") === script.map((c, i) => `${i}:${c}`).join(" "), litOrder.join(" "));
  ok(`${ex}: only a fault turns anything red`, redOnClean === 0);
  loopAt(spec, 1.234, 1, p, s);
  const a = Array.from(p);
  loopAt(spec, 1.234 + cycle, 1, p, s);
  ok(`${ex}: the set runs again from the top`, a.every((v, i) => Math.abs(v - p[i]) < 1e-6) && s.counted === 0);
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
     parser, so an asterisk reaches a real user as an asterisk. */
  ok("no markdown in the debrief", !/[*_`#]|<[a-z]/i.test(all));

  /* 2. No normalised numbers: every number is a rep number, a count, or
     degrees — the check is on the decimals, the form the leak took. And of the
     degrees, only the trunk lean, read side-on. */
  const decimals = prose.match(/-?\d+\.\d+/g) ?? [];
  ok("no normalised coordinate is quoted at the reader", decimals.every((d) => prose.includes(`${d} degrees`)), decimals.join(", ") || "no decimals");
  ok("no negative number reaches the reader", !/-\d/.test(prose));
  const degrees = [...prose.matchAll(/(\d+) degrees/g)].map((m) => Number(m[1]));
  ok("the only degrees quoted are the trunk lean's", degrees.length === 1 && degrees[0] === LEAN_EXTRA_DEG, degrees.join(", "));

  /* 3. The number is MEASURED: re-derived here from the same poses the scene
     draws, so editing a pose fails this check rather than leaving the page
     quoting a figure the body stopped producing. */
  const extra = range("squat", "lean", trunkLeanDeg).hi - range("squat", "clean", trunkLeanDeg).hi;
  ok(
    "the quoted lean is how much further the flagged reps lean than the clean ones",
    Math.abs(extra - LEAN_EXTRA_DEG) < 1,
    `copy ${LEAN_EXTRA_DEG}°, pose ${extra.toFixed(1)}°`,
  );

  /* 4. No causation, between faults or from context to fault. A cue makes no
     claim about the set; the give-away in one would be a retrospective
     connective, not the word "so". */
  const RETROSPECTIVE =
    /\b(caused|causing|because|due to|led to|leading to|result(ed|ing) (in|from)|which is why|hence|therefore)\b/i;
  const DESCRIPTIVE = new RegExp(`${RETROSPECTIVE.source}|\\bso the\\b|\\bmeaning\\b`, "i");
  ok(
    "the description of the set claims no causation",
    POST_SET.paras.every((t) => !DESCRIPTIVE.test(t)),
    POST_SET.paras.find((t) => DESCRIPTIVE.test(t)) ?? "",
  );
  ok("the cues make no retrospective claim either", POST_SET.cues.every((t) => !RETROSPECTIVE.test(t)));
  ok(
    "every sentence of the findings names the reps it is about",
    POST_SET.paras[1].split(/(?<=\.)\s+/).every((sentence) => /\bReps? \d/.test(sentence)),
  );

  /* 5. It describes the set the flow just played. The clean reps come first
     and by number; every rep that went wrong is accounted for; the count is
     the set's. */
  const script = FLOW_SET;
  const cleanReps = script.map((c, i) => (c === "clean" ? i + 1 : 0)).filter(Boolean);
  ok("the clean reps are named, first", new RegExp(`Reps ${cleanReps[0]} and ${cleanReps[1]} were clean`).test(POST_SET.paras[0]));
  const flagged = script.map((c, i) => (c === "clean" ? 0 : i + 1)).filter(Boolean);
  const named = (POST_SET.paras[1].match(/^Reps? ((?:\d+(?:, | and ))*\d+)\b/)?.[1] ?? "").match(/\d+/g)?.map(Number) ?? [];
  ok("every rep the set flags is accounted for", flagged.join() === named.join(), `flagged ${flagged}, named ${named}`);
  const counted = script.filter((c) => checkOf(EXERCISES.squat, c).kind !== "miss").length;
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven"];
  ok("the count matches the set", POST_SET.paras[0].toLowerCase().startsWith(`${words[script.length]} reps, ${words[counted]} counted`));
  ok("the flagged reps are the ones the flow flashes", script.slice(cleanReps.length).every((c) => c === FLOW_REP));

  /* 6. It says what it is, and ends on exactly two cues. */
  ok("the panel names itself", /post-set summary/i.test(POST_SET.label));
  ok("there are exactly two cues", POST_SET.cues.length === 2, String(POST_SET.cues.length));

  /* 7. It has to FIT. The panel is fixed and centred with no scroll of its own,
     so anything taller than the viewport is lost off both ends. Measured at the
     two sizes that bite: the 520px desktop panel, and a 375px phone. */
  const lines = (text: string, px: number, fontPx: number) => Math.ceil(text.length / Math.max(1, (px / fontPx) * 1.92));
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

/* ── 4e. the flow script ──────────────────────────────────────────────────
   The flow stop's steps, played by scroll, and the timed pieces each starts. */
console.log("\n4e. the flow script");
{
  ok(
    "the steps start in order, the first at the start of the hold",
    FLOW_STEPS[0].from === 0 && FLOW_STEPS.every((s, i) => i === 0 || s.from > FLOW_STEPS[i - 1].from) && FLOW_STEPS.at(-1)!.from < 1,
  );
  let back = 0;
  let prevStep = flowStepAt(-0.1);
  for (let u = -0.1; u <= 1.1; u += 0.001) {
    const k = flowStepAt(u);
    if (k < prevStep) back++;
    prevStep = k;
  }
  ok("scrolling on only ever moves the step on", back === 0 && flowStepAt(-0.01) === -1 && flowStepAt(1.2) === FLOW_STEPS.length - 1);

  /* The scrub: every animation in the flow is a function of the scroll, so
     it moves only while the reader scrolls and freezes when they stop. */
  const at = (u: number) => flowAt(u);
  const stepEnd = (i: number) => (FLOW_STEPS[i + 1]?.from ?? 1) - 1e-6;
  ok("the same scroll always shows the same scene (stopped = frozen)", JSON.stringify(at(0.37)) === JSON.stringify(at(0.37)));
  ok("nothing moves before the hold", at(-0.01).step === -1 && at(-0.01).scan === 0 && at(-0.01).squat === 0 && at(-0.01).turn === 0);
  {
    // The front scan: sweeps top to bottom, blinks, and is gone by the end of
    // its step — all within its own stretch of scroll.
    let blinks = 0;
    let wasOn = true;
    let maxSweep = 0;
    for (let u = 0; u < FLOW_STEPS[STEP.points].from; u += 0.0005) {
      const f = at(u);
      maxSweep = Math.max(maxSweep, f.sweep < 1 ? f.sweep : 0);
      // A blink is the scan dropping to its dim "off" level (the final fade
      // passes through smoothly and never sits there).
      const on = !(f.sweep === 1 && Math.abs(f.scan - 0.1) < 1e-9);
      if (wasOn && !on) blinks++;
      wasOn = on;
    }
    ok("the front scan sweeps down and blinks twice as you scroll", maxSweep > 0.9 && blinks === 2, `${blinks} blinks`);
    ok("…and has gone before the points start", at(stepEnd(STEP.camera)).scan === 0);
  }
  {
    const end = at(stepEnd(STEP.points));
    ok(
      "every point pops in and every line is drawn within the points' scroll",
      Array.from({ length: LANDMARK_COUNT }, (_, i) => markAt(i, end.marksT)).every((m) => m === 1) &&
        LANDMARK_LINKS.every((_, k) => linkAt(k, end.marksT) === 1),
    );
    const first = at(FLOW_STEPS[STEP.points].from + 0.002);
    ok("…one by one, not all at once", markAt(0, first.marksT) < 1 && markAt(LANDMARK_COUNT - 1, first.marksT) === 0);
  }
  {
    const v0 = at(FLOW_STEPS[STEP.view].from);
    const v1 = at(stepEnd(STEP.view));
    let sideScan = 0;
    for (let u = FLOW_STEPS[STEP.view].from; u < FLOW_STEPS[STEP.reps].from; u += 0.0005) sideScan = Math.max(sideScan, at(u).turn === 1 ? at(u).scan : 0);
    ok("the body turns to the side within the view's scroll, points faded first", v0.turn === 0 && v1.turn === 1 && v1.marks === 0);
    ok("…and is scanned again once side-on", sideScan === 1 && v1.scan === 0);
  }
  {
    const r1 = at(stepEnd(STEP.reps));
    let flashes = 0;
    let wasLit = false;
    for (let u = FLOW_STEPS[STEP.reps].from; u < FLOW_STEPS[STEP.ask].from; u += 0.0005) {
      const lit = at(u).flash > 0.6;
      if (lit && !wasLit) flashes++;
      wasLit = lit;
    }
    ok("two whole flagged reps play within the reps' scroll", Math.abs(r1.squatT - FLOW_DUR.reps) < 1e-3, `${r1.squatT.toFixed(2)} s`);
    ok("two red flashes a rep, each scrolled through", flashes === 4, `${flashes} flashes`);
  }
  {
    // No jumps: the turn, the squat and the points only ever move a little
    // for a little scroll — scrubbing never skips a frame of them.
    let worst = 0;
    let prev = at(0);
    for (let u = 0.0005; u <= 1; u += 0.0005) {
      const f = at(u);
      worst = Math.max(worst, Math.abs(f.turn - prev.turn), Math.abs(f.squatT - prev.squatT), Math.abs(f.squat - prev.squat));
      prev = f;
    }
    ok("a little scroll only ever moves the scene a little", worst < 0.05, `worst ${worst.toFixed(3)}`);
    ok("the dots go out across the border only in the ask step", at(stepEnd(STEP.reps)).stream === 0 && at(0.99).stream > 3);
  }
  const mid = scanAt(0.3);
  ok("the scan is lit while it sweeps down", mid.amount === 1 && mid.sweep > 0 && mid.sweep < 1);
  ok("the scan has gone once it's done", scanAt(SCAN_S).amount === 0 && scanAt(SCAN_S - 0.001).amount < 0.01);
  let blinks = 0;
  let wasOn = true;
  for (let t = 0; t < SCAN_S; t += 0.005) {
    const on = scanAt(t).amount > 0.5;
    if (on && !wasOn) blinks++;
    wasOn = on;
  }
  ok("it blinks twice before it goes", blinks === 2, `${blinks}`);
  ok(
    "33 points, joined only to each other",
    LANDMARK_COUNT === 33 && LANDMARK_LINKS.every(([a, b]) => a >= 0 && b >= 0 && a < 33 && b < 33 && a !== b),
  );
  ok("every point is joined to something", Array.from({ length: 33 }, (_, i) => i).every((i) => LANDMARK_LINKS.some(([a, b]) => a === i || b === i)));
}

/* ── 4d. the comparison ───────────────────────────────────────────────────
   Public claims about other companies' products. Each one in the product's
   own words from its own pages, dated; what they don't say stays unsaid. */
console.log("\n4d. the comparison");
{
  ok("the comparison says when it was checked", /\b20\d\d\b/.test(CHECKED), CHECKED);
  ok(
    "every other product names its sources, on https",
    COMPETITORS.every((c) => c.sources.length > 0 && c.sources.every((s) => s.url.startsWith("https://"))),
  );
  ok("Neuro-Fit states every fact about itself", FACTS.every((f) => !!US.facts[f.id]));
  ok("Neuro-Fit shows up at every moment it covers", MOMENTS.every((m) => !!US.when[m.id]));
  ok("every other product has at least one moment it covers", COMPETITORS.every((c) => MOMENTS.some((m) => c.when[m.id])));
  /* A gap is "not stated", never a "no": nothing about another product is
     written as a lack. */
  const NEGATIVE = /^(no|not|none|doesn’t|doesn't|can’t|can't|never|without)\b/i;
  const claims = COMPETITORS.flatMap((c) => [...Object.values(c.facts), ...Object.values(c.when)]).filter(
    (v): v is string => typeof v === "string",
  );
  ok("nothing about another product is written as a lack", claims.every((t) => !NEGATIVE.test(t)), claims.find((t) => NEGATIVE.test(t)) ?? "");
  ok("product ids are unique", new Set([US, ...COMPETITORS].map((c) => c.id)).size === COMPETITORS.length + 1);
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
  ok(
    "the stops run in order: opening, in frame, what happens to it, how it compares, try it",
    STOPS.map((s) => s.id).join(" ") === "form frame flow compare finale",
  );
  // Scrubbed by the scroll, slowly enough to follow: every step of the flow
  // takes most of a screen of scroll, none more than one.
  const flowHold = HOLDS[stopIndex("flow")][1] - HOLDS[stopIndex("flow")][0];
  const perStep = FLOW_STEPS.slice(0, -1).map((st, i) => (FLOW_STEPS[i + 1].from - st.from) * flowHold);
  ok(
    "each flow step takes 0.6–0.9 screens of scroll",
    perStep.every((x) => x >= 0.6 && x <= 0.9),
    perStep.map((x) => x.toFixed(2)).join(" "),
  );
  const readScroll = (READ_TO - READ_FROM) * flowHold;
  ok("the read gets half a screen or more to write itself out", readScroll >= 0.5, `${readScroll.toFixed(2)} screens`);

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


  /* The exercise changes at the middle of a move, where no stop's words are
     sharp — so the body blowing apart and re-forming never happens under text
     the reader is reading. (StageScene picks the exercise by `sample.stop`.) */
  let prevEx = EXERCISE_AT[STOPS[storyAt(0, s).stop].id];
  let underText = 0;
  for (let p = STEP; p <= END + 1e-9; p += STEP) {
    storyAt(p, s);
    const ex = EXERCISE_AT[STOPS[s.stop].id];
    if (ex !== prevEx && Math.max(...s.focus) > 0.05) underText++;
    prevEx = ex;
  }
  ok("the body only changes exercise between stops, with no words in focus", underText === 0, `${underText} change(s) under text`);
}

console.log(failures === 0 ? "\nALL PASSED\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
