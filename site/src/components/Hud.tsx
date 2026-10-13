/**
 * The page's frame, after dragonfly.xyz: the top bar (N/F · five pixels · MENU) and its menu, the
 * serif corner letters N and F, the blur bands at the top and bottom edges, the sheets (FAQ,
 * privacy), and the lens booting in characters while the scene loads.
 *
 * The pixels light one by one as the reader goes down the page. The menu's rows are the page's
 * stops (lib/story STOPS[].label) — a neighbour is a smooth scroll, anything further goes through
 * the iris (hooks/scrollControl). Its ASCII panel is the scene itself, re-drawn in characters;
 * its three blocks open the app on that exercise.
 *
 * `live` is false for the still page (reduced motion, no WebGL): no scene, no bands, no boot — the
 * bar, menu and sheets still work, over plain scrolling text.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { AsciiField, canvasSource } from "@/chrome/AsciiField";
import { Menu, type MenuBlock, type MenuRow } from "@/chrome/Menu";
import { PrivacyNote } from "@/chrome/privacy";
import { Sheet } from "@/chrome/Sheet";
import { TopBar } from "@/chrome/TopBar";
import { onTick } from "@/hooks/ticker";
import { openSheet, useSheet } from "@/hooks/panels";
import { pauseScroll, resumeScroll, scrollToStop } from "@/hooks/scrollControl";
import { FAQ } from "@/lib/faq";
import { END, STOPS, stopIndex, type StopId } from "@/lib/story";
import { tapCanvas } from "@/stage/asciiTapStore";
import { store } from "@/stage/store";

/** A separate origin (its own deployment off the same repo), so the camera permission the app
 *  asks for is scoped to it alone and never to this page. */
const TRY_URL = "https://try.neurofit-training.com";
const BLOCKS: { id: string; label: string }[] = [
  { id: "squat", label: "Squat" },
  { id: "pushup", label: "Push-up" },
  { id: "pullup", label: "Pull-up" },
];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** Five pixels across the page: the first lit at the top, all five at the end. */
const pixelsAt = (p: number) => 1 + Math.floor(clamp01(p / END) * 4.999);

/** The lens booting: a field of drifting characters over black until the body's first frame. */
function Boot() {
  const ref = useRef<HTMLDivElement>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let done = false;
    let timer = 0;
    const off = onTick(() => {
      if (done || !store.ready || !ref.current) return;
      done = true;
      ref.current.classList.add("is-done");
      timer = window.setTimeout(() => setGone(true), 1000);
    });
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, []);
  if (gone) return null;
  return (
    <div className="boot" ref={ref} aria-hidden="true">
      <AsciiField className="boot__field" fps={12} />
      <span className="boot__label">Lens init</span>
    </div>
  );
}

export function Hud({ live }: { live: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [lit, setLit] = useState(1);
  const [active, setActive] = useState<StopId>("form");
  const sheet = useSheet();

  // The pixels and the menu's current row follow the reader.
  useEffect(() => {
    const read = (p: number) => {
      const n = pixelsAt(p);
      setLit((was) => (was === n ? was : n));
      const id = (document.body.dataset.stop as StopId | undefined) ?? "form";
      setActive((was) => (was === id ? was : id));
    };
    if (live) return onTick(() => read(store.progress));
    // The still page: the browser's own scroll, mapped onto the same five pixels.
    const onScroll = () => {
      const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      read((window.scrollY / max) * END);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [live]);

  // The page holds still under an open menu or sheet; the stage copies its frame for the menu.
  useEffect(() => {
    store.menuOpen = menuOpen;
    if (menuOpen || sheet) pauseScroll();
    else resumeScroll();
  }, [menuOpen, sheet]);

  // The menu's ASCII panel: the scene around the body, re-drawn in characters (the still page
  // has no scene — its still picture stands in).
  const ascii = useMemo(() => {
    if (live) {
      return canvasSource(tapCanvas, {
        gain: 1.5,
        fit: "contain",
        crop: () => {
          const b = store.box;
          if (!b.w || !b.h) return null;
          const W = window.innerWidth;
          const H = window.innerHeight;
          const padX = b.w * 0.6;
          const padY = b.h * 0.04;
          const x = clamp01((b.x - padX) / W);
          const y = clamp01((b.y - padY) / H);
          return { x, y, w: clamp01((b.x + b.w + padX) / W) - x, h: clamp01((b.y + b.h + padY) / H) - y };
        },
      });
    }
    let img: HTMLImageElement | null = null;
    return canvasSource(() => {
      if (!img) {
        img = new Image();
        img.src = "/body-still.webp";
      }
      return img.complete ? img : null;
    });
  }, [live]);

  const rows: MenuRow[] = STOPS.map((s) => ({ id: s.id, title: s.label }));
  const blocks: MenuBlock[] = BLOCKS.map((b) => ({
    id: b.id,
    label: b.label,
    href: `${TRY_URL}/?exercise=${b.id}`,
    title: `Open the app on ${b.label.toLowerCase()}s`,
  }));
  const goHome = (e: MouseEvent) => {
    e.preventDefault();
    setMenuOpen(false);
    scrollToStop(0);
  };

  return (
    <div className="hud">
      {live && (
        <>
          <div className="edge edge--top" aria-hidden="true" />
          <div className="edge edge--bottom" aria-hidden="true" />
        </>
      )}
      <span className="hud__corner hud__corner--n" aria-hidden="true">
        N
      </span>
      <span className="hud__corner hud__corner--f" aria-hidden="true">
        F
      </span>

      <div className="hud__bar">
        <TopBar
          home={{ label: "Neuro-Fit, back to the top", href: "#top", onClick: goHome }}
          pixels={{ mode: "progress", lit }}
          menuOpen={menuOpen}
          onToggleMenu={() => setMenuOpen((o) => !o)}
          menuId="site-menu"
        >
          {menuOpen && (
            <Menu
              id="site-menu"
              label="Sections"
              rows={rows}
              activeId={active}
              onRow={(row) => scrollToStop(stopIndex(row.id as StopId))}
              ascii={ascii}
              footer={[
                { id: "faq", label: "FAQ", onClick: () => openSheet("faq") },
                { id: "privacy", label: "Privacy", onClick: () => openSheet("privacy") },
              ]}
              blocks={blocks}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </TopBar>
      </div>

      {live && <Boot />}

      {sheet === "faq" && (
        <Sheet id="faq" title="Questions" onClose={() => openSheet(null)}>
          <dl>
            {FAQ.map(({ q, a }) => (
              <div key={q}>
                <dt>{q}</dt>
                <dd>{a}</dd>
              </div>
            ))}
          </dl>
        </Sheet>
      )}
      {sheet === "privacy" && (
        <Sheet id="privacy" title="Privacy" onClose={() => openSheet(null)}>
          <PrivacyNote />
        </Sheet>
      )}
    </div>
  );
}
