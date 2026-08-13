import { Suspense, lazy, useState } from "react";

import { useReducedMotion } from "@/hooks/useReducedMotion";
import {
  useLensParallax,
  useRepCounter,
  useScrollReveal,
  useStickyMasthead,
} from "@/hooks/useSiteMotion";

import { Masthead } from "@/sections/Masthead";
import { Hero } from "@/sections/Hero";
import { How } from "@/sections/How";
import { Proof } from "@/sections/Proof";
import { Planes } from "@/sections/Planes";
import { Cost } from "@/sections/Cost";
import { NextUp } from "@/sections/NextUp";
import { Foot } from "@/sections/Foot";

// Only one of these is ever fetched. Under reduced motion `SquatRig` — and with
// it three.js — is never requested at all, which is the point: a bundle that was
// downloaded "just in case" is a bundle that can still be triggered.
const SquatRig = lazy(() => import("@/components/SquatRig"));
const RigFallback = lazy(() => import("@/components/RigFallback"));

/**
 * Checked before anything renders, so a machine that cannot run WebGL is never
 * given the placeholder lens in the hero. The runtime failure path — a context
 * lost after the fact, a driver that lies — is caught by the rig's own error
 * boundary, which calls back here and retires it.
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
  const rig = !reduced && glOk;

  useStickyMasthead();
  useScrollReveal(reduced);
  // Both of these drive hero chrome that the rig replaces with its own.
  useRepCounter(reduced || rig);
  useLensParallax(reduced || rig);

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>

      <Masthead />

      <main id="main">
        <Hero rig={rig} />
        <Suspense fallback={null}>
          {rig ? <SquatRig onFail={() => setGlOk(false)} /> : <RigFallback />}
        </Suspense>
        <How />
        <Proof />
        <Planes />
        <Cost />
        <NextUp />
      </main>

      <Foot />
    </>
  );
}
