import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Config for the marketing site ONLY. It lives in site/ rather than at the repo
 * root on purpose.
 *
 * The PostCSS pipeline is declared INLINE here instead of in a postcss.config.js.
 * Vite resolves PostCSS config by walking up from the project root, so a root-level
 * config file would be picked up by the tracker app's build too — injecting Tailwind
 * into src/neurofit/neurofit.css and wrecking 1,256 lines of hand-written CSS.
 * Inline config is scoped to this build and physically cannot leak.
 */
export default defineConfig({
  root: here,
  plugins: [react()],
  css: {
    postcss: {
      plugins: [tailwindcss(path.join(here, "tailwind.config.ts")), autoprefixer()],
    },
  },
  resolve: {
    alias: { "@": path.join(here, "src") },
  },
  // PORT lets a second checkout (a worktree) run beside the main one's 5180.
  server: { port: Number(process.env.PORT) || 5180, strictPort: true },
  build: { outDir: path.join(here, "dist"), emptyOutDir: true },
});
