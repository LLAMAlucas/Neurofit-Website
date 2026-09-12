/**
 * Persisted user settings (Phase 1: squat depth target only).
 * ----------------------------------------------------------------------------
 * Stored in localStorage so the choice survives reloads. Defaults to PARALLEL on
 * first load. React glue — the only place the depth preset touches the browser.
 */
import { useEffect, useState } from "react";
import {
  DEFAULT_DEPTH_PRESET,
  DEFAULT_MODE,
  DEPTH_PRESETS,
  type DepthPreset,
  type SquatMode,
} from "../squat/config";
import {
  apiCallsDisabled,
  apiKeyIsUserSupplied,
  geminiKeyPresent,
  setApiCallsDisabled,
  setApiKey,
} from "../ai/gemini";

const KEY = "neurofit.depthPreset";
const MODE_KEY = "neurofit.mode";

function isDepthPreset(v: unknown): v is DepthPreset {
  return typeof v === "string" && v in DEPTH_PRESETS;
}

function loadDepthPreset(): DepthPreset {
  try {
    const v = localStorage.getItem(KEY);
    return isDepthPreset(v) ? v : DEFAULT_DEPTH_PRESET;
  } catch {
    return DEFAULT_DEPTH_PRESET;
  }
}

/** [selected depth preset, setter] — persisted to localStorage. */
export function useDepthPreset(): [DepthPreset, (p: DepthPreset) => void] {
  const [preset, setPreset] = useState<DepthPreset>(loadDepthPreset);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, preset);
    } catch {
      /* private mode / storage disabled — fall back to in-memory only */
    }
  }, [preset]);
  return [preset, setPreset];
}

function isMode(v: unknown): v is SquatMode {
  return v === "bodyweight" || v === "loaded";
}

function loadMode(): SquatMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return isMode(v) ? v : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

/** [training mode, setter] — bodyweight | loaded, persisted to localStorage. */
export function useMode(): [SquatMode, (m: SquatMode) => void] {
  const [mode, setMode] = useState<SquatMode>(loadMode);
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* private mode / storage disabled — in-memory only */
    }
  }, [mode]);
  return [mode, setMode];
}

/**
 * [apiEnabled, setter] — master kill-switch for Gemini calls. When off, every
 * mid-set/post-set/post-workout call is short-circuited via geminiEnabled(), so
 * the UI and raw number tracking can be exercised without firing any API call.
 * Persistence lives in gemini.ts (single source of truth for the flag) so the
 * gate and this toggle can never drift apart.
 */
export function useApiEnabled(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(() => !apiCallsDisabled());
  const set = (next: boolean) => {
    setApiCallsDisabled(!next);
    setEnabled(next);
  };
  return [enabled, set];
}

export interface ApiKeyControl {
  /** What's in the textbox right now — never the stored key itself. */
  draft: string;
  setDraft: (v: string) => void;
  /** A key is in force (saved, or inherited from .env.local in dev). */
  present: boolean;
  /** The key in force was saved here, as opposed to inherited in dev. */
  saved: boolean;
  /** Draft differs from what's stored, so Save has something to do. */
  dirty: boolean;
  save: () => void;
  clear: () => void;
}

/**
 * The Settings API-key box. The stored key is never read back into the textbox —
 * the draft starts empty and stays empty after a save, so a shoulder-surfer or a
 * screenshot of the Settings tab can't recover it. `present`/`saved` carry the
 * status the UI needs without the value ever round-tripping through React state.
 *
 * Typing is local until Save is pressed (`dirty`), so a half-typed key is never
 * written to storage and never becomes the key a call would fire with.
 */
export function useApiKey(): ApiKeyControl {
  const [draft, setDraft] = useState("");
  const [present, setPresent] = useState<boolean>(() => geminiKeyPresent());
  const [saved, setSaved] = useState<boolean>(() => apiKeyIsUserSupplied());

  const sync = () => {
    setPresent(geminiKeyPresent());
    setSaved(apiKeyIsUserSupplied());
  };

  return {
    draft,
    setDraft,
    present,
    saved,
    dirty: draft.trim().length > 0,
    save: () => {
      const next = draft.trim();
      if (next.length === 0) return;
      setApiKey(next);
      setDraft("");
      sync();
    },
    clear: () => {
      setApiKey("");
      setDraft("");
      sync();
    },
  };
}
