/**
 * A dark panel over a scrim — the FAQ and the privacy note. Portalled to <body> so no ancestor's
 * transform or blur can trap it; Esc, the X or a click on the scrim closes it, and focus goes back
 * to whatever opened it.
 *
 * ⚠️ Mirrored byte-for-byte at src/neurofit/chrome/ and site/src/chrome/ (npm run check:mirror).
 */
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Sheet({ id, title, onClose, children }: { id: string; title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>(".sheet__close")?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      before?.focus?.({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div
      className="sheet-scrim"
      data-lenis-prevent=""
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close.current();
      }}
    >
      <div ref={panel} className="sheet" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
        <div className="sheet__head">
          <h2 id={`${id}-title`} className="sheet__title">
            {title}
          </h2>
          <button type="button" className="btn btn--icon sheet__close" aria-label="Close" onClick={() => close.current()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div className="sheet__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
