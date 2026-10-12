/**
 * Analyze (video form analysis) — every tunable in one place. PURE module.
 * ----------------------------------------------------------------------------
 * ⚠️ EVERY number here is UNVALIDATED (n=0): no clip has been run through it yet. They are
 * starting guesses, named and centralized so a calibration pass is a one-file edit. When you
 * change one, say WHY (what you observed) — same rule as squat/config.ts.
 *
 * All timing is in MILLISECONDS, never frame counts: uploaded clips run at 24, 30, 60 or 240 fps,
 * and the pose pass samples whatever the browser presents.
 */

export type MediaResolution = "MEDIA_RESOLUTION_LOW" | "MEDIA_RESOLUTION_MEDIUM" | "MEDIA_RESOLUTION_HIGH";

export const ANALYZE = {
  ai: {
    /** "Find my form errors" over the whole clip. */
    clip: {
      /** Hard cap on images sent. 3 reps × 4 phases — first, middle and last rep. The cap, not the
       *  clip length, bounds the cost: a 3-minute clip costs the same as a 10-second one. */
      maxFrames: 12,
      /** Frames sent when no reps were found (spread evenly over the analysed range). */
      evenFrames: 8,
      /** LOW = 280 tokens per image on Gemini 3 (HIGH, the default, is 1120 — 4× the cost).
       *  Enough to read body position; detail questions go through the single-frame ask. */
      mediaResolution: "MEDIA_RESOLUTION_LOW" as MediaResolution,
      /** Thinking level is GEMINI.thinking.formClip (squat/config.ts, with the other tiers).
       *  Thinking draws from this budget (see GEMINI in squat/config.ts) — a tight cap truncates. */
      maxOutputTokens: 8192,
      maxIssues: 5,
      /** Rep rows sent as text context; more than this are summarized by count only. */
      maxRepRows: 20,
    },
    /** "Ask about this frame". */
    frame: {
      /** One frame each side of the paused one, so the model can tell which way the body moves. */
      neighbourOffsetMs: 150,
      /** MEDIUM = 560 tokens per image: one frame, looked at closely. Applies to all three images
       *  (a request-wide setting — the per-image field isn't on every API version). */
      mediaResolution: "MEDIA_RESOLUTION_MEDIUM" as MediaResolution,
      /** Thinking level is GEMINI.thinking.formFrame. */
      maxOutputTokens: 4096,
      maxIssues: 3,
      maxQuestionChars: 300,
    },
    /** JPEGs keep the clip's aspect ratio (the live coach squashes to 640×480 — fine for a
     *  webcam, wrong for a portrait phone clip). */
    jpeg: { longSide: 768, quality: 0.8 },
    maxExerciseChars: 60,
  },

  /**
   * Cost estimate shown on the AI buttons. Third-party trackers (pricepertoken.com,
   * anotherwrapper.com; checked 2026-10-10) list gemini-3.6-flash at $0.75 / 1M input and
   * $3.75 / 1M output, and one says it doubles on 2027-01-01. An ESTIMATE for the user, never a
   * bill — the usage panel shows the real token counts. Update both numbers and the date together.
   */
  price: { inputPerMTok: 0.75, outputPerMTok: 3.75, checked: "2026-10-10" },
  tokens: {
    /** Gemini 3 per-image token budgets by media resolution. */
    perImage: { MEDIA_RESOLUTION_LOW: 280, MEDIA_RESOLUTION_MEDIUM: 560, MEDIA_RESOLUTION_HIGH: 1120 } as Record<MediaResolution, number>,
    /** ~4 characters per text token — the usual English rule of thumb. */
    charsPerToken: 4,
    /** Expected output incl. thinking, by tier. Guesses from the live coach's measured headroom
     *  (post-set: ~1.9k thought + ~0.25k output on "medium"). */
    expectedOutput: { clip: 2600, frame: 1200 },
  },

  /** Generic rep finder (analyze/reps.ts). */
  reps: {
    /** A driving angle must swing at least this far (p90 − p10, degrees) to count as reps.
     *  Below it the clip is a hold, a walk-through, or too far from the camera. */
    minRangeDeg: 25,
    /** Leaving the rest band = past this share of the range from the rest side. */
    leaveFrac: 0.25,
    /** A rep only counts once it gets this far toward the far side. */
    commitFrac: 0.5,
    minCycleMs: 400,
    maxCycleMs: 20000,
    /** Moving-average window applied before detection (ms). */
    smoothMs: 120,
    /** The rest side is whichever extreme the first this-many ms sit nearer. */
    restProbeMs: 600,
  },

  /** Pose pass over the clip (hooks/usePoseTrack.ts). */
  pass: {
    /** Played through at up to this rate; slower when detection can't keep up (frameWalker), so
     *  every frame is read even on a slow device. */
    playbackRate: 1,
    /** Starting rate, before the detection speed is known. */
    startRate: 0.25,
    /** Without requestVideoFrameCallback we seek instead, at this many frames per second. */
    seekFps: 15,
    /** Longer clips are analysed over their in/out range only (a warning asks the user to trim). */
    maxSeconds: 180,
    /** A pose sample is "the" pose for a time if it is within this much of it. */
    maxGapMs: 120,
  },

  annotation: {
    /** A "this frame" drawing stays visible this long either side of its frame, fading. */
    frameFadeMs: 300,
    /** Snap radius for joint snapping, in screen pixels. */
    snapPx: 18,
  },

  /** Template tracker for "track a point" (analyze/pointTracker.ts). */
  tracker: {
    /** Template half-size (px at the analysis scale): a 21×21 patch. */
    halfPatch: 10,
    /** Search this far from the last position (px at the analysis scale) — per sampled frame. */
    searchRadius: 28,
    /** Normalized cross-correlation below this stops the track instead of guessing. */
    minScore: 0.55,
    /** Frames are scaled so the long side is this many px before matching (speed). */
    longSide: 480,
  },

  /** Saved annotations (analyze/clipStore.ts). */
  store: { key: "neurofit.analyze.v1", maxClips: 20 },
} as const;
