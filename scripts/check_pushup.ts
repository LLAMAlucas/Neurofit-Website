/* Sanity checks for the Neuro-Fit push-up engine. Run with:
   npm run check:pushup

   SYNTHETIC/geometric checks on hand-built landmark frames (a segment-proportion body model),
   exactly like check_squat.ts. They prove the math, gating, counting policy, trigger layer,
   payload honesty and the prompt↔payload contract behave as designed — NOT that any threshold
   is right. Every push-up threshold is UNVALIDATED until PUSHUP_TEST_PROTOCOL.md has been run.  */
import type { Landmark } from "../src/neurofit/pose/landmarks";
import { PUSHUP, PUSHUP_DEPTH_PRESETS, PUSHUP_TRIGGERS, type PushupVariant } from "../src/neurofit/pushup/config";
import {
  computePushupFrame,
  headDropDeg,
  handOffsetDeg,
  NearSideSelector,
  signedBodyLineDeg,
  upperArmAngleDeg,
  type Pt,
} from "../src/neurofit/pushup/frame";
import { estimatePushupOrientation, pushupFacingScore } from "../src/neurofit/pushup/orientation";
import { PushupRepTracker, type PushupRep } from "../src/neurofit/pushup/repCounter";
import {
  bodyLineTrigger,
  evalPushupEccentric,
  flareTriggerActive,
  handWidthBand,
  levelTriggerActive,
  observedVariant,
  pushupLandmarkImplausible,
  pushupRepCounts,
  pushupShortfallBand,
} from "../src/neurofit/pushup/checks";
import { PushupSetSession, type PushupRepRecord, type PushupSetRecord } from "../src/neurofit/pushup/session";
import { buildPushupPostSetData, buildPushupPostWorkoutData } from "../src/neurofit/pushup/payload";
import { synthesizePushup } from "../src/neurofit/pushup/synthesis";
import { buildPushupTriggerTable } from "../src/neurofit/pushup/evalTable";
import {
  POSTSET_SYSTEM,
  POSTWORKOUT_SYSTEM,
  PUSHUP_POSTSET_SYSTEM,
  PUSHUP_POSTWORKOUT_SYSTEM,
  SHARED_POSTSET_RULES,
  SHARED_POSTWORKOUT_RULES,
} from "../src/neurofit/ai/prompts";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}
const near = (a: number | null, b: number, tol: number) => a !== null && Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------------------
// Synthetic body model (Winter proportions). Built in ASPECT space ([x·W/H, y]), then
// normalized with the frame's aspect — so the same body can be rendered at 16:9 and 4:3.
// ---------------------------------------------------------------------------------------
const H = 0.9; // body height in image-height units
const A_UP = 0.186 * H;
const B_FORE = 0.146 * H;
const FLOOR = 0.85;
const WIDE = 16 / 9;

function blank(): Landmark[] {
  return Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
}
function put(a: Landmark[], i: number, p: Pt, aspect: number, vis: number, z = 0) {
  a[i] = { x: p[0] / aspect, y: p[1], z, visibility: vis };
}
function add(p: Pt, q: Pt): Pt {
  return [p[0] + q[0], p[1] + q[1]];
}
function lerpPt(p: Pt, q: Pt, f: number): Pt {
  return [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
}

interface SideOpts {
  d: number; // shoulder-drop ratio (0 = locked out)
  hipOffset?: number; // + = hip pushed DOWN (sag), − = up (pike), aspect units
  variant?: PushupVariant;
  aspect?: number;
  earDrop?: number;
  facing?: 1 | -1; // head toward +x (1) or −x (−1)
}

/** Side-on push-up (left side nearest the camera). Forearm vertical; shoulder on an arc. */
function sideBody(o: SideOpts): Landmark[] {
  const aspect = o.aspect ?? WIDE;
  const dir = o.facing ?? 1;
  const variant = o.variant ?? "toes";
  const sinPhi = Math.max(-1, Math.min(1, 1 - o.d / 0.56));
  const cosPhi = Math.sqrt(1 - sinPhi * sinPhi);
  const W: Pt = [0.95, FLOOR];
  const E: Pt = [W[0], FLOOR - B_FORE];
  const S: Pt = [E[0] + dir * A_UP * cosPhi, E[1] - A_UP * sinPhi];
  let hip: Pt;
  let knee: Pt;
  let ankle: Pt;
  if (variant === "toes") {
    const L = 0.779 * H;
    const ay = FLOOR - 0.04 * H;
    const dy = ay - S[1];
    ankle = [S[0] - dir * Math.sqrt(L * L - dy * dy), ay];
    hip = lerpPt(S, ankle, 0.37);
    knee = lerpPt(S, ankle, 0.685);
  } else {
    const L = 0.533 * H;
    const ky = FLOOR - 0.03 * H;
    const dy = ky - S[1];
    knee = [S[0] - dir * Math.sqrt(L * L - dy * dy), ky];
    hip = lerpPt(S, knee, 0.54);
    ankle = [knee[0] - dir * 0.246 * H, ky];
  }
  hip = [hip[0], hip[1] + (o.hipOffset ?? 0)];
  const len = Math.hypot(S[0] - hip[0], S[1] - hip[1]);
  const ear: Pt = add(S, [((S[0] - hip[0]) / len) * 0.12 * H, ((S[1] - hip[1]) / len) * 0.12 * H + (o.earDrop ?? 0)]);
  const a = blank();
  const farShift: Pt = [0.01, 0];
  const pts: [number, number, Pt][] = [
    [7, 8, ear],
    [11, 12, S],
    [13, 14, E],
    [15, 16, W],
    [23, 24, hip],
    [25, 26, knee],
    [27, 28, ankle],
  ];
  for (const [l, r, p] of pts) {
    put(a, l, p, aspect, 0.95, -0.1);
    put(a, r, add(p, farShift), aspect, 0.5, 0.1);
  }
  put(a, 0, add(ear, [dir * 0.03, 0]), aspect, 0.9);
  return a;
}

interface FrontOpts {
  d: number;
  flare?: number; // (elbowSpan − wristSpan)/shoulderWidth at full depth
  tiltOffset?: number; // left shoulder pushed down (aspect units)
  hipsVisible?: boolean;
  aspect?: number;
}

/** Head-on push-up (camera on the floor in front of the head). Legs hidden behind the torso. */
function frontBody(o: FrontOpts): Landmark[] {
  const aspect = o.aspect ?? WIDE;
  const cx = aspect / 2;
  const sw = 0.21 * H;
  const hw = 1.2 * sw;
  const h = 0.332 * H * (1 - o.d);
  const sy = FLOOR - h;
  const out = (((o.flare ?? 0) * sw) / 2) * Math.min(1, o.d / 0.5);
  const ey = FLOOR - Math.min(B_FORE, h * 0.95);
  const a = blank();
  put(a, 11, [cx + sw / 2, sy + (o.tiltOffset ?? 0)], aspect, 0.95, -0.05);
  put(a, 12, [cx - sw / 2, sy], aspect, 0.95, -0.05);
  put(a, 15, [cx + hw / 2, FLOOR], aspect, 0.95);
  put(a, 16, [cx - hw / 2, FLOOR], aspect, 0.95);
  put(a, 13, [cx + hw / 2 + out, ey], aspect, 0.95);
  put(a, 14, [cx - hw / 2 - out, ey], aspect, 0.95);
  const hipVis = o.hipsVisible ? 0.95 : 0.1;
  put(a, 23, [cx + 0.1 * H, sy + 0.02], aspect, hipVis);
  put(a, 24, [cx - 0.1 * H, sy + 0.02], aspect, hipVis);
  put(a, 0, [cx, sy - 0.05 * H], aspect, 0.95);
  return a;
}

/** A person standing upright, arms hanging (must never lock a push-up set). */
function standing(view: "side" | "front"): Landmark[] {
  const a = blank();
  const aspect = WIDE;
  const cx = aspect / 2;
  if (view === "side") {
    put(a, 11, [cx, 0.3], aspect, 0.95, -0.1);
    put(a, 12, [cx + 0.01, 0.3], aspect, 0.5, 0.1);
    put(a, 13, [cx, 0.3 + A_UP], aspect, 0.95, -0.1);
    put(a, 14, [cx + 0.01, 0.3 + A_UP], aspect, 0.5, 0.1);
    put(a, 15, [cx, 0.3 + A_UP + B_FORE], aspect, 0.95, -0.1);
    put(a, 16, [cx + 0.01, 0.3 + A_UP + B_FORE], aspect, 0.5, 0.1);
    put(a, 23, [cx, 0.3 + 0.288 * H], aspect, 0.95, -0.1);
    put(a, 24, [cx + 0.01, 0.3 + 0.288 * H], aspect, 0.5, 0.1);
  } else {
    const sw = 0.21 * H;
    put(a, 11, [cx + sw / 2, 0.3], aspect, 0.95);
    put(a, 12, [cx - sw / 2, 0.3], aspect, 0.95);
    put(a, 13, [cx + sw / 2, 0.3 + A_UP], aspect, 0.95);
    put(a, 14, [cx - sw / 2, 0.3 + A_UP], aspect, 0.95);
    put(a, 15, [cx + sw / 2, 0.3 + A_UP + B_FORE], aspect, 0.95);
    put(a, 16, [cx - sw / 2, 0.3 + A_UP + B_FORE], aspect, 0.95);
    put(a, 23, [cx + 0.08, 0.3 + 0.288 * H], aspect, 0.95);
    put(a, 24, [cx - 0.08, 0.3 + 0.288 * H], aspect, 0.95);
  }
  return a;
}

// ---------------------------------------------------------------------------------------
// A. Geometry
// ---------------------------------------------------------------------------------------
{
  const top = computePushupFrame(sideBody({ d: 0 }), 0.6, 0, WIDE, "left", "toes");
  const par = computePushupFrame(sideBody({ d: 0.56 }), 0.6, 0, WIDE, "left", "toes");
  const deep = computePushupFrame(sideBody({ d: 0.75 }), 0.6, 0, WIDE, "left", "toes");
  check("geometry: upper arm vertical at lockout (≈ −90°)", near(top.upperArmAngleDeg, -90, 1));
  check("geometry: upper arm parallel at depthRatio 0.56 (≈ 0°) — the [DERIVED] model", near(par.upperArmAngleDeg, 0, 1));
  check("geometry: deeper than parallel reads positive (shoulder below elbow)", (deep.upperArmAngleDeg ?? -1) > 10);
  check("geometry: elbow ≈180° at lockout, ≈90° at parallel", near(top.elbowAngleDeg, 180, 1) && near(par.elbowAngleDeg, 90, 1));
  check("geometry: straight plank body line ≈ 0°", near(top.bodyLineDeg, 0, 0.5));
  const sag = computePushupFrame(sideBody({ d: 0.3, hipOffset: 0.1 }), 0.6, 0, WIDE, "left", "toes");
  const pike = computePushupFrame(sideBody({ d: 0.3, hipOffset: -0.1 }), 0.6, 0, WIDE, "left", "toes");
  check("geometry: hips dropped → body line POSITIVE (sag)", (sag.bodyLineDeg ?? 0) > 20);
  check("geometry: hips raised → body line NEGATIVE (pike)", (pike.bodyLineDeg ?? 0) < -20);
  const sagMirror = computePushupFrame(sideBody({ d: 0.3, hipOffset: 0.1, facing: -1 }), 0.6, 0, WIDE, "left", "toes");
  check("geometry: sag sign holds when the lifter faces the other way", near(sagMirror.bodyLineDeg, sag.bodyLineDeg ?? 99, 0.01));
  // Aspect invariance: identical aspect-space body rendered at 16:9 vs 4:3 → identical angles.
  const at169 = computePushupFrame(sideBody({ d: 0.4, hipOffset: 0.05, aspect: WIDE }), 0.6, 0, WIDE, "left", "toes");
  const at43 = computePushupFrame(sideBody({ d: 0.4, hipOffset: 0.05, aspect: 4 / 3 }), 0.6, 0, 4 / 3, "left", "toes");
  check(
    "geometry: aspect invariance — same body at 16:9 and 4:3 gives the same angles",
    near(at169.bodyLineDeg, at43.bodyLineDeg ?? 99, 1e-9) && near(at169.upperArmAngleDeg, at43.upperArmAngleDeg ?? 99, 1e-9),
  );
  // Raw normalized space WOULD distort it — proof the conversion matters.
  const rawBody = sideBody({ d: 0.4, hipOffset: 0.05 });
  const raw = signedBodyLineDeg([rawBody[11].x, rawBody[11].y], [rawBody[23].x, rawBody[23].y], [rawBody[27].x, rawBody[27].y]);
  check("geometry: un-corrected normalized coords misread the same sag (why aspect space exists)", raw !== null && Math.abs(raw - (at169.bodyLineDeg ?? 0)) > 3);

  const kneesBody = sideBody({ d: 0, variant: "knees" });
  const kneesRef = computePushupFrame(kneesBody, 0.6, 0, WIDE, "left", "knees");
  const kneesWrongRef = computePushupFrame(kneesBody, 0.6, 0, WIDE, "left", "toes");
  check("variant: knee push-up is a straight line against the KNEE reference", near(kneesRef.bodyLineDeg, 0, 0.5));
  check("variant: the same knee push-up misreads badly against the ANKLE reference", kneesWrongRef.bodyLineDeg === null || Math.abs(kneesWrongRef.bodyLineDeg) > 10);
  check("variant: knees down detected from lockout frame", observedVariant(kneesRef.kneeAngleDeg, kneesRef.kneeHeightArms) === "knees");
  check("variant: toes detected from lockout frame", observedVariant(top.kneeAngleDeg, top.kneeHeightArms) === "toes");

  check("head drop: ear below the body line reads positive", (headDropDeg([0, 0.5], [1, 0.5], [1.2, 0.55]) ?? 0) > 0);
  check("head drop: sign holds facing the other way", (headDropDeg([1, 0.5], [0, 0.5], [-0.2, 0.55]) ?? 0) > 0);
  check("hand offset: wrists toward the head read positive", (handOffsetDeg([1, 0.5], [1.1, 0.8], [0.5, 0.5]) ?? 0) > 0);
  check("upperArmAngleDeg: shoulder above elbow is negative", (upperArmAngleDeg([1, 0.4], [0.9, 0.5]) ?? 0) < 0);

  const tucked = computePushupFrame(frontBody({ d: 0.56, flare: 0 }), 0.6, 0, WIDE, null, "toes");
  const flared = computePushupFrame(frontBody({ d: 0.56, flare: 1.4 }), 0.6, 0, WIDE, null, "toes");
  const flaredTop = computePushupFrame(frontBody({ d: 0.05, flare: 1.4 }), 0.6, 0, WIDE, null, "toes");
  check("front: elbows over wrists → flare ≈ 0", near(tucked.flareRatio, 0, 0.05));
  check("front: T-flare at depth → flare ≥ 1.0", (flared.flareRatio ?? 0) >= 1.0);
  check("front: near lockout the same lifter reads low flare (why P7 is depth-gated)", (flaredTop.flareRatio ?? 9) < 0.3);
  check("front: sagittal fields are null without a near side", tucked.bodyLineDeg === null && tucked.upperArmAngleDeg === null);
  check("front: hand width ratio standard at 1.2× shoulders", handWidthBand(tucked.handWidthRatio) === "standard");
  const tilted = computePushupFrame(frontBody({ d: 0.5, tiltOffset: 0.04 }), 0.6, 0, WIDE, null, "toes");
  check("front: one shoulder dropping raises the tilt differential", (tilted.shoulderTiltDiffDeg ?? 0) > 10);
}

// ---------------------------------------------------------------------------------------
// B. Orientation + plank gate
// ---------------------------------------------------------------------------------------
{
  const sideTop = estimatePushupOrientation(sideBody({ d: 0 }), 0.6, WIDE);
  const sideBottom = estimatePushupOrientation(sideBody({ d: 0.65 }), 0.6, WIDE);
  const frontTop = estimatePushupOrientation(frontBody({ d: 0 }), 0.6, WIDE);
  const frontBottom = estimatePushupOrientation(frontBody({ d: 0.6 }), 0.6, WIDE);
  check("orientation: side plank → side + inPlank", sideTop.orientation === "side" && sideTop.inPlank);
  check("orientation: side stays side at the BOTTOM (posture-invariant score)", sideBottom.orientation === "side");
  check("orientation: head-on plank → front + inPlank", frontTop.orientation === "front" && frontTop.inPlank);
  check("orientation: head-on stays front at the bottom", frontBottom.orientation === "front");
  const sTop = pushupFacingScore(sideBody({ d: 0 }), 0.6, WIDE) ?? 9;
  const sBot = pushupFacingScore(sideBody({ d: 0.65 }), 0.6, WIDE) ?? 9;
  check("orientation: side facing score barely moves top→bottom", Math.abs(sTop - sBot) < 0.05);
  check("plank gate: standing side-on never locks", !estimatePushupOrientation(standing("side"), 0.6, WIDE).inPlank);
  check("plank gate: standing head-on never locks", !estimatePushupOrientation(standing("front"), 0.6, WIDE).inPlank);
  check("plank gate: head-on with hips visible near shoulder height still passes", estimatePushupOrientation(frontBody({ d: 0, hipsVisible: true }), 0.6, WIDE).inPlank);

  const sel = new NearSideSelector();
  for (let i = 0; i < 10; i++) sel.update(sideBody({ d: 0 }));
  const flipped = sideBody({ d: 0 });
  for (const [l, r] of [[11, 12], [13, 14], [15, 16], [23, 24]]) {
    const tmp = flipped[l].visibility;
    flipped[l].visibility = flipped[r].visibility;
    flipped[r].visibility = tmp;
  }
  flipped[11].z = 0.1;
  flipped[12].z = -0.1;
  check("near side: left chain selected side-on", sel.side() === "left");
  sel.update(flipped);
  check("near side: one contradicting frame does not swap sides (hysteresis)", sel.side() === "left");
}

// ---------------------------------------------------------------------------------------
// C. Rep counter
// ---------------------------------------------------------------------------------------
const FPS = 30;

/** Linearly interpolate a [t, depthRatio] trajectory at FPS. */
function trajectory(points: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 1; i < points.length; i++) {
    const [t0, d0] = points[i - 1];
    const [t1, d1] = points[i];
    const n = Math.max(1, Math.round((t1 - t0) * FPS));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) out.push([t0 + ((t1 - t0) * k) / n, d0 + ((d1 - d0) * k) / n]);
  }
  return out;
}
function runTracker(points: [number, number][]): PushupRep[] {
  const reps: PushupRep[] = [];
  const tr = new PushupRepTracker(PUSHUP, (r) => reps.push(r));
  for (const [t, d] of trajectory(points)) tr.update(computePushupFrame(sideBody({ d }), 0.6, t, WIDE, "left", "toes"));
  return reps;
}
{
  const full = runTracker([[0, 0], [0.4, 0], [1.1, 0.62], [1.2, 0.62], [1.9, 0], [2.3, 0]]);
  check("rep counter: full push-up = 1 attempt, locked out", full.length === 1 && full[0].lockedOut);
  check("rep counter: bottom ratio recorded", (full[0]?.bottomDepthRatio ?? 0) > 0.55);
  check("rep counter: concentric velocity measured", (full[0]?.concentricVelocity ?? 0) > 0);
  check("rep counter: shallow bob never arms", runTracker([[0, 0], [0.4, 0], [0.8, 0.15], [1.2, 0], [1.5, 0]]).length === 0);
  check("rep counter: sub-0.3 s rep debounced", runTracker([[0, 0], [0.4, 0], [0.5, 0.6], [0.6, 0], [1.0, 0]]).length === 0);
  const pulse = runTracker([[0, 0], [0.4, 0], [1.0, 0.6], [1.1, 0.6], [1.5, 0.25], [1.6, 0.25], [2.1, 0.6], [2.2, 0.6], [2.8, 0], [3.2, 0]]);
  check("rep counter: partial-lockout pulse splits into 2 attempts", pulse.length === 2);
  check("rep counter: the pulse is lockedOut=false with a top near 0.25", !!pulse[0] && !pulse[0].lockedOut && near(pulse[0].topRatio, 0.25, 0.05));
  check("rep counter: the follow-up rep locks out", !!pulse[1] && pulse[1].lockedOut);

  // Single-frame spike: one frame reads a deep drop amid lockout frames.
  const reps: PushupRep[] = [];
  const tr = new PushupRepTracker(PUSHUP, (r) => reps.push(r));
  for (let i = 0; i < 30; i++) {
    const d = i === 15 ? 0.5 : 0;
    tr.update(computePushupFrame(sideBody({ d }), 0.6, i / FPS, WIDE, "left", "toes"));
  }
  check("rep counter: single-frame landmark spike never arms (median filter)", !tr.isDown && reps.length === 0);
}

// ---------------------------------------------------------------------------------------
// D. Counting policy
// ---------------------------------------------------------------------------------------
{
  const par = PUSHUP_DEPTH_PRESETS.parallel;
  const miss = pushupRepCounts("side", par.targetUpperArmDeg - 3, 0.5, true, 0.02, "parallel");
  check("count: side 3° short of target = depth miss", !miss.counted && miss.misses[0]?.reason === "depth_miss");
  check("count: side miss carries the DECIDING basis (degrees) + a marginal band", miss.misses[0]?.basis === "upper_arm_angle_deg" && miss.misses[0]?.band === "marginal");
  check("count: side deeper than target counts", pushupRepCounts("side", 20, 0.8, true, 0.02, "parallel").counted);
  check("count: side occluded bottom (null angle) never silently voids a rep", pushupRepCounts("side", null, 0.5, true, 0.02, "parallel").counted);
  check("count: front ratio below target = miss in depth_ratio basis", pushupRepCounts("front", null, 0.42, true, 0.02, "parallel").misses[0]?.basis === "depth_ratio");
  check("count: front null ratio never counts", !pushupRepCounts("front", null, null, true, 0.02, "parallel").counted);
  check("count: front deeper always counts", pushupRepCounts("front", null, 0.95, true, 0.02, "parallel").counted);
  const both = pushupRepCounts("side", -30, 0.3, false, 0.3, "parallel");
  check("count: shallow AND no lockout records both misses", both.misses.map((m) => m.reason).join(",") === "depth_miss,lockout_miss");
  check("count: lockout miss band scales with how far short", both.misses[1]?.band === "large");
  check(
    "presets: chest > parallel > above in both bases",
    PUSHUP_DEPTH_PRESETS.chest.targetUpperArmDeg > PUSHUP_DEPTH_PRESETS.parallel.targetUpperArmDeg &&
      PUSHUP_DEPTH_PRESETS.parallel.targetUpperArmDeg > PUSHUP_DEPTH_PRESETS.above.targetUpperArmDeg &&
      PUSHUP_DEPTH_PRESETS.chest.frontRatioTarget > PUSHUP_DEPTH_PRESETS.parallel.frontRatioTarget &&
      PUSHUP_DEPTH_PRESETS.parallel.frontRatioTarget > PUSHUP_DEPTH_PRESETS.above.frontRatioTarget,
  );
  check(
    "presets: front targets sit within ~10% below the [DERIVED] 0.56·(1+sin θ) model",
    Object.values(PUSHUP_DEPTH_PRESETS).every((p) => {
      const model = 0.56 * (1 + Math.sin((p.targetUpperArmDeg * Math.PI) / 180));
      return p.frontRatioTarget <= model + 0.01 && p.frontRatioTarget >= model * 0.88;
    }),
  );
  check("band: not short → null", pushupShortfallBand(-1, "upper_arm_angle_deg") === null);
}

// ---------------------------------------------------------------------------------------
// E. Trigger predicates
// ---------------------------------------------------------------------------------------
{
  check("P1: 26° sag fires absolute with no baseline", bodyLineTrigger(26, null)?.basis === "absolute");
  check("P1: 20° sag with NO baseline stays silent (relative disarmed)", bodyLineTrigger(20, null) === null);
  check("P1: 21° vs a 5° warm-up = relative sag", JSON.stringify(bodyLineTrigger(21, 5)) === JSON.stringify({ sub: "sag", basis: "baseline_relative" }));
  check("P1: −36° = absolute pike", JSON.stringify(bodyLineTrigger(-36, 0)) === JSON.stringify({ sub: "pike", basis: "absolute" }));
  check("P1: −12° vs a +5° warm-up = relative pike", bodyLineTrigger(-12, 5)?.sub === "pike");
  check("P1: implausible 80° never fires", bodyLineTrigger(80, 0) === null);
  check("P1: sag tolerance stricter than pike", PUSHUP_TRIGGERS.bodyLine.absSagDeg < PUSHUP_TRIGGERS.bodyLine.absPikeDeg);
  check("P7: T-flare near lockout does NOT fire (depth-gated)", !flareTriggerActive(1.4, 0.1));
  check("P7: T-flare past the gate fires", flareTriggerActive(1.4, 0.4));
  check("P7: garbage ratio never fires", !flareTriggerActive(7, 0.5));
  check("P2: 2.1× warm-up descent warns", evalPushupEccentric(0.21, 0.1).status === "warn");
  check("P2: 1.9× stays ok (slow-warm-up lesson: 2.0×, not 1.5×)", evalPushupEccentric(0.19, 0.1).status === "ok");
  check("P2: no descent baseline → unknown, never a clean pass", evalPushupEccentric(0.3, null).status === "unknown");
  check("P11: 12° vs 3° warm-up fires; 10° doesn't", levelTriggerActive(12, 3) && !levelTriggerActive(10, 3));
  const garbage = computePushupFrame(frontBody({ d: 0.5, flare: 9 }), 0.6, 0, WIDE, null, "toes");
  check("implausible: frontal garbage flagged on FRONT sets", pushupLandmarkImplausible(garbage, "front"));
  check("implausible: never flags SIDE sets (squat 18/18 lesson)", !pushupLandmarkImplausible(garbage, "side"));
}

// ---------------------------------------------------------------------------------------
// F. Session integration (frames → records)
// ---------------------------------------------------------------------------------------
interface RepSpec {
  bottom?: number;
  hipOffset?: number;
  descentSec?: number;
  flare?: number;
  tiltOffset?: number;
  /** Rise only to this ratio, sink back to the bottom, then press out (a missed lockout). */
  pulseTop?: number;
}

function runSet(view: "side" | "front", specs: RepSpec[], variant: PushupVariant = "toes", setIndex = 1): { session: PushupSetSession; fired: string[]; baselineTs: number[] } {
  const session = new PushupSetSession({ setIndex, orientation: view, depthPreset: "parallel", variant });
  const fired: string[] = [];
  const baselineTs: number[] = [];
  let t = 0;
  const feed = (d: number, spec: RepSpec) => {
    const lm = view === "side" ? sideBody({ d, hipOffset: spec.hipOffset, variant }) : frontBody({ d, flare: spec.flare, tiltOffset: spec.tiltOffset });
    const frame = computePushupFrame(lm, 0.6, t, WIDE, view === "side" ? "left" : null, variant);
    const ev = session.onFrame(frame, t, view === "side" ? 0 : 90);
    for (const f of ev.fired) fired.push(`${f.repIndex}:${f.faultType}`);
    baselineTs.push(...ev.baselineFrameTs);
    t += 1 / FPS;
  };
  const hold = (d: number, sec: number, spec: RepSpec) => {
    for (let i = 0; i < Math.round(sec * FPS); i++) feed(d, spec);
  };
  const ramp = (d0: number, d1: number, sec: number, spec: RepSpec) => {
    const n = Math.round(sec * FPS);
    for (let i = 1; i <= n; i++) feed(d0 + ((d1 - d0) * i) / n, spec);
  };
  hold(0, 0.5, {});
  for (const s of specs) {
    const bottom = s.bottom ?? 0.62;
    ramp(0, bottom, s.descentSec ?? 0.8, s);
    hold(bottom, 0.1, s);
    if (s.pulseTop !== undefined) {
      ramp(bottom, s.pulseTop, 0.5, s);
      hold(s.pulseTop, 0.1, s);
      ramp(s.pulseTop, bottom, 0.5, s);
      hold(bottom, 0.1, s);
    }
    ramp(bottom, 0, 0.7, s);
    hold(0, 0.4, {});
  }
  return { session, fired, baselineTs };
}

const SAG = 0.1;
{
  const { session, fired, baselineTs } = runSet("side", [{}, {}, { hipOffset: SAG }, {}]);
  const reps = session.reps();
  check("session: 4 side reps recorded, all counted", reps.length === 4 && reps.every((r) => r.counted));
  check("session: sag rep 3 fires P1 (trigger layer)", fired.includes("3:hip_sag") && reps[2]?.triggeredMetrics.includes("bodyLine"));
  check("session: clean rep 4 does not fire", !!reps[3] && !reps[3].triggeredMetrics.includes("bodyLine"));
  check("session: warm-up reps 1–2 archive baseline frames", baselineTs.length === 2);
  check("session: body-line baseline resolved from warm-up", session.baselineSnapshot().bodyLineDeg !== null);
  check("session: sagittal record fields populated, frontal null", !!reps[0] && reps[0].upperArmAngleDeg !== null && reps[0].flarePeak === null && reps[0].tiltPeakDeg === null);
  check("session: trigger moment captured for archiving", session.momentFor(3, "bodyLine")?.faultType === "hip_sag");

  const warmSag = runSet("side", [{ hipOffset: SAG }, {}, {}]);
  check("session: a sagging WARM-UP rep never fires", !warmSag.fired.some((f) => f.startsWith("1:")));

  // Baseline window gate: rep 1 fails hygiene (shallow), later clean reps must NOT complete it.
  const starved = runSet("side", [{ bottom: 0.3 }, {}, {}, {}, {}, {}]);
  check("session: a failed warm-up rep leaves the body-line baseline unresolved ALL set", starved.session.baselineSnapshot().bodyLineDeg === null);
  check("session: the shallow warm-up rep still counts as an attempt", starved.session.reps().length === 6);

  const fast = runSet("side", [{}, {}, { descentSec: 0.3 }, {}]);
  check("session: a ~2.7× faster descent fires P2 at rep close", fast.fired.includes("3:eccentric_control"));
  check("session: normal-tempo rep 4 does not fire P2", !fast.fired.includes("4:eccentric_control"));

  const shallow = runSet("side", [{}, {}, { bottom: 0.35 }]);
  const s3 = shallow.session.reps()[2];
  check("session: shallow side rep is uncounted with a depth_miss in degrees", !!s3 && !s3.counted && s3.misses[0]?.basis === "upper_arm_angle_deg");

  const pulsed = runSet("side", [{}, {}, { pulseTop: 0.3 }, {}]);
  const pulsedReps = pulsed.session.reps();
  check("session: a pulse short of lockout closes as its own lockout_miss attempt", pulsedReps.length === 5 && pulsedReps[2].misses.some((m) => m.reason === "lockout_miss"));
  check("session: the press-out after the pulse is a normal counted attempt", !!pulsedReps[3] && pulsedReps[3].counted);

  const knees = runSet("side", [{}, {}, {}], "knees");
  check("session: knees variant — straight knee push-ups never fire P1", knees.session.reps().length === 3 && !knees.fired.some((f) => f.includes("hip_")));
  check("session: knees variant observed during warm-up", knees.session.variantObserved() === "knees");

  const front = runSet("front", [{}, {}, { flare: 1.5 }, {}, { tiltOffset: 0.05 }]);
  check("session: front T-flare fires P7 on rep 3", front.fired.includes("3:elbow_flare"));
  check("session: clean front rep 4 does not fire P7", !front.fired.includes("4:elbow_flare"));
  check("session: front one-side dip fires P11 (post-set) on rep 5", front.fired.includes("5:uneven_press"));
  check("session: front records never carry sagittal fields", front.session.reps().every((r) => r.bodyLinePeakDeg === null && r.upperArmAngleDeg === null));
}

// ---------------------------------------------------------------------------------------
// G. Payload honesty
// ---------------------------------------------------------------------------------------
function setRecord(view: "side" | "front", specs: RepSpec[], index: number, variant: PushupVariant = "toes"): PushupSetRecord {
  return runSet(view, specs, variant, index).session.toSetRecord(view === "side" ? 0 : 90);
}
const sideSet = setRecord("side", [{}, {}, { hipOffset: SAG }, { bottom: 0.35 }, { descentSec: 0.3 }], 1);
const frontSet = setRecord("front", [{}, {}, { flare: 1.5 }, { bottom: 0.3 }, { tiltOffset: 0.05 }], 2);
const sideData = buildPushupPostSetData(sideSet, { baselineFramesIncluded: 2 });
const frontData = buildPushupPostSetData(frontSet, { baselineFramesIncluded: 2 });
{
  check("payload side: frontal fields are NULL (not 0/false)", sideData.baseline.shoulder_tilt_diff_deg === null && sideData.context.hand_width_ratio === null && sideData.context.hand_width_band === null);
  check("payload side: sagittal fields present", sideData.baseline.body_line_deg !== null && sideData.context.top_elbow_angle_deg_by_rep !== null && sideData.context.variant_check !== null);
  check(
    "payload front: sagittal fields are NULL",
    frontData.baseline.body_line_deg === null &&
      frontData.context.head_drop_deg === null &&
      frontData.context.hand_offset_deg === null &&
      frontData.context.top_elbow_angle_deg_by_rep === null &&
      frontData.context.variant_check === null,
  );
  check("payload front: frontal context present", frontData.context.hand_width_band !== null);
  check("payload side: depth basis is degrees, front is ratio", sideData.depth_context.depth_basis === "upper_arm_angle_deg" && frontData.depth_context.depth_basis === "depth_ratio");
  check("payload: exercise tag selects the push-up prompt", sideData.exercise === "pushup" && frontData.exercise === "pushup");
  check("payload side: hip_sag in triggers_fired with a basis", sideData.triggers_fired.some((t) => t.type === "hip_sag" && t.basis !== null && t.rep_numbers.includes(3)));
  check("payload side: descent spike carries a baseline multiple", sideData.triggers_fired.some((t) => t.type === "eccentric_control" && (t.baseline_multiple ?? 0) >= 2));
  check("payload front: elbow_flare + uneven_press fired", frontData.triggers_fired.some((t) => t.type === "elbow_flare") && frontData.triggers_fired.some((t) => t.type === "uneven_press"));
  check("payload side: shallow rep 4 in uncounted_reps with basis + band", sideData.uncounted_reps.some((u) => u.rep_number === 4 && u.misses[0].basis === "upper_arm_angle_deg" && u.misses[0].band !== null));
  check("payload front: shallow rep 4 is a depth_ratio miss", frontData.uncounted_reps.some((u) => u.rep_number === 4 && u.misses.some((m) => m.reason === "depth_miss" && m.basis === "depth_ratio")));
  check("payload: depth_misses and uncounted depth entries agree", sideData.set_summary.depth_misses === sideData.uncounted_reps.filter((u) => u.misses.some((m) => m.reason === "depth_miss")).length);

  const starvedData = buildPushupPostSetData(setRecord("side", [{ bottom: 0.3 }, {}, {}], 3), { baselineFramesIncluded: 2 });
  check(
    "disarmed side: names the body line, NOT the frontal evenness check",
    starvedData.baseline.checks_disarmed.some((c) => c.startsWith("body line")) && !starvedData.baseline.checks_disarmed.includes("left/right evenness"),
  );
  check("disarmed side: baseline.valid false", starvedData.baseline.valid === false);
  const starvedFront = buildPushupPostSetData(setRecord("front", [{ bottom: 0.3 }, {}, {}], 4), { baselineFramesIncluded: 2 });
  check(
    "disarmed front: names evenness, never the body line",
    starvedFront.baseline.checks_disarmed.includes("left/right evenness") && !starvedFront.baseline.checks_disarmed.some((c) => c.startsWith("body line")),
  );

  // Trigger layer ≠ metric layer: a warn with no fired trigger must not become a finding.
  const metricOnly: PushupSetRecord = JSON.parse(JSON.stringify(setRecord("side", [{}, {}, {}], 5)));
  metricOnly.reps[2].metrics.bodyLine = { metric: "bodyLine", status: "warn", severity: "warning", message: "x", value: 30 };
  metricOnly.reps[2].bodyLinePeakDeg = 30;
  check("payload: metric warn without a trigger is NOT in triggers_fired", !buildPushupPostSetData(metricOnly, { baselineFramesIncluded: 2 }).triggers_fired.some((t) => t.type === "hip_sag"));

  const pw = buildPushupPostWorkoutData([sideSet, frontSet], []);
  const sagTrend = pw.fault_trends.find((f) => f.type === "hip_sag");
  check("post-workout: hip_sag observable only in side sets", !!sagTrend && sagTrend.sets_observable.join() === "1");
  check("post-workout: a fault seen in its only observable set is persistent", sagTrend?.trend === "persistent");
  const slowSet: PushupSetRecord = JSON.parse(JSON.stringify(sideSet));
  const sagRep = slowSet.reps.find((r) => r.triggeredMetrics.includes("bodyLine")) as PushupRepRecord;
  if (sagRep.velocity) sagRep.velocity.ratio = 1.1;
  check("post-workout: co_occurred_with_slowing FALSE when the fault rep was faster", buildPushupPostWorkoutData([slowSet], []).fault_trends.find((f) => f.type === "hip_sag")?.co_occurred_with_slowing === false);
  if (sagRep.velocity) sagRep.velocity.ratio = 0.8;
  check("post-workout: co_occurred_with_slowing TRUE only on the rep's OWN ratio < 1", buildPushupPostWorkoutData([slowSet], []).fault_trends.find((f) => f.type === "hip_sag")?.co_occurred_with_slowing === true);
  check(
    "post-workout: unmeasured velocity is null, not a fabricated 1.0",
    buildPushupPostWorkoutData([{ ...sideSet, reps: sideSet.reps.map((r) => ({ ...r, velocity: null })) }], []).cross_set_metrics.velocity_degradation_per_set[0] === null,
  );
}

// ---------------------------------------------------------------------------------------
// H. Prompt ↔ payload contract
// ---------------------------------------------------------------------------------------
{
  const pw = buildPushupPostWorkoutData([sideSet, frontSet], [{ set_number: 1, orientation: "side", text: "x" }]);
  const keys = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        keys.add(k);
        walk(x);
      }
  };
  [sideData, frontData, pw].forEach(walk);
  // Values the prompts legitimately name that are enum VALUES, not keys.
  const vocab = new Set(["upper_arm_angle_deg", "depth_ratio", "depth_miss", "lockout_miss", "above_parallel", "chest_to_floor", "baseline_relative"]);
  const resolves = (root: unknown, path: string): boolean => {
    let cur: unknown = root;
    for (const raw of path.split(".")) {
      const key = raw.replace(/\[\]$/, "");
      if (Array.isArray(cur)) cur = cur[0];
      if (!cur || typeof cur !== "object" || !(key in (cur as object))) return false;
      cur = (cur as Record<string, unknown>)[key];
    }
    return true;
  };
  for (const [name, prompt, roots] of [
    ["post-set", PUSHUP_POSTSET_SYSTEM, [sideData, frontData]],
    ["post-workout", PUSHUP_POSTWORKOUT_SYSTEM, [pw]],
  ] as [string, string, unknown[]][]) {
    const snake = [...new Set(prompt.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])];
    const unknownSnake = snake.filter((s) => !keys.has(s) && !vocab.has(s));
    check(`prompt ${name}: every snake_case field it names exists in the payload (${unknownSnake.join(", ") || "all ok"})`, unknownSnake.length === 0);
    const dotted = [...new Set(prompt.match(/\b[a-z_]+(?:\[\])?(?:\.[a-z_]+(?:\[\])?)+/g) ?? [])].filter((p) => p.includes("_") || p.startsWith("baseline."));
    const broken = dotted.filter((p) => !roots.some((r) => resolves(r, p)));
    check(`prompt ${name}: every dotted payload path resolves (${broken.join(", ") || "all ok"})`, broken.length === 0);
  }
  const lines = (p: string) => p.split("\n");
  check(
    "prompt: shared post-set rules are byte-identical to the squat prompt",
    SHARED_POSTSET_RULES.every((pre) => lines(PUSHUP_POSTSET_SYSTEM).find((l) => l.startsWith(pre)) === lines(POSTSET_SYSTEM).find((l) => l.startsWith(pre))),
  );
  check(
    "prompt: shared post-workout rules are byte-identical to the squat prompt",
    SHARED_POSTWORKOUT_RULES.every((pre) => lines(PUSHUP_POSTWORKOUT_SYSTEM).find((l) => l.startsWith(pre)) === lines(POSTWORKOUT_SYSTEM).find((l) => l.startsWith(pre))),
  );
  const leak = /squat|valgus|knee cave|hip-vs-knee|rep_context|forward lean/i;
  check("prompt: push-up prompts carry no squat vocabulary or stale fields", !leak.test(PUSHUP_POSTSET_SYSTEM) && !leak.test(PUSHUP_POSTWORKOUT_SYSTEM));
  check("prompt: plain-text rule 8 kept in both push-up prompts", PUSHUP_POSTSET_SYSTEM.includes("PLAIN TEXT ONLY") && PUSHUP_POSTWORKOUT_SYSTEM.includes("PLAIN TEXT ONLY"));
  check("prompt: squat prompts untouched by push-up wording", !/push-up/i.test(POSTSET_SYSTEM) && !/push-up/i.test(POSTWORKOUT_SYSTEM));
  check(
    "prompt: rule numbering complete (1,1a,2,3,3a,4,5,6,6a,6b,7,8)",
    ["1. ", "1a. ", "2. ", "3. ", "3a. ", "4. ", "5. ", "6. ", "6a. ", "6b. ", "7. ", "8. "].every((p) => lines(PUSHUP_POSTSET_SYSTEM).some((l) => l.startsWith(p))),
  );
}

// ---------------------------------------------------------------------------------------
// I. Eval table + J. synthesis
// ---------------------------------------------------------------------------------------
{
  const ctxSide = { view: "side" as const, variant: "toes" as const, depthPreset: "parallel" as const };
  const ctxFront = { view: "front" as const, variant: "toes" as const, depthPreset: "parallel" as const };
  const sideRows = buildPushupTriggerTable(sideSet.reps[2], ctxSide);
  const frontRows = buildPushupTriggerTable(frontSet.reps[2], ctxFront);
  const warmRows = buildPushupTriggerTable(sideSet.reps[0], ctxSide);
  const row = (rows: typeof sideRows, id: string) => rows.find((r) => r.id === id);
  check("evaltable: side scored rep — P1 eligible + fired, P7 ineligible", !!row(sideRows, "P1_body_line")?.eligible && !!row(sideRows, "P1_body_line")?.fired && !row(sideRows, "P7_elbow_flare")?.eligible);
  check("evaltable: front scored rep — P7 eligible + fired, P1 ineligible", !!row(frontRows, "P7_elbow_flare")?.fired && !row(frontRows, "P1_body_line")?.eligible);
  check("evaltable: warm-up reps have no eligible triggers", !["P1_body_line", "P2_eccentric_control", "P7_elbow_flare", "P11_uneven_press"].some((id) => row(warmRows, id)?.eligible));
  check("evaltable: bounce reversal is logged but never fires", sideSet.reps.every((r) => buildPushupTriggerTable(r, ctxSide).find((x) => x.id === "P2_eccentric_control")?.sub_signals?.[1].fired === false));
  check("evaltable: lockout gate eligible in both views", !!row(sideRows, "lockout_gate")?.eligible && !!row(frontRows, "lockout_gate")?.eligible);

  const frontOnly = synthesizePushup([frontSet]);
  check("synthesis: body line not assessed without a side set", frontOnly.metrics.find((m) => m.metric === "bodyLine")?.status === "not-assessed");
  check("synthesis: depth assessed (and flagged) from a front set", frontOnly.metrics.find((m) => m.metric === "depth")?.status === "warn");
  const both = synthesizePushup([sideSet, frontSet]);
  check("synthesis: tally line mentions misses per gate", (both.setSummaries[0].tallyText ?? "").includes("missed depth"));
  check("synthesis: flare flagged from the trigger layer", both.metrics.find((m) => m.metric === "elbowFlare")?.status === "warn");
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
