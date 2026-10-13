import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";

import { Sfx } from "@/audio/sfx";
import { Hud } from "@/components/Hud";
import { TouchZone } from "@/components/TouchZone";
import { useJourney } from "@/hooks/useJourney";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { onTick } from "@/hooks/ticker";
import { detectTier, stepDown, type Tier } from "@/lib/quality";
import { Journey } from "@/sections/Journey";
import { store } from "@/stage/store";

// Fetched only for the live page. Under reduced motion, or without WebGL, the
// stage — and three.js with it — is never requested at all: a bundle that was
// downloaded "just in case" is a bundle that can still be triggered.
const Stage = lazy(() => import("@/stage/Stage"));

/**
 * Checked before anything renders, so a machine that cannot run WebGL is never
 * handed a page built around a canvas. The runtime failure path — a context
 * lost after the fact, a driver that lies — is the stage's own boundary, which
 * calls back here and retires it.
 */
function supportsWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export default function App() {
  const reduced = useReducedMotion();
  const [glOk, setGlOk] = useState(supportsWebGL);
  const live = !reduced && glOk;
  const [tier, setTier] = useState<Tier>(detectTier);
  const sfx = useMemo(() => new Sfx(), []);

  useJourney(live);

  // The page's two looks: the live one is a stack of fixed layers over the
  // scene; the still one is ordinary, scrolling, normal-flow text.
  useEffect(() => {
    document.documentElement.classList.toggle("is-live", live);
    document.documentElement.classList.toggle("is-still", !live);
  }, [live]);

  // Sound follows the scene: a tick per counted rep, a tone as a fault first
  // lights up in view. (Silent until the reader turns it on.)
  useEffect(() => {
    if (!live) return;
    let reps = store.reps;
    let flash = store.faultFlash;
    return onTick(() => {
      // Only a rep counted ticks — not the count starting over for the next set.
      if (store.reps !== reps) {
        if (store.reps > reps) sfx.tick();
        reps = store.reps;
      }
      if (store.faultFlash !== flash) {
        flash = store.faultFlash;
        sfx.fault();
      }
    });
  }, [live, sfx]);

  // Dev only: the look's tuning panel, hidden until `?tune` or P. lil-gui is a
  // dev dependency and this branch is dropped from a production build.
  useEffect(() => {
    if (!import.meta.env.DEV || !live) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void import("@/stage/tuningPanel").then(({ createTuningPanel }) => {
      if (!cancelled) dispose = createTuningPanel();
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [live]);

  const onSwipe = useCallback((speed: number) => sfx.swish(speed), [sfx]);
  const onFail = useCallback(() => setGlOk(false), []);
  const onSlow = useCallback(() => setTier((t) => stepDown(t)), []);

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>

      {live && (
        <Suspense fallback={null}>
          <Stage tier={tier} onFail={onFail} onSlow={onSlow} />
        </Suspense>
      )}
      {live && <TouchZone onSwipe={onSwipe} />}

      <Hud live={live} />

      <main id="main" className="journey">
        <Journey live={live} />
      </main>
    </>
  );
}
