/**
 * The lab stage: plays the picked exercise's scripted set, flies the camera, and
 * composes the frame.
 *
 * Frame order matters and is set by useFrame priority: this driver (−2) decides
 * the pose and the camera, the body (−1) skins itself to that pose, and the
 * effect composer (+1) renders.
 */
import { Suspense, useMemo, useRef, type Ref } from "react";
import { useFrame } from "@react-three/fiber";
import { Bloom, ChromaticAberration, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import { BlendFunction, type ChromaticAberrationEffect } from "postprocessing";
import { HalfFloatType, Vector2, Vector3 } from "three";

import { EXERCISES, type ExerciseId } from "@/lib/exercises";
import { loopAt, newLoopSample } from "@/lib/loop";
import { BAR_HALF, BAR_Y } from "@/lib/pullup";
import { Environment } from "@/stage/Environment";
import { ParticleBody, GHOST_X } from "@/stage/ParticleBody";
import { Bar } from "@/stage/Props";
import { store } from "@/stage/store";
import maleUrl from "@/stage/models/body-male.glb?url";
import femaleUrl from "@/stage/models/body-female.glb?url";

const BODY_URL = { male: maleUrl, female: femaleUrl };

/** What the camera looks at, and from how far, per exercise: about the middle
 *  of the body, close enough that it fills most of the frame — at 4.3 m a
 *  standing body's particles came out ~2 px and it read as TV static. */
const FRAMING: Record<ExerciseId, { target: Vector3; distance: number }> = {
  squat: { target: new Vector3(0, 0.92, 0), distance: 3.9 },
  pushup: { target: new Vector3(0, 0.3, 0), distance: 3.6 },
  pullup: { target: new Vector3(0, 1.25, 0), distance: 5 },
};
/** How far the cursor sways the camera, radians. */
const PARALLAX_AZ = 0.05;
const PARALLAX_EL = 0.03;

const damp = (a: number, b: number, lambda: number, dt: number) => a + (b - a) * (1 - Math.exp(-lambda * dt));

function Driver() {
  const parallax = useRef({ x: 0, y: 0 });
  const loop = useMemo(newLoopSample, []);
  const shown = useRef<ExerciseId>(store.exercise);
  const at = useMemo(() => ({ target: FRAMING.squat.target.clone(), distance: FRAMING.squat.distance }), []);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.1); // a backgrounded tab must not skip a whole rep
    const s = store;
    const st = s.settings;

    // A new exercise picked: blow the body apart and start its set from rep 1.
    if (s.exercise !== shown.current) {
      shown.current = s.exercise;
      s.loopClock = 0;
      s.burstNonce++;
    }
    const spec = EXERCISES[s.exercise];
    s.loopClock += dt * st.speed;
    loopAt(spec, s.loopClock, st.severity, s.pose, loop);
    s.check = loop.check;
    s.envelope = loop.envelope;
    s.lit = loop.lit;
    s.reps = loop.counted;
    s.readA = spec.readouts[0].read(s.pose);
    s.readB = spec.readouts[1].read(s.pose);
    s.bar = s.exercise === "pullup" ? 1 : 0;

    // Camera: the orbit, plus a little sway toward the cursor.
    const f = FRAMING[s.exercise];
    at.target.lerp(f.target, 1 - Math.exp(-3 * dt));
    at.distance = damp(at.distance, f.distance, 3, dt);
    const inside = s.pointerInside && !s.dragging;
    parallax.current.x = damp(parallax.current.x, inside ? s.pointer.x : 0, 2, dt);
    parallax.current.y = damp(parallax.current.y, inside ? s.pointer.y : 0, 2, dt);
    const az = s.azimuth + parallax.current.x * PARALLAX_AZ;
    const el = s.elevation + parallax.current.y * PARALLAX_EL;
    state.camera.position.set(
      at.target.x + Math.sin(az) * Math.cos(el) * at.distance,
      at.target.y + Math.sin(el) * at.distance,
      at.target.z + Math.cos(az) * Math.cos(el) * at.distance,
    );
    state.camera.lookAt(at.target);
  }, -2);

  return null;
}

/** A brief chromatic split as a fault arrives — the igloo "signal" flicker. */
function useFaultFlicker() {
  const ca = useRef<ChromaticAberrationEffect>(null);
  const last = useRef(0);
  const pulse = useRef(0);
  useFrame((_, dt) => {
    const now = store.envelope;
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
      <Bar y={BAR_Y} half={BAR_HALF} reachX={GHOST_X[0] - BAR_HALF} />
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
