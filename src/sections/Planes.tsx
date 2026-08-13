import { useRef, useState, type KeyboardEvent } from "react";

type View = "side" | "front";

const TABS: Array<{ id: View; label: string }> = [
  { id: "side", label: "From the side" },
  { id: "front", label: "Head-on" },
];

const CHECKS: Array<{ name: string; plane: "sagittal" | "frontal" | "both" }> = [
  { name: "How deep you got", plane: "sagittal" },
  { name: "Tipping forward", plane: "sagittal" },
  { name: "Lower back rounding", plane: "sagittal" },
  { name: "Knees falling in", plane: "frontal" },
  { name: "Leaning to one side", plane: "frontal" },
  { name: "Stance width", plane: "frontal" },
  { name: "Rep count", plane: "both" },
  { name: "Rep speed", plane: "both" },
  { name: "Control on the way down", plane: "both" },
];

export function Planes() {
  const [view, setView] = useState<View>("side");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const select = (i: number, focus: boolean) => {
    setView(TABS[i].id);
    if (focus) tabRefs.current[i]?.focus();
  };

  // Roving tabindex: arrow keys move between tabs, as expected of a tablist.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === view);
    if (i < 0) return;

    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      select((i + 1) % TABS.length, true);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      select((i - 1 + TABS.length) % TABS.length, true);
    } else if (e.key === "Home") {
      e.preventDefault();
      select(0, true);
    } else if (e.key === "End") {
      e.preventDefault();
      select(TABS.length - 1, true);
    }
  };

  return (
    <section id="planes" className="sec sec--planes" data-view={view}>
      <div className="shell">
        <header className="sec__head">
          <span className="eyebrow reveal">What one camera can see</span>
          <h2 className="h2 reveal" data-d="1">
            Where you put the phone changes what it knows.
          </h2>
          <p className="sec__intro reveal" data-d="2">
            From the side, it can see how deep you got and how far you tipped forward. From the
            front, it can see a knee falling inward. It can’t see both at once, so rather than
            guess, it says which of the two it’s looking at — and your sets alternate between them.
          </p>
        </header>

        <div className="planes reveal" data-d="1">
          <div className="planes__viz">
            <div className="lens lens--sq">
              <div className="lens__chrome" aria-hidden="true">
                <span className="brk brk--tl" />
                <span className="brk brk--tr" />
                <span className="brk brk--bl" />
                <span className="brk brk--br" />
              </div>

              <svg className="skel skel--side" viewBox="0 0 200 300" aria-hidden="true">
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
                <g className="joints">
                  <circle cx="118" cy="44" r="4.5" />
                  <circle cx="100" cy="74" r="4.5" />
                  <circle cx="108" cy="106" r="4.5" />
                  <circle cx="124" cy="128" r="4.5" />
                  <circle cx="84" cy="146" r="4.5" />
                  <circle cx="104" cy="200" r="4.5" />
                  <circle cx="88" cy="252" r="4.5" />
                </g>
              </svg>

              <svg className="skel skel--front" viewBox="0 0 200 300" aria-hidden="true">
                <g className="guide">
                  <line className="guide__l guide__l--v" x1="78" y1="190" x2="78" y2="256" />
                  <line className="guide__l guide__l--v" x1="122" y1="190" x2="122" y2="256" />
                </g>
                <g className="bones">
                  <path d="M100 42 L76 72" />
                  <path d="M100 42 L124 72" />
                  <path d="M76 72 L124 72" />
                  <path d="M76 72 L66 104" />
                  <path d="M66 104 L72 132" />
                  <path d="M124 72 L134 104" />
                  <path d="M134 104 L128 132" />
                  <path d="M76 72 L84 140" />
                  <path d="M124 72 L116 140" />
                  <path d="M84 140 L116 140" />
                  <path className="bone--fault" d="M84 140 L88 196" />
                  <path className="bone--fault" d="M88 196 L78 252" />
                  <path className="bone--fault" d="M116 140 L112 196" />
                  <path className="bone--fault" d="M112 196 L122 252" />
                </g>
                <g className="joints">
                  <circle cx="100" cy="42" r="4.5" />
                  <circle cx="76" cy="72" r="4.5" />
                  <circle cx="124" cy="72" r="4.5" />
                  <circle cx="66" cy="104" r="4.5" />
                  <circle cx="134" cy="104" r="4.5" />
                  <circle cx="72" cy="132" r="4.5" />
                  <circle cx="128" cy="132" r="4.5" />
                  <circle cx="84" cy="140" r="4.5" />
                  <circle cx="116" cy="140" r="4.5" />
                  <circle className="joint--fault" cx="88" cy="196" r="5.5" />
                  <circle className="joint--fault" cx="112" cy="196" r="5.5" />
                  <circle cx="78" cy="252" r="4.5" />
                  <circle cx="122" cy="252" r="4.5" />
                </g>
              </svg>
            </div>

            <div
              className="planes__switch"
              role="tablist"
              aria-label="Camera position"
              onKeyDown={onKeyDown}
            >
              <span className="planes__thumb" aria-hidden="true" />
              {TABS.map((tab, i) => (
                <button
                  key={tab.id}
                  ref={(el) => {
                    tabRefs.current[i] = el;
                  }}
                  role="tab"
                  id={`tab-${tab.id}`}
                  aria-controls="checks"
                  aria-selected={view === tab.id}
                  tabIndex={view === tab.id ? 0 : -1}
                  data-set={tab.id}
                  onClick={() => select(i, false)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div
            className="planes__checks"
            id="checks"
            role="region"
            aria-live="polite"
            aria-labelledby={`tab-${view}`}
          >
            <ul className="checks">
              {CHECKS.map((c) => (
                <li key={c.name} data-plane={c.plane}>
                  <span className="checks__n">{c.name}</span>
                  <span className="checks__s" />
                </li>
              ))}
            </ul>
            <p className="checks__note">
              Anything it can’t see, it marks as unknown rather than passed — and the coaching is
              held to the same limit, so it won’t comment on your knees off a set filmed from the
              side.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
