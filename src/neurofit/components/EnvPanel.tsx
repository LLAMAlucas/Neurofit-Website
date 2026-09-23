/**
 * Environmental-robustness panel — the demo's "white space."
 * Shows the detected lighting + camera-angle state and lets the user toggle the
 * exposure correction ON/OFF for a live before/after comparison.
 */
import type { ExposureDecision } from "../vision/exposure";
import type { CameraAngleEstimate } from "../vision/cameraAngle";

export function EnvPanel({
  exposure,
  camera,
  corrected,
  onToggleCorrected,
  exercise = "squat",
}: {
  exposure: ExposureDecision | null;
  camera: CameraAngleEstimate | null;
  corrected: boolean;
  onToggleCorrected: (v: boolean) => void;
  /** The knee-visibility footnote only applies to squats. */
  exercise?: "squat" | "pushup" | "pullup";
}) {
  return (
    <section className="panel">
      <p className="panel__title">ENVIRONMENT</p>

      <div className="env-row">
        <span className="env-row__label">Lighting</span>
        <span className={"env-badge env-badge--" + (exposure?.quality ?? "good")}>
          {exposure ? exposure.label : "—"}
        </span>
      </div>
      <div className="env-meter" title="mean image brightness">
        <div className="env-meter__fill" style={{ width: lumaPct(exposure) + "%" }} />
      </div>

      <label className="env-toggle">
        <input
          type="checkbox"
          checked={corrected}
          onChange={(e) => onToggleCorrected(e.target.checked)}
        />
        <span>Exposure correction {corrected ? "ON" : "OFF"}</span>
      </label>

      <div className="env-row env-row--mt">
        <span className="env-row__label">Camera</span>
        <span className={"env-badge env-badge--" + (camera?.view ?? "unknown")}>
          {camera ? camera.label : "—"}
        </span>
      </div>
      {exercise === "squat" && camera?.view === "side" && (
        <p className="panel__foot">Turn more toward the camera so both knees are visible for valgus checks.</p>
      )}
    </section>
  );
}

function lumaPct(e: ExposureDecision | null): number {
  if (!e) return 0;
  return Math.round((Math.min(255, Math.max(0, e.meanLuma)) / 255) * 100);
}
