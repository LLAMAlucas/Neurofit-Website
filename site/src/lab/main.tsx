import { createRoot } from "react-dom/client";

import "./lab.css";
import Lab from "./Lab";
import { store } from "@/stage/store";

// A console handle for tuning sessions: `__lab.settings.rim = 0.3`, or freeze a
// rep at its peak with `__lab.settings.speed = 0`.
if (import.meta.env.DEV) (window as unknown as { __lab: typeof store }).__lab = store;

createRoot(document.getElementById("lab")!).render(<Lab />);
