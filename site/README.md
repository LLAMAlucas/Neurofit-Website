# Neuro-Fit — marketing site

The landing page for Neuro-Fit, a camera form coach for squats, push-ups and pull-ups.
A single-page React site: prop your phone up, do your set, find out what your form
actually did.

The centrepiece is one particle body in fog that the scroll carries through the page.
At each exercise's stop it runs a scripted set on its own — clean reps mixed with
faulty ones — while the list of what the app watches for lights the rep's fault, and
between exercises it blows apart and re-forms as the next one. It degrades
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

The poses, fault timing, scripted sets, sample debrief and camera path are verified
**offscreen in Node**, not in a browser. [`scripts/check_site.ts`](scripts/check_site.ts)
drives the same pure modules the scene uses and asserts on the result: that every bone
keeps its length through every rep of every exercise, that contacts (feet, hands, the
bar) never slide, that each fault crosses the line the app itself would flag while a
clean rep stays inside it, that each set counts and lights the right line, and that
the debrief quotes only numbers the poses actually produce.
[`scripts/check_body.ts`](scripts/check_body.ts) does the same for the particle
sampler and the retargeter (standing, in a plank, and hanging).

It needs no browser and no build. Run it after touching anything in `src/lib/`.

## Layout

```
src/
  sections/    the page's stops (Journey) and the footer
  stage/       the WebGL scene: particle body, props, driver
  lib/         pure modules — poses (squat, push-up, pull-up), the scripted
               loop, the camera path, the debrief
  hooks/       scroll/ticker/motion
  lab/         a dev-only page for tuning the body (/lab/)
  styles/      site.css (hand-written) + globals.css (Tailwind layer)
scripts/
  check_site.ts, check_body.ts  the offscreen assertions
```

Tailwind is configured **inline** in [`vite.config.ts`](vite.config.ts) rather than via
a `postcss.config.js`, and its content globs in
[`tailwind.config.ts`](tailwind.config.ts) are absolute. Both are deliberate: Vite and
Tailwind resolve those relative to the process CWD / by walking up the tree, and this
site is built from a parent directory. Preflight is off — `site.css` ships its own
reset, tuned alongside the design tokens.

## Stack

React 18 · TypeScript · Vite · Tailwind · three.js / @react-three/fiber · Framer Motion
