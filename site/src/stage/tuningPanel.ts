/**
 * The tuning panel: every value in `look.ts`, live. DEV ONLY — lil-gui is a dev
 * dependency, and both pages import this behind `import.meta.env.DEV`, so a
 * production build never contains it.
 *
 * Built on every dev load but HIDDEN: the look is signed off, and the panel sat
 * over the page. `?tune` in the URL opens a page with it showing; P toggles it.
 */
import GUI from "lil-gui";

import type { Settings } from "./look";
import { store } from "./store";

/** Settings that rebuild something (geometry, effect passes) rather than just
 *  updating a uniform, so a page has to re-render for them. */
export type Rebuild = Pick<Settings, "body" | "count" | "interior" | "skelCount" | "bloom" | "grain">;

export function rebuildOf(st: Settings): Rebuild {
  return {
    body: st.body,
    count: st.count,
    interior: st.interior,
    skelCount: st.skelCount,
    bloom: st.bloom,
    grain: st.grain,
  };
}

/** Returns a dispose function. `onRebuild` is left out on a page that can't
 *  rebuild (the site keeps one body), and those controllers are then omitted. */
export function createTuningPanel(onRebuild?: (r: Rebuild) => void): () => void {
  const st = store.settings;
  const sync = () => onRebuild?.(rebuildOf(st));
  const gui = new GUI({ title: "Particle body" });
  const rebuildable = (c: ReturnType<GUI["add"]>) => (onRebuild ? c.onFinishChange(sync) : c.destroy());

  const body = gui.addFolder("Body");
  rebuildable(body.add(st, "body", ["male", "female"]));
  rebuildable(body.add(st, "count", 4000, 90000, 1000));
  rebuildable(body.add(st, "interior", 0, 0.8, 0.05).name("fill (inside share)"));
  body.add(st, "flow", 0, 60, 1).name("idle current (mm)");
  body.add(st, "churn", 0, 2, 0.05).name("idle churn speed");
  body.add(st, "fizz", 0, 120, 1).name("loose grains lift (mm)");
  body.add(st, "size", 2, 16, 0.5).name("size (mm)");
  body.add(st, "opacity", 0.2, 1, 0.01);
  body.addColor(st, "graphite");
  body.addColor(st, "rimColor").name("rim colour");
  body.add(st, "rim", 0, 1, 0.01);
  body.add(st, "showMesh").name("show source mesh");

  const throwing = gui.addFolder("Throw (cursor)");
  throwing.add(st, "force", 0, 1.5, 0.01).name("throw (× swipe speed)");
  throwing.add(st, "spray", 0, 1.5, 0.01).name("spray");
  throwing.add(st, "brush", 0.02, 0.25, 0.005).name("brush size");
  throwing.add(st, "heat", 0.2, 6, 0.1).name("stays hot (s)");
  throwing.add(st, "drag", 0, 5, 0.05).name("air drag");
  throwing.add(st, "gravity", 0, 12, 0.1).name("gravity (m/s²)");
  throwing.add(st, "swirl", 0, 8, 0.1).name("swirl");
  throwing.add(st, "pull", 0.5, 10, 0.1).name("pull home");
  throwing.add(st, "walls").name("glass walls");
  throwing.add(st, "room", 0.4, 2.5, 0.05).name("room half-width (m)");
  throwing.addColor(st, "hotColor").name("hot colour");

  const forming = gui.addFolder("Forming");
  forming.add(st, "formNear", 0.2, 3, 0.05).name("cloud inner radius (m)");
  forming.add(st, "formFar", 0.5, 6, 0.05).name("cloud outer radius (m)");
  forming.add(st, "formHeat", 0, 1, 0.01).name("start hot (0…1)");
  forming.add(st, "formSpin", 0, 2, 0.05).name("spin (rad/s)");
  forming.add(st, "formStagger", 0, 3, 0.05).name("stagger (s)");
  forming.add(st, "formRise", 0, 1, 0.05).name("from the feet up (0…1)");
  forming.add({ form: () => store.formNonce++ }, "form").name("form again");

  const skeleton = gui.addFolder("Skeleton (shows through a hole)");
  rebuildable(skeleton.add(st, "skelCount", 1000, 20000, 500).name("grains"));
  skeleton.add(st, "skelSize", 2, 14, 0.5).name("grain size (mm)");
  skeleton.add(st, "skelGlow", 0.5, 3, 0.05).name("glow");
  skeleton.add(st, "revealFrom", 0.5, 10, 0.1).name("shows once flesh moved (cm)");
  skeleton.add(st, "revealTo", 1, 25, 0.5).name("fully shown at (cm)");
  skeleton.add(st, "skelAlways").name("show it all (tuning)");

  const fault = gui.addFolder("Fault");
  fault.addColor(st, "red");
  fault.add(st, "glow", 0, 4, 0.05);
  fault.add(st, "radius", 0.05, 0.4, 0.005).name("radius (m)");
  fault.add(st, "severity", 0.2, 1, 0.05);
  fault.add(st, "loop").name("loop the rep");
  fault.add(st, "speed", 0, 1.5, 0.05).name("rep speed (0 = freeze)");

  const world = gui.addFolder("World");
  world.addColor(st, "fogColor").name("fog colour");
  world.add(st, "fog", 0, 0.2, 0.002);
  rebuildable(world.add(st, "bloom", 0, 3, 0.05));
  rebuildable(world.add(st, "grain", 0, 0.3, 0.005));

  // The approved look gets baked into look.ts from this.
  gui
    .add({ copy: () => void navigator.clipboard?.writeText(JSON.stringify(st, null, 2)) }, "copy")
    .name("copy settings as JSON");

  gui.close();
  if (!new URLSearchParams(location.search).has("tune")) gui.hide();
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "p" && e.key !== "P") return;
    const t = e.target as HTMLElement | null;
    if (t?.closest?.("input, textarea, select, [contenteditable]")) return;
    gui.show(gui._hidden);
  };
  window.addEventListener("keydown", onKey);

  // Scripted tuning: `__labGui.controllersRecursive()` drives the same
  // controllers a person would, rebuilds included.
  (window as unknown as { __labGui: GUI }).__labGui = gui;
  return () => {
    window.removeEventListener("keydown", onKey);
    gui.destroy();
  };
}
