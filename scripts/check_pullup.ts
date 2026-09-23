/* Sanity checks for the Neuro-Fit pull-up engine. Run with:
   npm run check:pullup

   SYNTHETIC/geometric checks on hand-built landmark frames (a segment-proportion hanging body under
   a bar), exactly like check_pushup.ts. They prove the math, gating, counting policy, trigger layer,
   payload honesty and the prompt↔payload contract behave as designed — NOT that any threshold is
   right. Every pull-up threshold is UNVALIDATED until PULLUP_TEST_PROTOCOL.md has been run.  */
import type { Landmark } from "../src/neurofit/pose/landmarks";
import { estimateOrientation } from "../src/neurofit/vision/orientation";
import { PULLUP, PULLUP_FACE, PULLUP_TOP_PRESETS, PULLUP_TRIGGERS, type PullupTopPreset } from "../src/neurofit/pullup/config";
import { barSampleY, computePullupFrame, estimateChinY, swingAngleDeg, type Pt } from "../src/neurofit/pullup/frame";
import { PullupRepTracker, type PullupRep } from "../src/neurofit/pullup/repCounter";
import {
  evalPullupEccentric,
  evenTriggerActive,
  gripWidthBand,
  judgeExtension,
  judgeTop,
  legDriveTriggerActive,
  pullupDescentSpeed,
  pullupLandmarkImplausible,
  pullupRepCounts,
  pullupShortfallBand,
  swingTrigger,
} from "../src/neurofit/pullup/checks";
import { PullupSetSession, type PullupRepRecord, type PullupSetRecord } from "../src/neurofit/pullup/session";
import { buildPullupPostSetData, buildPullupPostWorkoutData } from "../src/neurofit/pullup/payload";
import { synthesizePullup } from "../src/neurofit/pullup/synthesis";
import { buildPullupTriggerTable } from "../src/neurofit/pullup/evalTable";
import {
  POSTSET_SYSTEM,
  POSTWORKOUT_SYSTEM,
  PULLUP_POSTSET_SYSTEM,
  PULLUP_POSTWORKOUT_SYSTEM,
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
const near = (a: number | null | undefined, b: number, tol: number) => a !== null && a !== undefined && Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------------------
// Synthetic hanging body (Winter proportions) under a bar, built in ASPECT space ([x·W/H, y]).
//   upper arm 0.186H, forearm 0.146H; the wrist hangs 0.045H below the bar (the bar lies across the
//   fingers); chin 0.052H above the shoulder; nose→mouth 0.014H, mouth→chin 0.023H (so the chin
//   estimate's 1.6 factor is exact on this body); shoulder→hip 0.288H, thigh 0.245H, shin 0.246H.
// ---------------------------------------------------------------------------------------
const H = 0.7; // body height in image-height units (the hanging body spans ~1.25H)
const U = 0.186 * H;
const F = 0.146 * H;
const L = U + F;
const BAR = 0.1;
const WRIST_BELOW_BAR = 0.045 * H;
const SW = 0.21 * H; // BlazePose joint-centre shoulder width
const WIDE = 16 / 9;

function blank(): Landmark[] {
  return Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }));
}
function put(a: Landmark[], i: number, p: Pt, aspect: number, vis: number, z = 0) {
  a[i] = { x: p[0] / aspect, y: p[1], z, visibility: vis };
}
const add = (p: Pt, q: Pt): Pt => [p[0] + q[0], p[1] + q[1]];

/** Two-link elbow position: shoulder S, wrist W, bending toward `side` (+1 = +x). */
function elbowOf(S: Pt, W: Pt, side: 1 | -1): Pt {
  const c = Math.min(L - 1e-9, Math.hypot(W[0] - S[0], W[1] - S[1]));
  const d: Pt = [(W[0] - S[0]) / c, (W[1] - S[1]) / c];
  const a = Math.acos(Math.max(-1, Math.min(1, (U * U + c * c - F * F) / (2 * U * c))));
  const rot = (s: number): Pt => [S[0] + U * (d[0] * Math.cos(s * a) - d[1] * Math.sin(s * a)), S[1] + U * (d[0] * Math.sin(s * a) + d[1] * Math.cos(s * a))];
  const e1 = rot(1);
  const e2 = rot(-1);
  return (e1[0] - e2[0]) * side >= 0 ? e1 : e2;
}

/** Pull ratio (vs the TRUE straight-arm hang) that puts the chin `clear` × H above the bar. */
function pForClear(clear: number, hDown: number): number {
  return 1 - (0.007 * H - clear * H) / hDown;
}

interface FrontOpts {
  p: number; // shoulder rise from the straight-arm hang, fraction of that hang height
  grip?: number; // wristSpan / shoulderWidth
  tilt?: number; // left shoulder dropped by this (aspect units)
  face?: boolean; // false = camera behind the lifter (no nose / mouth)
  knuckles?: boolean;
  wristDrop?: number; // hands + body fall this far (letting go)
  aspect?: number;
}

function frontHang(grip = 1.5): number {
  const dx = ((grip - 1) / 2) * SW;
  return Math.sqrt(L * L - dx * dx);
}

/** Lifter hanging head-on (faces the camera), overhand grip wider than the shoulders. */
function frontBody(o: FrontOpts): Landmark[] {
  const aspect = o.aspect ?? WIDE;
  const cx = aspect / 2;
  const grip = o.grip ?? 1.5;
  const hDown = frontHang(grip);
  const wristY = BAR + WRIST_BELOW_BAR + (o.wristDrop ?? 0);
  const sy = wristY + hDown * (1 - o.p);
  const a = blank();
  const LS: Pt = [cx + SW / 2, sy + (o.tilt ?? 0)];
  const RS: Pt = [cx - SW / 2, sy];
  const LW: Pt = [cx + (grip * SW) / 2, wristY];
  const RW: Pt = [cx - (grip * SW) / 2, wristY];
  put(a, 11, LS, aspect, 0.95);
  put(a, 12, RS, aspect, 0.95);
  put(a, 15, LW, aspect, 0.95);
  put(a, 16, RW, aspect, 0.95);
  put(a, 13, elbowOf(LS, LW, 1), aspect, 0.95);
  put(a, 14, elbowOf(RS, RW, -1), aspect, 0.95);
  const kv = o.knuckles === false ? 0.1 : 0.9;
  const ky = BAR + (o.wristDrop ?? 0);
  put(a, 17, [LW[0] + 0.01, ky], aspect, kv);
  put(a, 19, [LW[0] - 0.01, ky], aspect, kv);
  put(a, 18, [RW[0] - 0.01, ky], aspect, kv);
  put(a, 20, [RW[0] + 0.01, ky], aspect, kv);
  const fv = o.face === false ? 0.1 : 0.95;
  put(a, 0, [cx, sy - 0.089 * H], aspect, fv);
  put(a, 9, [cx + 0.025 * H, sy - 0.075 * H], aspect, fv);
  put(a, 10, [cx - 0.025 * H, sy - 0.075 * H], aspect, fv);
  put(a, 7, [cx + 0.07 * H, sy - 0.09 * H], aspect, 0.9);
  put(a, 8, [cx - 0.07 * H, sy - 0.09 * H], aspect, 0.9);
  for (const [l, r, dy] of [[23, 24, 0.288], [25, 26, 0.533], [27, 28, 0.779]] as const) {
    put(a, l, [cx + 0.1 * H, sy + dy * H], aspect, 0.95);
    put(a, r, [cx - 0.1 * H, sy + dy * H], aspect, 0.95);
  }
  return a;
}

interface SideOpts {
  p: number;
  swing?: number; // pendulum rotation about the hands (deg, + = hips forward)
  hipFlex?: number; // thigh raised forward (deg)
  kneeFlex?: number; // shin folded back (deg)
  facing?: 1 | -1;
  wristDrop?: number;
  aspect?: number;
}

/** Lifter hanging side-on, left side nearest the camera, facing +x (or −x). Chin-up-style elbows
 *  bend forward in the image plane. The whole body rotates about the hands for a swing. */
function sideBody(o: SideOpts): Landmark[] {
  const aspect = o.aspect ?? WIDE;
  const dir = o.facing ?? 1;
  const bx = aspect / 2;
  const W: Pt = [bx, BAR + WRIST_BELOW_BAR + (o.wristDrop ?? 0)];
  const S: Pt = [bx, W[1] + L * (1 - o.p)];
  const E = elbowOf(S, W, dir);
  const hip = add(S, [0, 0.288 * H]);
  const hf = ((o.hipFlex ?? 0) * Math.PI) / 180;
  const kf = ((o.kneeFlex ?? 0) * Math.PI) / 180;
  const knee = add(hip, [dir * 0.245 * H * Math.sin(hf), 0.245 * H * Math.cos(hf)]);
  const ankle = add(knee, [dir * 0.246 * H * Math.sin(hf - kf), 0.246 * H * Math.cos(hf - kf)]);
  const ear = add(S, [-dir * 0.01 * H, -0.09 * H]);
  const nose = add(S, [dir * 0.06 * H, -0.089 * H]);
  const mouth = add(S, [dir * 0.05 * H, -0.075 * H]);
  const phi = (((o.swing ?? 0) * Math.PI) / 180) * dir;
  const rot = (P: Pt): Pt => {
    const x = P[0] - W[0];
    const y = P[1] - W[1];
    return [W[0] + x * Math.cos(phi) + y * Math.sin(phi), W[1] - x * Math.sin(phi) + y * Math.cos(phi)];
  };
  const a = blank();
  const far: Pt = [0.01, 0];
  const chain: [number, number, Pt][] = [
    [7, 8, rot(ear)],
    [9, 10, rot(mouth)],
    [11, 12, rot(S)],
    [13, 14, rot(E)],
    [15, 16, W],
    [23, 24, rot(hip)],
    [25, 26, rot(knee)],
    [27, 28, rot(ankle)],
  ];
  // The far side at 0.7: MediaPipe invents occluded far limbs WITH decent confidence (which is why
  // the squat's both-shoulders-and-hips facing score can lock side-on at all), yet below the near
  // side so the near-side selection stays unambiguous.
  for (const [l, r, pt] of chain) {
    put(a, l, pt, aspect, 0.95, -0.1);
    put(a, r, add(pt, far), aspect, 0.7, 0.1);
  }
  const ky = BAR + (o.wristDrop ?? 0);
  put(a, 17, [bx + dir * 0.01, ky], aspect, 0.9, -0.1);
  put(a, 19, [bx + dir * 0.012, ky], aspect, 0.9, -0.1);
  put(a, 0, rot(nose), aspect, 0.9);
  return a;
}

/** Standing head-on below the bar, arms raised `raise` of the way from the sides (0) to overhead (1). */
function standingFront(raise: number, shoulderY: number): Landmark[] {
  const aspect = WIDE;
  const cx = aspect / 2;
  const a = blank();
  const th = Math.PI * raise;
  for (const [s, e, w, side] of [[11, 13, 15, 1], [12, 14, 16, -1]] as const) {
    const S: Pt = [cx + (side * SW) / 2, shoulderY];
    put(a, s, S, aspect, 0.95);
    put(a, e, [S[0], S[1] + U * Math.cos(th)], aspect, 0.95);
    put(a, w, [S[0], S[1] + L * Math.cos(th)], aspect, 0.95);
  }
  put(a, 0, [cx, shoulderY - 0.089 * H], aspect, 0.95);
  put(a, 9, [cx + 0.025 * H, shoulderY - 0.075 * H], aspect, 0.95);
  put(a, 10, [cx - 0.025 * H, shoulderY - 0.075 * H], aspect, 0.95);
  put(a, 23, [cx + 0.1 * H, shoulderY + 0.288 * H], aspect, 0.95);
  put(a, 24, [cx - 0.1 * H, shoulderY + 0.288 * H], aspect, 0.95);
  return a;
}

const FRONT_HANG = frontHang();
const P_CLEAN = pForClear(0.03, FRONT_HANG); // chin 0.03H over the bar
const P_SHORT = pForClear(-0.06, FRONT_HANG); // chin 0.06H under it

// ---------------------------------------------------------------------------------------
// A. Geometry
// ---------------------------------------------------------------------------------------
{
  const hang = computePullupFrame(frontBody({ p: 0 }), 0.6, 0, WIDE, null);
  const top = computePullupFrame(frontBody({ p: pForClear(0, FRONT_HANG) }), 0.6, 0, WIDE, null);
  check("geometry: straight-arm hang reads a straight elbow (≈180°)", near(hang.elbowAngleDeg, 180, 0.5));
  check("geometry: arms bend through the pull (<100° at the top)", (top.elbowAngleDeg ?? 180) < 100);
  check("geometry: hanging = arms overhead", hang.armsOverhead);
  check("geometry: chin estimate lands on the model chin at the top (chin level with the bar)", near(top.chinY, BAR, 0.002));
  check("geometry: bar sample = the knuckle line", near(barSampleY(hang), BAR, 1e-9));
  const noKnuckles = computePullupFrame(frontBody({ p: 0, knuckles: false }), 0.6, 0, WIDE, null);
  check("geometry: bar fallback from the wrist lands within 0.002 of the bar", noKnuckles.handY === null && near(barSampleY(noKnuckles), BAR, 0.002));
  check("geometry: grip width ratio 1.5× shoulders", near(hang.gripWidthRatio, 1.5, 1e-6) && gripWidthBand(hang.gripWidthRatio) === "standard");
  const tilted = computePullupFrame(frontBody({ p: 0.6, tilt: 0.04 }), 0.6, 0, WIDE, null);
  check("geometry: one shoulder lower raises the tilt differential (>10°)", (tilted.shoulderTiltDiffDeg ?? 0) > 10);
  check("geometry: level shoulders on a level bar read ≈0° tilt", near(hang.shoulderTiltDiffDeg, 0, 1e-6));
  check("geometry: front sets carry no sagittal fields", hang.swingDeg === null && hang.hipAngleDeg === null && hang.kneeAngleDeg === null);
  check("geometry: estimateChinY never extrapolates upward past the mouth", estimateChinY(0.5, 0.45) === 0.45);
  check("geometry: a short top reads the chin below the bar", ((computePullupFrame(frontBody({ p: P_SHORT }), 0.6, 0, WIDE, null).chinY ?? 0) - BAR) > 0.03);

  const sHang = computePullupFrame(sideBody({ p: 0 }), 0.6, 0, WIDE, "left");
  const sSwing = computePullupFrame(sideBody({ p: 0, swing: 20 }), 0.6, 0, WIDE, "left");
  const sSwingMirror = computePullupFrame(sideBody({ p: 0, swing: 20, facing: -1 }), 0.6, 0, WIDE, "left");
  check("geometry: strict side hang = 0° swing", near(sHang.swingDeg, 0, 1e-6));
  check("geometry: a 20° pendulum reads +20° (hips forward)", near(sSwing.swingDeg, 20, 0.01));
  check("geometry: swing sign holds when the lifter faces the other way", near(sSwingMirror.swingDeg, 20, 0.01));
  const sHip = computePullupFrame(sideBody({ p: 0.3, hipFlex: 40 }), 0.6, 0, WIDE, "left");
  check("geometry: 40° hip flexion reads a 140° hip angle", near(sHip.hipAngleDeg, 140, 0.5));
  const sKnee = computePullupFrame(sideBody({ p: 0.3, kneeFlex: 60 }), 0.6, 0, WIDE, "left");
  check("geometry: 60° knee flexion reads a 120° knee angle", near(sKnee.kneeAngleDeg, 120, 0.5));
  check("geometry: side sets carry no frontal fields", sHang.gripWidthRatio === null && sHang.shoulderTiltDiffDeg === null);
  const at169 = computePullupFrame(sideBody({ p: 0.5, swing: 12, aspect: WIDE }), 0.6, 0, WIDE, "left");
  const at43 = computePullupFrame(sideBody({ p: 0.5, swing: 12, aspect: 4 / 3 }), 0.6, 0, 4 / 3, "left");
  check(
    "geometry: aspect invariance — same body at 16:9 and 4:3 gives the same angles",
    near(at169.swingDeg, at43.swingDeg ?? 99, 1e-9) && near(at169.elbowAngleDeg, at43.elbowAngleDeg ?? 99, 1e-9),
  );
  const raw = sideBody({ p: 0.5, swing: 12 });
  const rawSwing = swingAngleDeg([raw[15].x, raw[15].y], [raw[23].x, raw[23].y], 1);
  check("geometry: un-corrected normalized coords misread the same swing (why aspect space exists)", rawSwing !== null && Math.abs(rawSwing - (at169.swingDeg ?? 0)) > 3);
  const standing = computePullupFrame(standingFront(0, 0.4), 0.6, 0, WIDE, null);
  check("geometry: standing with arms down is NOT arms-overhead", !standing.armsOverhead);
}

// ---------------------------------------------------------------------------------------
// B. Orientation (the squat's facing score works on a vertical, hanging body)
// ---------------------------------------------------------------------------------------
{
  const cls = (lm: Landmark[]) => estimateOrientation(lm, 0.6, WIDE).orientation;
  check("orientation: head-on hang → front", cls(frontBody({ p: 0 })) === "front");
  check("orientation: head-on at the top → still front", cls(frontBody({ p: P_CLEAN })) === "front");
  check("orientation: side hang → side", cls(sideBody({ p: 0 })) === "side");
  check("orientation: side at the top → still side", cls(sideBody({ p: 0.95 })) === "side");
}

// ---------------------------------------------------------------------------------------
// C. Rep counter
// ---------------------------------------------------------------------------------------
const FPS = 30;

type Keyframe = [number, number, Partial<FrontOpts>?];
/** Interpolate [t, p, extra] keyframes at FPS (the wrist drop is interpolated too). */
function framesOf(points: Keyframe[]): { t: number; o: FrontOpts }[] {
  const out: { t: number; o: FrontOpts }[] = [];
  for (let i = 1; i < points.length; i++) {
    const [t0, p0, e0 = {}] = points[i - 1];
    const [t1, p1, e1 = {}] = points[i];
    const n = Math.max(1, Math.round((t1 - t0) * FPS));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const f = k / n;
      const drop0 = e0.wristDrop ?? 0;
      const drop1 = e1.wristDrop ?? 0;
      out.push({ t: t0 + (t1 - t0) * f, o: { ...e1, p: p0 + (p1 - p0) * f, wristDrop: drop0 + (drop1 - drop0) * f } });
    }
  }
  return out;
}
function runTracker(points: Keyframe[]): { reps: PullupRep[]; tracker: PullupRepTracker } {
  const reps: PullupRep[] = [];
  const tracker = new PullupRepTracker(PULLUP, (r) => reps.push(r));
  for (const { t, o } of framesOf(points)) tracker.update(computePullupFrame(frontBody(o), 0.6, t, WIDE, null));
  return { reps, tracker };
}
{
  const full = runTracker([[0, 0], [0.5, 0], [1.5, P_CLEAN], [1.6, P_CLEAN], [2.6, 0], [3.1, 0]]).reps;
  check("rep counter: one full pull-up = 1 attempt, closed on the return to the hang", full.length === 1 && full[0].endedBy === "return");
  check("rep counter: peak ratio ≈ the chin-over-bar model (~1)", near(full[0]?.peakRatio, P_CLEAN, 0.02));
  check("rep counter: the start frame is the straight-arm hang", near(full[0]?.startRatio, 0, 0.01) && near(full[0]?.start.elbowAngleDeg, 180, 1));
  check("rep counter: concentric velocity measured", (full[0]?.concentricVelocity ?? 0) > 0);
  check("rep counter: scapular pull (ratio 0.12) never arms", runTracker([[0, 0], [0.5, 0], [0.9, 0.12], [1.3, 0], [1.8, 0]]).reps.length === 0);
  check("rep counter: sub-0.5 s bob debounced", runTracker([[0, 0], [0.5, 0], [0.65, 0.9], [0.8, 0], [1.3, 0]]).reps.length === 0);

  const partial = runTracker([[0, 0], [0.5, 0], [1.5, P_CLEAN], [1.6, P_CLEAN], [2.2, 0.45], [2.3, 0.45], [3.1, P_CLEAN], [3.2, P_CLEAN], [4.2, 0], [4.7, 0]]).reps;
  check("rep counter: lowering halfway then pulling again splits into 2 attempts", partial.length === 2);
  check("rep counter: the first closes at its partial bottom", partial[0]?.endedBy === "partial" && near(partial[0]?.endRatio, 0.45, 0.05));
  check("rep counter: the second STARTS from that bent-arm partial hang", near(partial[1]?.startRatio, 0.45, 0.05) && (partial[1]?.start.elbowAngleDeg ?? 180) < 140);

  const drop = runTracker([[0, 0], [0.5, 0], [1.5, P_CLEAN], [1.7, P_CLEAN], [1.9, P_CLEAN, { wristDrop: 0.15 }], [2.5, P_CLEAN, { wristDrop: 0.15 }]]).reps;
  check("rep counter: letting go at the top closes the attempt as a dismount", drop.length === 1 && drop[0].endedBy === "dismount" && near(drop[0].peakRatio, P_CLEAN, 0.02));

  // Dropping off the bar, then lowering the arms while standing: h shrinks exactly like a pull.
  const reps: PullupRep[] = [];
  const tr = new PullupRepTracker(PULLUP, (r) => reps.push(r));
  let t = 0;
  const feed = (lm: Landmark[]) => {
    tr.update(computePullupFrame(lm, 0.6, t, WIDE, null));
    t += 1 / FPS;
  };
  for (let i = 0; i < 20; i++) feed(frontBody({ p: 0 }));
  const hangShoulder = BAR + WRIST_BELOW_BAR + FRONT_HANG;
  for (let i = 0; i <= 10; i++) feed(frontBody({ p: 0, wristDrop: (0.12 * i) / 10 }));
  for (let i = 0; i <= 45; i++) feed(standingFront(1 - i / 45, hangShoulder + 0.12));
  check("rep counter: dropping off and lowering the arms never arms a phantom rep", reps.length === 0 && !tr.isDown);

  // Standing reach below a higher bar, then jumping up to it: the grip moves up (new epoch).
  const jr: PullupRep[] = [];
  const jt = new PullupRepTracker(PULLUP, (r) => jr.push(r));
  let jtime = 0;
  const jfeed = (lm: Landmark[]) => {
    jt.update(computePullupFrame(lm, 0.6, jtime, WIDE, null));
    jtime += 1 / FPS;
  };
  for (let i = 0; i < 20; i++) jfeed(frontBody({ p: 0, wristDrop: 0.1 })); // hands 0.1 below the bar (standing reach)
  for (let i = 0; i <= 9; i++) jfeed(frontBody({ p: 0, wristDrop: 0.1 - (0.1 * i) / 9 })); // jump
  for (let i = 0; i < 20; i++) jfeed(frontBody({ p: 0 }));
  check("rep counter: jumping up to the bar bumps the grip epoch", jt.gripEpoch > 0 && jr.length === 0);

  const spikeReps: PullupRep[] = [];
  const sp = new PullupRepTracker(PULLUP, (r) => spikeReps.push(r));
  for (let i = 0; i < 40; i++) sp.update(computePullupFrame(frontBody({ p: i === 20 ? 0.9 : 0 }), 0.6, i / FPS, WIDE, null));
  check("rep counter: single-frame landmark spike never arms (median filter)", !sp.isDown && spikeReps.length === 0);
}

// ---------------------------------------------------------------------------------------
// D. Counting policy
// ---------------------------------------------------------------------------------------
{
  const chin = PULLUP_TOP_PRESETS.chin;
  check("top: chin clearance at target reaches", judgeTop(chin.chinClearanceTarget, 0.5, "chin").reached);
  const short = judgeTop(-0.2, 0.99, "chin");
  check("top: chin basis decides even when the ratio looks high", !short.reached && short.basis === "chin_clearance");
  const noFace = judgeTop(null, 0.95, "chin");
  check("top: no readable face → falls back to the pull ratio", noFace.basis === "pull_ratio" && noFace.reached);
  check("top: fallback ratio short of target misses", !judgeTop(null, 0.7, "chin").reached);
  check("extension: straight elbow at the start passes", judgeExtension(172, 0.02).ok);
  const bent = judgeExtension(130, 0.05);
  check("extension: 130° elbow fails in DEGREES", !bent.ok && bent.basis === "elbow_angle_deg");
  const gross = judgeExtension(170, 0.3);
  check("extension: a straight-READING elbow far above the hang fails the gross ratio backstop", !gross.ok && gross.basis === "pull_ratio");
  check("extension: an active hang (ratio 0.10, straight elbow) passes", judgeExtension(175, 0.1).ok);
  check("extension: no readable elbow → ratio decides", judgeExtension(null, 0.08).ok && !judgeExtension(null, 0.2).ok);

  const both = pullupRepCounts(judgeExtension(120, 0.2), judgeTop(-0.25, 0.8, "chin"));
  check("count: both gates can miss on one attempt, in time order", !both.counted && both.misses.map((m) => m.reason).join(",") === "extension_miss,top_miss");
  check("count: elbow 30° short is a LARGE shortfall", both.misses[0]?.band === "large");
  check("count: chin 0.2 short of target is a LARGE shortfall", both.misses[1]?.band === "large");
  const marginal = pullupRepCounts(judgeExtension(170, 0), judgeTop(-0.07, 0.9, "chin"));
  check("count: 0.02 short of the chin target is marginal", marginal.misses[0]?.band === "marginal");
  check("count: clean rep counts", pullupRepCounts(judgeExtension(175, 0), judgeTop(0.05, 1, "chin")).counted);
  check("band: not short → null", pullupShortfallBand(-1, "chin_clearance") === null);
  const p = PULLUP_TOP_PRESETS;
  check(
    "presets: chest > chin > nose in both bases",
    p.chest.chinClearanceTarget > p.chin.chinClearanceTarget &&
      p.chin.chinClearanceTarget > p.nose.chinClearanceTarget &&
      p.chest.pullRatioTarget > p.chin.pullRatioTarget &&
      p.chin.pullRatioTarget > p.nose.pullRatioTarget,
  );
  check(
    "presets: ratio fallbacks sit within ~0.1 below the [DERIVED] 0.976 + clearance model",
    Object.values(p).every((s) => {
      const model = 0.976 + s.chinClearanceTarget;
      return s.pullRatioTarget <= model + 0.01 && s.pullRatioTarget >= model - 0.1;
    }),
  );
  check("config: dismount drop stays below the arming ratio (lowered arms can never arm)", PULLUP.dismountDropRatio < PULLUP.repUpRatio);
  check("config: an active hang returns (returnRatio above the active-hang offset)", PULLUP.returnRatio > PULLUP.extension.ratioMax);
}

// ---------------------------------------------------------------------------------------
// E. Trigger predicates
// ---------------------------------------------------------------------------------------
{
  check("U1: 25° swing fires absolute with no baseline", swingTrigger(25, null) === "absolute");
  check("U1: 15° swing with NO baseline stays silent (relative disarmed)", swingTrigger(15, null) === null);
  check("U1: 15° vs a 3° warm-up = baseline_relative", swingTrigger(15, 3) === "baseline_relative");
  check("U1: 11° vs a 3° warm-up stays silent", swingTrigger(11, 3) === null);
  check("U1: garbage swing never fires", swingTrigger(400, 0) === null);
  check("U3: 35° leg change fires; 25° doesn't", legDriveTriggerActive(35) && !legDriveTriggerActive(25));
  check("U4: 12° vs 3° warm-up fires; 10° doesn't; no baseline never fires", evenTriggerActive(12, 3) && !evenTriggerActive(10, 3) && !evenTriggerActive(40, null));
  check("U2: 2.1× warm-up lowering warns", evalPullupEccentric(0.21, 0.1).status === "warn");
  check("U2: 1.9× stays ok (slow-warm-up lesson: 2.0×, not 1.5×)", evalPullupEccentric(0.19, 0.1).status === "ok");
  check("U2: no lowering baseline → unknown, never a clean pass", evalPullupEccentric(0.3, null).status === "unknown");
  check("descent: measured from the top of the rep to the hang", near(pullupDescentSpeed([0, 500, 1000, 1500], [0.5, 0.3, 0.4, 0.5]), 0.2, 1e-9));
  check("descent: no descent → null", pullupDescentSpeed([0, 500], [0.5, 0.3]) === null);
  const garbage = computePullupFrame(frontBody({ p: 0, grip: 6 }), 0.6, 0, WIDE, null);
  check("implausible: impossible grip width flagged on FRONT sets", pullupLandmarkImplausible(garbage, "front"));
  check("implausible: never flags SIDE sets (squat 18/18 lesson)", !pullupLandmarkImplausible(garbage, "side"));
}

// ---------------------------------------------------------------------------------------
// F. Session integration (frames → records)
// ---------------------------------------------------------------------------------------
interface RepSpec {
  clear?: number; // chin height over the bar at the top (× H)
  pullSec?: number;
  lowerSec?: number;
  lowerTo?: number; // true pull ratio this rep lowers back to (0 = straight-arm hang)
  swing?: number; // side: kip amplitude (deg) — back-swing in the hang, forward through the pull
  hipFlex?: number; // side: hip flexion peak during the pull (deg)
  tilt?: number; // front: left shoulder dropped at the top (aspect units)
}

interface SetOpts {
  preset?: PullupTopPreset;
  face?: boolean;
  startP?: number; // true pull ratio of the hang before rep 1
  setIndex?: number;
}

function runSet(view: "side" | "front", specs: RepSpec[], so: SetOpts = {}): { session: PullupSetSession; fired: string[]; baselineTs: number[] } {
  const session = new PullupSetSession({ setIndex: so.setIndex ?? 1, orientation: view, topPreset: so.preset ?? "chin", grip: "overhand" });
  const fired: string[] = [];
  const baselineTs: number[] = [];
  const hDown = view === "side" ? L : FRONT_HANG;
  let t = 0;
  const feed = (p: number, swing: number, hipFlex: number, tilt: number) => {
    const lm = view === "side" ? sideBody({ p, swing, hipFlex }) : frontBody({ p, tilt, face: so.face });
    const frame = computePullupFrame(lm, 0.6, t, WIDE, view === "side" ? "left" : null);
    const ev = session.onFrame(frame, t, view === "side" ? 0 : 90);
    for (const f of ev.fired) fired.push(`${f.repIndex}:${f.faultType}`);
    baselineTs.push(...ev.baselineFrameTs);
    t += 1 / FPS;
  };
  const ramp = (sec: number, fn: (f: number) => [number, number, number, number]) => {
    const n = Math.round(sec * FPS);
    for (let i = 1; i <= n; i++) feed(...fn(i / n));
  };
  let bottom = so.startP ?? 0;
  ramp(0.6, () => [bottom, 0, 0, 0]);
  for (const s of specs) {
    const top = pForClear(s.clear ?? 0.03, hDown);
    const A = s.swing ?? 0;
    const hip = s.hipFlex ?? 0;
    const tilt = s.tilt ?? 0;
    ramp(0.4, (f) => [bottom, (-A / 2) * f, 0, 0]); // back-swing in the hang (pre-arm)
    ramp(s.pullSec ?? 1.0, (f) => [bottom + (top - bottom) * f, -A / 2 + A * f, hip * Math.sin(Math.PI * f), tilt * f]);
    ramp(0.1, () => [top, A / 2, 0, tilt]);
    const to = s.lowerTo ?? 0;
    ramp(s.lowerSec ?? 1.0, (f) => [top + (to - top) * f, (A / 2) * (1 - f), 0, tilt * (1 - f)]);
    bottom = to;
    ramp(0.4, () => [bottom, 0, 0, 0]);
  }
  return { session, fired, baselineTs };
}

{
  const { session, fired, baselineTs } = runSet("front", [{}, {}, {}, { clear: -0.06 }, { tilt: 0.04 }]);
  const reps = session.reps();
  check("session: 5 front attempts recorded", reps.length === 5);
  check("session: clean reps count with the chin basis", reps.slice(0, 3).every((r) => r.counted && r.top.basis === "chin_clearance"));
  check("session: the bar line is found at the knuckles", near(session.barLineY(), BAR, 0.002));
  check("session: clean chin clearance ≈ 0.03H / hang height", near(reps[0]?.peakChinClearance, (0.03 * H) / FRONT_HANG, 0.02));
  check("session: chin 0.06H under the bar = a top_miss (chin basis)", !!reps[3] && !reps[3].counted && reps[3].misses[0]?.reason === "top_miss" && reps[3].misses[0]?.basis === "chin_clearance");
  check("session: one shoulder dropping fires U4 on rep 5 only", fired.includes("5:uneven_pull") && !fired.some((f) => f.startsWith("4:uneven")));
  check("session: warm-up reps 1–2 archive their TOP frames", baselineTs.length === 2);
  check("session: front records never carry sagittal fields", reps.every((r) => r.swingRangeDeg === null && r.legRangeDeg === null));
  check("session: front evenness baseline resolved from the warm-up", session.baselineSnapshot().shoulderTiltDiffDeg !== null);
  check("session: trigger moment captured for archiving", session.momentFor(5, "evenness")?.faultType === "uneven_pull");

  const back = runSet("front", [{}, {}, {}], { face: false });
  check("session: camera behind the lifter (no face) → top judged on the pull ratio", back.session.reps().every((r) => r.top.basis === "pull_ratio" && r.counted));

  const side = runSet("side", [{}, {}, {}, { swing: 26 }, { hipFlex: 45 }, {}]);
  const sreps = side.session.reps();
  check("session: 6 side attempts, all counted", sreps.length === 6 && sreps.every((r) => r.counted));
  check("session: strict side reps read ≈0° swing", near(sreps[2]?.swingRangeDeg, 0, 0.5));
  check("session: a 26° kip fires U1 (absolute) on rep 4 — the pre-arm back-swing is included", side.fired.includes("4:body_swing") && sreps[3]?.swingFire === "absolute" && (sreps[3]?.swingRangeDeg ?? 0) > 24);
  check("session: a 45° knee tuck fires U3 on rep 5", side.fired.includes("5:leg_drive") && near(sreps[4]?.hipRangeDeg, 45, 2));
  check("session: the clean rep after does not fire", !side.fired.some((f) => f.startsWith("6:")));
  check("session: side records never carry frontal fields", sreps.every((r) => r.tiltPeakDeg === null && r.gripWidthRatio === null));
  check("session: a warm-up kip never fires", !runSet("side", [{ swing: 30 }, {}, {}]).fired.some((f) => f.startsWith("1:")));
  check("session: 15° swing vs a still warm-up fires baseline_relative", runSet("side", [{}, {}, { swing: 15 }]).session.reps()[2]?.swingFire === "baseline_relative");

  const fast = runSet("front", [{}, {}, { lowerSec: 0.2 }, {}]);
  check("session: a ~5× faster lowering fires U2", fast.fired.includes("3:eccentric_control"));
  check("session: normal lowering does not fire U2", !fast.fired.includes("4:eccentric_control"));

  // Extension: rep 4 lowers only halfway, rep 5 pulls from there.
  const halfway = runSet("side", [{}, {}, {}, { lowerTo: 0.45 }, {}, {}]);
  const hreps = halfway.session.reps();
  check("session: pulling again from a half hang = extension_miss on THAT rep (degrees)", !!hreps[4] && !hreps[4].counted && hreps[4].misses[0]?.reason === "extension_miss" && hreps[4].misses[0]?.basis === "elbow_angle_deg");
  check("session: the half-lowered rep itself still counts (its start was a full hang)", !!hreps[3] && hreps[3].counted && hreps[3].endedBy === "partial");

  // Baseline starvation: never straighten during the warm-up → baselines unresolved ALL set.
  const starved = runSet("side", [{ lowerTo: 0.35 }, { lowerTo: 0 }, {}, { swing: 15 }, {}], { startP: 0.35 });
  const st = starved.session.reps();
  check("session: bent-arm warm-up reps are extension misses and don't feed the baseline", !st[0].counted && !st[0].fedBaseline && !st[1].fedBaseline);
  check("session: a failed warm-up leaves the swing baseline unresolved ALL set", starved.session.baselineSnapshot().swingRangeDeg === null);
  check("session: with the relative check disarmed, a 15° swing stays silent", !starved.fired.includes("4:body_swing"));
  check("session: straightening mid-set works — rep 3 starts from a full hang and counts", st[2]?.counted === true);
}

// ---------------------------------------------------------------------------------------
// G. Payload honesty
// ---------------------------------------------------------------------------------------
function setRecord(view: "side" | "front", specs: RepSpec[], index: number, so: SetOpts = {}): PullupSetRecord {
  return runSet(view, specs, { ...so, setIndex: index }).session.toSetRecord(view === "side" ? 0 : 90);
}
const frontSet = setRecord("front", [{}, {}, {}, { clear: -0.06 }, { tilt: 0.04 }, { lowerSec: 0.2 }], 1);
const sideSet = setRecord("side", [{}, {}, { swing: 26 }, { hipFlex: 45, lowerTo: 0.45 }, {}], 2);
const frontData = buildPullupPostSetData(frontSet, { baselineFramesIncluded: 2 });
const sideData = buildPullupPostSetData(sideSet, { baselineFramesIncluded: 2 });
{
  check(
    "payload front: sagittal fields are NULL (not 0/false)",
    frontData.baseline.swing_range_deg === null && frontData.context.swing_range_deg === null && frontData.context.leg_angle_change_deg === null,
  );
  check("payload front: frontal fields present", frontData.baseline.shoulder_tilt_diff_deg !== null && frontData.context.grip_width_band === "standard");
  check(
    "payload side: frontal fields are NULL",
    sideData.baseline.shoulder_tilt_diff_deg === null && sideData.context.grip_width_ratio === null && sideData.context.grip_width_band === null,
  );
  check("payload side: sagittal context present", sideData.baseline.swing_range_deg !== null && sideData.context.swing_range_deg !== null);
  check("payload: exercise tag selects the pull-up prompt", frontData.exercise === "pullup" && sideData.exercise === "pullup");
  check("payload front: uneven_pull + eccentric_control fired", frontData.triggers_fired.some((t) => t.type === "uneven_pull") && frontData.triggers_fired.some((t) => t.type === "eccentric_control" && (t.baseline_multiple ?? 0) >= 2));
  check("payload side: body_swing (absolute) + leg_drive fired", sideData.triggers_fired.some((t) => t.type === "body_swing" && t.basis === "absolute") && sideData.triggers_fired.some((t) => t.type === "leg_drive"));
  check("payload side: body_swing carries a delta past the still warm-up", (sideData.triggers_fired.find((t) => t.type === "body_swing")?.baseline_delta_deg ?? 0) > 20);
  check("payload front: short rep 4 in uncounted_reps with chin basis + band", frontData.uncounted_reps.some((u) => u.rep_number === 4 && u.misses[0].reason === "top_miss" && u.misses[0].basis === "chin_clearance" && u.misses[0].band !== null));
  check("payload side: the rep pulled from the half hang is an extension_miss in degrees", sideData.uncounted_reps.some((u) => u.rep_number === 5 && u.misses[0].reason === "extension_miss" && u.misses[0].basis === "elbow_angle_deg"));
  check("payload: miss counts agree with uncounted_reps", frontData.set_summary.top_misses === frontData.uncounted_reps.filter((u) => u.misses.some((m) => m.reason === "top_miss")).length);
  check("payload: every achieved top value names its own basis", frontData.top_context.achieved_by_rep.every((a) => a.basis === "chin_clearance"));

  const starvedSide = buildPullupPostSetData(setRecord("side", [{ lowerTo: 0.35 }, { lowerTo: 0 }, {}], 3, { startP: 0.35 }), { baselineFramesIncluded: 2 });
  check(
    "disarmed side: names the body swing + lowering, NOT the frontal evenness check",
    starvedSide.baseline.checks_disarmed.some((c) => c.startsWith("body swing")) &&
      starvedSide.baseline.checks_disarmed.includes("lowering control") &&
      !starvedSide.baseline.checks_disarmed.includes("left/right evenness"),
  );
  check("disarmed side: baseline.valid false", starvedSide.baseline.valid === false);
  const starvedFront = buildPullupPostSetData(setRecord("front", [{ lowerTo: 0.35 }, { lowerTo: 0 }, {}], 4, { startP: 0.35 }), { baselineFramesIncluded: 2 });
  check(
    "disarmed front: names evenness, never the body swing",
    starvedFront.baseline.checks_disarmed.includes("left/right evenness") && !starvedFront.baseline.checks_disarmed.some((c) => c.startsWith("body swing")),
  );

  // Trigger layer ≠ metric layer: a warn with no fired trigger must not become a finding.
  const metricOnly: PullupSetRecord = JSON.parse(JSON.stringify(setRecord("side", [{}, {}, {}], 5)));
  metricOnly.reps[2].metrics.swing = { metric: "swing", status: "warn", severity: "warning", message: "x", value: 30 };
  metricOnly.reps[2].swingRangeDeg = 30;
  check("payload: metric warn without a trigger is NOT in triggers_fired", !buildPullupPostSetData(metricOnly, { baselineFramesIncluded: 2 }).triggers_fired.some((t) => t.type === "body_swing"));

  const pw = buildPullupPostWorkoutData([frontSet, sideSet], []);
  const swingTrend = pw.fault_trends.find((f) => f.type === "body_swing");
  check("post-workout: body_swing observable only in side sets", !!swingTrend && swingTrend.sets_observable.join() === "2");
  check("post-workout: uneven_pull observable only in front sets", pw.fault_trends.find((f) => f.type === "uneven_pull")?.sets_observable.join() === "1");
  const slowSet: PullupSetRecord = JSON.parse(JSON.stringify(sideSet));
  const swingRep = slowSet.reps.find((r) => r.triggeredMetrics.includes("swing")) as PullupRepRecord;
  if (swingRep.velocity) swingRep.velocity.ratio = 1.1;
  check("post-workout: co_occurred_with_slowing FALSE when the fault rep was faster", buildPullupPostWorkoutData([slowSet], []).fault_trends.find((f) => f.type === "body_swing")?.co_occurred_with_slowing === false);
  if (swingRep.velocity) swingRep.velocity.ratio = 0.8;
  check("post-workout: co_occurred_with_slowing TRUE only on the rep's OWN ratio < 1", buildPullupPostWorkoutData([slowSet], []).fault_trends.find((f) => f.type === "body_swing")?.co_occurred_with_slowing === true);
  check(
    "post-workout: unmeasured velocity is null, not a fabricated 1.0",
    buildPullupPostWorkoutData([{ ...sideSet, reps: sideSet.reps.map((r) => ({ ...r, velocity: null })) }], []).cross_set_metrics.velocity_degradation_per_set[0] === null,
  );
}

// ---------------------------------------------------------------------------------------
// H. Prompt ↔ payload contract
// ---------------------------------------------------------------------------------------
{
  const pw = buildPullupPostWorkoutData([frontSet, sideSet], [{ set_number: 1, orientation: "front", text: "x" }]);
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
  const vocab = new Set([
    "chin_clearance",
    "pull_ratio",
    "elbow_angle_deg",
    "extension_miss",
    "top_miss",
    "nose_to_bar",
    "baseline_relative",
    "body_swing",
    "leg_drive",
    "eccentric_control",
    "uneven_pull",
  ]);
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
    ["post-set", PULLUP_POSTSET_SYSTEM, [sideData, frontData]],
    ["post-workout", PULLUP_POSTWORKOUT_SYSTEM, [pw]],
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
    SHARED_POSTSET_RULES.every((pre) => lines(PULLUP_POSTSET_SYSTEM).find((l) => l.startsWith(pre)) === lines(POSTSET_SYSTEM).find((l) => l.startsWith(pre))),
  );
  check(
    "prompt: shared post-workout rules are byte-identical to the squat prompt",
    SHARED_POSTWORKOUT_RULES.every((pre) => lines(PULLUP_POSTWORKOUT_SYSTEM).find((l) => l.startsWith(pre)) === lines(POSTWORKOUT_SYSTEM).find((l) => l.startsWith(pre))),
  );
  const leak = /squat|valgus|knee cave|hip-vs-knee|rep_context|forward lean|push-up|body line|plank|\bdepth\b/i;
  const leaked = (p: string) => (p.match(leak) ?? [])[0] ?? "none";
  check(
    `prompt: pull-up prompts carry no squat / push-up vocabulary (post-set: ${leaked(PULLUP_POSTSET_SYSTEM)}, post-workout: ${leaked(PULLUP_POSTWORKOUT_SYSTEM)})`,
    !leak.test(PULLUP_POSTSET_SYSTEM) && !leak.test(PULLUP_POSTWORKOUT_SYSTEM),
  );
  check("prompt: plain-text rule 8 kept in both pull-up prompts", PULLUP_POSTSET_SYSTEM.includes("PLAIN TEXT ONLY") && PULLUP_POSTWORKOUT_SYSTEM.includes("PLAIN TEXT ONLY"));
  check(
    "prompt: squat and push-up prompts untouched by pull-up wording",
    ![POSTSET_SYSTEM, POSTWORKOUT_SYSTEM, PUSHUP_POSTSET_SYSTEM, PUSHUP_POSTWORKOUT_SYSTEM].some((p) => /pull-up|chin clearance/i.test(p)),
  );
  check(
    "prompt: rule numbering complete (1,1a,2,3,3a,4,5,6,6a,6b,7,8)",
    ["1. ", "1a. ", "2. ", "3. ", "3a. ", "4. ", "5. ", "6. ", "6a. ", "6b. ", "7. ", "8. "].every((p) => lines(PULLUP_POSTSET_SYSTEM).some((l) => l.startsWith(p))),
  );
  check("prompt: elbow angles are explicitly not quotable (projection-lenient)", /NEVER QUOTE[^\n]*elbow angles/.test(PULLUP_POSTSET_SYSTEM));
}

// ---------------------------------------------------------------------------------------
// I. Eval table + J. synthesis
// ---------------------------------------------------------------------------------------
{
  const ctxFront = { view: "front" as const, grip: "overhand" as const, topPreset: "chin" as const };
  const ctxSide = { view: "side" as const, grip: "overhand" as const, topPreset: "chin" as const };
  const frontRows = buildPullupTriggerTable(frontSet.reps[4], ctxFront);
  const sideRows = buildPullupTriggerTable(sideSet.reps[2], ctxSide);
  const warmRows = buildPullupTriggerTable(sideSet.reps[0], ctxSide);
  const row = (rows: typeof frontRows, id: string) => rows.find((r) => r.id === id);
  check("evaltable: front scored rep — U4 eligible + fired, U1/U3 ineligible", !!row(frontRows, "U4_uneven_pull")?.fired && !row(frontRows, "U1_body_swing")?.eligible && !row(frontRows, "U3_leg_drive")?.eligible);
  check("evaltable: side scored rep — U1 eligible + fired, U4 ineligible", !!row(sideRows, "U1_body_swing")?.fired && !row(sideRows, "U4_uneven_pull")?.eligible);
  check("evaltable: warm-up reps have no eligible triggers", !["U1_body_swing", "U2_eccentric_control", "U3_leg_drive", "U4_uneven_pull"].some((id) => row(warmRows, id)?.eligible));
  check("evaltable: both counting gates eligible in both views", !!row(frontRows, "top_gate")?.eligible && !!row(sideRows, "extension_gate")?.eligible);
  check("evaltable: the short rep's top gate is a MISS", !!buildPullupTriggerTable(frontSet.reps[3], ctxFront).find((r) => r.id === "top_gate")?.fired);

  const frontOnly = synthesizePullup([frontSet]);
  check("synthesis: body swing + leg drive NOT assessed without a side set (doorway bar)", ["swing", "legDrive"].every((id) => frontOnly.metrics.find((m) => m.metric === id)?.status === "not-assessed"));
  check("synthesis: the top gate is flagged from a front set", frontOnly.metrics.find((m) => m.metric === "top")?.status === "warn");
  const both = synthesizePullup([frontSet, sideSet]);
  check("synthesis: tally line names the missed gate", (both.setSummaries[0].tallyText ?? "").includes("short of the top"));
  check("synthesis: swing flagged from the trigger layer", both.metrics.find((m) => m.metric === "swing")?.status === "warn");
  check("synthesis: headline counts head-on first", both.headline.includes("head-on set 1"));
}

console.log(`\n(${PULLUP_FACE.chinBelowMouth} chin factor · ${PULLUP_TRIGGERS.baselineReps} warm-up reps)`);
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
