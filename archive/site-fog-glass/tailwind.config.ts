import type { Config } from "tailwindcss";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Content globs are ABSOLUTE and derived from this file's location.
 *
 * Tailwind resolves relative content globs against the process CWD, not the config
 * file. The site is normally launched as `npx vite site` from the repo root, so a
 * relative "./src/**" would resolve to NEUROFIT/src — the tracker app — and would
 * both miss every site file and scan code that must stay out of this build.
 */
const content = [path.join(here, "index.html"), path.join(here, "src/**/*.{ts,tsx}")];

export default {
  content,
  // site.css ships its own reset (box-sizing, margins, list-style, focus-visible),
  // tuned alongside the design tokens. Preflight would duplicate and fight it, so
  // the hand-written reset stays authoritative. See globals.css for the one bit of
  // preflight behaviour that has to be restored for Tailwind's border utilities.
  corePlugins: { preflight: false },
  theme: {
    extend: {
      // Mirrors of the :root custom properties in styles/site.css. The CSS vars
      // stay the single source of truth at runtime — these just make the same
      // values reachable as Tailwind utilities for new components.
      colors: {
        fog: { DEFAULT: "var(--fog)", 2: "var(--fog-2)" },
        ink: { DEFAULT: "var(--ink)", 2: "var(--ink-2)" },
        hot: "var(--hot)",
        fault: { DEFAULT: "var(--fault)", ink: "var(--fault-ink)" },
        rule: "var(--rule)",
      },
      fontFamily: {
        sans: "var(--sans)",
        mono: "var(--mono)",
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
      },
    },
  },
  plugins: [],
} satisfies Config;
