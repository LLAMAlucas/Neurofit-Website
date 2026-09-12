/**
 * Webcam + exposure-corrected pose pipeline + fault-colored overlay.
 * ----------------------------------------------------------------------------
 * The webcam → pose → overlay pipeline with the Neuro-Fit robustness layer
 * wired in:
 *
 *   raw <video>  ──▶  sample (tiny canvas) ──▶ luma stats ──▶ exposure decision
 *        │
 *        ▼ drawImage with ctx.filter = correction
 *   procCanvas (the CORRECTED feed, shown to the user)  ──▶ PoseLandmarker
 *        │
 *        ▼ landmarks
 *   overlay canvas (skeleton; knees turn red on valgus)
 *
 * Detecting on the corrected canvas (not the raw video) is the whole point: in
 * bad light the correction keeps the landmarks stable. A correction ON/OFF
 * toggle (the `corrected` prop) is the before/after demo.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  PoseLandmarker,
  type NormalizedLandmark,
  type PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";
import { createPoseLandmarker } from "../pose/poseLandmarker";
import { POSE_LANDMARK_INDEX } from "../pose/landmarks";
import { decideExposure, lumaStats, type ExposureDecision } from "../vision/exposure";
import { setShoulderHipFrameSize } from "../debug/shoulderHipLog";
import { GEMINI } from "../squat/config";

type CameraState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "live" }
  | { status: "error"; message: string };

type PoseState = "loading" | "ready" | "error";

const SAMPLE_W = 80;
const SAMPLE_H = 45;
const EXPOSURE_INTERVAL_MS = 200; // re-assess lighting ~5x/sec

export type CaptureFn = () => string | null;

export function CoachCamera({
  onResult,
  corrected,
  onExposure,
  kneeWarn = false,
  debugGap = null,
  debugValgus = null,
  captureRef,
  children,
}: {
  onResult: (result: PoseLandmarkerResult) => void;
  /** Apply the exposure correction to the detection feed (the before/after toggle). */
  corrected: boolean;
  /** Reports the current (raw-image) exposure decision for the UI readout. */
  onExposure?: (d: ExposureDecision) => void;
  /** Tint the knees red when the form layer flags valgus. */
  kneeWarn?: boolean;
  /** Live hip-vs-knee gap drawn near the hips for depth calibration (null = hide). */
  debugGap?: number | null;
  /** Live knee/ankle ratio drawn near the knees for valgus calibration (null = hide). */
  debugValgus?: number | null;
  /** Parent-owned slot for grabbing a JPEG frame (for the Gemini critique). */
  captureRef: React.MutableRefObject<CaptureFn | null>;
  /** Overlay layer rendered above the feed (countdown / reposition prompts). */
  children?: ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const procRef = useRef<HTMLCanvasElement>(null); // corrected feed (shown)
  const overlayRef = useRef<HTMLCanvasElement>(null); // skeleton
  const sampleRef = useRef<HTMLCanvasElement | null>(null); // tiny luma probe

  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const rafRef = useRef(0);

  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const onExposureRef = useRef(onExposure);
  onExposureRef.current = onExposure;
  const correctedRef = useRef(corrected);
  correctedRef.current = corrected;
  const kneeWarnRef = useRef(kneeWarn);
  kneeWarnRef.current = kneeWarn;
  const debugGapRef = useRef(debugGap);
  debugGapRef.current = debugGap;
  const debugValgusRef = useRef(debugValgus);
  debugValgusRef.current = debugValgus;

  const decisionRef = useRef<ExposureDecision>({
    quality: "good",
    filter: "none",
    gain: 1,
    label: "Lighting OK",
    meanLuma: 130,
  });
  const lastExposureRef = useRef(0);

  const [camera, setCamera] = useState<CameraState>({ status: "idle" });
  const [pose, setPose] = useState<PoseState>("loading");
  const [fps, setFps] = useState(0);
  const [delegate, setDelegate] = useState<"GPU" | "CPU" | null>(null);
  const detCountRef = useRef(0);

  // -- Capture handle: hand a DOWNSCALED JPEG grabber to the parent ---------
  // Downscaled to GEMINI.image resolution/quality (spec Part 2) so both the live
  // Gemini calls and the image buffer get a small 640x480 q0.75 frame.
  const scaleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    captureRef.current = () => {
      const proc = procRef.current;
      if (!proc || proc.width === 0) return null;
      let sc = scaleCanvasRef.current;
      if (!sc) {
        sc = document.createElement("canvas");
        scaleCanvasRef.current = sc;
      }
      sc.width = GEMINI.image.width;
      sc.height = GEMINI.image.height;
      const ctx = sc.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(proc, 0, 0, sc.width, sc.height);
      // strip the "data:image/jpeg;base64," prefix
      return sc.toDataURL("image/jpeg", GEMINI.image.jpegQuality).split(",")[1] ?? null;
    };
    return () => {
      captureRef.current = null;
    };
  }, [captureRef]);

  // -- Camera ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamera({
          status: "error",
          message: "This browser has no camera API. Use a modern browser over https:// or localhost.",
        });
        return;
      }
      setCamera({ status: "starting" });
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {});
        }
        setCamera({ status: "live" });
      } catch (err) {
        setCamera({ status: "error", message: describeCameraError(err) });
      }
    }
    void start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  // -- Pose model -----------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setPose("loading");
    createPoseLandmarker()
      .then(({ landmarker, delegate }) => {
        if (cancelled) {
          landmarker.close();
          return;
        }
        landmarkerRef.current = landmarker;
        setDelegate(delegate);
        setPose("ready");
      })
      .catch((err) => {
        console.error("[pose] failed to initialize", err);
        if (!cancelled) setPose("error");
      });
    return () => {
      cancelled = true;
      landmarkerRef.current?.close();
      landmarkerRef.current = null;
    };
  }, []);

  // -- Detection + draw loop ------------------------------------------------
  useEffect(() => {
    if (camera.status !== "live" || pose !== "ready") return;
    const video = videoRef.current;
    const proc = procRef.current;
    const overlay = overlayRef.current;
    if (!video || !proc || !overlay) return;

    if (!sampleRef.current) {
      sampleRef.current = document.createElement("canvas");
      sampleRef.current.width = SAMPLE_W;
      sampleRef.current.height = SAMPLE_H;
    }

    let lastVideoTime = -1;

    const tick = () => {
      const landmarker = landmarkerRef.current;
      const procCtx = proc.getContext("2d", { willReadFrequently: false });
      const overlayCtx = overlay.getContext("2d");

      if (landmarker && procCtx && overlayCtx && video.readyState >= 2 && video.videoWidth > 0) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (proc.width !== w || proc.height !== h) {
          proc.width = w;
          proc.height = h;
          overlay.width = w;
          overlay.height = h;
        }

        if (video.currentTime !== lastVideoTime) {
          lastVideoTime = video.currentTime;

          // Assess RAW lighting periodically (independent of the correction toggle).
          const now = performance.now();
          if (now - lastExposureRef.current >= EXPOSURE_INTERVAL_MS) {
            lastExposureRef.current = now;
            const sample = sampleRef.current!;
            const sctx = sample.getContext("2d", { willReadFrequently: true });
            if (sctx) {
              sctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
              const { data } = sctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
              const decision = decideExposure(lumaStats(data, 1));
              decisionRef.current = decision;
              onExposureRef.current?.(decision);
            }
          }

          // Draw the (optionally corrected) frame, then detect on it.
          procCtx.filter = correctedRef.current ? decisionRef.current.filter : "none";
          procCtx.drawImage(video, 0, 0, w, h);
          procCtx.filter = "none";

          const result = landmarker.detectForVideo(proc, now);
          detCountRef.current += 1;
          drawCoachPose(overlayCtx, result, kneeWarnRef.current, debugGapRef.current, debugValgusRef.current);
          setShoulderHipFrameSize(proc.width, proc.height); // debug-only, inert when off
          onResultRef.current(result);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [camera.status, pose]);

  // -- FPS sampling ---------------------------------------------------------
  useEffect(() => {
    const id = setInterval(() => {
      setFps(detCountRef.current * 2);
      detCountRef.current = 0;
    }, 500);
    return () => clearInterval(id);
  }, []);

  const overlayMessage = getOverlayMessage(camera, pose);

  return (
    <div className="coach-cam">
      <video ref={videoRef} className="coach-cam__layer" playsInline muted style={{ transform: "scaleX(-1)" }} />
      <canvas ref={procRef} className="coach-cam__layer" style={{ transform: "scaleX(-1)" }} />
      <canvas ref={overlayRef} className="coach-cam__layer" style={{ transform: "scaleX(-1)" }} />

      {overlayMessage && (
        <div className="coach-cam__overlay">
          {overlayMessage.kind === "error" ? (
            <div className="coach-cam__error">
              <p className="coach-cam__error-title">{overlayMessage.title}</p>
              <p>{overlayMessage.body}</p>
            </div>
          ) : (
            <p>{overlayMessage.body}</p>
          )}
        </div>
      )}

      {pose === "ready" && (
        <div className={"fps-badge fps-badge--" + fpsLevel(fps)}>
          {delegate ?? "…"} · {fps} fps
        </div>
      )}

      {camera.status === "live" && pose === "ready" && children}
    </div>
  );
}

// --- Overlay drawing (fault-aware skeleton) ---------------------------------
const VIS_THRESHOLD = 0.5;
const KNEE_INDICES = new Set([POSE_LANDMARK_INDEX.LEFT_KNEE, POSE_LANDMARK_INDEX.RIGHT_KNEE]);
const { LEFT_HIP: HIP_L, RIGHT_HIP: HIP_R, LEFT_KNEE: KNEE_L, RIGHT_KNEE: KNEE_R } = POSE_LANDMARK_INDEX;

function visible(lm: NormalizedLandmark | undefined): boolean {
  return !!lm && (lm.visibility ?? 0) >= VIS_THRESHOLD;
}

function drawCoachPose(
  ctx: CanvasRenderingContext2D,
  result: PoseLandmarkerResult | null,
  kneeWarn: boolean,
  debugGap: number | null,
  debugValgus: number | null,
): void {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  if (!result) return;

  for (const landmarks of result.landmarks) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    for (const { start, end } of PoseLandmarker.POSE_CONNECTIONS) {
      const a = landmarks[start];
      const b = landmarks[end];
      if (!visible(a) || !visible(b)) continue;
      const kneeEdge = KNEE_INDICES.has(start) || KNEE_INDICES.has(end);
      ctx.strokeStyle = kneeWarn && kneeEdge ? "#ff5252" : "#ffffff";
      ctx.beginPath();
      ctx.moveTo(a.x * width, a.y * height);
      ctx.lineTo(b.x * width, b.y * height);
      ctx.stroke();
    }
    landmarks.forEach((lm, i) => {
      if (!visible(lm)) return;
      ctx.fillStyle = kneeWarn && KNEE_INDICES.has(i) ? "#ff5252" : "#00e676";
      ctx.beginPath();
      ctx.arc(lm.x * width, lm.y * height, 3, 0, Math.PI * 2);
      ctx.fill();
    });

    // Calibration readouts next to the relevant joints (hide when null/unseen).
    if (debugGap !== null) {
      const p = jointMid(landmarks, HIP_L, HIP_R, width, height);
      if (p) drawTag(ctx, `gap ${debugGap >= 0 ? "+" : ""}${debugGap.toFixed(2)}`, p[0], p[1], "#7cf2c0");
    }
    if (debugValgus !== null) {
      const p = jointMid(landmarks, KNEE_L, KNEE_R, width, height);
      if (p) drawTag(ctx, `valgus ${debugValgus.toFixed(2)}`, p[0], p[1], "#ffd166");
    }
  }
}

/** Midpoint pixel of two landmarks (or the single visible one), else null. */
function jointMid(
  landmarks: NormalizedLandmark[],
  li: number,
  ri: number,
  width: number,
  height: number,
): [number, number] | null {
  const a = landmarks[li];
  const b = landmarks[ri];
  const va = visible(a);
  const vb = visible(b);
  if (va && vb) return [((a.x + b.x) / 2) * width, ((a.y + b.y) / 2) * height];
  if (va) return [a.x * width, a.y * height];
  if (vb) return [b.x * width, b.y * height];
  return null;
}

/** Draw a label at a canvas point, pre-flipped so it reads correctly under the
 *  overlay's CSS scaleX(-1) mirror. */
function drawTag(ctx: CanvasRenderingContext2D, text: string, px: number, py: number, color: string): void {
  ctx.save();
  ctx.translate(px, py);
  ctx.scale(-1, 1);
  ctx.font = "bold 20px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(0,0,0,0.78)";
  ctx.strokeText(text, 12, 0);
  ctx.fillStyle = color;
  ctx.fillText(text, 12, 0);
  ctx.restore();
}

function fpsLevel(fps: number): "good" | "ok" | "low" {
  if (fps >= 25) return "good";
  if (fps >= 15) return "ok";
  return "low";
}

type Overlay = { kind: "info"; body: string } | { kind: "error"; title: string; body: string };

function getOverlayMessage(camera: CameraState, pose: PoseState): Overlay | null {
  if (camera.status === "error") return { kind: "error", title: "Camera unavailable", body: camera.message };
  if (camera.status === "starting" || camera.status === "idle") return { kind: "info", body: "Requesting camera…" };
  if (pose === "error")
    return { kind: "error", title: "Pose model failed to load", body: "Check your connection and reload." };
  if (pose === "loading") return { kind: "info", body: "Loading pose model…" };
  return null;
}

function describeCameraError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Camera permission denied. Allow camera access and reload.";
      case "NotFoundError":
      case "OverconstrainedError":
        return "No camera found. Check that one is connected.";
      case "NotReadableError":
        return "The camera is in use by another app. Close it and reload.";
      default:
        return `${err.name}: ${err.message}`;
    }
  }
  return err instanceof Error ? err.message : "Unknown camera error.";
}
