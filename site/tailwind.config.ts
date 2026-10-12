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
      // Mirrors of the :root custom properties in chrome/tokens.css. The CSS vars
      // stay the single source of truth at runtime — these just make the same
      // values reachable as Tailwind utilities for new components.
      colors: {
        bg: "var(--bg)",
        panel: "var(--panel-solid)",
        chip: "var(--chip)",
        fg: { DEFAULT: "var(--fg)", 2: "var(--fg-2)" },
        accent: { DEFAULT: "var(--accent)", 2: "var(--accent-2)", 3: "var(--accent-3)" },
        hot: "var(--hot)",
        fault: { DEFAULT: "var(--fault)", text: "var(--fault-text)" },
        rule: "var(--rule)",
      },
      fontFamily: {
        sans: "var(--sans)",
        serif: "var(--serif)",
        mono: "var(--mono)",
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
      },
    },
  },
  plugins: [],
} satisfies Config;
