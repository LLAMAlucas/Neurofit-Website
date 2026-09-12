import type { CSSProperties } from "react";

/** Joint positions for the side-on figure, shared by the ping rings and the
 *  joint dots so the two stay registered. `--i` staggers each joint's lock-on. */
const JOINTS: Array<[number, number]> = [
  [118, 44],
  [100, 74],
  [108, 106],
  [124, 128],
  [84, 146],
  [104, 200],
  [88, 252],
];

const idx = (i: number) => ({ "--i": i }) as CSSProperties;

/**
 * @param rig When the 3D sequence is running, the lens here is only a
 *   PLACEHOLDER: it holds the layout and supplies the rect the fixed canvas
 *   clips itself to, and `SquatRig` draws the chrome, the figure and the
 *   readouts on top of it. When the rig is off — reduced motion, or no WebGL —
 *   this renders the original 2D lens in full, unchanged.
 */
export function Hero({ rig }: { rig: boolean }) {
  return (
    <section className="hero" id="top">
      <div className="shell hero__grid">
        <div className="hero__copy">
          <h1 className="h1">
            <span className="ln">
              <span>You can’t see</span>
            </span>
            <span className="ln">
              <span>your own squat.</span>
            </span>
          </h1>
          <p className="lede rise" data-d="3">
            Neuro-Fit watches you through your phone camera and tells you what your form actually
            did. Prop the phone against something, do your set, and get a plain read on it — after
            the set, and again at the end of the workout.
          </p>
        </div>

        {/* The lens: the only dark surface on the page is what the camera sees */}
        <figure className="hero__lens rise" data-d="4">
          {rig ? (
            <div className="lens" data-lens-anchor />
          ) : (
            <div className="lens">
              <div className="lens__chrome" aria-hidden="true">
                <span className="brk brk--tl" />
                <span className="brk brk--tr" />
                <span className="brk brk--bl" />
                <span className="brk brk--br" />
              </div>

              <span className="lens__scan" aria-hidden="true" />

              <div className="lens__hud" aria-hidden="true">
                <span className="hud__tag">SIDE VIEW</span>
                <span className="hud__tag">PARALLEL</span>
              </div>

              <svg
                className="skel is-armed"
                viewBox="0 0 200 300"
                role="img"
                aria-label="Illustration of the app's on-screen overlay: a tracked figure squatting side-on, with guide lines marking hip and knee height."
              >
                <g className="guide">
                  <line className="guide__l" x1="24" y1="146" x2="176" y2="146" />
                  <line className="guide__l" x1="24" y1="200" x2="176" y2="200" />
                  <text className="guide__t" x="26" y="140">
                    HIP
                  </text>
                  <text className="guide__t" x="26" y="214">
                    KNEE
                  </text>
                </g>
                <g className="bones">
                  <path d="M118 44 L100 74" />
                  <path d="M100 74 L108 106" />
                  <path d="M108 106 L124 128" />
                  <path d="M100 74 L84 146" />
                  <path d="M84 146 L104 200" />
                  <path d="M104 200 L88 252" />
                </g>
                {/* one ping per joint: the ring that fires as the tracker locks on */}
                <g className="pings">
                  {JOINTS.map(([cx, cy], i) => (
                    <circle key={`p${i}`} cx={cx} cy={cy} r="4.5" style={idx(i)} />
                  ))}
                </g>
                <g className="joints">
                  {JOINTS.map(([cx, cy], i) => (
                    <circle key={`j${i}`} cx={cx} cy={cy} r="4.5" style={idx(i)} />
                  ))}
                </g>
              </svg>

              <div className="lens__count" aria-hidden="true">
                <span className="count__n" data-count="3">
                  0
                </span>
                <span className="count__l">REPS</span>
              </div>
            </div>
          )}
        </figure>
      </div>

      <div className="shell">
        <span className="rule" aria-hidden="true" />
      </div>
    </section>
  );
}
