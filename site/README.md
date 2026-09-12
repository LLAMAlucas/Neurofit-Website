# Neuro-Fit — marketing site

The landing page for Neuro-Fit, a camera form coach for squats. A single-page React
site: prop your phone up, do your set, find out what your form actually did.

The centrepiece is a scroll-driven WebGL squat rig — a pose skeleton that runs a set
of reps while annotated callouts point at the faults as they happen. It degrades
deliberately:

- **No WebGL** → a static fallback, decided before first render.
- **`prefers-reduced-motion`** → the fallback again, and three.js is *never fetched*.
  A bundle downloaded "just in case" is a bundle that can still be triggered.

This repo is the website only. The tracker app itself is a separate project.

## Running it

```bash
npm install
npm run dev
```

Dev server comes up on <http://localhost:5180>.

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck, then production build to `dist/` |
| `npm run preview` | Serve the built `dist/` |
| `npm run typecheck` | Types only |
| `npm run check` | Offscreen rig assertions (see below) |

## `npm run check`

The rig's geometry, fault timing, camera framing and leader lines are verified
**offscreen in Node**, not in a browser — a headless pane can't size a WebGL canvas
(its `ResizeObserver` never fires), so there is nothing to screenshot. Instead
[`scripts/check_rig.ts`](scripts/check_rig.ts) drives the same pure modules the scene
uses and reimplements the projection independently, then asserts on the result: that
every joint stays in frame, that each callout appears only on the rep it belongs to,
that the labels never overlap, that no leader line crosses the midline.

It needs no browser and no build. Run it after touching anything in `src/lib/`.

## Layout

```
src/
  sections/    one component per band of the page
  components/  SquatRig (WebGL) + RigFallback (static) + ui/
  lib/         pure modules — pose, frames, timeline, shots, framing
  hooks/       scroll/reveal/motion
  styles/      site.css (hand-written) + globals.css (Tailwind layer)
scripts/
  check_rig.ts the offscreen assertions
```

Tailwind is configured **inline** in [`vite.config.ts`](vite.config.ts) rather than via
a `postcss.config.js`, and its content globs in
[`tailwind.config.ts`](tailwind.config.ts) are absolute. Both are deliberate: Vite and
Tailwind resolve those relative to the process CWD / by walking up the tree, and this
site is built from a parent directory. Preflight is off — `site.css` ships its own
reset, tuned alongside the design tokens.

## Stack

React 18 · TypeScript · Vite · Tailwind · three.js / @react-three/fiber · Framer Motion
