import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// getUserMedia requires a secure context. localhost counts as secure, so the
// default dev server is fine. If you test from another device on the LAN,
// you'll need HTTPS (set server.https) or the camera will be blocked.
export default defineConfig({
  plugins: [react()],
  // Expose GEMINI_* (unprefixed key, spec §6) to the client alongside Vite's
  // default VITE_* vars. Browser-direct for this prototype — a key-holding proxy
  // is the production path.
  envPrefix: ["VITE_", "GEMINI_"],
  server: {
    host: true,
    port: 5173,
  },
});
