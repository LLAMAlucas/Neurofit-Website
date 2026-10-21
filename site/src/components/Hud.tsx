/**
 * The page's frame: the blur bands at the top and bottom edges, the sheets (FAQ, privacy), and the
 * lens booting in characters while the scene loads. The top bar (N/F · five pixels · MENU) and its
 * menu were removed at the user's request, 2026-10-21; chrome/ still holds them for the tracker.
 *
 * `live` is false for the still page (reduced motion, no WebGL): no scene, no bands, no boot.
 */
import { useEffect, useRef, useState } from "react";

import { AsciiField } from "@/chrome/AsciiField";
import { PrivacyNote } from "@/chrome/privacy";
import { Sheet } from "@/chrome/Sheet";
import { onTick } from "@/hooks/ticker";
import { openSheet, useSheet } from "@/hooks/panels";
import { pauseScroll, resumeScroll } from "@/hooks/scrollControl";
import { FAQ } from "@/lib/faq";
import { store } from "@/stage/store";

/** The boot screen never holds the page hostage: if the body hasn't drawn its first frame by
 *  now (a slow phone, a model that didn't load), it fades anyway and the words are the page. */
const BOOT_MAX_MS = 12000;

/** The lens booting: a field of drifting characters over black until the body's first frame. */
function Boot() {
  const ref = useRef<HTMLDivElement>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let done = false;
    let timer = 0;
    const finish = () => {
      if (done || !ref.current) return;
      done = true;
      ref.current.classList.add("is-done");
      timer = window.setTimeout(() => setGone(true), 1000);
    };
    const off = onTick(() => {
      if (store.ready) finish();
    });
    const cap = window.setTimeout(finish, BOOT_MAX_MS);
    return () => {
      off();
      window.clearTimeout(timer);
      window.clearTimeout(cap);
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
  const sheet = useSheet();

  // The page holds still under an open sheet.
  useEffect(() => {
    store.menuOpen = false;
    if (sheet) pauseScroll();
    else resumeScroll();
  }, [sheet]);

  return (
    <div className="hud">
      {live && (
        <>
          <div className="edge edge--top" aria-hidden="true" />
          <div className="edge edge--bottom" aria-hidden="true" />
        </>
      )}

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
