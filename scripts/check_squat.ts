/* Sanity checks for the Neuro-Fit orientation-aware squat logic. Run with:
   npm run check:squat

   NOTE: these are SYNTHETIC/geometric checks on hand-built landmark frames.
   They validate the math + gating (incl. severity zones, per-check tolerance
   EDGES, and the AI-trigger coordinator), NOT real footage. Real-footage edge
   validation is a manual step — see TOLERANCE_VALIDATION.md.                  */
import { GEMINI, ORIENTATION, SEVERITY, SQUAT, TRIGGERS } from "../src/neurofit/squat/config";
import { computeSquatFrame, type SquatFrame } from "../src/neurofit/squat/frame";
import { SquatRepTracker, type SquatRep } from "../src/neurofit/squat/repCounter";
import { VelocityTracker } from "../src/neurofit/squat/velocity";
import {
  AGGREGATED_METRICS,
  aggregateRep,
  depthShortfallBand,
  evaluateRep,
  evalEccentric,
  landmarkImplausible,
  leanTriggerActive,
  repCounts,
  repFeedsBaseline,
  severityFor,
  shiftTriggerActive,
  valgusTriggerActive,
  velocityBand,
  warnedMetrics,
  criticalMetrics,
  type RepMetrics,
  type VelocityVerdict,
} from "../src/neurofit/squat/checks";
import { BaselineTracker, EccentricTracker, PersistenceGate } from "../src/neurofit/squat/dynamics";
import { LandmarkBuffer, ImageBuffer } from "../src/neurofit/ai/frameBuffer";
import { bodyCropRect, fitWithin, type CropPoint } from "../src/neurofit/ai/frameGeometry";
import {
  classify,
  distanceFromOrientation,
  estimateOrientation,
} from "../src/neurofit/vision/orientation";
import { CoachingCoordinator } from "../src/neurofit/ai/coaching";
import { decideExposure } from "../src/neurofit/vision/exposure";
import { estimateCameraAngle } from "../src/neurofit/vision/cameraAngle";
import type { Landmark } from "../src/neurofit/pose/landmarks";
import { buildTriggerTable, type RepEvalInputs } from "../src/neurofit/debug/evalLog";
import { METRIC_ORDER, type MetricId } from "../src/neurofit/squat/metrics";
import { computeFacing } from "../src/neurofit/pose/facing";
import { squatFaultTrends, velocityDegradationPerSet } from "../src/neurofit/session/faultTrends";
import type { RepRecord, SetRecord } from "../src/neurofit/session/types";
import type { VelocitySample } from "../src/neurofit/squat/velocity";
import { POSTSET_SYSTEM, POSTWORKOUT_SYSTEM } from "../src/neurofit/ai/prompts";
import {
  MONTH_MS,
  appendCall,
  appendWorkout,
  emptyLedger,
  evaluateQuota,
  percentile,
  pruneLedger,
  summarize,
  upsertWorkout,
  wasSent,
  type UsageCall,
  type UsageLedger,
} from "../src/neurofit/usage/ledger";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

// --- SquatFrame builder ---------------------------------------------------
function sf(o: Partial<SquatFrame> & { t: number; kneeAngle: number | null }): SquatFrame {
  return {
    t: o.t,
    kneeAngle: o.kneeAngle,
    leftKneeAngle: o.leftKneeAngle ?? o.kneeAngle,
    rightKneeAngle: o.rightKneeAngle ?? o.kneeAngle,
    hipMid: o.hipMid ?? null,
    kneeMid: o.kneeMid ?? null,
    ankleMid: o.ankleMid ?? null,
    shoulderMid: o.shoulderMid ?? null,
    leftShoulder: o.leftShoulder ?? null,
    rightShoulder: o.rightShoulder ?? null,
    leftHip: o.leftHip ?? null,
    rightHip: o.rightHip ?? null,
    leftKnee: o.leftKnee ?? null,
    rightKnee: o.rightKnee ?? null,
    leftAnkle: o.leftAnkle ?? null,
    rightAnkle: o.rightAnkle ?? null,
    torsoLean: o.torsoLean ?? null,
    levelnessDiffDeg: o.levelnessDiffDeg ?? null,
    shinAngleDeg: o.shinAngleDeg ?? null,
    footAngleDeg: o.footAngleDeg ?? null,
    shoulderWidth: o.shoulderWidth ?? null,
    kneeWidth: o.kneeWidth ?? null,
    ankleWidth: o.ankleWidth ?? null,
    hipWidth: o.hipWidth ?? null,
    bothLegsVisible: o.bothLegsVisible ?? false,
  };
}
const VEL = (degraded: boolean, ratio?: number): VelocityVerdict => ({
  measured: true,
  degraded,
  ratio: ratio ?? (degraded ? 0.6 : 0.95),
});

// --- Rep counter: vertical HIP DISPLACEMENT (orientation-agnostic) ---------
const HIP = (t: number, hy: number, knee: number) =>
  sf({ t, kneeAngle: knee, hipMid: [0.5, hy], ankleMid: [0.5, 0.9], kneeMid: [0.5, 0.7] });
const reps: SquatRep[] = [];
const tracker = new SquatRepTracker(SQUAT, (r) => reps.push(r));
for (const [t, hy, knee] of [
  [0.0, 0.50, 172], [0.2, 0.58, 168], [0.4, 0.72, 165], [0.6, 0.76, 164], [0.8, 0.60, 168], [1.0, 0.51, 172],
] as Array<[number, number, number]>) {
  tracker.update(HIP(t, hy, knee));
}
check("head-on squat counts via hip drop (knee angle ~stays high)", tracker.reps === 1);
check("concentric velocity measured", (reps[0]?.concentricVelocity ?? 0) > 0);
check("bottom depth ratio recorded", (reps[0]?.bottomDepthRatio ?? 0) > 0.3);

const shallow = new SquatRepTracker(SQUAT);
for (const [t, hy] of [[0, 0.50], [0.3, 0.55], [0.6, 0.50]] as Array<[number, number]>) shallow.update(HIP(t, hy, 170));
check("shallow bob doesn't count", shallow.reps === 0);

const fast = new SquatRepTracker(SQUAT);
for (const [t, hy] of [[0.0, 0.50], [0.1, 0.76], [0.2, 0.50]] as Array<[number, number]>) fast.update(HIP(t, hy, 170));
check("sub-0.3s rep debounced", fast.reps === 0);

// --- Velocity: ROLLING-AVERAGE trigger (spec §2) --------------------------
const vt = new VelocityTracker(SQUAT);
vt.add(1, 0.6); vt.add(2, 0.58);
check("velocity rep3 not degraded (6% under avg)", vt.add(3, 0.55).degraded === false);
check("velocity rep4 degraded (30% under avg)", vt.add(4, 0.4).degraded === true);
// Reps 1-2 never trigger, even on a huge drop.
const vt2 = new VelocityTracker(SQUAT);
vt2.add(1, 0.9);
check("velocity rep2 never triggers (warm-up)", vt2.add(2, 0.1).degraded === false);
// Rolling-average duration context is tracked.
const vt3 = new VelocityTracker(SQUAT);
vt3.add(1, 0.6, { concentricSec: 0.4, eccentricSec: 0.5 });
const s2 = vt3.add(2, 0.6, { concentricSec: 0.6, eccentricSec: 0.7 });
check("rolling concentric duration tracked", Math.abs((s2.rollingConcentricSec ?? 0) - 0.4) < 1e-9);
check("front velocity flagged noisy", new VelocityTracker(SQUAT, "front").add(1, 0.5).noisy === true);
check("side velocity not noisy", new VelocityTracker(SQUAT, "side").add(1, 0.5).noisy === false);

// --- Orientation classification -------------------------------------------
function lm(x: number, y: number, vis: number, z = 0): Landmark {
  return { x, y, z, visibility: vis };
}
function body(ls: [number, number], rs: [number, number], legsVisible = true, zL = 0, zR = 0): Landmark[] {
  const a = Array.from({ length: 33 }, () => lm(0, 0, 0));
  a[11] = lm(ls[0], ls[1], 0.9, zL);
  a[12] = lm(rs[0], rs[1], 0.9, zR);
  a[23] = lm(0.45, 0.6, 0.9);
  a[24] = lm(0.55, 0.6, 0.9);
  const lv = legsVisible ? 0.9 : 0.2;
  a[25] = lm(0.44, 0.75, lv); a[26] = lm(0.56, 0.75, lv);
  a[27] = lm(0.45, 0.9, lv); a[28] = lm(0.55, 0.9, lv);
  return a;
}
// The synthetic coordinates below are normalized coordinates on the 1280×720 camera every
// recorded session used, so they are read with its aspect (see the aspect-space section below).
const CAL_ASPECT = 1280 / 720;
check("orientation: wide shoulders -> front", estimateOrientation(body([0.35, 0.3], [0.65, 0.3]), 0.6, CAL_ASPECT).orientation === "front");
check("orientation: stacked shoulders -> side", estimateOrientation(body([0.49, 0.3], [0.51, 0.3], false), 0.6, CAL_ASPECT).orientation === "side");
check("orientation: half-turn -> ambiguous", estimateOrientation(body([0.46, 0.3], [0.54, 0.3]), 0.6, CAL_ASPECT).orientation === "ambiguous");
check("orientation: standing front (low score) -> front", estimateOrientation(body([0.44, 0.3], [0.56, 0.3]), 0.6, CAL_ASPECT).orientation === "front");
check("classify 90 = front", classify(90) === "front");
check("classify 0 = side", classify(0) === "side");
check("classify 45 = ambiguous", classify(45) === "ambiguous");
check("classify front edge 75", classify(75) === "front");
check("classify side edge 15", classify(15) === "side");
check("side distance mirrors at 168", distanceFromOrientation(168, "side") === 12);

// --- Orientation gating of the metric set ---------------------------------
const sideFrame = sf({ t: 0, kneeAngle: 80, hipMid: [0.5, 0.62], kneeMid: [0.5, 0.6], torsoLean: 20 });
const sideEval = evaluateRep({ frame: sideFrame, orientation: "side", facingAngleDeg: 0, velocity: VEL(false), cfg: SQUAT });
check("side: depth checked", sideEval.depth.status === "ok");
check("side: forward lean checked", sideEval.forwardLean.status === "ok");
check("side: velocity checked", sideEval.velocity.status === "ok");
check("side: knee valgus NOT checked", sideEval.kneeValgus.status === "not-checked");
check("repCount always ok", sideEval.repCount.status === "ok");
check("barPath always unavailable", sideEval.barPath.status === "unavailable");

const frontFrame = sf({
  t: 0, kneeAngle: 80, hipMid: [0.5, 0.6], kneeMid: [0.5, 0.6], ankleMid: [0.5, 0.9],
  kneeWidth: 0.19, ankleWidth: 0.2, bothLegsVisible: true,
  leftShoulder: [0.4, 0.3], rightShoulder: [0.6, 0.3], leftHip: [0.45, 0.6], rightHip: [0.55, 0.6], levelnessDiffDeg: 0,
});
const frontEval = evaluateRep({ frame: frontFrame, orientation: "front", facingAngleDeg: 90, velocity: VEL(false), cfg: SQUAT });
check("front: knee valgus checked", frontEval.kneeValgus.status === "ok");
check("front: levelness checked", frontEval.shoulderHipLevelness.status === "ok");
check("front: depth NOT checked", frontEval.depth.status === "not-checked");
check("front: forward lean NOT checked", frontEval.forwardLean.status === "not-checked");
// Velocity is agnostic now — tracked (not "not-checked") in the FRONT view too.
check("front: velocity tracked (agnostic)", frontEval.velocity.status === "ok");
check("front: velocity not gated out", frontEval.velocity.status !== "not-checked");

// Side occlusion (near side only): depth + lean must still resolve.
const occluded = Array.from({ length: 33 }, () => lm(0, 0, 0.2));
occluded[11] = lm(0.5, 0.30, 0.9);
occluded[23] = lm(0.5, 0.62, 0.9);
occluded[25] = lm(0.52, 0.60, 0.9);
occluded[27] = lm(0.5, 0.90, 0.9);
const occFrame = computeSquatFrame(occluded, 0.6, 0, CAL_ASPECT);
check("side occlusion: hipMid falls back to near side", occFrame.hipMid !== null);
const occEval = evaluateRep({ frame: occFrame, orientation: "side", facingAngleDeg: 0, velocity: VEL(false), cfg: SQUAT });
check("side occlusion: depth resolves (not 'can't see')", occEval.depth.status === "ok");
check("side occlusion: forward lean resolves", occEval.forwardLean.status !== "unknown");

// --- Depth target presets (spec task 2) -----------------------------------
// One rep, hip 0.05 ABOVE the knee (gap = −0.05), judged under each preset.
const shallowDepth = sf({ t: 0, kneeAngle: 100, hipMid: [0.5, 0.6], kneeMid: [0.5, 0.65], torsoLean: 20 });
const depthAt = (preset: "full" | "parallel" | "above") =>
  evaluateRep({ frame: shallowDepth, orientation: "side", facingAngleDeg: 0, velocity: VEL(false), cfg: SQUAT, depthPreset: preset }).depth;
check("depth preset above: shallow rep is OK", depthAt("above").status === "ok");
check("depth preset parallel: same rep WARNS", depthAt("parallel").status === "warn");
check("depth preset parallel: warning (not yet critical)", depthAt("parallel").severity === "warning");
check("depth preset full: same rep is CRITICAL", depthAt("full").severity === "critical");
// Default preset (no depthPreset) is PARALLEL.
check("depth default = parallel", evaluateRep({ frame: shallowDepth, orientation: "side", facingAngleDeg: 0, velocity: VEL(false), cfg: SQUAT }).depth.status === "warn");

// --- Counting policy: depth gap gates SIDE counting, depthRatio gates FRONT ----
// repCounts(orientation, bottomGap, targetGap, bottomDepthRatio, frontRatioTarget)
check("count side: deep rep (hip below knee) counts", repCounts("side", 0.02, 0.0, 0.5, 0.18) === true);
check("count side: shallow rep doesn't count", repCounts("side", -0.05, 0.0, 0.5, 0.18) === false);
check("count side: occlusion (null gap) still counts", repCounts("side", null, 0.0, 0.5, 0.18) === true);
check("count side: full-depth target needs hip past knee", repCounts("side", 0.02, 0.05, 0.5, 0.18) === false);
// Front: depthRatio vs the per-preset front target (side gap/target ignored).
check("count front: at/above target counts", repCounts("front", null, 0.0, 0.30, 0.25) === true);
check("count front: below target doesn't count", repCounts("front", null, 0.0, 0.20, 0.25) === false);
check("count front: deeper than target always counts (no upper bound)", repCounts("front", null, 0.0, 0.95, 0.33) === true);
check("count front: side gap/target ignored", repCounts("front", -0.5, 0.05, 0.40, 0.25) === true);
check("count front: null depthRatio never silently counts", repCounts("front", null, 0.0, null, 0.20) === false);
// The wired front targets: parallel is stricter than above; a mid-depth rep splits them.
const midDepth = (SQUAT.frontRatioTarget.above + SQUAT.frontRatioTarget.parallel) / 2;
check("count front: parallel target rejects a mid-depth rep that above accepts",
  repCounts("front", null, 0.0, midDepth, SQUAT.frontRatioTarget.above) === true &&
  repCounts("front", null, 0.0, midDepth, SQUAT.frontRatioTarget.parallel) === false);

// --- Severity zones (spec §1) ---------------------------------------------
check("severity: ok -> good", severityFor("depth", "ok", 0.05) === "good");
check("severity: not-checked -> good", severityFor("kneeValgus", "not-checked", null) === "good");
// depth value is shortfall vs target: −0.05 short = warning, −0.15 short (> 0.10 tol) = critical.
check("severity: just under target -> warning", severityFor("depth", "warn", -0.05) === "warning");
check("severity: well under target -> critical", severityFor("depth", "warn", -0.15) === "critical");
// valgus ratio: warn < 0.80, critical < 0.60 (raised for sensitivity).
check("severity: mild valgus -> warning", severityFor("kneeValgus", "warn", 0.7) === "warning");
check("severity: hard valgus -> critical", severityFor("kneeValgus", "warn", 0.5) === "critical");
// velocity ratio: 35%+ loss critical.
check("severity: 25% slow -> warning", severityFor("velocity", "warn", 0.75) === "warning");
check("severity: 40% slow -> critical", severityFor("velocity", "warn", 0.6) === "critical");
// End-to-end on a frame: hard valgus rep reports a critical metric.
const hardValgus = evaluateRep({
  frame: sf({ t: 0, kneeAngle: 80, hipMid: [0.5, 0.6], kneeMid: [0.5, 0.6], ankleMid: [0.5, 0.9], kneeWidth: 0.08, ankleWidth: 0.2, bothLegsVisible: true, leftShoulder: [0.4, 0.3], rightShoulder: [0.6, 0.3], leftHip: [0.45, 0.6], rightHip: [0.55, 0.6] }),
  orientation: "front", facingAngleDeg: 90, velocity: null, cfg: SQUAT,
});
check("evaluateRep tags critical valgus", criticalMetrics(hardValgus).includes("kneeValgus"));
// Knee valgus warn threshold is 0.72 (nudged down from 0.8 — fired on straight legs).
const valgusAt = (kneeWidth: number) => evaluateRep({ frame: sf({ t: 0, kneeAngle: 80, hipMid: [0.5, 0.6], kneeMid: [0.5, 0.6], ankleMid: [0.5, 0.9], kneeWidth, ankleWidth: 0.2, bothLegsVisible: true, leftShoulder: [0.4, 0.3], rightShoulder: [0.6, 0.3], leftHip: [0.45, 0.6], rightHip: [0.55, 0.6] }), orientation: "front", facingAngleDeg: 90, velocity: null, cfg: SQUAT }).kneeValgus.status;
check("valgus warns at 0.70 ratio (past the 0.72 gate)", valgusAt(0.14) === "warn");
check("valgus OK at 0.75 ratio (less sensitive — no longer warns on near-neutral)", valgusAt(0.15) === "ok");

// --- Per-rep worst-of aggregation -----------------------------------------
const frontBase = (kw: number) =>
  sf({ t: 0, kneeAngle: 165, hipMid: [0.5, 0.6], kneeMid: [0.5, 0.6], ankleMid: [0.5, 0.9], kneeWidth: kw, ankleWidth: 0.2, bothLegsVisible: true, leftShoulder: [0.4, 0.3], rightShoulder: [0.6, 0.3], leftHip: [0.45, 0.6], rightHip: [0.55, 0.6] });
const evalWarn = evaluateRep({ frame: frontBase(0.1), orientation: "front", facingAngleDeg: 90, velocity: null, cfg: SQUAT });
const evalOk = evaluateRep({ frame: frontBase(0.18), orientation: "front", facingAngleDeg: 90, velocity: null, cfg: SQUAT });
const aggWarn = aggregateRep(evalOk, [evalWarn, evalWarn, evalOk]);
check("aggregate: valgus warn recorded even if bottom frame ok", aggWarn.kneeValgus.status === "warn");
const aggNoise = aggregateRep(evalOk, [evalWarn, evalOk, evalOk, evalOk, evalOk]);
check("aggregate: single-frame blip filtered as noise", aggNoise.kneeValgus.status === "ok");
const aggCrit = aggregateRep(evalOk, [evalWarn, evaluateRep({ frame: frontBase(0.08), orientation: "front", facingAngleDeg: 90, velocity: null, cfg: SQUAT })]);
check("aggregate: escalates to critical when a warn frame is critical", aggCrit.kneeValgus.severity === "critical");

// Forward lean is now aggregated THROUGHOUT the rep (spec request).
const evalLean = (deg: number) => evaluateRep({ frame: sf({ t: 0, kneeAngle: 120, hipMid: [0.5, 0.6], kneeMid: [0.5, 0.6], torsoLean: deg }), orientation: "side", facingAngleDeg: 0, velocity: VEL(false), cfg: SQUAT });
const leanAgg = aggregateRep(evalLean(20), [evalLean(55), evalLean(55), evalLean(20)]);
check("aggregate: forward lean warn recorded mid-rep (bottom ok)", leanAgg.forwardLean.status === "warn");
check("warnedMetrics lists the aggregated lean warn", warnedMetrics(leanAgg).includes("forwardLean"));

// The aggregated value must be the PEAK of the warn frames, not whichever came last.
// Regression (2026-07-27 set 1): the old `>=` reduce returned the final frame in the top
// severity band, so reps measuring 43.8°/69.8° (normalized-space degrees) reported a
// peak_severity_ratio of 50.7 while the archived photo showed the worst rep. Values below sit
// in the SAME band (warn >51, critical >=65 real degrees) so the test distinguishes "most
// extreme" from "last seen".
const leanPeak = aggregateRep(evalLean(20), [evalLean(55), evalLean(62), evalLean(53)]);
check("aggregate: lean peak is the MAX warn frame, not the last", leanPeak.forwardLean.value === 62);
// Valgus runs the other way (lower ratio = more caved) — the peak must be the MINIMUM.
// 0.50 and 0.60 are both critical; the old reduce kept 0.60 (last), the fix keeps 0.50.
const valgusEval = (kw: number) => evaluateRep({ frame: frontBase(kw), orientation: "front", facingAngleDeg: 90, velocity: null, cfg: SQUAT });
const valgusPeak = aggregateRep(evalOk, [valgusEval(0.1), valgusEval(0.13), valgusEval(0.12)]);
check("aggregate: valgus peak is the MIN warn frame (inverse direction)", valgusPeak.kneeValgus.value === 0.5);

// --- AI trigger coordinator (v2 requestTrigger API; dedup / supersede) -----
const ctx = (rep: number) => ({ setIndex: 1, repIndex: rep, orientation: "front" as const });

// A mid-set trigger fires once, after the dedup window.
const c1 = new CoachingCoordinator(0.5);
check("trigger: no immediate flush on first request", c1.requestTrigger(ctx(1), "kneeValgus", 0) === null);
check("trigger: not due before window", c1.flushDue(0.4) === null);
const b1 = c1.flushDue(0.5);
check("trigger: fires after window with the fault", !!b1 && b1.faultChecks.includes("kneeValgus") && b1.triggers.includes("fault_spike"));

// Dedup: two same-rep triggers within the window merge into ONE batch.
const c2 = new CoachingCoordinator(0.5);
check("dedup: first request pends", c2.requestTrigger(ctx(1), "forwardLean", 0) === null);
check("dedup: same-rep second request doesn't flush early", c2.requestTrigger(ctx(1), "eccentricControl", 0.2) === null);
const combined = c2.flushDue(0.5);
check("dedup: one batch carries both faults", !!combined && combined.faultChecks.includes("forwardLean") && combined.faultChecks.includes("eccentricControl"));

// A different rep supersedes the pending batch (immediate flush of the old one).
const c3 = new CoachingCoordinator(0.5);
c3.requestTrigger(ctx(1), "forwardLean", 0);
const superseded = c3.requestTrigger(ctx(2), "kneeValgus", 0.1);
check("supersede: new-rep trigger flushes the old rep's batch", !!superseded && superseded.repIndex === 1);

// T6 velocity collapse is CONTEXT ONLY — attaching never enqueues or fires a cue.
const c4 = new CoachingCoordinator(0.5);
c4.attachVelocity({ rollingAverage: 0.5, current: 0.2, pctSlower: 0.6, collapsed: true });
check("velocity: context-only attach never fires a cue", c4.flushDue(0.6) === null);

// Depth is still GRADED (severity) — it just never calls requestTrigger.
const depthCrit = evaluateRep({
  frame: sf({ t: 0, kneeAngle: 90, hipMid: [0.5, 0.4], kneeMid: [0.5, 0.62], torsoLean: 20 }),
  orientation: "side", facingAngleDeg: 0, velocity: VEL(false), cfg: SQUAT,
});
check("depth still graded critical (gap −0.22)", depthCrit.depth.severity === "critical");

// --- v2 dynamics: baseline / persistence / eccentric -----------------------
const bl = new BaselineTracker(2);
check("baseline: null before warm-up", bl.baseline() === null);
bl.record(10); bl.record(20);
check("baseline: mean of reps 1–2", bl.baseline() === 15);
bl.record(100); // ignored after warm-up
check("baseline: later reps don't shift it", bl.baseline() === 15);

const pg = new PersistenceGate(150);
check("persist: not at t=0", pg.update(true, 0) === false);
check("persist: not at 100ms", pg.update(true, 100) === false);
check("persist: fires at 150ms held", pg.update(true, 150) === true);
check("persist: inactive frame resets", pg.update(false, 160) === false);
check("persist: re-arm needs full hold again", pg.update(true, 200) === false);

const ec = new EccentricTracker();
([[0, 0.4], [50, 0.5], [100, 0.6], [150, 0.55], [200, 0.45]] as Array<[number, number]>).forEach(([t, y]) => ec.add(t, y));
check("eccentric: descent speed positive", (ec.descentSpeed() ?? 0) > 0);
check("eccentric: reversal time detected", ec.reversalMs() !== null);

// evalEccentric: descent spike (≥2.0×) and/or bounce (≤300ms, depth-gated).
check("eccentric verdict: controlled = ok", evalEccentric(1.0, 1.0, 400, true).status === "ok");
check("eccentric verdict: descent spike warns", evalEccentric(2.5, 1.0, 400, true).status === "warn");
check("eccentric verdict: bottom bounce warns", evalEccentric(1.0, 1.0, 80, true).status === "warn");
check("eccentric verdict: spike + bounce = critical", severityFor("eccentricControl", "warn", evalEccentric(2.5, 1.0, 80, true).value) === "critical");
// Bounce is meaningless on a rep that never reached a bottom. Measured 2026-07-31: the ONLY
// sub-300ms reversal in 30 reps was a deliberate quarter squat (268.7ms).
check("eccentric: bounce suppressed when depth not reached", evalEccentric(1.0, 1.0, 268.7, false).status === "ok");
check("eccentric: bounce counts when depth reached", evalEccentric(1.0, 1.0, 268.7, true).status === "warn");
// Descent spike is NOT depth-gated — dropping fast is a fault at any depth.
check("eccentric: spike still fires on a shallow rep", evalEccentric(2.5, 1.0, 900, false).status === "warn");
// Real 2026-07-31 numbers: the genuine fast drop must fire, the two set-3 false positives must not.
check("eccentric: real fast drop fires (0.59 vs 0.156 baseline)", evalEccentric(0.59, 0.156, 1122, true).status === "warn");
check("eccentric: set-3 false positive now silent (0.39 vs 0.228)", evalEccentric(0.39, 0.228, 935, true).status === "ok");
check("eccentric: set-3 false positive now silent (0.35 vs 0.228)", evalEccentric(0.35, 0.228, 896, true).status === "ok");

// T1 lean trigger: baseline + 12° (real degrees) past depth gate 0.3 (widened from 0.5 — faults
// are performed throughout the rep, and normal reps measured only 32.8–37.7° real in the shallow
// phase). Real-run numbers below are the 2026-07-31 values converted to aspect space.
check("lean trigger: fires baseline+12° when deep", leanTriggerActive(32, 20, 0.6) === true);
check("lean trigger: fires in the shallow phase past the widened gate", leanTriggerActive(57.9, 38.9, 0.35) === true);
check("lean trigger: silent before depth gate", leanTriggerActive(32, 20, 0.2) === false);
check("lean trigger: real normal rep stays silent at the gate", leanTriggerActive(37.7, 38.9, 0.35) === false);
check("lean trigger: silent under the delta", leanTriggerActive(20 + TRIGGERS.lean.baselineDeltaDeg - 1, 20, 0.6) === false);
check("lean trigger: silent during warm-up (null baseline)", leanTriggerActive(40, null, 0.6) === false);

// T7 valgus trigger: below warn past depth gate 0.15 (widened from 0.3 — the measured cave was
// WORST during the ascent, and at 0.3 only ~77ms qualified against a 150ms persistence window).
check("valgus trigger: fires below warn when deep", valgusTriggerActive(0.7, 0.5, SQUAT) === true);
check("valgus trigger: fires at the old gate boundary (0.59 @ 0.30)", valgusTriggerActive(0.59, 0.30, SQUAT) === true);
check("valgus trigger: fires late in the ascent (0.52 @ 0.15)", valgusTriggerActive(0.52, 0.15, SQUAT) === true);
check("valgus trigger: silent before the widened depth gate", valgusTriggerActive(0.7, 0.1, SQUAT) === false);
// False-positive guard from the real run: the big-hip-shift rep bottomed at 0.867 @ depth 0.19.
check("valgus trigger: real hip-shift rep does NOT read as cave", valgusTriggerActive(0.867, 0.19, SQUAT) === false);
check("valgus trigger: real normal rep does NOT read as cave", valgusTriggerActive(0.996, 0.19, SQUAT) === false);

// T10 knee symmetry + T11 lateral hip shift (front).
const symEven = sf({ t: 0, kneeAngle: 120, leftKnee: [0.42, 0.6], rightKnee: [0.58, 0.6], leftAnkle: [0.42, 0.9], rightAnkle: [0.58, 0.9], hipWidth: 0.1, hipMid: [0.5, 0.6], ankleMid: [0.5, 0.9] });
check("symmetry: even knees ok", evaluateRep({ frame: symEven, orientation: "front", facingAngleDeg: 90, velocity: null, cfg: SQUAT }).kneeSymmetry.status === "ok");
const symOff = sf({ t: 0, kneeAngle: 120, leftKnee: [0.50, 0.6], rightKnee: [0.58, 0.6], leftAnkle: [0.42, 0.9], rightAnkle: [0.58, 0.9], hipWidth: 0.1, hipMid: [0.5, 0.6], ankleMid: [0.5, 0.9] });
check("symmetry: one knee compensating warns", evaluateRep({ frame: symOff, orientation: "front", facingAngleDeg: 90, velocity: null, cfg: SQUAT }).kneeSymmetry.status === "warn");
const shiftOff = sf({ t: 0, kneeAngle: 120, hipMid: [0.56, 0.6], ankleMid: [0.5, 0.9], hipWidth: 0.1, leftKnee: [0.42, 0.6], rightKnee: [0.58, 0.6], leftAnkle: [0.42, 0.9], rightAnkle: [0.58, 0.9] });
check("hip shift: hips off-center warn", evaluateRep({ frame: shiftOff, orientation: "front", facingAngleDeg: 90, velocity: null, cfg: SQUAT }).hipShift.status === "warn");

// --- Physical-plausibility gate (Tier 1): impossible values → "unknown", never a fault ---
const evalFront = (frame: SquatFrame) => evaluateRep({ frame, orientation: "front", facingAngleDeg: 90, velocity: null, cfg: SQUAT });
// valgus 0.07 (knees collapsed to a point, ankleWidth 0.2) is a landmark failure, not a cave.
const valgusGarbage = sf({ t: 0, kneeAngle: 80, kneeWidth: 0.014, ankleWidth: 0.2, bothLegsVisible: true, leftKnee: [0.49, 0.6], rightKnee: [0.51, 0.6], leftAnkle: [0.4, 0.9], rightAnkle: [0.6, 0.9], hipWidth: 0.1, hipMid: [0.5, 0.6], ankleMid: [0.5, 0.9], leftShoulder: [0.4, 0.3], rightShoulder: [0.6, 0.3], leftHip: [0.45, 0.6], rightHip: [0.55, 0.6] });
check("plausibility: valgus 0.07 → unknown (landmark error), not warn", evalFront(valgusGarbage).kneeValgus.status === "unknown");
check("plausibility: real severe cave 0.4 still warns", valgusAt(0.08) === "warn"); // 0.08/0.2 = 0.4 > floor
check("plausibility: T7 silent on impossible valgus 0.07", valgusTriggerActive(0.07, 0.5, SQUAT) === false);
check("plausibility: T7 silent on impossible valgus 5.0", valgusTriggerActive(5.0, 0.5, SQUAT) === false);
// hip drift 2.3 (hip center 2.3 hip-widths off the ankle center) → unknown.
const shiftGarbage = sf({ t: 0, kneeAngle: 120, hipMid: [0.73, 0.6], ankleMid: [0.5, 0.9], hipWidth: 0.1, leftKnee: [0.42, 0.6], rightKnee: [0.58, 0.6], leftAnkle: [0.42, 0.9], rightAnkle: [0.58, 0.9] });
check("plausibility: hip drift 2.3 → unknown", evalFront(shiftGarbage).hipShift.status === "unknown");
// landmarkImplausible drives the Tier-2 whole-rep flag. FRONT-ONLY: every arm reads frontal
// geometry, which is degenerate edge-on.
check("plausibility: landmarkImplausible true on garbage drift", landmarkImplausible(shiftGarbage, "front") === true);
check("plausibility: landmarkImplausible true on garbage valgus", landmarkImplausible(valgusGarbage, "front") === true);
check("plausibility: landmarkImplausible false on a clean rep", landmarkImplausible(symEven, "front") === false);
// Regression for the 2026-07-31 finding: 18/18 side reps were flagged unreliable (0/12 front),
// which emptied `reliableReps` and silently nulled velocity_collapse_ratio on every side set.
// Mechanism: edge-on the hips stack, so hipWidth collapses (~0.007 measured) and becomes a tiny
// DENOMINATOR — the hipShift arm tripped on ~100% of side frames. Reproduced with real values:
// a 0.0235 hip-vs-ankle offset over a 0.007 hip width reads 3.36 against a bound of 1.5.
const sideStacked = sf({
  t: 0, kneeAngle: 90,
  hipMid: [0.5035, 0.60], ankleMid: [0.48, 0.90], kneeMid: [0.5, 0.62], hipWidth: 0.007,
});
check("plausibility: side view is NOT flagged on stacked hips", landmarkImplausible(sideStacked, "side") === false);
check("plausibility: the same frame WOULD be flagged front-on", landmarkImplausible(sideStacked, "front") === true);

// --- hipShift is judged across the rep, but only where its geometry is physical -----------
// It was bottom-frame only, so a shift performed on the way UP was invisible. Its shallow
// readings are NOT physical though (measured peak 1.44 hip-widths at depth 0.19), so the
// per-frame check gates itself out below TRIGGERS.lateralShift.depthGate.
check("hipShift: aggregated across the rep", AGGREGATED_METRICS.includes("hipShift"));
const shiftFrameAt = (depthRatio?: number) =>
  evaluateRep({ frame: shiftOff, orientation: "front", facingAngleDeg: 90, velocity: null, cfg: SQUAT, depthRatio }).hipShift;
check("hipShift: judged at depth", shiftFrameAt(0.5).status === "warn");
check("hipShift: not judged near lockout", shiftFrameAt(0.1).status === "unknown");
check("hipShift: bottom-frame eval (no depthRatio) is always judged", shiftFrameAt().status === "warn");
// "unknown" keeps gated frames out of BOTH the warn count and the denominator in aggregateRep.
const shiftWarn = evaluateRep({ frame: shiftOff, orientation: "front", facingAngleDeg: 90, velocity: null, cfg: SQUAT, depthRatio: 0.5 });
const shiftGated = evaluateRep({ frame: shiftOff, orientation: "front", facingAngleDeg: 90, velocity: null, cfg: SQUAT, depthRatio: 0.1 });
const shiftClean = evaluateRep({ frame: symEven, orientation: "front", facingAngleDeg: 90, velocity: null, cfg: SQUAT, depthRatio: 0.5 });
check(
  "hipShift: mid-rep warn survives aggregation",
  aggregateRep(shiftClean, [shiftWarn, shiftWarn, shiftClean]).hipShift.status === "warn",
);
check(
  "hipShift: near-lockout frames can't create a warn",
  aggregateRep(shiftClean, [shiftGated, shiftGated, shiftClean]).hipShift.status !== "warn",
);

// --- Baseline hygiene gate: only reps that reached a real bottom may calibrate baselines ---
const MINREL = SQUAT.baselineMinDepthRel;
check("baseline gate: genuine parallel rep (rel 0.08) feeds", repFeedsBaseline(0.08, 0.0, MINREL) === true);
check("baseline gate: settling rep (rel ~0.005) excluded", repFeedsBaseline(0.007, 0.0, MINREL) === false);
check("baseline gate: cut-short rep (rel < 0) excluded", repFeedsBaseline(-0.12, 0.0, MINREL) === false);
// Preset-relative: an above-parallel genuine rep (gap −0.05, target −0.1 → rel 0.05) still feeds,
// where an absolute-gap floor of 0.03 would have wrongly starved it.
check("baseline gate: above-parallel genuine rep feeds (preset-relative)", repFeedsBaseline(-0.05, -0.1, MINREL) === true);
check("baseline gate: null gap (occlusion) allowed to feed", repFeedsBaseline(null, 0.0, MINREL) === true);

// --- Baseline WINDOW: samples may only come from the warm-up reps ----------------------------
// Regression for the 2026-08-02 set-3 divergence. The tracker itself only caps the sample COUNT,
// so the caller (useWorkout.onRepComplete) must also gate on rep index. Replay set 3 exactly:
// rep 1 failed the hygiene gate, rep 2 passed, reps 3-5 failed, rep 6 passed. Without the window
// gate rep 6 became sample #2 and the baseline resolved on the LAST rep of the set — after every
// trigger had already been evaluated against null.
{
  const S3_GAPS = [-0.001, 0.04, 0.025, 0.023, -0.006, 0.059]; // measured, set 3
  const S3_LEANS = [28.3, 27.5, 27.5, 26.9, 59.3, 26.2];
  const windowed = new BaselineTracker(TRIGGERS.baselineReps);
  const unwindowed = new BaselineTracker(TRIGGERS.baselineReps);
  S3_GAPS.forEach((gap, i) => {
    const repIndex = i + 1; // rep.index is 1-based (repCounter increments before emitting)
    if (!repFeedsBaseline(gap, 0.0, MINREL)) return;
    unwindowed.record(S3_LEANS[i]!); // the old behaviour
    if (repIndex <= TRIGGERS.baselineReps) windowed.record(S3_LEANS[i]!);
  });
  check("baseline window: set-3 replay leaves the baseline unresolved", windowed.ready() === false);
  check("baseline window: set-3 replay reports no lean baseline", windowed.baseline() === null);
  // Prove the bug is real and this test would catch its return: ungated, rep 6 completes it.
  check("baseline window: WITHOUT the gate rep 6 wrongly completes it", unwindowed.ready() === true);
  // …and must NOT break a normal set. Set 1's reps 1-2 (gaps 0.074/0.057, leans 26.0/24.7) still
  // resolve to the 25.32° baseline the triggers actually used that set.
  const s1 = new BaselineTracker(TRIGGERS.baselineReps);
  [
    [0.074, 26.0],
    [0.057, 24.7],
  ].forEach(([gap, lean], i) => {
    if (repFeedsBaseline(gap!, 0.0, MINREL) && i + 1 <= TRIGGERS.baselineReps) s1.record(lean!);
  });
  check("baseline window: a clean warm-up still resolves", s1.ready() === true);
  check("baseline window: set-1 baseline is 25.35°", Math.abs((s1.baseline() ?? 0) - 25.35) < 0.01);
}

// --- Plain-language bands (presentation honesty, not detection) -------------------------------
// Real values from the 2026-08-02 run. Side misses were a hair; the quarter squat was not.
check("depth band: side miss -0.0023 vs target 0 is marginal", depthShortfallBand(-0.0023, 0, "hip_knee_gap") === "marginal");
check("depth band: side miss -0.0060 vs target 0 is marginal", depthShortfallBand(-0.006, 0, "hip_knee_gap") === "marginal");
check("depth band: quarter squat 0.395 vs 0.60 is large", depthShortfallBand(0.395, 0.6, "depth_ratio") === "large");
check("depth band: a rep that MADE depth has no band", depthShortfallBand(0.04, 0, "hip_knee_gap") === null);
check("depth band: null measurement has no band", depthShortfallBand(null, 0, "hip_knee_gap") === null);
// The two bases are not interchangeable — the same shortfall reads differently by design.
check("depth band: 0.05 short is moderate on gap, marginal on ratio",
  depthShortfallBand(-0.05, 0, "hip_knee_gap") === "moderate" && depthShortfallBand(0.55, 0.6, "depth_ratio") === "marginal");
// Velocity: the three real per-rep ratios must land in DISTINCT bands, else the band adds nothing.
check("velocity band: 1.18 (faster) is none", velocityBand(1.18) === "none");
check("velocity band: 0.80 is slight", velocityBand(0.8) === "slight");
check("velocity band: 0.66 is moderate", velocityBand(0.66) === "moderate");
check("velocity band: 0.55 (past T6 collapse) is marked", velocityBand(0.55) === "marked");
check("velocity band: exactly 1.0 is none, never 'slight'", velocityBand(1.0) === "none");
check("velocity band: null ratio has no band", velocityBand(null) === null);

// Velocity collapse flag (T6 context): < 60% of rolling baseline.
const vc = new VelocityTracker(SQUAT);
vc.add(1, 1.0); vc.add(2, 1.0);
check("velocity collapse: >60% not collapsed", vc.add(3, 0.7).collapsed === false);
check("velocity collapse: <60% flagged", vc.add(4, 0.5).collapsed === true);

// --- Per-check tolerance EDGES (synthetic) --------------------------------
const edge12 = evaluateRep({ frame: sideFrame, orientation: "side", facingAngleDeg: 12, velocity: VEL(false), cfg: SQUAT });
check("edge: depth unknown at 12° (tol 10°)", edge12.depth.status === "unknown");
check("edge: forward lean still checked at 12° (tol 15°)", edge12.forwardLean.status === "ok");
check("edge: velocity still checked at 12° (agnostic, no angle gate)", edge12.velocity.status === "ok");
const edge8 = evaluateRep({ frame: sideFrame, orientation: "side", facingAngleDeg: 8, velocity: VEL(false), cfg: SQUAT });
check("edge: depth checked at 8° (within tol 10°)", edge8.depth.status === "ok");

// --- Gemini dual frame buffer (spec Part 2) --------------------------------
const lb2 = new LandmarkBuffer(1000);
lb2.add({ timestampMs: 0, landmarks: {}, depthRatio: 0, repPhase: "standing", repNumber: 0, setNumber: 1 });
lb2.add({ timestampMs: 500, landmarks: {}, depthRatio: 0.2, repPhase: "descent", repNumber: 1, setNumber: 1 });
lb2.add({ timestampMs: 1200, landmarks: {}, depthRatio: 0.1, repPhase: "ascent", repNumber: 1, setNumber: 1 });
check("landmark buffer: evicts outside window (t=0 dropped)", lb2.getWindow(0, 2000).length === 2);
check("landmark buffer: getLatest is newest", lb2.getLatest()?.timestampMs === 1200);
check("landmark buffer: getWindow slices by time", lb2.getWindow(500, 1200).length === 2);

const ib = new ImageBuffer(3);
ib.add("a", 0, 1, "descent");
ib.add("b", 250, 1, "bottom");
ib.add("c", 500, 1, "ascent");
ib.add("d", 750, 2, "descent"); // evicts "a" (ring cap 3)
check("image buffer: ring cap drops oldest", ib.getAll().length === 3 && ib.getAll()[0].jpegBase64 === "b");
check("image buffer: getFramesAround windows correctly", ib.getFramesAround(500, 300, 100).length === 2);
ib.tagFrames(500, "knee_valgus", 0.7, 300);
check("image buffer: tagFrames tags nearby frames", ib.getAll().some((f) => f.triggerTags.some((t) => t.triggerType === "knee_valgus")));

// --- Gemini frame geometry: keep the camera's shape, crop to the body -------
// The sent JPEG used to be the full frame squashed into a fixed 640×480 — 25% narrower on a
// 1280×720 feed, far worse on a portrait phone — so Gemini judged angles off bent bodies.
{
  const aspectErr = (w: number, h: number, o: { width: number; height: number }) => Math.abs(o.width / o.height / (w / h) - 1);
  check("frame fit: no fixed output height left in config (shape comes from the source)", !("height" in GEMINI.image) && !("width" in GEMINI.image));
  const land = fitWithin(1280, 720, 640);
  check("frame fit: 1280×720 → 640×360", land.width === 640 && land.height === 360);
  const port = fitWithin(720, 1280, 640);
  check("frame fit: portrait 720×1280 → 360×640", port.width === 360 && port.height === 640);
  const small = fitWithin(300, 500, 640);
  check("frame fit: a crop smaller than the cap is never upscaled", small.width === 300 && small.height === 500);
  check("frame fit: an odd crop keeps its shape within 1%", aspectErr(347, 611, fitWithin(347, 611, 640)) < 0.01 && aspectErr(1111, 233, fitWithin(1111, 233, 640)) < 0.01);

  // A standing body as 33 points: x 0.44–0.56, y 0.10–0.90, all visible, plus one joint MediaPipe
  // placed at the corner with low visibility (a hidden limb) that must not widen the box.
  const body: CropPoint[] = Array.from({ length: 33 }, (_, i) => ({ x: 0.44 + 0.12 * ((i * 7) % 33) / 32, y: 0.1 + 0.8 * (i / 32), visibility: 0.9 }));
  body[5] = { x: 0.02, y: 0.02, visibility: 0.1 };
  const opts = GEMINI.image.crop;
  const visible = body.filter((p) => (p.visibility ?? 0) >= opts.minVisibility);
  for (const [W, H] of [[1280, 720], [720, 1280]] as const) {
    const r = bodyCropRect(body, W, H, opts);
    const tag = `${W}×${H}`;
    check(`body crop ${tag}: returns a crop`, r !== null);
    if (!r) continue;
    const xs = visible.map((p) => p.x * W);
    const ys = visible.map((p) => p.y * H);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    check(`body crop ${tag}: contains every visible landmark`, r.x <= minX && r.y <= minY && r.x + r.w >= maxX && r.y + r.h >= maxY);
    check(`body crop ${tag}: stays inside the frame`, r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H);
    check(`body crop ${tag}: the hidden corner joint does not widen the box`,
      JSON.stringify(r) === JSON.stringify(bodyCropRect(body.filter((_, i) => i !== 5), W, H, opts)));
    // Unclamped sides get the same margin in PIXELS on x and y (a normalized margin would be 16:9-uneven).
    const pad = opts.padFrac * Math.max(maxX - minX, maxY - minY);
    const padL = minX - r.x;
    const padR = r.x + r.w - maxX;
    check(`body crop ${tag}: left/right margin = padFrac × longer side (±1 px)`, Math.abs(padL - pad) <= 1 && Math.abs(padR - pad) <= 1);
    if (r.y > 0) check(`body crop ${tag}: top margin equals the side margin in pixels (±1 px)`, Math.abs(minY - r.y - padL) <= 1);
    check(`body crop ${tag}: the encoded crop keeps its shape within 1%`, aspectErr(r.w, r.h, fitWithin(r.w, r.h, GEMINI.image.maxEdgePx)) < 0.01);
    check(`body crop ${tag}: smaller than the full frame (background cut)`, r.w * r.h < W * H);
  }
  // A horizontal (push-up) body: nothing clamps, so the x and y margins must match in pixels.
  const plank: CropPoint[] = Array.from({ length: 33 }, (_, i) => ({ x: 0.2 + 0.6 * (i / 32), y: 0.5 + 0.1 * ((i * 5) % 33) / 32, visibility: 0.9 }));
  const rp = bodyCropRect(plank, 1280, 720, opts);
  const pxs = plank.map((p) => p.x * 1280);
  const pys = plank.map((p) => p.y * 720);
  check("body crop: push-up body, top margin = left margin in pixels (±1 px)",
    rp !== null && rp.y > 0 && Math.abs((Math.min(...pys) - rp.y) - (Math.min(...pxs) - rp.x)) <= 1);
  // A body at the right edge is clamped, never pushed past the frame.
  const edge = body.map((p) => ({ ...p, x: Math.min(1, p.x + 0.43) }));
  const re = bodyCropRect(edge, 1280, 720, opts);
  check("body crop: a body at the frame edge clamps to the edge", re !== null && re.x + re.w === 1280);
  check("body crop: too few visible landmarks → null (send the full frame)",
    bodyCropRect(body.map((p, i) => ({ ...p, visibility: i < opts.minPoints - 1 ? 0.9 : 0.1 })), 1280, 720, opts) === null);
  check("body crop: no landmarks → null", bodyCropRect(null, 1280, 720, opts) === null && bodyCropRect([], 1280, 720, opts) === null);
}

// --- Dev eval-log trigger table (descriptive audit of fired/not-fired) -----
function stubMetrics(over: Partial<Record<string, "ok" | "warn">> = {}): RepMetrics {
  const m = {} as RepMetrics;
  for (const id of METRIC_ORDER) m[id] = { metric: id, status: over[id] ?? "ok", severity: "good", message: "", value: null };
  return m;
}
function repInputs(over: Partial<RepEvalInputs>): RepEvalInputs {
  return {
    set: 1, rep: 5, view: "side", counted: true,
    phase: { descentStartMs: 0, bottomMs: 0, ascentEndMs: 0, eccentricMs: 0, concentricMs: 0 },
    peakTrunkAngleDeg: null, bottomTrunkAngleDeg: null, leanBaselineDeg: null,
    descentSpeed: null, descentBaseline: null, reversalMs: null,
    ascentVelocity: null, velocityRatio: null, velocityCollapsed: false,
    depthRatio: 0.5, depthGap: null, targetGap: 0.0, frontRatioTarget: 0.33,
    valgusRatio: null, leftKneeDev: null, rightKneeDev: null,
    kneeSymmetry: null, hipShift: null, levelnessDiff: null,
    shinAngleDeg: null, stanceWidthRatio: null, footAngleDeg: null,
    earlyLeanOnset: false, leanConcentratedDeep: false,
    firedMidSet: [], eccentricFired: false, eccentricSubCount: null, mode: "bodyweight",
    shiftTriggered: false, shiftBaseline: null,
    minVisibility: null, trackingDegraded: false, landmarkUnreliable: false, fedBaseline: true, visBaseline: null, metrics: stubMetrics(),
    landmarks: [], frames: [],
    ...over,
  };
}
const find = (t: ReturnType<typeof buildTriggerTable>, id: string) => t.find((e) => e.id === id)!;

// T1 forward lean fires when peak deep-lean exceeds baseline + delta and it actually fired.
const t1Fire = find(buildTriggerTable(repInputs({ view: "side", peakTrunkAngleDeg: 45, leanBaselineDeg: 30, firedMidSet: ["forwardLean"] }), true), "T1_forward_lean");
check("evallog T1: eligible + fired, threshold = baseline+delta", t1Fire.eligible && t1Fire.fired && t1Fire.threshold === 30 + TRIGGERS.lean.baselineDeltaDeg);
// Non-firing but close → logged as an explicit near-miss (false negatives stay visible).
const t1Near = find(buildTriggerTable(repInputs({ view: "side", peakTrunkAngleDeg: 37, leanBaselineDeg: 30, firedMidSet: [] }), true), "T1_forward_lean");
check("evallog T1: eligible not-fired near-miss logged", t1Near.eligible && !t1Near.fired && t1Near.near_miss);
// Warm-up (baseline) rep → no eligible triggers.
check("evallog T1: baseline rep not eligible", !find(buildTriggerTable(repInputs({ view: "side" }), false), "T1_forward_lean").eligible);
// T7 valgus (front) fires below the warn ratio.
const t7 = find(buildTriggerTable(repInputs({ view: "front", valgusRatio: 0.6, firedMidSet: ["kneeValgus"] }), true), "T7_knee_valgus");
check("evallog T7: front valgus fired, threshold = valgusRatioWarn", t7.eligible && t7.fired && t7.threshold === SQUAT.valgusRatioWarn);
// Depth gate: a side rep that didn't count is a logged miss.
check("evallog depth_gate: side non-counted = miss", find(buildTriggerTable(repInputs({ view: "side", counted: false, depthGap: -0.1 }), true), "depth_gate").fired);
// Front depth gate: a front rep that didn't count (shallow depthRatio) is a logged miss…
check("evallog front_depth_gate: front non-counted = miss", find(buildTriggerTable(repInputs({ view: "front", counted: false, depthRatio: 0.15, frontRatioTarget: 0.33 }), true), "front_depth_gate").fired);
// …and a counted front rep is not a miss; the side depth_gate stays front-ineligible.
{
  const tbl = buildTriggerTable(repInputs({ view: "front", counted: true, depthRatio: 0.4, frontRatioTarget: 0.33 }), true);
  check("evallog front_depth_gate: counted front rep not a miss, threshold = frontRatioTarget",
    find(tbl, "front_depth_gate").eligible && !find(tbl, "front_depth_gate").fired && find(tbl, "front_depth_gate").threshold === 0.33);
  check("evallog front_depth_gate: side depth_gate not eligible on front", !find(tbl, "depth_gate").eligible);
}
// Velocity collapse is CONTEXT ONLY — never marked fired, even when collapsed.
const t6 = find(buildTriggerTable(repInputs({ velocityRatio: 0.4, velocityCollapsed: true }), true), "T6_velocity_collapse");
check("evallog T6: velocity collapse is context-only (never fired)", t6.tier === "context" && !t6.fired);
// T2 eccentric: both sub-signals reported; entry.fired mirrors runtime truth.
const t2 = find(buildTriggerTable(repInputs({ descentSpeed: 2.0, descentBaseline: 1.0, reversalMs: 100, eccentricFired: true }), true), "T2_eccentric_control");
check("evallog T2: eccentric sub-signals both fire", t2.fired && !!t2.sub_signals && t2.sub_signals[0].fired && t2.sub_signals[1].fired);

// --- T11 lateral-shift baseline-relative + scored trigger predicate --------
check("shift trigger: fires above baseline+delta", shiftTriggerActive(0.04 + TRIGGERS.lateralShift.baselineDeltaRatio + 0.01, 0.04) === true);
check("shift trigger: silent within baseline+delta", shiftTriggerActive(0.04 + TRIGGERS.lateralShift.baselineDeltaRatio - 0.01, 0.04) === false);
check("shift trigger: silent on null baseline (warm-up)", shiftTriggerActive(0.3, null) === false);

// Eval-log T11 is baseline-relative + scored (mirror T1): warm-up not eligible, fired mirrors
// the runtime flag, threshold = baseline + delta.
const t11 = find(buildTriggerTable(repInputs({ view: "front", hipShift: 0.12, shiftBaseline: 0.04, shiftTriggered: true }), true), "T11_lateral_shift");
check("evallog T11: eligible + fired, threshold = baseline+delta", t11.eligible && t11.fired && Math.abs((t11.threshold ?? 0) - (0.04 + TRIGGERS.lateralShift.baselineDeltaRatio)) < 1e-9);
// T10 knee symmetry DEMOTED to context — never eligible / fired regardless of the raw value.
const t10 = find(buildTriggerTable(repInputs({ view: "front", kneeSymmetry: 0.3 }), true), "T10_knee_symmetry");
check("evallog T10: demoted to non-firing context", t10.tier === "context" && !t10.eligible && !t10.fired);
// Levelness demoted to context — never eligible / fired regardless of the raw diff.
const lvl = find(buildTriggerTable(repInputs({ view: "front", levelnessDiff: 17 }), true), "shoulder_hip_levelness");
check("evallog levelness: demoted to non-firing context", lvl.tier === "context" && !lvl.eligible && !lvl.fired);

// --- Exposure + camera angle (unchanged robustness layer) -----------------
check("exposure: good -> none", decideExposure({ meanLuma: 130, darkFraction: 0.05, brightFraction: 0.05 }).filter === "none");
check("exposure: dark -> brighten", decideExposure({ meanLuma: 50, darkFraction: 0.5, brightFraction: 0 }).gain > 1);
check("exposure: backlit detected", decideExposure({ meanLuma: 95, darkFraction: 0.5, brightFraction: 0.3 }).quality === "backlit");
check("camera: roll detected", (estimateCameraAngle(body([0.35, 0.3], [0.65, 0.4]), 0.6, CAL_ASPECT).rollDeg ?? 0) > 8);

// --- Usage ledger + quota (pure) ------------------------------------------
// The quota gate decides whether a paid API call goes out, so its arithmetic is
// unit-tested directly. `nowMs` is injected everywhere, so the whole lifecycle
// (fill → block → age out → unblock) is exercised without faking timers.
const T0 = 1_000_000_000_000;
function uCall(o: Partial<UsageCall> & { tsMs: number }): UsageCall {
  return {
    tsMs: o.tsMs,
    tier: o.tier ?? "post_set",
    outcome: o.outcome ?? "response",
    model: o.model ?? "gemini-3.6-flash",
    sessionId: o.sessionId ?? "s1",
    latencyMs: o.latencyMs ?? 1000,
    imageCount: o.imageCount ?? 3,
    promptTokens: o.promptTokens ?? 100,
    outputTokens: o.outputTokens ?? 50,
    thinkingTokens: o.thinkingTokens ?? 25,
  };
}
function ledgerWith(calls: UsageCall[]): UsageLedger {
  return calls.reduce((l, c) => appendCall(l, c), emptyLedger("install-1", T0));
}

check("usage: wasSent true for response/no_cue/error", wasSent("response") && wasSent("no_cue") && wasSent("error"));
check("usage: wasSent false for local skips", !wasSent("skipped_quota") && !wasSent("skipped_rate_limit"));

// A skipped call must never consume quota — otherwise the gate's own refusals
// would permanently lock the user out once the window filled.
const skipLedger = ledgerWith([
  uCall({ tsMs: T0 + 1, outcome: "skipped_quota" }),
  uCall({ tsMs: T0 + 2, outcome: "skipped_rate_limit" }),
  uCall({ tsMs: T0 + 3, outcome: "response" }),
]);
check("usage quota: skips don't consume the window", evaluateQuota(skipLedger, { enabled: true, windowMs: MONTH_MS, maxCalls: 5 }, T0 + 10).used === 1);
check("usage quota: errors DO consume the window", evaluateQuota(ledgerWith([uCall({ tsMs: T0 + 1, outcome: "error" })]), { enabled: true, windowMs: MONTH_MS, maxCalls: 5 }, T0 + 10).used === 1);

const fullPolicy = { enabled: true, windowMs: MONTH_MS, maxCalls: 3 };
const full = ledgerWith([uCall({ tsMs: T0 + 1 }), uCall({ tsMs: T0 + 2 }), uCall({ tsMs: T0 + 3 })]);
const blockedVerdict = evaluateQuota(full, fullPolicy, T0 + 10);
check("usage quota: blocks at the limit", !blockedVerdict.allowed && blockedVerdict.remaining === 0);
check("usage quota: resetsAt = oldest in-window + window", blockedVerdict.resetsAtMs === T0 + 1 + MONTH_MS);
// Disabled policy still REPORTS usage but must never block.
check("usage quota: disabled never blocks", evaluateQuota(full, { ...fullPolicy, enabled: false }, T0 + 10).allowed);
// Roll the clock to exactly one window past the OLDEST call: the window is
// exclusive (`tsMs > now - windowMs`), so that call has just expired and the
// other two still count — one slot frees up and the gate reopens.
check("usage quota: oldest ages out of the window", evaluateQuota(full, fullPolicy, T0 + 1 + MONTH_MS).used === 2);
check("usage quota: unblocks once a slot frees", evaluateQuota(full, fullPolicy, T0 + 1 + MONTH_MS).allowed);
// Tier scoping: a policy naming only post_workout must ignore post_set traffic.
check(
  "usage quota: tier-scoped policy ignores other tiers",
  evaluateQuota(full, { ...fullPolicy, tiers: ["post_workout"] }, T0 + 10).used === 0,
);

// Pruning keeps storage bounded by BOTH count and age.
const manyCalls = Array.from({ length: 12 }, (_, i) => uCall({ tsMs: T0 + i }));
const capped = manyCalls.reduce((l, c) => appendCall(l, c, { maxCalls: 5, maxWorkouts: 5, retentionDays: 400 }), emptyLedger("i", T0));
check("usage prune: count cap keeps the NEWEST", capped.calls.length === 5 && capped.calls[4].tsMs === T0 + 11);
// Retention is inclusive at the boundary (`tsMs >= cutoff`), so probe a day past
// it: the T0 record is outside the 400-day window, the recent one survives.
const aged = pruneLedger(ledgerWith([uCall({ tsMs: T0 }), uCall({ tsMs: T0 + 399 * 86_400_000 })]), T0 + 401 * 86_400_000, {
  maxCalls: 100,
  maxWorkouts: 100,
  retentionDays: 400,
});
check("usage prune: drops records past retention", aged.calls.length === 1 && aged.calls[0].tsMs === T0 + 399 * 86_400_000);

// Summary: tokens/images must come only from calls that were actually sent.
const summ = summarize(
  ledgerWith([
    uCall({ tsMs: T0 + 1, promptTokens: 100, outputTokens: 50, thinkingTokens: 25, imageCount: 3, latencyMs: 1000 }),
    uCall({ tsMs: T0 + 2, outcome: "error", promptTokens: 10, outputTokens: 0, thinkingTokens: 0, imageCount: 1, latencyMs: 3000 }),
    uCall({ tsMs: T0 + 3, outcome: "skipped_quota", promptTokens: 999, outputTokens: 999, thinkingTokens: 999, imageCount: 9 }),
  ]),
  T0 + 10,
);
check("usage summary: counts sent vs skipped", summ.totalSent === 2 && summ.totalSkipped === 1);
check("usage summary: skipped tokens excluded", summ.tokens.total === 185 && summ.images === 4);
check("usage summary: error rate over sent calls", Math.abs(summ.errorRate - 0.5) < 1e-9);
check("usage summary: per-tier split", summ.byTier.post_set.sent === 2 && summ.byTier.post_set.skipped === 1);
check("usage summary: latency percentiles", summ.latencyMs.p50 === 1000 && summ.latencyMs.max === 3000);
check("percentile: empty is null", percentile([], 50) === null);

// Workout stats — the session-length / completion data nothing tracked before.
const wLedger = appendWorkout(
  appendWorkout(emptyLedger("i", T0), { sessionId: "a", startedMs: T0, endedMs: T0 + 60_000, durationMs: 60_000, sets: 2, repsCounted: 8, repsAttempted: 10, completed: true, mode: "bodyweight", depthPreset: "parallel" }),
  { sessionId: "b", startedMs: T0, endedMs: T0 + 180_000, durationMs: 180_000, sets: 3, repsCounted: 12, repsAttempted: 14, completed: false, mode: "bodyweight", depthPreset: "parallel" },
);
const wSumm = summarize(wLedger, T0 + 200_000);
check("usage workouts: completion rate", Math.abs(wSumm.workouts.completionRate - 0.5) < 1e-9);
check("usage workouts: depth-gate pass rate", Math.abs(wSumm.workouts.repCountRate - 20 / 24) < 1e-9);
check("usage workouts: median duration", wSumm.workouts.medianDurationMs === 60_000);

// Upsert is what keeps `completed` honest: the row is written incomplete when the
// first set ends, then REPLACED (not duplicated) on finish. Without this the
// completion rate would be a constant 100%, since only finished sessions existed.
const wIn = { sessionId: "s", startedMs: T0, endedMs: T0 + 60_000, durationMs: 60_000, sets: 1, repsCounted: 5, repsAttempted: 6, completed: false, mode: "bodyweight", depthPreset: "parallel" };
const upserted = upsertWorkout(upsertWorkout(emptyLedger("i", T0), wIn), { ...wIn, sets: 2, repsCounted: 11, repsAttempted: 13, completed: true, endedMs: T0 + 120_000, durationMs: 120_000 });
check("usage upsert: replaces by sessionId (no duplicate)", upserted.workouts.length === 1);
check("usage upsert: finish marks the row complete", upserted.workouts[0].completed && upserted.workouts[0].sets === 2);
// A session abandoned after one set stays incomplete — the case that makes the metric real.
const abandoned = summarize(upsertWorkout(emptyLedger("i", T0), wIn), T0 + 200_000);
check("usage upsert: abandoned session stays incomplete", abandoned.workouts.completionRate === 0 && abandoned.workouts.count === 1);

// --- Aspect space (2026-09-18) ----------------------------------------------------------------
// MediaPipe normalizes x by the frame WIDTH and y by the HEIGHT, so an angle computed on raw
// landmarks depends on the camera. One physical body, filmed by three cameras, must now give the
// same angles, the same facing score and the same orientation on all three.
{
  const toAspectDeg = (deg: number, a: number) => (Math.atan(Math.tan((deg * Math.PI) / 180) * a) * 180) / Math.PI;
  // A squat bottom with a clear trunk lean, in image PIXELS (square pixels, y down).
  const SQUAT_PX: Record<number, [number, number]> = {
    11: [330, 330], 12: [360, 336], 23: [480, 560], 24: [500, 566],
    25: [600, 600], 26: [612, 596], 27: [560, 820], 28: [574, 816], 31: [640, 840], 32: [652, 836],
  };
  // A standing body turned ~3/4 toward side: shoulder spread 60 px over a 220 px torso (score 0.27).
  const TURNED_PX: Record<number, [number, number]> = {
    11: [470, 300], 12: [530, 300], 23: [480, 520], 24: [520, 520],
    25: [482, 680], 26: [518, 680], 27: [484, 840], 28: [516, 840],
  };
  // Filming = a similarity transform into the frame, then MediaPipe's per-axis normalization.
  const film = (px: Record<number, [number, number]>, W: number, H: number, scale: number, ox: number, oy: number): Landmark[] => {
    const a = Array.from({ length: 33 }, () => lm(0, 0, 0));
    for (const [i, [x, y]] of Object.entries(px)) a[Number(i)] = lm((x * scale + ox) / W, (y * scale + oy) / H, 0.9, i === "11" ? -0.1 : 0);
    return a;
  };
  const cams = [
    { W: 1280, H: 720, scale: 0.8, ox: 100, oy: 20 }, // 16:9 laptop — the calibration camera
    { W: 640, H: 480, scale: 0.5, ox: 20, oy: 30 }, // 4:3 webcam
    { W: 720, H: 1280, scale: 0.9, ox: 50, oy: 300 }, // portrait phone
  ];
  const frames = cams.map((c) => computeSquatFrame(film(SQUAT_PX, c.W, c.H, c.scale, c.ox, c.oy), 0.6, 0, c.W / c.H));
  const sameOnEveryCamera = (get: (f: SquatFrame) => number | null) =>
    frames.every((f) => get(f) !== null && Math.abs((get(f) as number) - (get(frames[0]) as number)) < 1e-9);
  check("aspect: trunk lean identical on 16:9, 4:3 and portrait", sameOnEveryCamera((f) => f.torsoLean));
  check("aspect: knee angle identical on every camera", sameOnEveryCamera((f) => f.kneeAngle));
  check("aspect: shin + foot angles identical on every camera", sameOnEveryCamera((f) => f.shinAngleDeg) && sameOnEveryCamera((f) => f.footAngleDeg));
  check("aspect: levelness identical on every camera", sameOnEveryCamera((f) => f.levelnessDiffDeg));
  // …and it is the REAL image angle: shoulder-mid (345,333) over hip-mid (490,563) = atan(145/230).
  const trueLean = (Math.atan2(145, 230) * 180) / Math.PI;
  check("aspect: trunk lean is the real pixel-space angle (32.2°)", Math.abs((frames[0].torsoLean ?? 0) - trueLean) < 1e-9);
  // The bug this fixes: the raw normalized angle of the same body was camera-dependent.
  const naiveLean = (c: (typeof cams)[number]) => {
    const l = film(SQUAT_PX, c.W, c.H, c.scale, c.ox, c.oy);
    const dx = (l[11].x + l[12].x) / 2 - (l[23].x + l[24].x) / 2;
    const dy = (l[11].y + l[12].y) / 2 - (l[23].y + l[24].y) / 2;
    return (Math.atan2(Math.abs(dx), Math.abs(dy)) * 180) / Math.PI;
  };
  check("aspect: the OLD normalized lean read ~19.5° on 16:9 and ~48° on portrait for one body",
    Math.abs(naiveLean(cams[0]) - 19.5) < 0.5 && naiveLean(cams[2]) - naiveLean(cams[0]) > 25);

  const turned = cams.map((c) => film(TURNED_PX, c.W, c.H, c.scale, c.ox, c.oy));
  const scores = turned.map((l, i) => computeFacing(l, 0.6, cams[i].W / cams[i].H)?.score ?? NaN);
  check("aspect: facing score identical on every camera", scores.every((x) => Math.abs(x - scores[0]) < 1e-9));
  const orients = turned.map((l, i) => estimateOrientation(l, 0.6, cams[i].W / cams[i].H).orientation);
  check("aspect: a 3/4-turned stance classifies the same (side) on every camera", orients.every((o) => o === "side"));
  const rawScore = (i: number) => computeFacing(turned[i], 0.6, 1)?.score ?? NaN;
  check("aspect: the raw normalized facing score differed 3.2× between 16:9 and portrait", Math.abs(rawScore(2) / rawScore(0) - (16 / 9) ** 2) < 1e-6);
  const rolls = cams.map((c) => estimateCameraAngle(film(SQUAT_PX, c.W, c.H, c.scale, c.ox, c.oy), 0.6, c.W / c.H).rollDeg ?? NaN);
  check("aspect: camera roll identical on every camera", rolls.every((r) => Math.abs(r - rolls[0]) < 1e-9));

  // Thresholds tuned on the 16:9 recordings were converted with atan(tan θ · 16/9).
  check("aspect: forward-lean warn = the old 35° on 16:9 (51.2°)", Math.abs(SQUAT.forwardLeanWarnDeg - toAspectDeg(35, 16 / 9)) < 0.5);
  check("aspect: forward-lean critical = the old 50° on 16:9 (64.7°)", Math.abs((SEVERITY.forwardLean?.critical ?? 0) - toAspectDeg(50, 16 / 9)) < 0.5);
  const OLD_SCORE = { FRONT_FULL: 0.5, FRONT_EDGE: 0.3, SIDE_EDGE: 0.2, SIDE_FULL: 0.1 };
  check("aspect: orientation anchors = the old ones × 16/9",
    (Object.keys(OLD_SCORE) as (keyof typeof OLD_SCORE)[]).every((k) => Math.abs(ORIENTATION.SCORE[k] - OLD_SCORE[k] * (16 / 9)) < 0.01));
  // Replay of every eligible side rep with a resolved baseline in the 07-31, 08-02 and 08-27 runs
  // (normalized degrees as logged, all from a 1280×720 camera): [baseline, peak deep lean, T1 fired].
  const REPLAY: Array<[number, number, boolean]> = [
    [24.4, 23.5, false], [24.4, 29.4, false], [24.4, 45.1, true], [24.4, 75.0, true],
    [25.9, 25.0, false], [25.9, 25.8, false], [25.9, 84.3, true], [25.9, 26.1, false],
    [26.1, 26.2, false], [26.1, 27.1, false], [26.1, 27.9, false], [26.1, 29.2, false],
    [25.3, 26.8, false], [25.3, 31.5, false], [25.3, 53.2, true], [25.3, 89.7, true], [25.3, 28.1, false],
    [25.8, 27.7, false], [25.8, 25.0, false], [25.8, 25.9, false], [25.8, 28.1, false],
    [18.1, 54.6, true], [18.1, 79.3, true],
  ];
  check("aspect replay: the table reproduces the logged decisions under the old +10° rule",
    REPLAY.every(([b, p, fired]) => (p - b >= 10) === fired));
  check("aspect replay: T1 in real degrees makes every recorded decision the same (23 reps)",
    REPLAY.every(([b, p, fired]) => leanTriggerActive(toAspectDeg(p, 16 / 9), toAspectDeg(b, 16 / 9), 0.5) === fired));
}

// --- Post-workout fault trends (session/faultTrends.ts) ----------------------------------------
// `worsened_with_fatigue` was `present.includes(lastSetIndex)` — any fault in the final set read
// as fatigue, velocity never consulted. Its replacement only claims what the data holds.
{
  const mkRep = (index: number, o: { fired?: MetricId[]; ratio?: number | null; ecc?: boolean } = {}): RepRecord => ({
    index,
    metrics: stubMetrics(o.ecc ? { eccentricControl: "warn" } : {}),
    velocity: o.ratio === undefined || o.ratio === null ? null : ({ ratio: o.ratio } as unknown as VelocitySample),
    bottomKneeAngle: 90,
    counted: true,
    depthRatio: 0.6,
    depthGap: 0.05,
    triggeredMetrics: o.fired ?? [],
    shiftTriggered: false,
    landmarkUnreliable: false,
    coaching: null,
  });
  const sets: SetRecord[] = [
    { index: 1, orientation: "side", facingAngleDeg: 0, reps: [mkRep(1, { ratio: 1 }), mkRep(2, { ratio: 1 }), mkRep(3, { fired: ["forwardLean"], ratio: 1.1, ecc: true })] },
    { index: 2, orientation: "front", facingAngleDeg: 90, reps: [mkRep(1, { ratio: 1 }), mkRep(2, { ratio: 1 }), mkRep(3, { ratio: 0.95 }), mkRep(4, { fired: ["kneeValgus"], ratio: 0.8 })] },
    { index: 3, orientation: "side", facingAngleDeg: 0, reps: [mkRep(1), mkRep(2), mkRep(3, { fired: ["forwardLean"] })] },
  ];
  const trends = squatFaultTrends(sets);
  const trend = (id: MetricId) => trends.find((t) => t.id === id);
  check("fault trends: a fault in the LAST set is not fatigue by itself (no slower rep)", trend("forwardLean")?.co_occurred_with_slowing === false);
  check("fault trends: a fault on a rep slower than average co-occurred with slowing", trend("kneeValgus")?.co_occurred_with_slowing === true);
  check("fault trends: a rep FASTER than average (1.1) is not slowing", trend("eccentricControl")?.co_occurred_with_slowing === false);
  const lean = trend("forwardLean");
  check("fault trends: side-only fault observable only in side sets",
    JSON.stringify(lean?.sets_observable) === "[1,3]" && JSON.stringify(lean?.sets_present) === "[1,3]");
  check("fault trends: present in every set that could SEE it = persistent", lean?.trend === "persistent");
  check("fault trends: agnostic fault observable in every set → intermittent when in one",
    JSON.stringify(trend("eccentricControl")?.sets_observable) === "[1,2,3]" && trend("eccentricControl")?.trend === "intermittent");
  check("fault trends: a fault that never fired is absent", trend("hipShift") === undefined);
  const vel = velocityDegradationPerSet(sets);
  check("velocity per set: slowest ratio per set, null (not 1) when unmeasured",
    vel.length === 3 && vel[0] === 1 && vel[1] === 0.8 && vel[2] === null);

  // Prompt ↔ payload: the two stale references are gone, and every fault_trends field the
  // post-workout prompt names exists on the builder's output.
  check("prompt: squat prompts no longer name rep_context or worsened_with_fatigue",
    !/rep_context|worsened_with_fatigue/.test(POSTSET_SYSTEM + POSTWORKOUT_SYSTEM));
  check("prompt: squat post-set rule 2 reads the view from set_summary.orientation",
    POSTSET_SYSTEM.split("\n").find((l) => l.startsWith("2. "))?.includes("set_summary.orientation") === true);
  const named = [...POSTWORKOUT_SYSTEM.matchAll(/fault_trends\[\]\.([a-z_]+)/g)].map((m) => m[1]);
  const built = new Set(["type", ...Object.keys(trends[0] ?? {})]);
  check("prompt: every fault_trends[] field in POSTWORKOUT_SYSTEM exists in the payload",
    named.length >= 3 && named.every((k) => built.has(k)));
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
