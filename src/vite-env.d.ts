/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Gemini API key for the triggered AI coaching (spec §6). Optional — when
   *  absent the app runs fully and only the AI panel is disabled. */
  readonly GEMINI_API_KEY?: string;
  /** Gemini model id (default "gemini-3.6-flash"). */
  readonly GEMINI_MODEL?: string;
  /** Back-compat fallback for older .env.local files. */
  readonly VITE_GEMINI_API_KEY?: string;
  readonly VITE_GEMINI_MODEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
