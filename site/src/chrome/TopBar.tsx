/**
 * The bar both apps wear, after dragonfly.xyz: N/F on the left, five pixels in the middle, MENU
 * on the right, on a blurred #0F0F0F plate. The menu (children) hangs under it.
 *
 * The pixels say what's happening: the site lights them one by one as you read down the page
 * ("progress"); the tracker runs them as a loader while an AI read is being written ("loader").
 * Open the menu and the same five squares slide into an X.
 *
 * ⚠️ Mirrored byte-for-byte at src/neurofit/chrome/ and site/src/chrome/ (npm run check:mirror).
 */
import type { MouseEvent, ReactNode } from "react";

export type PixelMode = "progress" | "loader" | "static";

export function PixelMark({ mode, lit = 5, open }: { mode: PixelMode; lit?: number; open: boolean }) {
  return (
    <span className="px" data-mode={mode} data-open={open ? "true" : "false"} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <i key={i} className={mode === "progress" && i >= lit ? "is-dim" : undefined} />
      ))}
    </span>
  );
}

export function TopBar({
  home,
  pixels,
  menuOpen,
  onToggleMenu,
  menuId,
  status,
  className,
  children,
}: {
  /** The N/F mark: a link (href) or an action (onClick), and what it's called aloud. */
  home: { label: string; href?: string; onClick?: (e: MouseEvent) => void };
  pixels: { mode: PixelMode; lit?: number };
  menuOpen: boolean;
  onToggleMenu: () => void;
  menuId: string;
  /** Announced politely while it changes (e.g. "Writing your set's read"). */
  status?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={"topbar" + (className ? " " + className : "")} data-open={menuOpen ? "true" : undefined}>
      <div className="topbar__plate">
        {home.href !== undefined ? (
          <a className="topbar__home" href={home.href} onClick={home.onClick} aria-label={home.label}>
            N/F
          </a>
        ) : (
          <button type="button" className="topbar__home" onClick={home.onClick} aria-label={home.label}>
            N/F
          </button>
        )}
        {/* The pixels toggle the menu for a pointer too; MENU is the real (keyboard) control. */}
        <span className="topbar__px" onClick={onToggleMenu}>
          <PixelMark mode={pixels.mode} lit={pixels.lit} open={menuOpen} />
        </span>
        <button type="button" className="topbar__menu" aria-expanded={menuOpen} aria-controls={menuId} onClick={onToggleMenu}>
          Menu
        </button>
      </div>
      <span className="sr-only" role="status">
        {status ?? ""}
      </span>
      {children}
    </div>
  );
}
