/* Sanity checks for Analyze (video form analysis). Run with:
   npm run check:analyze

   Pure modules only, on synthetic data, in Node — same style as check_squat/check_pushup. They
   prove the geometry, rep finding, frame selection, payload honesty, prompt↔schema contract, the
   AI answer parser, the cost estimate, saved annotations and the point tracker behave as designed
   — NOT that any threshold is right. Every Analyze threshold is UNVALIDATED (n=0). */
import type { Landmark } from "../src/neurofit/pose/landmarks";
import { ANALYZE } from "../src/neurofit/analyze/config";
import {
  angleAt,
  angleArc,
  distToSegment,
  formatLength,
  leanFromVerticalDeg,
  makeCalibration,
  tiltFromHorizontalDeg,
  toPx,
} from "../src/neurofit/analyze/geometry";
import { computeJointAngles, facingScore, guessView, pairedAngle } from "../src/neurofit/analyze/jointAngles";
import { PoseTrack, percentile, smoothSeries, type SeriesPoint } from "../src/neurofit/analyze/poseTrack";
import { findCycles, findReps } from "../src/neurofit/analyze/reps";
import { pickReps, selectKeyFrames } from "../src/neurofit/analyze/keyFrames";
import { anglesDeg, buildClipPayload, buildFramePayload, phaseAt } from "../src/neurofit/analyze/payload";
import {
  History,
  drawingOpacity,
  hitTest,
  measure,
  resolvePoints,
  translate,
  validDrawing,
  type Drawing,
} from "../src/neurofit/analyze/annotations";
import { PointTracker, toGray, type Gray } from "../src/neurofit/analyze/pointTracker";
import { extractJson, parseFormResult, plain } from "../src/neurofit/analyze/aiResult";
import { estimateCost, formatCost } from "../src/neurofit/analyze/cost";
import { ClipStore, clipKey, emptyRecord, type KV } from "../src/neurofit/analyze/clipStore";
import { FORM_CLIP_SYSTEM, FORM_FRAME_SYSTEM, FORM_RESULT_FIELDS, formResultSchema } from "../src/neurofit/ai/prompts";
import { buildGenerateBody } from "../src/neurofit/ai/requestBody";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures++;
}
const near = (a: number | null | undefined, b: number, tol: number) => a !== null && a !== undefined && Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------
check("angleAt: right angle", near(angleAt([0, 0], [0, 10], [10, 10]), 90, 1e-9));
check("angleAt: straight line", near(angleAt([0, 0], [5, 5], [10, 10]), 180, 1e-9));
check("tilt: horizontal line = 0°", near(tiltFromHorizontalDeg([0, 5], [10, 5]), 0, 1e-9));
check("lean: vertical line = 0°", near(leanFromVerticalDeg([3, 0], [3, 10]), 0, 1e-9));
check("lean: 45° line", near(leanFromVerticalDeg([0, 0], [10, 10]), 45, 1e-9));
// Aspect: a 45° line in a 16:9 frame spans equal PIXELS, not equal normalized units.
{
  const size = { width: 1600, height: 900 };
  const a = toPx(0.1, 0.1, size);
  const b = toPx(0.1 + 900 / 1600 * 0.5, 0.6, size);
  check("aspect: normalized points go through pixels before an angle", near(leanFromVerticalDeg(a, b), 45, 1e-6));
}
{
  const cal = makeCalibration(450, 45, "cm");
  check("calibration: 450 px over 45 cm = 10 px/cm", near(cal?.pxPerUnit, 10, 1e-9));
  check("calibration: 100 px reads 10.0 cm", formatLength(100, cal) === "10.0 cm");
  check("calibration: none → pixels", formatLength(99.6, null) === "100 px");
  check("calibration: zero/negative refused", makeCalibration(0, 45, "cm") === null && makeCalibration(10, -1, "cm") === null);
}
check("distToSegment: perpendicular foot", near(distToSegment([5, 5], [0, 0], [10, 0]), 5, 1e-9));
check("distToSegment: beyond the end", near(distToSegment([15, 0], [0, 0], [10, 0]), 5, 1e-9));
{
  const arc = angleArc([10, 0], [0, 0], [0, 10], 5);
  check("angleArc: path + label on the bisector", arc.d.startsWith("M 5.0 0.0 A 5 5") && arc.label[0] > 0 && arc.label[1] > 0 && near(arc.label[0], arc.label[1], 1e-6));
}

// ---------------------------------------------------------------------------------------
// Synthetic body (33 landmarks), side-on, squatting by `depth` 0..1.
// ---------------------------------------------------------------------------------------
const SIZE = { width: 1280, height: 720 };
const ASPECT = SIZE.width / SIZE.height;
function body(depth: number, opts: { front?: boolean; hideLeft?: boolean } = {}): Landmark[] {
  const lms: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.0 }));
  // Built in aspect space then normalized: x_norm = X / ASPECT.
  const set = (i: number, X: number, Y: number, vis = 0.95) => (lms[i] = { x: X / ASPECT, y: Y, z: 0, visibility: vis });
  const knee = (Math.PI * (180 - 100 * depth)) / 180; // knee angle 180 → 80
  const thigh = 0.22;
  const shin = 0.22;
  const ankle: [number, number] = [0.9, 0.9];
  // Shin leans forward by half the knee bend, thigh back.
  const bend = Math.PI - knee;
  const shinLean = bend * 0.45;
  const kneeP: [number, number] = [ankle[0] + shin * Math.sin(shinLean), ankle[1] - shin * Math.cos(shinLean)];
  const thighDir = shinLean - bend;
  const hipP: [number, number] = [kneeP[0] + thigh * Math.sin(thighDir), kneeP[1] - thigh * Math.cos(thighDir)];
  const trunk = 0.28;
  const lean = (35 * depth * Math.PI) / 180;
  const shP: [number, number] = [hipP[0] + trunk * Math.sin(lean), hipP[1] - trunk * Math.cos(lean)];
  const sep = opts.front ? 0.3 : 0.01;
  for (const side of [0, 1] as const) {
    const dx = side === 0 ? -sep / 2 : sep / 2;
    const vis = opts.hideLeft && side === 0 ? 0.1 : 0.95;
    set(11 + side, shP[0] + dx, shP[1], vis);
    set(13 + side, shP[0] + dx + 0.1, shP[1] + 0.02, vis);
    set(15 + side, shP[0] + dx + 0.2, shP[1], vis);
    set(23 + side, hipP[0] + dx, hipP[1], vis);
    set(25 + side, kneeP[0] + dx, kneeP[1], vis);
    set(27 + side, ankle[0] + dx, ankle[1], vis);
    set(31 + side, ankle[0] + dx + 0.08, ankle[1] + 0.01, vis);
  }
  set(0, shP[0] + 0.03, shP[1] - 0.08);
  return lms;
}

{
  const a = computeJointAngles(body(0), SIZE);
  check("joint angles: standing knee ≈ 180°", near(a.left_knee, 180, 0.5) && near(a.right_knee, 180, 0.5));
  check("joint angles: standing trunk upright", near(a.trunk_lean, 0, 0.5));
  const b = computeJointAngles(body(1), SIZE);
  check("joint angles: deep squat knee ≈ 80°", near(b.left_knee, 80, 0.5));
  check("joint angles: trunk lean ≈ 35°", near(b.trunk_lean, 35, 0.5));
  const hidden = computeJointAngles(body(1, { hideLeft: true }), SIZE);
  check("joint angles: unseen side → null (never 0)", hidden.left_knee === null && hidden.right_knee !== null);
  check("pairedAngle: one side seen → that side", near(pairedAngle(hidden, "knee"), b.right_knee ?? -1, 1e-9));
  const none = computeJointAngles(Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 })), SIZE);
  check("joint angles: no pose → every angle null", Object.values(none).every((v) => v === null));
  const side = facingScore(body(0), SIZE);
  const front = facingScore(body(0, { front: true }), SIZE);
  check("view: side body scores lower than front", side !== null && front !== null && side < front);
  check("view guess: side", guessView([side ?? 1, side ?? 1, side ?? 1]) === "side");
  check("view guess: front", guessView([front ?? 0, front ?? 0]) === "front");
  check("view guess: no scores → unknown", guessView([]) === "unknown");
}

// ---------------------------------------------------------------------------------------
// Pose track + rep finder
// ---------------------------------------------------------------------------------------
function squatClip(reps: number, opts: { periodMs?: number; restMs?: number; noise?: number; fps?: number; startDown?: boolean } = {}): PoseTrack {
  const period = opts.periodMs ?? 2000;
  const rest = opts.restMs ?? 800;
  const fps = opts.fps ?? 30;
  const total = rest + reps * (period + rest);
  const track = new PoseTrack(SIZE);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  for (let t = 0; t <= total; t += 1000 / fps) {
    let depth = 0;
    const k = t - rest;
    if (k >= 0) {
      const cyc = k % (period + rest);
      if (cyc < period) depth = Math.sin((Math.PI * cyc) / period) ** 2;
    }
    if (opts.startDown && t < 300) depth = 1;
    const lms = body(depth).map((l) => ({ ...l, x: l.x + (opts.noise ?? 0) * rnd(), y: l.y + (opts.noise ?? 0) * rnd() }));
    track.add({ tMs: t, landmarks: lms });
  }
  return track;
}

{
  const track = squatClip(5);
  const f = findReps(track, 0, Infinity);
  check("reps: 5 clean squats found", f.reps.length === 5);
  check("reps: driven by the knee", f.joint === "knee");
  const r = f.reps[1];
  check("reps: phases in order", !!r && r.startMs < r.midOutMs && r.midOutMs < r.turnMs && r.turnMs < r.midBackMs && r.midBackMs < r.endMs);
  // Rep 2's bottom is at rest + (period+rest) + period/2 = 800 + 2800 + 1000 = 4600 ms.
  check("reps: turnaround at the bottom (±80 ms)", near(r?.turnMs, 4600, 80));
  check("reps: turnaround angle ≈ deepest knee angle", near(r?.turnDeg, 80, 4));
  const noisy = findReps(squatClip(5, { noise: 0.003 }), 0, Infinity);
  check("reps: still 5 with landmark jitter", noisy.reps.length === 5);
  const sixty = findReps(squatClip(4, { fps: 60, periodMs: 1200, restMs: 400 }), 0, Infinity);
  check("reps: 60 fps fast reps → 4", sixty.reps.length === 4);
  const window = findReps(track, 3000, 9000);
  check("reps: in/out range limits the search", window.reps.length >= 1 && window.reps.length < 5 && window.reps.every((x) => x.startMs >= 3000));
}
{
  // A hold: no joint swings far enough.
  const track = new PoseTrack(SIZE);
  for (let t = 0; t < 5000; t += 33) track.add({ tMs: t, landmarks: body(0.1 + 0.05 * Math.sin(t / 300)) });
  const f = findReps(track, 0, Infinity);
  check("reps: a near-static clip finds none (no joint passes minRangeDeg)", f.reps.length === 0 && f.joint === null);
}
{
  // Starting at the far end (deadlift-style: rest is the CLOSED angle).
  const s: SeriesPoint[] = [];
  for (let t = 0; t < 9000; t += 33) {
    const cyc = t % 3000;
    s.push({ tMs: t, v: cyc < 600 ? 60 : 60 + 110 * Math.sin((Math.PI * (cyc - 600)) / 2400) ** 2 });
  }
  const cyc = findCycles(s);
  check("cycles: rest at the LOW end is detected (3 reps)", cyc.length === 3 && cyc.every((c) => c.turnDeg > 150 && near(c.restDeg, 60, 3)));
}
{
  const s: SeriesPoint[] = [];
  for (let t = 0; t < 4000; t += 33) s.push({ tMs: t, v: 170 - (t > 1000 ? 80 : 0) });
  check("cycles: a rep that never comes back is not counted", findCycles(s).length === 0);
}
{
  const track = new PoseTrack(SIZE);
  track.add({ tMs: 100, landmarks: body(0) });
  track.add({ tMs: 50, landmarks: body(0) });
  track.add({ tMs: 100.4, landmarks: body(1), exact: true });
  track.add({ tMs: 100.2, landmarks: body(0) });
  check("track: kept in time order, exact sample not overwritten by the pass", track.length === 2 && track.all()[0].tMs === 50 && track.all()[1].exact === true);
  check("track: nearest within gap", track.nearest(90, 20)?.tMs === 100.4 && track.nearest(300, 50) === null);
  const sm = smoothSeries([{ tMs: 0, v: 0 }, { tMs: 10, v: 10 }, { tMs: 20, v: 0 }, { tMs: 30, v: 10 }], 25);
  check("smooth: time-window average", near(sm[1].v, 10 / 3, 1e-9));
  check("percentile: nearest rank", percentile([5, 1, 3, 2, 4], 50) === 3);
}
{
  const track = new PoseTrack(SIZE);
  for (let t = 0; t <= 1000; t += 100) {
    const lms = body(0);
    lms[15] = { x: 0.5, y: 0.5 + t / 10000, z: 0, visibility: t === 500 ? 0.1 : 0.9 };
    track.add({ tMs: t, landmarks: lms });
  }
  const runs = track.jointPath(15, 0, 1000);
  check("trail: an unseen frame splits the path", runs.length === 2 && runs[0].length === 5 && runs[1].length === 5);
  check("trail: speed in px/s (0.01 norm-y per 100 ms on 720 px = 72 px/s)", near(runs[0][2].speed, 72, 1e-6));
}

// ---------------------------------------------------------------------------------------
// Key frames
// ---------------------------------------------------------------------------------------
{
  const f = findReps(squatClip(7), 0, Infinity);
  const picked = pickReps(f.reps);
  check("key frames: first, middle, last rep", picked.map((r) => r.index).join(",") === "1,4,7");
  const kf = selectKeyFrames(f.reps, 0, 30000);
  check("key frames: capped at maxFrames", kf.length <= ANALYZE.ai.clip.maxFrames && kf.length === 12);
  check("key frames: sorted in time", kf.every((k, i) => i === 0 || k.tMs > kf[i - 1].tMs));
  check("key frames: every rep frame has 4 phases", ["start", "moving_out", "turnaround", "moving_back"].every((p) => kf.filter((k) => k.phase === p).length === 3));
  const none = selectKeyFrames([], 0, 8000);
  check("key frames: no reps → evenly spaced samples", none.length === ANALYZE.ai.clip.evenFrames && none.every((k) => k.phase === "sample" && k.rep === null));
  const one = selectKeyFrames(findReps(squatClip(1), 0, Infinity).reps, 0, 3600);
  check("key frames: one rep → its 4 phases + a few context samples", one.filter((k) => k.rep === 1).length === 4 && one.length > 4 && one.length <= 8);
  check("key frames: cap holds whatever the clip length", selectKeyFrames(findReps(squatClip(40), 0, Infinity).reps, 0, 1e6).length <= 12);
}

// ---------------------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------------------
const clipInfo = { durationMs: 12345, width: 1280, height: 720 };
const finding = findReps(squatClip(3), 0, Infinity);
const keys = selectKeyFrames(finding.reps, 0, 12345);
const clipPayload = buildClipPayload({
  clip: clipInfo,
  fromMs: 0,
  toMs: 12345,
  exerciseHint: "  back   squat ",
  userNote: "",
  view: "side",
  poseFoundShare: 0.876,
  finding,
  frames: keys.map((k, i) => ({ key: k, angles: i === 0 ? null : computeJointAngles(body(0.5, { hideLeft: true }), SIZE) })),
});
{
  check("clip payload: hint whitespace collapsed; empty note → null", clipPayload.exercise_hint === "back squat" && clipPayload.user_note === null);
  check("clip payload: images numbered from 1, in order", clipPayload.frames.every((f, i) => f.image === i + 1));
  check("clip payload: no pose → every angle null (not 0, not missing)", Object.values(clipPayload.frames[0].angles_deg).every((v) => v === null) && Object.keys(clipPayload.frames[0].angles_deg).length === 11);
  check("clip payload: unseen side null, seen side integer degrees", clipPayload.frames[1].angles_deg.left_knee === null && Number.isInteger(clipPayload.frames[1].angles_deg.right_knee));
  check("clip payload: pose share as whole percent", clipPayload.pose_found_pct === 88);
  check("clip payload: times rounded to 0.01 s", clipPayload.clip.duration_s === 12.35 && clipPayload.frames.every((f) => Math.abs(Math.round(f.t_s * 100) - f.t_s * 100) < 1e-6));
  check("clip payload: reps listed with drive angle", clipPayload.reps.found === 3 && clipPayload.reps.driven_by === "knee angle" && clipPayload.reps.listed[0].drive_angle_deg.turnaround < 100);
  check("anglesDeg(null): full null map", Object.values(anglesDeg(null)).every((v) => v === null));
}
const mainMs = finding.reps[1].turnMs;
const framePayload = buildFramePayload({
  clip: clipInfo,
  mainMs,
  imageTimesMs: [mainMs - 150, mainMs, mainMs + 150],
  exerciseHint: "",
  question: "Is my back rounding?",
  view: "side",
  angles: computeJointAngles(body(1), SIZE),
  reps: finding.reps,
  measurements: [{ kind: "angle", what: "your angle at Left knee", value: "81°" }],
});
{
  check("frame payload: roles before/main/after", framePayload.images.map((i) => i.role).join(",") === "before,main,after");
  check("frame payload: main frame located in its rep at the turnaround", framePayload.main_frame.rep === 2 && framePayload.main_frame.phase === "turnaround");
  check("frame payload: empty hint → null, question kept", framePayload.exercise_hint === null && framePayload.question === "Is my back rounding?");
  check("phaseAt: outside every rep → nulls", phaseAt(finding.reps, -5).rep === null && phaseAt(finding.reps, -5).phase === null);
  const r = finding.reps[0];
  check("phaseAt: early in a rep → moving_out", phaseAt(finding.reps, (r.startMs + r.turnMs) / 2).phase === "moving_out");
}

// ---------------------------------------------------------------------------------------
// Prompt ↔ schema ↔ payload contract
// ---------------------------------------------------------------------------------------
function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
}
{
  const schema = formResultSchema();
  const schemaKeys = keysDeep((schema as { properties: unknown }).properties);
  const issueProps = (((schema as { properties: Record<string, { items?: { properties?: unknown } }> }).properties.issues.items ?? {}).properties) ?? {};
  for (const k of Object.keys(issueProps as object)) schemaKeys.add(k);
  check("schema: covers exactly FORM_RESULT_FIELDS", FORM_RESULT_FIELDS.every((f) => schemaKeys.has(f)) && [...schemaKeys].filter((k) => !["type", "enum", "items", "properties", "required", "propertyOrdering"].includes(k)).every((k) => (FORM_RESULT_FIELDS as readonly string[]).includes(k)));
  const known = new Set<string>([...FORM_RESULT_FIELDS, ...keysDeep(clipPayload), ...keysDeep(framePayload)]);
  for (const [name, prompt] of [["clip", FORM_CLIP_SYSTEM], ["frame", FORM_FRAME_SYSTEM]] as const) {
    const named = [...prompt.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
    const missing = named.filter((n) => !known.has(n));
    check(`prompt(${name}): every backticked field exists in the schema or a payload${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`, missing.length === 0 && named.length > 10);
  }
  check("prompts: shared rules identical in both", FORM_CLIP_SYSTEM.slice(FORM_CLIP_SYSTEM.indexOf("\n3. ")) === FORM_FRAME_SYSTEM.slice(FORM_FRAME_SYSTEM.indexOf("\n3. ")));
  check("prompts: issue caps stated match config", FORM_CLIP_SYSTEM.includes(`at most ${ANALYZE.ai.clip.maxIssues} issues`) && FORM_FRAME_SYSTEM.includes(`at most ${ANALYZE.ai.frame.maxIssues} issues`));
  check("prompts: frame cap stated matches config", FORM_CLIP_SYSTEM.includes(`up to ${ANALYZE.ai.clip.maxFrames} still frames`));
  check("prompts: forbid markdown + causes + diagnosis", /no markdown/i.test(FORM_FRAME_SYSTEM) && /no fatigue/i.test(FORM_FRAME_SYSTEM) && /No medical diagnosis/.test(FORM_FRAME_SYSTEM));
  const phases = ["start", "moving_out", "turnaround", "moving_back", "sample"];
  check("prompt(clip): every key-frame phase is explained", phases.every((p) => FORM_CLIP_SYSTEM.includes(`\\"${p}\\"`) || FORM_CLIP_SYSTEM.includes(`"${p}"`)));
}

// ---------------------------------------------------------------------------------------
// AI answer parser
// ---------------------------------------------------------------------------------------
{
  const good = JSON.stringify({
    exercise: "back squat",
    exercise_confidence: "sure",
    summary: "Solid depth. Your **heels** lift at the bottom.",
    issues: [
      { title: "Polish", severity: "low", frame: 2, reps: [1], what_we_see: "a", how_to_fix: "b", cue: "c", drill: "" },
      { title: "Heels lift", severity: "HIGH", frame: 3, reps: [3, 1, 1], what_we_see: "Heels come up", how_to_fix: "Sit back", cue: "Weight mid-foot", drill: "Goblet squat" },
      { title: "Bad frame", severity: "nonsense", frame: 99, reps: ["x"], what_we_see: "x", how_to_fix: "y", cue: "", drill: "" },
      { title: "", severity: "low", frame: 1, reps: [], what_we_see: "dropped", how_to_fix: "", cue: "", drill: "" },
    ],
    looks_good: ["- Depth", "Bar path"],
    cannot_judge: ["Knees caving (side view)"],
    refilm_tip: "",
  });
  const r = parseFormResult("```json\n" + good + "\n```", 12, 5);
  check("parse: fenced JSON accepted", r !== null);
  check("parse: markdown stripped from strings", r?.summary === "Solid depth. Your heels lift at the bottom." && r?.looksGood[0] === "Depth");
  check("parse: severity sorted high → low, case-insensitive", r?.issues[0].title === "Heels lift" && r?.issues[0].severity === "high");
  check("parse: unknown severity → medium; out-of-range frame → null", r?.issues.find((i) => i.title === "Bad frame")?.severity === "medium" && r?.issues.find((i) => i.title === "Bad frame")?.frame === null);
  check("parse: reps deduped + sorted, non-numbers dropped", r?.issues[0].reps.join(",") === "1,3" && r?.issues.find((i) => i.title === "Bad frame")?.reps.length === 0);
  check("parse: issue with no title dropped", r?.issues.length === 3);
  check("parse: cap trims lowest severity first", parseFormResult(good, 12, 1)?.issues.map((i) => i.title).join() === "Heels lift");
  check("parse: garbage → null", parseFormResult("I think your squat is fine", 12, 5) === null && parseFormResult("{not json", 12, 5) === null && parseFormResult(null, 12, 5) === null);
  check("parse: no summary and no issues → null", parseFormResult('{"summary":"","issues":[]}', 3, 3) === null);
  check("parse: clean bill of health is a valid answer", parseFormResult('{"summary":"Looks solid.","issues":[],"exercise":"push-up","exercise_confidence":"maybe"}', 3, 3)?.exerciseConfidence === "unsure");
  check("extractJson: text around the object", (extractJson('Here: {"a":1} done') as { a: number })?.a === 1);
  check("plain: headers and bullets removed", plain("# Title\n* one\n- two") === "Title\none\ntwo");
}

// ---------------------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------------------
{
  const clip = estimateCost({ images: 12, resolution: "MEDIA_RESOLUTION_LOW", textChars: 12000, expectedOutputTokens: ANALYZE.tokens.expectedOutput.clip });
  check("cost: 12 LOW images = 3360 image tokens + text/4", clip.inputTokens === 12 * 280 + 3000);
  check("cost: clip analysis estimate stays under 3¢", clip.usd < 0.03);
  const frame = estimateCost({ images: 3, resolution: "MEDIA_RESOLUTION_MEDIUM", textChars: 8000, expectedOutputTokens: ANALYZE.tokens.expectedOutput.frame });
  check("cost: frame question cheaper than a clip analysis", frame.usd < clip.usd);
  check("cost: LOW is a quarter of HIGH per image", ANALYZE.tokens.perImage.MEDIA_RESOLUTION_LOW * 4 === ANALYZE.tokens.perImage.MEDIA_RESOLUTION_HIGH);
  check("formatCost", formatCost(0.004) === "under 1¢" && formatCost(0.014) === "about 1¢" && formatCost(0.026) === "about 3¢" && formatCost(1.234) === "about $1.23");
}

// ---------------------------------------------------------------------------------------
// Request body: the live coach's requests are byte-identical; Analyze adds only its options.
// ---------------------------------------------------------------------------------------
{
  // The exact construction geminiGenerate used before requestBody.ts existed.
  const legacy = (system: string, payload: unknown, images: string[], maxTokens: number, level: string) => {
    const parts: Record<string, unknown>[] = [{ text: system }, { text: JSON.stringify(payload) }];
    for (const b64 of images) parts.push({ inline_data: { mime_type: "image/jpeg", data: b64 } });
    const generationConfig: Record<string, unknown> = { maxOutputTokens: maxTokens };
    generationConfig.thinkingConfig = { thinkingLevel: level };
    return JSON.stringify({ contents: [{ parts }], generationConfig });
  };
  const payload = { set_summary: { orientation: "side" }, x: [1, 2] };
  check("request body: post-set unchanged", buildGenerateBody("SYS", payload, ["AAA", "BBB"], 8192, "medium") === legacy("SYS", payload, ["AAA", "BBB"], 8192, "medium"));
  check("request body: post-workout unchanged", buildGenerateBody("SYS2", payload, [], 4096, "low") === legacy("SYS2", payload, [], 4096, "low"));
  const withOpts = JSON.parse(buildGenerateBody("S", {}, ["A"], 4096, "low", { mediaResolution: "MEDIA_RESOLUTION_LOW", responseMimeType: "application/json", responseSchema: formResultSchema() }));
  check("request body: Analyze options land in generationConfig", withOpts.generationConfig.mediaResolution === "MEDIA_RESOLUTION_LOW" && withOpts.generationConfig.responseMimeType === "application/json" && withOpts.generationConfig.responseSchema.type === "OBJECT");
  check("request body: no temperature with thinking on (Gemini 3.x)", !("temperature" in withOpts.generationConfig));
}

// ---------------------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------------------
{
  const lms = body(1);
  const angle: Drawing = {
    id: "a1",
    type: "angle",
    color: "#fff",
    scope: "clip",
    tMs: 1000,
    pts: [
      { kind: "joint", index: 23, p: [0, 0] },
      { kind: "joint", index: 25, p: [0, 0] },
      { kind: "joint", index: 27, p: [0, 0] },
    ],
  };
  const res = resolvePoints(angle, lms, SIZE);
  check("snapped angle follows the joints (reads the knee)", res.tracked && near(measure(angle, res.pts, null).value, computeJointAngles(lms, SIZE).left_knee ?? -1, 1e-6));
  const lost = resolvePoints(angle, null, SIZE);
  check("snapped angle with no pose falls back and says so", !lost.tracked && lost.pts[0][0] === 0);
  const line: Drawing = { id: "l1", type: "line", color: "#fff", scope: "frame", tMs: 1000, pts: [{ kind: "free", p: [0, 0] }, { kind: "free", p: [100, 10] }] };
  check("line reads against level when nearer level", measure(line, [[0, 0], [100, 10]], null).text === "6° off level");
  check("line reads against vertical when nearer vertical", measure(line, [[0, 0], [10, 100]], null).text === "6° off vertical");
  check("ruler reads in calibrated units", measure({ ...line, type: "ruler" }, [[0, 0], [300, 400]], makeCalibration(10, 1, "cm")).text === "50.0 cm");
  check("opacity: frame drawing fades out by frameFadeMs", drawingOpacity(line, 1000) === 1 && near(drawingOpacity(line, 1150), 0.5, 1e-9) && drawingOpacity(line, 1400) === 0);
  check("opacity: clip drawing always shown", drawingOpacity(angle, 99999) === 1);
  const resolved = new Map([["l1", [[0, 0], [100, 10]] as [number, number][]]]);
  check("hitTest: handle beats body", hitTest([line], resolved, [99, 9], 6)?.handle === 1);
  check("hitTest: body hit", hitTest([line], resolved, [50, 5], 6)?.handle === -1);
  check("hitTest: miss", hitTest([line], resolved, [50, 60], 6) === null);
  const moved = translate({ ...angle, pts: [{ kind: "free", p: [1, 1] }, angle.pts[1], angle.pts[2]] }, 10, 5);
  check("translate: free anchors move, joint anchors stay", moved.pts[0].p[0] === 11 && moved.pts[1].kind === "joint" && moved.pts[1].p[0] === 0);
  const sorted = (o: unknown) => JSON.stringify(o, Object.keys(o as object).sort());
  check("validDrawing: round-trip", sorted(validDrawing(JSON.parse(JSON.stringify(angle)))) === sorted(angle) && validDrawing(angle)?.pts[0].kind === "joint");
  check("validDrawing: wrong point count / bad joint / junk rejected", validDrawing({ ...angle, pts: angle.pts.slice(0, 2) }) === null && validDrawing({ ...angle, pts: [{ kind: "joint", index: 40, p: [0, 0] }, angle.pts[1], angle.pts[2]] }) === null && validDrawing("x") === null);
  const h = new History<number>(0, 3);
  h.push(1); h.push(2); h.push(3); h.push(4);
  check("history: capped undo depth", h.undo() === 3 && h.undo() === 2 && h.undo() === 1 && h.undo() === 1 && !h.canUndo);
  check("history: redo after undo, cleared by a new push", h.redo() === 2 && (h.push(9), !h.canRedo));
}

// ---------------------------------------------------------------------------------------
// Saved annotations
// ---------------------------------------------------------------------------------------
{
  const map = new Map<string, string>();
  const kv: KV = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
  const store = new ClipStore(kv, { key: "t", maxClips: 2 });
  const key = clipKey({ name: "set.mp4", size: 100, lastModified: 5, durationMs: 1234.4 });
  check("clipKey: name|size|modified|duration", key === "set.mp4|100|5|1234");
  const rec = emptyRecord(key, "set.mp4");
  rec.drawings.push({ id: "x", type: "ruler", color: "#fff", scope: "frame", tMs: 5, pts: [{ kind: "free", p: [0, 0] }, { kind: "free", p: [5, 5] }] });
  rec.calibration = { pxPerUnit: 10, unit: "cm", refId: "x" };
  rec.clipAi = { result: parseFormResult('{"summary":"ok","issues":[]}', 1, 1)!, frameTimesMs: [1, 2], createdAtMs: 9, exerciseHint: "squat" };
  rec.tracks.push({ id: "t1", color: "#fff", label: "Bar", points: [{ tMs: 0, x: 1, y: 2 }, { tMs: 33, x: 1.5, y: 2.5 }] }, { id: "bad", color: "#fff", label: "x", points: [{ tMs: 0, x: 1, y: 2 }] });
  store.save(rec, 1);
  const back = store.load(key);
  check("store: point tracks kept; a one-point track dropped", back?.tracks.length === 1 && back.tracks[0].points[1].x === 1.5);
  check("store: round-trip keeps drawings, calibration, AI answer", back?.drawings.length === 1 && back.calibration?.pxPerUnit === 10 && back.clipAi?.result.summary === "ok" && back.savedAtMs === 1);
  store.save(emptyRecord("b", "b"), 2);
  store.save(emptyRecord("c", "c"), 3);
  check("store: keeps only the newest maxClips", store.list().map((c) => c.key).join() === "c,b" && store.load(key) === null);
  map.set("t", "{corrupt");
  check("store: corrupt entry reads as empty, never throws", store.list().length === 0);
  const full: KV = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
  check("store: a full/blocked store fails quietly", new ClipStore(full).save(rec, 1) === false);
  check("store: no storage at all is fine", new ClipStore(null).load("x") === null);
}

// ---------------------------------------------------------------------------------------
// Point tracker
// ---------------------------------------------------------------------------------------
function frameWithBlob(w: number, h: number, cx: number, cy: number): Gray {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      // Textured background (so the patch isn't flat) + a bright ring blob.
      const bg = 60 + 20 * Math.sin(x * 0.7) * Math.cos(y * 0.5);
      const v = d < 6 ? 250 : d < 9 ? 20 : bg;
      const i = (y * w + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  return toGray(rgba, w, h);
}
{
  const W = 160;
  const Hh = 120;
  const path: [number, number][] = [];
  for (let k = 0; k < 20; k++) path.push([40 + k * 3.5, 30 + k * 2.2]);
  const tracker = PointTracker.start(frameWithBlob(W, Hh, path[0][0], path[0][1]), path[0][0], path[0][1]);
  let maxErr = 0;
  let ok = !!tracker;
  for (let k = 1; k < path.length && tracker; k++) {
    const hit = tracker.step(frameWithBlob(W, Hh, path[k][0], path[k][1]));
    if (!hit) { ok = false; break; }
    maxErr = Math.max(maxErr, Math.hypot(hit.x - path[k][0], hit.y - path[k][1]));
  }
  check(`tracker: follows a moving blob within 1 px (max err ${maxErr.toFixed(2)})`, ok && maxErr <= 1);
  const t2 = PointTracker.start(frameWithBlob(W, Hh, 80, 60), 80, 60);
  const flat = toGray(new Uint8ClampedArray(W * Hh * 4).fill(128), W, Hh);
  check("tracker: loses the point instead of guessing, and stays lost", t2 !== null && t2.step(flat) === null && t2.lost && t2.step(frameWithBlob(W, Hh, 80, 60)) === null);
  check("tracker: refuses a flat patch", PointTracker.start(flat, 80, 60) === null);
  check("tracker: refuses a point at the edge", PointTracker.start(frameWithBlob(W, Hh, 2, 2), 2, 2) === null);
}

console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
if (failures) process.exit(1);
