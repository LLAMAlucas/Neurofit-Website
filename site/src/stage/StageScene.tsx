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

import {
  FAULTS,
  REP_S,
  SQUARE_ON,
  kneeAngleDeg,
  planeVisibility,
  repAt,
  trunkLeanDeg,
  type Plane,
} from "@/lib/faultDemo";
import { newPose, type Pose } from "@/lib/poseFrames";
import { STOPS, mixShot, newSample, stopIndex, storyAt, type Shot } from "@/lib/story";
import type { Tier } from "@/lib/quality";
import { Environment } from "./Environment";
import { ParticleBody } from "./ParticleBody";
import { Iris, Pedestal, Phone } from "./Props";
import { store } from "./store";
import maleUrl from "./models/body-male.glb?url";

const SQUAT = stopIndex("squat");
const FRAME = stopIndex("frame");
const WORKOUT = stopIndex("afterWorkout");
const FINALE = stopIndex("finale");

/** How far the cursor sways the camera, radians — well inside the band where a
 *  fault reads at full strength, so parallax never dims the red. */
const PARALLAX_AZ = 0.05;
const PARALLAX_EL = 0.03;
const TAG_HOLD_S = 1.8;
/** The pedestal's height: the body steps up onto it in the finale. */
const LIFT = 0.12;
/** The finale's slow turn, rad/s. */
const TURN = 0.3;
/** The invisible box around the body that a finger can swipe through: half its
 *  width and depth, and its height, metres. Tighter than the particles' glass
 *  container (±0.9 m), which is wider than a portrait phone's whole view — a
 *  touch zone that size left nothing on the page to scroll by. */
const TOUCH_HALF_W = 0.45;
const TOUCH_HALF_D = 0.35;
const TOUCH_H = 2.05;
/** On a portrait screen the camera stands this much further back, so the body
 *  has fog on both sides of it — room to scroll by. */
const NARROW_PULLBACK = 0.45;

const damp = (a: number, b: number, lambda: number, dt: number) => a + (b - a) * (1 - Math.exp(-lambda * dt));
const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The square-on view of `plane` nearest to where the camera already is. */
function nearestSquareOn(plane: Plane, azimuth: number): number {
  const base = SQUARE_ON[plane];
  return base + Math.round((azimuth - base) / Math.PI) * Math.PI;
}

/** When in a knee-cave rep the cave is at its worst: the pose the ghosts and
 *  the body hold after the workout. */
const CAVE_PEAK_T = (() => {
  const p = newPose();
  let best = 0;
  let at = 0;
  for (let t = 0; t <= REP_S; t += 0.01) {
    const e = repAt("valgus", t, 1, p).envelope;
    if (e > best) {
      best = e;
      at = t;
    }
  }
  return at;
})();

function lerpPose(into: Pose, to: Pose, t: number) {
  for (let i = 0; i < into.length; i++) into[i] += (to[i] - into[i]) * t;
}

function Driver({ dof }: { dof: MutableRefObject<DepthOfFieldEffect | null> }) {
  const size = useThree((s) => s.size);
  const sample = useMemo(newSample, []);
  const shotNow = useMemo<Shot>(() => ({ ...STOPS[0].shot }), []);
  const squatShot = useMemo<Shot>(() => ({ ...STOPS[SQUAT].shot }), []);
  const caved = useMemo(newPose, []);
  const parallax = useRef({ x: 0, y: 0 });
  const autoRep = useRef(false);
  const lit = useRef(0);
  const v = useMemo(() => new Vector3(), []);

  // The squat stop's orbit starts where its shot does.
  useEffect(() => {
    store.azimuth = STOPS[SQUAT].shot.azimuth;
    store.elevation = STOPS[SQUAT].shot.elevation;
  }, []);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const s = store;
    const st = s.settings;
    const cam = state.camera as PerspectiveCamera;
    storyAt(s.progress, sample);

    // ── the squat stop: the reader's own orbit, and the fault picker ──────
    if (sample.presence[SQUAT] === 0 && !s.dragging) {
      // Away from it, the orbit drifts back to where the stop frames the body,
      // so coming back never finds the camera somewhere odd.
      s.azimuth = damp(s.azimuth, STOPS[SQUAT].shot.azimuth, 2, dt);
      s.elevation = damp(s.elevation, STOPS[SQUAT].shot.elevation, 2, dt);
      s.targetAzimuth = null;
    }
    // Arriving at the squat for the first time, the body does one clean rep on
    // its own, so the counter ticks before anyone has touched anything.
    if (!autoRep.current && sample.focus[SQUAT] > 0.95 && s.phase === "idle") {
      autoRep.current = true;
      s.request ??= "clean";
    }
    if (s.request && s.phase === "idle") {
      s.fault = s.request;
      s.request = null;
      s.tagHold = 0;
      const plane = FAULTS[s.fault].plane;
      if (plane) {
        s.targetAzimuth = nearestSquareOn(plane, s.azimuth);
        s.phase = "aligning";
      } else {
        s.phase = "rep";
        s.repClock = 0;
      }
    }
    if (!s.dragging && s.targetAzimuth !== null) s.azimuth = damp(s.azimuth, s.targetAzimuth, 3.2, dt);
    if (s.phase === "aligning" && (s.targetAzimuth === null || Math.abs(s.azimuth - s.targetAzimuth) < 0.015)) {
      s.phase = "rep";
      s.repClock = 0;
    }

    // ── pose ──────────────────────────────────────────────────────────────
    if (s.phase === "rep") {
      s.repClock += dt * st.speed;
      const r = repAt(s.fault, s.repClock, st.severity, s.pose);
      s.envelope = r.envelope;
      if (r.done) {
        s.reps++;
        s.phase = "idle";
        s.tagHold = TAG_HOLD_S;
      }
    } else {
      repAt("clean", 0, 0, s.pose);
      s.envelope = 0;
      s.tagHold = Math.max(0, s.tagHold - dt);
    }
    // After the workout the body — and the ghosts, which draw its pose — hold
    // the bottom of a caved rep, lit: the thing that kept happening.
    const workout = sample.presence[WORKOUT];
    if (workout > 0 && s.phase !== "rep") {
      repAt("valgus", CAVE_PEAK_T, 1, caved);
      lerpPose(s.pose, caved, workout);
      s.fault = "valgus";
      s.envelope = workout;
    }
    s.knee = kneeAngleDeg(s.pose);
    s.trunk = trunkLeanDeg(s.pose);

    // ── what's on stage ───────────────────────────────────────────────────
    s.cone = sample.presence[FRAME];
    s.ghosts = workout;
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
    squatShot.azimuth = s.azimuth;
    squatShot.elevation = s.elevation;
    const a = sample.from === SQUAT ? squatShot : STOPS[sample.from].shot;
    const b = sample.to === SQUAT ? squatShot : STOPS[sample.to].shot;
    mixShot(a, b, sample.blend, shotNow);

    const hovering = s.pointerInside && !s.dragging;
    parallax.current.x = damp(parallax.current.x, hovering ? s.pointer.x : 0, 2, dt);
    parallax.current.y = damp(parallax.current.y, hovering ? s.pointer.y : 0, 2, dt);
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

    // The red answers to the view on screen, turned body and all.
    s.viewAzimuth = az - s.spin;
    const plane = FAULTS[s.fault].plane;
    s.visibility = plane ? planeVisibility(plane, s.viewAzimuth) : 0;
    const showing = s.envelope * s.visibility;
    if (showing > 0.25 && lit.current <= 0.25) s.faultFlash++;
    lit.current = showing;

    // The box around the body on screen: the only place a touch throws
    // particles.
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const cx of [-TOUCH_HALF_W, TOUCH_HALF_W])
      for (const cy of [0, TOUCH_H])
        for (const cz of [-TOUCH_HALF_D, TOUCH_HALF_D]) {
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
