const PHASES = [
  {
    k: "Before",
    h: "Get yourself in frame.",
    p: "Stand back far enough that the whole of you fits on screen. The app works out whether it’s looking at you from the side or head-on, settles on it while you’re standing still, and tells you when it’s ready.",
  },
  {
    k: "During",
    h: "Squat. Watch the count.",
    p: "Your body is traced on screen as you move, and reps only count when you actually reach the depth you asked for. If a knee falls inward, you see it light up the moment it happens.",
  },
  {
    k: "After the set",
    h: "Find out how that one went.",
    p: "End the set and you get a few sentences on what it actually did — written from your first couple of reps as a reference point and the worst moment of anything it flagged. Only when you ask for it.",
  },
  {
    k: "After the workout",
    h: "See the pattern across sets.",
    p: "One read across the whole session: what kept happening, what was a one-off, and what genuinely changed as you got tired — judged on how your reps slowed, not assumed because it was the last set.",
  },
];

export function How() {
  return (
    <section id="how" className="sec">
      <div className="shell">
        <header className="sec__head">
          <span className="eyebrow reveal">How it works</span>
          <h2 className="h2 reveal" data-d="1">
            Set up once. Then just lift.
          </h2>
          <p className="sec__intro reveal" data-d="2">
            There is no wiring, no wearable and nothing to strap on. A phone, a wall to lean it
            against, and room to squat.
          </p>
        </header>

        <ol className="phases">
          {PHASES.map((phase, i) => (
            <li
              key={phase.k}
              className="phase reveal"
              {...(i > 0 ? { "data-d": String(i) } : {})}
            >
              <span className="phase__k">{phase.k}</span>
              <h3 className="phase__h">{phase.h}</h3>
              <p>{phase.p}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
