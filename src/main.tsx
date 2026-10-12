import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Neuro-Fit (Phase 1 squat coach) is the live app. The StakeFit app under
// src/App.tsx + backend/ is kept on disk as reference but no longer rendered.
import App from "./neurofit/App";
// Order is load-bearing: the shared tokens + chrome (mirrored in the site) first, the tracker's own
// pages on top.
import "./neurofit/chrome/tokens.css";
import "./neurofit/chrome/chrome.css";
import "./neurofit/neurofit.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
