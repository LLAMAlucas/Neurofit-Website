import { BONES, J, JOINT_NAMES } from "@/lib/pose";
import { BEAT_SPEC } from "@/lib/poseFrames";
import { SHOTS, SHOT_H, SHOT_W, frameShot, type Shot } from "@/lib/rigShots";

/**
 * The sequence with the motion taken out: the same five reps' worth of argument
 * as four still frames.
 *
 * Reached when the visitor has asked for reduced motion, or when WebGL is
 * unavailable. It renders as SVG from the SAME pose data the 3D scene uses —
 * `poseAt` projected by hand — which is the point: three.js is never fetched on
 * this path, so a scroll-driven camera can't be triggered by a bundle that was
 * downloaded just in case. A scroll-hijacking rotating figure is precisely what
 * `prefers-reduced-motion` exists to suppress, so this is not a lesser version
 * of the page, it is the correct one for that visitor.
 */

function Frame({ shot }: { shot: Shot }) {
  // Poses, camera fit and projection all live in `lib/rigShots` — pure, and
  // therefore checkable offscreen, which is the only reason these frames can be
  // trusted to fit inside their own box.
  const { at: pt } = frameShot(shot);

  const spec = shot.beat ? BEAT_SPEC[shot.beat] : null;
  const lit = new Set(spec?.bones ?? []);
  const marked = new Set(spec?.marked ?? []);

  /* The measured shot gets the same imaginary horizontal the moving version
     draws, because without it a tilted shoulder line in a still frame is just a
     figure standing slightly crooked — the reference is what makes it a reading.
     No degree label here: the number belongs to a camera position this frame
     doesn't have. */
  const level = shot.beat === "unlevel" ? pt(J.shoulderL) : null;
  const levelR = shot.beat === "unlevel" ? pt(J.shoulderR) : null;

  return (
    <svg viewBox={`0 0 ${SHOT_W} ${SHOT_H}`} className="rigfb__svg" aria-hidden="true">
      {/* No knee-height depth guide here either — the only horizontal drawn is
          the one the shoulder reading is measured against, which is a reference
          for a specific number rather than a rule floating across the shins. */}
      <g className="guide">
        {level && levelR && (
          <line
            className="guide__l guide__l--level"
            x1={(Math.min(level[0], levelR[0]) - 26).toFixed(1)}
            y1={((level[1] + levelR[1]) / 2).toFixed(1)}
            x2={(Math.max(level[0], levelR[0]) + 26).toFixed(1)}
            y2={((level[1] + levelR[1]) / 2).toFixed(1)}
          />
        )}
      </g>
      <g className="bones">
        {BONES.map(([a, b], i) => {
          const [x1, y1] = pt(J[a]);
          const [x2, y2] = pt(J[b]);
          return (
            <path
              key={i}
              className={lit.has(i) ? "bone--fault" : marked.has(i) ? "bone--mark" : undefined}
              d={`M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}`}
            />
          );
        })}
      </g>
      <g className="joints">
        {JOINT_NAMES.map((n, i) => {
          const [x, y] = pt(i);
          return <circle key={n} cx={x.toFixed(1)} cy={y.toFixed(1)} r="4" />;
        })}
      </g>
    </svg>
  );
}

export default function RigFallback() {
  return (
    <section className="sec rigfb" aria-labelledby="rigfb-h">
      <div className="shell">
        <header className="sec__head">
          <span className="eyebrow">What it watches for</span>
          <h2 className="h2" id="rigfb-h">
            Five squats, and the three it would have something to say about.
          </h2>
        </header>

        <ol className="rigfb__list">
          {SHOTS.map((shot) => (
            <li key={shot.key} className="rigfb__item">
              <div className="lens rigfb__lens">
                <div className="lens__chrome" aria-hidden="true">
                  <span className="brk brk--tl" />
                  <span className="brk brk--tr" />
                  <span className="brk brk--bl" />
                  <span className="brk brk--br" />
                </div>
                <Frame shot={shot} />
              </div>
              <p className="rigfb__cap">{shot.caption}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
