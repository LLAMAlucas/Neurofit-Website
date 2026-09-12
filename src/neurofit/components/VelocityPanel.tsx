/**
 * Per-rep concentric velocity bars + the rep-quality degradation flag.
 * The degradation flag is what triggers the AI critique, so this panel makes the
 * trigger visible: bars shrink as the lifter slows, and a flagged rep is marked.
 */
import type { VelocitySample } from "../squat/velocity";

export function VelocityPanel({
  samples,
  best,
}: {
  samples: VelocitySample[];
  best: number | null;
}) {
  const scale = best && best > 0 ? best : 1;

  return (
    <section className="panel">
      <p className="panel__title">REP VELOCITY</p>
      {samples.length === 0 ? (
        <p className="panel__empty">Concentric (rising) speed per rep appears here.</p>
      ) : (
        <>
          <div className="vbars">
            {samples.map((s) => {
              const pct = Math.max(6, Math.min(100, (s.velocity / scale) * 100));
              return (
                <div className="vbar" key={s.index} title={`rep ${s.index}: ${s.velocity.toFixed(3)} u/s`}>
                  <div className="vbar__track">
                    <div
                      className={"vbar__fill" + (s.degraded ? " vbar__fill--degraded" : "")}
                      style={{ height: pct + "%" }}
                    />
                  </div>
                  <span className="vbar__num">{s.index}</span>
                </div>
              );
            })}
          </div>
          <p className="panel__foot">
            {flaggedNote(samples)} · best {best ? best.toFixed(3) : "—"} u/s
          </p>
        </>
      )}
    </section>
  );
}

function flaggedNote(samples: VelocitySample[]): string {
  const last = samples[samples.length - 1];
  if (last?.degraded && last.ratio !== null) {
    return `rep ${last.index} slowed ${Math.round((1 - last.ratio) * 100)}% — quality dropping`;
  }
  return "rep speed steady";
}
