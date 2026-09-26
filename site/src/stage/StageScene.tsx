/**
 * The site's scene: one body in the fog, and everything the page's scroll does
 * to it.
 *
 * The driver reads `storyAt(store.progress)` every frame and turns it into a
 * camera, a pose and the props on stage. Frame order is set by useFrame
 * priority: the driver (−2) decides the pose and the camera, the body (−1) skins
 * itself to that pose, and the effect composer (+1) renders.
 */
import { Suspense, useEffect, useMemo, useRef, type MutableRefObject, type Ref } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Bloom, BrightnessContrast, DepthOfField, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { BlendFunction, type BrightnessContrastEffect, type DepthOfFieldEffect } from "postprocessing";
import { HalfFloatType, Vector3, type PerspectiveCamera } from "three";

import { EXERCISES, restPose, type ExerciseId, type ExerciseSpec } from "@/lib/exercises";
import { FLOW_REP, FLOW_REP_S, STEP, TURN as FLOW_TURN, flowAt, newFlowFrame } from "@/lib/flowScript";
import { loopAt, newLoopSample } from "@/lib/loop";
import { BAR_HALF, BAR_Y } from "@/lib/pullup";
import { newPose, type Pose } from "@/lib/poseFrames";
import { EXERCISE_AT, STOPS, holdAt, mixShot, newSample, stopIndex, storyAt, type Shot } from "@/lib/story";
import type { Tier } from "@/lib/quality";
import { Environment } from "./Environment";
import { GHOST_X, ParticleBody } from "./ParticleBody";
import { Bar, Iris, Pedestal, Phone } from "./Props";
import { store } from "./store";
import maleUrl from "./models/body-male.glb?url";

const FRAME = stopIndex("frame");
const FLOW = stopIndex("flow");
/** The flow's scene with the reader off the stop: everything at rest. */
const FLOW_REST = newFlowFrame();
const FINALE = stopIndex("finale");

/** The flow's squat: the lean rep, over and over (lib/flowScript). */
const FLOW_SPEC: ExerciseSpec = { ...EXERCISES.squat, script: [FLOW_REP], repS: FLOW_REP_S };
/** The phone's scan sweeps from over the head to the floor, metres. */
const SCAN_TOP = 2.02;
const SCAN_BOTTOM = -0.04;

/** The invisible box around the body that a finger can swipe through, per
 *  exercise: half its width and depth about the body, and its height, metres.
 *  Tighter than the particles' glass container (±0.9 m), which is wider than a
 *  portrait phone's whole view — a touch zone that size left nothing on the
 *  page to scroll by. */
const TOUCH: Record<ExerciseId, { halfW: number; halfD: number; top: number }> = {
  squat: { halfW: 0.45, halfD: 0.35, top: 2.05 },
  pushup: { halfW: 0.45, halfD: 0.95, top: 0.75 },
  pullup: { halfW: 0.5, halfD: 0.4, top: 2.45 },
};

/** How far the cursor sways the camera, radians. */
const PARALLAX_AZ = 0.05;
const PARALLAX_EL = 0.03;
/** The pedestal's height: the body steps up onto it in the finale. */
const LIFT = 0.12;
/** The finale's slow turn, rad/s. */
const TURN = 0.3;
/** On a portrait screen the camera stands this much further back, so the body
 *  has fog on both sides of it — room to scroll by. */
const NARROW_PULLBACK = 0.45;
/** How far over the body's highest point the HUD's labels sit, metres. */
const LABEL_CLEAR = 0.26;
/** How fast the pull-up bar fades in or out with a change of exercise, 1/s. */
const BAR_FADE = 9;

const damp = (a: number, b: number, lambda: number, dt: number) => a + (b - a) * (1 - Math.exp(-lambda * dt));
const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function lerpPose(into: Pose, to: Pose, t: number) {
  for (let i = 0; i < into.length; i++) into[i] += (to[i] - into[i]) * t;
}

function Driver({ dof }: { dof: MutableRefObject<DepthOfFieldEffect | null> }) {
  const size = useThree((s) => s.size);
  const sample = useMemo(newSample, []);
  const shotNow = useMemo<Shot>(() => ({ ...STOPS[0].shot }), []);
  const flowPose = useMemo(newPose, []);
  const flowLoop = useMemo(newLoopSample, []);
  const flowFrame = useMemo(newFlowFrame, []);
  /** The flow step shown last frame — for the flash as the squat starts. */
  const flowStep = useRef(-1);
  const parallax = useRef({ x: 0, y: 0 });
  const lit = useRef(0);
  const lastStop = useRef(0);
  const v = useMemo(() => new Vector3(), []);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const s = store;
    const st = s.settings;
    const cam = state.camera as PerspectiveCamera;
    storyAt(s.progress, sample);

    // ── which exercise ─────────────────────────────────────────────────────
    // Decided by the stop the reader is nearer, so it changes at the middle of
    // a move — where both stops' words are out of focus. Between two exercises
    // the body is blown apart there and re-forms as the next one; through the
    // iris the change is hidden behind the closed blades, so it simply cuts.
    // (Judged by the stops, not by how closed the iris is this frame: a jump
    // of the scroll — a link, the End key — can land past the closed middle.)
    const exercise = EXERCISE_AT[STOPS[sample.stop].id];
    if (exercise !== s.exercise) {
      const throughIris = STOPS[sample.stop].throughIris || STOPS[lastStop.current].throughIris;
      s.exercise = exercise;
      s.loopClock = 0;
      if (!throughIris) s.burstNonce++;
    }
    lastStop.current = sample.stop;
    const spec = EXERCISES[exercise];

    // ── pose ──────────────────────────────────────────────────────────────
    // At rest, except where the flow has it squat (below). (The exercise stops,
    // each running its scripted set, were removed on 2026-09-26.)
    restPose(spec, s.pose);
    s.check = "clean";
    s.envelope = 0;
    s.lit = null;
    s.reps = 0;

    // ── the flow (lib/flowScript) ─────────────────────────────────────────
    // Scrubbed by the scroll: every sweep, point, turn, rep and flash is a
    // function of how far through the stop the reader is (`flowAt`), so it
    // moves only while they scroll, freezes when they stop, and plays
    // backwards on the way back up. Off the stop it's all at rest.
    const ff = flowFrame;
    if (sample.presence[FLOW] > 0) flowAt(holdAt(s.progress, FLOW), ff);
    else Object.assign(ff, FLOW_REST);
    // The flag lights with an exposure flash (and its sound) as the squat
    // starts, on the way down the page.
    if (ff.step === STEP.reps && flowStep.current < STEP.reps && flowStep.current >= 0) s.faultFlash++;
    flowStep.current = ff.step;
    s.flowStep = ff.step;
    s.scan = ff.scan;
    // Once the sweep is done its line goes below the floor, out of sight.
    s.scanY = ff.sweep < 1 ? SCAN_TOP + (SCAN_BOTTOM - SCAN_TOP) * ff.sweep : -1;
    s.marks = ff.marks;
    s.marksClock = ff.marksT;
    s.turn = FLOW_TURN * ff.turn;
    // The flagged squat: side-on, leaning, the trunk flashing red — through
    // the reps and on while the read goes out and comes back.
    if (ff.squat > 0) {
      loopAt(FLOW_SPEC, ff.squatT * st.speed, st.severity, flowPose, flowLoop);
      lerpPose(s.pose, flowPose, ff.squat);
      s.check = FLOW_REP;
      s.envelope = ff.flash;
    }
    s.flowStream = ff.stream;
    s.readA = spec.readouts[0].read(s.pose);
    s.readB = spec.readouts[1].read(s.pose);
    let top = 0;
    for (let k = 1; k < s.pose.length; k += 3) top = Math.max(top, s.pose[k]);
    s.labelY = top + LABEL_CLEAR;

    // ── what's on stage ───────────────────────────────────────────────────
    s.cone = sample.presence[FRAME];
    // The flow shows the phone in front of the body, without its view: the
    // phone's scan is drawn on the body itself.
    s.phoneShow = sample.presence[FLOW];
    // The ghosts of earlier sets went with the "after the workout" stop.
    s.ghosts = 0;
    // The bar goes with the pull-up, fading in or out with the burst.
    s.bar = damp(s.bar, exercise === "pullup" ? 1 : 0, BAR_FADE, dt);
    if (Math.abs(s.bar - (exercise === "pullup" ? 1 : 0)) < 0.002) s.bar = exercise === "pullup" ? 1 : 0;
    s.holo = sample.presence[FINALE];
    s.lift = LIFT * s.holo;
    s.iris = sample.iris;
    if (s.holo > 0) s.spin += dt * TURN * s.holo;
    else {
      // Unwind to the nearest whole turn rather than spinning back.
      const whole = Math.round(s.spin / (Math.PI * 2)) * Math.PI * 2;
      s.spin = damp(s.spin, whole, 2.5, dt);
    }

    // ── camera ────────────────────────────────────────────────────────────
    mixShot(STOPS[sample.from].shot, STOPS[sample.to].shot, sample.blend, shotNow);

    parallax.current.x = damp(parallax.current.x, s.pointerInside ? s.pointer.x : 0, 2, dt);
    parallax.current.y = damp(parallax.current.y, s.pointerInside ? s.pointer.y : 0, 2, dt);
    const az = shotNow.azimuth + parallax.current.x * PARALLAX_AZ;
    const el = shotNow.elevation + parallax.current.y * PARALLAX_EL;
    const aspect = size.width / Math.max(1, size.height);
    const narrow = 1 - smooth(0.75, 1.05, aspect);
    const dist = Math.max(0.6, shotNow.distance * (1 + NARROW_PULLBACK * narrow) - sample.dolly);
    const [tx, ty, tz] = shotNow.target;
    cam.position.set(
      tx + Math.sin(az) * Math.cos(el) * dist,
      ty + Math.sin(el) * dist,
      tz + Math.cos(az) * Math.cos(el) * dist,
    );
    cam.lookAt(tx, ty, tz);
    cam.fov = shotNow.fov + (shotNow.narrowFov - shotNow.fov) * narrow;
    // Slide the body out from under the text: a shifted view, not a turned
    // camera, so the perspective is the same wherever the body sits.
    const sx = shotNow.shift[0] + (shotNow.narrowShift[0] - shotNow.shift[0]) * narrow;
    const sy = shotNow.shift[1] + (shotNow.narrowShift[1] - shotNow.shift[1]) * narrow;
    cam.setViewOffset(size.width, size.height, -sx * size.width, sy * size.height, size.width, size.height);
    cam.updateProjectionMatrix();

    // A fault first lighting up: for the sound and the exposure flash. Not the
    // flow's flashing trunk — that blinks on purpose, and flashed once as the
    // squat started (above).
    if (flowFrame.squat === 0 && s.envelope > 0.25 && lit.current <= 0.25) s.faultFlash++;
    lit.current = s.envelope;

    // The box around the body on screen: the only place a touch throws
    // particles.
    const box = TOUCH[exercise];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const cx of [-box.halfW, box.halfW])
      for (const cy of [0, box.top])
        for (const cz of [-box.halfD, box.halfD]) {
          v.set(cx, cy + s.lift, cz).project(cam);
          const px = (v.x * 0.5 + 0.5) * size.width;
          const py = (-v.y * 0.5 + 0.5) * size.height;
          x0 = Math.min(x0, px);
          x1 = Math.max(x1, px);
          y0 = Math.min(y0, py);
          y1 = Math.max(y1, py);
        }
    s.box.x = Math.max(0, x0);
    s.box.y = Math.max(0, y0);
    s.box.w = Math.max(0, Math.min(size.width, x1) - s.box.x);
    s.box.h = Math.max(0, Math.min(size.height, y1) - s.box.y);

    // Rack focus: on whatever the shot is framing.
    dof.current?.target?.set(tx, ty, tz);
  }, -2);

  return null;
}

/** Exposure: a brief lift while the camera moves between stops, and a flash as
 *  a fault first lights up — optical, where igloo used a glitch. */
function useExposure(ref: MutableRefObject<BrightnessContrastEffect | null>) {
  const sample = useMemo(newSample, []);
  const flash = useRef(0);
  const seen = useRef(0);
  useFrame((_, dt) => {
    storyAt(store.progress, sample);
    if (store.faultFlash !== seen.current) {
      seen.current = store.faultFlash;
      flash.current = 1;
    }
    flash.current = Math.max(0, flash.current - dt * 2.2);
    if (ref.current) ref.current.brightness = 0.035 * sample.exposure + 0.05 * flash.current * flash.current;
  });
}

/** Watches the frame rate once the body has formed; one step down if the
 *  device can't hold it. */
function FrameWatch({ onSlow }: { onSlow: () => void }) {
  const t = useRef({ from: 0, frames: 0, done: false });
  useFrame((state) => {
    const w = t.current;
    const now = state.clock.elapsedTime;
    if (w.done || now < 3) return;
    if (w.from === 0) w.from = now;
    w.frames++;
    if (now - w.from >= 2) {
      w.done = true;
      if (w.frames / (now - w.from) < 45) onSlow();
    }
  });
  return null;
}

export default function StageScene({ tier, onSlow }: { tier: Tier; onSlow: () => void }) {
  const exposure = useRef<BrightnessContrastEffect | null>(null);
  const dof = useRef<DepthOfFieldEffect | null>(null);
  const focus = useMemo(() => new Vector3(0, 0.92, 0), []);
  useExposure(exposure);
  useEffect(() => {
    store.drawCount = tier.particles;
  }, [tier]);
  const st = store.settings;
  const exposureRef = exposure as unknown as Ref<typeof BrightnessContrastEffect>;
  return (
    <>
      <Driver dof={dof} />
      <FrameWatch onSlow={onSlow} />
      <Environment />
      <Phone />
      <Bar y={BAR_Y} half={BAR_HALF} reachX={GHOST_X[0] - BAR_HALF} />
      <Pedestal />
      <Suspense fallback={null}>
        <ParticleBody url={maleUrl} count={st.count} interior={st.interior} skelCount={st.skelCount} />
      </Suspense>
      <Iris />
      {/* Two composers rather than one with a conditional child: the composer
          builds its passes from its children once, and a pass that comes and
          goes under it is not something it expects. */}
      {tier.dof ? (
        <EffectComposer multisampling={0} frameBufferType={HalfFloatType}>
          <DepthOfField ref={dof} target={focus} worldFocusRange={2.5} bokehScale={1.6} />
          <Bloom mipmapBlur luminanceThreshold={1} luminanceSmoothing={0.15} intensity={st.bloom} />
          <BrightnessContrast ref={exposureRef} brightness={0} contrast={0} />
          <Noise premultiply blendFunction={BlendFunction.SCREEN} opacity={st.grain} />
          <Vignette offset={0.3} darkness={0.32} />
        </EffectComposer>
      ) : (
        <EffectComposer multisampling={0} frameBufferType={HalfFloatType}>
          <Bloom mipmapBlur luminanceThreshold={1} luminanceSmoothing={0.15} intensity={st.bloom} />
          <BrightnessContrast ref={exposureRef} brightness={0} contrast={0} />
          <Noise premultiply blendFunction={BlendFunction.SCREEN} opacity={st.grain} />
          <Vignette offset={0.3} darkness={0.32} />
        </EffectComposer>
      )}
    </>
  );
}
