import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

import GLBoundary from "@/components/GLBoundary";
import { BONES, J, JOINT_COUNT, JOINT_NAMES } from "@/lib/pose";
import { BEAT_SPEC, newPose, poseAt } from "@/lib/poseFrames";
import {
  JUMP_S,
  PLANES_CAM_Y,
  PLANES_CAM_Z,
  PLANES_FOV,
  PLANES_TARGET_Y,
  REST,
  TURN_FOR,
  frontalFor,
  jumpAt,
  rotOf,
  valgusFor,
} from "@/lib/planesView";

/* The same three colours the rig uses, and for the same reason they are hard
   coded there: WebGL materials cannot read var(), and these are the app's
   overlay colours rather than the page's theme. */
const BONE_COLOR = new THREE.Color("#E9ECEC");
const FAULT_COLOR = new THREE.Color("#FF5252");
const JOINT_COLOR = "#00E676";

/** Entrance, mirroring the rig's: limbs draw first, joints snap on top. */
const BONE_START = 0.1;
const BONE_STAGGER = 0.028;
const BONE_DUR = 0.38;
const JOINT_START = 0.34;
const JOINT_STAGGER = 0.03;
const JOINT_DUR = 0.34;
const ENTRANCE_S = JOINT_START + JOINT_COUNT * JOINT_STAGGER + JOINT_DUR;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * The stance marks, written straight by the scene.
 *
 * DOM and not WebGL because they are an IMAGE-SPACE reading — marks held against
 * the picture, which is the only kind of measurement a single camera has. Drawn
 * in the scene they would foreshorten with the body, which is precisely what
 * they are there to be independent of.
 *
 * The hip and knee rules that used to sit opposite these are gone. They were
 * two horizontals across the middle of the figure, and at the size this lens
 * actually renders they read as the frame's own furniture rather than as a
 * measurement — while making the one thing worth watching, a body turning,
 * harder to see. The section's right-hand list already says in words what each
 * view can and cannot resolve.
 */
type Guides = {
  front: SVGGElement | null;
  stanceL: SVGLineElement | null;
  stanceR: SVGLineElement | null;
};

const newGuides = (): Guides => ({ front: null, stanceL: null, stanceR: null });

/** The overlay's own coordinate space. The lens is `aspect-ratio: 1/1`, so a
 *  square viewBox maps linearly onto it at every size and the scene can report
 *  normalised positions without measuring an element. */
const VB = 1000;

function Figure({
  view,
  guides,
  armed,
}: {
  view: "side" | "front";
  guides: MutableRefObject<Guides>;
  armed: boolean;
}) {
  const spin = useRef<THREE.Group>(null);
  const centre = useRef<THREE.Group>(null);
  const boneRefs = useRef<Array<THREE.Mesh | null>>([]);
  const jointRefs = useRef<Array<THREE.Mesh | null>>([]);
  const invalidate = useThree((s) => s.invalidate);

  // Allocated once — see the rig's Figure for why per-frame Vector3s are a real
  // cost rather than a tidiness question.
  const s = useMemo(
    () => ({
      pose: newPose(),
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0),
      quat: new THREE.Quaternion(),
      anchor: new THREE.Vector3(),
      colour: new THREE.Color(),
      pa: [0, 0] as [number, number],
      pb: [0, 0] as [number, number],
      /* Where the figure is standing now, and the jump it is in the middle of.
         Starts side-on so the first frame agrees with the section's initial tab
         instead of jumping into it as the reader arrives. */
      facing: TURN_FOR.side as number,
      from: TURN_FOR.side as number,
      to: TURN_FOR.side as number,
      jumpT: -1,
      t0: -1,
    }),
    [],
  );

  /* Nothing renders unless something asks for it. A tab press and the arrival of
     the section are the only two things that ever do. */
  useEffect(() => {
    invalidate();
  }, [view, armed, invalidate]);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1); // a backgrounded tab resumes with a huge delta
    if (s.t0 < 0) s.t0 = state.clock.elapsedTime;
    const age = armed ? state.clock.elapsedTime - s.t0 : 0;

    /* A jump, once committed to, is seen through.
       Pressing the other tab mid-air does not reverse the body — there is
       nothing to push against, which is the whole premise of the flight phase —
       so the new target is simply what it jumps to next, off the landing. That
       is also what a person does, and it means hammering the toggle produces a
       sequence of jumps rather than a figure that stutters in place. */
    const target = TURN_FOR[view];
    if (s.jumpT < 0 && s.facing !== target) {
      s.from = s.facing;
      s.to = target;
      s.jumpT = 0;
    }

    let j = REST;
    if (s.jumpT >= 0) {
      s.jumpT += dt;
      j = jumpAt(s.jumpT);
      if (s.jumpT >= JUMP_S) {
        s.facing = s.to;
        s.jumpT = -1;
        j = REST;
      }
    }

    const rotY = s.jumpT >= 0 ? mix(rotOf(s.from), rotOf(s.to), j.turn) : rotOf(s.facing);
    poseAt(j.depth, "valgus", valgusFor(j.depth), s.pose);

    if (spin.current) {
      spin.current.rotation.y = rotY;
      // The whole body leaves the floor. `poseAt` pins the ankles and toes in
      // its own space by design, so a jump can only be a translation of the
      // thing they are pinned in — which is also why the feet stay together
      // relative to the hips all the way up.
      spin.current.position.y = j.y;
    }

    /* Aimed at the body's mid-height every frame, not left at the default. R3F
       points the default camera at the world ORIGIN, which here is the floor
       between the feet — the figure came out sitting in the top half of the lens
       with an empty half beneath it. It does NOT follow the body up: a camera
       that tracked the jump would cancel the jump. */
    state.camera.position.set(0, PLANES_CAM_Y, PLANES_CAM_Z);
    state.camera.lookAt(0, PLANES_TARGET_Y, 0);

    // Spin about the body's own centroid, not the world origin: the hips sit
    // back and the knees reach forward, so spinning about origin swings the
    // whole figure sideways out of the frame.
    let cz = 0;
    for (let i = 0; i < JOINT_COUNT; i++) cz += s.pose[i * 3 + 2];
    if (centre.current) centre.current.position.z = -cz / JOINT_COUNT;

    for (let i = 0; i < BONES.length; i++) {
      const m = boneRefs.current[i];
      if (!m) continue;
      const [an, bn] = BONES[i];
      s.a.fromArray(s.pose, J[an] * 3);
      s.b.fromArray(s.pose, J[bn] * 3);
      s.dir.subVectors(s.b, s.a);
      const len = s.dir.length();

      m.position.addVectors(s.a, s.b).multiplyScalar(0.5);
      m.quaternion.copy(s.quat.setFromUnitVectors(s.up, s.dir.divideScalar(len)));

      const grow = clamp01((age - (BONE_START + i * BONE_STAGGER)) / BONE_DUR);
      m.scale.y = len * easeOut(grow);
      m.visible = grow > 0;
    }

    /* The red is on the CAMERA, not on the body.
       The shins are caved at both facings; the colour that says so is gated on
       the camera being square enough to the frontal plane to have read it. Land
       side-on and the fault is still there and the app has stopped claiming it,
       which is the section's whole argument stated in one channel. */
    const frontal = frontalFor(rotY);
    for (const i of BEAT_SPEC.valgus.bones) {
      const m = boneRefs.current[i];
      if (!m) continue;
      (m.material as THREE.MeshBasicMaterial).color.copy(
        s.colour.copy(BONE_COLOR).lerp(FAULT_COLOR, frontal),
      );
      m.scale.x = m.scale.z = 1 + 0.5 * frontal;
    }

    for (let i = 0; i < JOINT_COUNT; i++) {
      const m = jointRefs.current[i];
      if (!m) continue;
      m.position.fromArray(s.pose, i * 3);
      const p = clamp01((age - (JOINT_START + i * JOINT_STAGGER)) / JOINT_DUR);
      m.scale.setScalar(p === 0 ? 0 : easeOut(p) * (1 + 0.32 * Math.sin(Math.PI * p)));
      m.visible = p > 0;
    }

    paintGuides(frontal, state.camera);

    /* Keep asking for frames only while something is still moving. The figure is
       static between jumps, and a canvas repainting an unchanging picture sixty
       times a second is the reason this runs on demand at all. */
    if (s.jumpT >= 0 || s.facing !== target || (armed && age < ENTRANCE_S)) invalidate();
  });

  /** Project a joint into the overlay's coordinate space. The canvas fills the
   *  square lens exactly, so NDC maps straight onto the viewBox. */
  const project = (joint: number, camera: THREE.Camera, out: [number, number]) => {
    s.anchor.fromArray(s.pose, joint * 3);
    // `centre` is a child of `spin`, so its matrixWorld already carries both the
    // turn and the jump — transforming through both would apply them twice.
    centre.current?.localToWorld(s.anchor);
    s.anchor.project(camera);
    out[0] = (s.anchor.x * 0.5 + 0.5) * VB;
    out[1] = (-s.anchor.y * 0.5 + 0.5) * VB;
  };

  const paintGuides = (frontal: number, camera: THREE.Camera) => {
    const g = guides.current;
    if (g.front) g.front.setAttribute("opacity", frontal.toFixed(3));
    // Positioned even while hidden: they hang off joints that move, so marks
    // only placed when they became visible would arrive at wherever the body
    // had been the last time anyone looked.
    project(J.ankleL, camera, s.pa);
    project(J.ankleR, camera, s.pb);
    setStance(g.stanceL, s.pa[0], s.pa[1]);
    setStance(g.stanceR, s.pb[0], s.pb[1]);
  };

  /** The marks hang off the ankles and run down past the floor — they are the
   *  width the lifter is standing at, which is a frontal quantity and collapses
   *  to nothing edge-on. */
  const setStance = (line: SVGLineElement | null, x: number, y: number) => {
    if (!line) return;
    line.setAttribute("x1", x.toFixed(1));
    line.setAttribute("x2", x.toFixed(1));
    line.setAttribute("y1", (y - 210).toFixed(1));
    line.setAttribute("y2", (y + 40).toFixed(1));
  };

  return (
    <group ref={spin}>
      <group ref={centre}>
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
 * One body, one fixed camera, and the body jumps to change which way it faces.
 *
 * Replaces two flat drawings that cross-faded. The drawings could not make the
 * section's argument — they were two different pictures, so nothing stopped a
 * reader assuming the app sees both and picks what to mention. Here the knees
 * are caved the whole time and the reader can turn them away from the lens.
 */
export default function PlanesFigure({
  view,
  onFail,
}: {
  view: "side" | "front";
  onFail: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const guides = useRef<Guides>(newGuides());
  const [near, setNear] = useState(false);

  /* The section sits well below the fold, so nothing renders until it is nearly
     on screen — and the entrance is keyed off the same moment, so the figure
     draws itself in as the reader arrives rather than having happened while they
     were four screens away. */
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    /* Two independent conditions, so the observer's answer is REMEMBERED rather
       than recomputed from the DOM when the tab comes back. Asking "does the
       element have a height" on visibilitychange answers a different question —
       it is true four screens away — and would have woken the scene up for a
       reader who returned to the tab somewhere else on the page. */
    let inView = false;
    const sync = () => setNear(inView && !document.hidden);
    const io = new IntersectionObserver(
      ([e]) => {
        inView = e.isIntersecting;
        sync();
      },
      { rootMargin: "20% 0px" },
    );
    io.observe(el);
    document.addEventListener("visibilitychange", sync);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  const ref =
    <K extends keyof Guides>(k: K) =>
    (el: Guides[K]) => {
      guides.current[k] = el;
    };

  return (
    <div className="planes__gl" ref={host}>
      <Canvas
        frameloop={near ? "demand" : "never"}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        camera={{ position: [0, PLANES_CAM_Y, PLANES_CAM_Z], fov: PLANES_FOV }}
      >
        <GLBoundary onFail={onFail}>
          <Figure view={view} guides={guides} armed={near} />
        </GLBoundary>
      </Canvas>

      {/* Same classes as the flat version's overlay, so the marks are the same
          ink wherever they are drawn. */}
      <svg className="skel planes__guides" viewBox={`0 0 ${VB} ${VB}`} aria-hidden="true">
        <g className="guide" ref={ref("front")} opacity="0">
          <line className="guide__l guide__l--v" ref={ref("stanceL")} />
          <line className="guide__l guide__l--v" ref={ref("stanceR")} />
        </g>
      </svg>
    </div>
  );
}
