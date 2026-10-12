/**
 * MediaPipe Tasks — PoseLandmarker setup (browser: the live coach and Analyze).
 * ----------------------------------------------------------------------------
 * Produces a configured PoseLandmarker (VIDEO mode by default). The raw landmark
 * stream it yields is what the pure squat/vision/analyze modules consume.
 *
 * WASM + models are vendored locally under public/ (no third-party CDN at
 * runtime). WASM copied from node_modules/@mediapipe/tasks-vision/wasm; the lite
 * and full models downloaded from Google (storage.googleapis.com/mediapipe-models).
 */
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

const WASM_BASE = `${import.meta.env.BASE_URL}mediapipe/wasm`;

/** Lite model: lowest latency, good enough for live feedback. Full model: ~1.6× the size and
 *  slower, but steadier points — used by Analyze, where a recorded clip has no live deadline. */
const MODEL_URL = {
  lite: `${import.meta.env.BASE_URL}models/pose_landmarker_lite.task`,
  full: `${import.meta.env.BASE_URL}models/pose_landmarker_full.task`,
} as const;

export type Delegate = "GPU" | "CPU";

export interface PoseLandmarkerOptions {
  /** VIDEO (default) tracks between frames and needs strictly increasing timestamps; IMAGE
   *  detects each call from scratch — what a paused, scrubbed frame needs. */
  runningMode?: "VIDEO" | "IMAGE";
  model?: keyof typeof MODEL_URL;
}

/**
 * Create a PoseLandmarker (VIDEO mode + lite model unless told otherwise — the live coach
 * calls it with no options). Tries the GPU delegate first (fast), falling back to CPU if GPU
 * init fails (some drivers / headless contexts).
 */
export async function createPoseLandmarker(opts: PoseLandmarkerOptions = {}): Promise<{
  landmarker: PoseLandmarker;
  delegate: Delegate;
}> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);

  const build = (delegate: Delegate) =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL[opts.model ?? "lite"], delegate },
      runningMode: opts.runningMode ?? "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

  try {
    return { landmarker: await build("GPU"), delegate: "GPU" };
  } catch (gpuErr) {
    console.warn("[pose] GPU delegate failed, falling back to CPU.", gpuErr);
    return { landmarker: await build("CPU"), delegate: "CPU" };
  }
}
