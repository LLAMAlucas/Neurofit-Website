/**
 * The footer, with the questions folded into it. Every answer is what the app
 * does today — nothing promised that isn't built.
 *
 * The toggle lives in the footer; the answers open as a panel of their own. They
 * are rendered into the stop's frame rather than inside the footer because the
 * finale is transformed (and, on a phone, frosted), and either makes it the box a
 * fixed panel is placed against — the answers came out squeezed into the
 * finale's column, pushing its heading up under the brand.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const FAQ: { q: string; a: string }[] = [
  {
    q: "What do I need?",
    a: "A phone or laptop with a camera and an up-to-date browser, something to prop it against, and room to move. Nothing to install, and no account.",
  },
  {
    q: "Does my video get uploaded?",
    a: "No. The camera is read on your device, frame by frame. When you ask for a read after a set, a handful of still frames from that set go to Google’s Gemini under your own key; the end-of-workout summary sends text only.",
  },
  {
    q: "Do I need a Gemini key?",
    a: "Only for the written reads. Counting reps and watching your form work without one. Paste a key into Settings and it stays in your browser.",
  },
  {
    q: "What does it cost?",
    a: "Neuro-Fit is free. The written reads run on your own Gemini key, so any charge for those is between you and Google.",
  },
  {
    q: "Which exercises?",
    a: "Squats, push-ups and pull-ups — pick one at the top of the app. You choose how deep a squat or a push-up has to go, and how high a pull-up has to reach, to count.",
  },
  {
    q: "Where do I put the phone?",
    a: "Far enough back that all of you fits on screen — and the bar, for pull-ups. Side-on and head-on each show different things, and it only judges what its view can see. Doorway bar? Pull-ups have a head-on-only setting.",
  },
];

export function Foot() {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => setHost(toggle.current?.closest<HTMLElement>(".stop__frame") ?? null), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <footer className="foot">
      <div className="foot__in">
        <span className="foot__mark">Neuro-Fit</span>
        <p className="foot__legal">
          Early build. Not medical advice, and not a substitute for a coach or a physiotherapist.
        </p>
      </div>
      <button
        type="button"
        className="faq__toggle"
        aria-expanded={open}
        aria-controls="faq"
        data-focus-only=""
        ref={toggle}
        onClick={() => setOpen((o) => !o)}
      >
        Questions
      </button>
      {host &&
        createPortal(
          // Lenis leaves this alone, so it scrolls itself when it runs long.
          <dl id="faq" className="faq__body" hidden={!open} data-lenis-prevent="" data-focus-only="">
            {FAQ.map(({ q, a }) => (
              <div key={q} className="faq__item">
                <dt>{q}</dt>
                <dd>{a}</dd>
              </div>
            ))}
          </dl>,
          host,
        )}
    </footer>
  );
}
