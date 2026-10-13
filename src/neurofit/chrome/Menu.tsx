/**
 * The menu under the top bar: numbered rows, a live ASCII panel, two footer buttons and three
 * blocks — after dragonfly.xyz's mobile menu. Rendered only while open; Esc, a click outside the
 * bar, or picking anything closes it, and focus goes back to MENU.
 *
 * ⚠️ Mirrored byte-for-byte at src/neurofit/chrome/ and site/src/chrome/ (npm run check:mirror).
 */
import { useEffect, useRef, type CSSProperties } from "react";
import { AsciiField, type AsciiSource } from "./AsciiField";

export interface MenuRow {
  id: string;
  title: string;
  /** A link instead of an action; `external` opens it in a new tab. */
  href?: string;
  external?: boolean;
  disabled?: boolean;
  /** Small mono line under the title (e.g. why it's disabled). */
  hint?: string;
}
export interface MenuAction {
  id: string;
  label: string;
  onClick: () => void;
}
export interface MenuBlock {
  id: string;
  label: string;
  href?: string;
  current?: boolean;
  disabled?: boolean;
  title?: string;
  onPick?: () => void;
}

const FOCUSABLE = "a[href], button:not(:disabled)";

export function Menu({
  id,
  label,
  rows,
  activeId,
  onRow,
  footer = [],
  blocks = [],
  ascii,
  onClose,
}: {
  id: string;
  label: string;
  rows: MenuRow[];
  activeId?: string | null;
  onRow?: (row: MenuRow) => void;
  footer?: MenuAction[];
  blocks?: MenuBlock[];
  /** undefined = no ASCII panel; null = the panel, drawn from noise. */
  ascii?: AsciiSource | null;
  onClose: () => void;
}) {
  const nav = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const el = nav.current;
    if (!el) return;
    const bar = el.closest<HTMLElement>(".topbar") ?? el;
    const toggle = bar.querySelector<HTMLElement>(".topbar__menu");
    (el.querySelector<HTMLElement>("[aria-current='page']:not(:disabled)") ?? el.querySelector<HTMLElement>(FOCUSABLE))?.focus({
      preventScroll: true,
    });
    const shut = (refocus: boolean) => {
      close.current();
      if (refocus) toggle?.focus({ preventScroll: true });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        shut(true);
        return;
      }
      if (e.key !== "Tab") return;
      // Keep Tab inside the bar + menu while it's open.
      const items = Array.from(bar.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!bar.contains(t) || t.classList?.contains("topbar__scrim")) shut(false);
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, []);

  return (
    <nav ref={nav} id={id} className="menu" aria-label={label}>
      <ul className="menu__rows">
        {rows.map((r, i) => {
          const style = { "--i": i } as CSSProperties;
          const current = r.id === activeId ? "page" : undefined;
          const inner = (
            <>
              <span className="menu__num">{String(i + 1).padStart(2, "0")}</span>
              <span className="menu__title">
                {r.title}
                {r.hint && <span className="menu__hint">{r.hint}</span>}
              </span>
              <span aria-hidden="true" />
            </>
          );
          return (
            <li key={r.id}>
              {r.href !== undefined && !r.disabled ? (
                <a
                  className="menu__row"
                  style={style}
                  href={r.href}
                  target={r.external ? "_blank" : undefined}
                  rel={r.external ? "noopener" : undefined}
                  aria-current={current}
                  onClick={() => {
                    onRow?.(r);
                    close.current();
                  }}
                >
                  {inner}
                </a>
              ) : (
                <button
                  type="button"
                  className="menu__row"
                  style={style}
                  disabled={r.disabled}
                  aria-current={current}
                  onClick={() => {
                    onRow?.(r);
                    close.current();
                  }}
                >
                  {inner}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {ascii !== undefined && (
        <div className="menu__ascii">
          <AsciiField source={ascii} fps={10} />
        </div>
      )}

      {footer.length > 0 && (
        <div className="menu__foot">
          {footer.map((f) => (
            <button
              key={f.id}
              type="button"
              className="btn"
              onClick={() => {
                close.current();
                f.onClick();
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {blocks.length > 0 && (
        <div className="menu__blocks">
          {blocks.map((b) =>
            b.href !== undefined && !b.disabled ? (
              <a key={b.id} className="menu__block" href={b.href} title={b.title} aria-current={b.current ? "true" : undefined}>
                {b.label}
              </a>
            ) : (
              <button
                key={b.id}
                type="button"
                className="menu__block"
                disabled={b.disabled}
                title={b.title}
                aria-current={b.current ? "true" : undefined}
                onClick={() => {
                  b.onPick?.();
                  close.current();
                }}
              >
                {b.label}
              </button>
            ),
          )}
        </div>
      )}
    </nav>
  );
}
