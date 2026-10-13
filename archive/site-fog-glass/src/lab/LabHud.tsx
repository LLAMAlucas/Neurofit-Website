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
import { EXERCISES, EXERCISE_ORDER, type ExerciseId } from "@/lib/exercises";
import { store } from "@/stage/store";
import { GlassSegment, installGlassPointer } from "@/lib/liquidGlass";

export function LabHud() {
  const reps = useRef<HTMLSpanElement>(null);
  const readA = useRef<HTMLSpanElement>(null);
  const readB = useRef<HTMLSpanElement>(null);
  const labelA = useRef<HTMLSpanElement>(null);
  const labelB = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const boot = useRef<HTMLDivElement>(null);
  const buttons = useRef<Partial<Record<ExerciseId, HTMLButtonElement>>>({});
  const row = useRef<HTMLElement>(null);

  useEffect(() => {
    let raf = 0;
    const glass = row.current ? new GlassSegment(row.current) : null;
    const offPointer = installGlassPointer();
    let shownExercise: ExerciseId | null = null;

    const tick = () => {
      const s = store;
      if (boot.current && s.ready) boot.current.classList.add("is-done");
      const spec = EXERCISES[s.exercise];

      // The exercise changed: its list, its angles, the droplet on its button.
      if (s.exercise !== shownExercise) {
        shownExercise = s.exercise;
        glass?.setActive(buttons.current[s.exercise] ?? null);
        for (const id of EXERCISE_ORDER) buttons.current[id]?.setAttribute("aria-pressed", String(id === s.exercise));
        if (labelA.current) labelA.current.textContent = spec.readouts[0].label;
        if (labelB.current) labelB.current.textContent = spec.readouts[1].label;
        if (list.current) {
          list.current.replaceChildren(
            ...spec.checks.map((c) => {
              const li = document.createElement("li");
              li.dataset.check = c.id;
              li.dataset.kind = c.kind;
              li.textContent = c.kind === "miss" ? `${c.label} — didn't count` : c.label;
              return li;
            }),
          );
        }
      }
      if (list.current) {
        for (const li of list.current.children as HTMLCollectionOf<HTMLElement>) {
          li.classList.toggle("is-on", li.dataset.check === s.lit);
        }
      }
      if (reps.current) reps.current.textContent = String(s.reps).padStart(2, "0");
      if (readA.current) readA.current.textContent = `${Math.round(s.readA)}°`;
      if (readB.current) readB.current.textContent = `${Math.round(s.readB)}°`;

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      glass?.destroy();
      offPointer();
    };
  }, []);

  return (
    <div className="hud">
      <div className="boot" ref={boot} aria-hidden="true">
        <span>Lens init — sampling body</span>
      </div>

      <header className="hud__tl">
        <div className="hud__brand">Neuro-Fit</div>
        <div>// Lab 01 — particle body look test</div>
      </header>

      <div className="hud__tr">
        <div className="hud__label">////// Watching for</div>
        <ul className="lab-checks" ref={list} />
      </div>

      <div className="hud__bl">
        <div className="hud__label">Reps</div>
        <div className="hud__reps">
          <span ref={reps}>00</span>
        </div>
        <div>
          <span ref={labelA} /> <span ref={readA}>—</span> · <span ref={labelB} /> <span ref={readB}>—</span>
        </div>
      </div>

      <nav className="lg-seg picker" aria-label="Pick an exercise" ref={row}>
        <span className="lg-seg__thumb" aria-hidden="true" />
        {EXERCISE_ORDER.map((id) => (
          <button
            key={id}
            type="button"
            className="lg-seg__item"
            data-lg-item=""
            ref={(el) => {
              if (el) buttons.current[id] = el;
            }}
            onClick={() => (store.exercise = id)}
          >
            {EXERCISES[id].name}
          </button>
        ))}
        <span className="lg-seg__lens" aria-hidden="true" />
      </nav>

      <div className="hud__br">Drag to orbit · ← →</div>
    </div>
  );
}
