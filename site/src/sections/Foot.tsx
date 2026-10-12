/**
 * The footer: the mark, the one line of small print, and the way to the questions and the privacy
 * note — the same sheets the menu opens (components/Hud draws them; lib/faq, chrome/privacy).
 */
import { openSheet } from "@/hooks/panels";

export function Foot() {
  return (
    <footer className="foot">
      <div className="foot__in">
        <span className="foot__mark">Neuro-Fit</span>
        <p className="foot__legal">
          Early build. Not medical advice, and not a substitute for a coach or a physiotherapist.
        </p>
      </div>
      <div className="foot__links">
        <button type="button" className="foot__link" data-focus-only="" onClick={() => openSheet("faq")}>
          Questions
        </button>
        <button type="button" className="foot__link" data-focus-only="" onClick={() => openSheet("privacy")}>
          Privacy
        </button>
      </div>
    </footer>
  );
}
