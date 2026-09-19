/**
 * The lab stage: drives the rep, flies the camera, and composes the frame.
 *
 * Frame order matters and is set by useFrame priority: this driver (−2) decides
 * the pose and the camera, the body (−1) skins itself to that pose, and the
 * effect composer (+1) renders.
 */
import { Suspense, useRef, type Ref } from "react";
import { useFrame } from "@react-three/fiber";
import { Bloom, ChromaticAberration, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { BlendFunction, type ChromaticAberrationEffect } from "postprocessing";
import { HalfFloatType, Vector2, Vector3 } from "three";

import {
  FAULTS,
  SQUARE_ON,
  kneeAngleDeg,
  planeVisibility,
  repAt,
  trunkLeanDeg,
  type Plane,
} from "@/lib/faultDemo";
import { Environment } from "@/stage/Environment";
import { ParticleBody } from "@/stage/ParticleBody";
import { store } from "@/stage/store";
import maleUrl from "@/stage/models/body-male.glb?url";
import femaleUrl from "@/stage/models/body-female.glb?url";

const BODY_URL = { male: maleUrl, female: femaleUrl };

/** What the camera looks at: about hip-to-chest height on a standing body. */
const TARGET = new Vector3(0, 0.92, 0);
/** Close enough that a standing body fills most of the frame — at 4.3 m the
 *  particles came out ~2 px and the body read as TV static — but not so close
 *  that the head crops: 3.5 m cut it off at the top of a 16:9 window. */
const DISTANCE = 3.9;
/** How far the cursor sways the camera, radians. Kept well inside the 9° band
 *  where a fault reads at full strength, so parallax never dims the red. */
const PARALLAX_AZ = 0.05;
const PARALLAX_EL = 0.03;
/** Seconds the tag stays up after a rep ends. */
const TAG_HOLD_S = 1.8;
const LOOP_PAUSE_S = 0.9;

const damp = (a: number, b: number, lambda: number, dt: number) => a + (b - a) * (1 - Math.exp(-lambda * dt));

/** The square-on view of `plane` nearest to where the camera already is — so
 *  asking for a side view never swings the camera the long way round. */
function nearestSquareOn(plane: Plane, azimuth: number): number {
  const base = SQUARE_ON[plane];
  return base + Math.round((azimuth - base) / Math.PI) * Math.PI;
}

function Driver() {
  const parallax = useRef({ x: 0, y: 0 });

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.1); // a backgrounded tab must not skip a whole rep
    const s = store;
    const st = s.settings;

    // A picked fault: glide to the view that can see it, then squat.
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
    // Dragging away mid-glide cancels the glide — start anyway, from wherever
    // the user put the camera. That is the point of the demo.
    if (s.phase === "aligning" && (s.targetAzimuth === null || Math.abs(s.azimuth - s.targetAzimuth) < 0.015)) {
      s.phase = "rep";
      s.repClock = 0;
    }

    if (s.phase === "rep") {
      s.repClock += dt * st.speed;
      const r = repAt(s.fault, s.repClock, st.severity, s.pose);
      s.envelope = r.envelope;
      if (r.done) {
        s.reps++;
        s.phase = "idle";
        s.tagHold = TAG_HOLD_S;
        s.loopWait = st.loop ? LOOP_PAUSE_S : 0;
      }
    } else {
      repAt("clean", 0, 0, s.pose);
      s.envelope = 0;
      s.tagHold = Math.max(0, s.tagHold - dt);
      if (s.phase === "idle" && s.loopWait > 0) {
        s.loopWait -= dt;
        if (s.loopWait <= 0 && st.loop) s.request = s.fault;
      }
    }
    s.knee = kneeAngleDeg(s.pose);
    s.trunk = trunkLeanDeg(s.pose);

    // Camera: the orbit, plus a little sway toward the cursor.
    const inside = s.pointerInside && !s.dragging;
    parallax.current.x = damp(parallax.current.x, inside ? s.pointer.x : 0, 2, dt);
    parallax.current.y = damp(parallax.current.y, inside ? s.pointer.y : 0, 2, dt);
    const az = s.azimuth + parallax.current.x * PARALLAX_AZ;
    const el = s.elevation + parallax.current.y * PARALLAX_EL;
    s.viewAzimuth = az;
    state.camera.position.set(
      TARGET.x + Math.sin(az) * Math.cos(el) * DISTANCE,
      TARGET.y + Math.sin(el) * DISTANCE,
      TARGET.z + Math.cos(az) * Math.cos(el) * DISTANCE,
    );
    state.camera.lookAt(TARGET);

    const plane = FAULTS[s.fault].plane;
    s.visibility = plane ? planeVisibility(plane, az) : 0;
  }, -2);

  return null;
}

/** A brief chromatic split as a fault arrives — the igloo "signal" flicker. */
function useFaultFlicker() {
  const ca = useRef<ChromaticAberrationEffect>(null);
  const last = useRef(0);
  const pulse = useRef(0);
  useFrame((_, dt) => {
    const now = store.envelope * store.visibility;
    if (now > 0.25 && last.current <= 0.25) pulse.current = 1;
    last.current = now;
    pulse.current = Math.max(0, pulse.current - dt * 2.5);
    const o = 0.0016 * pulse.current * pulse.current;
    ca.current?.offset.set(o, o * 0.4);
  });
  return ca;
}

export function LabScene({
  body,
  count,
  interior,
  skelCount,
  bloom,
  grain,
}: {
  body: "male" | "female";
  count: number;
  interior: number;
  skelCount: number;
  bloom: number;
  grain: number;
}) {
  const ca = useFaultFlicker();
  return (
    <>
      <Driver />
      <Environment />
      <Suspense fallback={null}>
        <ParticleBody url={BODY_URL[body]} count={count} interior={interior} skelCount={skelCount} />
      </Suspense>
      <EffectComposer multisampling={0} frameBufferType={HalfFloatType}>
        <Bloom mipmapBlur luminanceThreshold={1} luminanceSmoothing={0.15} intensity={bloom} />
        <ChromaticAberration
          ref={ca as unknown as Ref<typeof ChromaticAberrationEffect>}
          offset={new Vector2(0, 0)}
          radialModulation={false}
          modulationOffset={0}
        />
        <Noise premultiply blendFunction={BlendFunction.SCREEN} opacity={grain} />
        <Vignette offset={0.3} darkness={0.32} />
      </EffectComposer>
    </>
  );
}
