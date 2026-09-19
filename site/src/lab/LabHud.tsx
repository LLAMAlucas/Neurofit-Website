/**
 * The viewfinder HUD over the lab stage.
 *
 * It reads the store on its own animation frame and writes straight into the
 * DOM — React renders the structure once and never again per frame.
 *
 * Every number on it is a degree or a rep count computed from the live pose:
 * the two kinds of number the site is allowed to quote.
 */
import { useEffect, useRef } from "react";
import { FAULTS, FAULT_ORDER, planeVisibility, viewLabel, type FaultId } from "@/lib/faultDemo";
import { store } from "@/stage/store";

const GLYPHS = "▮▯/\\_-=+<>:01";
const SCRAMBLE_MS = 420;

/** Where the tag sits relative to the point it labels, CSS px. */
const TAG_OFFSET = { x: 120, y: -90 };

export function LabHud() {
  const view = useRef<HTMLSpanElement>(null);
  const reads = useRef<HTMLSpanElement>(null);
  const reps = useRef<HTMLSpanElement>(null);
  const knee = useRef<HTMLSpanElement>(null);
  const trunk = useRef<HTMLSpanElement>(null);
  const tag = useRef<HTMLDivElement>(null);
  const line = useRef<SVGLineElement>(null);
  const dot = useRef<SVGCircleElement>(null);
  const boot = useRef<HTMLDivElement>(null);
  const buttons = useRef<Partial<Record<FaultId, HTMLButtonElement>>>({});

  useEffect(() => {
    let raf = 0;
    let target = "";
    let shown = "";
    let since = 0;

    const tick = (now: number) => {
      const s = store;
      if (boot.current && s.ready) boot.current.classList.add("is-done");

      if (view.current) view.current.textContent = viewLabel(s.viewAzimuth);
      if (reads.current) {
        const can: string[] = [];
        if (planeVisibility("frontal", s.viewAzimuth) > 0.5) can.push("knee cave");
        if (planeVisibility("sagittal", s.viewAzimuth) > 0.5) can.push("forward lean");
        reads.current.textContent = can.length ? `Can judge: ${can.join(", ")}` : "Can judge: neither fault";
      }
      if (reps.current) reps.current.textContent = String(s.reps).padStart(2, "0");
      if (knee.current) knee.current.textContent = `${Math.round(s.knee)}°`;
      if (trunk.current) trunk.current.textContent = `${Math.round(s.trunk)}°`;

      // The tag: what the lens concluded about the rep in progress (or the one
      // that just ended). A fault it can't see from here is "unknown", never
      // "clean" — silence from a check that couldn't run is not a pass.
      const f = FAULTS[s.fault];
      const repNo = s.phase === "rep" ? s.reps + 1 : s.reps;
      let desired = "";
      let kind = "";
      if (f.plane) {
        const live = (s.phase === "rep" && s.envelope > 0.05) || s.tagHold > 0;
        if (live) {
          const seen = s.visibility > 0.5;
          desired = seen ? `${f.tag} · rep ${repNo}` : "Not visible from this angle · unknown";
          kind = seen ? "is-fault" : "is-unknown";
        }
      } else if (s.tagHold > 0) {
        desired = `Rep ${repNo} · nothing flagged`;
        kind = "is-clean";
      }

      if (desired !== target) {
        target = desired;
        since = now;
      }
      if (tag.current && line.current && dot.current) {
        if (target) {
          const t = now - since;
          let out = "";
          for (let i = 0; i < target.length; i++) {
            const ch = target[i];
            out += ch === " " || t > 60 + (i / target.length) * SCRAMBLE_MS ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0];
          }
          if (out !== shown) tag.current.textContent = shown = out;
          tag.current.className = `tag is-on ${kind}`;
          const tx = s.anchor.x + TAG_OFFSET.x;
          const ty = s.anchor.y + TAG_OFFSET.y;
          tag.current.style.transform = `translate(${tx}px, ${ty}px)`;
          line.current.setAttribute("x1", String(s.anchor.x));
          line.current.setAttribute("y1", String(s.anchor.y));
          line.current.setAttribute("x2", String(tx - 6));
          line.current.setAttribute("y2", String(ty + 8));
          dot.current.setAttribute("cx", String(s.anchor.x));
          dot.current.setAttribute("cy", String(s.anchor.y));
          line.current.parentElement?.classList.add("is-on");
        } else {
          tag.current.className = "tag";
          line.current.parentElement?.classList.remove("is-on");
        }
      }

      const busy = s.phase !== "idle" || s.request !== null;
      for (const id of FAULT_ORDER) {
        const b = buttons.current[id];
        if (!b) continue;
        b.setAttribute("aria-disabled", String(busy));
        b.setAttribute("aria-pressed", String(busy && s.fault === id));
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const pick = (id: FaultId) => {
    if (store.phase !== "idle" || store.request) return;
    store.request = id;
  };

  return (
    <div className="hud">
      <div className="boot" ref={boot} aria-hidden="true">
        <span>Lens init — sampling body</span>
      </div>

      <svg className="leader" aria-hidden="true">
        <line ref={line} />
        <circle ref={dot} r="3" />
      </svg>
      <div className="tag" ref={tag} role="status" aria-live="polite" />

      <header className="hud__tl">
        <div className="hud__brand">Neuro-Fit</div>
        <div>// Lab 01 — particle body look test</div>
      </header>

      <div className="hud__tr">
        <div className="hud__label">////// View</div>
        <div className="hud__big">
          <span ref={view}>—</span>
        </div>
        <div>
          <span ref={reads} />
        </div>
      </div>

      <div className="hud__bl">
        <div className="hud__label">Reps</div>
        <div className="hud__reps">
          <span ref={reps}>00</span>
        </div>
        <div>
          Knee <span ref={knee}>—</span> · Trunk <span ref={trunk}>—</span>
        </div>
      </div>

      <nav className="picker" aria-label="Pick a rep">
        {FAULT_ORDER.map((id) => (
          <button
            key={id}
            type="button"
            className="bracket"
            ref={(el) => {
              if (el) buttons.current[id] = el;
            }}
            onClick={() => pick(id)}
          >
            {FAULTS[id].label}
          </button>
        ))}
      </nav>

      <div className="hud__br">Drag to orbit · ← →</div>
    </div>
  );
}
