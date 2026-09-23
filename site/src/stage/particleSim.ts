/**
 * The particles' physics, on the GPU. Every particle is one texel, and it has a
 * real offset and velocity that carry over from frame to frame.
 *
 * The previous version displaced particles as a pure function of a screen-space
 * field, so nothing ever travelled: a swipe dented the body and the dent healed.
 * Studying igloo.inc's hologram frame by frame, what makes that one feel
 * physical is exactly what a stateless displacement can't do — a thrown
 * particle keeps flying after the cursor has gone, piles up against the glass it
 * is thrown at, falls, swirls, and only later flows home. The rules themselves
 * are in simStep.frag.glsl.
 *
 * Two passes a frame, each one texel per particle:
 *  skin — its home on the posed body, and its normal;
 *  step — its offset from home (+ heat), its velocity, and how much of the
 *         cursor's hold on it is used up, advanced by dt.
 * The body's points are drawn at home + offset. A third pass, seed, runs only
 * when asked: it scatters every particle into the fog, and the step pass's pull
 * home then assembles the body out of it.
 */
import {
  DataTexture,
  FloatType,
  GLSL3,
  HalfFloatType,
  Matrix4,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type Texture,
  type WebGLRenderer,
} from "three";

import type { SampledPoints } from "@/lib/sampleSkinned";
import skinShader from "./shaders/simSkin.frag.glsl?raw";
import stepShader from "./shaders/simStep.frag.glsl?raw";
import seedShader from "./shaders/simSeed.frag.glsl?raw";

export type SimParams = {
  /** Share of the swipe's speed a particle picks up. */
  force: number;
  /** Random share of a throw — how much a stream fans out. */
  spray: number;
  /** Brush radius, in screen heights. */
  brush: number;
  /** Seconds a fully hot particle stays hot (free, glowing). */
  heat: number;
  /** Air drag in flight, 1/s. */
  drag: number;
  /** m/s² on particles in flight. */
  gravity: number;
  /** Turbulence on particles in flight, m/s². */
  swirl: number;
  /** How hard home pulls once a particle cools, rad/s. */
  pull: number;
  /** How far the idle current carries a particle around its home, metres. */
  flow: number;
  /** How fast the idle current changes. */
  churn: number;
  /** How far a loose surface grain lifts off, metres. */
  fizz: number;
  walls: boolean;
  /** The container's half-width, metres. */
  room: number;
};

/** One frame of the cursor, in NDC with x scaled by the aspect ratio. */
export type Cursor = { from: Vector2; to: Vector2; vel: Vector2; active: boolean };

export type Skin = { boneTexture: Texture; bindMatrix: Matrix4; bindMatrixInverse: Matrix4 };

/** Where `seed()` scatters the particles from. */
export type Scatter = {
  /** The cloud's centre, in the body's space (metres). */
  centre: [number, number, number];
  /** Inner and outer radius of the cloud, metres. */
  near: number;
  far: number;
  /** Hottest a particle starts, 0…1: how long it drifts free before home takes hold. */
  heat: number;
  /** How fast the cloud turns about the vertical, rad/s. */
  spin: number;
  /** Seconds between the first grain being let go and the last. */
  stagger: number;
  /** 0 = grains let go at random, 1 = from the feet up. */
  rise: number;
};

/** Longest sub-step, seconds. A long frame is split, never taken in one jump. */
const MAX_STEP = 1 / 60;
const MAX_STEPS = 4;
/** The container's height, metres: well over the head, so a throw upward lands. */
const ROOM_HEIGHT = 2.4;
/** Seconds after the LAST grain is let go that the glass walls stay down. The
 *  cloud starts outside them, and a wall that came up around it would pin every
 *  grain to the glass; by the time they're back, the body has formed inside. */
const FORMING_S = 3;

const QUAD_VERTEX = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export class ParticleSim {
  readonly width: number;
  readonly height: number;
  /** Per particle: the texel it lives in, for the draw's `aSimUv`. */
  readonly uvs: Float32Array;

  private readonly data: DataTexture[];
  private home: WebGLRenderTarget;
  private homePrev: WebGLRenderTarget;
  private read: WebGLRenderTarget;
  private write: WebGLRenderTarget;
  private readonly skin: ShaderMaterial;
  private readonly step: ShaderMaterial;
  private readonly scatter: ShaderMaterial;
  private pendingSeed: Scatter | null = null;
  /** Seconds simulated so far — not wall time: a slow frame is clamped, and
   *  the walls must wait for the body to have formed, not for a clock. */
  private simTime = 0;
  private wallsFrom = -Infinity;
  private readonly quad: Mesh;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private primed = false;
  private readonly eye = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly toBody = new Matrix4();

  constructor(gl: WebGLRenderer, points: SampledPoints, rig: Skin) {
    const count = points.seed.length;
    this.width = Math.ceil(Math.sqrt(count));
    this.height = Math.ceil(count / this.width);
    const texels = this.width * this.height;

    this.uvs = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      this.uvs[i * 2] = ((i % this.width) + 0.5) / this.width;
      this.uvs[i * 2 + 1] = (Math.floor(i / this.width) + 0.5) / this.height;
    }

    const pack = (fill: (out: Float32Array, i: number) => void) => {
      const out = new Float32Array(texels * 4);
      for (let i = 0; i < count; i++) fill(out, i);
      const t = new DataTexture(out, this.width, this.height, RGBAFormat, FloatType);
      t.minFilter = t.magFilter = NearestFilter;
      t.needsUpdate = true;
      return t;
    };
    const { position, normal, skinIndex, skinWeight, seed, depth } = points;
    this.data = [
      pack((o, i) => o.set([position[i * 3], position[i * 3 + 1], position[i * 3 + 2], seed[i]], i * 4)),
      pack((o, i) => o.set([normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2], depth[i]], i * 4)),
      pack((o, i) => o.set(skinIndex.subarray(i * 4, i * 4 + 4), i * 4)),
      pack((o, i) => o.set(skinWeight.subarray(i * 4, i * 4 + 4), i * 4)),
    ];

    // Full float where the GPU can render to it. Half float would put home
    // positions on a ~1 mm grid, which is still fine to look at.
    const type = gl.extensions.has("EXT_color_buffer_float") ? FloatType : HalfFloatType;
    const target = (count: number) =>
      new WebGLRenderTarget(this.width, this.height, {
        count,
        type,
        format: RGBAFormat,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        depthBuffer: false,
      });
    this.home = target(2);
    this.homePrev = target(2);
    // Offset + heat, velocity + wait, grip. Zero-initialised: every particle
    // starts at home, at rest, with no stroke holding it.
    this.read = target(3);
    this.write = target(3);

    this.skin = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: QUAD_VERTEX,
      fragmentShader: skinShader,
      uniforms: {
        uBoneTexture: { value: rig.boneTexture },
        // Shared references: the SkinnedMesh keeps these current, so do we.
        uBindMatrix: { value: rig.bindMatrix },
        uBindMatrixInverse: { value: rig.bindMatrixInverse },
        tRest: { value: this.data[0] },
        tRestNormal: { value: this.data[1] },
        tSkinIndex: { value: this.data[2] },
        tSkinWeight: { value: this.data[3] },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.step = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: QUAD_VERTEX,
      fragmentShader: stepShader,
      uniforms: {
        tOffset: { value: null },
        tVelocity: { value: null },
        tHome: { value: null },
        tHomePrev: { value: null },
        tNormal: { value: null },
        tGrip: { value: null },
        uDt: { value: MAX_STEP },
        uTime: { value: 0 },
        uFirst: { value: 0 },
        uHit: { value: 0 },
        uViewProj: { value: new Matrix4() },
        uCamPos: { value: this.eye },
        uCamRight: { value: this.right },
        uCamUp: { value: this.up },
        uTanHalfFov: { value: 0.27 },
        uAspect: { value: 1 },
        uFrom: { value: new Vector2() },
        uTo: { value: new Vector2() },
        uCursorVel: { value: new Vector2() },
        uBrush: { value: 0.08 },
        uForce: { value: 0.6 },
        uSpray: { value: 0.4 },
        uHeatLife: { value: 2 },
        uDrag: { value: 1.2 },
        uGravity: { value: 3 },
        uSwirl: { value: 2 },
        uPull: { value: 3 },
        uFlow: { value: 0.012 },
        uChurn: { value: 0.5 },
        uFizz: { value: 0.03 },
        uWalls: { value: 1 },
        uBoxMin: { value: new Vector3() },
        uBoxMax: { value: new Vector3() },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.scatter = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: QUAD_VERTEX,
      fragmentShader: seedShader,
      uniforms: {
        tHome: { value: null },
        uCentre: { value: new Vector3() },
        uNear: { value: 1 },
        uFar: { value: 3 },
        uHeat: { value: 0 },
        uSpin: { value: 0 },
        uAway: { value: new Vector3(0, 0, 1) },
        uStagger: { value: 0 },
        uRise: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new Mesh(new PlaneGeometry(2, 2), this.skin);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /** Home position (xyz) and seed (w), this frame. */
  get homeTexture(): Texture {
    return this.home.textures[0];
  }
  /** Skinned normal (xyz) and depth into the body (w), this frame. */
  get normalTexture(): Texture {
    return this.home.textures[1];
  }
  /** Offset from home (xyz) and heat (w). */
  get offsetTexture(): Texture {
    return this.read.textures[0];
  }

  /**
   * Scatter every particle into the fog on the next `update()`. The body then
   * forms on its own, pulled home by the same physics that heals a swipe.
   */
  seed(scatter: Scatter): void {
    this.pendingSeed = scatter;
  }

  /**
   * Advance the whole system by `dt` seconds. Call after the skeleton has been
   * posed for this frame, with the camera about to render it. `model` is the
   * points' world matrix — the space homes, walls and floor all live in.
   */
  update(
    gl: WebGLRenderer,
    dt: number,
    time: number,
    camera: PerspectiveCamera,
    model: Matrix4,
    aspect: number,
    cursor: Cursor,
    p: SimParams,
  ): void {
    const previous = gl.getRenderTarget();

    // Skin: this frame's homes, keeping last frame's for how far the body moved.
    [this.home, this.homePrev] = [this.homePrev, this.home];
    this.quad.material = this.skin;
    gl.setRenderTarget(this.home);
    gl.render(this.scene, this.camera);

    const u = this.step.uniforms;
    camera.updateMatrixWorld();
    (u.uViewProj.value as Matrix4).multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(model);
    // The camera, in the space the particles live in.
    this.toBody.copy(model).invert();
    this.eye.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(this.toBody);
    this.right.setFromMatrixColumn(camera.matrixWorld, 0).transformDirection(this.toBody);
    this.up.setFromMatrixColumn(camera.matrixWorld, 1).transformDirection(this.toBody);

    // Seed: straight into the state the step is about to read.
    if (this.pendingSeed) {
      const sc = this.pendingSeed;
      const su = this.scatter.uniforms;
      su.tHome.value = this.home.textures[0];
      (su.uCentre.value as Vector3).set(...sc.centre);
      su.uNear.value = sc.near;
      su.uFar.value = Math.max(sc.near, sc.far);
      su.uHeat.value = sc.heat;
      su.uSpin.value = sc.spin;
      su.uStagger.value = Math.max(0, sc.stagger);
      su.uRise.value = sc.rise;
      const away = (su.uAway.value as Vector3).set(this.eye.x - sc.centre[0], 0, this.eye.z - sc.centre[2]);
      if (away.lengthSq() < 1e-6) away.set(0, 0, 1);
      away.normalize();
      this.quad.material = this.scatter;
      gl.setRenderTarget(this.read);
      gl.render(this.scene, this.camera);
      this.pendingSeed = null;
      this.wallsFrom = this.simTime + Math.max(0, sc.stagger) + FORMING_S;
    }

    u.uTanHalfFov.value = Math.tan(((camera.fov * Math.PI) / 180) / 2);
    u.uAspect.value = aspect;
    u.uHit.value = cursor.active ? 1 : 0;
    (u.uFrom.value as Vector2).copy(cursor.from);
    (u.uTo.value as Vector2).copy(cursor.to);
    (u.uCursorVel.value as Vector2).copy(cursor.vel);
    u.uBrush.value = p.brush;
    u.uForce.value = p.force;
    u.uSpray.value = p.spray;
    u.uHeatLife.value = Math.max(0.05, p.heat);
    u.uDrag.value = p.drag;
    u.uGravity.value = p.gravity;
    u.uSwirl.value = p.swirl;
    u.uPull.value = p.pull;
    u.uFlow.value = p.flow;
    u.uChurn.value = p.churn;
    u.uFizz.value = p.fizz;
    this.simTime += dt;
    u.uWalls.value = p.walls && this.simTime >= this.wallsFrom ? 1 : 0;
    (u.uBoxMin.value as Vector3).set(-p.room, 0, -p.room);
    (u.uBoxMax.value as Vector3).set(p.room, ROOM_HEIGHT, p.room);
    u.tHome.value = this.home.textures[0];
    u.tHomePrev.value = (this.primed ? this.homePrev : this.home).textures[0];
    u.tNormal.value = this.home.textures[1];
    this.primed = true;

    // Step, split evenly so a 120 Hz screen runs the same physics as a 60 Hz one.
    const steps = Math.min(MAX_STEPS, Math.max(1, Math.ceil(dt / MAX_STEP - 1e-6)));
    u.uDt.value = dt / steps;
    this.quad.material = this.step;
    for (let i = 0; i < steps; i++) {
      u.uTime.value = time - dt + ((i + 1) * dt) / steps;
      u.uFirst.value = i === 0 ? 1 : 0;
      u.tOffset.value = this.read.textures[0];
      u.tVelocity.value = this.read.textures[1];
      u.tGrip.value = this.read.textures[2];
      gl.setRenderTarget(this.write);
      gl.render(this.scene, this.camera);
      [this.read, this.write] = [this.write, this.read];
    }

    gl.setRenderTarget(previous);
  }

  /**
   * Read the whole state back and summarise it — for checking the physics by
   * number in the lab, not for use per frame (it stalls the GPU).
   */
  /** The whole offset state (xyz offset, w heat), read back — dev only, it
   *  stalls the GPU. */
  readOffsets(gl: WebGLRenderer): Float32Array {
    const out = new Float32Array(this.width * this.height * 4);
    gl.readRenderTargetPixels(this.read, 0, 0, this.width, this.height, out);
    return out;
  }

  probe(gl: WebGLRenderer, count: number, room: number) {
    const texels = this.width * this.height;
    const offset = new Float32Array(texels * 4);
    const home = new Float32Array(texels * 4);
    gl.readRenderTargetPixels(this.read, 0, 0, this.width, this.height, offset);
    gl.readRenderTargetPixels(this.home, 0, 0, this.width, this.height, home);
    let maxOffset = 0;
    let sumOffset = 0;
    let out = 0;
    let hot = 0;
    let maxHeat = 0;
    let belowFloor = 0;
    let throughWall = 0;
    for (let i = 0; i < count; i++) {
      const [dx, dy, dz, heat] = offset.subarray(i * 4, i * 4 + 4);
      const d = Math.hypot(dx, dy, dz);
      maxOffset = Math.max(maxOffset, d);
      sumOffset += d;
      if (d > 0.01) out++;
      if (heat > 0.05) hot++;
      maxHeat = Math.max(maxHeat, heat);
      const [hx, hy, hz] = home.subarray(i * 4, i * 4 + 3);
      const [x, y, z] = [hx + dx, hy + dy, hz + dz];
      if (y < Math.min(0, hy) - 1e-4) belowFloor++;
      const bx = Math.max(room, Math.abs(hx)) + 1e-4;
      const bz = Math.max(room, Math.abs(hz)) + 1e-4;
      if (Math.abs(x) > bx || Math.abs(z) > bz) throughWall++;
    }
    return { maxOffset, meanOffset: sumOffset / count, out, hot, maxHeat, belowFloor, throughWall };
  }

  dispose(): void {
    for (const t of this.data) t.dispose();
    for (const rt of [this.home, this.homePrev, this.read, this.write]) rt.dispose();
    this.skin.dispose();
    this.step.dispose();
    this.scatter.dispose();
    this.quad.geometry.dispose();
  }
}
