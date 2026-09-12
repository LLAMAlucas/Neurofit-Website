import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

import { frameToClip } from "@/lib/framing";
import { BONES, J, JOINT_COUNT, JOINT_NAMES } from "@/lib/pose";
import { BEAT_SPEC, HIGHLIGHTABLE, newPose, poseAt } from "@/lib/poseFrames";
import { timelineAt } from "@/lib/rigTimeline";

/* Palette is hard-coded rather than read from CSS custom properties: WebGL
   materials can't consume var(), and these are the app's own overlay colours
   (--on-lens / --signal / --fault), fixed by the product rather than the theme. */
const BONE_COLOR = new THREE.Color("#E9ECEC");
const FAULT_COLOR = new THREE.Color("#FF5252");
/* Measured, not flagged — the same green as the joints, deliberately NOT the
   fault red. See `marked` in BEAT_SPEC for why the distinction is load-bearing. */
const MARK_COLOR = new THREE.Color("#00E676");
const JOINT_COLOR = "#00E676";

/**
 * The one mutable object the scroll rig and the scene share.
 *
 * It is a ref rather than props because every field changes at frame rate:
 * routing any of it through React state would re-render the whole canvas
 * subtree sixty times a second.
 */
export type RigDriver = {
  /** Written by the rig: 0…1 as the lens grows out of the hero frame. */
  expandT: number;
  /** Written by the rig: 0…1 across the pinned sequence. */
  seqT: number;
  /** Written by the rig: whether the sequence is anywhere near the viewport. */
  running: boolean;
  /**
   * Written by the rig: the visible frame in viewport pixels — the clip rect,
   * which starts as the hero lens box and grows to the whole screen.
   *
   * The canvas is always full-viewport, so without this the camera frames the
   * figure on the CANVAS centre while the clip is showing a box off to the right
   * — and the figure is drawn precisely where the clip discards it. The scene
   * frames this rect instead.
   */
  clipX: number;
  clipY: number;
  clipW: number;
  clipH: number;
  /**
   * Written by the SCENE: the beat's two anchor joints in viewport pixels, and
   * the two hips.
   *
   * Both PAIRS, never their midpoints. A leader aimed at the midpoint of a
   * left/right pair has to cross whichever limb is nearer the label to get
   * there, which is exactly what it looked like — a dashed line skewering the
   * shin it was pointing at. The DOM side picks whichever end is on the label's
   * own side and stops there.
   *
   * These are the ONLY things that flow back out of the canvas, because they are
   * the only things that genuinely need the camera. Everything else the overlay
   * shows is driven from scroll on the DOM side — a label whose visibility
   * depended on the WebGL frameloop would freeze mid-sentence the moment the
   * renderer was throttled.
   */
  markAX: number;
  markAY: number;
  markBX: number;
  markBY: number;
  /** The hips. The fatigue label points here because the grind is a whole-body
   *  event with no single joint of its own, and the hips are where the stall in
   *  the ascent actually shows. */
  hipAX: number;
  hipAY: number;
  hipBX: number;
  hipBY: number;
};

export const newRigDriver = (): RigDriver => ({
  expandT: 0,
  seqT: 0,
  running: true,
  clipX: 0,
  clipY: 0,
  clipW: 0,
  clipH: 0,
  markAX: 0,
  markAY: 0,
  markBX: 0,
  markBY: 0,
  hipAX: 0,
  hipAY: 0,
  hipBX: 0,
  hipBY: 0,
});

/** Frame-rate independent exponential approach. `t += (target - t) * k` is not:
 *  it converges twice as fast on a 120 Hz display as it does on 60. */
const damp = (cur: number, target: number, lambda: number, dt: number) =>
  target + (cur - target) * Math.exp(-lambda * dt);

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/* Entrance, mirroring the 2D overlay's: limbs draw first, joints snap on top. */
const BONE_START = 0.25;
const BONE_STAGGER = 0.035;
const BONE_DUR = 0.4;
const JOINT_START = 0.5;
const JOINT_STAGGER = 0.04;
const JOINT_DUR = 0.36;

function Figure({ driver }: { driver: MutableRefObject<RigDriver> }) {
  const spin = useRef<THREE.Group>(null);
  const centre = useRef<THREE.Group>(null);
  const boneRefs = useRef<Array<THREE.Mesh | null>>([]);
  const jointRefs = useRef<Array<THREE.Mesh | null>>([]);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);

  // Everything the per-frame path touches is allocated once. Seventeen bones'
  // worth of fresh Vector3/Quaternion at 60fps is real GC pressure, and it shows
  // up as periodic hitches rather than as a steady frame cost.
  const s = useMemo(
    () => ({
      pose: newPose(),
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0),
      quat: new THREE.Quaternion(),
      anchor: new THREE.Vector3(),
      pt: [0, 0] as [number, number],
      colour: new THREE.Color(),
      clip: { x: 0, y: 0, w: 0, h: 0 },
      t0: -1,
      seq: 0,
      camY: 0.86,
      camZ: 4.2,
      targetY: 0.86,
      rotY: Math.PI / 2,
    }),
    [],
  );

  useFrame((state, delta) => {
    const d = driver.current;
    const dt = Math.min(delta, 0.1); // a backgrounded tab resumes with a huge delta
    if (s.t0 < 0) s.t0 = state.clock.elapsedTime;
    const age = state.clock.elapsedTime - s.t0;

    // Smooth the INPUT, not each output. One damped value keeps the pose, the
    // camera and the highlight in step; damping them separately makes the camera
    // arrive after the fault it is supposed to be looking at.
    s.seq = damp(s.seq, d.seqT, 11, dt);

    const f = timelineAt(d.expandT, s.seq);
    // The grind is phase-locked, not clock-driven, so the shudder is a function
    // of the damped scroll like everything else — it stops dead when the reader
    // does, and replays identically on the way back up.
    poseAt(f.depth, f.beat, f.beatAmount, s.pose, f.grind, f.phase);

    s.rotY = damp(s.rotY, f.rotY, 9, dt);
    s.camY = damp(s.camY, f.camY, 7, dt);
    s.camZ = damp(s.camZ, f.camZ, 7, dt);
    s.targetY = damp(s.targetY, f.targetY, 7, dt);

    if (spin.current) spin.current.rotation.y = s.rotY;

    // Rotate about the body's own centroid, which travels forward through the
    // rep as the arms reach and the hips sit back.
    let cz = 0;
    for (let i = 0; i < JOINT_COUNT; i++) cz += s.pose[i * 3 + 2];
    if (centre.current) centre.current.position.z = -cz / JOINT_COUNT;

    // Frame the CLIP RECT, not the canvas — see `frameToClip`.
    s.clip.x = d.clipX;
    s.clip.y = d.clipY;
    s.clip.w = d.clipW;
    s.clip.h = d.clipH;
    const fr = frameToClip(s.clip, size.width, size.height);

    camera.position.set(0, s.camY, s.camZ * fr.distanceScale);
    camera.lookAt(0, s.targetY, 0);

    /* The offset is applied as a LENS SHIFT (an off-axis frustum) rather than by
     * translating the camera: translating would turn the figure away from us as
     * it moved off-centre, which is the opposite of what you want while the
     * frame is opening. Mutating the projection's skew terms keeps the view
     * direction dead-on and only slides where the image lands. */
    camera.updateProjectionMatrix();
    const e = camera.projectionMatrix.elements;
    e[8] -= fr.shiftX;
    e[9] -= fr.shiftY;
    // `.project()` below reads these, so the inverse has to keep up with them.
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

    for (let i = 0; i < BONES.length; i++) {
      const m = boneRefs.current[i];
      if (!m) continue;
      const [an, bn] = BONES[i];
      s.a.fromArray(s.pose, J[an] * 3);
      s.b.fromArray(s.pose, J[bn] * 3);
      s.dir.subVectors(s.b, s.a);
      const len = s.dir.length();

      m.position.addVectors(s.a, s.b).multiplyScalar(0.5);
      // cylinderGeometry runs along +Y; rotate that onto the bone's direction
      m.quaternion.copy(s.quat.setFromUnitVectors(s.up, s.dir.divideScalar(len)));

      const grow = clamp01((age - (BONE_START + i * BONE_STAGGER)) / BONE_DUR);
      m.scale.y = len * easeOut(grow);
      m.visible = grow > 0;
    }

    // Only the bones that can ever change colour are touched here, and they are
    // ALWAYS touched — so a beat that has just ended is cleared by the same line
    // that set it, rather than needing a record of what was changed last frame.
    const spec = f.beat ? BEAT_SPEC[f.beat] : null;
    for (const i of HIGHLIGHTABLE) {
      const m = boneRefs.current[i];
      if (!m) continue;
      // Red only where the app would actually fire; green where it is reading a
      // number without passing judgement. Two claims, two colours.
      const bad = spec?.bones.includes(i) ? f.beatAmount : 0;
      const marked = spec?.marked.includes(i) ? f.beatAmount : 0;
      const lit = Math.max(bad, marked);
      (m.material as THREE.MeshBasicMaterial).color.copy(
        s.colour.copy(BONE_COLOR).lerp(bad > 0 ? FAULT_COLOR : MARK_COLOR, lit),
      );
      m.scale.x = m.scale.z = 1 + 0.5 * lit;
    }

    for (let i = 0; i < JOINT_COUNT; i++) {
      const m = jointRefs.current[i];
      if (!m) continue;
      m.position.fromArray(s.pose, i * 3);
      const p = clamp01((age - (JOINT_START + i * JOINT_STAGGER)) / JOINT_DUR);
      // slight overshoot, echoing the 2D overlay's `lock` keyframe
      m.scale.setScalar(p === 0 ? 0 : easeOut(p) * (1 + 0.32 * Math.sin(Math.PI * p)));
      m.visible = p > 0;
    }

    // Project the beat's anchor joints to viewport pixels for the DOM overlays.
    // The canvas is fixed at the origin and full-viewport, so NDC maps straight
    // to client coordinates and no element rect has to be read.
    const toScreen = (joint: number, out: [number, number]) => {
      // `centre` is a child of `spin`, so its matrixWorld already carries the
      // turn — transforming through both would rotate the point twice.
      s.anchor.fromArray(s.pose, joint * 3);
      centre.current?.localToWorld(s.anchor);
      s.anchor.project(camera);
      out[0] = (s.anchor.x * 0.5 + 0.5) * size.width;
      out[1] = (-s.anchor.y * 0.5 + 0.5) * size.height;
    };

    // The hips are needed on every frame, not just on a beat: the fatigue label
    // rides the grind, which is its own channel and can outlast the beat.
    toScreen(J.hipL, s.pt);
    d.hipAX = s.pt[0];
    d.hipAY = s.pt[1];
    toScreen(J.hipR, s.pt);
    d.hipBX = s.pt[0];
    d.hipBY = s.pt[1];

    if (spec) {
      const [p, q] = spec.anchors;
      toScreen(J[p], s.pt);
      d.markAX = s.pt[0];
      d.markAY = s.pt[1];
      toScreen(J[q], s.pt);
      d.markBX = s.pt[0];
      d.markBY = s.pt[1];
    }
  });

  return (
    <group ref={spin}>
      <group ref={centre}>
        {/* No depth guide. A line at knee height is the rule the app judges
            depth by, but drawn here it read as a stray horizontal cutting across
            the shins — and the rep counter already IS the depth feedback, which
            is the product's own position on this. */}
        {BONES.map((_, i) => (
          <mesh
            key={`b${i}`}
            ref={(el) => {
              boneRefs.current[i] = el;
            }}
            scale={[1, 0, 1]}
          >
            <cylinderGeometry args={[0.011, 0.011, 1, 8]} />
            <meshBasicMaterial color={BONE_COLOR} transparent opacity={0.92} />
          </mesh>
        ))}

        {JOINT_NAMES.map((n, i) => (
          <mesh
            key={n}
            ref={(el) => {
              jointRefs.current[i] = el;
            }}
            scale={0}
          >
            <sphereGeometry args={[0.026, 16, 16]} />
            <meshBasicMaterial color={JOINT_COLOR} />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/**
 * A pinned canvas is on screen for seven screens of scroll, so the frameloop is
 * gated on two things: whether the rig is anywhere near the viewport (the rig
 * sets `driver.running`) and whether the tab is visible at all. Polling the
 * driver is deliberate — it is a ref, so there is nothing to subscribe to, and
 * four checks a second is cheaper than routing it through React state.
 */
function useFrameloopGate(driver: MutableRefObject<RigDriver>) {
  const [on, setOn] = useState(true);

  useEffect(() => {
    const sync = () => setOn(driver.current.running && !document.hidden);
    sync();
    document.addEventListener("visibilitychange", sync);
    const id = window.setInterval(sync, 250);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.clearInterval(id);
    };
  }, [driver]);

  return on;
}

export default function PoseSkeleton3D({ driver }: { driver: MutableRefObject<RigDriver> }) {
  const running = useFrameloopGate(driver);

  return (
    <Canvas
      frameloop={running ? "always" : "never"}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
      camera={{ position: [0, 0.86, 4.2], fov: 32 }}
    >
      <Figure driver={driver} />
    </Canvas>
  );
}
