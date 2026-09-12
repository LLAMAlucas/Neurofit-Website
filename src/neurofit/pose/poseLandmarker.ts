/**
 * MediaPipe Tasks — PoseLandmarker setup (browser, live feedback).
 * ----------------------------------------------------------------------------
 * Produces a configured PoseLandmarker running in VIDEO mode. The raw landmark
 * stream it yields is what the pure squat/vision modules consume.
 *
 * WASM + model are vendored locally under public/ (no third-party CDN at
 * runtime). WASM copied from node_modules/@mediapipe/tasks-vision/wasm; the lite
 * model downloaded from Google.
 */
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

const WASM_BASE = `${import.meta.env.BASE_URL}mediapipe/wasm`;

/** Lite model: lowest latency, good enough for live feedback. */
const MODEL_URL = `${import.meta.env.BASE_URL}models/pose_landmarker_lite.task`;

export type Delegate = "GPU" | "CPU";

/**
 * Create a PoseLandmarker in VIDEO mode. Tries the GPU delegate first (fast),
 * falling back to CPU if GPU init fails (some drivers / headless contexts).
 */
export async function createPoseLandmarker(): Promise<{
  landmarker: PoseLandmarker;
  delegate: Delegate;
}> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);

  const build = (delegate: Delegate) =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
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
