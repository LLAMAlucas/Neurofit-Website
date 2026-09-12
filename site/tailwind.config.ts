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
      // Mirrors of the :root custom properties in styles/site.css. The CSS vars stay
      // the single source of truth at runtime — these just make the same values
      // reachable as Tailwind utilities (bg-paper, text-ink-3, …) for new components.
      colors: {
        paper: { DEFAULT: "var(--paper)", 2: "var(--paper-2)" },
        lens: { DEFAULT: "var(--lens)", 2: "var(--lens-2)" },
        ink: {
          DEFAULT: "var(--ink)",
          2: "var(--ink-2)",
          3: "var(--ink-3)",
        },
        "on-lens": { DEFAULT: "var(--on-lens)", 2: "var(--on-lens-2)" },
        signal: "var(--signal)",
        fault: { DEFAULT: "var(--fault)", ink: "var(--fault-ink)" },
        rule: { DEFAULT: "var(--rule)", soft: "var(--rule-soft)" },

        // shadcn's semantic token set (defined in globals.css against the site
        // palette). Registry components reference these by name.
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: "var(--sans)",
        mono: "var(--mono)",
        serif: "var(--serif)",
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
        io: "var(--ease-io)",
      },
      maxWidth: { shell: "var(--shell)" },
      keyframes: {
        lensIn: {
          from: { opacity: "0", transform: "scale(.975)", filter: "blur(9px)" },
        },
        brkIn: {
          from: { opacity: "0", transform: "translate(var(--bx), var(--by))" },
        },
        lnUp: {
          "60%": { filter: "blur(0)" },
          to: { transform: "translateY(0)", filter: "blur(0)" },
        },
        riseIn: { from: { opacity: "0", transform: "translateY(16px)" } },
        fadeIn: { from: { opacity: "0" } },
      },
      animation: {
        lensIn: "lensIn 900ms var(--ease-out) 120ms backwards",
        brkIn: "brkIn 620ms var(--ease-out) 340ms backwards",
        riseIn: "riseIn 760ms var(--ease-out) backwards",
        fadeIn: "fadeIn 620ms var(--ease-out) backwards",
      },
    },
  },
  plugins: [],
} satisfies Config;
