/**
 * TEMPORARY calibration logging for the sagittal shoulder–hip segment-length
 * metric (chest-cave / thoracic-rounding probe). PURELY ADDITIVE — it reads
 * existing values, computes nothing the form pipeline relies on, and is a no-op
 * when DEBUG_SHOULDER_HIP is false.
 * ----------------------------------------------------------------------------
 * Metric under test: Euclidean distance between the shoulder midpoint (11/12)
 * and hip midpoint (23/24) in PIXEL space (normalized x × frameW, y × frameH),
 * normalized to its own value at the set's standing reference. 1.0 = standing
 * length; < 1.0 = compression (rounding/caving).
 *
 * Browser note: a web app can't stream a CSV to disk per frame, so rows are
 * buffered in memory and exported as a timestamped download — automatically when
 * a workout finishes, or on demand via window.__downloadShoulderHipCsv().
 *
 * To switch OFF cleanly after calibration: set DEBUG_SHOULDER_HIP = false. The
 * call sites stay in place but become inert (every function early-returns).
 */
import type { Landmark } from "../pose/landmarks";

/** MASTER TOGGLE — set to false to disable ALL shoulder–hip debug logging. */
export const DEBUG_SHOULDER_HIP = true;

// MediaPipe Pose indices for the four points this metric uses.
const LS = 11; // LEFT_SHOULDER
const RS = 12; // RIGHT_SHOULDER
const LH = 23; // LEFT_HIP
const RH = 24; // RIGHT_HIP

const VIS_MIN = 0.6; // matches MIN_VISIBILITY — gate the standing-reference lock
const STANDING_DEPTH_MAX = 0.06; // depthRatio below this = standing (lock window)

interface Row {
  tMs: number;
  set: number;
  phase: string;
  shNormX: number;
  shNormY: number;
  hipNormX: number;
  hipNormY: number;
  shPx: number;
  shPy: number;
  hipPx: number;
  hipPy: number;
  segLenPx: number;
  segLenRatio: number | null;
  depthRatio: number;
  trunkAngle: number | null;
  visLS: number;
  visRS: number;
  visLH: number;
  visRH: number;
}

// --- Module state (single calibration session) -----------------------------
let rows: Row[] = [];
let frameW = 0;
let frameH = 0;
let lockedSetIndex: number | null = null;
let standingRefLen: number | null = null;
let sessionStamp = "";

/** Filesystem-safe ISO timestamp, e.g. 2026-06-26T14-30-00-000Z. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Record the current detection frame dimensions (pixel space = normalized ×
 * these). Called from the pose pipeline right before it hands the result on.
 */
export function setShoulderHipFrameSize(w: number, h: number): void {
  if (!DEBUG_SHOULDER_HIP) return;
  frameW = w;
  frameH = h;
}

export interface ShoulderHipContext {
  /** Frame timestamp in milliseconds. */
  tMs: number;
  /** The detected person's full landmark array (indices 11/12/23/24 are read). */
  person: readonly Landmark[];
  /** Current rep depth ratio (already computed by the rep tracker). */
  depthRatio: number;
  /** Current trunk lean in degrees, if already computed (else null). */
  trunkAngle: number | null;
  /** Workout phase ("positioning" | "countdown" | "active" | "finished"). */
  phase: string;
  /** 1-based set index. */
  setIndex: number;
}

/**
 * Log one frame. Records only during a set's lifecycle (countdown + active) so
 * the standing reference can be locked before rep 1. The standing reference is
 * locked ONCE per set at the first standing, fully-visible frame; until then the
 * ratio column is null.
 */
export function logShoulderHipFrame(ctx: ShoulderHipContext): void {
  if (!DEBUG_SHOULDER_HIP) return;
  if (ctx.phase !== "countdown" && ctx.phase !== "active") return;

  const p = ctx.person;
  const ls = p[LS];
  const rs = p[RS];
  const lh = p[LH];
  const rh = p[RH];
  if (!ls || !rs || !lh || !rh) return;

  // Raw normalized midpoints.
  const shNormX = (ls.x + rs.x) / 2;
  const shNormY = (ls.y + rs.y) / 2;
  const hipNormX = (lh.x + rh.x) / 2;
  const hipNormY = (lh.y + rh.y) / 2;

  // Pixel-space midpoints + segment length (x × frameW, y × frameH).
  const shPx = shNormX * frameW;
  const shPy = shNormY * frameH;
  const hipPx = hipNormX * frameW;
  const hipPy = hipNormY * frameH;
  const segLenPx = Math.hypot(shPx - hipPx, shPy - hipPy);

  const visOk =
    ls.visibility >= VIS_MIN && rs.visibility >= VIS_MIN && lh.visibility >= VIS_MIN && rh.visibility >= VIS_MIN;

  // New set → clear the standing reference so it re-locks for this set.
  if (ctx.setIndex !== lockedSetIndex) {
    lockedSetIndex = ctx.setIndex;
    standingRefLen = null;
  }
  // Lock the standing reference once, at a standing + fully-visible frame.
  if (standingRefLen === null && visOk && ctx.depthRatio < STANDING_DEPTH_MAX && frameW > 0 && frameH > 0) {
    standingRefLen = segLenPx;
  }
  const segLenRatio = standingRefLen ? segLenPx / standingRefLen : null;

  if (!sessionStamp) sessionStamp = stamp();
  rows.push({
    tMs: Math.round(ctx.tMs),
    set: ctx.setIndex,
    phase: ctx.phase,
    shNormX,
    shNormY,
    hipNormX,
    hipNormY,
    shPx,
    shPy,
    hipPx,
    hipPy,
    segLenPx,
    segLenRatio,
    depthRatio: ctx.depthRatio,
    trunkAngle: ctx.trunkAngle,
    visLS: ls.visibility,
    visRS: rs.visibility,
    visLH: lh.visibility,
    visRH: rh.visibility,
  });
}

const HEADERS = [
  "t_ms",
  "set",
  "phase",
  "sh_norm_x",
  "sh_norm_y",
  "hip_norm_x",
  "hip_norm_y",
  "sh_px",
  "sh_py",
  "hip_px",
  "hip_py",
  "seg_len_px",
  "seg_len_ratio",
  "depth_ratio",
  "trunk_angle_deg",
  "vis_11_LS",
  "vis_12_RS",
  "vis_23_LH",
  "vis_24_RH",
];

/** null → "null"; otherwise fixed-precision (keeps the CSV readable). */
function n(v: number | null, dp: number): string {
  return v === null ? "null" : v.toFixed(dp);
}

function toCsv(): string {
  const lines = [HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.tMs,
        r.set,
        r.phase,
        n(r.shNormX, 5),
        n(r.shNormY, 5),
        n(r.hipNormX, 5),
        n(r.hipNormY, 5),
        n(r.shPx, 2),
        n(r.shPy, 2),
        n(r.hipPx, 2),
        n(r.hipPy, 2),
        n(r.segLenPx, 3),
        n(r.segLenRatio, 4),
        n(r.depthRatio, 4),
        n(r.trunkAngle, 2),
        n(r.visLS, 3),
        n(r.visRS, 3),
        n(r.visLH, 3),
        n(r.visRH, 3),
      ].join(","),
    );
  }
  return lines.join("\n");
}

/**
 * Export the buffered rows as a timestamped CSV download, then clear the buffer
 * so the next session starts fresh. No-op when disabled or empty.
 */
export function downloadShoulderHipCsv(): void {
  if (!DEBUG_SHOULDER_HIP || rows.length === 0 || typeof document === "undefined") return;
  const blob = new Blob([toCsv()], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `neurofit_shoulderhip_${sessionStamp || stamp()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  rows = [];
  sessionStamp = "";
}

// Expose a manual trigger + one-time hint while logging is on.
if (DEBUG_SHOULDER_HIP && typeof window !== "undefined") {
  (window as unknown as { __downloadShoulderHipCsv?: () => void }).__downloadShoulderHipCsv = downloadShoulderHipCsv;
  // eslint-disable-next-line no-console
  console.info(
    "[shoulderHip] DEBUG logging ON — finish a workout to export, or call window.__downloadShoulderHipCsv(). Set DEBUG_SHOULDER_HIP=false to disable.",
  );
}
